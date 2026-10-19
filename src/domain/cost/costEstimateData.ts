import type { WeaponTypeId } from '../models/publicTypes'

/*
 * Display-only cost estimate data (`docs/REQUIREMENTS.md` 22.1,
 * `docs/SEARCH_SPEC.md` 4.3, `docs/MASTER_DATA.md` 13.1).
 *
 * These figures answer one question only: roughly how many game items and how
 * much zenny a Candidate Route or a ProductionPlan needs. They are never a
 * Search, Planner or Execution input, never persisted, never hashed, and never
 * compared between Candidates. They are deliberately kept out of the
 * `MaterialMaster` / `MaterialCostMaster` model, whose additive per-operation
 * shape cannot express an alternative cost (ナナイロカネ OR 歴戦錬磨の証), the
 * two device counts of a Skill reassignment, or a cost that applies to the
 * production-target Normal only.
 *
 * Provenance (never to be confused with the Production RNG `game-verified` /
 * `reference-verified` terms, which describe RNG prediction only):
 *
 * - project owner direct game observation: the 10,000z of one rarity-8 Normal
 *   Artian forge and the 30,000z of one Normal -> Gogma conversion
 * - reference information adopted for this task: the full restoration of the
 *   production-target Normal (ナナイロカネ x50 / 10,000z), Reset / Keep Bonuses
 *   (ナナイロカネ x20 or 歴戦錬磨の証 x2 / 5,000z), the Skill reassignment
 *   (油濁した遺装置 x6 when a different 激化 type is used, x3 with the same type
 *   as the conversion / 9,000z), and the fixed rarity-8 Artian part recipe of
 *   each of the 14 weapon types
 */

/** The four rarity-8 Artian parts. Stable IDs, never display names. */
export type ArtianPartId =
  | 'artian_part.broken_blade'
  | 'artian_part.crushed_tube'
  | 'artian_part.cracked_disc'
  | 'artian_part.rusted_device'

/** Fixed display order of the parts, shared by every recipe and summary. */
export const ARTIAN_PART_IDS: readonly ArtianPartId[] = [
  'artian_part.broken_blade',
  'artian_part.crushed_tube',
  'artian_part.cracked_disc',
  'artian_part.rusted_device',
]

export interface ArtianPartRequirement {
  partId: ArtianPartId
  quantity: number
}

/** Every rarity-8 Normal Artian forge consumes exactly three parts. */
export const RARE8_ARTIAN_PARTS_PER_FORGE = 3

/**
 * The fixed rarity-8 part recipe of each weapon type, keyed by the Master
 * `WeaponTypeId`. Every recipe sums to `RARE8_ARTIAN_PARTS_PER_FORGE`.
 */
