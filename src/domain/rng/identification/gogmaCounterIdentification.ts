import type { RestorationBonusSet } from '../../models/publicTypes'
import type { WeaponBonusDefinitionsMasterSubset } from '../../master/masterSelectors'
import type { RngEngine, RngMasterSubset } from '../rngEngine'
import { productionGogmaResetCandidatesForWeaponAndElement } from '../production/gameGogmaBonuses'
import { predictProductionGogmaResetSlotsFromRawValues } from '../production/gogmaPrediction'
import {
  referenceGogmaIdFromRestorationBonus,
  type ReferenceGogmaBonus,
} from '../production/referenceGogmaBonuses'
import {
  initializeReferencePrng,
  nextReferencePrngState,
  REFERENCE_RNG_BLOCK_SIZE,
  type ReferencePrngState,
} from '../production/referencePrng'
import { deriveGogmaSeed } from '../production/seedDerivation'
import { applyReferencePrngJump, compileReferencePrngJump } from './referencePrngJump'
import {
  GogmaCounterIdentificationError,
  MAX_GOGMA_IDENTIFICATION_COUNTER,
  type GogmaCounterIdentificationExecutionOptions,
  type GogmaCounterIdentificationInput,
  type GogmaCounterIdentificationResult,
} from './gogmaCounterIdentificationTypes'

const GOGMA_RESULT_SLOT_COUNT = 5
const DEFAULT_COUNTER_CHUNK_SIZE = 1_000

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new GogmaCounterIdentificationError('invalid_input', `${label} must be a safe integer.`)
  }
}

function validateInput(input: GogmaCounterIdentificationInput, engine: RngEngine): number {
  let normalizedSeed: string
  try {
    normalizedSeed = engine.normalizeSeed(input.baseSeed)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new GogmaCounterIdentificationError('invalid_input', error.message)
    }
    throw error
  }
  if (normalizedSeed !== input.baseSeed) {
    throw new GogmaCounterIdentificationError(
      'invalid_input',
      'Base Seed must already use the canonical Production decimal form.',
    )
  }

  const range = input.gogmaCounterRange
  requireSafeInteger(range.startInclusive, 'Gogma Counter range start')
  requireSafeInteger(range.endInclusive, 'Gogma Counter range end')
  if (
    range.startInclusive < 0 ||
    range.endInclusive < range.startInclusive ||
    range.endInclusive > MAX_GOGMA_IDENTIFICATION_COUNTER
  ) {
    throw new GogmaCounterIdentificationError(
      'invalid_input',
      `Gogma Counter range must be inclusive and ascending from 0 to ${MAX_GOGMA_IDENTIFICATION_COUNTER}.`,
    )
  }
  if (input.observations.length === 0) {
    throw new GogmaCounterIdentificationError(
      'invalid_input',
      'At least one ordered five-slot Gogma Reset observation is required.',
    )
  }
  if (
    input.observations.length - 1 >
    MAX_GOGMA_IDENTIFICATION_COUNTER - range.endInclusive
  ) {
    throw new GogmaCounterIdentificationError(
      'invalid_input',
      'The final consecutive observation exceeds the supported Gogma Counter range.',
    )
  }
  for (const observation of input.observations) {
    if (!Array.isArray(observation) || observation.length !== GOGMA_RESULT_SLOT_COUNT) {
      throw new GogmaCounterIdentificationError(
        'invalid_input',
        'Every Gogma Reset observation must contain exactly five ordered slots.',
      )
    }
    try {
      observation.forEach(referenceGogmaIdFromRestorationBonus)
    } catch (error) {
      if (error instanceof RangeError) {
        throw new GogmaCounterIdentificationError('invalid_input', error.message)
      }
      throw error
    }
  }
  if (input.maxMatches !== undefined) {
    requireSafeInteger(input.maxMatches, 'maxMatches')
    if (input.maxMatches < 1) {
      throw new GogmaCounterIdentificationError('invalid_input', 'maxMatches must be at least 1.')
    }
  }
  return Number(normalizedSeed)
}

function supportMaster(master: WeaponBonusDefinitionsMasterSubset): RngMasterSubset {
  return { ...master, bonusRanks: [] }
}

function requirePredictionSupport(input: GogmaCounterIdentificationInput, engine: RngEngine): void {
  if (!engine.capabilities.supportsGogmaPrediction) {
    throw new GogmaCounterIdentificationError(
      'unsupported_input',
      'The active RNG Engine does not support Gogma Reset prediction.',
      'engine_capability_unavailable',
    )
  }
  const support = engine.getPredictionSupport({
    type: 'gogma_reset',
    weaponTypeId: input.weaponTypeId,
    elementId: input.elementId,
    master: supportMaster(input.master),
  })
  if (!support.supported) {
    throw new GogmaCounterIdentificationError(
      'unsupported_input',
      `Gogma Counter identification input is unsupported: ${support.reason}.`,
      support.reason,
    )
  }
}

