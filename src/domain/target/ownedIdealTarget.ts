import type {
  OwnedGogmaArtianWeapon,
  OwnedWeapon,
  TargetWeapon,
} from '../models/publicTypes'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'
import { satisfiesIdealTarget } from './targetEvaluator'

/**
 * Whether one owned weapon already satisfies a Target's Ideal condition by its
 * current performance (`docs/SEARCH_SPEC.md` 5.5.5, `docs/UI_FLOW.md` 8.2).
 *
 * The one authority the Target Weapons screen, the Search screen and the
 * direct completion Service share, so no screen re-implements the judgement.
 * Only a Gogma weapon of the Target's weapon type and element qualifies, and
 * the decision is the existing `satisfiesIdealTarget()` over the weapon's five
 * slots, scope and Skills. `status` and `isProtected` are deliberately not
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
    satisfiesIdealTarget(
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
 * Every owned Gogma weapon that already satisfies the Target's Ideal condition,
 * in the stable order above. Several weapons can qualify; none is chosen here -
 * the user picks the one that completes the Target (`docs/UI_FLOW.md` 8.2).
 * It runs no RNG prediction.
 */
export function findOwnedIdealWeaponsForTarget(
  target: TargetWeapon,
  ownedWeapons: readonly OwnedWeapon[],
  master: TargetEvaluationMasterSubset,
): OwnedGogmaArtianWeapon[] {
  return ownedWeapons
    .filter((weapon): weapon is OwnedGogmaArtianWeapon => isOwnedIdealForTarget(target, weapon, master))
    .sort(compareOwnedIdealWeapons)
}
