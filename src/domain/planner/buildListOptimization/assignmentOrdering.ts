/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B (moved from the Global Assignment Research
 * Phase B-1, Issue #154).
 *
 * The value order of one node and the MRV option count (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md`
 * 6.3 / 6.4), both lazy.
 *
 * Value order (design 6.3): smallest Σ stream-end increment first (`streamEndDelta()` against the node's
 * partial assignment), then an owned source before a new Normal, then the smaller required positions,
 * then the stable option key. "Smaller required positions" is realized as: the final Skill position,
 * the final Gogma position, the Normal forge position, then the secondary positions in Phase A's own
 * order (a conversion closest to its final Skill position first, i.e. `c` descending; `reset` before
 * `keep_from_source` before `reset_then_keep` at one final position; the earliest Reset of a
 * `reset_then_keep` first). The key is a pure function of the option and the partial assignment, so the
 * order never depends on enumeration history, Clock or run.
 *
 * The order is produced without materializing the `source x Skill x Bonus` product. Per source, the
 * Skill requirements are an indexable sequence whose stream end is monotone along the index (Phase A's
 * order; a continuation lane is `none` followed by `reset_skills` ascending, and `none` keys below every
 * operation: Skill end at the origin, final Skill component -1), and each Bonus stream (`none` - a stream of
 * its own, of length 1 - then `reset`, `keep_from_source`, `reset_then_keep`) is an ascending position array,
 * so every (source, Bonus stream) pair is a 2-D lattice whose key is monotone along both axes. No component is
 * added for continuations: a continuation option never precedes the option of the same source that replaces
 * its continued lane by `none` (audit 5.2 L1, the option dominating it), because that option's key is smaller in
 * the stream-end increment or, on a tie, in the final position of that lane. A min-heap frontier merges every lattice: the roots are pushed first and a popped
 * cell pushes its right neighbour `(i, j + 1)` and, when `j = 0`, its lower neighbour `(i + 1, 0)`, so
 * each cell is reached exactly once and the memory held is the frontier - the roots plus the cells
 * popped so far - never the product. A source the partial assignment already uses is left out whole
 * (exact: every option of a used source violates C1). No option is dropped or reordered for cost.
 *
 * The MRV count walks Phase A's per-source generator and stops at the lookahead `k`; it reads no lower
 * bound (design 6.4, review R1).
 *
 * Phase C-2 adds the coverage-driven value ordering (design 6.3) as a separate, opt-in enumerator
 * (`createPrioritizedOptionEnumerator()`): the base frontier above is reused unchanged and a priority
 * conversion position is served by a second lattice merge restricted to `c = x`, with key ranges excluding
 * duplicates. `createOrderedOptionEnumerator()` itself is unchanged.
 */
import { findResourceViolation, streamEndDelta } from './assignmentFeasibility'
import type { PartialResourceAssignment, ResourceViolationKind } from './assignmentTypes'
import {
  createReachOption, createResetThenKeepIndex, enumerateReachOptionsOfSource, keepFromSourcePositions, laneAdmitsNone, laneAdmitsOperations, reachOptionKey,
  skillRequirementBlocks, sourceLaneAdmission, sourceResourceKey,
} from './reachOptions'
import type { BonusRequirement, ReachOption, ReachTable, SkillRequirement, SourceCandidate, TargetReach } from './buildListOptimizationTypes'

/** A random-access view of a finite sequence that is never materialized as a whole. */
export interface IndexedSequence<T> {
  readonly length: number
  at(index: number): T
}

/**
 * The Skill requirements of one source as an indexable sequence in Phase A's order
 * (`enumerateSkillRequirements()`): `none`; `reset_skills` by final position, after one leading `none` for a
 * continuation lane; for a Normal source the conversion blocks `(s*, c = s*), (s*, s* - 1), ..., (s*, origin)` per
 * ascending `s*`, addressed through block prefix sums so no `(c, s*)` pair is stored.
 */
export function indexedSkillRequirements(target: TargetReach, source: SourceCandidate, table: ReachTable): IndexedSequence<SkillRequirement> {
  const blocks = skillRequirementBlocks(target, source, table)
  switch (blocks.kind) {
    case 'none':
      return { length: 1, at: () => ({ kind: 'none' }) }
    case 'reset_skills': {
      const lead = blocks.leadingNone ? 1 : 0
      const length = lead + blocks.finalPositions.length
      return {
        length,
        at: index => {
          if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError(`Skill requirement index ${String(index)} is out of range (${length}).`)
          return index < lead ? { kind: 'none' } : { kind: 'reset_skills', finalPosition: blocks.finalPositions[index - lead]! }
        },
      }
    }
    case 'conversion': {
      const starts: number[] = []
      let length = 0
      for (const finalPosition of blocks.finalPositions) {
        starts.push(length)
        length += finalPosition - blocks.originSkill + 1
      }
      return {
        length,
        at: index => {
          if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError(`Skill requirement index ${String(index)} is out of range (${length}).`)
          let low = 0, high = starts.length - 1
          while (low < high) {
            const middle = (low + high + 1) >> 1
            if (starts[middle]! <= index) low = middle
            else high = middle - 1
          }
          const finalPosition = blocks.finalPositions[low]!
          return { kind: 'conversion', conversionPosition: finalPosition - (index - starts[low]!), finalPosition }
        },
      }
    }
  }
}

/**
 * The Bonus requirement streams of one source, each ascending in its final position (Phase A's
 * `enumerateBonusRequirements()` split by kind): a single `none` when the source's Bonus lane admits it (an
 * owned Gogma already Ideal; with continuation followed by the operations), then `reset`, `keep_from_source` (only while
 * supported for the source's layout) and `reset_then_keep` when the lane admits operations. Empty streams are
 * omitted. `resetThenKeep` is the Target's compact `reset_then_keep` index (`createResetThenKeepIndex()`, no pair
 * materialized), shared by its sources.
 */
export function indexedBonusStreams(target: TargetReach, source: SourceCandidate, table: Pick<ReachTable, 'continuesCurrentIdealLanes'>, resetThenKeep: IndexedSequence<BonusRequirement>): IndexedSequence<BonusRequirement>[] {
  const admission = sourceLaneAdmission(source, table.continuesCurrentIdealLanes).bonus
  const streams: IndexedSequence<BonusRequirement>[] = []
  if (laneAdmitsNone(admission)) streams.push({ length: 1, at: () => ({ kind: 'none' }) })
  if (!laneAdmitsOperations(admission)) return streams
  const resets = target.bonus.resetIdealPositions
  if (resets.length > 0) streams.push({ length: resets.length, at: index => ({ kind: 'reset', finalPosition: resets[index]! }) })
  const keeps = keepFromSourcePositions(target, source)
  if (keeps.length > 0) streams.push({ length: keeps.length, at: index => ({ kind: 'keep_from_source', finalPosition: keeps[index]! }) })
  if (resetThenKeep.length > 0) streams.push(resetThenKeep)
  return streams
}

export interface TargetOptionLatticeSource {
  source: SourceCandidate
  key: string
  skills: IndexedSequence<SkillRequirement>
  bonusStreams: IndexedSequence<BonusRequirement>[]
}

/** The per-source lattices of one Target, built once per search and shared by every node. */
export interface TargetOptionLattice {
  target: TargetReach
  sources: readonly TargetOptionLatticeSource[]
}

/** `resetThenKeep` defaults to the Target's own compact index; a caller holding one already (the solver) passes it so one Target has one index. */
export function createTargetOptionLattice(target: TargetReach, table: ReachTable, resetThenKeep: IndexedSequence<BonusRequirement> = createResetThenKeepIndex(target)): TargetOptionLattice {
  return {
    target,
    sources: target.sources.map(source => ({
      source, key: sourceResourceKey(source), skills: indexedSkillRequirements(target, source, table), bonusStreams: indexedBonusStreams(target, source, table, resetThenKeep),
    })),
  }
}

/** The value order key of design 6.3 (see the module comment); compared lexicographically, then by the stable option key. */
export interface ValueOrderKey {
  components: readonly number[]
  optionKey: string
}

function bonusKindRank(bonus: BonusRequirement): number {
  switch (bonus.kind) {
    case 'none': return 0
    case 'reset': return 1
    case 'keep_from_source': return 2
    case 'reset_then_keep': return 3
  }
}

export function valueOrderKey(option: ReachOption, partial: PartialResourceAssignment): ValueOrderKey {
  const skill = option.skillRequired
  const bonus = option.bonusRequired
  return {
    components: [
      streamEndDelta(option, partial),
      option.source.kind === 'new_normal' ? 1 : 0,
      skill.kind === 'none' ? -1 : skill.finalPosition,
      bonus.kind === 'none' ? -1 : bonus.finalPosition,
      option.normalRequired === null ? -1 : option.normalRequired.position,
      skill.kind === 'conversion' ? skill.finalPosition - skill.conversionPosition : 0,
      bonusKindRank(bonus),
      bonus.kind === 'reset_then_keep' ? bonus.resetPosition : -1,
    ],
    optionKey: reachOptionKey(option),
  }
}

export function compareValueOrder(left: ValueOrderKey, right: ValueOrderKey): number {
  for (let index = 0; index < left.components.length; index++) {
    const difference = left.components[index]! - right.components[index]!
    if (difference !== 0) return difference
  }
  return left.optionKey < right.optionKey ? -1 : left.optionKey > right.optionKey ? 1 : 0
}

interface LatticeCell {
  sourceIndex: number
  streamIndex: number
  i: number
  j: number
  option: ReachOption
  key: ValueOrderKey
}

class CellHeap {
  private readonly cells: LatticeCell[] = []

  get size(): number {
    return this.cells.length
  }

  push(cell: LatticeCell): void {
    const cells = this.cells
    cells.push(cell)
    let index = cells.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (compareValueOrder(cells[index]!.key, cells[parent]!.key) >= 0) break
      ;[cells[index], cells[parent]] = [cells[parent]!, cells[index]!]
      index = parent
    }
  }

  pop(): LatticeCell | undefined {
    const cells = this.cells
    if (cells.length === 0) return undefined
    const top = cells[0]!
    const last = cells.pop()!
    if (cells.length > 0) {
      cells[0] = last
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < cells.length && compareValueOrder(cells[left]!.key, cells[smallest]!.key) < 0) smallest = left
        if (right < cells.length && compareValueOrder(cells[right]!.key, cells[smallest]!.key) < 0) smallest = right
        if (smallest === index) break
        ;[cells[index], cells[smallest]] = [cells[smallest]!, cells[index]!]
        index = smallest
      }
    }
    return top
  }
}

export interface OrderedOptionEnumerator {
  /** The next option of the Target in value order, or undefined when every option of an unused source was delivered. */
  next(): ReachOption | undefined
  /** Cells currently held (the lattice frontier). */
  readonly frontierSize: number
  /** Options delivered so far. */
  readonly delivered: number
  /** Sources left out whole because the partial assignment already uses them (C1). */
  readonly excludedUsedSources: number
}

/** One delivered option with its value order key against the enumerator's partial assignment. */
export interface KeyedOption {
  option: ReachOption
  key: ValueOrderKey
}

/**
 * The keyed form of `OrderedOptionEnumerator`: every delivery carries its value order key. Keys are
 * strictly ascending in `compareValueOrder()` (the lattice merge pops a non-decreasing sequence and the
 * stable option key makes every option's key distinct), which is what lets a caller decide by one key
 * comparison whether an option was delivered before (Phase C-2 coverage-driven ordering).
 */
export interface KeyedOptionEnumerator {
  next(): KeyedOption | undefined
  readonly frontierSize: number
  readonly delivered: number
  readonly excludedUsedSources: number
}

/**
 * The lattice merge of design 6.3 over the lattice's unused sources, each source's Skill axis given by
 * `skillsOf` (the full Phase A sequence, or a monotone subsequence of it). Every (source, Bonus stream)
 * pair stays a 2-D lattice whose key is monotone along both axes as long as `skillsOf` keeps the final
 * Skill position ascending, so the frontier invariant of the module comment holds unchanged.
 */
function createLatticeMerge(lattice: TargetOptionLattice, table: ReachTable, partial: PartialResourceAssignment,
  skillsOf: (source: TargetOptionLatticeSource) => IndexedSequence<SkillRequirement>): KeyedOptionEnumerator {
  const heap = new CellHeap()
  let delivered = 0
  let excludedUsedSources = 0
  const skills = lattice.sources.map(source => (partial.usedSources.has(source.key) ? null : skillsOf(source)))
  const cell = (sourceIndex: number, streamIndex: number, i: number, j: number): LatticeCell => {
    const source = lattice.sources[sourceIndex]!
    const option = createReachOption(lattice.target, table, source.source, skills[sourceIndex]!.at(i), source.bonusStreams[streamIndex]!.at(j))
    return { sourceIndex, streamIndex, i, j, option, key: valueOrderKey(option, partial) }
  }
  lattice.sources.forEach((source, sourceIndex) => {
    if (partial.usedSources.has(source.key)) { excludedUsedSources += 1; return }
    if (skills[sourceIndex]!.length === 0) return
    source.bonusStreams.forEach((stream, streamIndex) => {
      if (stream.length > 0) heap.push(cell(sourceIndex, streamIndex, 0, 0))
    })
  })
  return {
    next: () => {
      const top = heap.pop()
      if (!top) return undefined
      const source = lattice.sources[top.sourceIndex]!
      const stream = source.bonusStreams[top.streamIndex]!
      if (top.j + 1 < stream.length) heap.push(cell(top.sourceIndex, top.streamIndex, top.i, top.j + 1))
      if (top.j === 0 && top.i + 1 < skills[top.sourceIndex]!.length) heap.push(cell(top.sourceIndex, top.streamIndex, top.i + 1, 0))
      delivered += 1
      return { option: top.option, key: top.key }
    },
    get frontierSize() { return heap.size },
    get delivered() { return delivered },
    get excludedUsedSources() { return excludedUsedSources },
  }
}

/** The keyed value-order enumerator of every option of the lattice's Target (the same sequence as `createOrderedOptionEnumerator()`). */
export function createKeyedOptionEnumerator(lattice: TargetOptionLattice, table: ReachTable, partial: PartialResourceAssignment): KeyedOptionEnumerator {
  return createLatticeMerge(lattice, table, partial, source => source.skills)
}

/**
 * Enumerates every option of the lattice's Target whose source the partial assignment does not use, in
 * value order against that partial assignment (which the caller keeps fixed for the enumerator's life).
 * Position feasibility (C2) is not filtered here: the caller judges each delivered option.
 */
export function createOrderedOptionEnumerator(lattice: TargetOptionLattice, table: ReachTable, partial: PartialResourceAssignment): OrderedOptionEnumerator {
  const keyed = createKeyedOptionEnumerator(lattice, table, partial)
  return {
    next: () => keyed.next()?.option,
    get frontierSize() { return keyed.frontierSize },
    get delivered() { return keyed.delivered },
    get excludedUsedSources() { return keyed.excludedUsedSources },
  }
}

/**
 * The conversions of one source at exactly `conversionPosition` (`c = x`, design 6.3 coverage-driven
 * value ordering), ascending in the final Skill position `s* >= x`: `c = s*` and every `c < s*`. A subsequence
 * of `indexedSkillRequirements()` that keeps `s*` ascending, so it is a valid lattice axis. Empty for an
 * owned Gogma (it never converts) and for a position outside the source's conversion range.
 */
export function indexedConversionsAt(target: TargetReach, source: SourceCandidate, table: ReachTable, conversionPosition: number): IndexedSequence<SkillRequirement> {
  const blocks = skillRequirementBlocks(target, source, table)
  if (blocks.kind !== 'conversion' || !Number.isSafeInteger(conversionPosition) || conversionPosition < blocks.originSkill) return { length: 0, at: index => { throw new RangeError(`No conversion at ${conversionPosition} (index ${String(index)}).`) } }
  // finalPositions are ascending: the first one at or after the conversion position starts the subsequence.
  let low = 0, high = blocks.finalPositions.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (blocks.finalPositions[middle]! < conversionPosition) low = middle + 1
    else high = middle
  }
  const start = low
  const length = blocks.finalPositions.length - start
  return {
    length,
    at: index => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError(`Conversion index ${String(index)} is out of range (${length}).`)
      return { kind: 'conversion', conversionPosition, finalPosition: blocks.finalPositions[start + index]! }
    },
  }
}

/**
 * The keyed value-order enumerator of exactly the options of the lattice's Target that convert at
 * `conversionPosition` (design 6.3 coverage-driven value ordering): the same lattice merge restricted on
 * the Skill axis, so the options come in the same relative order as in the full enumeration and no
 * `source x Skill x Bonus` product is materialized. Owned Gogma sources contribute nothing.
 */
export function createConversionPriorityEnumerator(lattice: TargetOptionLattice, table: ReachTable, partial: PartialResourceAssignment, conversionPosition: number): KeyedOptionEnumerator {
  return createLatticeMerge(lattice, table, partial, source => indexedConversionsAt(lattice.target, source.source, table, conversionPosition))
}

export interface FeasibleOptionCount {
  /** Resource-feasible options found, saturated at the limit. */
  count: number
  /**
   * What the walk skipped before it stopped: `source` counts used sources skipped whole (C1), the position
   * kinds count options (C2). Exact only when the count did not reach the limit (then every option was walked).
   */
  rejections: Record<ResourceViolationKind, number>
}

/**
 * `countUpTo(k)` of design 6.4: the resource-feasible options of `target` under `partial`, counted in
 * Phase A's order until `limit` is reached. A used source is skipped whole; no lower bound is read.
 * `onOptionWalked` is called once per option examined (feasible or not), so a long walk can poll the
 * cancel seam; it never changes the count.
 */
export function countFeasibleOptionsUpTo(target: TargetReach, table: ReachTable, partial: PartialResourceAssignment, limit: number,
  onOptionWalked?: () => void): FeasibleOptionCount {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`countFeasibleOptionsUpTo limit must be a positive integer (got ${String(limit)}).`)
  const rejections: Record<ResourceViolationKind, number> = { source: 0, skill_position: 0, gogma_position: 0, normal_position: 0 }
  let count = 0
  for (const source of target.sources) {
    if (partial.usedSources.has(sourceResourceKey(source))) { rejections.source += 1; continue }
    for (const option of enumerateReachOptionsOfSource(target, table, source)) {
      onOptionWalked?.()
      const violation = findResourceViolation(option, partial)
      if (violation !== null) { rejections[violation] += 1; continue }
      count += 1
      if (count >= limit) return { count, rejections }
    }
  }
  return { count, rejections }
}

/** The conversion position of an option, or null when it does not convert. */
function conversionPositionOf(option: ReachOption): number | null {
  return option.skillRequired.kind === 'conversion' ? option.skillRequired.conversionPosition : null
}

/**
 * What one priority phase delivered: every option converting at the phase's position whose key lies in
 * `(cutoff, last]` - or in `(cutoff, +inf)` once the phase is exhausted. `cutoff` is the key the base
 * enumerator had last popped when the phase opened (null: nothing yet), so the phase never repeats an
 * option the base already delivered, and the base later skips exactly the options inside the range.
 */
interface PriorityRange {
  cutoff: ValueOrderKey | null
  last: ValueOrderKey | null
  exhausted: boolean
}

/** Counters of the Phase C-2 coverage-driven value ordering, shared by every frame of one search (diagnostics only). */
export interface PriorityOrderingCounters {
  /** Priority phases opened (a frame read a priority conversion position different from the one it applied last). */
  phaseActivations: number
  /** Options delivered through a priority phase, before the caller's C2 check. */
  priorityDeliveries: number
  /** Options a priority phase passed over because the base or an earlier phase had delivered them. */
  prioritySkips: number
  /** Options the base enumerator passed over because a priority phase had delivered them. */
  baseSkips: number
}

export function createPriorityOrderingCounters(): PriorityOrderingCounters {
  return { phaseActivations: 0, priorityDeliveries: 0, prioritySkips: 0, baseSkips: 0 }
}

export interface PrioritizedOptionEnumerator {
  /** The next option, or undefined once every option of an unused source was delivered exactly once. */
  next(): ReachOption | undefined
  readonly excludedUsedSources: number
  /** Cells held: the base frontier plus the active priority phase's frontier (closed phases hold none). */
  readonly frontierSize: number
  /** Priority ranges kept (O(1) each). */
  readonly priorityRanges: number
}

/**
 * Phase C-2 coverage-driven value ordering of one node (design 6.3): the node's full value order, except
 * that whenever `readPriorityConversionPosition()` names a conversion position `x`, the options converting
 * at `x` (`c = x`, both `c = s*` and `c < s*`) that were not delivered yet come first, in their own value
 * order. The priority is read at every delivery, so a frame created before a coverage rejection reacts to
 * it at its next value; a change of position closes the current phase and opens a new one.
 *
 * The base value-order frontier is never re-keyed (its heap invariant is untouched): a phase is a second,
 * independent lattice merge restricted on the Skill axis (`createConversionPriorityEnumerator()`), and
 * duplicates are excluded by key ranges. Because both enumerators deliver strictly ascending keys, an
 * option converting at `x` was delivered by a phase exactly when its key lies inside one of that position's
 * ranges, and was delivered by the base exactly when its key is at most the base's last popped key. So
 * every option of an unused source is delivered exactly once - none dropped, none repeated - whatever the
 * sequence of priorities, and the order is a pure function of that sequence. Memory per frame is the base
 * frontier, the active phase's frontier, and O(1) per closed phase; no product is materialized.
 *
 * `onSkip` is called once per option passed over (so a long skip run can poll the cancel seam).
 */
export function createPrioritizedOptionEnumerator(lattice: TargetOptionLattice, table: ReachTable, partial: PartialResourceAssignment,
  readPriorityConversionPosition: () => number | null, counters: PriorityOrderingCounters, onSkip?: () => void): PrioritizedOptionEnumerator {
  const base = createKeyedOptionEnumerator(lattice, table, partial)
  let baseLast: ValueOrderKey | null = null
  const rangesByPosition = new Map<number, PriorityRange[]>()
  let applied: number | null = null
  let active: { range: PriorityRange; enumerator: KeyedOptionEnumerator } | null = null
  const isAfter = (key: ValueOrderKey, bound: ValueOrderKey | null) => bound === null || compareValueOrder(key, bound) > 0
  const deliveredByPhase = (delivery: KeyedOption) => {
    const position = conversionPositionOf(delivery.option)
    if (position === null) return false
    for (const range of rangesByPosition.get(position) ?? []) {
      if (isAfter(delivery.key, range.cutoff) && (range.exhausted || (range.last !== null && compareValueOrder(delivery.key, range.last) <= 0))) return true
    }
    return false
  }
  return {
    next: () => {
      const priority = readPriorityConversionPosition()
      if (priority !== applied) {
        // The current phase (if any) closes with what it delivered so far; its range stays authoritative.
        active = null
        applied = priority
        if (priority !== null) {
          const range: PriorityRange = { cutoff: baseLast, last: null, exhausted: false }
          const ranges = rangesByPosition.get(priority)
          if (ranges) ranges.push(range)
          else rangesByPosition.set(priority, [range])
          active = { range, enumerator: createConversionPriorityEnumerator(lattice, table, partial, priority) }
          counters.phaseActivations += 1
        }
      }
      while (active !== null) {
        const delivery = active.enumerator.next()
        if (delivery === undefined) {
          active.range.exhausted = true
          active = null
          break
        }
        if (!isAfter(delivery.key, active.range.cutoff) || deliveredByPhase(delivery)) {
          counters.prioritySkips += 1
          onSkip?.()
          continue
        }
        active.range.last = delivery.key
        counters.priorityDeliveries += 1
        return delivery.option
      }
      while (true) {
        const delivery = base.next()
        if (delivery === undefined) return undefined
        baseLast = delivery.key
        if (deliveredByPhase(delivery)) {
          counters.baseSkips += 1
          onSkip?.()
          continue
        }
        return delivery.option
      }
    },
    get excludedUsedSources() { return base.excludedUsedSources },
    get frontierSize() { return base.frontierSize + (active === null ? 0 : active.enumerator.frontierSize) },
    get priorityRanges() { let count = 0; for (const ranges of rangesByPosition.values()) count += ranges.length; return count },
  }
}
