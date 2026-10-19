import type {
  ElementId,
  RestorationBonusSet,
  WeaponTypeId,
} from '../../models/publicTypes'
import type { WeaponBonusDefinitionsMasterSubset } from '../../master/masterSelectors'
import type { NormalizedSeed, RngPredictionUnsupportedReason } from '../rngEngine'
import { REFERENCE_GOGMA_COUNTER_GATE_THRESHOLD } from '../production/gogmaPrediction'
import type { InclusiveNumberRange } from './skillIdentificationTypes'

export const GOGMA_IDENTIFICATION_ACTIVE_GATE_REPRESENTATIVE =
  REFERENCE_GOGMA_COUNTER_GATE_THRESHOLD
export const MAX_GOGMA_IDENTIFICATION_COUNTER = Math.floor(Number.MAX_SAFE_INTEGER / 10)

export interface GogmaCounterIdentificationInput {
  readonly baseSeed: NormalizedSeed
  readonly weaponTypeId: WeaponTypeId
  readonly elementId: ElementId
  readonly observations: readonly RestorationBonusSet[]
  readonly gogmaCounterRange: InclusiveNumberRange
  /**
   * Kept in the Worker input shape for protocol stability. It is not the Reset
   * candidate availability authority: Identification uses the Production
   * Normal pool family set exactly as Production Reset does
   * (`docs/RNG_SPEC.md` 6.1.1 / 9.8).
   */
  readonly master: WeaponBonusDefinitionsMasterSubset
  readonly maxMatches?: number
}

export interface GogmaCounterIdentificationMatch {
  readonly startGogmaCounter: number
}

export interface GogmaCounterIdentificationResult {
  readonly matches: readonly GogmaCounterIdentificationMatch[]
  readonly searchedCounterRange: InclusiveNumberRange
  readonly isTruncated: boolean
}

export interface GogmaCounterIdentificationProgress {
  readonly searchedCounters: number
  readonly totalCounters: number
  readonly matchesFound: number
}

export interface GogmaCounterIdentificationExecutionOptions {
  readonly shouldCancel?: () => boolean
  readonly yieldControl?: () => Promise<void>
  readonly onProgress?: (progress: GogmaCounterIdentificationProgress) => void
  /** Runtime tuning only; this is not a persisted Production contract. */
  readonly counterChunkSize?: number
}

export type GogmaCounterIdentificationErrorCode =
  | 'invalid_input'
  | 'unsupported_input'
  | 'cancelled'

export class GogmaCounterIdentificationError extends Error {
  readonly code: GogmaCounterIdentificationErrorCode
  readonly unsupportedReason: RngPredictionUnsupportedReason | null

  constructor(
    code: GogmaCounterIdentificationErrorCode,
    message: string,
    unsupportedReason: RngPredictionUnsupportedReason | null = null,
  ) {
    super(message)
    this.name = 'GogmaCounterIdentificationError'
    this.code = code
    this.unsupportedReason = unsupportedReason
  }
}

export type GogmaCounterIdentificationWorkerRequest =
  | {
      readonly type: 'identify_gogma_counter'
      readonly requestId: string
      readonly input: GogmaCounterIdentificationInput
    }
  | { readonly type: 'cancel'; readonly requestId: string }

export type GogmaCounterIdentificationWorkerResponse =
  | {
      readonly type: 'gogma_counter_identification_result'
      readonly requestId: string
      readonly result: GogmaCounterIdentificationResult
    }
  | {
      readonly type: 'progress'
      readonly requestId: string
      readonly progress: GogmaCounterIdentificationProgress
    }
  | {
      readonly type: 'error'
      readonly requestId: string
      readonly message: string
      readonly code: GogmaCounterIdentificationErrorCode | 'unexpected_error'
      readonly unsupportedReason: RngPredictionUnsupportedReason | null
    }
