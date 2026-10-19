import type { BonusTypeId, RestorationBonus, RestorationBonusSet } from '../../models/publicTypes'

/**
 * Reference-only mapping from GARP.lua v0.9.4 `gogma_bonus_ids`,
 * `gogma_repeat_penalty`, `gogma_keep_family`, and `build_gogma_pool` at
 * WiseHorror/Gogma-Artian-Roll-Planner
 * @ eceb2bd9ca6f4897ec516387acab2ad6beb8b38b.
 */
export type ReferenceGogmaBonusFamily = 'attack' | 'affinity' | 'element' | 'sharpness_capacity'

export interface ReferenceGogmaBonus {
  readonly referenceId: number
  readonly family: ReferenceGogmaBonusFamily
  readonly repeatPenalty: 50 | 80
  readonly bonus: Readonly<RestorationBonus>
}

/** Exact Reset candidate order from the pinned `gogma_bonus_ids` table. */
export const REFERENCE_GOGMA_RESET_CANDIDATES: readonly ReferenceGogmaBonus[] = [
  { referenceId: 8, family: 'attack', repeatPenalty: 50, bonus: { bonusTypeId: 'bonus_type.attack', bonusRankId: 'bonus_rank.ii' } },
  { referenceId: 12, family: 'attack', repeatPenalty: 50, bonus: { bonusTypeId: 'bonus_type.attack', bonusRankId: 'bonus_rank.iii' } },
  { referenceId: 15, family: 'attack', repeatPenalty: 80, bonus: { bonusTypeId: 'bonus_type.attack', bonusRankId: 'bonus_rank.ex' } },
  { referenceId: 9, family: 'affinity', repeatPenalty: 50, bonus: { bonusTypeId: 'bonus_type.affinity', bonusRankId: 'bonus_rank.ii' } },
  { referenceId: 13, family: 'affinity', repeatPenalty: 50, bonus: { bonusTypeId: 'bonus_type.affinity', bonusRankId: 'bonus_rank.iii' } },
  { referenceId: 16, family: 'affinity', repeatPenalty: 80, bonus: { bonusTypeId: 'bonus_type.affinity', bonusRankId: 'bonus_rank.ex' } },
  { referenceId: 11, family: 'element', repeatPenalty: 50, bonus: { bonusTypeId: 'bonus_type.element', bonusRankId: 'bonus_rank.ii' } },
  { referenceId: 14, family: 'element', repeatPenalty: 80, bonus: { bonusTypeId: 'bonus_type.element', bonusRankId: 'bonus_rank.ex' } },
  { referenceId: 6, family: 'sharpness_capacity', repeatPenalty: 50, bonus: { bonusTypeId: 'bonus_type.gogma_sharpness_capacity', bonusRankId: 'bonus_rank.base' } },
  { referenceId: 10, family: 'sharpness_capacity', repeatPenalty: 80, bonus: { bonusTypeId: 'bonus_type.gogma_sharpness_capacity', bonusRankId: 'bonus_rank.ex' } },
]

const BONUS_BY_REFERENCE_ID = new Map(REFERENCE_GOGMA_RESET_CANDIDATES.map((entry) => [entry.referenceId, entry]))

function semanticBonusKey(bonus: RestorationBonus): string {
  return `${bonus.bonusTypeId}\u0000${bonus.bonusRankId}`
}

const REFERENCE_ID_BY_SEMANTIC_BONUS = new Map(REFERENCE_GOGMA_RESET_CANDIDATES.map((entry) => [semanticBonusKey(entry.bonus), entry.referenceId]))

function requireReferenceBonus(referenceId: number): ReferenceGogmaBonus {
  const entry = BONUS_BY_REFERENCE_ID.get(referenceId)
  if (!entry) throw new RangeError(`Unsupported reference Gogma bonus ID: ${referenceId}`)
  return entry
}

/** Converts a private reference ID into a fresh semantic Domain bonus value. */
export function restorationBonusFromReferenceGogmaId(referenceId: number): RestorationBonus {
  return { ...requireReferenceBonus(referenceId).bonus }
}

