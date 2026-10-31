import type { BuildListEntry, TargetWeaponId } from '../models/publicTypes'
import type { PlannerSearchState } from './plannerTypes'

/**
 * The single Planner authority for whether a BuildListEntry can still complete
 * its Target in the given state. The initial conflict preparation, the dynamic
 * Beam Search expansion, conflict detection, scoring, and completion must never
 * diverge here, so all of them use this predicate.
 *
 * Since Issue #334 PR-3 (`docs/PLANNER_SPEC.md` 21.5) a planning Target is
 * complete in a run only through its own Entry's reserve (or its own
 * zero-operation confirmation), so an Entry stays relevant until *its* Target
 * was completed that way. No other Entry's reserve changes it: a weapon
 * secured for one Target satisfies no other Target, there is no release, and
 * an owned weapon that performs at Planner start completes nothing. Whether a
 * relevant Entry is also committed, and not dropped, is the deterministic
 * scheduler's own runtime record (`plannerRouteCommitment.ts`).
 *
 * Calculation schema 11..18 judged a Target with a selected compromise
 * checkpoint by its required Entry alone; Issue #100 removed the selection
 * (`docs/PLANNER_SPEC.md` 20.7 / 20.10), and a valid Entry carrying one fails
 * the Planner input closed before any state exists. Calculation schema 11..19
 * read the inventory-derived `hasIdeal` here.
 */
export function entryIsRelevantForState(
  state: PlannerSearchState,
  entry: BuildListEntry,
): boolean {
  // An Entry of a Target this run does not track (no planning Target) is never
  // relevant; an Entry of a tracked Target is relevant until that Target was
  // completed in this run.
  return state.targetSatisfaction[entry.targetWeaponId]?.completedInRun === false
}

/** Whether one planning Target is finished in this state: its own Entry secured its weapon. */
export function isPlannerTargetComplete(
  state: PlannerSearchState,
  targetId: TargetWeaponId,
): boolean {
  return state.targetSatisfaction[targetId]?.completedInRun === true
}

/**
 * The single completion authority of the Beam Search and its termination.
 * `planningTargetIds` is the run's planning Target set
 * (`PlannerInitialContext.planningTargetIds`): the Targets of the valid
 * BuildListEntries, never every active Target. An empty set is never complete.
 */
export function isPlannerSearchStateComplete(
  state: PlannerSearchState,
  planningTargetIds: readonly TargetWeaponId[],
): boolean {
  return (
    planningTargetIds.length > 0 &&
    planningTargetIds.every((targetId) => isPlannerTargetComplete(state, targetId))
  )
}
