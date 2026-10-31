import type {
  BonusRankId,
  BonusTypeId,
  CompletionBonusVariant,
  RestorationBonusSet,
  TargetWeapon,
} from '../models/publicTypes'
import {
  assertCompletionVariantRankReferences,
  bonusRankOrder,
  completionBonusVariantKey,
  satisfiesVariant,
} from './completionCondition'
import { completionSkillVariantKey, completionSkillVariantsCompatible } from './completionSkillVariants'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

/**
 * The relation between the completion conditions of two Targets
 * (`docs/DATA_MODEL.md` 8.8, Issue #338).
 *
 * - `identical`: the same weapon type and element, the same set of normalized
 *   completion Variants and the same set of normalized completion Skill
 *   configurations (Issue #367)
 * - `overlapping`: not `identical`, but one weapon state (five `gogma_artian`
 *   slots and Series / Group Skills) can meet both completion conditions
 * - `disjoint`: neither
 *
 * Display-time judgement for the Target registration confirmation
 * (`docs/UI_FLOW.md` 8.5) only. It is never persisted, and Candidate Search,
 * the Planner and Execution never read it.
 */
export type TargetCompletionOverlap = 'identical' | 'overlapping' | 'disjoint'

/** The part of a Target the classification reads; nothing else of the Target matters. */
export type TargetCompletionDefinition = Pick<
  TargetWeapon,
  'weaponTypeId' | 'elementId' | 'completionBonusVariants' | 'completionSkillVariants'
>

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The completion Skill sides can hold together (`docs/DATA_MODEL.md` 8.8 rule
 * 2): some configuration of one and some configuration of the other are
 * compatible - each Skill unspecified (`null`) on either one or the same ID on
 * both.
 */
function skillVariantsCompatible(
  left: TargetCompletionDefinition['completionSkillVariants'],
  right: TargetCompletionDefinition['completionSkillVariants'],
): boolean {
  return left.some((a) => right.some((b) => completionSkillVariantsCompatible(a, b)))
}

/** The normalized Skill configurations as a set: configuration order, `id` and a repeated configuration never matter. */
function normalizedSkillKeySet(variants: TargetCompletionDefinition['completionSkillVariants']): Set<string> {
  return new Set(variants.map((variant) => completionSkillVariantKey(variant)))
}

/** The normalized Variants as a set: Variant order, `id` and a repeated Variant never matter. */
function normalizedVariantKeySet(variants: readonly Pick<CompletionBonusVariant, 'slots'>[]): Set<string> {
  return new Set(variants.map((variant) => completionBonusVariantKey(variant)))
}

function sameKeySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const key of left) {
    if (!right.has(key)) return false
  }
  return true
}

/** The minimum rank IDs of one Variant per bonus type (the type multiset is the keys with their counts). */
function minimumRanksByType(variant: Pick<CompletionBonusVariant, 'slots'>): Map<BonusTypeId, BonusRankId[]> {
  const byType = new Map<BonusTypeId, BonusRankId[]>()
  for (const { bonusTypeId, minimumRankId } of variant.slots) {
    const ranks = byType.get(bonusTypeId)
    if (ranks) ranks.push(minimumRankId)
    else byType.set(bonusTypeId, [minimumRankId])
  }
  return byType
}

/**
 * The five slots that meet both Variants, or `null` when none exists
 * (`docs/DATA_MODEL.md` 8.8 rule 3). Both slots sets must agree on the bonus
 * type multiset, because a Variant requires its type counts exactly. Then every
 * slot of a type takes the highest minimum either Variant names for that type -
 * by Master `order` alone, never by display name or ID spelling - and that five
 * slot set meets every required minimum of both. The witness is re-checked with
 * the shared `satisfiesVariant()`, so the decision never drifts from completion.
 */
