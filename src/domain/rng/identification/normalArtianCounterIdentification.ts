import type {
  ElementId,
  NormalArtianRarity,
  RestorationBonus,
  RestorationBonusSet,
  WeaponTypeId,
} from '../../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../../models/common'
import type { RngEngine, RngPredictionSupport } from '../rngEngine'
import {
  NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES,
  isNormalArtianLotteryTableClass,
  type NormalArtianLotteryTableClass,
} from '../normalArtianLotteryTable'
import { gameVerifiedNormalCandidatesForWeaponAndTableClass } from '../production/gameNormalBonuses'
import { selectReferenceNormalLotteryIdsFromRawValues } from '../production/normalPrediction'
import {
  referenceNormalIdFromRestorationBonus,
  restorationBonusFromReferenceNormalId,
  type ReferenceNormalCandidate,
  type ReferenceNormalLotteryId,
} from '../production/referenceNormalBonuses'
import {
  initializeReferencePrng,
  nextReferencePrngState,
  REFERENCE_RNG_BLOCK_SIZE,
  type ReferencePrngState,
} from '../production/referencePrng'
import { deriveNormalArtianSeed } from '../production/seedDerivation'
import { applyReferencePrngJump, compileReferencePrngJump } from './referencePrngJump'
import {
  MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER,
  NormalArtianCounterIdentificationError,
  type NormalArtianCounterIdentificationExecutionOptions,
  type NormalArtianCounterIdentificationInput,
  type NormalArtianCounterIdentificationResult,
  type NormalArtianCounterObservation,
} from './normalArtianCounterIdentificationTypes'

const NORMAL_RESULT_SLOT_COUNT = 5
const DEFAULT_COUNTER_CHUNK_SIZE = 1_000

/**
 * Internal support-query representatives for the Production adapter.
 *
 * The candidate pool itself is taken directly from
 * `gameVerifiedNormalCandidatesForWeaponAndTableClass()`; this map exists only
 * because `RngEngine.getPredictionSupport()` takes an `ElementId`. `element.fire`
 * here means "query support for the Table A pool" and `element.none` means
 * "query support for the Table B pool", nothing more: neither claims the
 * observed weapon had that element, and neither is persisted, displayed, or
 * written into an observation or result. For every supported weapon type Fire
 * is a Table A element and none is a Table B element, so the queried pool is
 * the observed table's pool.
 */
const SUPPORT_QUERY_ELEMENT_BY_TABLE_CLASS: Readonly<
  Record<NormalArtianLotteryTableClass, ElementId>
> = {
  table_a: 'element.fire',
  table_b: 'element.none',
}

/** The Production adapter's support-query representative; see the constant above. */
export function normalArtianLotteryTableClassSupportQueryElementId(
  tableClass: NormalArtianLotteryTableClass,
): ElementId {
  return SUPPORT_QUERY_ELEMENT_BY_TABLE_CLASS[tableClass]
}

/**
 * The semantic bonuses one observation slot may hold for a weapon type and
 * lottery table class: the Production pool of that table
 * (`gameVerifiedNormalCandidatesForWeaponAndTableClass()`) mapped slot-wise
 * through the reference semantic mapping, in pool order. It is the observation
 * UI's option authority, so the UI never carries a lottery table of its own.
 *
 * A weapon type with no Production pool raises
 * `UnsupportedGameVerifiedNormalPredictionError` exactly as the pool does;
 * nothing falls back to the reference pools.
 */
export function normalArtianCounterObservationBonusOptions(
  weaponTypeId: WeaponTypeId,
  tableClass: NormalArtianLotteryTableClass,
): readonly RestorationBonus[] {
  return gameVerifiedNormalCandidatesForWeaponAndTableClass(weaponTypeId, tableClass)
    .map((candidate) => restorationBonusFromReferenceNormalId(weaponTypeId, candidate.referenceId))
    .filter((bonus): bonus is RestorationBonus => bonus !== null)
}

/**
 * Whether the active Engine can identify this weapon type's Counter at all,
 * judged the way the kernel judges a request: the Engine capability first,
 * then `getPredictionSupport()` for both lottery table classes. The first
 * unsupported reason wins, so a UI can refuse to start before any observation
 * is entered, with the same structured reason the kernel would return. Every
 * rarity-8 weapon type the Production Engine knows is currently supported
 * (Switch Axe since its single-pool verification); the check stays the
 * fail-closed authority rather than a UI assumption.
 */
