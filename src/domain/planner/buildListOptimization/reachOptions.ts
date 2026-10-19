/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage A options (moved from the Global Assignment
 * Research Phase A, Issue #154).
 *
 * Lazy, deterministic enumeration of the reach options of one planning Target from its ReachTable row
 * (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.3 / 5.2 / 5.4). An option is a necessary condition
 * (source + required positions per stream), never a Route and never a coexistence proof. The
 * generator never materializes the `source x Skill x Bonus` product: Phase B pulls options one at a
 * time (`countUpTo(k)` for MRV, value ordering, resume), and the order is a pure function of the table.
 *
 * Order (design 5.4): sources as listed (owned by OwnedWeapon ID, then `new_normal` by position);
 * per source, Skill requirements outer, Bonus requirements inner. Which requirements one lane of a
 * source admits is `sourceLaneAdmission()` under the table's option set (`ReachTable.continuesCurrentIdealLanes`):
 *   Skill, owned Gogma:  `none` when the current Skills are Ideal, else `reset_skills` by `s*` asc
 *                         (`s* <= resetSkillsLimit`); continuation: `none`, then `reset_skills` by `s*` asc.
 *   Skill, Normal:       `conversion (c, s*)` by `s*` asc (`s* <= conversionLimit`); for one `s*` first
 *                         `c = s*`, then `c = s* - 1, ..., originSkill` (the closest conversion first).
 *   Bonus, owned Gogma already Ideal in `gogma_artian` scope: `none`; continuation: `none`, then the
 *                         operations below.
 *   Bonus, otherwise:    `reset` by `g*` asc, then `keep_from_source` by `g*` asc (only when the
 *                         source's layout is Keep-supported), then `reset_then_keep` by `(g*, g1)` asc
 *                         with `g1 < g*` and `layout(Reset(g1))` Keep-Ideal at `g*`.
 * Chains between required positions (Reset -> Reset, Keep -> Keep, Reset Skills -> Reset Skills) are
 * skippable units and are not part of an option (design 5.2); Counter coverage decides them later.
 * The continuations add no position, layout or prediction: they reuse the Target's Ideal Skill / Reset
 * positions, the source's Keep-Ideal positions and the compact `reset_then_keep` index (audit 3.4).
 *
 * Stage B (design 6.3 / 6.4) and the Stage C coverage read the same rules through the per-source and per-requirement
 * entry points below (`sourceLaneAdmission()`, `skillRequirementBlocks()`, `enumerateSkillRequirements()`,
 * `enumerateBonusRequirements()`, `enumerateReachOptionsOfSource()`, `createReachOption()`), so its lazily
 * ordered enumeration, its lower bound and the coverage validation never re-implement an option rule: the
 * full enumeration is exactly the concatenation of the per-source enumerations, and every path builds
 * options through the one factory.
 */
import {
  type BonusRequirement, type LayoutKey, type ReachOption, type ReachTable, type SkillRequirement,
  type SourceCandidate, type StreamEnd, type TargetReach,
} from './buildListOptimizationTypes'

/**
 * Which requirements one lane (Skill or Bonus) of a source admits, in enumeration order:
 *   `none_only`             `none` alone (no operation on the lane)
 *   `operations_only`       the lane's operations; `none` is not a requirement of it
 *   `none_then_operations`  `none`, then the lane's operations (a continuation of a current-Ideal lane)
 */
export type LaneAdmission = 'none_only' | 'operations_only' | 'none_then_operations'

export interface SourceLaneAdmission {
  skill: LaneAdmission
  bonus: LaneAdmission
}

/**
 * The one option rule of a source's two lanes (design 5.2, A-2). Every Stage reads it - the Stage A enumeration, the Stage B
 * value-order lattice and lower bound, and the Stage C option validation - so no two of them can judge one option by
 * different rules.
 *
 * - A Normal source always converts (Skill) and always amends its `normal_artian` slots (Bonus): `operations_only` on both.
 * - A protected Gogma accepts no Skill or Bonus operation (REQUIREMENTS 21): `none_only` on both, whatever the option set. A
 *   protected Gogma is a source only while both of its axes are Ideal (`classifyOwnedSource()`); protection is checked here on
 *   its own, never inferred from Ideal-ness or `status`.
 * - `continuesCurrentIdealLanes` (the Build List global optimization's option set, the Research `a2`): a current-Ideal lane is
 *   `none_then_operations` (G2: the game allows Reset Skills / Reset / Keep after an Ideal, audit 1.1), a non-Ideal lane
 *   `operations_only` - except on a source Ideal on both axes for the Target, which keeps `none_only` on both (G4-iii, audit 3.6:
 *   the Target is satisfied by that weapon at Planner start and, with that Entry the only Route on it, the Planner never commits
 *   it; fixed by the Research `plannerStartIdealTransition.test.ts`).
 * - without continuation (the Research `a1` only): a current-Ideal lane is `none_only`, a non-Ideal lane `operations_only`.
 */
export function sourceLaneAdmission(source: SourceCandidate, continuesCurrentIdealLanes: boolean): SourceLaneAdmission {
  if (source.kind !== 'owned_gogma') return { skill: 'operations_only', bonus: 'operations_only' }
  if (source.isProtected) return { skill: 'none_only', bonus: 'none_only' }
  const continues = continuesCurrentIdealLanes && !(source.currentSkillIdeal && source.currentBonusIdeal)
  const idealLane: LaneAdmission = continues ? 'none_then_operations' : 'none_only'
  return { skill: source.currentSkillIdeal ? idealLane : 'operations_only', bonus: source.currentBonusIdeal ? idealLane : 'operations_only' }
}

/** Whether `none` is one of the lane's requirements. */
export function laneAdmitsNone(admission: LaneAdmission): boolean {
  return admission !== 'operations_only'
}

/** Whether an operation is one of the lane's requirements. */
export function laneAdmitsOperations(admission: LaneAdmission): boolean {
  return admission !== 'none_only'
}

/**
 * The structure behind one source's Skill requirements (design 5.2), in enumeration order. `none` is one
 * requirement; `reset_skills` is one per listed final position, after one leading `none` when the lane is an
 * continuation (`leadingNone`, `sourceLaneAdmission()`); `conversion` is, per listed final `s*`, the block
 * `c = s*, s* - 1, ..., originSkill` (`s* - originSkill + 1` requirements).
 */
export type SkillRequirementBlocks =
  | { kind: 'none' }
  | { kind: 'reset_skills'; leadingNone: boolean; finalPositions: number[] }
  | { kind: 'conversion'; finalPositions: number[]; originSkill: number }

export function skillRequirementBlocks(target: TargetReach, source: SourceCandidate, table: Pick<ReachTable, 'originSkill' | 'continuesCurrentIdealLanes'>): SkillRequirementBlocks {
  if (source.kind === 'owned_gogma') {
    const admission = sourceLaneAdmission(source, table.continuesCurrentIdealLanes).skill
    if (admission === 'none_only') return { kind: 'none' }
    return { kind: 'reset_skills', leadingNone: laneAdmitsNone(admission), finalPositions: target.skill.idealPositions.filter(position => position <= target.skill.resetSkillsLimit) }
  }
  return { kind: 'conversion', finalPositions: target.skill.idealPositions.filter(position => position <= target.skill.conversionLimit), originSkill: table.originSkill }
}

function* skillRequirements(target: TargetReach, source: SourceCandidate, table: ReachTable): Generator<SkillRequirement, void, undefined> {
  const blocks = skillRequirementBlocks(target, source, table)
  switch (blocks.kind) {
    case 'none':
      yield { kind: 'none' }
      return
    case 'reset_skills':
      if (blocks.leadingNone) yield { kind: 'none' }
      for (const finalPosition of blocks.finalPositions) yield { kind: 'reset_skills', finalPosition }
      return
    case 'conversion':
      for (const finalPosition of blocks.finalPositions) {
        for (let conversionPosition = finalPosition; conversionPosition >= blocks.originSkill; conversionPosition--) {
          yield { kind: 'conversion', conversionPosition, finalPosition }
        }
      }
      return
  }
}

/** The Skill requirements of one source in enumeration order (the outer loop of `enumerateReachOptionsOfSource()`). */
export function enumerateSkillRequirements(target: TargetReach, source: SourceCandidate, table: ReachTable): Generator<SkillRequirement, void, undefined> {
  return skillRequirements(target, source, table)
}

/**
 * Keep-Ideal positions reachable through a Reset layout, ascending and unique, with the Reset positions
 * that produce each layout (`reset_then_keep`, design 5.2). A Target-level fact: it reads no source.
 */
export function resetThenKeepPlan(target: TargetReach): { finalPositions: number[]; resetPositionsByLayout: Map<LayoutKey, number[]> } {
  const resetPositionsByLayout = new Map<LayoutKey, number[]>()
  const unsupported = new Set(target.bonus.keepUnsupportedLayouts)
  for (const [position, layout] of target.bonus.resetLayoutByPosition) {
    if (!target.bonus.keepIdealPositionsByLayout.has(layout) || unsupported.has(layout)) continue
    const positions = resetPositionsByLayout.get(layout)
    if (positions) positions.push(position)
    else resetPositionsByLayout.set(layout, [position])
  }
  const finalPositions = new Set<number>()
  for (const layout of resetPositionsByLayout.keys()) {
    for (const position of target.bonus.keepIdealPositionsByLayout.get(layout) ?? []) finalPositions.add(position)
  }
  return { finalPositions: [...finalPositions].sort((left, right) => left - right), resetPositionsByLayout }
}

/** The `reset_then_keep` requirements of a Target by `(g*, g1)` ascending; the same for every source whose Bonus lane admits operations. */
export function* enumerateResetThenKeepRequirements(target: TargetReach): Generator<Extract<BonusRequirement, { kind: 'reset_then_keep' }>, void, undefined> {
  const plan = resetThenKeepPlan(target)
  for (const finalPosition of plan.finalPositions) {
    // g1 ascending over every Reset position whose layout is Keep-Ideal at g*, and strictly before g*.
    const candidates: number[] = []
    for (const [layout, resetPositions] of plan.resetPositionsByLayout) {
      if (!(target.bonus.keepIdealPositionsByLayout.get(layout) ?? []).includes(finalPosition)) continue
      for (const resetPosition of resetPositions) {
        if (resetPosition >= finalPosition) break
        candidates.push(resetPosition)
      }
    }
    for (const resetPosition of candidates.sort((left, right) => left - right)) yield { kind: 'reset_then_keep', resetPosition, finalPosition }
  }
}

export type ResetThenKeepRequirement = Extract<BonusRequirement, { kind: 'reset_then_keep' }>

/**
 * The `reset_then_keep` requirements of one Target as a compact random-access index in the generator's
 * order (`finalPosition` ascending, `resetPosition` ascending within one final), holding no `(g1, g*)`
 * pair. It holds only the eligible Reset positions (per layout and merged, ascending), the eligible
 * layouts, and one group per final Keep position that at least one earlier eligible Reset reaches
 * (its layouts and its count, with a running start index). `at(index)` locates the group by binary
 * search over the starts and the `rank`-th smallest valid Reset position either directly (one layout)
 * or by a rank search over the merged Reset positions (several layouts), so the memory is
 * O(Reset positions + Keep positions x layouts) and one lookup is O(layouts x log^2 Reset positions),
 * never O(pairs). Phase B-1 reads it as a Bonus stream of the value-order lattice and for the lower
 * bound's final positions; `enumerateResetThenKeepRequirements()` stays the readable reference and the
 * two are kept equal pair by pair by test.
 */
export interface ResetThenKeepIndex {
  /** Σ over the finals of their valid earlier Resets: the exact number of requirements. */
  readonly length: number
  /** Final Keep positions that at least one valid earlier Reset reaches, ascending. */
  readonly finalPositions: readonly number[]
  at(index: number): ResetThenKeepRequirement
  /** Sizes of the arrays held (eligible Reset positions, eligible layouts, final groups and their layout references), so a test can assert compactness. */
  readonly footprint: { resetPositions: number; layouts: number; finalGroups: number; layoutReferences: number }
}

/** Elements of an ascending array strictly below `value`. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0, high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle]! < value) low = middle + 1
    else high = middle
  }
  return low
}

export function createResetThenKeepIndex(target: TargetReach): ResetThenKeepIndex {
  const plan = resetThenKeepPlan(target)
  const layouts = [...plan.resetPositionsByLayout.keys()]
  const resetsByLayout = layouts.map(layout => [...plan.resetPositionsByLayout.get(layout)!].sort((left, right) => left - right))
  const keepIdealByLayout = layouts.map(layout => new Set(target.bonus.keepIdealPositionsByLayout.get(layout) ?? []))
  // Every Reset position has exactly one layout, so the merged positions are distinct.
  const allResets = resetsByLayout.flat().sort((left, right) => left - right)
  const groups: { finalPosition: number; layoutIndexes: number[]; start: number }[] = []
  let length = 0
  let layoutReferences = 0
  for (const finalPosition of plan.finalPositions) {
    const layoutIndexes: number[] = []
    let count = 0
    layouts.forEach((_layout, layoutIndex) => {
      if (!keepIdealByLayout[layoutIndex]!.has(finalPosition)) return
      const before = countBelow(resetsByLayout[layoutIndex]!, finalPosition)
      if (before === 0) return
      layoutIndexes.push(layoutIndex)
      count += before
    })
    if (count === 0) continue
    groups.push({ finalPosition, layoutIndexes, start: length })
    length += count
    layoutReferences += layoutIndexes.length
  }
  const at = (index: number): ResetThenKeepRequirement => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError(`reset_then_keep index ${String(index)} is out of range (${length}).`)
    let low = 0, high = groups.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (groups[middle]!.start <= index) low = middle
      else high = middle - 1
    }
    const group = groups[low]!
    const rank = index - group.start
    if (group.layoutIndexes.length === 1) {
      // The valid Resets of one layout are the ascending prefix of its positions below the final.
      return { kind: 'reset_then_keep', resetPosition: resetsByLayout[group.layoutIndexes[0]!]![rank]!, finalPosition: group.finalPosition }
    }
    // Several layouts: the rank-th smallest position among their Resets below the final is the smallest merged
    // position v with Σ_layout |{ p in layout : p <= v }| > rank (the count grows only at those layouts' positions).
    const countThrough = (value: number) => group.layoutIndexes.reduce((sum, layoutIndex) => sum + countBelow(resetsByLayout[layoutIndex]!, value + 1), 0)
    let first = 0, last = allResets.length - 1
    while (first < last) {
      const middle = (first + last) >> 1
      if (countThrough(allResets[middle]!) > rank) last = middle
      else first = middle + 1
    }
    return { kind: 'reset_then_keep', resetPosition: allResets[first]!, finalPosition: group.finalPosition }
  }
  return {
    length,
    finalPositions: groups.map(group => group.finalPosition),
    at,
    footprint: { resetPositions: allResets.length, layouts: layouts.length, finalGroups: groups.length, layoutReferences },
  }
}

/** The `keep_from_source` final positions of one source: its layout's Keep-Ideal positions, only while its Keep input is supported. */
export function keepFromSourcePositions(target: TargetReach, source: SourceCandidate): readonly number[] {
  if (!source.keepSupported) return []
  return target.bonus.keepIdealPositionsByLayout.get(source.layout) ?? []
}

function* bonusRequirements(target: TargetReach, source: SourceCandidate, table: ReachTable): Generator<BonusRequirement, void, undefined> {
  const admission = sourceLaneAdmission(source, table.continuesCurrentIdealLanes).bonus
  if (laneAdmitsNone(admission)) yield { kind: 'none' }
  if (!laneAdmitsOperations(admission)) return
  for (const finalPosition of target.bonus.resetIdealPositions) yield { kind: 'reset', finalPosition }
  for (const finalPosition of keepFromSourcePositions(target, source)) yield { kind: 'keep_from_source', finalPosition }
  yield* enumerateResetThenKeepRequirements(target)
}

/** The Bonus requirements of one source in enumeration order (the inner loop of `enumerateReachOptionsOfSource()`). */
export function enumerateBonusRequirements(target: TargetReach, source: SourceCandidate, table: ReachTable): Generator<BonusRequirement, void, undefined> {
  return bonusRequirements(target, source, table)
}

export function reachOptionStreamEnd(target: TargetReach, table: ReachTable, source: SourceCandidate, skill: SkillRequirement, bonus: BonusRequirement): StreamEnd {
  const normal: StreamEnd['normal'] = {}
  if (target.normalCounterId !== null) {
    normal[target.normalCounterId] = source.kind === 'new_normal' ? source.position + 1 : table.originNormal[target.normalCounterId]!
  }
  return {
    skill: skill.kind === 'none' ? table.originSkill : skill.finalPosition + 1,
    gogma: bonus.kind === 'none' ? table.originGogma : bonus.finalPosition + 1,
    normal,
  }
}

/** The one option factory: the same object whichever enumeration (full, per source, or Phase B-1's ordered lattice) reached it. */
export function createReachOption(target: TargetReach, table: ReachTable, source: SourceCandidate, skillRequired: SkillRequirement, bonusRequired: BonusRequirement): ReachOption {
  return {
    targetWeaponId: target.targetWeaponId,
    source,
    skillRequired,
    bonusRequired,
    normalRequired: source.kind === 'new_normal' ? { counterId: source.counterId, position: source.position } : null,
    streamEnd: reachOptionStreamEnd(target, table, source, skillRequired, bonusRequired),
    verification: 'necessary_only',
  }
}

/** Σ (streamEnd − origin): the physical operation count the option would need if it came true (design 6.1). */
export function reachOptionObjective(option: ReachOption, table: ReachTable): number {
  let total = (option.streamEnd.skill - table.originSkill) + (option.streamEnd.gogma - table.originGogma)
  for (const [counterId, end] of Object.entries(option.streamEnd.normal)) total += end - table.originNormal[counterId]!
  return total
}

/** A stable identity of the source alone (design 6.1 C1): one OwnedWeapon, or one forge position of one Normal Counter. */
export function sourceResourceKey(source: SourceCandidate): string {
  return source.kind === 'new_normal' ? `normal:${source.counterId}:${source.position}` : `owned:${source.ownedWeaponId}`
}

/** A stable identity of the whole option, independent of enumeration order, Clock or run. */
export function reachOptionKey(option: ReachOption): string {
  const skill = option.skillRequired.kind === 'none' ? 'none'
    : option.skillRequired.kind === 'reset_skills' ? `reset_skills:${option.skillRequired.finalPosition}`
      : `conversion:${option.skillRequired.conversionPosition}:${option.skillRequired.finalPosition}`
  const bonus = option.bonusRequired.kind === 'none' ? 'none'
    : option.bonusRequired.kind === 'reset_then_keep' ? `reset_then_keep:${option.bonusRequired.resetPosition}:${option.bonusRequired.finalPosition}`
      : `${option.bonusRequired.kind}:${option.bonusRequired.finalPosition}`
  return `${option.targetWeaponId}|${sourceResourceKey(option.source)}|${skill}|${bonus}`
}

/** Lazily yields every reach option of `target` from one of its sources, Skill requirements outer and Bonus requirements inner. */
export function* enumerateReachOptionsOfSource(target: TargetReach, table: ReachTable, source: SourceCandidate): Generator<ReachOption, void, undefined> {
  for (const skillRequired of skillRequirements(target, source, table)) {
    for (const bonusRequired of bonusRequirements(target, source, table)) {
      yield createReachOption(target, table, source, skillRequired, bonusRequired)
    }
  }
}

/**
 * Lazily yields every reach option of `target` in the documented deterministic order. A source with no
 * Skill or no Bonus requirement in the window yields nothing; that is a window / support fact, never
 * "unreachable". The caller stops whenever it has enough (`countUpTo(k)`, first match).
 */
export function* enumerateReachOptions(target: TargetReach, table: ReachTable): Generator<ReachOption, void, undefined> {
  for (const source of target.sources) yield* enumerateReachOptionsOfSource(target, table, source)
}

/** The first `limit` options, without enumerating the rest (MRV domain counting, design 6.4). */
export function takeReachOptions(target: TargetReach, table: ReachTable, limit: number): ReachOption[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`takeReachOptions limit must be a non-negative integer (got ${String(limit)}).`)
  const taken: ReachOption[] = []
  if (limit === 0) return taken
  for (const option of enumerateReachOptions(target, table)) {
    taken.push(option)
    if (taken.length >= limit) break
  }
  return taken
}
