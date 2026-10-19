import type { ElementId, RestorationBonus, RestorationBonusSet, WeaponTypeId } from '../../models/publicTypes'
import { keepFamilyBonusTypeId, type KeepFamilyMasterSubset } from '../gogmaBonusFamily'
import { gameVerifiedNormalCandidatesForWeaponAndElement } from './gameNormalBonuses'
import {
  REFERENCE_GOGMA_RESET_CANDIDATES,
  type ReferenceGogmaBonus,
  type ReferenceGogmaBonusFamily,
  referenceGogmaBonusFamily,
  referenceGogmaKeepFamilyForBonusType,
} from './referenceGogmaBonuses'
import type { ReferenceNormalLotteryId } from './referenceNormalBonuses'
import { buildReferenceWeightedGogmaPool, type ReferenceWeightedGogmaCandidate } from './weightedDraw'

/**
 * The reference Keep family of one current slot, or null when its bonus type
 * resolves to no reference family.
 *
 * Only the bonus type is read. A Normal-side type is first normalized to its
 * Gogma-side type through the Master mapping (`docs/RNG_SPEC.md` 6.1), so an
 * inherited `normal_artian` scope slot and a `gogma_artian` scope slot of the
 * same family resolve identically. `bonusRankId` is never consulted: Keep
 * preserves the family and rerolls the tier, and whether a rank is a legal
 * persisted value is Master / Domain validation, not Keep RNG.
 */
export function keepCurrentBonusFamily(
  bonus: RestorationBonus,
  master: KeepFamilyMasterSubset,
): ReferenceGogmaBonusFamily | null {
  return referenceGogmaKeepFamilyForBonusType(keepFamilyBonusTypeId(bonus.bonusTypeId, master))
}

/**
 * One current slot rewritten in the reference Keep namespace: its bonus type is
 * the Gogma-side family type, its tier is carried through untouched.
 *
 * The reference predictor reads Gogma-side bonus types only, so the Production
 * adapter performs this semantic normalization before calling it, exactly as it
 * maps Weapon / Element IDs.
 */
export function toReferenceKeepCurrentBonus(
  bonus: RestorationBonus,
  master: KeepFamilyMasterSubset,
): RestorationBonus {
  const bonusTypeId = keepFamilyBonusTypeId(bonus.bonusTypeId, master)
  if (referenceGogmaKeepFamilyForBonusType(bonusTypeId) === null) {
    throw new RangeError(`Unsupported current bonus for Keep prediction: ${bonus.bonusTypeId}`)
  }
  return { bonusTypeId, bonusRankId: bonus.bonusRankId }
}

export function toReferenceKeepCurrentBonuses(
  bonuses: RestorationBonusSet,
  master: KeepFamilyMasterSubset,
): RestorationBonusSet {
  if (!Array.isArray(bonuses) || bonuses.length !== 5) {
    throw new RangeError('Keep current bonuses must contain exactly five slots')
  }
  return [
    toReferenceKeepCurrentBonus(bonuses[0], master),
    toReferenceKeepCurrentBonus(bonuses[1], master),
    toReferenceKeepCurrentBonus(bonuses[2], master),
    toReferenceKeepCurrentBonus(bonuses[3], master),
    toReferenceKeepCurrentBonus(bonuses[4], master),
  ]
}

/*
 * Production Gogma Reset family availability and family limit
 * (docs/RNG_SPEC.md 6.1.1, docs/RNG_REFERENCE_AUDIT.md 14.17).
 *
 * The families a Production Reset may draw are the family set of the
 * Production Normal Artian pool of the same weapon type + element. Only that
 * family set is shared: the Normal seed, Normal Counter, and Normal
 * `maximumOccurrences` (Affinity 3 in particular) never reach Gogma. The Bow
 * Table A / B split, the Switch Axe single pool, and the Melee / Bowgun pools
 * stay decided in `gameNormalBonuses.ts` alone; this module only reads the
 * families of the pool that authority returns.
 *
 * `WeaponBonusDefinition` + `ElementMaster.allowsElementBonus` is not this
 * authority: Bow Poison allows an Element bonus in the Master yet draws none,
 * and Switch Axe `element.none` disallows it yet draws Element.
 *
 * Provenance is layered. Directly game-verified at Base Seed 51231782 on
 * 2026-09-15: Bow Poison drawing no Element (Gogma Counters 55 / 179), Switch
 * Axe `element.none` drawing Element (55), and the Sharpness/Capacity limit of
 * two (Hammer Paralysis 104). Every other weapon type / element condition, and
 * the limit outside Hammer Paralysis, is category-level Production adoption.
 *
 * Both corrections are Production-only. The GARP v0.9.4 reference parity layer
 * (`REFERENCE_GOGMA_RESET_CANDIDATES`, `buildReferenceWeightedGogmaPool`,
 * `predictReferenceGogmaReset`) reproduces the exact-ID repeat penalty only and
 * is never rewritten to match the game. Keep uses neither correction.
 */