function commonCompletionBonuses(
  left: Pick<CompletionBonusVariant, 'slots'>,
  right: Pick<CompletionBonusVariant, 'slots'>,
  master: TargetEvaluationMasterSubset,
): RestorationBonusSet | null {
  const leftRanks = minimumRanksByType(left)
  const rightRanks = minimumRanksByType(right)
  if (leftRanks.size !== rightRanks.size) return null
  const witness: { bonusTypeId: BonusTypeId; bonusRankId: BonusRankId }[] = []
  for (const [bonusTypeId, ranks] of leftRanks) {
    const others = rightRanks.get(bonusTypeId)
    if (!others || others.length !== ranks.length) return null
    let highest = ranks[0]!
    for (const rank of [...ranks, ...others]) {
      const order = bonusRankOrder(master, rank)
      const highestOrder = bonusRankOrder(master, highest)
      // Equal orders are one rank; the code unit tie-break only keeps the witness deterministic.
      if (order > highestOrder || (order === highestOrder && compareCodeUnits(rank, highest) < 0)) highest = rank
    }
    for (let index = 0; index < ranks.length; index++) witness.push({ bonusTypeId, bonusRankId: highest })
  }
  const bonuses = witness as RestorationBonusSet
  return satisfiesVariant(bonuses, left, master) && satisfiesVariant(bonuses, right, master) ? bonuses : null
}

/**
 * `classifyTargetCompletionOverlap(a, b, master)` (`docs/DATA_MODEL.md` 8.8):
 * the one authority of the Target registration confirmation. It reads the
 * weapon type, element, completion Variants and completion Skill
 * configurations only - never the name, memo, priority, enablement, lifecycle, preferred
 * owned weapon, completion assignment, Variant / configuration order or `id` - and
 * judges the definitions alone, never whether the RNG can produce the common
 * state. An unknown Bonus Rank reference raises the Master Domain Error.
 */
export function classifyTargetCompletionOverlap(
  a: TargetCompletionDefinition,
  b: TargetCompletionDefinition,
  master: TargetEvaluationMasterSubset,
): TargetCompletionOverlap {
  if (a.weaponTypeId !== b.weaponTypeId || a.elementId !== b.elementId) return 'disjoint'
  assertCompletionVariantRankReferences(a.completionBonusVariants, master)
  assertCompletionVariantRankReferences(b.completionBonusVariants, master)
  if (
    sameKeySet(normalizedSkillKeySet(a.completionSkillVariants), normalizedSkillKeySet(b.completionSkillVariants)) &&
    sameKeySet(normalizedVariantKeySet(a.completionBonusVariants), normalizedVariantKeySet(b.completionBonusVariants))
  ) {
    return 'identical'
  }
  if (!skillVariantsCompatible(a.completionSkillVariants, b.completionSkillVariants)) return 'disjoint'
  const overlaps = a.completionBonusVariants.some((left) =>
    b.completionBonusVariants.some((right) => commonCompletionBonuses(left, right, master) !== null),
  )
  return overlaps ? 'overlapping' : 'disjoint'
}

/** One other Target the save must be confirmed against (`docs/UI_FLOW.md` 8.5). */
export interface TargetCompletionOverlapConfirmation {
  target: TargetWeapon
  overlap: Exclude<TargetCompletionOverlap, 'disjoint'>
}

export interface TargetCompletionOverlapConfirmationInput {
  /** The Target exactly as the save would write it. */
  saved: TargetCompletionDefinition & Pick<TargetWeapon, 'id'>
  /** The stored definition the edit replaces, or `null` for a new Target. */
  before: TargetCompletionDefinition | null
  /** Every stored Target; the saved Target itself and completed Targets are skipped. */
  targets: readonly TargetWeapon[]
  master: TargetEvaluationMasterSubset
}

/**
 * The Targets a save of a Target must confirm (`docs/UI_FLOW.md` 8.5), in the
 * given order. Only other `active` Targets are compared - disabled ones and
 * those whose completion condition needs a review included, completed ones
 * not. A new Target confirms every `identical` / `overlapping` one. An edit
 * confirms only a relation it creates: `disjoint` before and `identical` /
 * `overlapping` after, or `overlapping` before and `identical` after. A
 * relation that holds both before and after was confirmed earlier and is never
 * asked again, so an edit that changes no completion condition confirms
 * nothing.
 */
export function findTargetCompletionOverlapConfirmations({
  saved,
  before,
  targets,
  master,
}: TargetCompletionOverlapConfirmationInput): TargetCompletionOverlapConfirmation[] {
  const confirmations: TargetCompletionOverlapConfirmation[] = []
  for (const target of targets) {
    if (target.id === saved.id || target.lifecycleStatus !== 'active') continue
    const after = classifyTargetCompletionOverlap(saved, target, master)
    if (after === 'disjoint') continue
    if (before !== null) {
      const previous = classifyTargetCompletionOverlap(before, target, master)
      const created = previous === 'disjoint' || (previous === 'overlapping' && after === 'identical')
      if (!created) continue
    }
    confirmations.push({ target, overlap: after })
  }
  return confirmations
}
