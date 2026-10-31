import type {
  BonusRankId,
  BonusTypeId,
  CompletionConditionReviewReason,
  GroupSkillId,
  RestorationBonusSet,
  SeriesSkillId,
} from './common'
import type { TargetWeapon } from './entities'

/**
 * The TargetWeapon body before Issue #100 (calculation schema 18, Dexie 11,
 * Export 14): an Ideal five-slot set plus the Practical / Alternative /
 * Practical Skill compromise conditions (`docs/TARGET_COMPROMISE_SEMANTICS.md`,
 * a historical record).
 *
 * It exists only as a migration input: the Dexie version(12) upgrade and the
 * Export schema 14 -> 15 migration turn it into the current body through
 * `migrateLegacyTargetWeaponToCompletionConditions()`, and the version 11 /
 * schema 14 ExecutionHistory conversion validates the Target bodies it carries
 * with `validateLegacyTargetWeapon()`. No current Domain path reads it.
 */
export interface LegacyPracticalBonusCondition {
  id: string
  bonusTypeId: BonusTypeId
  minimumRankId: BonusRankId
  requiredExCount: number
}

export interface LegacyAlternativeBonusOption {
  alternativeBonusTypeId: BonusTypeId
  minimumRankId: BonusRankId
  requiredExCount: number
}

export interface LegacyAlternativeBonusRule {
  id: string
  sourceBonusTypeId: BonusTypeId
  maxReplacementCount: number
  options: LegacyAlternativeBonusOption[]
}

export interface LegacySkillCondition {
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  matchMode: 'all' | 'any'
}

export interface LegacyTargetWeapon
  extends Omit<
    TargetWeapon,
    'completionBonusVariants' | 'completionSkillCondition' | 'completionConditionReview' | 'completedWithOwnedWeaponId'
  > {
  idealBonuses: RestorationBonusSet
  practicalBonusConditions: LegacyPracticalBonusCondition[]
  alternativeBonusRules: LegacyAlternativeBonusRule[]
  compromiseNeedsReview?: boolean
  idealSkillCondition: LegacySkillCondition
  practicalSkillCondition: LegacySkillCondition
}

/** The fields only a legacy (schema 18 / Export 14) Target body carries. */
export const LEGACY_TARGET_WEAPON_FIELDS = [
  'idealBonuses',
  'practicalBonusConditions',
  'alternativeBonusRules',
  'idealSkillCondition',
  'practicalSkillCondition',
  'compromiseNeedsReview',
] as const

/** The fields only a current (Issue #100) Target body carries. */
export const COMPLETION_CONDITION_TARGET_WEAPON_FIELDS = [
  'completionBonusVariants',
  'completionSkillCondition',
  'completionConditionReview',
] as const

/** The Variant `id` a migrated Ideal five-slot set receives (`docs/DATA_MODEL.md` 8.6). */
export const MIGRATED_COMPLETION_BONUS_VARIANT_ID = 'completion-variant-1'

/** Whether a stored Target body already carries any field of the current shape. */
export function hasCompletionConditionTargetField(target: Record<string, unknown>): boolean {
  return COMPLETION_CONDITION_TARGET_WEAPON_FIELDS.some((field) => field in target)
}

/** Whether a stored Target body carries any field of the legacy shape. */
export function hasLegacyTargetWeaponField(target: Record<string, unknown>): boolean {
  return LEGACY_TARGET_WEAPON_FIELDS.some((field) => field in target)
}

/** A legacy Target body that does not have the structure its migration reads. */
export class LegacyTargetWeaponMigrationError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'LegacyTargetWeaponMigrationError'
    this.path = path
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacySkillCondition(value: unknown, path: string): LegacySkillCondition {
  if (
    !isRecord(value) ||
    (value.matchMode !== 'all' && value.matchMode !== 'any') ||
    (value.seriesSkillId !== null && typeof value.seriesSkillId !== 'string') ||
    (value.groupSkillId !== null && typeof value.groupSkillId !== 'string')
  ) {
    throw new LegacyTargetWeaponMigrationError(path, 'A legacy Skill condition must hold seriesSkillId, groupSkillId and an all / any matchMode.')
  }
  return value as unknown as LegacySkillCondition
}

