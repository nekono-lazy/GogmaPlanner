import type {
  NormalArtianCounter,
  OwnedGogmaArtianWeapon,
  OwnedNormalArtianWeapon,
  OwnedWeapon,
  TargetWeapon,
} from '../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../models/publicTypes'

/**
 * Route-base availability selectors shared by ordinary Candidate Search
 * (SEARCH_SPEC 6.1 / 6.2 / 6.3-6.6) and the Planner-driven constrained
 * enumerator (5.6.7).
 *
 * Constrained enumeration widens the route policy to every currently legal
 * Route, so it must decide legality with the same authority the ordinary Search
 * uses rather than with a second, B8-only implementation. Each selector returns
 * a stably sorted list so the enumeration order never depends on the stored
 * order of the input arrays.
 */

/** v1 searches only rarity-8 Normal Artian counters with a confirmed value. */
export function selectSearchableNormalCounters(
  target: TargetWeapon,
  normalCounters: readonly NormalArtianCounter[],
): NormalArtianCounter[] {
  return normalCounters
    .filter(
      (counter) =>
        counter.weaponTypeId === target.weaponTypeId &&
        counter.rarity === V1_NORMAL_ARTIAN_RARITY &&
        counter.isConfirmed &&
        counter.counter !== null,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** Rarity-8 owned Normal Artian weapons compatible with the Target. */
export function selectCompatibleOwnedNormalArtianWeapons(
  target: TargetWeapon,
  ownedWeapons: readonly OwnedWeapon[],
): OwnedNormalArtianWeapon[] {
  return ownedWeapons
    .filter(
      (weapon): weapon is OwnedNormalArtianWeapon =>
        weapon.kind === 'normal' &&
        weapon.rarity === V1_NORMAL_ARTIAN_RARITY &&
        weapon.weaponTypeId === target.weaponTypeId &&
        weapon.elementId === target.elementId,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Conversion consumes its source, so a protected owned Normal Artian weapon is
 * never an automatic conversion source (AGENTS.md Owned Weapon Rules).
 */
export function selectConvertibleOwnedNormalArtianWeapons(
  target: TargetWeapon,
  ownedWeapons: readonly OwnedWeapon[],
): OwnedNormalArtianWeapon[] {
  return selectCompatibleOwnedNormalArtianWeapons(target, ownedWeapons).filter(
    (weapon) => !weapon.isProtected,
  )
}

/** Owned Gogma Artian weapons compatible with the Target, protected included. */
export function selectCompatibleOwnedGogmaWeapons(
  target: TargetWeapon,
  ownedWeapons: readonly OwnedWeapon[],
): OwnedGogmaArtianWeapon[] {
  return ownedWeapons
    .filter(
      (weapon): weapon is OwnedGogmaArtianWeapon =>
        weapon.kind === 'gogma' &&
        weapon.weaponTypeId === target.weaponTypeId &&
        weapon.elementId === target.elementId,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
}
