import type {
  BuildListEntry,
  BuildListEntryId,
  DomainValidationIssue,
  PlanConflict,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { stableStringify } from '../models/publicTypes'
import {
  conflictResolutionRefusalReason,
  detectPlannerConflicts,
  type PlannerConflictDetectionResult,
} from './plannerConflictDetection'
import type { PlannerCheckpointRequirements } from './plannerCheckpoints'
import { entryIsRelevantForState } from './plannerEntryRelevance'
import {
  initialPlannerLaneProgress,
  isPlannerLaneRouteComplete,
  remainingPlannerLaneUnits,
  type PlannerEntryLanes,
} from './plannerRouteLanes'
import {
  applyPlannerReserveAction,
  type PlannerReserveActionContext,
  type PlannerStateMutationMode,
} from './plannerStateTransitions'
import { createUnsearchedPlannerTermination } from './plannerTermination'
import type {
  ExcludedBuildListEntry,
  PlannerConflictResolution,
  PlannerRunResultOf,
  PlannerSearchRejection,
  PlannerSearchState,
  PlannerTerminationOf,
  PlannerWarning,
} from './plannerTypes'

/**
 * Pure helpers the Beam Search oracle and the Production deterministic scheduler
 * (Issue #103 Phase A, `docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 17)
 * both use, so the two never carry two copies of one rule. None of them
 * decides a search strategy.
 */

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function plannerRejectionKey(value: PlannerSearchRejection): string {
  return stableStringify(value)
}

export function appendUniquePlannerRejection(
  rejections: PlannerSearchRejection[],
  rejectionKeys: Set<string>,
  value: PlannerSearchRejection,
): void {
  const key = plannerRejectionKey(value)
  if (rejectionKeys.has(key)) return
  rejectionKeys.add(key)
  rejections.push(value)
}

/** The stable order a Planner result reports its rejections in. */
export function sortPlannerRejections(
  rejections: PlannerSearchRejection[],
): PlannerSearchRejection[] {
  return rejections.sort((left, right) =>
    compareStableStrings(plannerRejectionKey(left), plannerRejectionKey(right)),
  )
}

export function addPlannerWarning(
  warnings: PlannerWarning[],
  kind: PlannerWarning['kind'],
  message: string,
): void {
  if (warnings.some((warning) => warning.kind === kind && warning.message === message)) {
    return
  }
  warnings.push({ kind, message })
}

/**
 * The PlanConflicts of one state: every Entry still relevant in it, over its
 * remaining (not yet executed or passed) Route units, through the one conflict
 * authority `detectPlannerConflicts()`.
 */
export function detectCurrentPlannerConflicts(
  state: PlannerSearchState,
  allSearchEntries: readonly BuildListEntry[],
  allLanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>,
  targets: readonly TargetWeapon[],
  resolutions: readonly PlannerConflictResolution[],
  requirements: PlannerCheckpointRequirements,
): PlannerConflictDetectionResult {
  const entries = allSearchEntries.filter((entry) =>
    entryIsRelevantForState(state, entry, requirements),
  )
  const unitPlans = new Map(
    entries.flatMap((entry) => {
      const lanes = allLanePlans.get(entry.id)
      if (!lanes) return []
      const progress = state.routeProgressByEntryId[entry.id] ?? initialPlannerLaneProgress()
      return [[entry.id, remainingPlannerLaneUnits(lanes, progress)] as const]
    }),
  )
  return detectPlannerConflicts(entries, unitPlans, targets, resolutions, false)
}

export function plannerConflictCountByEntryId(
  conflicts: readonly PlanConflict[],
): Map<BuildListEntryId, number> {
  const counts = new Map<BuildListEntryId, number>()
  conflicts.forEach((conflict) => {
    conflict.buildListEntryIds.forEach((entryId) => {
      counts.set(entryId, (counts.get(entryId) ?? 0) + 1)
    })
  })
  return counts
}

/** The `invalid_conflict_resolution` warnings of the resolutions no conflict accepted. */
export function plannerConflictResolutionWarnings(
  resolutions: readonly PlannerConflictResolution[],
  conflictsById: ReadonlyMap<string, PlanConflict>,
): PlannerWarning[] {
  return resolutions.flatMap((resolution) => {
    // The same refusal authority the detection applied, so a resolution that
    // targets a selected-checkpoint conflict is reported here too.
    const reason = conflictResolutionRefusalReason(
      resolution,
      conflictsById.get(resolution.conflictKey),
    )
    return reason === null
      ? []
      : [{ kind: 'invalid_conflict_resolution' as const, message: reason }]
  })
}

/**
 * The result of a Planner run whose input failed validation before any action.
 * `limits` is the bounds as the caller's termination shape records them - the
 * Production `plannerRunLimits()` or the Beam Search oracle's own.
 */
export function createPlannerInitialFailureResult<TLimits>(
  limits: TLimits,
  warnings: PlannerWarning[],
  issues: DomainValidationIssue[],
  excludedBuildListEntries: ExcludedBuildListEntry[],
  planningTargetIds: readonly TargetWeaponId[],
): PlannerRunResultOf<PlannerTerminationOf<never, TLimits>> {
  return {
    bestState: null,
    conflicts: [],
    warnings,
    validationIssues: issues,
    excludedBuildListEntries,
    rejections: [],
    expandedStates: 0,
    completed: false,
    cancelled: false,
    // No action ran, so no bound was touched. The reason the input was
    // rejected is reported by its own validation warnings.
    termination: createUnsearchedPlannerTermination(limits, planningTargetIds),
  }
}

/**
 * The Entries whose internal reserve must be applied before any other action
 * (`docs/PLANNER_SPEC.md` 16.3).
 *
 * The execution projection completes a Target on the Entry's last physical
 * Step, so the search secures a Candidate right after that unit, with nothing
 * but other such reserves in between: these are the Entries the most recent
 * physical action progressed, provided only reserves followed it, whose Route
 * is now complete and whose Target can still use them, in stable Entry ID
 * order. An Entry that misses this moment is never reserved later.
 */
export function pendingPlannerReserveEntries(
  state: PlannerSearchState,
  entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>,
  lanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>,
  requirements: PlannerCheckpointRequirements,
): BuildListEntry[] {
  let index = state.trace.length - 1
  while (index >= 0 && state.trace[index].kind === 'reserve_candidate') index -= 1
  const physical = index >= 0 ? state.trace[index] : undefined
  if (physical?.kind !== 'route_operation') return []
  return [...physical.progressedBuildListEntryIds]
    .sort(compareStableStrings)
    .flatMap((entryId) => {
      const entry = entriesById.get(entryId)
      const lanes = lanePlans.get(entryId)
      if (!entry || !lanes) return []
      if (state.selectedBuildListEntryIds.includes(entryId)) return []
      const progress = state.routeProgressByEntryId[entryId] ?? initialPlannerLaneProgress()
      if (!isPlannerLaneRouteComplete(lanes, progress)) return []
      return entryIsRelevantForState(state, entry, requirements) ? [entry] : []
    })
}

/**
 * The caller's bound on the zero-operation confirmations. Each confirmation is
 * one trace action and so one PlanStep; `canApply` is asked right before each
 * one would be applied, and a confirmation it refuses is reported through
 * `onWithheld` instead of being applied.
 */
export interface PlannerZeroOperationConfirmBound {
  canApply(): boolean
  onWithheld(targetId: TargetWeaponId): void
}

export interface PlannerZeroOperationConfirmContext {
  readonly allSearchEntries: readonly BuildListEntry[]
  readonly allLanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>
  readonly planningTargetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>
  readonly checkpointRequirements: PlannerCheckpointRequirements
  readonly reserveContext: PlannerReserveActionContext
}

/**
 * A zero-operation Candidate whose owned Gogma already satisfies its active
 * Target is confirmed, not silently dropped as already satisfied: it becomes
 * one `confirm_owned_ideal` Step that advances no Counter and completes the
 * Target (`docs/PLANNER_SPEC.md` 16.3). It changes no RNG state, so it is
 * applied before any other action, one Entry per Target in stable ID order.
 *
 * Returns the state after every confirmation: a new state in `clone` mode, the
 * given state itself in `in_place` mode. A rejected confirmation is reported
 * through `onRejection` and writes nothing.
 *
 * With a `bound`, a confirmation the bound refuses is withheld and reported,
 * every one already applied is kept, and the stable order never changes: once
 * the bound refuses, it refuses every later one too, because a withheld
 * confirmation writes nothing. Without a `bound` every confirmation is
 * applied, as the Beam Search oracle does.
 */
export function applyPlannerZeroOperationConfirms(
  state: PlannerSearchState,
  context: PlannerZeroOperationConfirmContext,
  mode: PlannerStateMutationMode,
  onRejection: (rejection: PlannerSearchRejection) => void,
  bound?: PlannerZeroOperationConfirmBound,
): PlannerSearchState {
  let current = state
  const confirmedTargetIds = new Set<TargetWeaponId>()
  for (const entry of context.allSearchEntries) {
    const lanes = context.allLanePlans.get(entry.id)
    if (
      lanes === undefined ||
      lanes.unitCount !== 0 ||
      entry.candidateSnapshot.route.kind !== 'existing_gogma_current'
    ) continue
    const required = context.checkpointRequirements.requiredEntryIdByTargetId.get(
      entry.targetWeaponId,
    )
    if (required !== undefined && required !== entry.id) continue
    const target = context.planningTargetsById.get(entry.targetWeaponId)
    if (!target || confirmedTargetIds.has(target.id)) continue
    if (current.targetSatisfaction[target.id]?.hasIdeal !== true) continue
    if (bound !== undefined && !bound.canApply()) {
      bound.onWithheld(target.id)
      confirmedTargetIds.add(target.id)
      continue
    }
    const confirmed = applyPlannerReserveAction(
      current,
      entry,
      target,
      context.reserveContext,
      { mode, zeroOperationConfirm: true },
    )
    if (confirmed.rejection) onRejection(confirmed.rejection)
    if (confirmed.state) {
      current = confirmed.state
      confirmedTargetIds.add(target.id)
    }
  }
  return current
}
