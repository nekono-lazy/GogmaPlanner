import type {
  BuildListEntry,
  BuildListEntryId,
  ProductionPlan,
  TargetWeaponId,
} from '../models/publicTypes'
import type {
  PlannerConflictResolution,
  PlannerRouteCommitmentEvidence,
  PlannerSearchRejectionReason,
} from './plannerTypes'

/**
 * Whether every Entry an explicit decision preferred is completed by the Plan
 * a conflict-resolution run produced (`docs/PLANNER_SPEC.md` 9.6.6).
 *
 * 「この候補を優先」 means "complete this Entry in this Plan", so a run whose
 * preferred Entry is not completed is never saved as the success of that
 * decision. This module is the one pure authority the Planner result carries
 * (`PlannerResult.conflictResolutionOutcome`) and the Application reads; the
 * save re-checks the same two records of the Plan as a defence.
 *
 * Every value here is runtime-only: it is never persisted, exported, or part of
 * a `ProductionPlan`.
 */

/**
 * Why a preferred Entry is not completed, from the Planner Domain's own route
 * commitment and rejection records. `unknown` is used whenever the records do
 * not name a cause: a cause is never guessed.
 *
 * - `preferred_entries_conflict`: a provisional outcome of an undecided
 *   conflict kept another preferred Entry and dropped this one
 * - `deadlock_or_stall`: the scheduler dropped it because the committed Routes
 *   waited on each other or a Counter stream stalled
 * - `execution_precondition_failed`: a Counter it needs was passed, its source
 *   weapon was gone, protected or changed, or its RNG input was unavailable
 * - `checkpoint_not_reached`: its selected compromise checkpoint was not reached
 * - `satisfied_by_other_entry`: another Entry's weapon satisfied its Target, so
 *   it was released (no completion effect of its own)
 * - `inconsistent_completion_record`: the Plan records it as selected but not
 *   as completing its Target, or the reverse (fail closed)
 */
export type PlannerPreferredEntryIncompleteCause =
  | { kind: 'preferred_entries_conflict'; conflictId: string; otherBuildListEntryId: BuildListEntryId }
  | { kind: 'deadlock_or_stall' }
  | { kind: 'execution_precondition_failed' }
  | { kind: 'checkpoint_not_reached' }
  | { kind: 'satisfied_by_other_entry' }
  | { kind: 'inconsistent_completion_record' }
  | { kind: 'unknown' }

export type PlannerPreferredEntryOutcome =
  | {
      buildListEntryId: BuildListEntryId
      /** `null` when the Entry is not in the run input (its decision was then refused too). */
      targetWeaponId: TargetWeaponId | null
      status: 'completed'
    }
  | {
      buildListEntryId: BuildListEntryId
      targetWeaponId: TargetWeaponId | null
      status: 'incomplete'
      cause: PlannerPreferredEntryIncompleteCause
    }

export interface PlannerConflictResolutionOutcome {
  /** One per distinct preferred Entry, in stable Entry ID order. */
  preferredEntries: PlannerPreferredEntryOutcome[]
  /** `true` exactly when every preferred Entry is `completed`. */
  allPreferredEntriesCompleted: boolean
}

export interface PlannerConflictResolutionOutcomeInput {
  /** The explicit decisions this run was given (`PlannerInput.conflictResolutions`). */
  resolutions: readonly PlannerConflictResolution[]
  /** The Plan the run produced, or `null`. */
  plan: ProductionPlan | null
  /** The run input's Entries, to name each preferred Entry's Target. */
  buildListEntries: readonly BuildListEntry[]
  /** The deterministic scheduler's route commitment record, when the run reached it. */
  routeCommitment: PlannerRouteCommitmentEvidence | null
}

const EXECUTION_PRECONDITION_REASONS: readonly PlannerSearchRejectionReason[] = [
  'counter_before_current',
  'counter_after_mismatch',
  'counter_unavailable',
  'inventory_precondition_failed',
  'protected_destructive_use',
  'rng_contract_unavailable',
]

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The distinct Entries the decisions prefer, in stable ID order. */
export function plannerPreferredBuildListEntryIds(
  resolutions: readonly PlannerConflictResolution[],
): BuildListEntryId[] {
  return [...new Set(resolutions.map(({ selectedBuildListEntryId }) => selectedBuildListEntryId))]
    .sort(compareStableStrings)
}

