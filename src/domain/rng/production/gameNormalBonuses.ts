import type { ElementId, WeaponTypeId } from '../../models/publicTypes'
import {
  NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES,
  type NormalArtianLotteryTableClass,
} from '../normalArtianLotteryTable'
import { toReferenceNormalFinalAttribute, toReferenceWeaponType } from './referenceAdapters'
import type { ReferenceNormalCandidate } from './referenceNormalBonuses'

/*
 * Per-candidate limits of the Production rarity-8 Normal Artian pool
 * (docs/RNG_REFERENCE_AUDIT.md 5.3 / 14.13):
 *
 *   Attack (6)              5
 *   Element (4)             4
 *   Sharpness/Capacity (7)  2
 *   Affinity (8)            3
 *
 * Provenance is not uniform. Attack 5 / Element 4 / Sharpness 2 / Affinity 3
 * were game-verified directly on 1293 attribute-present melee forges (Great
 * Sword, Dual Blades, Hammer, Charge Blade; 6465 slots at Base Seed 51231782,
 * 2026-09-14). Capacity 2 on the Bowguns, Element 4 / Affinity 3 on the Bow,
 * Affinity 3 on the Bowguns, and Affinity 3 in the elementless pools were not
 * boundary-observed in that data set: they are adopted as the Production
 * contract from the user-supplied Game8 limit table and from the existing
 * game-observed Bow / LBG / HBG / Long Sword fixtures not contradicting them.
 *
 * They deliberately differ from the pinned reference pools in
 * `referenceNormalBonuses.ts`, which cap Element and Affinity at 5 and are kept
 * unchanged as the reference parity contract.
 */
const GAME_ATTACK: ReferenceNormalCandidate = { referenceId: 6, maximumOccurrences: 5 }
const GAME_ELEMENT: ReferenceNormalCandidate = { referenceId: 4, maximumOccurrences: 4 }
const GAME_SHARPNESS_OR_CAPACITY: ReferenceNormalCandidate = { referenceId: 7, maximumOccurrences: 2 }
const GAME_AFFINITY: ReferenceNormalCandidate = { referenceId: 8, maximumOccurrences: 3 }

/*
 * Bow Table A / Table B (docs/RNG_REFERENCE_AUDIT.md 14.15).
 *
 * The Bow is the one supported weapon type whose pool is not decided by
 * "attribute present or not". Direct game observation at Base Seed 51231782 /
 * Normal Counter 0 showed Blast drawing exactly the Fire result `[6, 6, 8, 4, 4]`
 * while Poison, Paralysis, and Sleep drew exactly the elementless result
 * `[8, 8, 6, 6, 8]`. Provenance of the classification below is layered:
 *
 * - directly game-verified: Fire (Counters 0..2, re-confirmed at 0 / 1),
 *   Blast, Poison, Paralysis, Sleep (Counter 0 each), and none (Counters 0..2)
 * - category-level Production adoption: Water / Thunder / Ice / Dragon on
 *   Table A, from the user-supplied Game8 table classification, the direct
 *   Fire and Blast Table A fixtures, and no evidence contradicting the former
 *   single elemental pool for the five elements
 *
 * Never describe every Bow element as directly game-verified.
 */
const BOW_TABLE_A_ELEMENT_IDS: ReadonlySet<ElementId> = new Set<ElementId>([
  'element.fire',
  'element.water',
  'element.thunder',
  'element.ice',
  'element.dragon',
  'element.blast',
])
const BOW_TABLE_B_ELEMENT_IDS: ReadonlySet<ElementId> = new Set<ElementId>([
  'element.none',
  'element.poison',
  'element.paralysis',
  'element.sleep',
])

/** Bow Table A pool `[6, 4, 8]`: Fire / Water / Thunder / Ice / Dragon / Blast. */
export const GAME_VERIFIED_BOW_TABLE_A_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_ELEMENT,
  GAME_AFFINITY,
]

/** Bow Table B pool `[6, 8]`: none / Poison / Paralysis / Sleep. */
export const GAME_VERIFIED_BOW_TABLE_B_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_AFFINITY,
]

/** Game-verified for both table classes of a rarity-8 Light Bowgun result. */
export const GAME_VERIFIED_LIGHT_BOWGUN_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_SHARPNESS_OR_CAPACITY,
  GAME_AFFINITY,
]