export function getNormalArtianCounterIdentificationSupport(
  weaponTypeId: WeaponTypeId,
  rarity: NormalArtianRarity,
  engine: RngEngine,
): RngPredictionSupport {
  if (!engine.capabilities.supportsNormalArtianPrediction) {
    return { supported: false, reason: 'engine_capability_unavailable' }
  }
  for (const tableClass of NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES) {
    const support = normalPredictionSupport({ weaponTypeId, rarity }, tableClass, engine)
    if (!support.supported) return support
  }
  return { supported: true }
}

type ReferenceNormalIdTuple = ReturnType<typeof selectReferenceNormalLotteryIdsFromRawValues>

interface CompiledObservation {
  readonly candidates: readonly ReferenceNormalCandidate[]
  readonly referenceIds: ReferenceNormalIdTuple
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new NormalArtianCounterIdentificationError('invalid_input', `${label} must be a safe integer.`)
  }
}

function isStructurallyValidBonusSet(bonuses: unknown): bonuses is RestorationBonusSet {
  return (
    Array.isArray(bonuses) &&
    bonuses.length === NORMAL_RESULT_SLOT_COUNT &&
    bonuses.every((bonus: unknown) =>
      typeof bonus === 'object' &&
      bonus !== null &&
      typeof (bonus as { bonusTypeId?: unknown }).bonusTypeId === 'string' &&
      typeof (bonus as { bonusRankId?: unknown }).bonusRankId === 'string')
  )
}

function validateObservation(observation: NormalArtianCounterObservation): void {
  if (typeof observation !== 'object' || observation === null) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'Every Normal Artian observation must be an object.',
    )
  }
  if (!isNormalArtianLotteryTableClass(observation.tableClass)) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'Every Normal Artian observation must declare tableClass "table_a" or "table_b".',
    )
  }
  if (!isStructurallyValidBonusSet(observation.bonuses)) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'Every Normal Artian observation must contain exactly five ordered restoration bonus slots.',
    )
  }
}

function validateInput(input: NormalArtianCounterIdentificationInput, engine: RngEngine): number {
  let normalizedSeed: string
  try {
    normalizedSeed = engine.normalizeSeed(input.baseSeed)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new NormalArtianCounterIdentificationError('invalid_input', error.message)
    }
    throw error
  }
  if (normalizedSeed !== input.baseSeed) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'Base Seed must already use the canonical Production decimal form.',
    )
  }

  if (input.rarity !== V1_NORMAL_ARTIAN_RARITY) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      `Normal Artian Counter identification supports rarity ${V1_NORMAL_ARTIAN_RARITY} only.`,
    )
  }

  const range = input.normalCounterRange
  requireSafeInteger(range.startInclusive, 'Normal Counter range start')
  requireSafeInteger(range.endInclusive, 'Normal Counter range end')
  if (
    range.startInclusive < 0 ||
    range.endInclusive < range.startInclusive ||
    range.endInclusive > MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER
  ) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      `Normal Counter range must be inclusive and ascending from 0 to ${MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER}.`,
    )
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'At least one ordered five-slot Normal Artian observation is required.',
    )
  }
  if (
    input.observations.length - 1 >
    MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER - range.endInclusive
  ) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'The final consecutive observation exceeds the supported Normal Counter range.',
    )
  }
  input.observations.forEach(validateObservation)
  if (input.maxMatches !== undefined) {
    requireSafeInteger(input.maxMatches, 'maxMatches')
    if (input.maxMatches < 1) {
      throw new NormalArtianCounterIdentificationError('invalid_input', 'maxMatches must be at least 1.')
    }
  }
  return Number(normalizedSeed)
}

function distinctTableClasses(
  observations: readonly NormalArtianCounterObservation[],
): readonly NormalArtianLotteryTableClass[] {
  return NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES.filter((tableClass) =>
    observations.some((observation) => observation.tableClass === tableClass))
}

function normalPredictionSupport(
  input: Pick<NormalArtianCounterIdentificationInput, 'weaponTypeId' | 'rarity'>,
  tableClass: NormalArtianLotteryTableClass,
  engine: RngEngine,
): RngPredictionSupport {
  try {
    return engine.getPredictionSupport({
      type: 'normal_artian',
      weaponTypeId: input.weaponTypeId,
      elementId: normalArtianLotteryTableClassSupportQueryElementId(tableClass),
      rarity: input.rarity,
    })
  } catch (error) {
    // A weapon type the reference adapter does not know raises the adapter's
    // RangeError from the support query itself; it is a known unsupported
    // input, not a kernel failure. Anything else stays fatal.
    if (error instanceof RangeError) {
      return { supported: false, reason: 'reference_adapter_unsupported' }
    }
    throw error
  }
}

