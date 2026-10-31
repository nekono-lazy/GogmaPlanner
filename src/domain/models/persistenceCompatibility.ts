import { APP_SETTINGS_SCHEMA_VERSION, recommendedCandidateSearchDefaults } from './common'
import { completionSkillVariantFromCondition } from './completionSkillVariantIdentity'
import type { OwnedWeapon, RestorationBonusScope } from './publicTypes'

type LegacyOwnedWeapon = Omit<OwnedWeapon, 'restorationBonusScope'> & {
  restorationBonusScope?: RestorationBonusScope
}

/** Read/import boundary normalization for pre-B1 records only. */
export function normalizeOwnedWeaponRestorationBonusScope(
  weapon: LegacyOwnedWeapon,
): OwnedWeapon {
  if (weapon.restorationBonusScope !== undefined) return weapon as OwnedWeapon
  return {
    ...weapon,
    restorationBonusScope:
      weapon.kind === 'normal' ? 'normal_artian' : 'gogma_artian',
  } as OwnedWeapon
}

const NON_TERMINAL_PLAN_STATUSES: readonly unknown[] = ['draft', 'active', 'stale']
export const PRODUCTION_PLAN_LIFECYCLE_FIELDS = [
  'abandonmentReason',
  'abandonedAt',
  'completedAt',
] as const

/** Whether an untrusted Plan record carries any lifecycle metadata field. */
export function hasProductionPlanLifecycleField(plan: Record<string, unknown>): boolean {
  return PRODUCTION_PLAN_LIFECYCLE_FIELDS.some((field) => field in plan)
}

/** Whether an untrusted Plan record is `completed` or `abandoned`. */
export function isTerminalProductionPlanRecord(plan: Record<string, unknown>): boolean {
  return plan.status === 'completed' || plan.status === 'abandoned'
}

/**
 * Whether an untrusted Plan record is a not-yet-started `draft`
 * (`docs/DATA_MODEL.md` 11.1). Shared by the Dexie v7 -> v8 upgrade and the
 * Export schema 10 -> 11 migration, which both delete every accumulated Draft
 * of the old contract instead of guessing which one the user meant.
 */
export function isDraftProductionPlanRecord(plan: Record<string, unknown>): boolean {
  return plan.status === 'draft'
}

/**
 * Gives a Plan record written before the lifecycle metadata existed its
 * deterministic `null`s (`docs/DATA_MODEL.md` 11.1, 14.2).
 *
 * Only a `draft` / `active` / `stale` record without any lifecycle field is
 * filled: `null` is then the only value its status allows, so nothing is
 * inferred. A terminal record would need a completion time or an abandonment
 * reason nobody recorded, and a record already carrying a field is not a
 * legacy record, so both are left exactly as they are for validation to refuse.
 * Mutates and returns whether it filled the record.
 */
export function fillNonTerminalPlanLifecycle(plan: Record<string, unknown>): boolean {
  if (!NON_TERMINAL_PLAN_STATUSES.includes(plan.status)) return false
  if (hasProductionPlanLifecycleField(plan)) return false
  PRODUCTION_PLAN_LIFECYCLE_FIELDS.forEach((field) => {
    plan[field] = null
  })
  return true
}

/**
 * The Identification provenance fields (`RngState.lastIdentifiedAt`,
 * `NormalArtianCounter.lastIdentifiedAt`, `docs/DATA_MODEL.md` 6.1 / 6.2).
 */
export const IDENTIFICATION_PROVENANCE_FIELD = 'lastIdentifiedAt'
export const RNG_STATE_PROVENANCE_SCHEMA_VERSION = 2

/** Whether an untrusted RngState / NormalArtianCounter record already carries the provenance field. */
export function hasIdentificationProvenanceField(record: Record<string, unknown>): boolean {
  return IDENTIFICATION_PROVENANCE_FIELD in record
}

/**
 * Gives a RngState record written before the Identification provenance existed
 * its deterministic `lastIdentifiedAt = null` and record schema version 2
 * (`docs/DATA_MODEL.md` 14.2, 15.3). `null` means "no formal Identification
 * adoption is recorded", which is exactly what such a record can say: the time
 * of an adoption is never reconstructed from `updatedAt` or a `source ===
 * 'observation'`. A record already carrying the field is not a legacy record
 * and is left as it is. Mutates and returns whether it filled the record.
 */
export function fillRngStateIdentificationProvenance(state: Record<string, unknown>): boolean {
  if (hasIdentificationProvenanceField(state)) return false
  state[IDENTIFICATION_PROVENANCE_FIELD] = null
  state.schemaVersion = RNG_STATE_PROVENANCE_SCHEMA_VERSION
  return true
}

/** The NormalArtianCounter counterpart of `fillRngStateIdentificationProvenance()`; no record version exists. */
export function fillNormalCounterIdentificationProvenance(counter: Record<string, unknown>): boolean {
  if (hasIdentificationProvenanceField(counter)) return false
  counter[IDENTIFICATION_PROVENANCE_FIELD] = null
  return true
}