/** The Gogma family of each Normal lottery candidate (Normal lottery ID namespace). */
const GOGMA_RESET_FAMILY_BY_NORMAL_LOTTERY_ID: Readonly<Record<ReferenceNormalLotteryId, ReferenceGogmaBonusFamily>> = {
  6: 'attack',
  4: 'element',
  7: 'sharpness_capacity',
  8: 'affinity',
}

/**
 * The one explicit Production family limit inside a single Reset result.
 * Attack / Affinity / Element deliberately have none: Gogma Affinity 5 is
 * game-observed, and Element is capped at 4 (II x2 + EX x2) by the exact-ID
 * repeat penalty alone.
 */
export const PRODUCTION_GOGMA_RESET_SHARPNESS_CAPACITY_FAMILY_LIMIT = 2

/** No fixed reference Reset candidate belongs to the Production family set of this input. */
export class ProductionGogmaResetAvailabilityError extends Error {
  constructor(weaponTypeId: WeaponTypeId, elementId: ElementId) {
    super(`No available Production Gogma Reset candidates for ${weaponTypeId} / ${elementId}`)
    this.name = 'ProductionGogmaResetAvailabilityError'
  }
}

/**
 * The bonus families a Production Gogma Reset may draw for one weapon type +
 * element: the family set of the Production Normal pool of the same input.
 *
 * An unknown weapon type or element raises the reference adapter's
 * `RangeError`; a weapon type without a Production Normal pool raises
 * `UnsupportedGameVerifiedNormalPredictionError`. Nothing is guessed for it.
 */
export function productionGogmaResetFamiliesForWeaponAndElement(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): ReadonlySet<ReferenceGogmaBonusFamily> {
  return new Set(
    gameVerifiedNormalCandidatesForWeaponAndElement(weaponTypeId, elementId)
      .map((candidate) => GOGMA_RESET_FAMILY_BY_NORMAL_LOTTERY_ID[candidate.referenceId]),
  )
}

/**
 * The fixed reference Reset candidate order with every candidate outside the
 * Production family set removed. This is a pre-draw filter only: no reorder,
 * no ID replacement, no retry.
 */
export function productionGogmaResetCandidatesForWeaponAndElement(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): readonly ReferenceGogmaBonus[] {
  const families = productionGogmaResetFamiliesForWeaponAndElement(weaponTypeId, elementId)
  const candidates = REFERENCE_GOGMA_RESET_CANDIDATES.filter((candidate) => families.has(candidate.family))
  if (candidates.length === 0) {
    throw new ProductionGogmaResetAvailabilityError(weaponTypeId, elementId)
  }
  return candidates
}

/**
 * The weighted pool of one Production Reset slot.
 *
 * Once the reference IDs 6 and 10 together fill two slots of this Reset
 * result, both leave the pool. The remaining candidates then receive the
 * unchanged reference exact-ID repeat penalty (non-EX 100 -> 50 -> 0, EX
 * 100 -> 20 -> 0), which `buildReferenceWeightedGogmaPool` alone computes.
 */
export function buildProductionWeightedGogmaResetPool(
  candidates: readonly ReferenceGogmaBonus[],
  selectedReferenceIds: readonly number[],
): readonly ReferenceWeightedGogmaCandidate[] {
  let sharpnessCapacityCount = 0
  for (const selectedId of selectedReferenceIds) {
    if (referenceGogmaBonusFamily(selectedId) === 'sharpness_capacity') sharpnessCapacityCount += 1
  }
  const available = sharpnessCapacityCount >= PRODUCTION_GOGMA_RESET_SHARPNESS_CAPACITY_FAMILY_LIMIT
    ? candidates.filter((candidate) => candidate.family !== 'sharpness_capacity')
    : candidates
  return buildReferenceWeightedGogmaPool(available, selectedReferenceIds)
}