/**
 * The reference ID of a semantic bonus the reference lottery can actually draw.
 *
 * This is the Reset/Keep **result** namespace, so it stays limited to
 * `REFERENCE_GOGMA_RESET_CANDIDATES`. It is not the Keep **current input**
 * check: a current slot only selects its family, read from its bonus type
 * alone (see `keepCurrentBonusFamily`), and its tier is never looked up here.
 */
export function referenceGogmaIdFromRestorationBonus(bonus: RestorationBonus): number {
  const referenceId = REFERENCE_ID_BY_SEMANTIC_BONUS.get(semanticBonusKey(bonus))
  if (referenceId === undefined) {
    throw new RangeError(`Unsupported semantic reference Gogma lottery result: ${bonus.bonusTypeId} / ${bonus.bonusRankId}`)
  }
  return referenceId
}

export function referenceGogmaBonusFamily(referenceId: number): ReferenceGogmaBonusFamily {
  return requireReferenceBonus(referenceId).family
}

/**
 * The reference `keepFamily` of a semantic bonus type.
 *
 * Every candidate of one reference family shares exactly one `bonusTypeId` in
 * the pinned table above, so a slot's family is decided by its bonus type
 * alone. This only reads the pinned grouping: it introduces no reference ID,
 * no new draw candidate, and no assumption about which tiers a slot may hold.
 * The tier of a current bonus is deliberately not consulted here, because Keep
 * preserves the family and rerolls the tier (`docs/RNG_SPEC.md` 6.1).
 */
const FAMILY_BY_BONUS_TYPE: ReadonlyMap<BonusTypeId, ReferenceGogmaBonusFamily> = (() => {
  const families = new Map<BonusTypeId, ReferenceGogmaBonusFamily>()
  for (const candidate of REFERENCE_GOGMA_RESET_CANDIDATES) {
    const existing = families.get(candidate.bonus.bonusTypeId)
    if (existing !== undefined && existing !== candidate.family) {
      throw new Error(`Reference Gogma bonus type maps to more than one Keep family: ${candidate.bonus.bonusTypeId}`)
    }
    families.set(candidate.bonus.bonusTypeId, candidate.family)
  }
  return families
})()

/** Null when the bonus type has no reference Keep family at all. */
export function referenceGogmaKeepFamilyForBonusType(
  bonusTypeId: BonusTypeId,
): ReferenceGogmaBonusFamily | null {
  return FAMILY_BY_BONUS_TYPE.get(bonusTypeId) ?? null
}

/** The exact reference `keepFamily` candidate order of one family. */
export function referenceGogmaKeepFamilyCandidatesForFamily(
  family: ReferenceGogmaBonusFamily,
): readonly ReferenceGogmaBonus[] {
  return REFERENCE_GOGMA_RESET_CANDIDATES.filter((entry) => entry.family === family)
}

/** The exact reference `keepFamily` candidate order for one reference ID. */
export function referenceGogmaKeepFamilyCandidates(referenceId: number): readonly ReferenceGogmaBonus[] {
  return referenceGogmaKeepFamilyCandidatesForFamily(referenceGogmaBonusFamily(referenceId))
}

/** Builds a strongly typed five-slot Domain result from reference IDs. */
export function restorationBonusSetFromReferenceGogmaIds(referenceIds: readonly number[]): RestorationBonusSet {
  if (referenceIds.length !== 5) throw new RangeError('Reference Gogma result must contain exactly five bonuses')
  return [
    restorationBonusFromReferenceGogmaId(referenceIds[0]!),
    restorationBonusFromReferenceGogmaId(referenceIds[1]!),
    restorationBonusFromReferenceGogmaId(referenceIds[2]!),
    restorationBonusFromReferenceGogmaId(referenceIds[3]!),
    restorationBonusFromReferenceGogmaId(referenceIds[4]!),
  ]
}
