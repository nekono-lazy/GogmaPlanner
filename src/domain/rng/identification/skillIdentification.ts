import type { RngEngine } from '../rngEngine'
import {
  initializeReferencePrng,
  nextReferencePrngState,
  type ReferencePrngState,
} from '../production/referencePrng'
import {
  REFERENCE_SKILL_COMBINATION_COUNT,
  referenceSkillCombinationIndexFromIds,
} from '../production/referenceSkillPools'
import { deriveSkillSeed } from '../production/seedDerivation'
import {
  applyReferencePrngJump,
  compileReferencePrngJump,
  type ReferencePrngJump,
} from './referencePrngJump'
import {
  CANONICAL_BASE_SEED_MAX,
  CANONICAL_BASE_SEED_MIN,
  SkillIdentificationError,
  type InclusiveNumberRange,
  type SkillIdentificationExecutionOptions,
  type SkillIdentificationInput,
  type SkillIdentificationMatch,
  type SkillIdentificationResult,
} from './skillIdentificationTypes'

const SKILL_COUNTER_STRIDE = 10
const DEFAULT_SEED_CHUNK_SIZE = 10_000

interface CompiledSkillIdentification {
  readonly seedRange: InclusiveNumberRange
  readonly observationIndices: readonly number[]
  readonly rangeStartJump: ReferencePrngJump
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new SkillIdentificationError('invalid_input', `${label} must be a safe integer.`)
  }
}

function validateRange(
  range: InclusiveNumberRange,
  label: string,
  minimum: number,
  maximum: number,
): void {
  requireSafeInteger(range.startInclusive, `${label} start`)
  requireSafeInteger(range.endInclusive, `${label} end`)
  if (
    range.startInclusive < minimum ||
    range.endInclusive > maximum ||
    range.endInclusive < range.startInclusive
  ) {
    throw new SkillIdentificationError(
      'invalid_input',
      `${label} must be an inclusive ascending range from ${minimum} to ${maximum}.`,
    )
  }
}

function rangeLength(range: InclusiveNumberRange): number {
  return range.endInclusive - range.startInclusive + 1
}

function compileInput(input: SkillIdentificationInput): CompiledSkillIdentification {
  const seedRange = input.seedRange ?? {
    startInclusive: CANONICAL_BASE_SEED_MIN,
    endInclusive: CANONICAL_BASE_SEED_MAX,
  }
  validateRange(
    seedRange,
    'Base Seed range',
    CANONICAL_BASE_SEED_MIN,
    CANONICAL_BASE_SEED_MAX,
  )
  const maximumSkillCounter = Math.floor((Number.MAX_SAFE_INTEGER - 1) / SKILL_COUNTER_STRIDE)
  validateRange(input.skillCounterRange, 'Skill Counter range', 0, maximumSkillCounter)
  if (input.observations.length === 0) {
    throw new SkillIdentificationError(
      'invalid_input',
      'At least one complete Skill observation is required.',
    )
  }
  if (input.maxMatches !== undefined) {
    requireSafeInteger(input.maxMatches, 'maxMatches')
    if (input.maxMatches < 1) {
      throw new SkillIdentificationError('invalid_input', 'maxMatches must be at least 1.')
    }
  }

  let observationIndices: number[]
  try {
    observationIndices = input.observations.map((observation) =>
      referenceSkillCombinationIndexFromIds(
        observation.seriesSkillId,
        observation.groupSkillId,
      ),
    )
  } catch (error) {
    if (error instanceof RangeError) {
      throw new SkillIdentificationError('invalid_input', error.message)
    }
    throw error
  }

  return {
    seedRange,
    observationIndices,
    rangeStartJump: compileReferencePrngJump(
      input.skillCounterRange.startInclusive * SKILL_COUNTER_STRIDE + 1,
    ),
  }
}

function advance(state: ReferencePrngState, steps: number): ReferencePrngState {
  let current = state
  for (let step = 0; step < steps; step += 1) {
    current = nextReferencePrngState(current)
  }
  return current
}

function matchesObservations(
  counterState: ReferencePrngState,
  observationIndices: readonly number[],
): boolean {
  if (counterState.w % REFERENCE_SKILL_COMBINATION_COUNT !== observationIndices[0]) {
    return false
  }
  let observationState = counterState
  for (let index = 1; index < observationIndices.length; index += 1) {
    observationState = advance(observationState, SKILL_COUNTER_STRIDE)
    if (observationState.w % REFERENCE_SKILL_COMBINATION_COUNT !== observationIndices[index]) {
      return false
    }
  }
  return true
}

function requirePredictionSupport(input: SkillIdentificationInput, engine: RngEngine): void {
  if (!engine.capabilities.supportsSkillPrediction) {
    throw new SkillIdentificationError(
      'unsupported_input',
      'The active RNG Engine does not support Skill prediction.',
      'engine_capability_unavailable',
    )
  }
  const support = engine.getPredictionSupport({
    type: 'skill',
    weaponTypeId: input.weaponTypeId,
    elementId: input.elementId,
  })
  if (!support.supported) {
    throw new SkillIdentificationError(
      'unsupported_input',
      `Skill identification input is unsupported: ${support.reason}.`,
      support.reason,
    )
  }
}

function compareMatches(left: SkillIdentificationMatch, right: SkillIdentificationMatch): number {
  return left.baseSeed - right.baseSeed || left.startSkillCounter - right.startSkillCounter
}

