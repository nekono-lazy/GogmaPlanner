import manifestJson from '../../data/master/manifest.json'
import weaponTypesJson from '../../data/master/weapon-types.json'
import elementsJson from '../../data/master/elements.json'
import bonusTypesJson from '../../data/master/bonus-types.json'
import bonusRanksJson from '../../data/master/bonus-ranks.json'
import weaponBonusDefinitionsJson from '../../data/master/weapon-bonus-definitions.json'
import artianBonusTypeMappingsJson from '../../data/master/artian-bonus-type-mappings.json'
import seriesSkillsJson from '../../data/master/series-skills.json'
import groupSkillsJson from '../../data/master/group-skills.json'
import lotteryJson from '../../data/master/lottery.json'
import materialsJson from '../../data/master/materials.json'
import materialCostsJson from '../../data/master/material-costs.json'
import type {
  ArtianBonusTypeMapping,
  BonusRankMaster,
  BonusTypeMaster,
  ElementMaster,
  GroupSkillMaster,
  LotteryMaster,
  MasterDataRoot,
  MasterManifest,
  MaterialCostMaster,
  MaterialMaster,
  SeriesSkillMaster,
  WeaponBonusDefinition,
  WeaponTypeMaster,
} from './masterTypes'
import {
  validateMasterData,
  type MasterValidationIssue,
} from './validateMasterData'

export type MasterDataLoadResult =
  | { ok: true; data: MasterDataRoot }
  | { ok: false; issues: MasterValidationIssue[] }

function createStaticMasterDataRoot(): MasterDataRoot {
  return {
    manifest: manifestJson as MasterManifest,
    weaponTypes: weaponTypesJson as WeaponTypeMaster[],
    elements: elementsJson as ElementMaster[],
    bonusTypes: bonusTypesJson as BonusTypeMaster[],
    bonusRanks: bonusRanksJson as BonusRankMaster[],
    weaponBonusDefinitions:
      weaponBonusDefinitionsJson as WeaponBonusDefinition[],
    artianBonusTypeMappings:
      artianBonusTypeMappingsJson as ArtianBonusTypeMapping[],
    seriesSkills: seriesSkillsJson as SeriesSkillMaster[],
    groupSkills: groupSkillsJson as GroupSkillMaster[],
    lotteries: lotteryJson as LotteryMaster[],
    materials: materialsJson as MaterialMaster[],
    materialCosts: materialCostsJson as MaterialCostMaster[],
  }
}

export function loadMasterData(): MasterDataLoadResult {
  const data = createStaticMasterDataRoot()
  const validation = validateMasterData(data)
  return validation.isValid
    ? { ok: true, data }
    : { ok: false, issues: validation.issues }
}