/** Game-verified for both table classes of a rarity-8 Heavy Bowgun result. */
export const GAME_VERIFIED_HEAVY_BOWGUN_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_SHARPNESS_OR_CAPACITY,
  GAME_AFFINITY,
]

/*
 * Melee category (docs/RNG_REFERENCE_AUDIT.md 14.14).
 *
 * The Melee pools below are the Production contract for every melee weapon
 * type except Switch Axe. Their provenance is two-layered and must be kept
 * apart when described:
 *
 * - Directly game-verified: Long Sword (elemental and elementless 15-slot
 *   fixtures, `gameVerifiedNormalVectors.ts`), and the elemental pool on
 *   Great Sword, Dual Blades, Hammer, and Charge Blade (the 1293-forge /
 *   6465-slot re-verification at Base Seed 51231782, 2026-09-14).
 * - Category-level Production adoption: Sword and Shield, Hunting Horn,
 *   Lance, Gunlance, and Insect Glaive have no direct large-sample
 *   observation, and the elementless pool was not observed on Great Sword /
 *   Dual Blades / Hammer / Charge Blade. They are adopted because five
 *   independent melee weapon streams (Long Sword + the four above) follow one
 *   rule, the user-supplied Game8 table treats every melee weapon except
 *   Switch Axe as one common condition, the elementless pool agrees with the
 *   existing Long Sword none fixture, and the PRNG / seed derivation / weapon
 *   type stream are shared by every weapon type with only the weapon type
 *   numeric value separating the seeds.
 *
 * For the Melee category Table A is "any attribute" and Table B is "no
 * attribute"; Poison / Paralysis / Sleep / Blast melee weapons stay on Table A
 * exactly as before. The Bow-specific Table A / B split is never applied to
 * Melee.
 *
 * Switch Axe stays outside the category on purpose: Game8 describes it as a
 * separate table condition (one table whatever the parts configuration), and
 * its direct game observation established a single pool that does not follow
 * the Melee Table A / Table B rule. It has its own contract below; never fold
 * it into this category because the Table A array values happen to coincide.
 */

/** Production Melee Table A pool `[6, 4, 7, 8]` (any attribute); see the category note above. */
export const GAME_VERIFIED_MELEE_ELEMENTAL_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_ELEMENT,
  GAME_SHARPNESS_OR_CAPACITY,
  GAME_AFFINITY,
]

/** Production Melee Table B pool `[6, 7, 8]` (no attribute); see the category note above. */
export const GAME_VERIFIED_MELEE_NONE_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_SHARPNESS_OR_CAPACITY,
  GAME_AFFINITY,
]

/**
 * The explicit allow-list of weapon types that draw from the Melee pools.
 *
 * This is the single place that decides Melee membership. An unknown weapon
 * type is never treated as Melee implicitly, and Switch Axe in particular is
 * deliberately absent because it has its own single-pool contract below:
 * every Production pool query fails closed for a weapon type outside this
 * set, the three ranged cases, and the Switch Axe case.
 */
export const PRODUCTION_MELEE_NORMAL_POOL_WEAPON_TYPE_IDS: ReadonlySet<WeaponTypeId> = new Set<WeaponTypeId>([
  'weapon.great_sword',
  'weapon.sword_and_shield',
  'weapon.dual_blades',
  'weapon.long_sword',
  'weapon.hammer',
  'weapon.hunting_horn',
  'weapon.lance',
  'weapon.gunlance',
  'weapon.charge_blade',
  'weapon.insect_glaive',
])

/** True only for a weapon type on the explicit Melee allow-list above. */
export function isProductionMeleeNormalPoolWeaponType(weaponTypeId: WeaponTypeId): boolean {
  return PRODUCTION_MELEE_NORMAL_POOL_WEAPON_TYPE_IDS.has(weaponTypeId)
}