/** The AppSettings record version written before `candidateSearchDefaults` existed. */
export const LEGACY_APP_SETTINGS_SCHEMA_VERSION = 1
export const CANDIDATE_SEARCH_DEFAULTS_FIELD = 'candidateSearchDefaults'

/**
 * Whether an untrusted AppSettings record is an AppSettings v1 record: record
 * version 1 and no `candidateSearchDefaults` field. Anything else is not a
 * legacy record and is never filled.
 */
export function isLegacyAppSettingsRecord(settings: Record<string, unknown>): boolean {
  return settings.schemaVersion === LEGACY_APP_SETTINGS_SCHEMA_VERSION
    && !(CANDIDATE_SEARCH_DEFAULTS_FIELD in settings)
}

/**
 * Upgrades an AppSettings v1 record to v2 (`docs/DATA_MODEL.md` 13 / 14.2 /
 * 15.3): `candidateSearchDefaults` becomes the recommended
 * `recommendedCandidateSearchDefaults` and the record version becomes 2. A v1
 * record never held user-chosen Candidate Search bounds - the Search screen's
 * former fixed `500 / 350 / 1500` were never saved - so the recommendation is
 * the only value it can state. `debugMode`, `resultPageSize`,
 * `defaultSearchLimit` and the timestamps are kept exactly; in particular
 * `defaultSearchLimit` keeps its own meaning and is never copied into the new
 * bounds. A record that is not a v1 record is left as it is for validation to
 * judge. Mutates and returns whether it upgraded the record.
 */
export function upgradeAppSettingsToV2(settings: Record<string, unknown>): boolean {
  if (!isLegacyAppSettingsRecord(settings)) return false
  settings[CANDIDATE_SEARCH_DEFAULTS_FIELD] = { ...recommendedCandidateSearchDefaults }
  settings.schemaVersion = APP_SETTINGS_SCHEMA_VERSION
  return true
}

/** The repair lineage field every ProductionPlan body carries since Dexie v10 / Export 13. */
export const CONFLICT_REPAIR_LINEAGE_FIELD = 'conflictRepairLineage'

/** Whether an untrusted ProductionPlan record already carries the repair lineage field. */
export function hasConflictRepairLineageField(plan: Record<string, unknown>): boolean {
  return CONFLICT_REPAIR_LINEAGE_FIELD in plan
}

/**
 * Gives a ProductionPlan body written before the repair lineage existed its
 * deterministic `conflictRepairLineage = null` (`docs/DATA_MODEL.md` 11.1.1 /
 * 14.2 / 15.3, `docs/PLANNER_SPEC.md` 9.2.19.15). `null` - "this Plan belongs to
 * no repair chain" - is the only value such a record can state: no earlier
 * runtime saved a repair decision, and one is never reconstructed from the
 * Plan's selected Conflicts, its BuildListEntries or ExecutionHistory. A body
 * already carrying the field is not a legacy body and is left as it is.
 * Mutates and returns whether it filled the body.
 */
export function fillProductionPlanConflictRepairLineage(plan: Record<string, unknown>): boolean {
  if (hasConflictRepairLineageField(plan)) return false
  plan[CONFLICT_REPAIR_LINEAGE_FIELD] = null
  return true
}

/** The completion assignment field every TargetWeapon body carries since Dexie v13 / Export 16 (Issue #334). */
export const TARGET_COMPLETION_ASSIGNMENT_FIELD = 'completedWithOwnedWeaponId'

/**
 * A Target body the completion assignment migration cannot fill: it is not an
 * object, or it already carries the field and so is not a Dexie 12 / Export 15
 * body. Nothing is guessed and nothing is overwritten.
 */
export class TargetCompletionAssignmentMigrationError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'TargetCompletionAssignmentMigrationError'
    this.path = path
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Gives one TargetWeapon body written before the completion assignment existed
 * its `completedWithOwnedWeaponId = null` ("not recorded";
 * `docs/DATA_MODEL.md` 8.7 / 14.2 / 15.1, `docs/PLANNER_SPEC.md` 21.3 / 21.9).
 * A `completed` Target gets `null` too: the weapon that completed it is never
 * inferred from `completedByProductionPlanId`, a Plan's `targetCompletions`, an
 * owned Ideal weapon or a preference. Shared by the Dexie version(13) upgrade
 * and the Export schema 15 -> 16 migration. Mutates the body in place; a body
 * that is not an object or already carries the field throws.
 */
export function fillTargetWeaponCompletionAssignment(target: unknown, path: string): void {
  if (!isRecordValue(target)) {
    throw new TargetCompletionAssignmentMigrationError(path, 'A TargetWeapon body must be an object.')
  }
  if (TARGET_COMPLETION_ASSIGNMENT_FIELD in target) {
    throw new TargetCompletionAssignmentMigrationError(path, 'A TargetWeapon body written before the completion assignment cannot carry completedWithOwnedWeaponId.')
  }
  target[TARGET_COMPLETION_ASSIGNMENT_FIELD] = null
}

