/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage C (moved from the Global Assignment Research
 * Phase C-1, Issue #154).
 *
 * The static Counter coverage pre-check, the coverer prediction and the materialization order of one
 * resource assignment (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 8.1 / 8.2). Pure calculation over a
 * Phase B-1 `ResourceAssignmentCandidate` and its ReachTable: no Engine, no PlannerInput, no Search, no
 * Planner, and no held / blocked / sharing rule of its own (design 7). Every judgement here is a
 * necessary condition; Production coexistence is decided only by Phase D' (design 8.4).
 *
 * Coverage (design 8.1). Each stream's `origin .. end - 1` needs at least one unit at every position, or
 * the Production scheduler stalls. The required positions come from the assignment; every gap between
 * them must be fillable by one Target's skippable chain. A Target can fill a gap `[from, to]` when the
 * gap lies inside its chain reach `[entry, final - 1]`:
 *   Normal: only the owner of the farthest production target `pmax` (entry = origin, final = pmax). It
 *           forges `origin .. pmax` itself; the other Targets' production targets inside are required
 *           forges its own Counter-advance forges are fast-forwarded past. So a Normal Counter with a
 *           `new_normal` source is always covered.
 *   Gogma:  every Target with a Bonus operation (entry = origin, final = its last Bonus position): a Reset
 *           chain (`reset`), a Keep chain (`keep_from_source`), or a Reset chain before and a Keep chain
 *           after the required Reset (`reset_then_keep`). A converted weapon's Gogma units wait for its
 *           conversion; waiting is not a stall. The owner of the next required position always reaches it,
 *           so the Gogma stream is always covered.
 *   Skill:  an owned Gogma with `reset_skills` (entry = origin, final = its Reset Skills position), and a
 *           conversion Target only after its conversion (entry = c + 1). A gap before every reaching
 *           conversion is uncovered unless an existing Gogma's Reset Skills chain spans it.
 * A stream without a required position is empty and needs no coverer. Chain positions are never added
 * to the C2 exclusive positions: they are not resources (design 6.1 / 6.4).
 *
 * Coverer choice (design 8.2): the owner of the gap's next required position when it can fill the gap
 * (nearest successor), otherwise the reaching Target with the smallest final position of that stream,
 * then an owned source before a new Normal, then Target ID ascending. A prediction only - Phase D's
 * Search decides the real chain - used for the pre-check, the order, a later Search scale gate and
 * diagnostics, never as a Search shape constraint.
 *
 * Materialization order (design 8.2). A conversion Target can convert at `c` only once every Skill
 * position below `c` is held by already materialized Routes, so conversion Targets are placed in
 * ascending `c` (then Target ID), each after the Targets every Skill position below its `c` is attributed
 * to (gap coverers and required-position owners; only owned Gogma Targets and conversion Targets with a
 * lower `c` can be such Targets). The design pseudocode names the gap coverers; this implementation also
 * places a required-position owner below `c` first, because the design's reason is that every position
 * below `c` must be held - an owned Gogma whose Reset Skills is the position right after another
 * required position covers no gap of its own but still holds a position below `c`. The remaining Targets
 * follow in ascending max stream advance, then Target ID. Gogma and Normal add no dependency. A
 * feasible pre-check always admits this order; a violation is an internal invariant error.
 */
import type { TargetWeaponId } from '../../models/publicTypes'
import { requiredPositionsOf } from './assignmentFeasibility'
import type { RequiredPositions, ResourceAssignmentCandidate } from './assignmentTypes'
import type {
  CoverageInputIssue, CoverageRequiredPosition, CoverageSegment, CoverageStream, MaterializationDependency, MaterializationPlan,
  StreamCoverage, StreamCoverageResult, UncoveredGap,
} from './coverageTypes'
import { laneAdmitsNone, laneAdmitsOperations, sourceLaneAdmission, sourceResourceKey, type LaneAdmission } from './reachOptions'
import { BuildListOptimizationInvariantError, type ReachOption, type ReachTable, type SourceCandidate, type StreamEnd, type TargetReach } from './buildListOptimizationTypes'

class CoverageInputError extends Error {
  readonly reason: CoverageInputIssue

  constructor(reason: CoverageInputIssue, message: string) {
    super(message)
    this.reason = reason
  }
}

function reject(reason: CoverageInputIssue, message: string): never {
  throw new CoverageInputError(reason, message)
}

function invariant(message: string): never {
  throw new BuildListOptimizationInvariantError('coverage_invariant', message)
}

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** Stream order of every result: Skill, Gogma, then every Normal Counter of the table in ID order. */
export function coverageStreamsOf(table: ReachTable): CoverageStream[] {
  return [{ kind: 'skill' }, { kind: 'gogma' }, ...Object.keys(table.originNormal).sort(compareIds).map(counterId => ({ kind: 'normal' as const, counterId }))]
}

export function coverageStreamLabel(stream: CoverageStream): string {
  return stream.kind === 'normal' ? `normal:${stream.counterId}` : stream.kind
}

/** A canonical string of every field of a source, so a forged or edited source never matches a row source. */
function sourceSignature(source: SourceCandidate): string {
  switch (source.kind) {
    case 'owned_gogma':
      return JSON.stringify([source.kind, source.ownedWeaponId, source.layout, source.scope, source.currentSkillIdeal, source.currentBonusIdeal, source.isProtected, source.keepSupported])
    case 'owned_normal':
      return JSON.stringify([source.kind, source.ownedWeaponId, source.layout, source.isProtected, source.keepSupported])
    case 'new_normal':
      return JSON.stringify([source.kind, source.counterId, source.position, source.layout, source.keepSupported])
  }
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function requireRange(value: number, from: number, to: number, what: string): void {
  if (!isPosition(value)) reject('invalid_option', `${what} must be a safe integer (got ${String(value)}).`)
  if (value < from || value > to) reject('invalid_option', `${what} ${value} lies outside ${from}..${to}.`)
}

/** How a lane's admission names its requirement kinds in a rejection message. */
function admissionText(admission: LaneAdmission, operation: string): string {
  return admission === 'none_only' ? 'none' : admission === 'operations_only' ? operation : `none or ${operation}`
}

/**
 * Checks one option against its Target's ReachTable row (design 5.2 / 5.5) without any prediction. Which requirement kinds a
 * lane admits is the table option set's rule (`sourceLaneAdmission()`, the one rule Phase A enumerates and Phase B orders by);
 * everything else is checked here on its own, never by asking the Phase A generator whether it lists the option: the source is
 * a row source (every field), protection, each required position inside the scanned window (a conversion before its final
 * Skill, a `reset_then_keep` Reset before its Keep), Keep support, the Normal production target, and `streamEnd` re-derived.
 * Whether a position is Ideal is the required-only replay's question (design 5.3), which Phase C asks before any shape exists.
 */
function validateOption(option: ReachOption, row: TargetReach, table: ReachTable): void {
  const id = row.targetWeaponId
  const signature = sourceSignature(option.source)
  if (!row.sources.some(source => sourceSignature(source) === signature)) reject('invalid_option', `Target ${id}: the option's source ${sourceResourceKey(option.source)} is not a source of its ReachTable row.`)
  const { source, skillRequired, bonusRequired } = option
  if (source.kind === 'owned_gogma' && source.isProtected && (skillRequired.kind !== 'none' || bonusRequired.kind !== 'none')) {
    reject('invalid_option', `Target ${id}: the protected Gogma ${source.ownedWeaponId} accepts no Skill or Bonus operation (REQUIREMENTS 21).`)
  }
  const admission = sourceLaneAdmission(source, table.continuesCurrentIdealLanes)
  // Skill requirement kind and window (design 5.2 / A-2; the row's limits are the scanned window).
  if (source.kind === 'owned_gogma') {
    const allowed = (skillRequired.kind === 'none' && laneAdmitsNone(admission.skill)) || (skillRequired.kind === 'reset_skills' && laneAdmitsOperations(admission.skill))
    if (!allowed) {
      reject('invalid_option', `Target ${id}: an owned Gogma ${source.currentSkillIdeal ? 'with' : 'without'} Ideal Skills needs Skill requirement ${admissionText(admission.skill, 'reset_skills')} under ${table.optionSet} (got ${skillRequired.kind}).`)
    }
    if (skillRequired.kind === 'reset_skills') requireRange(skillRequired.finalPosition, table.originSkill, row.skill.resetSkillsLimit, `Target ${id}: Reset Skills position`)
  } else {
    if (skillRequired.kind !== 'conversion') reject('invalid_option', `Target ${id}: a Normal source needs a conversion (got ${skillRequired.kind}).`)
    requireRange(skillRequired.finalPosition, table.originSkill, row.skill.conversionLimit, `Target ${id}: final Skill position`)
    requireRange(skillRequired.conversionPosition, table.originSkill, skillRequired.finalPosition, `Target ${id}: conversion position`)
  }
  // Bonus requirement kind and window.
  if (bonusRequired.kind === 'none') {
    if (!laneAdmitsNone(admission.bonus)) reject('invalid_option', `Target ${id}: Bonus requirement none needs an owned Gogma already Ideal in gogma_artian scope.`)
  } else {
    if (!laneAdmitsOperations(admission.bonus)) reject('invalid_option', `Target ${id}: an owned Gogma already Ideal needs Bonus requirement ${admissionText(admission.bonus, 'an amendment')} under ${table.optionSet} (got ${bonusRequired.kind}).`)
    requireRange(bonusRequired.finalPosition, table.scanned.gogma.from, table.scanned.gogma.to, `Target ${id}: final Gogma position`)
    if (bonusRequired.kind === 'keep_from_source' && !source.keepSupported) reject('invalid_option', `Target ${id}: keep_from_source needs a Keep-supported source layout.`)
    if (bonusRequired.kind === 'reset_then_keep') {
      requireRange(bonusRequired.resetPosition, table.scanned.gogma.from, bonusRequired.finalPosition - 1, `Target ${id}: reset_then_keep Reset position`)
    }
  }
  // Normal requirement.
  if (source.kind === 'new_normal') {
    if (row.normalCounterId === null || source.counterId !== row.normalCounterId) reject('invalid_option', `Target ${id}: new_normal Counter ${source.counterId} is not the row's confirmed Counter ${String(row.normalCounterId)}.`)
    const scanned = table.scanned.normal[source.counterId]
    if (!scanned || table.originNormal[source.counterId] === undefined) reject('invalid_option', `Target ${id}: the table holds no Normal Counter ${source.counterId}.`)
    requireRange(source.position, scanned.from, scanned.to, `Target ${id}: production-target forge position`)
    if (option.normalRequired === null || option.normalRequired.counterId !== source.counterId || option.normalRequired.position !== source.position) {
      reject('invalid_option', `Target ${id}: a new_normal option must carry its own forge as normalRequired.`)
    }
  } else if (option.normalRequired !== null) {
    reject('invalid_option', `Target ${id}: an owned source has no Normal requirement.`)
  }
  // streamEnd re-derived from the required positions and the table origins (design 4.3), independently of the generator.
  const expected: StreamEnd = {
    skill: skillRequired.kind === 'none' ? table.originSkill : skillRequired.finalPosition + 1,
    gogma: bonusRequired.kind === 'none' ? table.originGogma : bonusRequired.finalPosition + 1,
    normal: row.normalCounterId === null ? {} : { [row.normalCounterId]: source.kind === 'new_normal' ? source.position + 1 : table.originNormal[row.normalCounterId]! },
  }
  const actual = option.streamEnd
  const actualKeys = Object.keys(actual.normal).sort(compareIds)
  const expectedKeys = Object.keys(expected.normal).sort(compareIds)
  if (actual.skill !== expected.skill || actual.gogma !== expected.gogma || actualKeys.join('|') !== expectedKeys.join('|') || expectedKeys.some(key => actual.normal[key] !== expected.normal[key])) {
    reject('invalid_option', `Target ${id}: streamEnd ${JSON.stringify(actual)} differs from the re-derived ${JSON.stringify(expected)}.`)
  }
}

interface ValidatedInput {
  /** Table Target order. */
  options: ReachOption[]
  rows: TargetReach[]
  required: RequiredPositions[]
}

/** Every structural check of a resource assignment against its ReachTable (no prediction). */
function validate(candidate: ResourceAssignmentCandidate, table: ReachTable): ValidatedInput {
  if (candidate === null || typeof candidate !== 'object' || candidate.kind !== 'resource_assignment') reject('invalid_candidate', 'The value is not a resource assignment.')
  if (!isPosition(candidate.ordinal) || candidate.ordinal < 0) reject('invalid_candidate', `ordinal must be a non-negative integer (got ${String(candidate.ordinal)}).`)
  if (!(candidate.chosen instanceof Map)) reject('invalid_candidate', 'chosen must be a Map.')
  for (const value of [table.originSkill, table.originGogma, ...Object.values(table.originNormal)]) {
    if (!isPosition(value) || value < 0) reject('invalid_candidate', `The ReachTable origin ${String(value)} is not a non-negative integer.`)
  }
  const rows = table.targets
  const ids = rows.map(row => row.targetWeaponId)
  if (new Set(ids).size !== ids.length) reject('planning_target_mismatch', 'The ReachTable holds a Target twice.')
  if (candidate.chosen.size !== rows.length || ids.some(id => !candidate.chosen.has(id))) {
    reject('planning_target_mismatch', `The assignment's Targets [${[...candidate.chosen.keys()].join(', ')}] differ from the ReachTable's [${ids.join(', ')}].`)
  }
  const order = candidate.assignmentOrder
  if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || order.some(id => !candidate.chosen.has(id))) {
    reject('invalid_candidate', 'assignmentOrder must list every Target of the assignment exactly once.')
  }
  const options = rows.map(row => {
    const option = candidate.chosen.get(row.targetWeaponId)!
    if (option.targetWeaponId !== row.targetWeaponId) reject('invalid_option', `The option stored for Target ${row.targetWeaponId} names Target ${option.targetWeaponId}.`)
    validateOption(option, row, table)
    return option
  })
  const required = options.map(option => {
    try {
      return requiredPositionsOf(option)
    } catch (error) {
      reject('invalid_option', error instanceof Error ? error.message : String(error))
    }
  })
  // C1 / C2 (design 6.1): sources, and required positions per stream, are pairwise disjoint.
  const sources = new Map<string, string>()
  const skill = new Map<number, string>()
  const gogma = new Map<number, string>()
  const normal = new Map<string, string>()
  const claim = <K>(map: Map<K, string>, key: K, id: string, what: string) => {
    const owner = map.get(key)
    if (owner !== undefined) reject('resource_conflict', `Targets ${owner} and ${id} share ${what} ${String(key)}.`)
    map.set(key, id)
  }
  options.forEach((option, index) => {
    const id = option.targetWeaponId
    claim(sources, sourceResourceKey(option.source), id, 'the source')
    for (const position of required[index]!.skill) claim(skill, position, id, 'the required Skill position')
    for (const position of required[index]!.gogma) claim(gogma, position, id, 'the required Gogma position')
    const forge = required[index]!.normal
    if (forge) claim(normal, `${forge.counterId}@${forge.position}`, id, 'the production-target forge')
  })
  // Aggregates (design 4.3): the candidate's own fields must be exactly what its options imply.
  const counterIds = Object.keys(table.originNormal).sort(compareIds)
  const sortedNumbers = (values: Iterable<number>) => [...values].sort((left, right) => left - right)
  const expectedRequired = {
    skill: sortedNumbers(skill.keys()),
    gogma: sortedNumbers(gogma.keys()),
    normal: Object.fromEntries(counterIds.map(counterId => [counterId, sortedNumbers(required.flatMap(value => value.normal && value.normal.counterId === counterId ? [value.normal.position] : []))])),
  }
  const expectedEnd: StreamEnd = {
    skill: Math.max(table.originSkill, ...options.map(option => option.streamEnd.skill)),
    gogma: Math.max(table.originGogma, ...options.map(option => option.streamEnd.gogma)),
    normal: Object.fromEntries(counterIds.map(counterId => [counterId, Math.max(table.originNormal[counterId]!, ...options.map(option => option.streamEnd.normal[counterId] ?? table.originNormal[counterId]!))])),
  }
  let expectedObjective = (expectedEnd.skill - table.originSkill) + (expectedEnd.gogma - table.originGogma)
  for (const counterId of counterIds) expectedObjective += expectedEnd.normal[counterId]! - table.originNormal[counterId]!
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  const actualRequired = candidate.requiredPositions
  if (!same([...candidate.usedSources], [...sources.keys()].sort(compareIds))) reject('aggregate_mismatch', 'usedSources differs from the options\' sources.')
  if (!actualRequired || !same(actualRequired.skill, expectedRequired.skill) || !same(actualRequired.gogma, expectedRequired.gogma)
    || !same(Object.keys(actualRequired.normal ?? {}).sort(compareIds), counterIds) || counterIds.some(counterId => !same(actualRequired.normal[counterId], expectedRequired.normal[counterId]))) {
    reject('aggregate_mismatch', `requiredPositions ${JSON.stringify(actualRequired)} differs from the options' ${JSON.stringify(expectedRequired)}.`)
  }
  const actualEnd = candidate.streamEnd
  if (!actualEnd || actualEnd.skill !== expectedEnd.skill || actualEnd.gogma !== expectedEnd.gogma || !same(Object.keys(actualEnd.normal ?? {}).sort(compareIds), counterIds)
    || counterIds.some(counterId => actualEnd.normal[counterId] !== expectedEnd.normal[counterId])) {
    reject('aggregate_mismatch', `streamEnd ${JSON.stringify(actualEnd)} differs from the options' ${JSON.stringify(expectedEnd)}.`)
  }
  if (candidate.objective !== expectedObjective) reject('aggregate_mismatch', `objective ${String(candidate.objective)} differs from Σ (end − origin) = ${expectedObjective}.`)
  return { options, rows, required }
}

/** One Target's chain reach on one stream: it can fill a gap `[from, to]` when `entry <= from` and `to < final`. */
export interface CoverageHolder {
  targetWeaponId: TargetWeaponId
  entry: number
  final: number
  owned: boolean
  /** Skill only: the conversion position of a conversion Target, for diagnostics. */
  conversionPosition: number | null
}

function holdersOf(stream: CoverageStream, options: readonly ReachOption[], required: readonly RequiredPositions[], origin: number): CoverageHolder[] {
  const holders: CoverageHolder[] = []
  if (stream.kind === 'normal') {
    // Only the farthest production target's owner forges from the origin (design 8.1 / 8.3 Normal coverer).
    let farthest: CoverageHolder | null = null
    for (let index = 0; index < options.length; index++) {
      const forge = required[index]!.normal
      if (!forge || forge.counterId !== stream.counterId) continue
      if (farthest === null || forge.position > farthest.final) farthest = { targetWeaponId: options[index]!.targetWeaponId, entry: origin, final: forge.position, owned: false, conversionPosition: null }
    }
    if (farthest !== null) holders.push(farthest)
    return holders
  }
  for (const option of options) {
    const owned = option.source.kind !== 'new_normal'
    if (stream.kind === 'gogma') {
      if (option.bonusRequired.kind === 'none') continue
      holders.push({ targetWeaponId: option.targetWeaponId, entry: origin, final: option.bonusRequired.finalPosition, owned, conversionPosition: null })
    } else if (option.skillRequired.kind === 'reset_skills') {
      holders.push({ targetWeaponId: option.targetWeaponId, entry: origin, final: option.skillRequired.finalPosition, owned, conversionPosition: null })
    } else if (option.skillRequired.kind === 'conversion') {
      // The converted weapon exists in the Skill stream only from its conversion on: its chain is c + 1 .. s* - 1.
      const { conversionPosition, finalPosition } = option.skillRequired
      holders.push({ targetWeaponId: option.targetWeaponId, entry: conversionPosition + 1, final: finalPosition, owned, conversionPosition })
    }
  }
  return holders
}

function requiredOf(stream: CoverageStream, options: readonly ReachOption[], required: readonly RequiredPositions[]): CoverageRequiredPosition[] {
  const list: CoverageRequiredPosition[] = []
  options.forEach((option, index) => {
    const positions = stream.kind === 'skill' ? required[index]!.skill
      : stream.kind === 'gogma' ? required[index]!.gogma
        : required[index]!.normal && required[index]!.normal!.counterId === stream.counterId ? [required[index]!.normal!.position] : []
    for (const position of positions) list.push({ position, targetWeaponId: option.targetWeaponId })
  })
  return list.sort((left, right) => left.position - right.position)
}

function streamOrigin(stream: CoverageStream, table: ReachTable): number {
  return stream.kind === 'skill' ? table.originSkill : stream.kind === 'gogma' ? table.originGogma : table.originNormal[stream.counterId]!
}

function streamEndOf(stream: CoverageStream, candidate: ResourceAssignmentCandidate): number {
  return stream.kind === 'skill' ? candidate.streamEnd.skill : stream.kind === 'gogma' ? candidate.streamEnd.gogma : candidate.streamEnd.normal[stream.counterId]!
}

/**
 * The design 8.2 coverer of a gap among the Targets that can fill it (`fillers`, non-empty): the owner of
 * the next required position, else the smallest final position, then an owned source, then Target ID.
 * With a C2-consistent assignment the final positions of one stream are distinct, so the last two keys
 * are a defensive total order that keeps the choice deterministic.
 */
export function selectCoverer(fillers: readonly CoverageHolder[], next: CoverageRequiredPosition): CoverageHolder {
  if (fillers.length === 0) invariant('selectCoverer needs at least one filler.')
  const successor = fillers.find(holder => holder.targetWeaponId === next.targetWeaponId)
  if (successor) return successor
  return [...fillers].sort((left, right) => left.final - right.final || Number(right.owned) - Number(left.owned) || compareIds(left.targetWeaponId, right.targetWeaponId))[0]!
}

function computeCoverage(candidate: ResourceAssignmentCandidate, table: ReachTable, input: ValidatedInput): StreamCoverageResult {
  const coverage: StreamCoverage[] = []
  const uncovered: UncoveredGap[] = []
  for (const stream of coverageStreamsOf(table)) {
    const origin = streamOrigin(stream, table)
    const end = streamEndOf(stream, candidate)
    const required = requiredOf(stream, input.options, input.required)
    const expectedEnd = required.length === 0 ? origin : required[required.length - 1]!.position + 1
    if (end !== expectedEnd) invariant(`Stream ${coverageStreamLabel(stream)}: end ${end} differs from the last required position + 1 (${expectedEnd}) after validation.`)
    const holders = holdersOf(stream, input.options, input.required, origin)
    const segments: CoverageSegment[] = []
    let previous: CoverageRequiredPosition | null = null
    for (const next of required) {
      const from = previous === null ? origin : previous.position + 1
      const to = next.position - 1
      if (from <= to) {
        const fillers = holders.filter(holder => holder.entry <= from && to < holder.final)
        if (fillers.length === 0) {
          // Only the Skill stream can lack a filler: the next owner of a Gogma / Normal gap always reaches it.
          if (stream.kind !== 'skill') invariant(`Stream ${coverageStreamLabel(stream)}: gap ${from}..${to} has no coverer, which the design rules exclude.`)
          const reaching = holders.filter(holder => to < holder.final && holder.conversionPosition !== null)
            .sort((left, right) => left.conversionPosition! - right.conversionPosition! || compareIds(left.targetWeaponId, right.targetWeaponId))
            .map(holder => ({ targetWeaponId: holder.targetWeaponId, conversionPosition: holder.conversionPosition! }))
          uncovered.push({ stream, from, to, firstUncoveredPosition: from, previousRequired: previous, nextRequired: next, reason: 'no_skill_holder_across_gap', reachingTargetsEnteringLater: reaching })
        } else {
          segments.push({ kind: 'chain', from, to, covererTargetWeaponId: selectCoverer(fillers, next).targetWeaponId })
        }
      }
      segments.push({ kind: 'required', from: next.position, to: next.position, covererTargetWeaponId: next.targetWeaponId })
      previous = next
    }
    coverage.push({ stream, origin, end, required, segments })
  }
  if (uncovered.length > 0) return { kind: 'coverage_infeasible', uncovered, firstUncovered: uncovered[0]! }
  for (const value of coverage) assertPartition(value)
  return { kind: 'feasible', coverage }
}

/** The `CoverageSegment` endpoint rule: the segments partition `origin .. end - 1` exactly once. */
function assertPartition(coverage: StreamCoverage): void {
  let cursor = coverage.origin
  for (const segment of coverage.segments) {
    if (segment.from !== cursor || segment.to < segment.from) invariant(`Stream ${coverageStreamLabel(coverage.stream)}: segment ${segment.from}..${segment.to} does not continue at ${cursor}.`)
    cursor = segment.to + 1
  }
  if (cursor !== coverage.end) invariant(`Stream ${coverageStreamLabel(coverage.stream)}: segments end at ${cursor - 1}, the stream ends at ${coverage.end - 1}.`)
}

/**
 * The static coverage pre-check of one resource assignment (design 8.1 / 8.2). `feasible` holds every
 * stream's partition into required and chain segments; `coverage_infeasible` lists every uncovered gap
 * (all of them Skill gaps) and the first one; `invalid_input` rejects an inconsistent assignment before
 * any coverage judgement. A design rule contradicted after validation throws
 * `BuildListOptimizationInvariantError('coverage_invariant')`.
 */
export function checkStreamCoverage(candidate: ResourceAssignmentCandidate, table: ReachTable): StreamCoverageResult {
  let input: ValidatedInput
  try {
    input = validate(candidate, table)
  } catch (error) {
    if (error instanceof CoverageInputError) return { kind: 'invalid_input', reason: error.reason, detail: error.message }
    throw error
  }
  return computeCoverage(candidate, table, input)
}

/** Max over streams of (option stream end − origin): the advance the remaining Targets are ordered by (design 8.2). */
function maxStreamAdvance(option: ReachOption, table: ReachTable): number {
  let advance = Math.max(option.streamEnd.skill - table.originSkill, option.streamEnd.gogma - table.originGogma)
  for (const [counterId, end] of Object.entries(option.streamEnd.normal)) advance = Math.max(advance, end - table.originNormal[counterId]!)
  return advance
}

/**
 * The design 8.2 materialization order of a feasible coverage. Pure; it re-checks its own result and
 * fails closed (`coverage_invariant`) when the order is not a permutation of the Targets or a conversion
 * Target would precede a Target a Skill position below its conversion is attributed to.
 */
export function deriveMaterializationOrder(candidate: ResourceAssignmentCandidate, table: ReachTable, coverage: readonly StreamCoverage[]): MaterializationPlan {
  const skill = coverage.find(value => value.stream.kind === 'skill')
  if (!skill) invariant('The coverage holds no Skill stream.')
  const ids = table.targets.map(row => row.targetWeaponId)
  const optionOf = (id: TargetWeaponId) => {
    const option = candidate.chosen.get(id)
    if (!option) invariant(`Target ${id} has no option in the assignment.`)
    return option
  }
  const conversions = ids.flatMap(id => {
    const requirement = optionOf(id).skillRequired
    return requirement.kind === 'conversion' ? [{ id, c: requirement.conversionPosition }] : []
  }).sort((left, right) => left.c - right.c || compareIds(left.id, right.id))
  const order: TargetWeaponId[] = []
  const placed = new Set<TargetWeaponId>()
  const place = (id: TargetWeaponId) => {
    order.push(id)
    placed.add(id)
  }
  const dependencies: MaterializationDependency[] = []
  for (const { id, c } of conversions) {
    const prerequisites: TargetWeaponId[] = []
    for (const segment of skill.segments) {
      if (segment.to >= c) break
      const owner = segment.covererTargetWeaponId
      if (owner === id) invariant(`Target ${id}: a Skill position ${segment.from}..${segment.to} below its own conversion ${c} is attributed to itself.`)
      if (!prerequisites.includes(owner)) prerequisites.push(owner)
      if (placed.has(owner)) continue
      // Only an owned Gogma (no Skill dependency) may still be unplaced; a conversion holder converts below c and was placed first.
      if (optionOf(owner).skillRequired.kind === 'conversion') invariant(`Target ${owner} holds Skill ${segment.from}..${segment.to} below Target ${id}'s conversion ${c} but converts later.`)
      place(owner)
    }
    if (placed.has(id)) invariant(`Conversion Target ${id} was placed before its own dependencies.`)
    place(id)
    dependencies.push({ targetWeaponId: id, conversionPosition: c, prerequisiteTargetWeaponIds: prerequisites })
  }
  const remaining = ids.filter(id => !placed.has(id))
    .map(id => ({ id, advance: maxStreamAdvance(optionOf(id), table) }))
    .sort((left, right) => left.advance - right.advance || compareIds(left.id, right.id))
  for (const { id } of remaining) place(id)
  // Self-check: a permutation of the planning Targets, and every Skill position below a conversion held earlier.
  if (order.length !== ids.length || new Set(order).size !== ids.length || ids.some(id => !placed.has(id))) invariant('The materialization order is not a permutation of the planning Targets.')
  const index = new Map(order.map((id, position) => [id, position]))
  for (const dependency of dependencies) {
    for (const segment of skill.segments) {
      if (segment.to >= dependency.conversionPosition) break
      if (index.get(segment.covererTargetWeaponId)! >= index.get(dependency.targetWeaponId)!) {
        invariant(`Skill ${segment.from}..${segment.to} of Target ${segment.covererTargetWeaponId} is not materialized before conversion Target ${dependency.targetWeaponId}.`)
      }
    }
  }
  return { order, skillDependencies: dependencies }
}
