import type { ArtianBonusTypeMapping } from '../master/masterTypes'
import type { BonusTypeId, RestorationBonus, RestorationBonusSet } from '../models/publicTypes'

/**
 * The Master subset Keep family resolution reads.
 *
 * `ArtianBonusTypeMapping` (`src/data/master/artian-bonus-type-mappings.json`)
 * is the single authority for the Normal-side -> Gogma-side bonus type
 * correspondence. Search and Production RNG both resolve families through this
 * module, so no second mapping table exists anywhere.
 */
export interface KeepFamilyMasterSubset {
  artianBonusTypeMappings: readonly ArtianBonusTypeMapping[]
}

/**
 * The Keep family of one bonus type, expressed as the Gogma-side bonus type.
 *
 * Keep Bonuses has no slot selection: it preserves the bonus family at each of
 * the current five slot positions and rerolls only the tier within that family
 * (`AGENTS.md` RNG Rules, `docs/RNG_SPEC.md` 6.1). The family is decided by the
 * bonus type alone, independently of the slot's `restorationBonusScope` and of
 * its `bonusRankId`:
 *
 * - a Normal-side bonus type (`bonus_type.normal_sharpness`,
 *   `bonus_type.normal_capacity`, ...) is normalized to its Gogma-side type
 *   through the Master mapping, which is many-to-one for Sharpness / Capacity
 * - any other bonus type is already a Gogma-side family and maps to itself
 *   (`bonus_type.attack` maps to itself through the Master as well)
 *
 * Whether a scope / rank combination is a legal persisted value is Master /
 * Domain validation, never this resolver: Keep RNG reads families only.
 */
export function keepFamilyBonusTypeId(
  bonusTypeId: BonusTypeId,
  master: KeepFamilyMasterSubset,
): BonusTypeId {
  const mapping = master.artianBonusTypeMappings.find(
    (entry) => entry.normalBonusTypeId === bonusTypeId,
  )
  return mapping ? mapping.gogmaBonusTypeId : bonusTypeId
}

/** The Keep family of one current slot; only its bonus type is read. */
export function keepFamilyOfBonus(
  bonus: RestorationBonus,
  master: KeepFamilyMasterSubset,
): BonusTypeId {
  return keepFamilyBonusTypeId(bonus.bonusTypeId, master)
}

/**
 * The ordered slot family layout of a complete five-slot current bonus set.
 *
 * Slot order is semantic here: Keep keeps each family in its own position, so
 * `[A, B, A, B, A]` and `[B, A, A, B, A]` are different layouts. The key must
 * never be normalized into an unordered multiset. Two sets that differ only in
 * tier, or only in Normal-side versus Gogma-side spelling of the same family,
 * share one layout.
 */
export function keepFamilyLayout(
  bonuses: RestorationBonusSet,
  master: KeepFamilyMasterSubset,
): BonusTypeId[] {
  return bonuses.map((bonus) => keepFamilyOfBonus(bonus, master))
}

export function keepFamilyLayoutKey(
  bonuses: RestorationBonusSet,
  master: KeepFamilyMasterSubset,
): string {
  return keepFamilyLayout(bonuses, master).join('\u0000')
}

/** Unordered family counts for Keep reachability, NOT a Keep stream identity. */
export function keepFamilyMultisetKey(
  bonuses: RestorationBonusSet,
  master: KeepFamilyMasterSubset,
): string {
  return keepFamilyLayout(bonuses, master).sort().join('\u0000')
}
