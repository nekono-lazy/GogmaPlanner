import type {
  BuildListEntry, BuildListEntryId, ExpectedResult,
  NormalArtianCounter, OwnedGogmaArtianWeapon, OwnedWeapon,
  OwnedWeaponId, PlanStepCheckpointMilestone, PlanStepDebugInfo,
  PlanStepOperationType, RestorationBonusSet,
  RngAdvance, RngState, RouteOperation, TargetWeapon, TargetWeaponId, BuildCandidateId,
} from '../models/publicTypes'
import {
  areRestorationBonusSlotsEqual,
  hashStableValue,
  isBlindCreateNormalArtianOperation,
  normalizeReferencedOwnedWeapon,
} from '../models/publicTypes'
import {
  checkpointConditionMatchFor,
  entryIntermediateSelection,
  hasIntermediateStateSelection,
  intermediatePinOperationIndex,
  isIntermediatePinHeldAtRouteStart,
} from './plannerCheckpoints'
import type {
  RngEngine,
  RngPredictionSupportInput,
  RngPredictionUnsupportedReason,
} from '../rng/rngEngine'
import { getPlannerPredictionSupport } from './plannerPredictionSupport'
import {
  advanceBlindNormalCreationCounters,
  createPlannerPhysicalActionIdentity,
} from './plannerRouteProgress'
import type { PlannerInput, PlannerSearchAction, PlannerSearchRngSnapshot, PlannerSearchRoutePosition, PlannerSearchState } from './plannerTypes'

/**
 * Non-persistent result of replaying one Search Action.
 *
 * It carries what the RNG Engine and the Search trace established - the
 * predicted result and the concrete RNG / Normal Counter state around the
 * action - but no expected state hash and no inventory change: those belong to
 * the ProductionPlan execution projection, which binds physical weapons to
 * OwnedWeapon IDs (`docs/PLANNER_SPEC.md` 16.3) and is built from these drafts.
 */
export interface PlannerPlanStepDraft {
  actionKind: PlannerSearchAction['kind']
  operationType: PlanStepOperationType
  routeOperation: RouteOperation | null
  primaryBuildListEntryId: BuildListEntryId | null
  progressedBuildListEntryIds: BuildListEntryId[]
  targetWeaponId: TargetWeaponId | null
  candidateId: BuildCandidateId | null
  /** The Search Action's own weapon reference: a Route source, or the reserved ID. */
  ownedWeaponId: OwnedWeaponId | null
  expectedResult: ExpectedResult | null
  rngStateBefore: RngState
  rngStateAfter: RngState
  normalCountersBefore: NormalArtianCounter[]
  normalCountersAfter: NormalArtianCounter[]
  rngAdvance: RngAdvance
  /**
   * The selected compromise checkpoints this physical Step reaches.
   *
   * One shared physical action can reach several Entries' milestones at once,
   * so this is a list rather than a single value (`docs/PLANNER_SPEC.md`
   * 7.5.4).
   */
  checkpointMilestones: PlanStepCheckpointMilestone[]
  debug: PlanStepDebugInfo | null
  /**
   * Whether this Step forges a Normal Artian whose restoration bonuses were
   * never predicted (`docs/SEARCH_SPEC.md` 6.1.1).
   *
   * Presentation only, and non-persistent like the rest of this draft: the
   * PlanStep it produces carries the difference in its own instruction text, so
   * no persisted PlanStep field is added.
   */
  isBlindNormalCreation: boolean
  /**
   * The primary Entry's Route unit position this physical action executed, or
   * `null` for a Planner-only action. Non-persistent like the rest of this
   * draft.
   *
   * A Normal creation's role is decided by it (Issue #129): a Counter-advance
   * forge another Entry's real forge passed never reaches the trace, so the
   * number of forges an Entry actually executed does not tell which one is its
   * production-target Normal - the Route position does.
   */
  routePosition: PlannerSearchRoutePosition | null
}

export type PlannerTraceReplayIssueCode =
  | 'rng_before_mismatch' | 'rng_after_mismatch' | 'counter_difference_unrepresentable'
  | 'invalid_physical_action_sharing'
  | 'missing_entry' | 'missing_target' | 'missing_rng_requirement' | 'engine_capability_missing'
  | 'missing_transient_output' | 'missing_source_weapon' | 'invalid_source_weapon'
  | 'inventory_transition_failed' | 'candidate_result_mismatch' | 'final_state_mismatch'
  /**
   * A replay step needed the current five restoration bonus slots, but the
   * weapon was forged by a blind Normal creation and no slots were ever
   * predicted for it (`docs/PLANNER_SPEC.md` 11.0). Only `reset_bonuses`, which
   * reads nothing it replaces, can turn that state into a known one.
   */
  | 'unknown_restoration_bonuses'
  /**
   * The compromise checkpoint an Entry's selected intermediate states pin was
   * reached, but the weapon state there is not the exact state those
   * selections record. A selection is a hard constraint, so this fails closed
   * rather than producing a Plan that quietly misses it
   * (`docs/PLANNER_SPEC.md` 7.5.3).
   */
  | 'checkpoint_state_mismatch'