/**
 * Fails closed on every lottery table class the observations use. The
 * Production Engine would answer `normal_pool_unverified` for a weapon type
 * with no game-verified Normal pool; that reason is forwarded as structured
 * data and never replaced by a reference-pool fallback.
 */
function requirePredictionSupport(
  input: NormalArtianCounterIdentificationInput,
  tableClasses: readonly NormalArtianLotteryTableClass[],
  engine: RngEngine,
): void {
  if (!engine.capabilities.supportsNormalArtianPrediction) {
    throw new NormalArtianCounterIdentificationError(
      'unsupported_input',
      'The active RNG Engine does not support Normal Artian prediction.',
      'engine_capability_unavailable',
    )
  }
  for (const tableClass of tableClasses) {
    const support = normalPredictionSupport(input, tableClass, engine)
    if (!support.supported) {
      throw new NormalArtianCounterIdentificationError(
        'unsupported_input',
        `Normal Artian Counter identification input is unsupported: ${support.reason}.`,
        support.reason,
      )
    }
  }
}

function compileObservations(
  input: NormalArtianCounterIdentificationInput,
  tableClasses: readonly NormalArtianLotteryTableClass[],
): readonly CompiledObservation[] {
  const candidatesByTableClass = new Map<NormalArtianLotteryTableClass, readonly ReferenceNormalCandidate[]>(
    tableClasses.map((tableClass) => [
      tableClass,
      gameVerifiedNormalCandidatesForWeaponAndTableClass(input.weaponTypeId, tableClass),
    ]),
  )
  return input.observations.map((observation) => {
    const candidates = candidatesByTableClass.get(observation.tableClass)
    if (candidates === undefined) {
      throw new Error(`Normal Artian pool is missing for ${observation.tableClass}`)
    }
    let referenceIds: ReferenceNormalLotteryId[]
    try {
      referenceIds = observation.bonuses.map((bonus) =>
        referenceNormalIdFromRestorationBonus(input.weaponTypeId, bonus))
    } catch (error) {
      if (error instanceof RangeError) {
        throw new NormalArtianCounterIdentificationError('invalid_input', error.message)
      }
      throw error
    }
    requireProducibleByPool(observation, referenceIds, candidates)
    return {
      candidates,
      referenceIds: [
        referenceIds[0]!, referenceIds[1]!, referenceIds[2]!, referenceIds[3]!, referenceIds[4]!,
      ],
    }
  })
}

/**
 * An observation the selected game-verified pool can never draw is malformed
 * input, not a legitimate zero-match search. Two conditions are checked: every
 * slot's reference ID must be a candidate of that observation's table-class
 * pool, and no candidate may occur more often than its `maximumOccurrences`,
 * because the pool step removes a candidate once it reaches that count.
 */
function requireProducibleByPool(
  observation: NormalArtianCounterObservation,
  referenceIds: readonly ReferenceNormalLotteryId[],
  candidates: readonly ReferenceNormalCandidate[],
): void {
  const occurrences = new Map<ReferenceNormalLotteryId, number>()
  for (let slot = 0; slot < referenceIds.length; slot += 1) {
    const referenceId = referenceIds[slot]!
    const candidate = candidates.find((entry) => entry.referenceId === referenceId)
    if (candidate === undefined) {
      const bonus = observation.bonuses[slot]!
      throw new NormalArtianCounterIdentificationError(
        'invalid_input',
        `Slot ${slot + 1} (${bonus.bonusTypeId} / ${bonus.bonusRankId}) cannot be produced by the ` +
          `${observation.tableClass} Normal Artian pool of this weapon type.`,
      )
    }
    const count = (occurrences.get(referenceId) ?? 0) + 1
    occurrences.set(referenceId, count)
    if (count > candidate.maximumOccurrences) {
      const bonus = observation.bonuses[slot]!
      throw new NormalArtianCounterIdentificationError(
        'invalid_input',
        `${bonus.bonusTypeId} / ${bonus.bonusRankId} occurs more than ${candidate.maximumOccurrences} ` +
          `times, which the ${observation.tableClass} Normal Artian pool of this weapon type cannot produce.`,
      )
    }
  }
}

function advance(state: ReferencePrngState, steps: number): ReferencePrngState {
  let current = state
  for (let step = 0; step < steps; step += 1) current = nextReferencePrngState(current)
  return current
}