const RARE8_ARTIAN_PART_RECIPES: ReadonlyMap<WeaponTypeId, readonly ArtianPartRequirement[]> =
  new Map<WeaponTypeId, readonly ArtianPartRequirement[]>([
    ['weapon.great_sword', [
      { partId: 'artian_part.broken_blade', quantity: 2 },
      { partId: 'artian_part.crushed_tube', quantity: 1 },
    ]],
    ['weapon.long_sword', [
      { partId: 'artian_part.broken_blade', quantity: 1 },
      { partId: 'artian_part.crushed_tube', quantity: 2 },
    ]],
    ['weapon.sword_and_shield', [
      { partId: 'artian_part.broken_blade', quantity: 1 },
      { partId: 'artian_part.crushed_tube', quantity: 1 },
      { partId: 'artian_part.cracked_disc', quantity: 1 },
    ]],
    ['weapon.dual_blades', [
      { partId: 'artian_part.broken_blade', quantity: 2 },
      { partId: 'artian_part.cracked_disc', quantity: 1 },
    ]],
    ['weapon.hammer', [
      { partId: 'artian_part.cracked_disc', quantity: 2 },
      { partId: 'artian_part.crushed_tube', quantity: 1 },
    ]],
    ['weapon.hunting_horn', [
      { partId: 'artian_part.cracked_disc', quantity: 1 },
      { partId: 'artian_part.rusted_device', quantity: 2 },
    ]],
    ['weapon.lance', [
      { partId: 'artian_part.broken_blade', quantity: 1 },
      { partId: 'artian_part.cracked_disc', quantity: 2 },
    ]],
    ['weapon.gunlance', [
      { partId: 'artian_part.cracked_disc', quantity: 2 },
      { partId: 'artian_part.rusted_device', quantity: 1 },
    ]],
    ['weapon.switch_axe', [
      { partId: 'artian_part.broken_blade', quantity: 2 },
      { partId: 'artian_part.rusted_device', quantity: 1 },
    ]],
    ['weapon.charge_blade', [
      { partId: 'artian_part.broken_blade', quantity: 1 },
      { partId: 'artian_part.cracked_disc', quantity: 1 },
      { partId: 'artian_part.rusted_device', quantity: 1 },
    ]],
    ['weapon.insect_glaive', [
      { partId: 'artian_part.broken_blade', quantity: 1 },
      { partId: 'artian_part.crushed_tube', quantity: 1 },
      { partId: 'artian_part.rusted_device', quantity: 1 },
    ]],
    ['weapon.light_bowgun', [
      { partId: 'artian_part.crushed_tube', quantity: 1 },
      { partId: 'artian_part.rusted_device', quantity: 2 },
    ]],
    ['weapon.heavy_bowgun', [
      { partId: 'artian_part.cracked_disc', quantity: 1 },
      { partId: 'artian_part.crushed_tube', quantity: 1 },
      { partId: 'artian_part.rusted_device', quantity: 1 },
    ]],
    ['weapon.bow', [
      { partId: 'artian_part.crushed_tube', quantity: 2 },
      { partId: 'artian_part.rusted_device', quantity: 1 },
    ]],
  ])

/** The weapon types a part recipe is defined for, in Map insertion order. */
export const RARE8_ARTIAN_PART_RECIPE_WEAPON_TYPE_IDS: readonly WeaponTypeId[] = [
  ...RARE8_ARTIAN_PART_RECIPES.keys(),
]

/**
 * The rarity-8 part recipe of one forge of `weaponTypeId`, or `null` when the
 * weapon type has no defined recipe. Nothing is guessed for an unknown type:
 * the caller reports such forges as unpriced instead.
 */
export function getRare8ArtianPartRecipe(
  weaponTypeId: WeaponTypeId,
): readonly ArtianPartRequirement[] | null {
  return RARE8_ARTIAN_PART_RECIPES.get(weaponTypeId) ?? null
}

/** One rarity-8 Normal Artian forge (project owner direct game observation). */
export const NORMAL_ARTIAN_FORGE_ZENNY = 10_000

/** Full restoration of the production-target Normal, once per new-Normal Route. */
export const NORMAL_FULL_RESTORATION_NANAIRO_KANE = 50
export const NORMAL_FULL_RESTORATION_ZENNY = 10_000

/** Normal -> Gogma conversion: 油濁した遺装置 of one 激化 type (project owner direct game observation for the zenny). */
export const CONVERSION_DEVICE_COUNT = 3
export const CONVERSION_ZENNY = 30_000

/** Reset Bonuses / Keep Bonuses, each: ナナイロカネ OR 歴戦錬磨の証 (alternative, never both). */
export const GOGMA_RESTORATION_NANAIRO_KANE = 20
export const GOGMA_RESTORATION_TICKET_COUNT = 2
export const GOGMA_RESTORATION_ZENNY = 5_000

/**
 * Reset Skills, each. The primary figure is the device count when a 激化 type
 * different from the conversion's is used; the same type halves it. The
 * alchemy conversion from 歴戦錬磨の証 is deliberately not represented.
 */
export const SKILL_REASSIGNMENT_DEVICE_COUNT_DIFFERENT_TYPE = 6
export const SKILL_REASSIGNMENT_DEVICE_COUNT_SAME_TYPE = 3
export const SKILL_REASSIGNMENT_ZENNY = 9_000
