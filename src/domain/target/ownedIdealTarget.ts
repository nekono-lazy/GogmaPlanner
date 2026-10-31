import type {
  OwnedGogmaArtianWeapon,
  OwnedWeapon,
  TargetWeapon,
} from '../models/publicTypes'
import { collectCompletionAssignedOwnedWeaponIds, isCompletionAssignedElsewhere } from './completionAssignment'
import { satisfiesCompletionTarget } from './completionCondition'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

/**
 * Whether one owned weapon already satisfies a Target's completion condition by
 * its current performance (`docs/SEARCH_SPEC.md` 5.5.5, `docs/UI_FLOW.md` 8.2).
 *
 * The one authority the Target Weapons screen, the Search screen and the
 * direct completion Service share, so no screen re-implements the judgement.
 * Only a Gogma weapon of the Target's weapon type and element qualifies, and
 * the decision is `satisfiesCompletionTarget()` over the weapon's five slots,
 * scope and Skills: a weapon meeting another Variant, or a higher rank than a
 * minimum, qualifies too. `status` and `isProtected` are deliberately not
 * conditions: an unclassified or a protected weapon that performs as the Ideal
 * is still the Ideal, exactly as Planner satisfaction judges it. The Target's
 * lifecycle is not judged here either; callers ask it for `active` Targets.
 */
export function isOwnedIdealForTarget(
  target: TargetWeapon,
  weapon: OwnedWeapon,
  master: TargetEvaluationMasterSubset,
): weapon is OwnedGogmaArtianWeapon {
  return (
    weapon.kind === 'gogma' &&
    weapon.weaponTypeId === target.weaponTypeId &&
    weapon.elementId === target.elementId &&
    satisfiesCompletionTarget(
      target,
      weapon.restorationBonuses,
      weapon.restorationBonusScope,
      weapon.seriesSkillId,
      weapon.groupSkillId,
      master,
    )
  )
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The stable display order of several owned Ideal weapons: name, then ID, so
 * the list never depends on the order the repository returned them in.
 */
export function compareOwnedIdealWeapons(left: OwnedWeapon, right: OwnedWeapon): number {
  return compareCodePoints(left.name, right.name) || compareCodePoints(left.id, right.id)
}

/**
 * Every owned Gogma weapon that already satisfies the Target's completion
 * condition, in the stable order above. Several weapons can qualify; none is
 * chosen here - the user picks the one that completes the Target
 * (`docs/UI_FLOW.md` 8.2). It runs no RNG prediction. A Target whose completion
 * condition still needs the user's review (`docs/DATA_MODEL.md` 8.6) is offered
 * nothing: its condition is not yet the user's confirmed one.
 *
 * A weapon that is already the completion of another Target (Issue #334,
 * `collectCompletionAssignedOwnedWeaponIds()` over `targetWeapons`,
 * `docs/PLANNER_SPEC.md` 21.4) is never offered, whatever its performance and
 * protection: satisfying a Target's condition is not completing it, and one
 * weapon completes at most one Target.
 */
export function findOwnedIdealWeaponsForTarget(
  target: TargetWeapon,
  ownedWeapons: readonly OwnedWeapon[],
  master: TargetEvaluationMasterSubset,
  targetWeapons: readonly TargetWeapon[],
): OwnedGogmaArtianWeapon[] {
  if (target.completionConditionReview.length > 0) return []
  const assignments = collectCompletionAssignedOwnedWeaponIds(targetWeapons)
  return ownedWeapons
    .filter((weapon): weapon is OwnedGogmaArtianWeapon =>
      !isCompletionAssignedElsewhere(assignments, weapon.id, target.id) &&
      isOwnedIdealForTarget(target, weapon, master))
    .sort(compareOwnedIdealWeapons)
}

/**
 * The other `active` Targets an owned weapon also satisfies by its current
 * performance (cross satisfaction, `docs/UI_FLOW.md` 8.2): completing
 * `target` with it assigns the weapon to `target` alone, so these Targets stay
 * `active` and lose the weapon from their notice. Display only; name order,
 * then ID.
 */
export function findOtherTargetsSatisfiedByOwnedWeapon(
  target: TargetWeapon,
  weapon: OwnedWeapon,
  targetWeapons: readonly TargetWeapon[],
  master: TargetEvaluationMasterSubset,
): TargetWeapon[] {
  return targetWeapons
    .filter((other) =>
      other.id !== target.id &&
      other.lifecycleStatus === 'active' &&
      other.completionConditionReview.length === 0 &&
      isOwnedIdealForTarget(other, weapon, master))
    .sort((left, right) => compareCodePoints(left.name, right.name) || compareCodePoints(left.id, right.id))
}

/**
 * The `completed` Targets whose completion was not recorded
 * (`completedWithOwnedWeaponId === null`, completed before Issue #334) and whose
 * completion condition the weapon satisfies (`docs/UI_FLOW.md` 8.2): the weapon
 * might have been the completion of one of them, which the direct completion
 * dialog may mention without guessing or blocking anything. Display only.
 */
export function findUnrecordedCompletedTargetsSatisfiedByOwnedWeapon(
  weapon: OwnedWeapon,
  targetWeapons: readonly TargetWeapon[],
  master: TargetEvaluationMasterSubset,
): TargetWeapon[] {
  return targetWeapons
    .filter((target) =>
      target.lifecycleStatus === 'completed' &&
      target.completedWithOwnedWeaponId === null &&
      isOwnedIdealForTarget(target, weapon, master))
    .sort((left, right) => compareCodePoints(left.name, right.name) || compareCodePoints(left.id, right.id))
}
