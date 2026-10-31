import type { CompletionSkillVariant, SkillCondition } from './entities'
import { stableStringify } from './hashing'

/**
 * The identity rules of the completion Skill configurations
 * (`docs/DATA_MODEL.md` 8.4, Issue #367): the normalized form and its key, the
 * inclusion and the duplicate / included conflicts. The Target definition hash,
 * the overlap classification, the structural `validateTargetWeapon()`, the
 * Dexie version(14) / Export 16 -> 17 conversion and the Target editor all read
 * these one functions; `domain/target/completionSkillVariants.ts` re-exports
 * them beside the completion judgement. Nothing reads the configuration order,
 * `id` or the Master.
 */

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Configuration `id` used when one configuration is created from one Skill condition (migration, drafts). */
export const DEFAULT_COMPLETION_SKILL_VARIANT_ID = 'completion-skill-variant-1'

/** The normalized form of one configuration: its Series and Group Skills, without `id`. */
export function normalizeCompletionSkillVariant(variant: SkillCondition): SkillCondition {
  return { seriesSkillId: variant.seriesSkillId, groupSkillId: variant.groupSkillId }
}

/** The stable string of a configuration's normalized form (identity, hashing, tie-break). */
export function completionSkillVariantKey(variant: SkillCondition): string {
  return stableStringify(normalizeCompletionSkillVariant(variant))
}

/**
 * Every configuration of a Target in normalized form, sorted by key in
 * locale-independent code unit order, so the configuration order and `id`
 * never matter.
 */
export function normalizeCompletionSkillVariants(variants: readonly SkillCondition[]): SkillCondition[] {
  return variants
    .map((variant) => ({ key: completionSkillVariantKey(variant), variant: normalizeCompletionSkillVariant(variant) }))
    .sort((left, right) => compareCodeUnits(left.key, right.key))
    .map(({ variant }) => variant)
}

/** One configuration whose Series / Group Skills are exactly the given condition's (migration, drafts). */
export function completionSkillVariantFromCondition(
  condition: SkillCondition,
  id: string = DEFAULT_COMPLETION_SKILL_VARIANT_ID,
): CompletionSkillVariant {
  return { id, seriesSkillId: condition.seriesSkillId, groupSkillId: condition.groupSkillId }
}

/**
 * Whether configuration `including` accepts every Skill state `included`
 * accepts (`docs/DATA_MODEL.md` 8.4): for the Series and for the Group, either
 * `including` does not specify it or both specify the same ID.
 */
export function completionSkillVariantIncludes(including: SkillCondition, included: SkillCondition): boolean {
  const covers = <T>(left: T | null, right: T | null) => left === null || left === right
  return covers(including.seriesSkillId, included.seriesSkillId) && covers(including.groupSkillId, included.groupSkillId)
}

/** Whether two configurations can both hold for one Skill state: each side is unspecified on either one or names the same ID. */
export function completionSkillVariantsCompatible(left: SkillCondition, right: SkillCondition): boolean {
  const compatible = <T>(a: T | null, b: T | null) => a === null || b === null || a === b
  return compatible(left.seriesSkillId, right.seriesSkillId) && compatible(left.groupSkillId, right.groupSkillId)
}

/** One conflict between two configurations of a Target (`docs/DATA_MODEL.md` 8.4). */
export interface CompletionSkillVariantConflict {
  /** The configuration that cannot be saved. */
  index: number
  /** `duplicate`: the same normalized form; `included`: every Skill state it accepts, the other accepts too. */
  kind: 'duplicate' | 'included'
  /** The earlier identical configuration, or the including configuration. */
  otherIndex: number
}

/**
 * The configurations a save refuses, in configuration order
 * (`docs/DATA_MODEL.md` 8.4): a later configuration with the same normalized
 * form as an earlier one is a `duplicate`, and a configuration included in
 * another (an unspecified side includes a specified one) is `included`. The
 * save validation and the editor report exactly these. No Master is read.
 */
export function findCompletionSkillVariantConflicts(variants: readonly SkillCondition[]): CompletionSkillVariantConflict[] {
  const keys = variants.map((variant) => completionSkillVariantKey(variant))
  const conflicts: CompletionSkillVariantConflict[] = []
  variants.forEach((variant, index) => {
    const duplicateOf = keys.findIndex((key, otherIndex) => otherIndex < index && key === keys[index])
    if (duplicateOf >= 0) {
      conflicts.push({ index, kind: 'duplicate', otherIndex: duplicateOf })
      return
    }
    const includedBy = variants.findIndex((other, otherIndex) =>
      otherIndex !== index && keys[otherIndex] !== keys[index] && completionSkillVariantIncludes(other, variant),
    )
    if (includedBy >= 0) conflicts.push({ index, kind: 'included', otherIndex: includedBy })
  })
  return conflicts
}
