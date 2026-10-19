import type { BonusRankId, BonusTypeId, ElementId, WeaponTypeId } from '../models/publicTypes'
import type {
  ArtianBonusScope,
  BonusRankMaster,
  ElementMaster,
  GroupSkillMaster,
  MasterDataRoot,
  MaterialCostMaster,
  MaterialCostOperationType,
  SeriesSkillMaster,
  WeaponBonusDefinition,
  WeaponTypeMaster,
} from './masterTypes'

export type MasterDataDomainErrorCode =
  | 'master_id_not_found'
  | 'master_reference_invalid'
  | 'master_mapping_not_found'

export class MasterDataDomainError extends Error {
  readonly code: MasterDataDomainErrorCode
  readonly masterName: string
  readonly id: string

  constructor(
    code: MasterDataDomainErrorCode,
    masterName: string,
    id: string,
  ) {
    super(`${masterName} id '${id}' is not available.`)
    this.name = 'MasterDataDomainError'
    this.code = code
    this.masterName = masterName
    this.id = id
  }
}

function compareBySortOrderAndId(
  left: { sortOrder: number; id: string },
  right: { sortOrder: number; id: string },
) {
  return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)
}

function compareByRankOrderAndId(
  left: { order: number; id: string },
  right: { order: number; id: string },
) {
  return left.order - right.order || left.id.localeCompare(right.id)
}

function requireById<T extends { id: string }>(
  values: readonly T[],
  id: string,
  masterName: string,
): T {
  const value = values.find((entry) => entry.id === id)
  if (!value) {
    throw new MasterDataDomainError('master_id_not_found', masterName, id)
  }
  return value
}

export type BonusRankMasterLookup = Pick<MasterDataRoot, 'bonusRanks'>

export function getBonusRank(
  master: BonusRankMasterLookup,
  bonusRankId: BonusRankId,
): BonusRankMaster {
  return requireById(master.bonusRanks, bonusRankId, 'BonusRankMaster')
}

export function getEnabledWeaponTypes(
  master: MasterDataRoot,
): WeaponTypeMaster[] {
  return master.weaponTypes
    .filter(({ isEnabled }) => isEnabled)
    .sort(compareBySortOrderAndId)
}

export function getEnabledElements(master: MasterDataRoot): ElementMaster[] {
  return master.elements
    .filter(({ isEnabled }) => isEnabled)
    .sort(compareBySortOrderAndId)
}

export type WeaponBonusDefinitionsMasterSubset = Pick<
  MasterDataRoot,
  'weaponTypes' | 'elements' | 'bonusTypes' | 'weaponBonusDefinitions'
>

export function getBonusDefinitionsForWeapon(
  master: WeaponBonusDefinitionsMasterSubset,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  scope: ArtianBonusScope,
): WeaponBonusDefinition[] {
  requireById(master.weaponTypes, weaponTypeId, 'WeaponTypeMaster')
  const element = requireById(master.elements, elementId, 'ElementMaster')
  const elementBonusTypeIds = new Set(
    master.bonusTypes
      .filter(({ category }) => category === 'element')
      .map(({ id }) => id),
  )
  return master.weaponBonusDefinitions
    .filter(
      (definition) =>
        definition.isEnabled &&
        definition.weaponTypeId === weaponTypeId &&
        definition.scope === scope &&
        (element.allowsElementBonus ||
          !elementBonusTypeIds.has(definition.bonusTypeId)),
    )
    .sort(compareBySortOrderAndId)
}

export type WeaponScopeBonusDefinitionsMasterSubset = Pick<
  MasterDataRoot,
  'weaponTypes' | 'weaponBonusDefinitions'
>

/**
 * The enabled Bonus Definitions Master declares for one weapon type and scope,
 * with no element exclusion at all.
 *
 * This is Master-only data. It deliberately ignores
 * `ElementMaster.allowsElementBonus`, so it never decides on its own which
 * bonuses a weapon may hold; the Production composite availability selector
 * (`src/domain/artian/productionBonusAvailability.ts`) intersects it with the
 * Production lottery authority. It never reads the Production RNG layer.
 */
