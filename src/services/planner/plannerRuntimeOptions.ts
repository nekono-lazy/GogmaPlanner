import type { BuildListEntry, ProductionPlan } from '../../domain/models/publicTypes'
import { defaultPlannerOptions, type PlannerOptions } from '../../domain/planner'
import { roundUpPlannerMaxPlanSteps } from '../../domain/planner/plannerStepBound'

/**
 * Runtime `PlannerOptions` derivation for the Application callers
 * (`docs/PLANNER_SPEC.md` 7.2.1, `docs/UI_FLOW.md` 10.0 / 11.1, Issue #130).
 *
 * `PlannerOptions` stays runtime-only: nothing here is persisted, and none of
 * it enters a ProductionPlan, a PlanningInputSnapshot, AppSettings, Export /
 * Import or the CalculationContext. `defaultPlannerOptions` stays the Domain /
 * Application fallback default; these helpers only decide which runtime bound
 * a caller writes into `PlannerInput.options`. No Worker Client, Worker or
 * Domain module applies them on its own.
 */

/**
 * The 500 rounding rule lives in the shared Domain helper (`src/domain/planner/plannerStepBound.ts`, Issue #260 PR-2)
 * so that a Domain caller never imports this Service; these names are re-exported unchanged (same value, same
 * `RangeError`) for the existing Application callers.
 */
export { PLANNER_MAX_PLAN_STEPS_INCREMENT, roundUpPlannerMaxPlanSteps } from '../../domain/planner/plannerStepBound'

/**
 * The headroom a conflict resolution recalculation adds on top of the current
 * Plan's rounded Step count: fixing a conflict can make the Plan somewhat
 * longer than the one it replaces, but never unbounded.
 */
export const CONFLICT_RESOLUTION_MAX_PLAN_STEPS_MARGIN = 500

/**
 * The Planner actions a Candidate needs besides its Route operations.
 *
 * `candidateSnapshot.estimatedOperationCount` counts the Route's operation
 * units only, while the Production scheduler also spends one
 * `maxPlanSteps` action (`canApplyAction()` / `actionApplied()`) on the
 * internal `reserve_candidate` that secures the Candidate once its Route is
 * done. This is that real action, not a safety margin: a 1000-operation
 * Candidate needs 1001 Planner actions to complete on its own.
 */
export const CANDIDATE_RESERVE_PLANNER_ACTION_COUNT = 1

/**
 * The Build List detail settings' recommended `maxPlanSteps`:
 * `max(1000, ceilTo500(max estimatedOperationCount + 1))` over every Entry the
 * Build List holds, where the `+ 1` is the Candidate's `reserve_candidate`
 * action (`CANDIDATE_RESERVE_PLANNER_ACTION_COUNT`), so the recommendation
 * always lets the largest Candidate complete on its own. Stale Entries and
 * legacy duplicates are included, since the value only sizes a safety bound
 * and decides nothing about which Entry the Planner accepts. An empty Build
 * List recommends 1000.
 */
export function recommendedBuildListMaxPlanSteps(
  entries: readonly Pick<BuildListEntry, 'candidateSnapshot'>[],
): number {
  if (entries.length === 0) return defaultPlannerOptions.maxPlanSteps
  const maxCandidatePlannerActions = entries.reduce(
    (max, entry) =>
      Math.max(
        max,
        entry.candidateSnapshot.estimatedOperationCount +
          CANDIDATE_RESERVE_PLANNER_ACTION_COUNT,
      ),
    0,
  )
  return Math.max(
    defaultPlannerOptions.maxPlanSteps,
    roundUpPlannerMaxPlanSteps(maxCandidatePlannerActions),
  )
}

/**
 * The `maxPlanSteps` a conflict resolution recalculation runs with:
 * `max(1000, ceilTo500(plan.steps.length) + 500)` over the Plan the page is
 * showing. It never reads the Build List page's temporary input, so each
 * saved Draft sizes its own next resolution.
 */
export function conflictResolutionMaxPlanSteps(
  plan: Pick<ProductionPlan, 'steps'>,
): number {
  return Math.max(
    defaultPlannerOptions.maxPlanSteps,
    roundUpPlannerMaxPlanSteps(plan.steps.length) +
      CONFLICT_RESOLUTION_MAX_PLAN_STEPS_MARGIN,
  )
}

/** The whole Production `PlannerOptions` of a conflict resolution recalculation. */
export function conflictResolutionPlannerOptions(
  plan: Pick<ProductionPlan, 'steps'>,
): PlannerOptions {
  return { maxPlanSteps: conflictResolutionMaxPlanSteps(plan) }
}
