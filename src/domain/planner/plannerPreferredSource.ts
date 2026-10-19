import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import type { PlannerSearchState } from './plannerTypes'

/**
 * Whether this Entry's Route starts from the weapon its Target prefers.
 *
 * `route.sourceOwnedWeaponId` is the whole test: an owned-Normal conversion and
 * every existing-Gogma amendment carry a concrete source ID, while a new-Normal
 * route has `null` and is therefore never preferred - there is no owned weapon
 * for it to have started from (`docs/PLANNER_SPEC.md` 7.4).
 */
export function isPreferredSourceEntry(
  entry: BuildListEntry,
  target: TargetWeapon | undefined,
): boolean {
  const preferredId = target?.preferredOwnedWeaponId ?? null
  if (preferredId === null) return false
  return entry.candidateSnapshot.route.sourceOwnedWeaponId === preferredId
}

/**
 * The Entries whose Route starts from their Target's preferred owned weapon.
 *
 * Computed once per Planner run from static input, so the Beam Search only has
 * to test set membership while expanding.
 */
export function collectPreferredSourceEntryIds(
  entries: readonly BuildListEntry[],
  targetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>,
): ReadonlySet<BuildListEntryId> {
  return new Set(
    entries
      .filter((entry) =>
        isPreferredSourceEntry(entry, targetsById.get(entry.targetWeaponId)),
      )
      .map(({ id }) => id),
  )
}

/**
 * Applies one executed action to the branch's preferred-source preference.
 *
 * Plan preference only, never correctness: a branch that progresses no
 * preferred Route is still a fully executable Plan, so this must never prune,
 * block, or reject an expansion, and it must never be folded into
 * `evaluationScore` as a weight - a Route one operation further away must not
 * win because it starts from the preferred weapon (`docs/PLANNER_SPEC.md` 7.4).
 *
 * Like `weaponSwitchCount` this is incremental runtime state: recomputing it by
 * scanning the whole trace on every state comparison would make each comparison
 * O(trace length) in a search that compares thousands of states.
 */
export function advancePlannerPreferredSourceMetric(
  state: Pick<PlannerSearchState, 'preferredSourceProgressCount'>,
  progressedEntryIds: readonly BuildListEntryId[],
  preferredSourceEntryIds: ReadonlySet<BuildListEntryId>,
): void {
  state.preferredSourceProgressCount += progressedEntryIds.filter((id) =>
    preferredSourceEntryIds.has(id),
  ).length
}