function advance(state: ReferencePrngState, steps: number): ReferencePrngState {
  let current = state
  for (let step = 0; step < steps; step += 1) current = nextReferencePrngState(current)
  return current
}

function rawResetValues(counterState: ReferencePrngState): readonly number[] {
  const values: number[] = []
  let state = counterState
  for (let slot = 0; slot < GOGMA_RESULT_SLOT_COUNT; slot += 1) {
    state = nextReferencePrngState(state)
    values.push(state.w)
  }
  return values
}

function bonusesEqual(left: RestorationBonusSet, right: RestorationBonusSet): boolean {
  for (let slot = 0; slot < GOGMA_RESULT_SLOT_COUNT; slot += 1) {
    if (
      left[slot].bonusTypeId !== right[slot].bonusTypeId ||
      left[slot].bonusRankId !== right[slot].bonusRankId
    ) return false
  }
  return true
}

function matchesObservations(
  counterState: ReferencePrngState,
  observations: readonly RestorationBonusSet[],
  candidates: readonly ReferenceGogmaBonus[],
): boolean {
  let observationState = counterState
  for (let index = 0; index < observations.length; index += 1) {
    const prediction = predictProductionGogmaResetSlotsFromRawValues(
      rawResetValues(observationState),
      candidates,
    )
    if (!bonusesEqual(prediction, observations[index]!)) return false
    if (index + 1 < observations.length) {
      observationState = advance(observationState, REFERENCE_RNG_BLOCK_SIZE)
    }
  }
  return true
}

/** Identifies only the starting Gogma Counter for an already-known canonical Base Seed. */
export async function identifyGogmaCounter(
  input: GogmaCounterIdentificationInput,
  engine: RngEngine,
  options: GogmaCounterIdentificationExecutionOptions = {},
): Promise<GogmaCounterIdentificationResult> {
  const baseSeed = validateInput(input, engine)
  requirePredictionSupport(input, engine)
  // The same Production family availability and draw path as
  // `ProductionRngEngine.predictGogmaBonus(reset)`; there is no separate
  // Identification candidate table and no Master availability filter.
  const candidates = productionGogmaResetCandidatesForWeaponAndElement(
    input.weaponTypeId,
    input.elementId,
  )
  const chunkSize = options.counterChunkSize ?? DEFAULT_COUNTER_CHUNK_SIZE
  requireSafeInteger(chunkSize, 'Counter chunk size')
  if (chunkSize < 1) {
    throw new GogmaCounterIdentificationError(
      'invalid_input',
      'Counter chunk size must be at least 1.',
    )
  }
  const shouldCancel = options.shouldCancel ?? (() => false)
  const yieldControl = options.yieldControl ?? (() => Promise.resolve())
  const range = input.gogmaCounterRange
  const totalCounters = range.endInclusive - range.startInclusive + 1
  const initialized = initializeReferencePrng(
    deriveGogmaSeed(baseSeed, input.weaponTypeId, input.elementId),
  )
  let counterState = applyReferencePrngJump(
    compileReferencePrngJump(range.startInclusive * REFERENCE_RNG_BLOCK_SIZE),
    initialized,
  )
  const matches: { startGogmaCounter: number }[] = []
  let searchedCounters = 0
  let completedCounter = range.startInclusive - 1
  let stoppedByLimit = false

  for (
    let chunkStart = range.startInclusive;
    chunkStart <= range.endInclusive;
    chunkStart += chunkSize
  ) {
    if (shouldCancel()) {
      throw new GogmaCounterIdentificationError(
        'cancelled',
        'Gogma Counter identification was cancelled.',
      )
    }
    const chunkEnd = Math.min(range.endInclusive, chunkStart + chunkSize - 1)
    for (let counter = chunkStart; counter <= chunkEnd; counter += 1) {
      if (matchesObservations(counterState, input.observations, candidates)) {
        matches.push({ startGogmaCounter: counter })
      }
      searchedCounters += 1
      completedCounter = counter
      if (input.maxMatches !== undefined && matches.length >= input.maxMatches) {
        stoppedByLimit = counter < range.endInclusive
        break
      }
      if (counter < range.endInclusive) {
        counterState = advance(counterState, REFERENCE_RNG_BLOCK_SIZE)
      }
    }

    options.onProgress?.({ searchedCounters, totalCounters, matchesFound: matches.length })
    if (stoppedByLimit) break
    await yieldControl()
  }

  if (shouldCancel()) {
    throw new GogmaCounterIdentificationError(
      'cancelled',
      'Gogma Counter identification was cancelled.',
    )
  }
  return {
    matches,
    searchedCounterRange: {
      startInclusive: range.startInclusive,
      endInclusive: completedCounter,
    },
    isTruncated: stoppedByLimit,
  }
}