export interface PlannerTraceReplayIssue { code: PlannerTraceReplayIssueCode; message: string; actionIndex: number | null }
export interface PlannerUnsupportedPredictionInput {
  buildListEntryId: BuildListEntryId
  operationType: RngPredictionSupportInput['type']
  reason: RngPredictionUnsupportedReason
  actionIndex: number
}
export interface PlannerTraceReplayResult {
  isValid: boolean
  drafts: PlannerPlanStepDraft[]
  issues: PlannerTraceReplayIssue[]
  unsupportedInput: PlannerUnsupportedPredictionInput | null
}

/**
 * The five restoration bonus slots one replay runtime weapon currently carries.
 *
 * `unknown` is the blind Normal creation of `docs/SEARCH_SPEC.md` 6.1.1: the
 * weapon physically exists, but no five slots were ever predicted for it. It is
 * deliberately its own runtime-only variant rather than a fabricated
 * `RestorationBonusSet`, so every step that would read the slots fails closed
 * instead of displaying invented values.
 */
type TransientBonuses =
  | {
      kind: 'known'
      restorationBonuses: RestorationBonusSet
      restorationBonusScope: 'normal_artian' | 'gogma_artian'
    }
  | { kind: 'unknown' }
interface TransientGogma { bonuses: TransientBonuses; seriesSkillId: string | null; groupSkillId: string | null }
interface Runtime {
  rngState: RngState; normalCounters: NormalArtianCounter[]; ownedWeapons: OwnedWeapon[]
  /** Per-Entry creation history; conversion consumes only the latest output. */
  normals: Map<BuildListEntryId, TransientBonuses[]>; gogmas: Map<BuildListEntryId, TransientGogma>
}
const knownBonuses = (
  restorationBonuses: RestorationBonusSet,
  restorationBonusScope: 'normal_artian' | 'gogma_artian',
): TransientBonuses => ({ kind: 'known', restorationBonuses: structuredClone(restorationBonuses), restorationBonusScope })
/**
 * The first two `result()` arguments for one runtime bonus state.
 *
 * `null` restoration bonuses mean "this Step predicts no restoration bonus
 * result", which `ExpectedResult` already allows; they never mean the weapon
 * has no bonuses.
 */
const expectedResultBonusArgs = (
  bonuses: TransientBonuses,
): [RestorationBonusSet | null, ExpectedResult['restorationBonusScope']] =>
  bonuses.kind === 'known'
    ? [structuredClone(bonuses.restorationBonuses), bonuses.restorationBonusScope]
    : [null, null]
const cloneBonuses = (value: RestorationBonusSet): RestorationBonusSet => structuredClone(value)
const result = (restorationBonuses: RestorationBonusSet | null, restorationBonusScope: ExpectedResult['restorationBonusScope'], seriesSkillId: string | null, groupSkillId: string | null, shouldSecure = false): ExpectedResult => ({ restorationBonuses, restorationBonusScope, seriesSkillId, groupSkillId, shouldSecure })