/*
 * Switch Axe single pool (docs/RNG_REFERENCE_AUDIT.md 14.16, 2026-09-15).
 *
 * Switch Axe is not a Melee-category member. Game8 lists it as a separate
 * table condition ("the same table whatever the parts configuration"), and
 * direct game observation at Base Seed 51231782 confirmed exactly that:
 *
 * - Counter 0 with a Fire configuration drew `[7, 7, 8, 6, 4]`
 * - Counter 0 with every part a different attribute (the Domain's
 *   `element.none`), restored from the same save, drew the identical
 *   `[7, 7, 8, 6, 4]`
 * - Counter 0 Fire followed, without any reload, by Counter 1 all-different
 *   drew `[7, 7, 8, 6, 4]` then `[8, 6, 4, 4, 6]`, matching the existing
 *   PRNG / seed derivation / 10-step block at Counters 0 and 1
 *
 * A Melee Table B pool `[6, 7, 8]` could never draw Element for the
 * elementless configuration, so the observation rules out the Melee split:
 * every configuration draws one pool `[6, 4, 7, 8]`. Provenance is layered
 * and must be stated that way:
 *
 * - directly game-verified: pool membership `[6, 4, 7, 8]`, its independence
 *   from the Fire / all-different configuration, and the Counter 0 -> 1
 *   sequence, all at Base Seed 51231782
 * - category-level Production adoption: the per-candidate limits Attack 5 /
 *   Element 4 / Sharpness 2 / Affinity 3. Those boundaries were not observed
 *   on Switch Axe itself; they are taken from the 2026-09-14 Melee 1293-forge
 *   / 6465-slot verification, the user-supplied Game8 limit table, and the
 *   fact that the Switch Axe observations contradict none of them
 *
 * Never write that the Switch Axe limits were game-verified directly, and
 * never write that Switch Axe has two game tables: both
 * `NormalArtianLotteryTableClass` values map onto this one pool (see
 * `gameVerifiedNormalCandidatesForWeaponAndTableClass()`).
 */

/** Switch Axe single pool `[6, 4, 7, 8]`, drawn by every table class; see the note above. */
export const GAME_VERIFIED_SWITCH_AXE_NORMAL_CANDIDATES: readonly ReferenceNormalCandidate[] = [
  GAME_ATTACK,
  GAME_ELEMENT,
  GAME_SHARPNESS_OR_CAPACITY,
  GAME_AFFINITY,
]

/** Game verification has not established a Normal pool for this input. */
export class UnsupportedGameVerifiedNormalPredictionError extends Error {
  constructor(weaponTypeId: WeaponTypeId, condition: ElementId | NormalArtianLotteryTableClass) {
    super(`Game-verified Normal prediction is unsupported for ${weaponTypeId} / ${condition}`)
    this.name = 'UnsupportedGameVerifiedNormalPredictionError'
  }
}

function isProductionNormalPoolWeaponType(weaponTypeId: WeaponTypeId): boolean {
  return (
    weaponTypeId === 'weapon.bow' ||
    weaponTypeId === 'weapon.light_bowgun' ||
    weaponTypeId === 'weapon.heavy_bowgun' ||
    weaponTypeId === 'weapon.switch_axe' ||
    isProductionMeleeNormalPoolWeaponType(weaponTypeId)
  )
}

/** Every element the Normal final-attribute adapter knows, in adapter order. */
const NORMAL_FINAL_ATTRIBUTE_ELEMENT_IDS: readonly ElementId[] = [
  'element.none',
  'element.fire',
  'element.water',
  'element.thunder',
  'element.ice',
  'element.dragon',
  'element.poison',
  'element.paralysis',
  'element.sleep',
  'element.blast',
]

/**
 * Classifies one concrete element of one supported weapon type into the
 * Production lottery table it draws from (`docs/RNG_SPEC.md` 6.3.1).
 *
 * - Bow: the explicit Table A / Table B element sets above
 * - Melee category: Table B for `element.none`, Table A for any attribute
 * - Light / Heavy Bowgun: the same rule as Melee; both tables share one pool
 * - Switch Axe: the same two-valued rule, purely as the Identification / UI
 *   observation adapter; both classes draw the one Switch Axe pool, because
 *   the game uses a single table for every configuration
 *
 * An unknown weapon type raises the adapter's `RangeError`; an unknown element
 * raises the Normal final-attribute adapter's `RangeError`; a known weapon
 * type without a Production pool raises
 * `UnsupportedGameVerifiedNormalPredictionError` (no current weapon type;
 * kept as the fail-closed defence). The element never enters the Normal seed.
 */
