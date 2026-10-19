/**
 * The Normal Artian lottery table class (`docs/RNG_SPEC.md` 6.3.1 / 9.12).
 *
 * The Normal seed is Base Seed + weapon type + rarity; the element never
 * enters it, and every element of one weapon type shares one Normal Counter.
 * What the element decides is only which candidate pool one forge draws from,
 * and the real game groups the elements of a weapon type into two tables:
 *
 * - Bow: Table A = Fire / Water / Thunder / Ice / Dragon / Blast,
 *   Table B = none / Poison / Paralysis / Sleep
 *   (`docs/RNG_REFERENCE_AUDIT.md` 14.15)
 * - Melee (every melee weapon type except Switch Axe): Table A = any
 *   attribute, Table B = none
 * - Light / Heavy Bowgun: both tables draw the same pool
 * - Switch Axe: the game uses one table for every configuration, so both
 *   classes draw the same single pool; the class is only the Identification
 *   observation adapter there (`docs/RNG_REFERENCE_AUDIT.md` 14.16)
 *
 * A table class is never a Counter stream. Forging a Table A weapon and then a
 * Table B weapon of the same weapon type consumes Counter C and C + 1 of the
 * one shared Counter. It is therefore never persisted, never part of
 * `NormalArtianCounter.id`, and never a Counter Search dimension.
 *
 * This module holds only the shared type so that Production pool selection
 * and Counter Identification can both depend on it without either depending
 * on the other's internals. Which element of which weapon type belongs to
 * which table is Production semantics and lives in
 * `production/gameNormalBonuses.ts`.
 */
export type NormalArtianLotteryTableClass = 'table_a' | 'table_b'

export const NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES: readonly NormalArtianLotteryTableClass[] = [
  'table_a',
  'table_b',
]

export function isNormalArtianLotteryTableClass(value: unknown): value is NormalArtianLotteryTableClass {
  return NORMAL_ARTIAN_LOTTERY_TABLE_CLASSES.includes(value as NormalArtianLotteryTableClass)
}
