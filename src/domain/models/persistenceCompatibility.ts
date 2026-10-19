import { APP_SETTINGS_SCHEMA_VERSION, recommendedCandidateSearchDefaults } from './common'
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
