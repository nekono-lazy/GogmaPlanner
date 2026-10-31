import type {
  BuildListEntry,
  BuildListEntryId,
  NormalArtianCounter,
  OwnedGogmaArtianWeapon,
  OwnedWeaponId,
  PlanConflict,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import type { RngEngine } from '../rng/rngEngine'
import {
  addRegisteredWeapon,
  canUseAsDestructiveGogmaSource,
  canUseAsResetSkillsSource,
  consumeOwnedNormalForConversion,
  findOwnedWeapon,
  reserveWeaponId,
  updateOwnedWeapon,
} from './simulatedInventory'
import { isUnitBlockedByConflictResolution } from './plannerConflictDetection'
import {
  advanceBlindNormalCreationCounters,
  advancePlannerWeaponSwitchMetric,
  arePlannerRouteUnitsShareable,
  currentPlannerCounterValue,
  fastForwardPlannerRouteProgress,
  plannerWeaponOperationSubjectKey,
  routeUnitOwnedWeaponId,
  type PlannerRouteUnit,
} from './plannerRouteProgress'
import { entryIsRelevantForState, isPlannerTargetComplete } from './plannerEntryRelevance'
import {
  advancePlannerLaneProgress,
  initialPlannerLaneProgress,
  isPlannerLaneRouteComplete,
  nextPlannerLaneUnits,
  type PlannerEntryLanes,
} from './plannerRouteLanes'
import { advancePlannerPreferredSourceMetric } from './plannerPreferredSource'
import { isCompletionAssignedElsewhere, satisfiesCompletionTarget } from '../target'
import type {
  PlannerDependencies,
  PlannerInput,
  PlannerSearchAction,
  PlannerSearchInventoryEffect,
  PlannerSearchRejection,
  PlannerSearchRngSnapshot,
  PlannerSearchState,
  SimulatedInventory,
} from './plannerTypes'

/**
 * The Planner action application authority: the preconditions of a route
 * unit, the required / skippable execution eligibility, physical action
 * sharing, and applying one route action or one internal reserve to one
 * `PlannerSearchState` (Issue #103 Phase A0,
 * `docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 17).
 *
 * It decides no search strategy: which actions are tried, in what order, and
 * which resulting states survive belong to the caller. The Beam Search applies
 * every action to a clone of its source state; a caller that keeps one state
 * may apply it in place. The caller always names the mode explicitly.
 */

/**
 * How an action application treats its source state.
 *
 * - `clone`: the source state is never written; the result is a new state.
 * - `in_place`: the result is the source state itself, updated. A rejected
 *   action still leaves it exactly as it was.
 */
export type PlannerStateMutationMode = 'clone' | 'in_place'

export type PlannerAppliedActionResult =
  | { state: PlannerSearchState; rejection: null }
  | { state: null; rejection: PlannerSearchRejection }

/** Everything a route action reads besides the state it is applied to. */
export interface PlannerRouteActionContext {
  readonly entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>
  readonly lanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>
  /** The conflicts detected for the source state. */
  readonly conflictsById: ReadonlyMap<string, PlanConflict>
  readonly conflictIdsByUnitKey: ReadonlyMap<string, readonly string[]>
  readonly selectedPhysicalActionKeysByConflictId: ReadonlyMap<string, readonly string[]>
  readonly engine: RngEngine
  readonly preferredSourceEntryIds: ReadonlySet<BuildListEntryId>
  /**
   * Which other Entries a shareable physical action may progress besides its
   * primary unit. Omitted, every relevant Entry may share it, which is the
   * Beam Search contract. The deterministic scheduler limits sharing to its
   * committed Entries (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 7.5).
   */
  readonly canShareWithEntry?: (entryId: BuildListEntryId) => boolean
}

/**
 * Everything an internal reserve reads besides the state it is applied to.
 *
 * `master` judges a zero-operation confirmation's own weapon against its
 * Target's completion condition; `completionAssignments` (the input Targets'
 * `collectCompletionAssignedOwnedWeaponIds()`, Issue #334, 21.4) refuses a
 * reserve of a weapon another Target was completed with. A route action reads
 * neither: since Issue #334 PR-3 no action derives Target satisfaction from the
 * inventory (`docs/PLANNER_SPEC.md` 21.5).
 */
export interface PlannerReserveActionContext {
  readonly dependencies: PlannerDependencies
  readonly master: PlannerInput['master']
  readonly completionAssignments: ReadonlyMap<OwnedWeaponId, TargetWeaponId>
  readonly preferredSourceEntryIds: ReadonlySet<BuildListEntryId>
}

export interface PlannerRouteActionOptions {
  readonly mode: PlannerStateMutationMode
}

export interface PlannerReserveActionOptions {
  readonly mode: PlannerStateMutationMode
  /**
   * A zero-operation Candidate confirming a weapon that already satisfies its
   * Target (`docs/PLANNER_SPEC.md` 16.3).
   */
  readonly zeroOperationConfirm?: boolean
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The one state copy the Beam Search takes per successor. */
export function clonePlannerSearchState(state: PlannerSearchState): PlannerSearchState {
  return structuredClone(state)
}

function writableState(
  sourceState: PlannerSearchState,
  mode: PlannerStateMutationMode,
): PlannerSearchState {
  switch (mode) {
    case 'clone':
      return clonePlannerSearchState(sourceState)
    case 'in_place':
      return sourceState
  }
}

export function createPlannerSearchRejection(
  entryId: BuildListEntryId,
  actionType: PlannerSearchRejection['actionType'],
  reason: PlannerSearchRejection['reason'],
  detail: string,
): PlannerSearchRejection {
  return { buildListEntryId: entryId, actionType, reason, detail }
}

const rejection = createPlannerSearchRejection

function rejected(value: PlannerSearchRejection): PlannerAppliedActionResult {
  return { state: null, rejection: value }
}

function emptyInventoryEffect(): PlannerSearchInventoryEffect {
  return {
    addedOwnedWeaponIds: [],
    removedOwnedWeaponIds: [],
    updatedOwnedWeaponIds: [],
    reservedOwnedWeaponIds: [],
    routeOutputChangedForEntryIds: [],
  }
}

function rngSnapshot(state: PlannerSearchState): PlannerSearchRngSnapshot {
  return {
    gogmaCounter: state.currentRngState.gogmaCounter.value,
    skillCounter: state.currentRngState.skillCounter.value,
    normalCounters: state.currentNormalCounters
      .map(({ id, counter }) => ({ id, counter }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
  }
}

function isExistingGogmaRoute(entry: BuildListEntry): boolean {
  return entry.candidateSnapshot.route.kind.startsWith('existing_gogma')
}

function existingRouteSourceId(entry: BuildListEntry): OwnedWeaponId | null {
  return isExistingGogmaRoute(entry)
    ? entry.candidateSnapshot.route.sourceOwnedWeaponId
    : null
}

function entryUsesCurrentSourceVersion(
  state: PlannerSearchState,
  entry: BuildListEntry,
): boolean {
  const sourceId = existingRouteSourceId(entry)
  if (sourceId === null) return true
  return (
    (state.routeSourceVersionByEntryId[entry.id] ?? 0) ===
    (state.sourceMutationVersionByOwnedWeaponId[sourceId] ?? 0)
  )
}

function sourceVersionRejection(
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): PlannerSearchRejection {
  return rejection(
    entry.id,
    unit.operation.type,
    'inventory_precondition_failed',
    'The existing Gogma Route was superseded by a later source mutation.',
  )
}

function sourceMutatedByOperation(
  operation: PlannerRouteUnit['operation'],
): OwnedWeaponId | null {
  if (
    operation.type === 'reset_bonuses' ||
    operation.type === 'keep_bonuses'
  ) return operation.sourceOwnedWeaponId
  if (
    operation.type === 'reset_skills' &&
    operation.sourceOwnedWeaponId !== null
  ) return operation.sourceOwnedWeaponId
  return null
}

/**
 * Records that `targetWeaponId` was completed in this run by its own Entry's
 * reserve (Issue #334 PR-3, `docs/PLANNER_SPEC.md` 21.5). It is the one
 * transition of `targetSatisfaction`: no route action and no other Entry's
 * reserve moves it, because nothing derives Target satisfaction from what the
 * inventory performs any more.
 */
function completeTargetInRun(
  state: PlannerSearchState,
  targetWeaponId: TargetWeaponId,
): PlannerSearchAction['satisfactionChanges'] {
  const before = state.targetSatisfaction[targetWeaponId] ?? { completedInRun: false }
  const after = { completedInRun: true }
  state.targetSatisfaction[targetWeaponId] = after
  return [{ targetWeaponId, before, after }]
}

/** The OwnedWeapon IDs the Entries secured so far, each the completion of one Target. */
function securedOwnedWeaponIds(state: PlannerSearchState): ReadonlySet<OwnedWeaponId> {
  return new Set(Object.values(state.securedOwnedWeaponIdByEntryId))
}

/** The Gogma or Skill Counter a route unit leaves behind. */
function setCurrentRngCounter(
  state: PlannerSearchState,
  unit: PlannerRouteUnit,
) {
  if (unit.counterStream === 'gogma') {
    state.currentRngState.gogmaCounter.value = unit.counterAfter
    return
  }
  if (unit.counterStream === 'skill') {
    state.currentRngState.skillCounter.value = unit.counterAfter
  }
}

/**
 * The Normal Counters a route unit leaves behind, derived without writing any
 * state: its own Normal stream position, then a blind creation's advance of a
 * confirmed Counter.
 */
function normalCountersAfterRouteUnit(
  counters: NormalArtianCounter[],
  unit: PlannerRouteUnit,
  engine: RngEngine,
): NormalArtianCounter[] {
  const positioned =
    unit.counterStream === 'normal'
      ? counters.map((counter) =>
          counter.id === unit.counterId
            ? { ...counter, counter: unit.counterAfter }
            : counter,
        )
      : counters
  // Having no Counter stream position is a Route property, not a runtime one: a
  // blind creation still forges a real weapon, so a confirmed Normal Counter
  // advances here (`docs/PLANNER_SPEC.md` 7.0.3).
  return advanceBlindNormalCreationCounters(positioned, unit.operation, engine) ?? positioned
}

function counterPreconditionRejection(
  state: PlannerSearchState,
  unit: PlannerRouteUnit,
): PlannerSearchRejection | null {
  if (unit.counterStream === null) return null
  const current = currentPlannerCounterValue(state, unit)
  if (current === null || unit.counterBefore === null || unit.counterAfter === null) {
    return rejection(
      unit.entryId,
      unit.operation.type,
      'counter_unavailable',
      'The required confirmed counter is unavailable.',
    )
  }
  if (unit.counterAfter < unit.counterBefore) {
    return rejection(
      unit.entryId,
      unit.operation.type,
      'counter_after_mismatch',
      'A saved RouteOperation that rewinds its counter is not executable.',
    )
  }
  if (current > unit.counterBefore) {
    return rejection(
      unit.entryId,
      unit.operation.type,
      'counter_before_current',
      `The current counter ${current} has already passed required position ${unit.counterBefore}, and this operation cannot be skipped.`,
    )
  }
  if (current < unit.counterBefore) {
    return rejection(
      unit.entryId,
      unit.operation.type,
      'counter_unavailable',
      `The required counter position ${unit.counterBefore} has not been reached.`,
    )
  }
  return null
}

function protectedRejection(
  unit: PlannerRouteUnit,
  detail: string,
): PlannerSearchRejection {
  return rejection(
    unit.entryId,
    unit.operation.type,
    'protected_destructive_use',
    detail,
  )
}

function inventoryPreconditionRejection(
  state: PlannerSearchState,
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): PlannerSearchRejection | null {
  const operation = unit.operation
  if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
    if (operation.sourceOwnedWeaponId === null) {
      // A transient Gogma of either scope may be Reset or Kept: its inherited
      // slots are known whenever the Route knows them, and the blind variant's
      // Keep-before-Reset is already refused by Route validation and fails
      // closed in Trace Replay (`unknown_restoration_bonuses`).
      return state.routeRuntimeByEntryId[entry.id]?.hasUnregisteredGogmaOutput
        ? null
        : rejection(
            entry.id,
            operation.type,
            'inventory_precondition_failed',
            'The unregistered converted Gogma route output does not exist.',
          )
    }
    const source = findOwnedWeapon(state.simulatedInventory, operation.sourceOwnedWeaponId)
    if (!source) {
      return rejection(entry.id, operation.type, 'inventory_precondition_failed', `OwnedWeapon '${operation.sourceOwnedWeaponId}' is unavailable.`)
    }
    return canUseAsDestructiveGogmaSource(source)
      ? null
      : protectedRejection(unit, `OwnedWeapon '${operation.sourceOwnedWeaponId}' is protected or is not a Gogma source.`)
  }
  if (operation.type === 'reset_skills') {
    if (operation.sourceOwnedWeaponId === null) {
      return state.routeRuntimeByEntryId[entry.id]
        ?.hasUnregisteredGogmaOutput
        ? null
        : rejection(
            entry.id,
            operation.type,
            'inventory_precondition_failed',
            'The unregistered converted Gogma route output does not exist.',
          )
    }
    const source = findOwnedWeapon(
      state.simulatedInventory,
      operation.sourceOwnedWeaponId,
    )
    if (canUseAsResetSkillsSource(source)) return null
    return source?.kind === 'gogma' && source.isProtected
      ? protectedRejection(
          unit,
          `OwnedWeapon '${operation.sourceOwnedWeaponId}' is protected and cannot be used for Reset Skills.`,
        )
      : rejection(
          entry.id,
          operation.type,
          'inventory_precondition_failed',
          `OwnedWeapon '${operation.sourceOwnedWeaponId}' is not an available Gogma source.`,
        )
  }
  if (
    operation.type === 'convert_normal_to_gogma' &&
    entry.candidateSnapshot.route.kind === 'owned_normal_artian_to_gogma'
  ) {
    const sourceId = entry.candidateSnapshot.route.sourceOwnedWeaponId
    const source =
      sourceId === null
        ? null
        : findOwnedWeapon(state.simulatedInventory, sourceId)
    if (!source) {
      return rejection(
        entry.id,
        operation.type,
        'inventory_precondition_failed',
        'The owned Normal conversion source is unavailable.',
      )
    }
    return source.isProtected
      ? protectedRejection(
          unit,
          `Protected Normal Artian '${source.id}' cannot be converted.`,
        )
      : null
  }
  return null
}

type RouteInventoryEffectResult =
  | { rejection: PlannerSearchRejection }
  | {
      rejection: null
      /** The inventory after the action, or `null` when it is unchanged. */
      inventory: SimulatedInventory | null
      effect: PlannerSearchInventoryEffect
    }

/**
 * The simulated inventory change of one route unit, derived from the source
 * state without writing it. The inventory helpers return copies, so the
 * result never aliases the source state's inventory.
 */
function routeInventoryEffect(
  state: PlannerSearchState,
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): RouteInventoryEffectResult {
  const effect = emptyInventoryEffect()
  const operation = unit.operation
  if (
    operation.type === 'convert_normal_to_gogma' &&
    entry.candidateSnapshot.route.kind === 'owned_normal_artian_to_gogma'
  ) {
    const sourceId = entry.candidateSnapshot.route.sourceOwnedWeaponId
    if (sourceId === null) {
      return {
        rejection: rejection(
          entry.id,
          operation.type,
          'inventory_precondition_failed',
          'Owned Normal conversion route has no source OwnedWeapon ID.',
        ),
      }
    }
    const consumed = consumeOwnedNormalForConversion(
      state.simulatedInventory,
      sourceId,
    )
    if (!consumed.isValid || consumed.inventory === null) {
      return {
        rejection: rejection(
          entry.id,
          operation.type,
          'inventory_precondition_failed',
          consumed.issues[0]?.message ?? 'Owned Normal conversion failed.',
        ),
      }
    }
    effect.removedOwnedWeaponIds.push(sourceId)
    return { rejection: null, inventory: consumed.inventory, effect }
  }
  return { rejection: null, inventory: null, effect }
}

function routeOutputChanges(
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): boolean {
  if (unit.operation.type === 'convert_normal_to_gogma') {
    return (
      entry.candidateSnapshot.route.kind === 'normal_artian_to_gogma' ||
      entry.candidateSnapshot.route.kind ===
        'owned_normal_artian_to_gogma'
    )
  }
  return (
    (unit.operation.type === 'reset_bonuses' ||
      unit.operation.type === 'keep_bonuses' ||
      unit.operation.type === 'reset_skills') &&
    unit.operation.sourceOwnedWeaponId === null
  )
}

function nextTransientRestorationBonusScope(
  current: PlannerSearchState['routeRuntimeByEntryId'][BuildListEntryId],
  operation: PlannerRouteUnit['operation'],
): PlannerSearchState['routeRuntimeByEntryId'][BuildListEntryId]['transientRestorationBonusScope'] {
  if (operation.type === 'convert_normal_to_gogma') return 'normal_artian'
  // Either amendment rewrites all five slots as `gogma_artian` scope
  // (`docs/DATA_MODEL.md` 7.1): Reset redraws them, Keep rerolls each tier.
  if (
    (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') &&
    operation.sourceOwnedWeaponId === null
  ) {
    return 'gogma_artian'
  }
  return current?.transientRestorationBonusScope ?? null
}

/**
 * Every executable precondition checked before a route unit is applied.
 * Expansion and the required-unit eligibility scan below must use exactly the
 * same authority, so they never disagree about whether a unit can run in this
 * state.
 */
export function plannerRouteUnitPreconditionRejection(
  state: PlannerSearchState,
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): PlannerSearchRejection | null {
  if (!entryUsesCurrentSourceVersion(state, entry)) {
    return sourceVersionRejection(entry, unit)
  }
  const counterIssue = counterPreconditionRejection(state, unit)
  if (counterIssue) return counterIssue
  return inventoryPreconditionRejection(state, entry, unit)
}

/**
 * The source weapon preconditions of a route unit that do not depend on the
 * Counter position or on an Entry-local route output: the existing-source
 * version, and - for a unit that operates a concrete OwnedWeapon - that weapon's
 * availability and protection. `null` for a unit on a transient route output
 * or with no source weapon.
 *
 * The same authority `plannerRouteUnitPreconditionRejection()` applies, so a
 * caller that judges a not-yet-reachable unit (the deterministic scheduler's
 * Route commitment) never disagrees with the moment the unit actually runs.
 */
export function plannerRouteUnitSourceRejection(
  state: PlannerSearchState,
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): PlannerSearchRejection | null {
  if (!entryUsesCurrentSourceVersion(state, entry)) {
    return sourceVersionRejection(entry, unit)
  }
  if (routeUnitOwnedWeaponId(entry, unit) === null) return null
  return inventoryPreconditionRejection(state, entry, unit)
}

/** One shared Counter stream position, the resource a unit occupies. */
function counterPositionKey(unit: PlannerRouteUnit): string | null {
  if (unit.counterStream === null || unit.counterBefore === null) return null
  return `${unit.counterStream}\u0000${unit.counterId ?? ''}\u0000${unit.counterBefore}`
}

/**
 * Required next units that can run in this state, indexed by Counter position.
 *
 * A `canSkipWhenCounterPassed` unit and a required unit at the same position do
 * not conflict, but they are not interchangeable either: running the required
 * one first lets the skippable one fast-forward, while running the skippable
 * one first pushes the Counter past the required unit and kills that Route with
 * `counter_before_current`. The order is therefore decided by the Planner
 * itself, never by the user (`docs/PLANNER_SPEC.md` 7.0.2).
 */
export function executablePlannerRequiredUnitsByCounterPosition(
  state: PlannerSearchState,
  entries: readonly BuildListEntry[],
  lanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>,
  isUnitBlocked: (unit: PlannerRouteUnit) => boolean,
): Map<string, PlannerRouteUnit[]> {
  const required = new Map<string, PlannerRouteUnit[]>()
  entries.forEach((entry) => {
    if (state.selectedBuildListEntryIds.includes(entry.id)) return
    if (!entryIsRelevantForState(state, entry)) return
    const lanes = lanePlans.get(entry.id)
    if (!lanes) return
    const progress = state.routeProgressByEntryId[entry.id] ?? initialPlannerLaneProgress()
    for (const unit of nextPlannerLaneUnits(lanes, progress)) {
      if (unit.canSkipWhenCounterPassed) continue
      const key = counterPositionKey(unit)
      if (key === null) continue
      if (isUnitBlocked(unit)) continue
      if (plannerRouteUnitPreconditionRejection(state, entry, unit) !== null) continue
      required.set(key, [...(required.get(key) ?? []), unit])
    }
  })
  return required
}

/**
 * Whether running this skippable unit now would irreversibly lose a required
 * unit that occupies the same Counter position.
 *
 * A skippable unit that is the same physical action as one of those required
 * units is not an alternative to it: the PR #4 sharing contract already runs
 * both Entries with one operation, so that case keeps its existing semantics.
 */
export function isSkippablePlannerUnitDominatedByRequiredUnit(
  unit: PlannerRouteUnit,
  requiredByCounterPosition: ReadonlyMap<string, readonly PlannerRouteUnit[]>,
): boolean {
  if (!unit.canSkipWhenCounterPassed) return false
  const key = counterPositionKey(unit)
  if (key === null) return false
  const required = requiredByCounterPosition.get(key)
  if (required === undefined || required.length === 0) return false
  return !required.some((other) => arePlannerRouteUnitsShareable(other, unit))
}

/**
 * The units one physical action progresses: the primary unit plus, when it is
 * shareable, every other relevant Entry's next unit that is the same physical
 * action, in stable Entry ID order. Read from the state before the action.
 */
export function mergedPlannerProgressedEntries(
  state: PlannerSearchState,
  primary: PlannerRouteUnit,
  context: PlannerRouteActionContext,
): PlannerRouteUnit[] {
  const {
    entriesById,
    lanePlans,
    conflictsById,
    conflictIdsByUnitKey,
    selectedPhysicalActionKeysByConflictId,
  } = context
  const shared = [primary]
  if (!primary.shareable) return shared
  lanePlans.forEach((lanes, entryId) => {
    if (entryId === primary.entryId) return
    if (context.canShareWithEntry !== undefined && !context.canShareWithEntry(entryId)) return
    if (state.selectedBuildListEntryIds.includes(entryId)) return
    const entry = entriesById.get(entryId)
    if (!entry) return
    if (!entryUsesCurrentSourceVersion(state, entry)) return
    if (!entryIsRelevantForState(state, entry)) return
    const progress = state.routeProgressByEntryId[entryId] ?? initialPlannerLaneProgress()
    const next = nextPlannerLaneUnits(lanes, progress).find((unit) =>
      arePlannerRouteUnitsShareable(primary, unit),
    )
    if (
      next &&
      !isUnitBlockedByConflictResolution(
        next,
        conflictsById,
        conflictIdsByUnitKey,
        selectedPhysicalActionKeysByConflictId,
        (entryId) => {
          const selected = entriesById.get(entryId)
          return selected !== undefined && entryIsRelevantForState(state, selected)
        },
      )
    ) {
      shared.push(next)
    }
  })
  return shared.sort((left, right) =>
    compareStableStrings(left.entryId, right.entryId),
  )
}

/**
 * Applies one physical route action.
 *
 * Every decision that reads the state before the action - the preconditions,
 * the inventory change, the RNG snapshot and the physical action sharing - is
 * taken from `sourceState` before anything is written, so an in-place
 * application never lets a partial write leak into those decisions, and a
 * rejection leaves the source state untouched in either mode.
 */
export function applyPlannerRouteAction(
  sourceState: PlannerSearchState,
  primary: PlannerRouteUnit,
  context: PlannerRouteActionContext,
  options: PlannerRouteActionOptions,
): PlannerAppliedActionResult {
  const { entriesById, lanePlans, engine, preferredSourceEntryIds } = context
  const primaryEntry = entriesById.get(primary.entryId)
  if (!primaryEntry) {
    return rejected(
      rejection(
        primary.entryId,
        primary.operation.type,
        'inventory_precondition_failed',
        'BuildListEntry disappeared from the validated search set.',
      ),
    )
  }
  const preconditionIssue = plannerRouteUnitPreconditionRejection(
    sourceState,
    primaryEntry,
    primary,
  )
  if (preconditionIssue) return rejected(preconditionIssue)
  const appliedInventory = routeInventoryEffect(sourceState, primaryEntry, primary)
  if (appliedInventory.rejection !== null) {
    return rejected(appliedInventory.rejection)
  }
  const before = rngSnapshot(sourceState)
  const progressedUnits = mergedPlannerProgressedEntries(
    sourceState,
    primary,
    context,
  )

  // Nothing above wrote any state; nothing below can reject the action.
  const state = writableState(sourceState, options.mode)
  const normalCounters = normalCountersAfterRouteUnit(
    state.currentNormalCounters,
    primary,
    engine,
  )
  if (appliedInventory.inventory !== null) {
    state.simulatedInventory = appliedInventory.inventory
  }
  setCurrentRngCounter(state, primary)
  state.currentNormalCounters = normalCounters
  const mutatedSourceId = sourceMutatedByOperation(primary.operation)
  if (mutatedSourceId !== null) {
    state.sourceMutationVersionByOwnedWeaponId[mutatedSourceId] =
      (state.sourceMutationVersionByOwnedWeaponId[mutatedSourceId] ?? 0) + 1
  }
  const progressedRoutePositions: PlannerSearchAction['progressedRoutePositions'] =
    {}
  progressedUnits.forEach((unit) => {
    const lanes = lanePlans.get(unit.entryId)
    const previousProgress =
      state.routeProgressByEntryId[unit.entryId] ?? initialPlannerLaneProgress()
    const nextProgress = advancePlannerLaneProgress(previousProgress, unit)
    state.routeProgressByEntryId[unit.entryId] = nextProgress
    progressedRoutePositions[unit.entryId] = unit.position
    const entry = entriesById.get(unit.entryId)
    if (entry && routeOutputChanges(entry, unit)) {
      const currentRuntime = state.routeRuntimeByEntryId[entry.id]
      state.routeRuntimeByEntryId[entry.id] = {
        hasUnregisteredGogmaOutput: true,
        transientRestorationBonusScope: nextTransientRestorationBonusScope(
          currentRuntime,
          unit.operation,
        ),
      }
      appliedInventory.effect.routeOutputChangedForEntryIds.push(entry.id)
    }
    const sourceId = entry ? existingRouteSourceId(entry) : null
    if (entry && sourceId !== null) {
      state.routeSourceVersionByEntryId[entry.id] =
        state.sourceMutationVersionByOwnedWeaponId[sourceId] ?? 0
    }
    if (
      entry &&
      lanes !== undefined &&
      isExistingGogmaRoute(entry) &&
      isPlannerLaneRouteComplete(lanes, nextProgress) &&
      sourceId !== null
    ) {
      state.candidateReadySourceVersionByEntryId[entry.id] =
        state.routeSourceVersionByEntryId[entry.id]
    }
  })
  // Counter stream progression only: a Route prefix another Entry's real
  // operation already passed advances silently here. It creates no Search
  // Action, no trace entry, no progressed Entry / Target record, no inventory
  // effect, and no route runtime output (docs/PLANNER_SPEC.md 7.0.2).
  fastForwardPlannerRouteProgress(state, lanePlans)
  const progressedBuildListEntryIds = progressedUnits.map(
    ({ entryId }) => entryId,
  )
  appliedInventory.effect.routeOutputChangedForEntryIds.sort(
    compareStableStrings,
  )
  const action: PlannerSearchAction = {
    kind: 'route_operation',
    actionType: primary.operation.type,
    primaryBuildListEntryId: primary.entryId,
    progressedBuildListEntryIds,
    progressedRoutePositions,
    routeOperation: structuredClone(primary.operation),
    ownedWeaponId: routeUnitOwnedWeaponId(primaryEntry, primary),
    plannerOnly: false,
    rngBefore: before,
    rngAfter: rngSnapshot(state),
    inventoryEffect: appliedInventory.effect,
    // A physical operation completes no Target and un-completes none: a
    // mutated existing source neither loses nor grants any Target's completion
    // (Issue #334 PR-3, `docs/PLANNER_SPEC.md` 21.5).
    satisfactionChanges: [],
  }
  state.trace.push(action)
  // One physical action, so the switch is judged once. Sharing this action with
  // other Entries and fast-forwarding other Entries' passed Route prefixes both
  // stay invisible here: neither is an operation the player performs
  // (docs/PLANNER_SPEC.md 7.3).
  advancePlannerWeaponSwitchMetric(
    state,
    plannerWeaponOperationSubjectKey(primary.entryId, primary.operation),
  )
  // A silently fast-forwarded prefix is not counted: it progresses no Entry
  // here, so it never appears in `progressedBuildListEntryIds`
  // (docs/PLANNER_SPEC.md 7.0.2 / 7.4).
  advancePlannerPreferredSourceMetric(
    state,
    progressedBuildListEntryIds,
    preferredSourceEntryIds,
  )
  state.totalCost = state.trace.length
  return { state, rejection: null }
}

function createReservedWeapon(
  entry: BuildListEntry,
  target: TargetWeapon,
  id: OwnedWeaponId,
): OwnedGogmaArtianWeapon {
  const candidate = entry.candidateSnapshot
  return {
    id,
    kind: 'gogma',
    name: '',
    weaponTypeId: target.weaponTypeId,
    elementId: target.elementId,
    restorationBonuses: structuredClone(candidate.finalBonuses),
    restorationBonusScope: candidate.restorationBonusScope,
    seriesSkillId: candidate.seriesSkillId,
    groupSkillId: candidate.groupSkillId,
    // Every Candidate is a canonical Ideal Candidate, so a newly generated
    // weapon is labelled Ideal and protected by default, exactly as the
    // existing Ideal contract requires (`docs/DATA_MODEL.md` 3.2).
    status: 'ideal',
    isProtected: true,
    // Non-semantic Execution state; Planner calculation never sets it.
    executionInProgress: null,
    memo: null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.createdAt,
  }
}

/**
 * Applies the internal reserve of one Entry's Candidate
 * (`docs/PLANNER_SPEC.md` 16.3).
 *
 * Every precondition and the resulting inventory are derived from
 * `sourceState` before anything is written, so a rejection leaves the source
 * state untouched in either mode. A newly created weapon's ID is drawn from
 * the ID factory at the same point as before, including on a rejection that
 * follows the draw.
 */
export function applyPlannerReserveAction(
  sourceState: PlannerSearchState,
  entry: BuildListEntry,
  target: TargetWeapon,
  context: PlannerReserveActionContext,
  options: PlannerReserveActionOptions,
): PlannerAppliedActionResult {
  const { dependencies, master, completionAssignments, preferredSourceEntryIds } = context
  const zeroOperationConfirm = options.zeroOperationConfirm === true
  // One completion per Target and per Entry (Issue #334 PR-3,
  // `docs/PLANNER_SPEC.md` 21.5): a Target this run already completed - by this
  // very Entry, or by another Entry of the same Target in a malformed input - is
  // never completed again. An owned weapon that merely performs the condition
  // never stands in the way: only a recorded completion does.
  if (
    sourceState.selectedBuildListEntryIds.includes(entry.id) ||
    isPlannerTargetComplete(sourceState, entry.targetWeaponId) ||
    !entryIsRelevantForState(sourceState, entry)
  ) {
    return rejected(
      rejection(
        entry.id,
        'reserve_weapon',
        'inventory_precondition_failed',
        `TargetWeapon '${entry.targetWeaponId}' was already completed in this run, or is not a planning Target of it.`,
      ),
    )
  }
  const alreadySecured = securedOwnedWeaponIds(sourceState)
  const route = entry.candidateSnapshot.route
  const effect = emptyInventoryEffect()
  let ownedWeaponId: OwnedWeaponId
  let inventory: SimulatedInventory

  if (
    route.kind === 'normal_artian_to_gogma' ||
    route.kind === 'owned_normal_artian_to_gogma'
  ) {
    if (!sourceState.routeRuntimeByEntryId[entry.id]?.hasUnregisteredGogmaOutput) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          'The route has no unregistered Gogma output to secure.',
        ),
      )
    }
    ownedWeaponId = dependencies.idFactory.ownedWeaponId()
    // A reserved ID is excluded exactly like an existing weapon (21.5): the ID
    // factory never repeats one, and the inventory refuses a repeat too, but
    // the completion exclusivity is judged here as its own authority.
    if (alreadySecured.has(ownedWeaponId)) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          `OwnedWeapon '${ownedWeaponId}' was already secured as the completion of another BuildListEntry in this run.`,
        ),
      )
    }
    const reserved = reserveWeaponId(sourceState.simulatedInventory, ownedWeaponId)
    if (!reserved.isValid || reserved.inventory === null) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          reserved.issues[0]?.message ?? 'OwnedWeapon ID reservation failed.',
        ),
      )
    }
    effect.reservedOwnedWeaponIds.push(ownedWeaponId)
    const weapon = createReservedWeapon(entry, target, ownedWeaponId)
    const registered = addRegisteredWeapon(reserved.inventory, weapon)
    if (!registered.isValid || registered.inventory === null) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          registered.issues[0]?.message ?? 'Candidate registration failed.',
        ),
      )
    }
    inventory = registered.inventory
    effect.addedOwnedWeaponIds.push(ownedWeaponId)
  } else {
    const sourceId = route.sourceOwnedWeaponId
    const source =
      sourceId === null
        ? null
        : findOwnedWeapon(sourceState.simulatedInventory, sourceId)
    if (!source || source.kind !== 'gogma' || sourceId === null) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          'The existing Gogma source is unavailable for Candidate reserve.',
        ),
      )
    }
    // One OwnedWeapon completes at most one Target (Issue #334 PR-3,
    // `docs/PLANNER_SPEC.md` 21.4 / 21.5): a weapon another Entry secured in
    // this run, or a weapon another Target was completed with before it, is
    // never this Entry's completion. Route commitment makes two Entries on one
    // weapon collide before either runs, so this is the Domain's own defence,
    // shared by the Beam Search oracle.
    if (alreadySecured.has(sourceId)) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          `OwnedWeapon '${sourceId}' was already secured as the completion of another BuildListEntry in this run.`,
        ),
      )
    }
    if (isCompletionAssignedElsewhere(completionAssignments, sourceId, entry.targetWeaponId)) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          `OwnedWeapon '${sourceId}' is the completion of another TargetWeapon.`,
        ),
      )
    }
    const readyVersion = zeroOperationConfirm
      ? 0
      : sourceState.candidateReadySourceVersionByEntryId[entry.id]
    const currentVersion =
      sourceState.sourceMutationVersionByOwnedWeaponId[sourceId] ?? 0
    if (readyVersion === undefined || readyVersion !== currentVersion) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          'The existing Gogma Candidate was superseded by a later source mutation.',
        ),
      )
    }
    // A zero-operation Candidate confirms the weapon as it is, so its own
    // weapon must satisfy its Target's completion condition now (21.5): the
    // confirmation is the Entry's own completion, never an inference from what
    // some other owned weapon performs.
    if (
      zeroOperationConfirm &&
      !satisfiesCompletionTarget(
        target,
        source.restorationBonuses,
        source.restorationBonusScope,
        source.seriesSkillId,
        source.groupSkillId,
        master,
      )
    ) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          `OwnedWeapon '${sourceId}' does not satisfy the completion condition of TargetWeapon '${target.id}'.`,
        ),
      )
    }
    ownedWeaponId = sourceId
    const updated: OwnedGogmaArtianWeapon = {
      ...source,
      restorationBonuses: structuredClone(entry.candidateSnapshot.finalBonuses),
      restorationBonusScope: entry.candidateSnapshot.restorationBonusScope,
      seriesSkillId: entry.candidateSnapshot.seriesSkillId,
      groupSkillId: entry.candidateSnapshot.groupSkillId,
      // Ideal completion protects an existing weapon exactly like a newly
      // created one, so a completed weapon is never the amendment source of a
      // later unit of the same Plan (`docs/PLANNER_SPEC.md` 16.3 / 16.13).
      status: 'ideal',
      isProtected: true,
    }
    const result = updateOwnedWeapon(sourceState.simulatedInventory, updated)
    if (!result.isValid || result.inventory === null) {
      return rejected(
        rejection(
          entry.id,
          'reserve_weapon',
          'inventory_precondition_failed',
          result.issues[0]?.message ?? 'Existing Gogma update failed.',
        ),
      )
    }
    inventory = result.inventory
    effect.updatedOwnedWeaponIds.push(ownedWeaponId)
  }
  const before = rngSnapshot(sourceState)

  // Nothing above wrote any state; nothing below can reject the action.
  const state = writableState(sourceState, options.mode)
  state.simulatedInventory = inventory
  state.securedOwnedWeaponIdByEntryId[entry.id] = ownedWeaponId
  // The Entry's own reserve is the one event that completes its Target in the
  // run; a weapon that also performs another Target's condition completes
  // nothing else (21.5).
  const satisfactionChanges = completeTargetInRun(state, entry.targetWeaponId)
  state.selectedBuildListEntryIds = [
    ...state.selectedBuildListEntryIds,
    entry.id,
  ].sort(compareStableStrings)
  const action: PlannerSearchAction = {
    kind: 'reserve_candidate',
    actionType: 'reserve_weapon',
    primaryBuildListEntryId: entry.id,
    progressedBuildListEntryIds: [entry.id],
    progressedRoutePositions: {},
    routeOperation: null,
    ownedWeaponId,
    plannerOnly: true,
    rngBefore: before,
    rngAfter: rngSnapshot(state),
    inventoryEffect: effect,
    satisfactionChanges,
  }
  state.trace.push(action)
  advancePlannerPreferredSourceMetric(
    state,
    [entry.id],
    preferredSourceEntryIds,
  )
  state.totalCost = state.trace.length
  return { state, rejection: null }
}
