import { getBonusRank } from '../master/masterSelectors'
import type {
  BonusRankId,
  BonusTypeId,
  CompletionBonusSlot,
  CompletionBonusSlots,
  CompletionBonusVariant,
  GroupSkillId,
  RestorationBonus,
  RestorationBonusScope,
  RestorationBonusSet,
  SeriesSkillId,
  TargetWeapon,
} from '../models/publicTypes'
import { stableStringify } from '../models/hashing'
import { satisfiesCompletionSkills } from './completionSkillVariants'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

/**
 * The Target completion condition (`docs/DATA_MODEL.md` 8.1 / 8.2,
 * `docs/PLANNER_SPEC.md` 20.2, Issue #100).
 *
 * This module is the single authority Search, the Planner, the Build List
 * optimization, Execution and the owned-Ideal notice share:
 *
 * - `satisfiesVariant()` / `satisfiesCompletionBonuses()` /
 *   `satisfiesCompletionTarget()` decide completion (a truth value)
 * - `evaluateVariantPartialMatch()` / `selectClosestVariant()` are the separate
 *   partial match evaluation that orders Bonus stream solutions and explains
 *   the difference to the closest Variant. Neither ever stands in for the other
 *
 * Rank order is Master `BonusRankMaster.order` alone; `isEx`, display names and
 * ID spelling are never read. An unknown Bonus Rank reference raises the Master
 * Domain Error before any scope decision.
 */

/** Variant `id` used when a single Variant is created from five concrete slots (migration, drafts). */
export const DEFAULT_COMPLETION_BONUS_VARIANT_ID = 'completion-variant-1'

const rankOrderCache = new WeakMap<object, Map<BonusRankId, number>>()

function rankOrders(master: TargetEvaluationMasterSubset): Map<BonusRankId, number> {
  let orders = rankOrderCache.get(master.bonusRanks)
  if (!orders) {
    orders = new Map(master.bonusRanks.map((rank) => [rank.id, rank.order]))
    rankOrderCache.set(master.bonusRanks, orders)
  }
  return orders
}

