import type {
  CompletionSkillVariant,
  GroupSkillId,
  SeriesSkillId,
  SkillCondition,
  TargetWeapon,
} from '../models/publicTypes'
import { completionSkillVariantKey } from '../models/completionSkillVariantIdentity'
import { evaluateSkillCondition } from './skillConditionEvaluator'

export {
  completionSkillVariantFromCondition,
  completionSkillVariantIncludes,
  completionSkillVariantKey,
  completionSkillVariantsCompatible,
  DEFAULT_COMPLETION_SKILL_VARIANT_ID,
  findCompletionSkillVariantConflicts,
  normalizeCompletionSkillVariant,
  normalizeCompletionSkillVariants,
} from '../models/completionSkillVariantIdentity'
export type { CompletionSkillVariantConflict } from '../models/completionSkillVariantIdentity'

/**
 * The completion Skill configurations of a Target (`docs/DATA_MODEL.md` 8.4,
 * `docs/PLANNER_SPEC.md` 22.2, Issue #367).
 *
 * This module is the single authority Search, the Planner, the Build List
 * optimization, Execution and the owned-Ideal notice share for the Skill side:
 *
 * - `satisfiesCompletionSkills()` decides completion (a truth value): one
 *   configuration's `evaluateSkillCondition()` (AND inside it) for any
 *   configuration (OR between them). `evaluateSkillCondition()` keeps its
 *   meaning; one OR sits on top of it
 * - `selectClosestCompletionSkillVariant()` / `closestCompletionSkillVariantMatchedCount()`
 *   are the separate partial match evaluation that orders Skill stream
 *   solutions and explains the difference to the closest configuration.
 *   Neither ever stands in for the other
 * - the normalization, the inclusion and `findCompletionSkillVariantConflicts()`
 *   (re-exported from `models/completionSkillVariantIdentity.ts`) are the
 *   identity rules the hash, the overlap classification, the save validation
 *   and the editor share
 *
 * Nothing reads the configuration order or `id`, and nothing reads the Master:
 * the Skills are compared by ID alone.
 */

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * `satisfiesCompletionSkills()` (`docs/PLANNER_SPEC.md` 22.2): the actual
 * Series / Group Skills satisfy at least one configuration. Configurations are
 * equal; the result is a truth value. One configuration is exactly its
 * `evaluateSkillCondition()`.
 */
export function satisfiesCompletionSkills(
  target: Pick<TargetWeapon, 'completionSkillVariants'>,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): boolean {
  return target.completionSkillVariants.some((variant) => evaluateSkillCondition(variant, seriesSkillId, groupSkillId))
}

/** Every configuration the actual Skills satisfy, in the Target's order (display-time re-judgement, `docs/REQUIREMENTS.md` 13.2). */
export function satisfiedCompletionSkillVariants(
  target: Pick<TargetWeapon, 'completionSkillVariants'>,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): CompletionSkillVariant[] {
  return target.completionSkillVariants.filter((variant) => evaluateSkillCondition(variant, seriesSkillId, groupSkillId))
}

/**
 * The partial match count of one configuration (0..2): how many of the Skills
 * it specifies equal the actual ones. An unspecified (`null`) side is never
 * counted as a match.
 */
export function completionSkillVariantMatchedCount(
  variant: SkillCondition,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): number {
  return (
    Number(variant.seriesSkillId !== null && variant.seriesSkillId === seriesSkillId) +
    Number(variant.groupSkillId !== null && variant.groupSkillId === groupSkillId)
  )
}

export interface ClosestCompletionSkillVariant {
  variant: CompletionSkillVariant
  /** The configuration's partial match count, which is the maximum over every configuration. */
  matchedCount: number
  /** Whether the actual Skills satisfy this configuration. */
  satisfied: boolean
}

/**
 * The closest completion Skill configuration (`docs/PLANNER_SPEC.md` 22.2,
 * `docs/DATA_MODEL.md` 9.3): (1) the largest partial match count, (2) on a tie
 * one the actual Skills satisfy, (3) then the smaller normalized key. By (2) a
 * completed state is always measured against a configuration it satisfies.
 * Neither the configuration order nor `id` decides. `null` only for an empty
 * list, which a valid Target never has.
 */
export function selectClosestCompletionSkillVariant(
  variants: readonly CompletionSkillVariant[],
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): ClosestCompletionSkillVariant | null {
  let best: (ClosestCompletionSkillVariant & { key: string }) | null = null
  for (const variant of variants) {
    const candidate = {
      variant,
      matchedCount: completionSkillVariantMatchedCount(variant, seriesSkillId, groupSkillId),
      satisfied: evaluateSkillCondition(variant, seriesSkillId, groupSkillId),
      key: completionSkillVariantKey(variant),
    }
    if (
      best === null ||
      candidate.matchedCount > best.matchedCount ||
      (candidate.matchedCount === best.matchedCount &&
        (Number(candidate.satisfied) > Number(best.satisfied) ||
          (candidate.satisfied === best.satisfied && compareCodeUnits(candidate.key, best.key) < 0)))
    ) {
      best = candidate
    }
  }
  if (best === null) return null
  return { variant: best.variant, matchedCount: best.matchedCount, satisfied: best.satisfied }
}

/**
 * The partial match count of the closest configuration (0..2): the one value
 * the Skill stream ordering key 2 and the constrained frontier's Skill
 * `idealCloseness` read (`docs/SEARCH_SPEC.md` 5.5.2 / 8.1). It is the maximum
 * count only; whether a configuration is satisfied never changes it.
 */
export function closestCompletionSkillVariantMatchedCount(
  target: Pick<TargetWeapon, 'completionSkillVariants'>,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): number {
  let best = 0
  for (const variant of target.completionSkillVariants) {
    best = Math.max(best, completionSkillVariantMatchedCount(variant, seriesSkillId, groupSkillId))
  }
  return best
}