/**
 * The one pure Target conversion of Issue #100 (`docs/DATA_MODEL.md` 8.6 /
 * 14.2 / 15.1), shared by the Dexie version(12) upgrade and the Export schema
 * 14 -> 15 migration and applied to every Target body: the table / root
 * collection, game save points, Undo bodies and the save point an Undo body
 * holds.
 *
 * - the Ideal five slots become one Variant whose minimum rank is each stored
 *   rank (`id` = `MIGRATED_COMPLETION_BONUS_VARIANT_ID`)
 * - the Practical / Alternative / Practical Skill conditions are removed, never
 *   turned into a Variant; when any existed (a non-empty list, or a Practical
 *   Skill condition naming a Skill) `compromise_conditions_removed` is recorded
 * - the Ideal Skill condition becomes `completionSkillCondition`; `any` is
 *   normalized to `all` with its Series / Group IDs kept, recording
 *   `skill_condition_normalized`
 * - the former `compromiseNeedsReview` is dropped; its value is not carried
 *
 * Every other field keeps its exact value. A body that already carries a
 * current field, or lacks the structure read here, throws
 * `LegacyTargetWeaponMigrationError`: it is not a legacy body, and nothing is
 * guessed.
 */
export function migrateLegacyTargetWeaponToCompletionConditions(
  legacy: Record<string, unknown>,
  path = '',
): Record<string, unknown> {
  if (hasCompletionConditionTargetField(legacy)) {
    throw new LegacyTargetWeaponMigrationError(path, 'A legacy Target body cannot carry a completion condition field.')
  }
  const ideal = legacy.idealBonuses
  if (
    !Array.isArray(ideal) ||
    ideal.length !== 5 ||
    ideal.some((bonus) => !isRecord(bonus) || typeof bonus.bonusTypeId !== 'string' || typeof bonus.bonusRankId !== 'string')
  ) {
    throw new LegacyTargetWeaponMigrationError(`${path}.idealBonuses`, 'A legacy Target needs five Ideal slots.')
  }
  const practical = legacy.practicalBonusConditions
  const alternative = legacy.alternativeBonusRules
  if (!Array.isArray(practical) || !Array.isArray(alternative)) {
    throw new LegacyTargetWeaponMigrationError(path, 'A legacy Target needs its Practical and Alternative condition lists.')
  }
  const idealSkill = legacySkillCondition(legacy.idealSkillCondition, `${path}.idealSkillCondition`)
  const practicalSkill = legacySkillCondition(legacy.practicalSkillCondition, `${path}.practicalSkillCondition`)

  const review: CompletionConditionReviewReason[] = []
  if (
    practical.length > 0 ||
    alternative.length > 0 ||
    practicalSkill.seriesSkillId !== null ||
    practicalSkill.groupSkillId !== null
  ) {
    review.push('compromise_conditions_removed')
  }
  if (idealSkill.matchMode === 'any') review.push('skill_condition_normalized')

  const migrated: Record<string, unknown> = { ...legacy }
  LEGACY_TARGET_WEAPON_FIELDS.forEach((field) => delete migrated[field])
  migrated.completionBonusVariants = [{
    id: MIGRATED_COMPLETION_BONUS_VARIANT_ID,
    slots: (ideal as Record<string, unknown>[]).map((bonus) => ({
      bonusTypeId: bonus.bonusTypeId,
      minimumRankId: bonus.bonusRankId,
    })),
  }]
  migrated.completionSkillCondition = {
    seriesSkillId: idealSkill.seriesSkillId,
    groupSkillId: idealSkill.groupSkillId,
    matchMode: 'all',
  }
  migrated.completionConditionReview = review
  return migrated
}

/**
 * Applies `migrateLegacyTargetWeaponToCompletionConditions()` to every Target
 * body of a list in place (a save point's `targetWeapons`, an Undo body's
 * `affectedTargetWeaponsBefore`). A non-array or a non-object element throws.
 */
export function migrateLegacyTargetWeaponList(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new LegacyTargetWeaponMigrationError(path, 'A Target body list must be an array.')
  }
  return value.map((target: unknown, index) => {
    if (!isRecord(target)) {
      throw new LegacyTargetWeaponMigrationError(`${path}[${index}]`, 'A Target body must be an object.')
    }
    return migrateLegacyTargetWeaponToCompletionConditions(target, `${path}[${index}]`)
  })
}
