import type { BuildListEntry, TargetWeaponId } from '../models/publicTypes'
import type { PlannerCheckpointRequirements } from './plannerCheckpoints'
import type { PlannerSearchState } from './plannerTypes'

/**
 * The single Planner authority for whether a BuildListEntry can still improve a
 * Target in the given state. The initial conflict preparation, the dynamic
 * Beam Search expansion, conflict detection, scoring, and completion must never
 * diverge here, so all of them use this predicate.
 *
 * A Target with a required checkpoint Entry (`docs/PLANNER_SPEC.md` 7.5.6) is
 * judged by that Entry alone: it stays relevant until it is secured itself,
 * even after another weapon or another Target's Entry made the Target Ideal,
 * and no other Entry of that Target is ever relevant. The selection is a hard
 * constraint, never a score, so nothing here compares Routes.
 */
export function entryIsRelevantForState(
  state: PlannerSearchState,
  entry: BuildListEntry,
  requirements: PlannerCheckpointRequirements,
): boolean {
  const required = requirements.requiredEntryIdByTargetId.get(entry.targetWeaponId)
  if (required !== undefined) {
    if (required !== entry.id) return false
    return !state.selectedBuildListEntryIds.includes(entry.id)
  }
  // Every Candidate is a canonical Ideal Candidate, so an Entry stays relevant
  // until its Target actually holds an Ideal weapon. A Target that only holds a
  // Practical weapon still needs its Ideal Route.
  return Boolean(state.targetSatisfaction[entry.targetWeaponId]?.hasIdeal === false)
}

/**
 * Whether one planning Target is finished in this state.
 *
 * `hasIdeal` alone is not enough: a Target with a required checkpoint Entry is
 * finished only once that Entry was secured, which the Beam Search allows only
 * after every selected checkpoint was really reached (7.5.3).
 */
export function isPlannerTargetComplete(
  state: PlannerSearchState,
  targetId: TargetWeaponId,
  requirements: PlannerCheckpointRequirements,
): boolean {
  if (state.targetSatisfaction[targetId]?.hasIdeal !== true) return false
  const required = requirements.requiredEntryIdByTargetId.get(targetId)
  return required === undefined || state.selectedBuildListEntryIds.includes(required)
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
  requirements: PlannerCheckpointRequirements,
): boolean {
  return (
    planningTargetIds.length > 0 &&
    planningTargetIds.every((targetId) =>
      isPlannerTargetComplete(state, targetId, requirements),
    )
  )
}