export function normalArtianLotteryTableClassForWeaponAndElement(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): NormalArtianLotteryTableClass {
  toReferenceWeaponType(weaponTypeId)
  const finalAttribute = toReferenceNormalFinalAttribute(elementId)
  if (!isProductionNormalPoolWeaponType(weaponTypeId)) {
    throw new UnsupportedGameVerifiedNormalPredictionError(weaponTypeId, elementId)
  }
  if (weaponTypeId === 'weapon.bow') {
    if (BOW_TABLE_A_ELEMENT_IDS.has(elementId)) return 'table_a'
    if (BOW_TABLE_B_ELEMENT_IDS.has(elementId)) return 'table_b'
    // The adapter knows the element but the Bow classification does not: fail
    // closed rather than guess a table for it.
    throw new UnsupportedGameVerifiedNormalPredictionError(weaponTypeId, elementId)
  }
  return finalAttribute === 1 ? 'table_b' : 'table_a'
}

/**
 * The element IDs of one table class for one supported weapon type, in the
 * reference final-attribute order. This is the same classification
 * `normalArtianLotteryTableClassForWeaponAndElement()` applies, exposed as a
 * list so presentation code can describe a table by its elements without
 * holding a table of its own. It never adds an element the adapter does not
 * know and fails closed for an unsupported weapon type.
 */
export function normalArtianLotteryTableClassElementIds(
  weaponTypeId: WeaponTypeId,
  tableClass: NormalArtianLotteryTableClass,
): readonly ElementId[] {
  return NORMAL_FINAL_ATTRIBUTE_ELEMENT_IDS.filter(
    (elementId) => normalArtianLotteryTableClassForWeaponAndElement(weaponTypeId, elementId) === tableClass,
  )
}

/**
 * The Production candidate pool one table class of one supported weapon type
 * draws from. This is the pool authority for both Production prediction and
 * Counter Identification; nothing falls back to the reference pools.
 */
export function gameVerifiedNormalCandidatesForWeaponAndTableClass(
  weaponTypeId: WeaponTypeId,
  tableClass: NormalArtianLotteryTableClass,
): readonly ReferenceNormalCandidate[] {
  toReferenceWeaponType(weaponTypeId)
  if (!NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES.includes(tableClass)) {
    throw new RangeError(`Unsupported Normal Artian lottery table class: ${String(tableClass)}`)
  }
  switch (weaponTypeId) {
    case 'weapon.bow':
      return tableClass === 'table_a'
        ? GAME_VERIFIED_BOW_TABLE_A_NORMAL_CANDIDATES
        : GAME_VERIFIED_BOW_TABLE_B_NORMAL_CANDIDATES
    case 'weapon.light_bowgun':
      return GAME_VERIFIED_LIGHT_BOWGUN_NORMAL_CANDIDATES
    case 'weapon.heavy_bowgun':
      return GAME_VERIFIED_HEAVY_BOWGUN_NORMAL_CANDIDATES
    case 'weapon.switch_axe':
      // One game table for every configuration: both Identification table
      // classes read the same Switch Axe pool, exactly like the Bowguns.
      return GAME_VERIFIED_SWITCH_AXE_NORMAL_CANDIDATES
    default:
      if (isProductionMeleeNormalPoolWeaponType(weaponTypeId)) {
        return tableClass === 'table_a'
          ? GAME_VERIFIED_MELEE_ELEMENTAL_NORMAL_CANDIDATES
          : GAME_VERIFIED_MELEE_NONE_NORMAL_CANDIDATES
      }
      throw new UnsupportedGameVerifiedNormalPredictionError(weaponTypeId, tableClass)
  }
}

/**
 * Returns candidates only for an explicitly supported Production Normal pool,
 * by classifying the exact element into its table class and then selecting
 * that table's pool. Callers needing a reference-only result must use
 * predictReferenceNormalRaw.
 */
export function gameVerifiedNormalCandidatesForWeaponAndElement(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): readonly ReferenceNormalCandidate[] {
  return gameVerifiedNormalCandidatesForWeaponAndTableClass(
    weaponTypeId,
    normalArtianLotteryTableClassForWeaponAndElement(weaponTypeId, elementId),
  )
}
