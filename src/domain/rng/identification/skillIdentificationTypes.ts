import type { ElementId, GroupSkillId, SeriesSkillId, WeaponTypeId } from '../../models/publicTypes'
import type { RngPredictionUnsupportedReason } from '../rngEngine'
import { REFERENCE_SKILL_COUNTER_GATE_THRESHOLD } from '../production/skillPrediction'

export const SKILL_IDENTIFICATION_ACTIVE_GATE_REPRESENTATIVE =
  REFERENCE_SKILL_COUNTER_GATE_THRESHOLD
export const CANONICAL_BASE_SEED_MIN = 0
export const CANONICAL_BASE_SEED_MAX = 99_999_999

export interface InclusiveNumberRange {
  readonly startInclusive: number
  readonly endInclusive: number
}

export interface CompleteSkillObservation {
  readonly seriesSkillId: SeriesSkillId
  readonly groupSkillId: GroupSkillId
}

export interface SkillIdentificationInput {
  readonly weaponTypeId: WeaponTypeId
  readonly elementId: ElementId
  readonly observations: readonly CompleteSkillObservation[]
  readonly skillCounterRange: InclusiveNumberRange
  readonly seedRange?: InclusiveNumberRange
  readonly maxMatches?: number
}

export interface SkillIdentificationMatch {
  readonly baseSeed: number
  readonly startSkillCounter: number
}

export interface SkillIdentificationResult {
  readonly matches: readonly SkillIdentificationMatch[]
  readonly searchedSeedRange: InclusiveNumberRange
  readonly isTruncated: boolean
}

export interface SkillIdentificationProgress {
  readonly searchedSeeds: number
  readonly totalSeeds: number
  readonly matchesFound: number
}

export interface SkillIdentificationExecutionOptions {
  readonly shouldCancel?: () => boolean
  readonly yieldControl?: () => Promise<void>
  readonly onProgress?: (progress: SkillIdentificationProgress) => void
  /** Runtime tuning only; this is not a persisted Production contract. */
  readonly seedChunkSize?: number
}

export type SkillIdentificationErrorCode =
  | 'invalid_input'
  | 'unsupported_input'
  | 'cancelled'
  | 'incomplete_parallel_chunk'

export class SkillIdentificationError extends Error {
  readonly code: SkillIdentificationErrorCode
  readonly unsupportedReason: RngPredictionUnsupportedReason | null

  constructor(
    code: SkillIdentificationErrorCode,
    message: string,
    unsupportedReason: RngPredictionUnsupportedReason | null = null,
  ) {
    super(message)
    this.name = 'SkillIdentificationError'
    this.code = code
    this.unsupportedReason = unsupportedReason
  }
}

export type SkillIdentificationWorkerRequest =
  | {
      readonly type: 'identify_skill_seed_counter'
      readonly requestId: string
      readonly input: SkillIdentificationInput
    }
  | { readonly type: 'cancel'; readonly requestId: string }

export type SkillIdentificationWorkerResponse =
  | {
      readonly type: 'skill_identification_result'
      readonly requestId: string
      readonly result: SkillIdentificationResult
    }
  | {
      readonly type: 'progress'
      readonly requestId: string
      readonly progress: SkillIdentificationProgress
    }
  | {
      readonly type: 'error'
      readonly requestId: string
      readonly message: string
      readonly code: SkillIdentificationErrorCode | 'unexpected_error'
      readonly unsupportedReason: RngPredictionUnsupportedReason | null
    }
