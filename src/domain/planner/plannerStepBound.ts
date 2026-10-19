/**
 * The shared rounding rule of a derived Planner `maxPlanSteps` (`docs/PLANNER_SPEC.md` 7.2.1 / 17.13).
 *
 * A pure Domain helper: it reads no UI setting, AppSettings, Worker request or persisted value, and it decides no
 * bound on its own. Its callers derive a bound and round it here - the Application's ordinary Planner
 * recommendation and conflict resolution recalculation (`src/services/planner/plannerRuntimeOptions.ts`, which
 * re-exports these two names unchanged), and the Build List global optimization's final verification bound. Moved
 * from the Service layer (Issue #260 PR-2) with the same names, value and exception, so that a Domain caller never
 * imports a Service.
 */

/** The granularity every derived `maxPlanSteps` is rounded up to. */
export const PLANNER_MAX_PLAN_STEPS_INCREMENT = 500

/** Rounds a non-negative Step count up to the next multiple of 500. */
export function roundUpPlannerMaxPlanSteps(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`A Planner Step count must be a non-negative finite number: ${value}`)
  }
  return (
    Math.ceil(value / PLANNER_MAX_PLAN_STEPS_INCREMENT) *
    PLANNER_MAX_PLAN_STEPS_INCREMENT
  )
}