/**
 * `fillTargetWeaponCompletionAssignment()` over every body of a Target list in
 * place (a save point's `targetWeapons`, an Undo body's
 * `affectedTargetWeaponsBefore`). A non-array throws.
 */
export function fillTargetWeaponListCompletionAssignment(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new TargetCompletionAssignmentMigrationError(path, 'A TargetWeapon body list must be an array.')
  }
  value.forEach((target: unknown, index) => fillTargetWeaponCompletionAssignment(target, `${path}[${index}]`))
}

/** The completion Skill configurations every TargetWeapon body carries since Dexie v14 / Export 17 (Issue #367). */
export const TARGET_COMPLETION_SKILL_VARIANTS_FIELD = 'completionSkillVariants'

/** The schema 16 completion Skill condition (one Series / Group pair) the Dexie v14 / Export 17 conversion replaces. */
export const LEGACY_COMPLETION_SKILL_CONDITION_FIELD = 'completionSkillCondition'

/**
 * A Target body the completion Skill configuration migration cannot convert:
 * it is not an object, it already carries `completionSkillVariants`, it has no
 * `completionSkillCondition`, or that condition is not a schema 16 one
 * (`matchMode: "all"` with `null` or string Series / Group IDs). Nothing is
 * guessed and nothing is overwritten.
 */
export class TargetCompletionSkillVariantsMigrationError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'TargetCompletionSkillVariantsMigrationError'
    this.path = path
  }
}

function isSkillIdValue(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Moves one schema 16 TargetWeapon body to the completion Skill configurations
 * (Issue #367, `docs/DATA_MODEL.md` 8.4 / 14.2 / 15.1, `docs/PLANNER_SPEC.md`
 * 22.7): its one `completionSkillCondition` becomes one configuration with the
 * same Series / Group IDs and the fixed `id` `DEFAULT_COMPLETION_SKILL_VARIANT_ID`,
 * and the condition (with its only possible `matchMode`, `"all"`) is removed.
 * The conversion is lossless: `completionConditionReview`, the lifecycle, the
 * completion assignment, the preference and every other field keep their exact
 * values, and the Target definition hash does not move (one configuration
 * hashes as the former condition, 9.4). Shared by the Dexie version(14) upgrade
 * and the Export schema 16 -> 17 migration. Mutates the body in place; a body
 * that is not a schema 16 body throws.
 */
export function migrateTargetWeaponCompletionSkillVariants(target: unknown, path: string): void {
  if (!isRecordValue(target)) {
    throw new TargetCompletionSkillVariantsMigrationError(path, 'A TargetWeapon body must be an object.')
  }
  if (TARGET_COMPLETION_SKILL_VARIANTS_FIELD in target) {
    throw new TargetCompletionSkillVariantsMigrationError(path, 'A TargetWeapon body written before the completion Skill configurations cannot carry completionSkillVariants.')
  }
  const condition = target[LEGACY_COMPLETION_SKILL_CONDITION_FIELD]
  if (!isRecordValue(condition)) {
    throw new TargetCompletionSkillVariantsMigrationError(`${path}.${LEGACY_COMPLETION_SKILL_CONDITION_FIELD}`, 'A schema 16 TargetWeapon body must carry its completionSkillCondition.')
  }
  if (condition.matchMode !== 'all') {
    throw new TargetCompletionSkillVariantsMigrationError(`${path}.${LEGACY_COMPLETION_SKILL_CONDITION_FIELD}.matchMode`, 'A schema 16 completion Skill condition must have matchMode "all".')
  }
  if (!isSkillIdValue(condition.seriesSkillId) || !isSkillIdValue(condition.groupSkillId)) {
    throw new TargetCompletionSkillVariantsMigrationError(`${path}.${LEGACY_COMPLETION_SKILL_CONDITION_FIELD}`, 'A schema 16 completion Skill condition must hold null or string Series / Group Skill IDs.')
  }
  delete target[LEGACY_COMPLETION_SKILL_CONDITION_FIELD]
  target[TARGET_COMPLETION_SKILL_VARIANTS_FIELD] = [
    completionSkillVariantFromCondition({ seriesSkillId: condition.seriesSkillId, groupSkillId: condition.groupSkillId }),
  ]
}

/**
 * `migrateTargetWeaponCompletionSkillVariants()` over every body of a Target
 * list in place (a save point's `targetWeapons`, an Undo body's
 * `affectedTargetWeaponsBefore`). A non-array throws.
 */
export function migrateTargetWeaponListCompletionSkillVariants(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new TargetCompletionSkillVariantsMigrationError(path, 'A TargetWeapon body list must be an array.')
  }
  value.forEach((target: unknown, index) => migrateTargetWeaponCompletionSkillVariants(target, `${path}[${index}]`))
}