/**
 * Identifies canonical Base Seed / starting Skill Counter pairs. Counter Gate
 * is deliberately absent: the Wizard targets the active branch represented by
 * Gate 54, without claiming or persisting an exact game Gate value.
 */
export async function identifySkillSeedAndCounter(
  input: SkillIdentificationInput,
  engine: RngEngine,
  options: SkillIdentificationExecutionOptions = {},
): Promise<SkillIdentificationResult> {
  const compiled = compileInput(input)
  requirePredictionSupport(input, engine)
  const shouldCancel = options.shouldCancel ?? (() => false)
  const yieldControl = options.yieldControl ?? (() => Promise.resolve())
  const chunkSize = options.seedChunkSize ?? DEFAULT_SEED_CHUNK_SIZE
  requireSafeInteger(chunkSize, 'Seed chunk size')
  if (chunkSize < 1) {
    throw new SkillIdentificationError('invalid_input', 'Seed chunk size must be at least 1.')
  }

  const matches: SkillIdentificationMatch[] = []
  const totalSeeds = rangeLength(compiled.seedRange)
  let searchedSeeds = 0
  let completedSeed = compiled.seedRange.startInclusive - 1
  let stoppedByLimit = false

  for (
    let chunkStart = compiled.seedRange.startInclusive;
    chunkStart <= compiled.seedRange.endInclusive;
    chunkStart += chunkSize
  ) {
    if (shouldCancel()) {
      throw new SkillIdentificationError('cancelled', 'Skill identification was cancelled.')
    }
    const chunkEnd = Math.min(
      compiled.seedRange.endInclusive,
      chunkStart + chunkSize - 1,
    )
    for (let baseSeed = chunkStart; baseSeed <= chunkEnd; baseSeed += 1) {
      const initialized = initializeReferencePrng(
        deriveSkillSeed(baseSeed, input.weaponTypeId, input.elementId),
      )
      let counterState = applyReferencePrngJump(compiled.rangeStartJump, initialized)
      for (
        let counter = input.skillCounterRange.startInclusive;
        counter <= input.skillCounterRange.endInclusive;
        counter += 1
      ) {
        if (matchesObservations(counterState, compiled.observationIndices)) {
          matches.push({ baseSeed, startSkillCounter: counter })
        }
        if (counter !== input.skillCounterRange.endInclusive) {
          counterState = advance(counterState, SKILL_COUNTER_STRIDE)
        }
      }
      searchedSeeds += 1
      completedSeed = baseSeed
      if (input.maxMatches !== undefined && matches.length >= input.maxMatches) {
        stoppedByLimit = baseSeed < compiled.seedRange.endInclusive
        break
      }
    }

    options.onProgress?.({ searchedSeeds, totalSeeds, matchesFound: matches.length })
    if (stoppedByLimit) break
    await yieldControl()
  }

  if (shouldCancel()) {
    throw new SkillIdentificationError('cancelled', 'Skill identification was cancelled.')
  }

  const orderedMatches = matches.sort(compareMatches)
  const isOverLimit = input.maxMatches !== undefined && orderedMatches.length > input.maxMatches
  return {
    matches: input.maxMatches === undefined
      ? orderedMatches
      : orderedMatches.slice(0, input.maxMatches),
    searchedSeedRange: {
      startInclusive: compiled.seedRange.startInclusive,
      endInclusive: completedSeed,
    },
    isTruncated: stoppedByLimit || isOverLimit,
  }
}

/**
 * Deterministically merges fully searched, contiguous Seed chunks. Parallel
 * callers must not early-truncate individual chunks; global maxMatches is
 * applied only after every chunk result has completed.
 */
export function mergeSkillIdentificationChunkResults(
  chunkResults: readonly SkillIdentificationResult[],
  maxMatches?: number,
): SkillIdentificationResult {
  if (chunkResults.length === 0) {
    throw new SkillIdentificationError(
      'invalid_input',
      'At least one completed chunk result is required.',
    )
  }
  if (maxMatches !== undefined) {
    requireSafeInteger(maxMatches, 'maxMatches')
    if (maxMatches < 1) {
      throw new SkillIdentificationError('invalid_input', 'maxMatches must be at least 1.')
    }
  }
  if (chunkResults.some(({ isTruncated }) => isTruncated)) {
    throw new SkillIdentificationError(
      'incomplete_parallel_chunk',
      'Truncated chunk results cannot be merged deterministically.',
    )
  }
  const orderedChunks = [...chunkResults].sort(
    (left, right) =>
      left.searchedSeedRange.startInclusive - right.searchedSeedRange.startInclusive,
  )
  for (let index = 1; index < orderedChunks.length; index += 1) {
    if (
      orderedChunks[index]!.searchedSeedRange.startInclusive !==
      orderedChunks[index - 1]!.searchedSeedRange.endInclusive + 1
    ) {
      throw new SkillIdentificationError(
        'incomplete_parallel_chunk',
        'Parallel chunk Seed ranges must be contiguous and non-overlapping.',
      )
    }
  }
  const matches = orderedChunks
    .flatMap(({ matches: chunkMatches }) => chunkMatches)
    .sort(compareMatches)
  const isTruncated = maxMatches !== undefined && matches.length > maxMatches
  return {
    matches: maxMatches === undefined ? matches : matches.slice(0, maxMatches),
    searchedSeedRange: {
      startInclusive: orderedChunks[0]!.searchedSeedRange.startInclusive,
      endInclusive: orderedChunks.at(-1)!.searchedSeedRange.endInclusive,
    },
    isTruncated,
  }
}