export function getBonusDefinitionsForWeaponAndScope(
  master: WeaponScopeBonusDefinitionsMasterSubset,
  weaponTypeId: WeaponTypeId,
  scope: ArtianBonusScope,
): WeaponBonusDefinition[] {
  requireById(master.weaponTypes, weaponTypeId, 'WeaponTypeMaster')
  return master.weaponBonusDefinitions
    .filter(
      (definition) =>
        definition.isEnabled &&
        definition.weaponTypeId === weaponTypeId &&
        definition.scope === scope,
    )
    .sort(compareBySortOrderAndId)
}

export function getRanksForBonusType(
  master: MasterDataRoot,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
  bonusTypeId: BonusTypeId,
  scope: ArtianBonusScope,
): BonusRankMaster[] {
  requireById(master.weaponTypes, weaponTypeId, 'WeaponTypeMaster')
  requireById(master.elements, elementId, 'ElementMaster')
  requireById(master.bonusTypes, bonusTypeId, 'BonusTypeMaster')

  const rankIds = new Set(
    getBonusDefinitionsForWeapon(master, weaponTypeId, elementId, scope)
      .filter((definition) => definition.bonusTypeId === bonusTypeId)
      .map(({ bonusRankId }) => bonusRankId),
  )

  return [...rankIds]
    .map((rankId) => {
      const rank = master.bonusRanks.find(({ id }) => id === rankId)
      if (!rank) {
        throw new MasterDataDomainError(
          'master_reference_invalid',
          'BonusRankMaster',
          rankId,
        )
      }
      return rank
    })
    .filter(({ isEnabled }) => isEnabled)
    .sort(compareByRankOrderAndId)
}

export function getGogmaBonusTypeForNormalBonus(
  master: MasterDataRoot,
  normalBonusTypeId: BonusTypeId,
): BonusTypeId {
  requireById(master.bonusTypes, normalBonusTypeId, 'BonusTypeMaster')
  const mapping = master.artianBonusTypeMappings.find(
    (entry) => entry.normalBonusTypeId === normalBonusTypeId,
  )
  if (!mapping) {
    throw new MasterDataDomainError(
      'master_mapping_not_found',
      'ArtianBonusTypeMapping',
      normalBonusTypeId,
    )
  }
  return mapping.gogmaBonusTypeId
}

export function getNormalBonusTypesForGogmaBonus(
  master: MasterDataRoot,
  gogmaBonusTypeId: BonusTypeId,
): BonusTypeId[] {
  requireById(master.bonusTypes, gogmaBonusTypeId, 'BonusTypeMaster')
  const values = master.artianBonusTypeMappings
    .filter((entry) => entry.gogmaBonusTypeId === gogmaBonusTypeId)
    .map((entry) => entry.normalBonusTypeId)
    .sort((left, right) => left.localeCompare(right))
  if (values.length === 0) {
    throw new MasterDataDomainError(
      'master_mapping_not_found',
      'ArtianBonusTypeMapping',
      gogmaBonusTypeId,
    )
  }
  return values
}

export function getBonusRankOrder(
  master: BonusRankMasterLookup,
  bonusRankId: BonusRankId,
): number {
  return getBonusRank(master, bonusRankId).order
}

export function isExRank(
  master: BonusRankMasterLookup,
  bonusRankId: BonusRankId,
): boolean {
  return getBonusRank(master, bonusRankId).isEx
}

export function getSeriesSkillOptions(
  master: MasterDataRoot,
): SeriesSkillMaster[] {
  return master.seriesSkills
    .filter(({ isEnabled }) => isEnabled)
    .sort(compareBySortOrderAndId)
}

export function getGroupSkillOptions(
  master: MasterDataRoot,
): GroupSkillMaster[] {
  return master.groupSkills
    .filter(({ isEnabled }) => isEnabled)
    .sort(compareBySortOrderAndId)
}

export function getMaterialCosts(
  master: MasterDataRoot,
  operationType: MaterialCostOperationType,
  weaponTypeId: WeaponTypeId,
): MaterialCostMaster[] {
  requireById(master.weaponTypes, weaponTypeId, 'WeaponTypeMaster')
  return getMaterialCostsFromSubset(master, operationType, weaponTypeId)
}

export function getMaterialCostsFromSubset(
  master: Pick<MasterDataRoot, 'materialCosts'>,
  operationType: MaterialCostOperationType,
  weaponTypeId: WeaponTypeId,
): MaterialCostMaster[] {
  return master.materialCosts
    .filter(
      (cost) =>
        cost.isEnabled &&
        cost.operationType === operationType &&
        (cost.weaponTypeId === null || cost.weaponTypeId === weaponTypeId),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
}
