import type {
  NormalArtianRarity,
  RestorationBonusSet,
  WeaponTypeId,
} from '../../models/publicTypes'
import type { NormalizedSeed, RngPredictionUnsupportedReason } from '../rngEngine'
import type { NormalArtianLotteryTableClass } from '../normalArtianLotteryTable'
import { REFERENCE_RNG_BLOCK_SIZE } from '../production/referencePrng'
import type { InclusiveNumberRange } from './skillIdentificationTypes'

export {
  NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES,
  isNormalArtianLotteryTableClass,
  type NormalArtianLotteryTableClass,
} from '../normalArtianLotteryTable'

/**
 * The largest starting Normal Counter one identification may evaluate.
 *
 * A Normal Counter addresses one ten-step reference PRNG block, and
 * `readReferenceRngBlock()` refuses a block index above this same bound so
 * that `blockIndex * REFERENCE_RNG_BLOCK_SIZE` stays a safe integer. The
 * identification walk positions the PRNG the same way, so it inherits the
 * bound instead of inventing one. Persisted `NormalArtianCounter` domain
 * validation is a separate contract and is not widened or narrowed here.
 */
export const MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER = Math.floor(
  Number.MAX_SAFE_INTEGER / REFERENCE_RNG_BLOCK_SIZE,
)

/**
 * One forged rarity-8 Normal Artian weapon: the lottery table it drew from and
 * its five ordered slots.
 *
 * The Normal seed is Base Seed + weapon type + rarity; the element never
 * enters it. The element decides only which candidate pool one forge draws
 * from, and that choice is the `NormalArtianLotteryTableClass` of the weapon
 * type (`docs/RNG_SPEC.md` 9.12): for the Bow, Table A is Fire / Water /
 * Thunder / Ice / Dragon / Blast and Table B is none / Poison / Paralysis /
 * Sleep; for the Melee category and the Bowguns, Table A is any attribute and
 * Table B is none. Counter identification therefore never asks for an exact
 * `ElementId`; it asks only which table the forged weapon drew from.
 *
 * A table class is not a Counter stream: observations of both tables sit on
 * the same weapon-type Counter, observation `i` at `C + i` whichever table it
 * used.
 */
export interface NormalArtianCounterObservation {
  readonly tableClass: NormalArtianLotteryTableClass
  readonly bonuses: RestorationBonusSet
}

export interface NormalArtianCounterIdentificationInput {
  readonly baseSeed: NormalizedSeed
  readonly weaponTypeId: WeaponTypeId
  readonly rarity: NormalArtianRarity
  /** Ordered consecutive forges of this weapon type; observation `i` sits at `C + i`. */
  readonly observations: readonly NormalArtianCounterObservation[]
  readonly normalCounterRange: InclusiveNumberRange
  readonly maxMatches?: number
}

export interface NormalArtianCounterIdentificationMatch {
  readonly startNormalCounter: number
}

export interface NormalArtianCounterIdentificationResult {
  readonly matches: readonly NormalArtianCounterIdentificationMatch[]
  /** The completed starting-Counter prefix; `endInclusive` is the last Counter actually evaluated. */
  readonly searchedCounterRange: InclusiveNumberRange
  readonly isTruncated: boolean
}

export interface NormalArtianCounterIdentificationProgress {
  /** Starting Counter candidates fully accepted or rejected, not prediction calls. */
  readonly searchedCounters: number
  readonly totalCounters: number
  readonly matchesFound: number
}

export interface NormalArtianCounterIdentificationExecutionOptions {
  readonly shouldCancel?: () => boolean
  readonly yieldControl?: () => Promise<void>
  readonly onProgress?: (progress: NormalArtianCounterIdentificationProgress) => void
  /** Runtime tuning only; this is not a persisted Production contract. */
  readonly counterChunkSize?: number
}

export type NormalArtianCounterIdentificationErrorCode =
  | 'invalid_input'
  | 'unsupported_input'
  | 'cancelled'

export class NormalArtianCounterIdentificationError extends Error {
  readonly code: NormalArtianCounterIdentificationErrorCode
  readonly unsupportedReason: RngPredictionUnsupportedReason | null

  constructor(
    code: NormalArtianCounterIdentificationErrorCode,
    message: string,
    unsupportedReason: RngPredictionUnsupportedReason | null = null,
  ) {
    super(message)
    this.name = 'NormalArtianCounterIdentificationError'
    this.code = code
    this.unsupportedReason = unsupportedReason
  }
}

export type NormalArtianCounterIdentificationWorkerRequest =
  | {
      readonly type: 'identify_normal_artian_counter'
      readonly requestId: string
      readonly input: NormalArtianCounterIdentificationInput
    }
  | { readonly type: 'cancel'; readonly requestId: string }

export type NormalArtianCounterIdentificationWorkerResponse =
  | {
      readonly type: 'normal_artian_counter_identification_result'
      readonly requestId: string
      readonly result: NormalArtianCounterIdentificationResult
    }
  | {
      readonly type: 'progress'
      readonly requestId: string
      readonly progress: NormalArtianCounterIdentificationProgress
    }
  | {
      readonly type: 'error'
      readonly requestId: string
      readonly message: string
      readonly code: NormalArtianCounterIdentificationErrorCode | 'unexpected_error'
      readonly unsupportedReason: RngPredictionUnsupportedReason | null
    }
