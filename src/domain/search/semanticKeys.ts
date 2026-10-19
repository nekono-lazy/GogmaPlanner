import type {
  OwnedWeaponId,
  RestorationBonusScope,
  RestorationBonusSet,
} from '../models/publicTypes'
import { stableStringify } from '../models/publicTypes'

export function compareStableKeys(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * 0 when a Route starting from `sourceOwnedWeaponId` is the one its Target
 * prefers, 1 otherwise, so a plain ascending comparison puts preferred first
 * (`docs/SEARCH_SPEC.md` 8.1).
 *
 * The source ID is the whole test. A new-Normal Route has no owned source, so
 * it is never preferred, and a Target with no preference disables the rule
 * entirely rather than matching every `null` source: without this guard a
 * new-Normal Route would rank ahead of every owned-source Route the moment a
 * Target left its preference unset.
 */
export function preferredSourceRank(
  sourceOwnedWeaponId: OwnedWeaponId | null,
  preferredOwnedWeaponId: OwnedWeaponId | null,
): number {
  if (preferredOwnedWeaponId === null) return 0
  return sourceOwnedWeaponId === preferredOwnedWeaponId ? 0 : 1
}

/** Completed five-slot identity: order independent, duplicates preserved. */
export function canonicalBonusMultiset(bonuses: RestorationBonusSet): string[] {
  return bonuses.map(({ bonusTypeId, bonusRankId }) =>
    stableStringify([bonusTypeId, bonusRankId]),
  ).sort(compareStableKeys)
}

/**
 * Pure unordered five-slot multiset key, with duplicate counts preserved.
 * Structural slot encoding avoids collisions between IDs containing delimiters.
 * Stream retention additionally requires scope; use bonusSolutionRetentionKey.
 */
export function bonusOutcomeKey(bonuses: RestorationBonusSet): string {
  return stableStringify(canonicalBonusMultiset(bonuses))
}

/** SEARCH_SPEC 5.5.3 initial-Search identity, not permanent dominance. */
export function bonusSolutionRetentionKey(
  bonuses: RestorationBonusSet,
  restorationBonusScope: RestorationBonusScope,
): string {
  return stableStringify([restorationBonusScope, bonusOutcomeKey(bonuses)])
}
