import type { ReferenceGogmaBonus } from './referenceGogmaBonuses'

export interface ReferenceWeightedGogmaCandidate {
  readonly bonus: ReferenceGogmaBonus
  readonly weight: number
}

/** Exact pinned-reference `buildGogmaPool` weights; repetition is exact ID only. */
export function buildReferenceWeightedGogmaPool(
  candidates: readonly ReferenceGogmaBonus[],
  selectedReferenceIds: readonly number[],
): readonly ReferenceWeightedGogmaCandidate[] {
  return candidates.flatMap((bonus) => {
    let occurrenceCount = 0
    for (const selectedId of selectedReferenceIds) {
      if (selectedId === bonus.referenceId) occurrenceCount += 1
    }
    const weight = Math.max(0, 100 - occurrenceCount * bonus.repeatPenalty)
    return weight > 0 ? [{ bonus, weight }] : []
  })
}

/** Exact reference draw: `w % total`, then candidate-order subtraction. */
export function drawReferenceWeightedGogmaBonus(
  rawValue: number,
  pool: readonly ReferenceWeightedGogmaCandidate[],
): number {
  let totalWeight = 0
  for (const entry of pool) totalWeight += entry.weight
  if (totalWeight <= 0) throw new RangeError('Reference Gogma weighted pool has no positive weight')

  let roll = rawValue % totalWeight
  for (const entry of pool) {
    if (roll < entry.weight) return entry.bonus.referenceId
    roll -= entry.weight
  }
  throw new Error('Reference Gogma weighted draw exhausted its positive pool')
}
