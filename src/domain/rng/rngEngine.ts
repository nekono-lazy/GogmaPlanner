import type {
  ElementId,
  GroupSkillId,
  NormalArtianRarity,
  RestorationBonusSet,
  SeriesSkillId,
  WeaponTypeId,
} from '../models/publicTypes'
import type {
  ArtianBonusTypeMapping,
  BonusRankMaster,
  BonusTypeMaster,
  ElementMaster,
  WeaponBonusDefinition,
  WeaponTypeMaster,
} from '../master/masterTypes'

export type NormalizedSeed = string

export interface RngEngineCapabilities {
  supportsNormalArtianPrediction: boolean
  supportsGogmaPrediction: boolean
  supportsSkillPrediction: boolean
  supportsKeepBonusesPrediction: boolean
}

/**
 * The minimal Master an RNG prediction reads.
 *
 * The provisional `LotteryMaster` is deliberately absent: Production RNG draws
 * from its own reference-verified tables and Engine constants, never from
 * `MasterDataRoot.lotteries`, so no calculation payload carries it
 * (`docs/RNG_SPEC.md` 6.4).
 */
export interface RngMasterSubset {
  weaponBonusDefinitions: WeaponBonusDefinition[]
  bonusRanks: BonusRankMaster[]
  /** Required by the production Gogma Reset availability filter when used. */
  elements?: ElementMaster[]
  /** Required by the production Gogma Reset availability filter when used. */
  bonusTypes?: BonusTypeMaster[]
  /** Required by the production Gogma Reset availability filter when used. */
  weaponTypes?: WeaponTypeMaster[]
  /**
   * Required by the production Keep family resolution when used: a Normal-side
   * bonus type of a current slot is normalized to its Gogma-side family through
   * this mapping (`docs/RNG_SPEC.md` 6.1 / 6.4).
   */
  artianBonusTypeMappings?: ArtianBonusTypeMapping[]
}

export interface GogmaBonusPredictionInput {
  baseSeed: NormalizedSeed
  gogmaCounter: number
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  operation:
    | { type: 'reset_bonuses' }
    | { type: 'keep_bonuses'; currentBonuses: RestorationBonusSet }
  master: RngMasterSubset
}

export interface SkillPredictionInput {
  baseSeed: NormalizedSeed
  skillCounter: number
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  master: RngMasterSubset
}

export interface SkillPredictionResult {
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

export interface NormalArtianPredictionInput {
  baseSeed: NormalizedSeed
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  rarity: NormalArtianRarity
  normalCounter: number
  master: RngMasterSubset
}

export type GogmaOperation =
  | { type: 'reset_bonuses' }
  | { type: 'keep_bonuses' }

export type SkillOperation =
  | { type: 'convert_normal_to_gogma' }
  | { type: 'reset_skills' }

export type NormalArtianOperation = {
  type: 'create_normal_artian'
  count: number
}

/**
 * Operation-level capability says an Engine exists; this query says whether a
 * particular semantic input is within that Engine's supported coverage.
 */
export type RngPredictionSupportInput =
  | {
      type: 'normal_artian'
      weaponTypeId: WeaponTypeId
      elementId: ElementId
      rarity: NormalArtianRarity
    }
  | {
      type: 'skill'
      weaponTypeId: WeaponTypeId
      elementId: ElementId
    }
  | {
      type: 'gogma_reset'
      weaponTypeId: WeaponTypeId
      elementId: ElementId
      master: RngMasterSubset
    }
  | {
      type: 'gogma_keep'
      weaponTypeId: WeaponTypeId
      elementId: ElementId
      /** The current ordered five slots of either scope; families are read from bonus types only. */
      currentBonuses: RestorationBonusSet
      master: RngMasterSubset
    }

export type RngPredictionUnsupportedReason =
  | 'engine_capability_unavailable'
  | 'normal_pool_unverified'
  | 'reference_adapter_unsupported'
  | 'master_data_unavailable'
  | 'no_available_reset_candidates'
  | 'unsupported_current_bonus'

export type RngPredictionSupport =
  | { supported: true }
  | { supported: false; reason: RngPredictionUnsupportedReason }

export interface RngEngine {
  readonly version: string
  readonly capabilities: RngEngineCapabilities
  getPredictionSupport(input: RngPredictionSupportInput): RngPredictionSupport
  normalizeSeed(input: string): NormalizedSeed
  predictGogmaBonus(input: GogmaBonusPredictionInput): RestorationBonusSet
  predictSkills(input: SkillPredictionInput): SkillPredictionResult
  predictNormalArtian(input: NormalArtianPredictionInput): RestorationBonusSet
  advanceGogmaCounter(current: number, operation: GogmaOperation): number
  advanceSkillCounter(current: number, operation: SkillOperation): number
  advanceNormalCounter(current: number, operation: NormalArtianOperation): number
}

export class UnsupportedRngOperationError extends Error {
  constructor(operation: string) {
    super(`RNG operation is unsupported without an explicit fixture: ${operation}`)
    this.name = 'UnsupportedRngOperationError'
  }
}

/** A supported Engine operation received a concrete input outside its coverage. */
export class UnsupportedRngInputError extends Error {
  readonly operation: RngPredictionSupportInput['type']
  readonly reason: RngPredictionUnsupportedReason

  constructor(
    operation: RngPredictionSupportInput['type'],
    reason: RngPredictionUnsupportedReason,
  ) {
    super(`RNG input is unsupported for ${operation}: ${reason}`)
    this.name = 'UnsupportedRngInputError'
    this.operation = operation
    this.reason = reason
  }
}
