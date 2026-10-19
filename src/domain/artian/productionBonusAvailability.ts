import {
  getBonusDefinitionsForWeaponAndScope,
  MasterDataDomainError,
} from '../master/masterSelectors'
import type {
  ArtianBonusScope,
  BonusRankMaster,
  MasterDataRoot,
  WeaponBonusDefinition,
} from '../master/masterTypes'
import type {
  BonusTypeId,
  ElementId,
  RestorationBonus,
  WeaponTypeId,
} from '../models/publicTypes'
import {
  ProductionGogmaResetAvailabilityError,
  productionGogmaResetCandidatesForWeaponAndElement,
} from '../rng/production/gameGogmaBonuses'
import {
  gameVerifiedNormalCandidatesForWeaponAndElement,
  UnsupportedGameVerifiedNormalPredictionError,
} from '../rng/production/gameNormalBonuses'
import { restorationBonusFromReferenceNormalId } from '../rng/production/referenceNormalBonuses'

/*
 * Production bonus availability for entity UI and validation
 * (`docs/RNG_SPEC.md` 6.1.1 / 6.3.1, `docs/MASTER_DATA.md` 15).
 *
 * A restoration bonus is selectable for a weapon type + element + scope only
 * when both of these hold:
 *
 * - Master declares it for that weapon type and scope
 *   (`getBonusDefinitionsForWeaponAndScope()`, no element exclusion)
 * - the Production lottery can draw it for that weapon type and element
 *   - `normal_artian`: the Production Normal pool
 *     (`gameVerifiedNormalCandidatesForWeaponAndElement()`), mapped to semantic
 *     bonuses through the reference semantic mapping
 *   - `gogma_artian`: the Production Gogma Reset candidates
 *     (`productionGogmaResetCandidatesForWeaponAndElement()`)
 *
 * The Bow Table A / B split, the Switch Axe single pool, and the Melee / Bowgun
 * pools stay decided in the Production RNG layer alone; nothing here repeats a
 * weapon-specific table. `ElementMaster.allowsElementBonus` and
 * `getBonusDefinitionsForWeapon()` are not consulted: they keep their
 * Master-only meaning.
 *
 * Dependency direction: this module reads `domain/master` and
 * `domain/rng/production`; `domain/master` never reads this module or the
 * Production RNG layer.
 *
 * Nothing falls back to the Master-only availability. A weapon type or element
 * the Production authority cannot classify, or an input whose intersection is
 * empty, raises `ProductionBonusAvailabilityError`.
 */

export type ProductionBonusAvailabilityMasterSubset = Pick<
  MasterDataRoot,
  'weaponTypes' | 'elements' | 'bonusRanks' | 'weaponBonusDefinitions'
>

export type ProductionBonusAvailabilityErrorReason =
  /** The Production lottery authority has no classification for this input. */
  | 'production_authority_unavailable'
  /** Master and the Production lottery share no enabled bonus for this input. */
  | 'no_available_definitions'

export class ProductionBonusAvailabilityError extends Error {
  readonly reason: ProductionBonusAvailabilityErrorReason
  readonly weaponTypeId: WeaponTypeId
  readonly elementId: ElementId
  readonly scope: ArtianBonusScope

  constructor(
    reason: ProductionBonusAvailabilityErrorReason,
    weaponTypeId: WeaponTypeId,
    elementId: ElementId,
    scope: ArtianBonusScope,
  ) {
    super(`Production bonus availability is unavailable (${reason}) for ${weaponTypeId} / ${elementId} / ${scope}`)
    this.name = 'ProductionBonusAvailabilityError'
    this.reason = reason
    this.weaponTypeId = weaponTypeId
    this.elementId = elementId
    this.scope = scope
  }
}

function semanticBonusKey(bonus: RestorationBonus): string {
  return `${bonus.bonusTypeId}\u0000${bonus.bonusRankId}`
}

function productionNormalLotteryBonuses(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): RestorationBonus[] {
  return gameVerifiedNormalCandidatesForWeaponAndElement(weaponTypeId, elementId).map((candidate) => {
    const bonus = restorationBonusFromReferenceNormalId(weaponTypeId, candidate.referenceId)
    if (bonus === null) {
      // A Production pool candidate with no Domain representation is an
      // authority inconsistency; never drop it silently.
      throw new RangeError(`Production Normal candidate ${candidate.referenceId} has no semantic bonus for ${weaponTypeId}`)
    }
    return bonus
  })
}