/** The first five post-step words of the block that starts at `blockState`. */
function rawForgeValues(blockState: ReferencePrngState): readonly number[] {
  const values: number[] = []
  let state = blockState
  for (let slot = 0; slot < NORMAL_RESULT_SLOT_COUNT; slot += 1) {
    state = nextReferencePrngState(state)
    values.push(state.w)
  }
  return values
}

function referenceIdsEqual(left: ReferenceNormalIdTuple, right: ReferenceNormalIdTuple): boolean {
  for (let slot = 0; slot < NORMAL_RESULT_SLOT_COUNT; slot += 1) {
    if (left[slot] !== right[slot]) return false
  }
  return true
}

function matchesObservations(
  blockState: ReferencePrngState,
  observations: readonly CompiledObservation[],
): boolean {
  let observationState = blockState
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!
    const prediction = selectReferenceNormalLotteryIdsFromRawValues(
      rawForgeValues(observationState),
      observation.candidates,
    )
    if (!referenceIdsEqual(prediction, observation.referenceIds)) return false
    if (index + 1 < observations.length) {
      observationState = advance(observationState, REFERENCE_RNG_BLOCK_SIZE)
    }
  }
  return true
}

/**
 * Identifies only the starting rarity-8 Normal Artian Counter of one weapon
 * type for an already-known canonical Base Seed (`docs/RNG_SPEC.md` 9.12).
 *
 * The walk positions the Production PRNG at the first candidate block once
 * and steps ten words per Counter afterwards, so the correctness authority
 * stays `ProductionRngEngine.predictNormalArtian()`: the same seed derivation,
 * block addressing, game-verified pool, and pool step are shared, and nothing
 * is re-derived. Observations of both lottery tables walk the one shared
 * Counter; each observation is matched against the pool of its own table.
 */
export async function identifyNormalArtianCounter(
  input: NormalArtianCounterIdentificationInput,
  engine: RngEngine,
  options: NormalArtianCounterIdentificationExecutionOptions = {},
): Promise<NormalArtianCounterIdentificationResult> {
  const baseSeed = validateInput(input, engine)
  const tableClasses = distinctTableClasses(input.observations)
  requirePredictionSupport(input, tableClasses, engine)
  const observations = compileObservations(input, tableClasses)
  const chunkSize = options.counterChunkSize ?? DEFAULT_COUNTER_CHUNK_SIZE
  requireSafeInteger(chunkSize, 'Counter chunk size')
  if (chunkSize < 1) {
    throw new NormalArtianCounterIdentificationError(
      'invalid_input',
      'Counter chunk size must be at least 1.',
    )
  }
  const shouldCancel = options.shouldCancel ?? (() => false)
  const yieldControl = options.yieldControl ?? (() => Promise.resolve())
  const range = input.normalCounterRange
  const totalCounters = range.endInclusive - range.startInclusive + 1
  const initialized = initializeReferencePrng(
    deriveNormalArtianSeed(baseSeed, input.weaponTypeId, input.rarity),
  )
  let blockState = applyReferencePrngJump(
    compileReferencePrngJump(range.startInclusive * REFERENCE_RNG_BLOCK_SIZE),
    initialized,
  )
  const matches: { startNormalCounter: number }[] = []
  let searchedCounters = 0
  let completedCounter = range.startInclusive - 1
  let stoppedByLimit = false

  for (
    let chunkStart = range.startInclusive;
    chunkStart <= range.endInclusive;
    chunkStart += chunkSize
  ) {
    if (shouldCancel()) {
      throw new NormalArtianCounterIdentificationError(
        'cancelled',
        'Normal Artian Counter identification was cancelled.',
      )
    }
    const chunkEnd = Math.min(range.endInclusive, chunkStart + chunkSize - 1)
    for (let counter = chunkStart; counter <= chunkEnd; counter += 1) {
      if (matchesObservations(blockState, observations)) {
        matches.push({ startNormalCounter: counter })
      }
      searchedCounters += 1
      completedCounter = counter
      if (input.maxMatches !== undefined && matches.length >= input.maxMatches) {
        stoppedByLimit = counter < range.endInclusive
        break
      }
      if (counter < range.endInclusive) {
        blockState = advance(blockState, REFERENCE_RNG_BLOCK_SIZE)
      }
    }

    options.onProgress?.({ searchedCounters, totalCounters, matchesFound: matches.length })
    if (stoppedByLimit) break
    await yieldControl()
  }

  if (shouldCancel()) {
    throw new NormalArtianCounterIdentificationError(
      'cancelled',
      'Normal Artian Counter identification was cancelled.',
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
