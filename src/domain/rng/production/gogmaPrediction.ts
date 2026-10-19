import type { ElementId, RestorationBonusSet, WeaponTypeId } from '../../models/publicTypes'
import {
  buildProductionWeightedGogmaResetPool,
  productionGogmaResetCandidatesForWeaponAndElement,
} from './gameGogmaBonuses'
import { readReferenceRngBlock } from './referencePrng'
import {
  REFERENCE_GOGMA_RESET_CANDIDATES,
  type ReferenceGogmaBonus,
  type ReferenceGogmaBonusFamily,
  referenceGogmaKeepFamilyCandidatesForFamily,
  referenceGogmaKeepFamilyForBonusType,
  restorationBonusSetFromReferenceGogmaIds,
} from './referenceGogmaBonuses'
import { deriveGogmaSeed } from './seedDerivation'
import {
  buildReferenceWeightedGogmaPool,
  drawReferenceWeightedGogmaBonus,
} from './weightedDraw'

/** The pinned reference's Gogma counter gate is 0x23 (35). */
export const REFERENCE_GOGMA_COUNTER_GATE_THRESHOLD = 35

export interface ReferenceGogmaPredictionInput {
  readonly baseSeed: number
  readonly weaponTypeId: WeaponTypeId
  readonly elementId: ElementId
  readonly gogmaCounter: number
  readonly counterGate: number
}

export interface ReferenceGogmaKeepPredictionInput extends ReferenceGogmaPredictionInput {
  /**
   * Ordered current bonuses in the reference namespace: each slot's bonus type
   * is a Gogma-side family type and fixes its own family. A Normal-side type is
   * normalized by the Production adapter before it reaches here
   * (`toReferenceKeepCurrentBonuses`); the tier is never read.
   */
  readonly currentBonuses: RestorationBonusSet
}

export interface ReferenceGogmaPredictionResult {
  readonly bonuses: RestorationBonusSet
  readonly effectiveBlock: number
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function referenceGogmaBlock(input: ReferenceGogmaPredictionInput, readBlock: typeof readReferenceRngBlock): {
  effectiveBlock: number
  rawValues: readonly number[]
} {
  requireNonNegativeSafeInteger(input.gogmaCounter, 'Gogma counter')
  requireNonNegativeSafeInteger(input.counterGate, 'Counter gate')
  const effectiveBlock = input.counterGate < REFERENCE_GOGMA_COUNTER_GATE_THRESHOLD
    ? 0
    : input.gogmaCounter
  const seed = deriveGogmaSeed(input.baseSeed, input.weaponTypeId, input.elementId)
  return { effectiveBlock, rawValues: readBlock(seed, effectiveBlock).values }
}

function predictReferenceGogmaSlots(
  rawValues: readonly number[],
  candidatesForSlot: (slot: number) => readonly ReferenceGogmaBonus[],
): RestorationBonusSet {
  const selectedReferenceIds: number[] = []
  for (let slot = 0; slot < 5; slot += 1) {
    const rawValue = rawValues[slot]
    if (rawValue === undefined) {
      throw new Error(`Reference Gogma block is missing raw value for slot ${slot + 1}`)
    }
    const pool = buildReferenceWeightedGogmaPool(candidatesForSlot(slot), selectedReferenceIds)
    selectedReferenceIds.push(drawReferenceWeightedGogmaBonus(rawValue, pool))
  }
  return restorationBonusSetFromReferenceGogmaIds(selectedReferenceIds)
}

/**
 * The Production Reset draw over already-compiled Production candidates
 * (`productionGogmaResetCandidatesForWeaponAndElement`). It is the single draw
 * path shared by `predictProductionGogmaReset` and Gogma Counter
 * Identification: the reference raw values, candidate order, and
 * `w % total` subtraction are unchanged, and only the per-slot pool adds the
 * Production Sharpness/Capacity family limit (`docs/RNG_SPEC.md` 6.1.1).
 */
export function predictProductionGogmaResetSlotsFromRawValues(
  rawValues: readonly number[],
  candidates: readonly ReferenceGogmaBonus[],
): RestorationBonusSet {
  const selectedReferenceIds: number[] = []
  for (let slot = 0; slot < 5; slot += 1) {
    const rawValue = rawValues[slot]
    if (rawValue === undefined) {
      throw new Error(`Reference Gogma block is missing raw value for slot ${slot + 1}`)
    }
    const pool = buildProductionWeightedGogmaResetPool(candidates, selectedReferenceIds)
    selectedReferenceIds.push(drawReferenceWeightedGogmaBonus(rawValue, pool))
  }
  return restorationBonusSetFromReferenceGogmaIds(selectedReferenceIds)
}

/** Reset ignores the prior set and redraws all five slots from the fixed pool. */
export function predictReferenceGogmaReset(input: ReferenceGogmaPredictionInput, readBlock = readReferenceRngBlock): ReferenceGogmaPredictionResult {
  const { effectiveBlock, rawValues } = referenceGogmaBlock(input, readBlock)
  return {
    bonuses: predictReferenceGogmaSlots(rawValues, () => REFERENCE_GOGMA_RESET_CANDIDATES),
    effectiveBlock,
  }
}

/**
 * Production Gogma Reset (`docs/RNG_SPEC.md` 6.1.1): the fixed reference
 * Reset order filtered to the Production Normal pool family set of the same
 * weapon type + element, drawn with the exact-ID repeat penalty plus the
 * Sharpness/Capacity family limit of two. Seed derivation, block consumption,
 * and draw order are the reference ones. No Master availability is read.
 */
export function predictProductionGogmaReset(
  input: ReferenceGogmaPredictionInput,
  readBlock = readReferenceRngBlock,
): ReferenceGogmaPredictionResult {
  const { effectiveBlock, rawValues } = referenceGogmaBlock(input, readBlock)
  const candidates = productionGogmaResetCandidatesForWeaponAndElement(
    input.weaponTypeId,
    input.elementId,
  )
  return {
    bonuses: predictProductionGogmaResetSlotsFromRawValues(rawValues, candidates),
    effectiveBlock,
  }
}

/** The reference family of one current slot; the tier is deliberately not consulted. */
function requireReferenceKeepFamily(bonus: RestorationBonusSet[number]): ReferenceGogmaBonusFamily {
  const family = referenceGogmaKeepFamilyForBonusType(bonus.bonusTypeId)
  if (family === null) {
    throw new RangeError(`Unsupported reference Keep current bonus type: ${bonus.bonusTypeId}`)
  }
  return family
}

/** Keep redraws every slot from the explicit current slot's reference family. */
export function predictReferenceGogmaKeep(input: ReferenceGogmaKeepPredictionInput, readBlock = readReferenceRngBlock): ReferenceGogmaPredictionResult {
  if (!Array.isArray(input.currentBonuses) || input.currentBonuses.length !== 5) {
    throw new RangeError('Keep current bonuses must contain exactly five slots')
  }
  // Keep reads only the family of each current slot; the draw pool itself
  // stays the unchanged reference family candidate order.
  const currentFamilies = input.currentBonuses.map(requireReferenceKeepFamily)
  const { effectiveBlock, rawValues } = referenceGogmaBlock(input, readBlock)
  return {
    bonuses: predictReferenceGogmaSlots(
      rawValues,
      (slot) => referenceGogmaKeepFamilyCandidatesForFamily(currentFamilies[slot]!),
    ),
    effectiveBlock,
  }
}