function productionGogmaLotteryBonuses(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): RestorationBonus[] {
  return productionGogmaResetCandidatesForWeaponAndElement(weaponTypeId, elementId)
    .map((candidate) => ({ ...candidate.bonus }))
}

/**
 * The semantic bonuses the Production lottery can draw for one weapon type,
 * element, and scope, in the Production authority's own candidate order.
 *
 * Every failure of the Production authority for this input - an unknown
 * weapon type or element, or a weapon type without a Production pool - becomes
 * `ProductionBonusAvailabilityError('production_authority_unavailable')`.
 */
export function productionLotteryBonusesForWeaponAndElement(
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  scope: ArtianBonusScope,
): readonly RestorationBonus[] {
  try {
    return scope === 'normal_artian'
      ? productionNormalLotteryBonuses(weaponTypeId, elementId)
      : productionGogmaLotteryBonuses(weaponTypeId, elementId)
  } catch (error) {
    if (
      error instanceof RangeError ||
      error instanceof UnsupportedGameVerifiedNormalPredictionError ||
      error instanceof ProductionGogmaResetAvailabilityError
    ) {
      throw new ProductionBonusAvailabilityError(
        'production_authority_unavailable',
        weaponTypeId,
        elementId,
        scope,
      )
    }
    throw error
  }
}

/**
 * The enabled Master Bonus Definitions that are also Production-drawable for
 * one weapon type, element, and scope, in Master sort order.
 *
 * An unknown Master weapon type or element raises `MasterDataDomainError`, as
 * `getBonusDefinitionsForWeapon()` does. A definition whose rank is disabled
 * is excluded, as `getRanksForBonusType()` excludes it.
 */
export function getProductionAvailableBonusDefinitions(
  master: ProductionBonusAvailabilityMasterSubset,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  scope: ArtianBonusScope,
): WeaponBonusDefinition[] {
  const masterDefinitions = getBonusDefinitionsForWeaponAndScope(master, weaponTypeId, scope)
  if (!master.elements.some(({ id }) => id === elementId)) {
    throw new MasterDataDomainError('master_id_not_found', 'ElementMaster', elementId)
  }
  const drawable = new Set(
    productionLotteryBonusesForWeaponAndElement(weaponTypeId, elementId, scope).map(semanticBonusKey),
  )
  const enabledRankIds = new Set(
    master.bonusRanks.filter(({ isEnabled }) => isEnabled).map(({ id }) => id),
  )
  const available = masterDefinitions.filter(
    (definition) =>
      enabledRankIds.has(definition.bonusRankId) &&
      drawable.has(semanticBonusKey(definition)),
  )
  if (available.length === 0) {
    throw new ProductionBonusAvailabilityError('no_available_definitions', weaponTypeId, elementId, scope)
  }
  return available
}

/** The distinct available Bonus Type IDs, in Master sort order. */
export function getProductionAvailableBonusTypeIds(
  master: ProductionBonusAvailabilityMasterSubset,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  scope: ArtianBonusScope,
): BonusTypeId[] {
  return [
    ...new Set(
      getProductionAvailableBonusDefinitions(master, weaponTypeId, elementId, scope)
        .map(({ bonusTypeId }) => bonusTypeId),
    ),
  ]
}

/**
 * The available ranks of one Bonus Type, in rank order. A Bonus Type outside
 * the availability has no ranks, so a stored legacy value yields `[]` rather
 * than an error.
 */
export function getProductionAvailableRanksForBonusType(
  master: ProductionBonusAvailabilityMasterSubset,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  bonusTypeId: BonusTypeId,
  scope: ArtianBonusScope,
): BonusRankMaster[] {
  const rankIds = new Set(
    getProductionAvailableBonusDefinitions(master, weaponTypeId, elementId, scope)
      .filter((definition) => definition.bonusTypeId === bonusTypeId)
      .map(({ bonusRankId }) => bonusRankId),
  )
  return master.bonusRanks
    .filter(({ id }) => rankIds.has(id))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
}

/** Whether one semantic bonus is inside the Production availability. */
export function isProductionAvailableBonus(
  master: ProductionBonusAvailabilityMasterSubset,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  scope: ArtianBonusScope,
  bonus: RestorationBonus,
): boolean {
  const key = semanticBonusKey(bonus)
  return getProductionAvailableBonusDefinitions(master, weaponTypeId, elementId, scope)
    .some((definition) => semanticBonusKey(definition) === key)
}
