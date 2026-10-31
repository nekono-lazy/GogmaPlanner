import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import type { TargetEvaluationMasterSubset } from '../target'
import { isCompletionAssignedElsewhere, satisfiesCompletionTarget } from '../target'
import type { OwnedWeapon, OwnedWeaponId, TargetWeapon, TargetWeaponId } from '../models/publicTypes'
import type { TargetSatisfaction } from './plannerTypes'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Derives the *performance* satisfaction of the given planning-eligible
 * Targets from the Gogma inventory, never from weapon status.
 *
 * The one judgement is the completion condition (`docs/PLANNER_SPEC.md` 20.2 /
 * 20.3): a weapon satisfying any Variant at or above its minimum ranks, with
 * the completion Skills, is Ideal. The Practical tier of calculation schema
 * 11..18 (`hasPractical`) equalled `hasIdeal` once the compromise conditions
 * were gone and was removed (`docs/PLANNER_SPEC.md` 20.10 stage 2).
 *
 * A weapon another Target was completed with (`completionAssignments`, from
 * `collectCompletionAssignedOwnedWeaponIds()` over the input Targets; Issue
 * #334, `docs/PLANNER_SPEC.md` 21.4) never satisfies a planning Target,
 * whatever it performs: it is that Target's completion, not this one's.
 *
 * Since Issue #334 PR-3 (`docs/PLANNER_SPEC.md` 21.2 / 21.5) performance
 * satisfaction is not the Planner's completion of a Target: a planning Target
 * is complete in a run only when its own BuildListEntry secured a weapon
 * (`PlannerTargetSatisfaction.completedInRun`), so no Planner calculation
 * reads this derivation any more. It stays the pure performance authority the
 * Global Assignment Research diagnostics (`diagnosePlannerStartIdeal()`) and
 * the Target evaluation tests read.
 */
export function deriveTargetSatisfaction(
  targetWeapons: readonly TargetWeapon[],
  ownedWeapons: readonly OwnedWeapon[],
  master: TargetEvaluationMasterSubset,
  completionAssignments: ReadonlyMap<OwnedWeaponId, TargetWeaponId>,
): TargetSatisfaction[] {
  return targetWeapons.filter(isTargetWeaponPlanningEligible).sort((left, right) => compareStableStrings(left.id, right.id)).map((target) => {
    const idealIds = new Set<string>()
    ownedWeapons.forEach((weapon) => {
      if (weapon.kind !== 'gogma' || weapon.weaponTypeId !== target.weaponTypeId || weapon.elementId !== target.elementId) return
      if (isCompletionAssignedElsewhere(completionAssignments, weapon.id, target.id)) return
      if (satisfiesCompletionTarget(target, weapon.restorationBonuses, weapon.restorationBonusScope, weapon.seriesSkillId, weapon.groupSkillId, master)) {
        idealIds.add(weapon.id)
      }
    })
    const idealOwnedWeaponIds = [...idealIds].sort(compareStableStrings) as TargetSatisfaction['idealOwnedWeaponIds']
    return { targetWeaponId: target.id, hasIdeal: idealOwnedWeaponIds.length > 0, idealOwnedWeaponIds }
  })
}
