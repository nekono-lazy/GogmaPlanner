import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import type { TargetWeapon } from '../models/publicTypes'
import type { ValidatedBuildListEntry } from './plannerTypes'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The planning Targets of one Planner run (`docs/PLANNER_SPEC.md` 4 / 7.2.1):
 * the unique planning-eligible Targets that at least one *valid*
 * BuildListEntry of this run belongs to, in stable Target ID order.
 *
 * The Build List is the user's Planner input (`docs/REQUIREMENTS.md` 18 / 19),
 * so an active Target with no valid Entry is not a goal of this run: it is not
 * counted for completion, termination, scoring or conflict detection. The set
 * is derived from `validatePlannerInput().validBuildListEntries`, never from
 * the raw `PlannerInput.buildListEntries`, so an Entry excluded as stale,
 * completed, disabled or unsupported creates no planning Target, and zero valid
 * Entries means zero planning Targets - never every active Target.
 *
 * `PlannerInput.targetWeapons` itself stays the whole planning-input Target
 * collection (validation, `PlanningInputSnapshot.targetWeaponsHash`); this is
 * only the goal set of the run. The planning-eligibility filter is a
 * fail-closed defence: validation already excludes an Entry of a missing,
 * disabled or completed Target.
 */
export function derivePlannerPlanningTargets(
  targetWeapons: readonly TargetWeapon[],
  validEntries: readonly ValidatedBuildListEntry[],
): TargetWeapon[] {
  const entryTargetIds = new Set(
    validEntries.map(({ entry }) => entry.targetWeaponId),
  )
  return targetWeapons
    .filter(
      (target) =>
        entryTargetIds.has(target.id) && isTargetWeaponPlanningEligible(target),
    )
    .sort((left, right) => compareStableStrings(left.id, right.id))
}
