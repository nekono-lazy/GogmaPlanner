import type {
  BonusRankId,
  BonusTypeId,
  ElementId,
  GroupSkillId,
  MaterialId,
  NormalArtianRarity,
  SeriesSkillId,
  WeaponTypeId,
} from '../models/publicTypes'

export interface MasterManifest {
  gameTitle: 'Monster Hunter Wilds'
  appDataKind: 'gogma-artian-planner-master'
  gameVersion: string
  dataVersion: number
  generatedAt: string | null
  notes: string | null
}

export interface WeaponTypeMaster {
  id: WeaponTypeId
  displayNameJa: string
  displayNameEn: string
  sortOrder: number
  category: 'melee' | 'ranged'
  supportsElement: boolean
  supportsSharpness: boolean
  isEnabled: boolean
}

export interface ElementMaster {
  id: ElementId
  displayNameJa: string
  displayNameEn: string
  sortOrder: number
  allowsElementBonus: boolean
  isEnabled: boolean
}

export interface BonusTypeMaster {
  id: BonusTypeId
  displayNameJa: string
  displayNameEn: string
  sortOrder: number
  category: 'offense' | 'element' | 'sharpness' | 'ranged' | 'utility'
  isEnabled: boolean
}

export interface BonusRankMaster {
  id: BonusRankId
  displayNameJa: string
  displayNameEn: string
  order: number
  isEx: boolean
  isEnabled: boolean
}

export type ArtianBonusScope = 'normal_artian' | 'gogma_artian'

export interface WeaponBonusDefinition {
  id: string
  weaponTypeId: WeaponTypeId
  bonusTypeId: BonusTypeId
  bonusRankId: BonusRankId
  scope: ArtianBonusScope
  displayNameJa: string
  displayNameEn: string
  effectValue: string
  sortOrder: number
  isEnabled: boolean
}

export interface ArtianBonusTypeMapping {
  id: string
  normalBonusTypeId: BonusTypeId
  gogmaBonusTypeId: BonusTypeId
}

export interface SeriesSkillMaster {
  id: SeriesSkillId
  displayNameJa: string
  displayNameEn: string
  sortOrder: number
  isEnabled: boolean
}

export interface GroupSkillMaster {
  id: GroupSkillId
  displayNameJa: string
  displayNameEn: string
  sortOrder: number
  isEnabled: boolean
}

export interface LotteryMaster {
  id: string
  lotteryKind:
    | 'normal_artian_bonus'
    | 'gogma_bonus'
    | 'series_skill'
    | 'group_skill'
  weaponTypeId: WeaponTypeId | null
  rarity: NormalArtianRarity | null
  resultType: 'bonus' | 'series_skill' | 'group_skill'
  bonusTypeId: BonusTypeId | null
  bonusRankId: BonusRankId | null
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  internalValue: number | string
  weight: number
  sortOrder: number
  isEnabled: boolean
}

export interface MaterialMaster {
  id: MaterialId
  displayNameJa: string
  displayNameEn: string
  sortOrder: number
  isEnabled: boolean
}

export interface MaterialCostMaster {
  id: string
  operationType:
    | 'create_normal_artian'
    | 'convert_normal_to_gogma'
    | 'reset_bonuses'
    | 'keep_bonuses'
    | 'reset_skills'
  weaponTypeId: WeaponTypeId | null
  materialId: MaterialId
  quantity: number
  isEnabled: boolean
}

export interface MasterDataRoot {
  manifest: MasterManifest
  weaponTypes: WeaponTypeMaster[]
  elements: ElementMaster[]
  bonusTypes: BonusTypeMaster[]
  bonusRanks: BonusRankMaster[]
  weaponBonusDefinitions: WeaponBonusDefinition[]
  artianBonusTypeMappings: ArtianBonusTypeMapping[]
  seriesSkills: SeriesSkillMaster[]
  groupSkills: GroupSkillMaster[]
  lotteries: LotteryMaster[]
  materials: MaterialMaster[]
  materialCosts: MaterialCostMaster[]
}

export type LotteryKind = LotteryMaster['lotteryKind']
export type LotteryResultType = LotteryMaster['resultType']
export type MaterialCostOperationType = MaterialCostMaster['operationType']