/** The Master order of one Bonus Rank; an unknown ID raises the Master Domain Error. */
export function bonusRankOrder(master: TargetEvaluationMasterSubset, bonusRankId: BonusRankId): number {
  const order = rankOrders(master).get(bonusRankId)
  return order === undefined ? getBonusRank(master, bonusRankId).order : order
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The five slots of one Variant as `RestorationBonus`es, `bonusRankId` holding the minimum rank. */
export function completionVariantMinimumBonuses(variant: Pick<CompletionBonusVariant, 'slots'>): RestorationBonusSet {
  return variant.slots.map(({ bonusTypeId, minimumRankId }) => ({ bonusTypeId, bonusRankId: minimumRankId })) as RestorationBonusSet
}

/**
 * The normalized form of one Variant: its `(bonusTypeId, minimumRankId)` slots
 * as an unordered multiset with duplicate counts kept, sorted in
 * locale-independent code unit order. Slot order and Variant `id` never matter.
 */
export function normalizeCompletionBonusVariant(variant: Pick<CompletionBonusVariant, 'slots'>): CompletionBonusSlot[] {
  return variant.slots
    .map(({ bonusTypeId, minimumRankId }) => ({ bonusTypeId, minimumRankId }))
    .sort((left, right) => compareCodeUnits(stableStringify(left), stableStringify(right)))
}

/** The stable string of a Variant's normalized form (identity, hashing, tie-break). */
export function completionBonusVariantKey(variant: Pick<CompletionBonusVariant, 'slots'>): string {
  return stableStringify(normalizeCompletionBonusVariant(variant))
}

/** Every Variant of a Target in normalized form, sorted, so Variant order and `id` never matter. */
export function normalizeCompletionBonusVariants(
  variants: readonly Pick<CompletionBonusVariant, 'slots'>[],
): CompletionBonusSlot[][] {
  return variants
    .map((variant) => ({ key: completionBonusVariantKey(variant), slots: normalizeCompletionBonusVariant(variant) }))
    .sort((left, right) => compareCodeUnits(left.key, right.key))
    .map(({ slots }) => slots)
}

/**
 * One completion Variant whose minimum ranks are exactly the given five
 * concrete slots. The migration of a former Ideal five-slot set and a new
 * Target draft use it; the Variant then also accepts any higher rank.
 */
export function completionBonusVariantFromBonuses(
  bonuses: readonly RestorationBonus[],
  id: string = DEFAULT_COMPLETION_BONUS_VARIANT_ID,
): CompletionBonusVariant {
  if (bonuses.length !== 5) {
    throw new RangeError('A completion Variant needs exactly five slots.')
  }
  return {
    id,
    slots: bonuses.map(({ bonusTypeId, bonusRankId }) => ({
      bonusTypeId,
      minimumRankId: bonusRankId,
    })) as CompletionBonusSlots,
  }
}

function groupOrdersByType<T>(
  values: readonly T[],
  typeOf: (value: T) => BonusTypeId,
  orderOf: (value: T) => number,
): Map<BonusTypeId, { value: T; order: number }[]> {
  const groups = new Map<BonusTypeId, { value: T; order: number }[]>()
  for (const value of values) {
    const type = typeOf(value)
    const group = groups.get(type)
    const entry = { value, order: orderOf(value) }
    if (group) group.push(entry)
    else groups.set(type, [entry])
  }
  for (const group of groups.values()) group.sort((left, right) => left.order - right.order)
  return groups
}

function assertBonusReferences(bonuses: readonly RestorationBonus[], master: TargetEvaluationMasterSubset): void {
  bonuses.forEach((bonus) => bonusRankOrder(master, bonus.bonusRankId))
}

/** Raises the Master Domain Error for any unknown minimum rank of any Variant. */
export function assertCompletionVariantRankReferences(
  variants: readonly Pick<CompletionBonusVariant, 'slots'>[],
  master: TargetEvaluationMasterSubset,
): void {
  variants.forEach((variant) => variant.slots.forEach((slot) => bonusRankOrder(master, slot.minimumRankId)))
}

/**
 * `satisfiesVariant(A, v)` (`docs/DATA_MODEL.md` 8.2): a bijection between the
 * five required slots and the five actual slots exists that pairs equal bonus
 * types with an actual rank whose Master order is at least the required
 * minimum. The type counts must match exactly. Per type, the ascending
 * required orders are compared with the ascending actual orders index by index
 * (the Hall condition on a total order), so no actual slot is used twice.
 */
export function satisfiesVariant(
  bonuses: readonly RestorationBonus[],
  variant: Pick<CompletionBonusVariant, 'slots'>,
  master: TargetEvaluationMasterSubset,
): boolean {
  assertBonusReferences(bonuses, master)
  assertCompletionVariantRankReferences([variant], master)
  return createCompiledVariant(variant, master).satisfiedBy(actualOrdersByType(bonuses, master))
}

interface CompiledVariant {
  satisfiedBy(actual: Map<BonusTypeId, number[]>): boolean
}

function actualOrdersByType(
  bonuses: readonly RestorationBonus[],
  master: TargetEvaluationMasterSubset,
): Map<BonusTypeId, number[]> {
  const groups = new Map<BonusTypeId, number[]>()
  for (const bonus of bonuses) {
    const order = bonusRankOrder(master, bonus.bonusRankId)
    const group = groups.get(bonus.bonusTypeId)
    if (group) group.push(order)
    else groups.set(bonus.bonusTypeId, [order])
  }
  for (const group of groups.values()) group.sort((left, right) => left - right)
  return groups
}

function createCompiledVariant(
  variant: Pick<CompletionBonusVariant, 'slots'>,
  master: TargetEvaluationMasterSubset,
): CompiledVariant {
  const required = new Map<BonusTypeId, number[]>()
  groupOrdersByType(variant.slots, (slot) => slot.bonusTypeId, (slot) => bonusRankOrder(master, slot.minimumRankId))
    .forEach((entries, type) => required.set(type, entries.map(({ order }) => order)))
  return {
    satisfiedBy(actual) {
      if (actual.size !== required.size) return false
      for (const [type, minimums] of required) {
        const orders = actual.get(type)
        if (!orders || orders.length !== minimums.length) return false
        for (let index = 0; index < minimums.length; index++) {
          if (orders[index]! < minimums[index]!) return false
        }
      }
      return true
    },
  }
}

/**
 * A reusable completion Bonus predicate for one Target: the Variants are
 * compiled once, so hot paths (Search streams, the Build List optimization's
 * reach table) judge many five-slot sets without re-sorting the Variants.
 * `satisfies()` gives exactly `satisfiesCompletionBonuses()`.
 */
export interface CompletionBonusMatcher {
  satisfies(bonuses: readonly RestorationBonus[], scope: RestorationBonusScope): boolean
}

const compiledVariantCache = new WeakMap<object, WeakMap<object, CompiledVariant[]>>()

/**
 * The compiled Variants of one Variant list under one Master rank table. Search
 * and the reach table judge thousands of five-slot sets per Target, so the
 * compilation is memoized on the identity of the (never mutated) Variant list.
 */
function compiledVariants(
  variants: readonly CompletionBonusVariant[],
  master: TargetEvaluationMasterSubset,
): CompiledVariant[] {
  let byMaster = compiledVariantCache.get(variants)
  if (!byMaster) {
    byMaster = new WeakMap()
    compiledVariantCache.set(variants, byMaster)
  }
  let compiled = byMaster.get(master.bonusRanks)
  if (!compiled) {
    assertCompletionVariantRankReferences(variants, master)
    compiled = variants.map((variant) => createCompiledVariant(variant, master))
    byMaster.set(master.bonusRanks, compiled)
  }
  return compiled
}

export function createCompletionBonusMatcher(
  target: Pick<TargetWeapon, 'completionBonusVariants'>,
  master: TargetEvaluationMasterSubset,
): CompletionBonusMatcher {
  const variants = compiledVariants(target.completionBonusVariants, master)
  return {
    satisfies(bonuses, scope) {
      // Unknown rank references fail before the scope decision.
      const actual = actualOrdersByType(bonuses, master)
      return scope === 'gogma_artian' && variants.some((variant) => variant.satisfiedBy(actual))
    },
  }
}

/**
 * `satisfiesCompletionBonuses()` (`docs/PLANNER_SPEC.md` 20.2): the scope is
 * `gogma_artian` and at least one Variant is satisfied. Variants are equal; the
 * result is a truth value. Scope is an explicit argument, and unknown rank
 * references raise before it is read, exactly as for every scope.
 */
export function satisfiesCompletionBonuses(
  target: Pick<TargetWeapon, 'completionBonusVariants'>,
  bonuses: readonly RestorationBonus[],
  scope: RestorationBonusScope,
  master: TargetEvaluationMasterSubset,
): boolean {
  return createCompletionBonusMatcher(target, master).satisfies(bonuses, scope)
}

/**
 * `satisfiesCompletionTarget()` (`docs/PLANNER_SPEC.md` 20.2 / 22.2): the
 * completion Bonus predicate AND the completion Skill predicate (any
 * configuration, `satisfiesCompletionSkills()`). No Bonus Variant is paired
 * with a Skill configuration.
 */
export function satisfiesCompletionTarget(
  target: Pick<TargetWeapon, 'completionBonusVariants' | 'completionSkillVariants'>,
  bonuses: readonly RestorationBonus[],
  scope: RestorationBonusScope,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
  master: TargetEvaluationMasterSubset,
): boolean {
  return (
    satisfiesCompletionBonuses(target, bonuses, scope, master) &&
    satisfiesCompletionSkills(target, seriesSkillId, groupSkillId)
  )
}

/** Every Variant a concrete five-slot set satisfies (display-time re-judgement, `docs/REQUIREMENTS.md` 13.2). */
export function satisfiedCompletionBonusVariants(
  target: Pick<TargetWeapon, 'completionBonusVariants'>,
  bonuses: readonly RestorationBonus[],
  scope: RestorationBonusScope,
  master: TargetEvaluationMasterSubset,
): CompletionBonusVariant[] {
  if (scope !== 'gogma_artian') {
    assertBonusReferences(bonuses, master)
    return []
  }
  return target.completionBonusVariants.filter((variant) => satisfiesVariant(bonuses, variant, master))
}

/**
 * The partial match evaluation of one Variant against five actual slots
 * (`docs/DATA_MODEL.md` 8.2「部分一致評価」).
 *
 * - `matchedCount` is the first priority: the maximum number of pairs of equal
 *   bonus type whose actual rank order is at least the required minimum, each
 *   slot used once. It is defined for any type counts and ignores scope
 * - `exactCount` is the second priority's value (pairs whose orders are equal)
 *   of the one mapping that also decides `missingBonuses` / `extraBonuses`. It
 *   is a display property only, never an ordering key
 * - `missingBonuses` are the unmatched required slots as
 *   `{ bonusTypeId, bonusRankId: minimumRankId }` ("this rank or higher");
 *   `extraBonuses` are the unmatched actual slots as they are
 *
 * The per type scan (actual slots ascending, each taking the highest unused
 * minimum it reaches) gives all three priorities at once. Nothing depends on
 * the input slot order, the Variant order, Variant `id` or the run.
 */
export interface VariantPartialMatch {
  matchedCount: number
  exactCount: number
  missingBonuses: RestorationBonus[]
  extraBonuses: RestorationBonus[]
}

function compareRestorationBonuses(master: TargetEvaluationMasterSubset) {
  return (left: RestorationBonus, right: RestorationBonus): number =>
    compareCodeUnits(left.bonusTypeId, right.bonusTypeId) ||
    bonusRankOrder(master, left.bonusRankId) - bonusRankOrder(master, right.bonusRankId) ||
    compareCodeUnits(left.bonusRankId, right.bonusRankId)
}

export function evaluateVariantPartialMatch(
  bonuses: readonly RestorationBonus[],
  variant: Pick<CompletionBonusVariant, 'slots'>,
  master: TargetEvaluationMasterSubset,
): VariantPartialMatch {
  const compareSlots = (
    left: { order: number; rankId: BonusRankId },
    right: { order: number; rankId: BonusRankId },
  ) => left.order - right.order || compareCodeUnits(left.rankId, right.rankId)
  const required = new Map<BonusTypeId, { order: number; rankId: BonusRankId; used: boolean }[]>()
  for (const slot of variant.slots) {
    const entry = { order: bonusRankOrder(master, slot.minimumRankId), rankId: slot.minimumRankId, used: false }
    const group = required.get(slot.bonusTypeId)
    if (group) group.push(entry)
    else required.set(slot.bonusTypeId, [entry])
  }
  const actual = new Map<BonusTypeId, { order: number; rankId: BonusRankId }[]>()
  for (const bonus of bonuses) {
    const entry = { order: bonusRankOrder(master, bonus.bonusRankId), rankId: bonus.bonusRankId }
    const group = actual.get(bonus.bonusTypeId)
    if (group) group.push(entry)
    else actual.set(bonus.bonusTypeId, [entry])
  }
  let matchedCount = 0
  let exactCount = 0
  const extraBonuses: RestorationBonus[] = []
  for (const [type, slots] of actual) {
    slots.sort(compareSlots)
    const minimums = (required.get(type) ?? []).sort(compareSlots)
    for (const slot of slots) {
      let chosen: (typeof minimums)[number] | undefined
      for (const minimum of minimums) {
        if (minimum.used || minimum.order > slot.order) continue
        if (chosen === undefined || minimum.order >= chosen.order) chosen = minimum
      }
      if (chosen === undefined) {
        extraBonuses.push({ bonusTypeId: type, bonusRankId: slot.rankId })
        continue
      }
      chosen.used = true
      matchedCount += 1
      if (chosen.order === slot.order) exactCount += 1
    }
  }
  const missingBonuses: RestorationBonus[] = []
  for (const [type, minimums] of required) {
    for (const minimum of minimums) {
      if (!minimum.used) missingBonuses.push({ bonusTypeId: type, bonusRankId: minimum.rankId })
    }
  }
  const compare = compareRestorationBonuses(master)
  return {
    matchedCount,
    exactCount,
    missingBonuses: missingBonuses.sort(compare),
    extraBonuses: extraBonuses.sort(compare),
  }
}

/**
 * `selectClosestVariant(A, V)` (`docs/DATA_MODEL.md` 8.2): the Variant with the
 * largest partial match count; a tie goes to the smaller normalized Variant
 * string. The exact count never compares Variants. `null` only for an empty
 * Variant list, which a valid Target never has.
 */
export function selectClosestVariant(
  bonuses: readonly RestorationBonus[],
  variants: readonly CompletionBonusVariant[],
  master: TargetEvaluationMasterSubset,
): { variant: CompletionBonusVariant; match: VariantPartialMatch } | null {
  const evaluated = variants.map((variant) => ({ variant, match: evaluateVariantPartialMatch(bonuses, variant, master) }))
  if (evaluated.length === 0) return null
  const best = Math.max(...evaluated.map(({ match }) => match.matchedCount))
  const tied = evaluated.filter(({ match }) => match.matchedCount === best)
  if (tied.length === 1) return tied[0]!
  // The normalized form decides a tie; Variant order and `id` never do.
  return tied
    .map((entry) => ({ entry, key: completionBonusVariantKey(entry.variant) }))
    .sort((left, right) => compareCodeUnits(left.key, right.key))[0]!.entry
}

/**
 * The partial match count of the closest Variant (0..5): the one shared value
 * behind `IdealDifference.matchedBonusCount`, the Bonus stream ordering key 2
 * and the constrained frontier's `idealCloseness` (`docs/SEARCH_SPEC.md` 5.5.3).
 */
export function closestVariantMatchedCount(
  target: Pick<TargetWeapon, 'completionBonusVariants'>,
  bonuses: readonly RestorationBonus[],
  master: TargetEvaluationMasterSubset,
): number {
  return selectClosestVariant(bonuses, target.completionBonusVariants, master)?.match.matchedCount ?? 0
}

/**
 * Whether Variant `including` accepts every five-slot set Variant `included`
 * accepts (`docs/DATA_MODEL.md` 8.2): equal type counts, and per type the
 * ascending minimum orders of `including` are at most those of `included`.
 */
export function completionVariantIncludes(
  including: Pick<CompletionBonusVariant, 'slots'>,
  included: Pick<CompletionBonusVariant, 'slots'>,
  master: TargetEvaluationMasterSubset,
): boolean {
  const left = groupOrdersByType(including.slots, (slot) => slot.bonusTypeId, (slot) => bonusRankOrder(master, slot.minimumRankId))
  const right = groupOrdersByType(included.slots, (slot) => slot.bonusTypeId, (slot) => bonusRankOrder(master, slot.minimumRankId))
  if (left.size !== right.size) return false
  for (const [type, minimums] of left) {
    const others = right.get(type)
    if (!others || others.length !== minimums.length) return false
    for (let index = 0; index < minimums.length; index++) {
      if (minimums[index]!.order > others[index]!.order) return false
    }
  }
  return true
}

/** One conflict between two Variants of a Target (`docs/DATA_MODEL.md` 8.2). */
export interface CompletionVariantConflict {
  /** The Variant that cannot be saved. */
  index: number
  /** `duplicate`: the same normalized form; `included`: every set it accepts, the other accepts too. */
  kind: 'duplicate' | 'included'
  /** The earlier identical Variant, or the including Variant. */
  otherIndex: number
}

/**
 * The Variants a save refuses, in Variant order (`docs/DATA_MODEL.md` 8.2): a
 * later Variant with the same normalized form as an earlier one is a
 * `duplicate`, and a Variant included in another is `included`. The save-time
 * validation reports exactly these, so the editor can show them next to the
 * Variant before saving. Unknown ranks raise the Master Domain Error.
 */
export function findCompletionVariantConflicts(
  variants: readonly Pick<CompletionBonusVariant, 'slots'>[],
  master: TargetEvaluationMasterSubset,
): CompletionVariantConflict[] {
  const keys = variants.map((variant) => completionBonusVariantKey(variant))
  const conflicts: CompletionVariantConflict[] = []
  variants.forEach((variant, index) => {
    const duplicateOf = keys.findIndex((key, otherIndex) => otherIndex < index && key === keys[index])
    if (duplicateOf >= 0) {
      conflicts.push({ index, kind: 'duplicate', otherIndex: duplicateOf })
      return
    }
    const includedBy = variants.findIndex((other, otherIndex) =>
      otherIndex !== index && keys[otherIndex] !== keys[index] && completionVariantIncludes(other, variant, master),
    )
    if (includedBy >= 0) conflicts.push({ index, kind: 'included', otherIndex: includedBy })
  })
  return conflicts
}