/**
 * Whether the Plan completes `buildListEntryId`, by the two records 9.6.6
 * names: the Plan's `selectedBuildListEntryIds` (the Entries the run secured)
 * and a `steps[].executionEffects.targetCompletions` record for its Target. Both
 * must hold; one without the other is an inconsistent record.
 */
export function plannerPlanCompletionRecord(
  plan: ProductionPlan,
  buildListEntryId: BuildListEntryId,
  targetWeaponId: TargetWeaponId | null,
): 'completed' | 'not_completed' | 'inconsistent' {
  const secured = plan.selectedBuildListEntryIds.includes(buildListEntryId)
  const completes =
    targetWeaponId !== null &&
    plan.steps.some((step) =>
      (step.executionEffects?.targetCompletions ?? []).some(
        (completion) => completion.targetWeaponId === targetWeaponId,
      ),
    )
  if (secured && completes) return 'completed'
  return secured || completes ? 'inconsistent' : 'not_completed'
}

function incompleteCause(
  buildListEntryId: BuildListEntryId,
  preferred: ReadonlySet<BuildListEntryId>,
  routeCommitment: PlannerRouteCommitmentEvidence | null,
): PlannerPreferredEntryIncompleteCause {
  const evidence = routeCommitment?.entries.find((entry) => entry.buildListEntryId === buildListEntryId)
  if (evidence === undefined) return { kind: 'unknown' }
  if (evidence.status === 'released') return { kind: 'satisfied_by_other_entry' }
  if (evidence.status !== 'dropped') return { kind: 'unknown' }
  const outcome = evidence.provisionalOutcome
  if (outcome !== null) {
    // An explicitly preferred Entry outranks every other one in a provisional
    // outcome, so only another preferred Entry can have dropped it.
    return preferred.has(outcome.selectedBuildListEntryId)
      ? {
          kind: 'preferred_entries_conflict',
          conflictId: outcome.conflictId,
          otherBuildListEntryId: outcome.selectedBuildListEntryId,
        }
      : { kind: 'unknown' }
  }
  const reasons = evidence.rejectionReasons
  if (reasons.includes('conflict_not_committed')) return { kind: 'deadlock_or_stall' }
  if (reasons.includes('selected_checkpoint_not_reached')) return { kind: 'checkpoint_not_reached' }
  if (reasons.some((reason) => EXECUTION_PRECONDITION_REASONS.includes(reason))) {
    return { kind: 'execution_precondition_failed' }
  }
  if (reasons.includes('candidate_already_satisfied')) return { kind: 'satisfied_by_other_entry' }
  return { kind: 'unknown' }
}

/**
 * The completion of every preferred Entry of one conflict-resolution run
 * (`docs/PLANNER_SPEC.md` 9.6.6). A preferred Entry is the selected Entry of
 * any decision the run was given; a decision the run refused also leaves an
 * `invalid_conflict_resolution` warning, which refuses the save on its own.
 */
export function evaluatePlannerConflictResolutionOutcome(
  input: PlannerConflictResolutionOutcomeInput,
): PlannerConflictResolutionOutcome {
  const preferredIds = plannerPreferredBuildListEntryIds(input.resolutions)
  const preferred = new Set(preferredIds)
  const entriesById = new Map(input.buildListEntries.map((entry) => [entry.id, entry]))
  const preferredEntries = preferredIds.map((buildListEntryId): PlannerPreferredEntryOutcome => {
    const targetWeaponId = entriesById.get(buildListEntryId)?.targetWeaponId ?? null
    const record = input.plan === null
      ? 'not_completed'
      : plannerPlanCompletionRecord(input.plan, buildListEntryId, targetWeaponId)
    if (record === 'completed') return { buildListEntryId, targetWeaponId, status: 'completed' }
    return {
      buildListEntryId,
      targetWeaponId,
      status: 'incomplete',
      cause: record === 'inconsistent'
        ? { kind: 'inconsistent_completion_record' }
        : incompleteCause(buildListEntryId, preferred, input.routeCommitment),
    }
  })
  return {
    preferredEntries,
    allPreferredEntriesCompleted: preferredEntries.every(({ status }) => status === 'completed'),
  }
}
