import type {
  ElementId,
  GroupSkillId,
  SeriesSkillId,
  WeaponTypeId,
} from '../../models/publicTypes'
import { readReferenceRngBlock } from './referencePrng'
import {
  REFERENCE_SKILL_COMBINATION_COUNT,
  referenceSkillCombinationFromIndex,
} from './referenceSkillPools'
import { deriveSkillSeed } from './seedDerivation'

/** The reference Skill counter gate is 0x36 (54). */
export const REFERENCE_SKILL_COUNTER_GATE_THRESHOLD = 54

export interface ReferenceSkillPredictionInput {
  readonly baseSeed: number
  readonly weaponTypeId: WeaponTypeId
  readonly elementId: ElementId
  readonly skillCounter: number
  readonly counterGate: number
}

export interface ReferenceSkillPredictionResult {
  readonly seriesSkillId: SeriesSkillId
  readonly groupSkillId: GroupSkillId
  readonly effectiveBlock: number
  readonly combinationIndex: number
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

/**
 * Predicts one Skill stream result using the pinned reference algorithm.
 * Gate selection changes only the prediction block; it never changes the
 * persisted Domain Skill Counter or its operation-level +1 contract.
 */
export function predictReferenceSkills(
  input: ReferenceSkillPredictionInput,
): ReferenceSkillPredictionResult {
  requireNonNegativeSafeInteger(input.skillCounter, 'Skill counter')
  requireNonNegativeSafeInteger(input.counterGate, 'Counter gate')

  const effectiveBlock =
    input.counterGate < REFERENCE_SKILL_COUNTER_GATE_THRESHOLD
      ? 0
      : input.skillCounter
  const seed = deriveSkillSeed(input.baseSeed, input.weaponTypeId, input.elementId)

  // GARP.lua `predict_skill_route` advances to a block, then uses exactly its
  // first post-step raw `w` word for `w % 294`; it draws no separate values.
  const rawValue = readReferenceRngBlock(seed, effectiveBlock).values[0]
  if (rawValue === undefined) {
    throw new Error('Reference RNG block is missing its first raw value')
  }
  const combinationIndex = rawValue % REFERENCE_SKILL_COMBINATION_COUNT
  const combination = referenceSkillCombinationFromIndex(combinationIndex)

  return {
    seriesSkillId: combination.seriesSkillId,
    groupSkillId: combination.groupSkillId,
    effectiveBlock,
    combinationIndex,
  }
}
