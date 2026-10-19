import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'

/**
 * The one BuildListEntry ranking the Planner uses when two Routes compete for
 * one resource (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 6.5, the
 * ranking function `R`).
 *
 * `detectPlannerConflicts()` reads it for `PlanConflict.recommendedBuildListEntryId`,
 * and the deterministic scheduler reads the very same comparator for its
 * provisional conflict outcome and its deadlock / stall drop. Sharing one
 * comparator is what keeps the recommended participant and the participant the
 * Draft actually executes the same. It is never a fixed-constraint authority:
 * only `PlannerConflictResolution.selectedBuildListEntryId` is.
 */

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * How many operations further the next Candidate of the same Target is, over
 * `entries`, or 0 when the Target has no later Candidate there.
 */
export function nextPlannerCandidateDistance(
  entry: BuildListEntry,
  entries: readonly BuildListEntry[],
): number {
  const laterDistances = entries
    .filter(
      (candidate) =>
        candidate.id !== entry.id &&
        candidate.targetWeaponId === entry.targetWeaponId &&
        candidate.candidateSnapshot.estimatedOperationCount >=
          entry.candidateSnapshot.estimatedOperationCount,
    )
    .map(
      (candidate) =>
        candidate.candidateSnapshot.estimatedOperationCount -
        entry.candidateSnapshot.estimatedOperationCount,
    )
  return laterDistances.length === 0 ? 0 : Math.min(...laterDistances)
}

/**
 * Negative when `left` ranks before `right`.
 *
 * Target priority, then how far the next Candidate of that Target is (over
 * `allEntries`), then the cheaper Route, then the BuildListEntry ID. Whether a
 * Target already holds a compromise weapon is deliberately not a factor: the
 * Planner has no Practical-first priority (`docs/PLANNER_SPEC.md` 7). No key
 * depends on which other Entries a conflict happens to list.
 */
export function comparePlannerEntryPriority(
  left: BuildListEntry,
  right: BuildListEntry,
  targetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>,
  allEntries: readonly BuildListEntry[],
): number {
  const leftTarget = targetsById.get(left.targetWeaponId)
  const rightTarget = targetsById.get(right.targetWeaponId)
  return (
    (rightTarget?.priority ?? 0) - (leftTarget?.priority ?? 0) ||
    nextPlannerCandidateDistance(right, allEntries) -
      nextPlannerCandidateDistance(left, allEntries) ||
    left.candidateSnapshot.estimatedOperationCount -
      right.candidateSnapshot.estimatedOperationCount ||
    compareStableStrings(left.id, right.id)
  )
}

/** The best-ranked of `entryIds`, or `null` when none of them is known. */
export function recommendPlannerEntry(
  entryIds: readonly BuildListEntryId[],
  entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>,
  targetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>,
  allEntries: readonly BuildListEntry[],
): BuildListEntryId | null {
  const entries = entryIds.flatMap((id) => {
    const entry = entriesById.get(id)
    return entry ? [entry] : []
  })
  entries.sort((left, right) =>
    comparePlannerEntryPriority(left, right, targetsById, allEntries),
  )
  return entries[0]?.id ?? null
}