function sameSnapshot(runtime: Runtime, snapshot: PlannerSearchRngSnapshot) {
  if (runtime.rngState.gogmaCounter.value !== snapshot.gogmaCounter || runtime.rngState.skillCounter.value !== snapshot.skillCounter) return false
  const actual = runtime.normalCounters.map(({ id, counter }) => ({ id, counter })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return JSON.stringify(actual) === JSON.stringify(snapshot.normalCounters)
}
function applySnapshot(runtime: Runtime, snapshot: PlannerSearchRngSnapshot) {
  runtime.rngState.gogmaCounter.value = snapshot.gogmaCounter; runtime.rngState.skillCounter.value = snapshot.skillCounter
  const values = new Map(snapshot.normalCounters.map(({ id, counter }) => [id, counter]))
  runtime.normalCounters = runtime.normalCounters.map((counter) => values.has(counter.id) ? { ...counter, counter: values.get(counter.id) ?? null } : counter)
}
function valueDelta(before: number | null, after: number | null) { return before === null && after === null ? 0 : before === null || after === null ? null : after - before }
function rngAdvance(before: PlannerSearchRngSnapshot, after: PlannerSearchRngSnapshot): RngAdvance | null {
  const gogmaCounterDelta = valueDelta(before.gogmaCounter, after.gogmaCounter); const skillCounterDelta = valueDelta(before.skillCounter, after.skillCounter)
  if (gogmaCounterDelta === null || skillCounterDelta === null) return null
  const b = new Map(before.normalCounters.map(({ id, counter }) => [id, counter])); const a = new Map(after.normalCounters.map(({ id, counter }) => [id, counter]))
  if (a.size !== b.size || [...a.keys()].some((id) => !b.has(id))) return null
  const changed = [...b.keys()].filter((id) => b.get(id) !== a.get(id)); if (changed.length > 1) return null
  if (changed.length === 0) return { gogmaCounterDelta, skillCounterDelta, normalCounterDelta: null, affectedNormalCounterId: null }
  const id = changed[0]; const normalCounterDelta = valueDelta(b.get(id) ?? null, a.get(id) ?? null)
  return normalCounterDelta === null ? null : { gogmaCounterDelta, skillCounterDelta, normalCounterDelta, affectedNormalCounterId: id }
}
function predictionIssue(runtime: Runtime, index: number): PlannerTraceReplayIssue | null {
  if (runtime.rngState.baseSeed.value === null || !runtime.rngState.baseSeed.isConfirmed) return { code: 'missing_rng_requirement', message: 'A confirmed Base Seed is required for prediction.', actionIndex: index }
  return null
}
function entryFor(input: PlannerInput, id: BuildListEntryId) { return input.buildListEntries.find((entry) => entry.id === id) ?? null }
function targetFor(input: PlannerInput, entry: BuildListEntry): TargetWeapon | null { return input.targetWeapons.find(({ id }) => id === entry.targetWeaponId) ?? null }
function sharedPhysicalActionIssue(
  input: PlannerInput,
  action: PlannerSearchAction,
): string | null {
  if (
    action.kind !== 'route_operation' ||
    action.progressedBuildListEntryIds.length <= 1
  ) {
    return null
  }
  const progressedEntryIds = new Set(action.progressedBuildListEntryIds)
  if (
    progressedEntryIds.size !== action.progressedBuildListEntryIds.length ||
    !progressedEntryIds.has(action.primaryBuildListEntryId)
  ) {
    return 'A shared Search Action must contain its primary Entry exactly once.'
  }
  const identities = action.progressedBuildListEntryIds.flatMap((entryId) => {
    const entry = entryFor(input, entryId)
    const position = action.progressedRoutePositions[entryId]
    const operation = position === undefined
      ? undefined
      : entry?.candidateSnapshot.route.operations[position.operationIndex]
    return entry && position && operation
      ? [createPlannerPhysicalActionIdentity(
          entry,
          operation,
          position.operationIndex,
          position.unitIndex,
        )]
      : []
  })
  if (identities.length !== action.progressedBuildListEntryIds.length) {
    return 'A shared Search Action must identify every progressed Route position.'
  }
  const primaryIdentity = identities[
    action.progressedBuildListEntryIds.indexOf(action.primaryBuildListEntryId)
  ]
  return primaryIdentity.shareable &&
    identities.every(
      ({ key, shareable }) =>
        shareable && key === primaryIdentity.key,
    )
    ? null
    : 'A Search Action cannot progress different physical weapon subjects.'
}
function currentGogma(runtime: Runtime, entryId: BuildListEntryId, sourceId: OwnedWeaponId): TransientGogma | null {
  const output = runtime.gogmas.get(entryId); if (output) return structuredClone(output)
  const source = runtime.ownedWeapons.find(({ id }) => id === sourceId)
  return source?.kind === 'gogma' ? { bonuses: knownBonuses(source.restorationBonuses, source.restorationBonusScope), seriesSkillId: source.seriesSkillId, groupSkillId: source.groupSkillId } : null
}
function assignGogma(runtime: Runtime, action: PlannerSearchAction, output: TransientGogma) { action.progressedBuildListEntryIds.forEach((id) => runtime.gogmas.set(id, structuredClone(output))) }
function reservedWeapon(entry: BuildListEntry, target: TargetWeapon, id: OwnedWeaponId): OwnedGogmaArtianWeapon {
  const candidate = entry.candidateSnapshot
  // Every Candidate is a canonical Ideal Candidate, so a newly generated weapon
  // is labelled Ideal and protected by default (`docs/DATA_MODEL.md` 3.2).
  return { id, kind: 'gogma', name: '', weaponTypeId: target.weaponTypeId, elementId: target.elementId, restorationBonuses: cloneBonuses(candidate.finalBonuses), restorationBonusScope: candidate.restorationBonusScope, seriesSkillId: candidate.seriesSkillId, groupSkillId: candidate.groupSkillId, status: 'ideal', isProtected: true, executionInProgress: null, memo: null, createdAt: candidate.createdAt, updatedAt: candidate.createdAt }
}
/** Semantic inventory comparison of the replay runtime and the settled Search state. */
function semanticInventoryHash(weapons: readonly OwnedWeapon[]): string {
  return hashStableValue(
    [...weapons]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((weapon) => weapon.kind === 'normal'
        ? { ...normalizeReferencedOwnedWeapon(weapon), rarity: weapon.rarity }
        : normalizeReferencedOwnedWeapon(weapon)),
  )
}
const semanticRngHash = (rngState: RngState, normalCounters: readonly NormalArtianCounter[]) => hashStableValue({
  gogmaCounter: { value: rngState.gogmaCounter.value, isConfirmed: rngState.gogmaCounter.isConfirmed },
  skillCounter: { value: rngState.skillCounter.value, isConfirmed: rngState.skillCounter.isConfirmed },
  baseSeed: { value: rngState.baseSeed.value, isConfirmed: rngState.baseSeed.isConfirmed },
  normalCounters: [...normalCounters].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(({ id, counter, isConfirmed }) => ({ id, counter, isConfirmed })),
})

/** Pure, deterministic replay. It generates neither PlanStep IDs nor clocks. */
export function replayPlannerSearchTrace(input: PlannerInput, bestState: PlannerSearchState, engine: RngEngine): PlannerTraceReplayResult {
  const runtime: Runtime = { rngState: structuredClone(input.rngState), normalCounters: structuredClone(input.normalCounters), ownedWeapons: structuredClone(input.ownedWeapons), normals: new Map(), gogmas: new Map() }
  const drafts: PlannerPlanStepDraft[] = []
  const supportCache = new Map()
  // Checkpoint bookkeeping per Entry: which Route operations really ran, how
  // many operation units ran, and whether the pinned lane pair was already
  // held. Silently fast-forwarded units never appear in the trace, so the
  // arrival is judged by the pinned endpoint operations themselves - which are
  // never skippable - rather than by a count (`docs/PLANNER_SPEC.md` 7.5.3).
  const executedOperationIndexes = new Map<BuildListEntryId, Set<number>>()
  const executedUnitCounts = new Map<BuildListEntryId, number>()
  // `remainingOperationCount` of a milestone is the number of later physical
  // Steps that still progress the Entry (`docs/PLANNER_SPEC.md` 7.5.4). The
  // settled trace is its only authority: a unit another Entry's action
  // silently fast-forwarded never appears there, a shared physical action
  // that progresses several Entries is one Step for each of them, and a
  // `reserve_weapon` is not a Route operation. The Candidate's
  // `estimatedOperationCount` counts fast-forwarded units too, so it must not
  // be used here.
  const traceRouteOperationCounts = new Map<BuildListEntryId, number>()
  bestState.trace.forEach((action) => {
    if (action.kind !== 'route_operation') return
    action.progressedBuildListEntryIds.forEach((entryId) => {
      traceRouteOperationCounts.set(entryId, (traceRouteOperationCounts.get(entryId) ?? 0) + 1)
    })
  })
  const reachedCheckpointEntryIds = new Set<BuildListEntryId>()
  const pinHeld = (entryId: BuildListEntryId, pinOperationIndex: number | null): boolean =>
    pinOperationIndex === null || (executedOperationIndexes.get(entryId)?.has(pinOperationIndex) ?? false)
  const fail = (code: PlannerTraceReplayIssueCode, message: string, actionIndex: number | null): PlannerTraceReplayResult => ({ isValid: false, drafts: [], issues: [{ code, message, actionIndex }], unsupportedInput: null })
  // The exact state the user selected on each lane (`docs/PLANNER_SPEC.md` 7.5.4):
  // a selected opportunity's own Skills / ordered slots, the Candidate's final
  // result for an unselected lane. A selected Skill state may legitimately
  // carry a `null` Series or Group id, so the selected group decides
  // explicitly rather than through a null-coalescing fallback.
  const selectedCheckpointState = (entry: BuildListEntry) => {
    const selection = entryIntermediateSelection(entry)
    const candidate = entry.candidateSnapshot
    return {
      bonuses: selection.bonus === null ? candidate.finalBonuses : selection.bonus.opportunity.restorationBonuses,
      scope: selection.bonus === null ? candidate.restorationBonusScope : selection.bonus.opportunity.restorationBonusScope,
      seriesSkillId: selection.skill === null ? candidate.seriesSkillId : selection.skill.group.seriesSkillId,
      groupSkillId: selection.skill === null ? candidate.groupSkillId : selection.skill.group.groupSkillId,
    }
  }
  const holdsSelectedCheckpointState = (weapon: TransientGogma | null, entry: BuildListEntry): boolean => {
    const expected = selectedCheckpointState(entry)
    return (
      weapon !== null &&
      weapon.bonuses.kind === 'known' &&
      weapon.bonuses.restorationBonusScope === expected.scope &&
      areRestorationBonusSlotsEqual(weapon.bonuses.restorationBonuses, expected.bonuses) &&
      weapon.seriesSkillId === expected.seriesSkillId &&
      weapon.groupSkillId === expected.groupSkillId
    )
  }
  // An existing Gogma whose selected lane states are its own lane starts holds
  // its compromise checkpoint before the first action. The selected state is
  // still a hard constraint, so the source weapon the Plan starts from must
  // hold it exactly; nothing is reserved, changed, or marked as a milestone
  // (`docs/PLANNER_SPEC.md` 7.5.2 / 7.5.4).
  const traceEntryIds = new Set(bestState.trace.flatMap((action) => [action.primaryBuildListEntryId, ...action.progressedBuildListEntryIds]))
  for (const entryId of traceEntryIds) {
    const entry = entryFor(input, entryId)
    if (!entry || !isIntermediatePinHeldAtRouteStart(entry)) continue
    const sourceId = entry.candidateSnapshot.route.sourceOwnedWeaponId
    if (sourceId === null || !holdsSelectedCheckpointState(currentGogma(runtime, entryId, sourceId), entry)) {
      return fail(
        'checkpoint_state_mismatch',
        'The source weapon at Plan start does not hold the intermediate states the user selected as its lane starts.',
        null,
      )
    }
    reachedCheckpointEntryIds.add(entryId)
  }
  const requireSupport = (
    supportInput: RngPredictionSupportInput,
    entryId: BuildListEntryId,
    actionIndex: number,
  ): PlannerTraceReplayResult | null => {
    const support = getPlannerPredictionSupport(engine, supportInput, supportCache)
    return support.supported
      ? null
      : {
          isValid: false,
          drafts: [],
          issues: [],
          unsupportedInput: {
            buildListEntryId: entryId,
            operationType: supportInput.type,
            reason: support.reason,
            actionIndex,
          },
        }
  }
  for (let index = 0; index < bestState.trace.length; index += 1) {
    const action = bestState.trace[index]; if (!sameSnapshot(runtime, action.rngBefore)) return fail('rng_before_mismatch', 'Replay runtime does not match Search Action rngBefore.', index)
    const physicalActionIssue = sharedPhysicalActionIssue(input, action)
    if (physicalActionIssue) return fail('invalid_physical_action_sharing', physicalActionIssue, index)
    const advance = rngAdvance(action.rngBefore, action.rngAfter); if (!advance) return fail('counter_difference_unrepresentable', 'Search Action changes multiple or unknown Normal counters.', index)
    const entry = entryFor(input, action.primaryBuildListEntryId); if (!entry) return fail('missing_entry', 'Search Action references a missing BuildListEntry.', index)
    const target = targetFor(input, entry); if (!target) return fail('missing_target', 'BuildListEntry references a missing TargetWeapon.', index)
    const rngStateBefore = structuredClone(runtime.rngState)
    const normalCountersBefore = structuredClone(runtime.normalCounters)
    let expectedResult: ExpectedResult | null = null
    if (action.kind === 'reserve_candidate') {
        // A zero-operation Candidate ran no Route unit, so the owned Gogma it
        // confirms is itself the result (`docs/PLANNER_SPEC.md` 16.3).
        const routeSourceId = entry.candidateSnapshot.route.sourceOwnedWeaponId
        const transient = runtime.gogmas.get(entry.id) ?? (
          entry.candidateSnapshot.route.operations.length === 0 && routeSourceId !== null
            ? currentGogma(runtime, entry.id, routeSourceId) ?? undefined
            : undefined
        )
        if (!transient) return fail('missing_transient_output', 'Reserve requires the Entry transient Gogma output.', index)
        const candidate = entry.candidateSnapshot
        if (transient.bonuses.kind !== 'known') {
          return fail('unknown_restoration_bonuses', 'A route output whose restoration bonuses were never predicted cannot secure a Candidate.', index)
        }
        if (JSON.stringify(transient.bonuses.restorationBonuses) !== JSON.stringify(candidate.finalBonuses) || transient.seriesSkillId !== candidate.seriesSkillId || transient.groupSkillId !== candidate.groupSkillId) {
          return fail('candidate_result_mismatch', 'Transient Gogma result does not match the Candidate Snapshot.', index)
        }
        if (entry.candidateSnapshot.route.kind === 'normal_artian_to_gogma' || entry.candidateSnapshot.route.kind === 'owned_normal_artian_to_gogma') {
          if (runtime.ownedWeapons.some(({ id }) => id === action.ownedWeaponId)) return fail('inventory_transition_failed', 'Reserved OwnedWeapon ID already exists.', index)
          runtime.ownedWeapons.push(reservedWeapon(entry, target, action.ownedWeaponId))
        } else {
          const position = runtime.ownedWeapons.findIndex(({ id }) => id === action.ownedWeaponId); const source = runtime.ownedWeapons[position]
          if (!source || source.kind !== 'gogma') return fail('missing_source_weapon', 'Existing Gogma reserve source is unavailable.', index)
          // Ideal completion protects an existing weapon too (`docs/PLANNER_SPEC.md` 16.13).
          runtime.ownedWeapons[position] = { ...source, restorationBonuses: cloneBonuses(entry.candidateSnapshot.finalBonuses), restorationBonusScope: entry.candidateSnapshot.restorationBonusScope, seriesSkillId: entry.candidateSnapshot.seriesSkillId, groupSkillId: entry.candidateSnapshot.groupSkillId, status: 'ideal', isProtected: true } satisfies OwnedGogmaArtianWeapon
        }
        runtime.gogmas.delete(entry.id)
        expectedResult = result(cloneBonuses(entry.candidateSnapshot.finalBonuses), entry.candidateSnapshot.restorationBonusScope, entry.candidateSnapshot.seriesSkillId, entry.candidateSnapshot.groupSkillId, true)
    } else {
        const operation = action.routeOperation
        if (operation.type === 'create_normal_artian') {
          if (isBlindCreateNormalArtianOperation(operation)) {
            // Blind creation calls no Normal prediction and reads no Normal
            // Artian Counter as a precondition. The forged weapon is real, so
            // it is recorded as an output whose five slots are simply unknown,
            // and a confirmed Normal Counter still advances through the same
            // authority the Beam Search used (`docs/PLANNER_SPEC.md` 11.0).
            // `applySnapshot()` below reconciles the runtime to the Search
            // Action either way, so this keeps the Replay independently correct
            // rather than dependent on that reconciliation.
            const created: TransientBonuses = { kind: 'unknown' }
            action.progressedBuildListEntryIds.forEach((id) => runtime.normals.set(id, [...(runtime.normals.get(id) ?? []), created]))
            const advancedCounters = advanceBlindNormalCreationCounters(runtime.normalCounters, operation, engine)
            if (advancedCounters !== null) runtime.normalCounters = advancedCounters
            expectedResult = result(null, null, null, null)
          } else {
            if (!engine.capabilities.supportsNormalArtianPrediction) return fail('engine_capability_missing', 'Normal prediction capability is unavailable.', index)
            const missing = predictionIssue(runtime, index); if (missing) return { isValid: false, drafts: [], issues: [missing], unsupportedInput: null }
            const normalCounter = runtime.normalCounters.find(({ id }) => id === operation.weaponTypeId + ':' + operation.rarity)
            const counter = normalCounter?.counter
            if (!normalCounter || counter === null || counter === undefined || !normalCounter.isConfirmed) return fail('missing_rng_requirement', 'A confirmed Normal Artian Counter is required.', index)
            const unsupported = requireSupport({
              type: 'normal_artian',
              weaponTypeId: operation.weaponTypeId,
              elementId: target.elementId,
              rarity: operation.rarity,
            }, entry.id, index)
            if (unsupported) return unsupported
            const bonuses = engine.predictNormalArtian({ baseSeed: runtime.rngState.baseSeed.value!, weaponTypeId: operation.weaponTypeId, elementId: target.elementId, rarity: operation.rarity, normalCounter: counter, master: input.master })
            action.progressedBuildListEntryIds.forEach((id) => runtime.normals.set(id, [...(runtime.normals.get(id) ?? []), knownBonuses(bonuses, 'normal_artian')])); expectedResult = result(cloneBonuses(bonuses), 'normal_artian', null, null)
          }
        } else if (operation.type === 'convert_normal_to_gogma') {
          if (!engine.capabilities.supportsSkillPrediction) return fail('engine_capability_missing', 'Skill prediction capability is unavailable.', index)
          const missing = predictionIssue(runtime, index); if (missing) return { isValid: false, drafts: [], issues: [missing], unsupportedInput: null }
          if (runtime.rngState.skillCounter.value === null || !runtime.rngState.skillCounter.isConfirmed) return fail('missing_rng_requirement', 'A confirmed Skill Counter is required.', index)
          let inheritedNormalBonuses: TransientBonuses | undefined
          if (entry.candidateSnapshot.route.kind === 'owned_normal_artian_to_gogma') {
            const source = entry.candidateSnapshot.route.sourceOwnedWeaponId === null ? null : runtime.ownedWeapons.find(({ id }) => id === entry.candidateSnapshot.route.sourceOwnedWeaponId)
            if (!source) return fail('missing_source_weapon', 'Owned Normal conversion source is unavailable.', index); if (source.kind !== 'normal') return fail('invalid_source_weapon', 'Owned Normal conversion source is not Normal Artian.', index)
            inheritedNormalBonuses = knownBonuses(source.restorationBonuses, 'normal_artian'); runtime.ownedWeapons = runtime.ownedWeapons.filter(({ id }) => id !== source.id)
          } else { const normals = runtime.normals.get(entry.id) ?? []; inheritedNormalBonuses = normals.at(-1); if (!inheritedNormalBonuses) return fail('missing_transient_output', 'New Normal conversion requires a transient Normal result.', index); runtime.normals.delete(entry.id) }
          const unsupported = requireSupport({
            type: 'skill',
            weaponTypeId: operation.weaponTypeId,
            elementId: target.elementId,
          }, entry.id, index)
          if (unsupported) return unsupported
          const skills = engine.predictSkills({ baseSeed: runtime.rngState.baseSeed.value!, skillCounter: runtime.rngState.skillCounter.value!, weaponTypeId: operation.weaponTypeId, elementId: target.elementId, master: input.master })
          // Conversion preserves the five inherited slots exactly, including the
          // case where they were never predicted at all.
          assignGogma(runtime, action, { bonuses: inheritedNormalBonuses, seriesSkillId: skills.seriesSkillId, groupSkillId: skills.groupSkillId }); expectedResult = result(...expectedResultBonusArgs(inheritedNormalBonuses), skills.seriesSkillId, skills.groupSkillId)
        } else if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
          if (!engine.capabilities.supportsGogmaPrediction || operation.type === 'keep_bonuses' && !engine.capabilities.supportsKeepBonusesPrediction) return fail('engine_capability_missing', 'Gogma prediction capability is unavailable.', index)
          const missing = predictionIssue(runtime, index); if (missing) return { isValid: false, drafts: [], issues: [missing], unsupportedInput: null }; if (runtime.rngState.gogmaCounter.value === null || !runtime.rngState.gogmaCounter.isConfirmed) return fail('missing_rng_requirement', 'A confirmed Gogma Counter is required.', index)
          const current = operation.sourceOwnedWeaponId === null ? runtime.gogmas.get(entry.id) ?? null : currentGogma(runtime, entry.id, operation.sourceOwnedWeaponId); if (!current) return fail('missing_source_weapon', 'Gogma source is unavailable.', index)
          // Keep reads the current five slots, so it fails closed on an
          // unknown state; Reset reads nothing it replaces and is exactly the
          // operation that turns unknown into known. Known slots of either
          // scope are a valid Keep input: the Engine resolves each slot's
          // family from its bonus type alone (`docs/SEARCH_SPEC.md` 5.9).
          if (operation.type === 'keep_bonuses' && current.bonuses.kind !== 'known') return fail('unknown_restoration_bonuses', 'Keep Bonuses cannot read restoration bonuses that were never predicted.', index)
          // Keep with unknown slots already failed closed above, so a null
          // `keepInput` here always means this operation is a Reset.
          const keepInput = operation.type === 'keep_bonuses' && current.bonuses.kind === 'known'
            ? current.bonuses.restorationBonuses
            : null
          const unsupported = requireSupport(
            keepInput === null
              ? {
                  type: 'gogma_reset',
                  weaponTypeId: target.weaponTypeId,
                  elementId: target.elementId,
                  master: input.master,
                }
              : {
                  type: 'gogma_keep',
                  weaponTypeId: target.weaponTypeId,
                  elementId: target.elementId,
                  currentBonuses: keepInput,
                  master: input.master,
                },
            entry.id,
            index,
          )
          if (unsupported) return unsupported
          const bonuses = engine.predictGogmaBonus({ baseSeed: runtime.rngState.baseSeed.value!, gogmaCounter: runtime.rngState.gogmaCounter.value, weaponTypeId: target.weaponTypeId, elementId: target.elementId, operation: keepInput === null ? { type: 'reset_bonuses' } : { type: 'keep_bonuses', currentBonuses: keepInput }, master: input.master })
          assignGogma(runtime, action, { ...current, bonuses: knownBonuses(bonuses, 'gogma_artian') }); expectedResult = result(cloneBonuses(bonuses), 'gogma_artian', current.seriesSkillId, current.groupSkillId)
        } else if (operation.type === 'reset_skills') {
          if (!engine.capabilities.supportsSkillPrediction) return fail('engine_capability_missing', 'Skill prediction capability is unavailable.', index)
          const missing = predictionIssue(runtime, index); if (missing) return { isValid: false, drafts: [], issues: [missing], unsupportedInput: null }; if (runtime.rngState.skillCounter.value === null || !runtime.rngState.skillCounter.isConfirmed) return fail('missing_rng_requirement', 'A confirmed Skill Counter is required.', index)
          const current = operation.sourceOwnedWeaponId === null ? runtime.gogmas.get(entry.id) : currentGogma(runtime, entry.id, operation.sourceOwnedWeaponId); if (!current) return fail('missing_transient_output', 'Reset Skills requires a current Gogma result.', index)
          const unsupported = requireSupport({
            type: 'skill',
            weaponTypeId: target.weaponTypeId,
            elementId: target.elementId,
          }, entry.id, index)
          if (unsupported) return unsupported
          const skills = engine.predictSkills({ baseSeed: runtime.rngState.baseSeed.value!, skillCounter: runtime.rngState.skillCounter.value, weaponTypeId: target.weaponTypeId, elementId: target.elementId, master: input.master })
          // Reset Skills writes only the Series / Group Skill pair, so it never
          // reads the five slots and carries an unknown state through unchanged.
          assignGogma(runtime, action, { bonuses: current.bonuses, seriesSkillId: skills.seriesSkillId, groupSkillId: skills.groupSkillId }); expectedResult = result(...expectedResultBonusArgs(current.bonuses), skills.seriesSkillId, skills.groupSkillId)
        }
    }
    // A selected intermediate state is a hard constraint, so the moment both
    // pinned lane states are held is verified against the replayed weapon -
    // exact ordered slots, scope, and Skills - and the Step that completed the
    // pair carries the milestone (`docs/PLANNER_SPEC.md` 7.5.3 / 7.5.4).
    const checkpointMilestones: PlanStepCheckpointMilestone[] = []
    if (action.kind === 'route_operation') {
      for (const progressedId of action.progressedBuildListEntryIds) {
        const progressedEntry = entryFor(input, progressedId)
        const position = action.progressedRoutePositions[progressedId]
        if (!progressedEntry || !position) continue
        executedUnitCounts.set(progressedId, (executedUnitCounts.get(progressedId) ?? 0) + 1)
        if (position.unitIndex !== position.unitCount - 1) continue
        const executed = executedOperationIndexes.get(progressedId) ?? new Set<number>()
        executed.add(position.operationIndex)
        executedOperationIndexes.set(progressedId, executed)
        if (!hasIntermediateStateSelection(progressedEntry)) continue
        if (reachedCheckpointEntryIds.has(progressedId)) continue
        if (
          !pinHeld(progressedId, intermediatePinOperationIndex(progressedEntry, 'skill')) ||
          !pinHeld(progressedId, intermediatePinOperationIndex(progressedEntry, 'bonus'))
        ) {
          continue
        }
        const selection = entryIntermediateSelection(progressedEntry)
        if (!holdsSelectedCheckpointState(runtime.gogmas.get(progressedId) ?? null, progressedEntry)) {
          return fail(
            'checkpoint_state_mismatch',
            'The replayed state at the selected compromise checkpoint differs from the intermediate states the user selected.',
            index,
          )
        }
        reachedCheckpointEntryIds.add(progressedId)
        checkpointMilestones.push({
          buildListEntryId: progressedId,
          targetWeaponId: progressedEntry.targetWeaponId,
          skillOpportunityId: selection.skill?.opportunity.id ?? null,
          bonusOpportunityId: selection.bonus?.opportunity.id ?? null,
          conditionMatch: checkpointConditionMatchFor(progressedEntry),
          remainingOperationCount:
            (traceRouteOperationCounts.get(progressedId) ?? 0) - (executedUnitCounts.get(progressedId) ?? 0),
        })
      }
    }
    applySnapshot(runtime, action.rngAfter); if (!sameSnapshot(runtime, action.rngAfter)) return fail('rng_after_mismatch', 'Replay runtime does not match Search Action rngAfter.', index)
    const normalBefore = advance.affectedNormalCounterId === null ? null : action.rngBefore.normalCounters.find(({ id }) => id === advance.affectedNormalCounterId)?.counter ?? null
    const normalAfter = advance.affectedNormalCounterId === null ? null : action.rngAfter.normalCounters.find(({ id }) => id === advance.affectedNormalCounterId)?.counter ?? null
    const routePosition = action.kind === 'route_operation' ? action.progressedRoutePositions[action.primaryBuildListEntryId] ?? null : null
    drafts.push({ isBlindNormalCreation: action.kind === 'route_operation' && action.routeOperation.type === 'create_normal_artian' && isBlindCreateNormalArtianOperation(action.routeOperation), routePosition: routePosition === null ? null : { ...routePosition }, actionKind: action.kind, operationType: action.actionType, routeOperation: action.routeOperation === null ? null : structuredClone(action.routeOperation), primaryBuildListEntryId: action.primaryBuildListEntryId, progressedBuildListEntryIds: [...action.progressedBuildListEntryIds], targetWeaponId: entry.targetWeaponId, candidateId: entry.candidateSnapshot.id, ownedWeaponId: action.ownedWeaponId, expectedResult, checkpointMilestones, rngStateBefore, rngStateAfter: structuredClone(runtime.rngState), normalCountersBefore, normalCountersAfter: structuredClone(runtime.normalCounters), rngAdvance: advance, debug: { startBaseSeed: runtime.rngState.baseSeed.value, startGogmaCounter: action.rngBefore.gogmaCounter, endGogmaCounter: action.rngAfter.gogmaCounter, startSkillCounter: action.rngBefore.skillCounter, endSkillCounter: action.rngAfter.skillCounter, startNormalCounter: normalBefore, endNormalCounter: normalAfter, plannerReason: action.actionType } })
  }
  const matches =
    semanticRngHash(bestState.currentRngState, bestState.currentNormalCounters) === semanticRngHash(runtime.rngState, runtime.normalCounters) &&
    semanticInventoryHash(bestState.simulatedInventory.ownedWeapons) === semanticInventoryHash(runtime.ownedWeapons)
  return matches
    ? { isValid: true, drafts, issues: [], unsupportedInput: null }
    : fail('final_state_mismatch', 'Replay final state differs from best PlannerSearchState.', null)
}
