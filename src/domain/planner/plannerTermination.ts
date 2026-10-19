import type { TargetWeaponId } from '../models/publicTypes'
import type { PlannerCheckpointRequirements } from './plannerCheckpoints'
import { isPlannerTargetComplete } from './plannerEntryRelevance'
import type {
  PlannerOptions,
  PlannerRunLimitKind,
  PlannerRunTermination,
  PlannerSearchState,
  PlannerTerminationOf,
} from './plannerTypes'

/**
 * How a full Planner run ended, as typed data (PLANNER_SPEC 7.2.1).
 *
 * This module is the single place the status is derived. UI, Application and
 * Persistence read `PlannerRunTermination`; they never parse a
 * `PlannerWarning.message` and never re-derive the status from a warning kind.
 * `max_steps_reached` stays a diagnostic that says the bound was touched -
 * which a *completed* run can also do, when the last affordable action
 * happened to be the one that completed it. The Beam Search oracle derives its
 * own termination through the same `createPlannerTermination()`, with its own
 * limit kinds (`plannerBeamSearchTypes.ts`).
 */

/** True when this full Planner run may become an executable ProductionPlan. */
export function isPlannerRunResultUsable(termination: PlannerRunTermination): boolean {
  return termination.status !== 'incomplete'
}

/** The Production bounds as a termination records them: `maxPlanSteps` only. */
export function plannerRunLimits(options: PlannerOptions): PlannerOptions {
  return { maxPlanSteps: options.maxPlanSteps }
}

function countCompletedTargets(
  bestState: PlannerSearchState | null,
  planningTargetIds: readonly TargetWeaponId[],
  checkpointRequirements: PlannerCheckpointRequirements,
  unconfirmedTargetIds: ReadonlySet<TargetWeaponId>,
): number {
  if (bestState === null) return 0
  // The same authority the run uses: a Target with a required checkpoint
  // Entry counts only once that Entry itself was secured.
  return planningTargetIds.filter((targetId) =>
    !unconfirmedTargetIds.has(targetId) &&
    isPlannerTargetComplete(bestState, targetId, checkpointRequirements),
  ).length
}

/** What every full Planner run termination is derived from, whatever its bounds. */
export interface PlannerTerminationStateInput {
  /**
   * The planning Targets of the run (`PlannerInitialContext.planningTargetIds`):
   * only Targets with a valid BuildListEntry, never every active Target.
   */
  planningTargetIds: readonly TargetWeaponId[]
  checkpointRequirements: PlannerCheckpointRequirements
  bestState: PlannerSearchState | null
  expandedStates: number
  cancelled: boolean
  /**
   * Planning Targets whose `confirm_owned_ideal` a bound withheld (the
   * deterministic scheduler's `maxPlanSteps`, Issue #103 Phase D-1). Such a
   * Target already holds its Ideal but its Step is missing from the trace, so
   * it is never counted complete. Absent means none.
   */
  unconfirmedTargetIds?: ReadonlySet<TargetWeaponId>
}

/**
 * Derives the typed termination of one full Planner run from the bounds it
 * reached.
 *
 * Status precedence, in this order:
 *
 * - `cancelled`  the user stopped the run; nothing about the result is a
 *   statement on feasibility, and the ordinary Planner already returns a safe
 *   `plan: null` for it.
 * - `completed`  every planning Target is complete: Ideal, and its required
 *   checkpoint Entry secured (PLANNER_SPEC 7.5.6). A bound that was touched
 *   on the way stays in `reachedLimits` as a diagnostic and changes nothing.
 * - `incomplete` a bound truncated the run before that, so the best state is a
 *   run artifact, not an answer about the input.
 * - `exhausted`  the run ended on its own without completing every Target.
 *   That is the ordinary "this input yields no better Plan" outcome, not a
 *   truncation, and it keeps its existing meaning and behaviour.
 */
export function createPlannerTermination<TLimitKind extends string, TLimits>(
  input: PlannerTerminationStateInput & {
    limits: TLimits
    reachedLimits: readonly TLimitKind[]
  },
): PlannerTerminationOf<TLimitKind, TLimits> {
  const reachedLimits = [...input.reachedLimits]
  const totalTargetCount = input.planningTargetIds.length
  const completedTargetCount = countCompletedTargets(
    input.bestState,
    input.planningTargetIds,
    input.checkpointRequirements,
    input.unconfirmedTargetIds ?? new Set(),
  )
  const isComplete =
    input.bestState !== null &&
    totalTargetCount > 0 &&
    completedTargetCount === totalTargetCount
  const status = input.cancelled
    ? 'cancelled'
    : isComplete
      ? 'completed'
      : reachedLimits.length > 0
        ? 'incomplete'
        : 'exhausted'
  return {
    status,
    reachedLimits,
    limits: input.limits,
    expandedStates: input.expandedStates,
    completedTargetCount,
    totalTargetCount,
  }
}

export interface PlannerRunTerminationInput extends PlannerTerminationStateInput {
  options: PlannerOptions
  reachedStepLimit: boolean
}

/**
 * The Production full Planner run termination. The deterministic scheduler's
 * one bound is `maxPlanSteps`, so `max_plan_steps` is the only limit kind it
 * can report (Issue #103 Phase D-1 / D-2a).
 */
export function createPlannerRunTermination(
  input: PlannerRunTerminationInput,
): PlannerRunTermination {
  const reachedLimits: PlannerRunLimitKind[] = input.reachedStepLimit ? ['max_plan_steps'] : []
  return createPlannerTermination({
    ...input,
    limits: plannerRunLimits(input.options),
    reachedLimits,
  })
}

/**
 * The termination of a Planner run that never started, so no bound was
 * touched. The reason it stopped - an invalid input, or an orchestration
 * bound - is reported by its own warning, never here. `planningTargetIds` is
 * the same planning Target authority a started run counts
 * (`preparePlannerInitialContext()`), never every active Target. `limits` is
 * the bounds as the caller's own termination shape records them.
 */
export function createUnsearchedPlannerTermination<TLimits>(
  limits: TLimits,
  planningTargetIds: readonly TargetWeaponId[],
): PlannerTerminationOf<never, TLimits> {
  return {
    status: 'exhausted',
    reachedLimits: [],
    limits,
    expandedStates: 0,
    completedTargetCount: 0,
    totalTargetCount: planningTargetIds.length,
  }
}
