import type {
  AppSettings,
  ISODateTimeString,
  NormalArtianCounter,
  RngState,
} from './common'
import type {
  BuildCandidate,
  BuildListEntry,
  OwnedWeapon,
  TargetWeapon,
} from './entities'
import { convertExecutionHistoryCollection } from './executionHistoryConversion'
import type { LegacyExecutionHistory } from './legacyExecutionHistory'
import {
  hasCompletionConditionTargetField,
  LegacyTargetWeaponMigrationError,
  migrateLegacyTargetWeaponList,
  type LegacyTargetWeapon,
} from './legacyTargetWeapon'
import type {
  ExecutionHistory,
  ExecutionSavePoint,
  ExecutionUndoSnapshot,
  ProductionPlan,
} from './planning'
import {
  fillNonTerminalPlanLifecycle,
  fillNormalCounterIdentificationProvenance,
  fillProductionPlanConflictRepairLineage,
  fillRngStateIdentificationProvenance,
  fillTargetWeaponListCompletionAssignment,
  hasConflictRepairLineageField,
  hasIdentificationProvenanceField,
  hasProductionPlanLifecycleField,
  isDraftProductionPlanRecord,
  isLegacyAppSettingsRecord,
  isTerminalProductionPlanRecord,
  RNG_STATE_PROVENANCE_SCHEMA_VERSION,
  migrateTargetWeaponListCompletionSkillVariants,
  TARGET_COMPLETION_ASSIGNMENT_FIELD,
  TARGET_COMPLETION_SKILL_VARIANTS_FIELD,
  TargetCompletionAssignmentMigrationError,
  TargetCompletionSkillVariantsMigrationError,
  upgradeAppSettingsToV2,
} from './persistenceCompatibility'
import {
  EXECUTION_PLAN_CONTRACT_APP_SCHEMA_VERSION,
  validateExecutionRecordCollection,
  validateExecutionSavePoint,
  validateExecutionSavePointReferences,
  validateNormalArtianCounter,
  validateOwnedWeapon,
  validateProductionPlan,
  validateRngState,
  validateTargetWeapon,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation'

/**
 * Current Export shape version. Version 7 adds the Execution lifecycle
 * persisted state: TargetWeapon lifecycle, `OwnedWeapon.executionInProgress`,
 * and `executionSavePoints`. Version 8 adds the calculation schema 12
 * ProductionPlan shape: `PlanStep.executionEffects`, the
 * `ExpectedPlanState.targetExecutionStateHash`, the Plan-dependent
 * `PlanningInputSnapshot` hashes and the `confirm_owned_ideal` Step
 * (`docs/DATA_MODEL.md` 15). It is independent of `DATABASE_SCHEMA_VERSION`
 * and of `CURRENT_CALCULATION_APP_SCHEMA_VERSION`. Version 9 adds the
 * ProductionPlan lifecycle metadata (`abandonmentReason`, `abandonedAt`,
 * `completedAt`) and the Execution lifecycle Undo snapshot
 * (`affectedTargetWeaponsBefore`, `executionSavePointBefore`). Version 10 adds
 * the Identification provenance `lastIdentifiedAt` of RngState (record schema
 * version 2) and NormalArtianCounter (`docs/DATA_MODEL.md` 6.1 / 6.2). Version
 * 11 changes no entity shape: it is the Draft lifecycle boundary
 * (`docs/DATA_MODEL.md` 11.1 / 15.3) under which `root.productionPlans` holds at
 * most one `draft` Plan, the current one; a schema 10 root was written under the
 * old contract that accumulated Drafts, so its migration deletes them all.
 * Version 12 carries the AppSettings record schema version 2, whose
 * `candidateSearchDefaults` holds the user's usual Candidate Search bounds
 * (`docs/DATA_MODEL.md` 13 / 15.3); a schema 11 root's AppSettings v1 gets the
 * recommended `350 / 500 / 1500` on migration.
 * Version 13 adds `ProductionPlan.conflictRepairLineage` (`docs/DATA_MODEL.md`
 * 11.1.1 / 15.3) to every Plan body - top-level, inside a game save point,
 * inside an Undo snapshot and inside the save point an Undo snapshot holds; a
 * schema 12 root's bodies get `null` on migration.
 * Version 14 splits the ExecutionHistory records into their metadata
 * (`executionHistory`) and their Undo bodies (`executionUndoSnapshots`), which
 * no longer copy the whole Plan (`docs/DATA_MODEL.md` 12.2 / 15.1, Issue #312);
 * a schema 13 root's records are converted by the rule the Dexie version(11)
 * upgrade shares, and a record that cannot be converted refuses the root.
 * Version 15 moves every TargetWeapon body - top-level, in a game save point,
 * in an Undo body and in the save point an Undo body holds - to the Issue #100
 * completion condition (`docs/DATA_MODEL.md` 8 / 15.1): a schema 14 root's
 * bodies are converted by the one Target conversion the Dexie version(12)
 * upgrade shares.
 * Version 16 adds the completion assignment `completedWithOwnedWeaponId`
 * (Issue #334, `docs/DATA_MODEL.md` 8.7 / 15.1) to every TargetWeapon body -
 * top-level, in a game save point, in an Undo body and in the save point an
 * Undo body holds; a schema 15 root's bodies get `null` ("not recorded") by
 * the one fill the Dexie version(13) upgrade shares, never an inferred weapon.
 * Version 17 replaces every TargetWeapon body's one `completionSkillCondition`
 * with the completion Skill configurations `completionSkillVariants` (Issue
 * #367, `docs/DATA_MODEL.md` 8.4 / 15.1) - top-level, in a game save point, in
 * an Undo body and in the save point an Undo body holds; a schema 16 root's
 * bodies are converted losslessly into one configuration each by the one
 * conversion the Dexie version(14) upgrade shares.
 */
export const EXPORT_SCHEMA_VERSION = 17

export const EXPORT_APP_NAME = 'mh-wilds-gogma-artian-planner'

export interface ExportRoot {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION
  appName: typeof EXPORT_APP_NAME
  exportedAt: ISODateTimeString
  rngState: RngState | null
  normalArtianCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
  buildCandidates: BuildCandidate[]
  buildListEntries: BuildListEntry[]
  productionPlans: ProductionPlan[]
  /** The ExecutionHistory metadata (`docs/DATA_MODEL.md` 12.2). */
  executionHistory: ExecutionHistory[]
  /** The ExecutionHistory Undo bodies, 1:1 with `executionHistory`. */
  executionUndoSnapshots: ExecutionUndoSnapshot[]
  executionSavePoints: ExecutionSavePoint[]
  settings: AppSettings
}

/**
 * A schema 16 TargetWeapon body: the current body before the completion Skill
 * configurations existed - one `completionSkillCondition` whose `matchMode` is
 * always `all`.
 */
export type TargetWeaponV16 = Omit<TargetWeapon, 'completionSkillVariants'> & {
  completionSkillCondition: {
    seriesSkillId: TargetWeapon['completionSkillVariants'][number]['seriesSkillId']
    groupSkillId: TargetWeapon['completionSkillVariants'][number]['groupSkillId']
    matchMode: 'all'
  }
}

/**
 * The schema 16 Export shape: every TargetWeapon body has the Issue #100
 * completion condition with one completion Skill condition and the completion
 * assignment. The nested save point and Undo body types are the current ones
 * only for reading convenience; their Target bodies have the schema 16 shape
 * too.
 */
export interface ExportRootV16 extends Omit<ExportRoot, 'schemaVersion' | 'targetWeapons'> {
  schemaVersion: 16
  targetWeapons: TargetWeaponV16[]
}

/** A schema 15 TargetWeapon body: the schema 16 body before the completion assignment existed. */
export type TargetWeaponV15 = Omit<TargetWeaponV16, 'completedWithOwnedWeaponId'>

/**
 * The schema 15 Export shape: every TargetWeapon body has the Issue #100
 * completion condition but no `completedWithOwnedWeaponId` yet. The nested save
 * point and Undo body types are the current ones only for reading convenience;
 * their Target bodies lack the field too.
 */
export interface ExportRootV15 extends Omit<ExportRoot, 'schemaVersion' | 'targetWeapons'> {
  schemaVersion: 15
  targetWeapons: TargetWeaponV15[]
}

/**
 * The schema 14 Export shape: every TargetWeapon body is still the legacy
 * (calculation schema 18) Ideal five slots plus compromise conditions
 * (`LegacyTargetWeapon`). The nested save point and Undo body types are the
 * current ones only for reading convenience; their Target bodies are legacy
 * too.
 */
export interface ExportRootV14 extends Omit<ExportRootV15, 'schemaVersion' | 'targetWeapons'> {
  schemaVersion: 14
  targetWeapons: LegacyTargetWeapon[]
}

/**
 * The schema 13 Export shape: every ExecutionHistory record holds its Undo
 * snapshot with the whole Plan before the Step (`LegacyExecutionHistory`), and
 * there is no `executionUndoSnapshots`.
 */
export interface ExportRootV13 extends Omit<ExportRootV14, 'schemaVersion' | 'executionHistory' | 'executionUndoSnapshots'> {
  schemaVersion: 13
  executionHistory: LegacyExecutionHistory[]
}

type SchemaV6OwnedWeapon = OwnedWeapon extends infer T
  ? T extends OwnedWeapon
    ? Omit<T, 'executionInProgress'>
    : never
  : never

type SchemaV6TargetWeapon = Omit<
  LegacyTargetWeapon,
  'lifecycleStatus' | 'completedAt' | 'completedByProductionPlanId'
>

/** The AppSettings v1 record shape, before `candidateSearchDefaults` existed. */
export type AppSettingsV1 = Omit<AppSettings, 'schemaVersion' | 'candidateSearchDefaults'> & {
  schemaVersion: 1
}

/**
 * The shape every Export schema 6..11 root shares: the current entity types
 * (each schema narrows them below where it differs) with an AppSettings v1.
 */
interface LegacySettingsExportRoot extends Omit<ExportRootV13, 'schemaVersion' | 'settings'> {
  settings: AppSettingsV1
}

/** The schema 6 Export shape, before the Execution lifecycle state existed. */
export interface ExportRootV6
  extends Omit<
    LegacySettingsExportRoot,
    'ownedWeapons' | 'targetWeapons' | 'executionSavePoints'
  > {
  schemaVersion: 6
  ownedWeapons: SchemaV6OwnedWeapon[]
  targetWeapons: SchemaV6TargetWeapon[]
}

/**
 * The schema 7 Export shape. Its entity fields are the current ones; every
 * ProductionPlan it holds predates calculation schema 12, so none carries the
 * schema 8 Plan fields.
 */
export interface ExportRootV7 extends LegacySettingsExportRoot {
  schemaVersion: 7
}

/**
 * The schema 8 Export shape. Its ProductionPlans carry no lifecycle metadata
 * and its ExecutionHistory Undo snapshots no Target or save point fields; the
 * entity types are the current ones only for reading convenience.
 */
export interface ExportRootV8 extends LegacySettingsExportRoot {
  schemaVersion: 8
}

/**
 * The schema 9 Export shape. Its RngState and NormalArtianCounter bodies -
 * top-level, inside save points and inside Undo snapshots - carry no
 * `lastIdentifiedAt`; the entity types are the current ones only for reading
 * convenience.
 */
export interface ExportRootV9 extends LegacySettingsExportRoot {
  schemaVersion: 9
}

/**
 * The schema 10 Export shape. Its entity fields are the current ones; it was
 * written under the old Draft contract, so `productionPlans` may hold any
 * number of `draft` Plans.
 */
export interface ExportRootV10 extends LegacySettingsExportRoot {
  schemaVersion: 10
}

/**
 * The schema 11 Export shape. Its entity fields are the current ones except
 * `settings`, which is an AppSettings v1 record without
 * `candidateSearchDefaults`.
 */
export interface ExportRootV11 extends LegacySettingsExportRoot {
  schemaVersion: 11
}

/**
 * The schema 12 Export shape. Its entity fields are the current ones except
 * that no ProductionPlan body - top-level, in a game save point, in an Undo
 * snapshot or in the save point an Undo snapshot holds - carries
 * `conflictRepairLineage`; the entity types are the current ones only for
 * reading convenience.
 */
export interface ExportRootV12 extends Omit<ExportRootV13, 'schemaVersion'> {
  schemaVersion: 12
}

export type ExportRootMigrationResult =
  | { ok: true; root: ExportRoot }
  | { ok: false; issues: DomainValidationIssue[] }

const SCHEMA_V7_OWNED_WEAPON_FIELDS = ['executionInProgress'] as const
const SCHEMA_V7_TARGET_WEAPON_FIELDS = [
  'lifecycleStatus',
  'completedAt',
  'completedByProductionPlanId',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function structureIssue(path: string, message: string): DomainValidationIssue {
  return { path, code: 'invalid_structure', message }
}

/**
 * Runtime shape of one entity collection of untrusted Export input: the field
 * is an array and every element is a non-null, non-array object. Typed
 * validators read fields of each element, so they only run once this holds.
 */
function collectionShapeIssues(
  owner: Record<string, unknown>,
  field: string,
  pathPrefix = '',
): DomainValidationIssue[] {
  const path = `${pathPrefix}${field}`
  const value = owner[field]
  if (!Array.isArray(value)) {
    return [structureIssue(path, `${path} must be an array.`)]
  }
  return value.flatMap((element: unknown, index) =>
    isRecord(element)
      ? []
      : [structureIssue(`${path}[${index}]`, `${path}[${index}] must be an object.`)],
  )
}

/**
 * Shape of the save point snapshot fields its typed validator iterates or
 * dereferences. Deeper entity shape is left to the typed validators, guarded by
 * `runTypedValidation()`.
 */
function savePointShapeIssues(
  savePoint: Record<string, unknown>,
  path: string,
): DomainValidationIssue[] {
  const prefix = `${path}.`
  return [
    ...collectionShapeIssues(savePoint, 'normalCounters', prefix),
    ...collectionShapeIssues(savePoint, 'ownedWeapons', prefix),
    ...collectionShapeIssues(savePoint, 'targetWeapons', prefix),
    ...(['rngState', 'productionPlan'] as const)
      .filter((field) => !isRecord(savePoint[field]))
      .map((field) => structureIssue(`${prefix}${field}`, `${prefix}${field} must be an object.`)),
  ]
}

/**
 * The typed Domain validators trust the declared entity shape. Import input is
 * untrusted, so a nested value of the wrong type that the shallow shape checks
 * did not cover must still become an issue rather than an exception.
 */
function runTypedValidation(
  path: string,
  validate: () => DomainValidationIssue[],
): DomainValidationIssue[] {
  try {
    return validate()
  } catch {
    return [structureIssue(path, `${path || 'Export root'} has a malformed nested structure.`)]
  }
}

/**
 * Pure schema 6 -> 7 Export migration.
 *
 * It only fills the fields schema 6 could not carry with their deterministic
 * "no Execution has happened" values: every Target `active` with no completion
 * metadata, every OwnedWeapon not in progress, and no game save point. It never
 * infers a completed Target from owned Ideal weapons, an in-progress weapon from
 * a Plan, or a save point from ExecutionHistory. Calculation artifacts
 * (BuildCandidate, BuildListEntry, ProductionPlan, ExecutionHistory) keep their
 * exact contents and stay behind the CalculationContext boundary.
 *
 * A schema 6 record that already carries a schema 7 field is not a schema 6
 * record, so it fails closed instead of being overwritten or trusted.
 */
export function migrateExportRootV6ToV7(
  root: ExportRootV6,
): { ok: true; root: ExportRootV7 } | { ok: false; issues: DomainValidationIssue[] } {
  // Exported and pure, so it does not rely on its caller having checked the
  // runtime shape of the collections it reads.
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const shapeIssues = [
    ...collectionShapeIssues(root as unknown as Record<string, unknown>, 'ownedWeapons'),
    ...collectionShapeIssues(root as unknown as Record<string, unknown>, 'targetWeapons'),
  ]
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  root.ownedWeapons.forEach((weapon, index) => {
    SCHEMA_V7_OWNED_WEAPON_FIELDS.forEach((field) => {
      if (field in weapon) {
        issues.push({
          path: `ownedWeapons[${index}].${field}`,
          code: 'invalid_structure',
          message: `Schema 6 OwnedWeapon cannot carry the schema 7 field '${field}'.`,
        })
      }
    })
  })
  root.targetWeapons.forEach((target, index) => {
    SCHEMA_V7_TARGET_WEAPON_FIELDS.forEach((field) => {
      if (field in target) {
        issues.push({
          path: `targetWeapons[${index}].${field}`,
          code: 'invalid_structure',
          message: `Schema 6 TargetWeapon cannot carry the schema 7 field '${field}'.`,
        })
      }
    })
  })
  if ('executionSavePoints' in root) {
    issues.push({
      path: 'executionSavePoints',
      code: 'invalid_structure',
      message: 'Schema 6 Export cannot carry executionSavePoints.',
    })
  }
  if (issues.length > 0) return { ok: false, issues }

  let migrated: ExportRootV6
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  return {
    ok: true,
    root: {
      ...migrated,
      schemaVersion: 7,
      ownedWeapons: migrated.ownedWeapons.map(
        (weapon) => ({ ...weapon, executionInProgress: null }) as OwnedWeapon,
      ),
      targetWeapons: migrated.targetWeapons.map((target) => ({
        ...target,
        lifecycleStatus: 'active',
        completedAt: null,
        completedByProductionPlanId: null,
      })),
      executionSavePoints: [],
    },
  }
}

/**
 * The schema 8 fields a ProductionPlan can carry: a calculation schema 12 Plan
 * shape. A schema 7 Export predates it, so any of them marks a record that is
 * not really schema 7.
 */
function schemaV8PlanFieldIssues(plan: unknown, path: string): DomainValidationIssue[] {
  if (!isRecord(plan)) return []
  const issues: DomainValidationIssue[] = []
  const context = plan.calculationContext
  if (
    isRecord(context) &&
    typeof context.appSchemaVersion === 'number' &&
    context.appSchemaVersion >= EXECUTION_PLAN_CONTRACT_APP_SCHEMA_VERSION
  ) {
    issues.push(structureIssue(`${path}.calculationContext.appSchemaVersion`, 'A schema 7 Export cannot carry a calculation schema 12 ProductionPlan.'))
  }
  const snapshot = plan.baseSnapshot
  if (isRecord(snapshot)) {
    ;(['dependentTargetDefinitionsHash', 'dependentBuildListEntriesHash'] as const).forEach((field) => {
      if (field in snapshot) {
        issues.push(structureIssue(`${path}.baseSnapshot.${field}`, `A schema 7 ProductionPlan cannot carry '${field}'.`))
      }
    })
    if (isRecord(snapshot.initialExecutionState) && 'targetExecutionStateHash' in snapshot.initialExecutionState) {
      issues.push(structureIssue(`${path}.baseSnapshot.initialExecutionState.targetExecutionStateHash`, 'A schema 7 ProductionPlan cannot carry targetExecutionStateHash.'))
    }
  }
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((step: unknown, index) => {
      if (!isRecord(step)) return
      const stepPath = `${path}.steps[${index}]`
      if ('executionEffects' in step) {
        issues.push(structureIssue(`${stepPath}.executionEffects`, 'A schema 7 PlanStep cannot carry executionEffects.'))
      }
      if (step.operationType === 'confirm_owned_ideal') {
        issues.push(structureIssue(`${stepPath}.operationType`, 'A schema 7 PlanStep cannot be confirm_owned_ideal.'))
      }
      ;(['expectedStateBefore', 'expectedStateAfter'] as const).forEach((field) => {
        const state = step[field]
        if (isRecord(state) && 'targetExecutionStateHash' in state) {
          issues.push(structureIssue(`${stepPath}.${field}.targetExecutionStateHash`, 'A schema 7 PlanStep cannot carry targetExecutionStateHash.'))
        }
      })
    })
  }
  return issues
}

/**
 * Pure schema 7 -> 8 Export migration.
 *
 * Schema 8 only adds the calculation schema 12 ProductionPlan shape, and every
 * Plan in a schema 7 Export is a calculation schema 11 or earlier Plan. So the
 * migration changes nothing but the version: it never adds `executionEffects`,
 * never merges a `reserve_weapon` Step into a physical Step, never infers a
 * tracked OwnedWeapon or an observation binding, and never computes a Target
 * execution state hash. Those Plans keep their exact persisted contents and are
 * failed closed at the CalculationContext boundary.
 *
 * A schema 7 root whose Plans - persisted, inside an ExecutionHistory Undo
 * snapshot, or inside a game save point - already carry a schema 8 field is not
 * a schema 7 root, so it fails closed.
 */
export function migrateExportRootV7ToV8(
  root: ExportRootV7,
): { ok: true; root: ExportRootV8 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['productionPlans', 'executionHistory', 'executionSavePoints']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }
  const issues = [
    ...root.productionPlans.flatMap((plan, index) =>
      schemaV8PlanFieldIssues(plan, `productionPlans[${index}]`)),
    ...root.executionHistory.flatMap((history, index) =>
      schemaV8PlanFieldIssues(
        isRecord(history.undoSnapshot) ? history.undoSnapshot.productionPlanBefore : undefined,
        `executionHistory[${index}].undoSnapshot.productionPlanBefore`,
      )),
    ...root.executionSavePoints.flatMap((savePoint, index) =>
      schemaV8PlanFieldIssues(savePoint.productionPlan, `executionSavePoints[${index}].productionPlan`)),
  ]
  if (issues.length > 0) return { ok: false, issues }
  let migrated: ExportRootV7
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  return { ok: true, root: { ...migrated, schemaVersion: 8 } }
}

/**
 * Pure schema 8 -> 9 Export migration.
 *
 * Schema 9 adds the ProductionPlan lifecycle metadata and the Execution
 * lifecycle Undo snapshot. No runtime before schema 9 moved a Plan past
 * `active` or wrote an ExecutionHistory, so:
 *
 * - a `draft` / `active` / `stale` Plan - persisted or inside a game save point -
 *   gets `abandonmentReason = abandonedAt = completedAt = null`, the only value
 *   its status allows
 * - a `completed` or `abandoned` Plan would need a completion time or an
 *   abandonment reason nobody recorded, so the root fails closed instead of
 *   guessing one
 * - an ExecutionHistory Undo snapshot has no `affectedTargetWeaponsBefore` or
 *   `executionSavePointBefore`, which cannot be reconstructed (an empty list or
 *   `null` would claim that no Target changed and no save point existed), so a
 *   root with any ExecutionHistory fails closed
 *
 * A schema 8 Plan that already carries a lifecycle field is not a schema 8
 * record, so it fails closed too.
 */
export function migrateExportRootV8ToV9(
  root: ExportRootV8,
): { ok: true; root: ExportRootV9 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['productionPlans', 'executionHistory', 'executionSavePoints']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }
  const planIssues = (plan: unknown, path: string): DomainValidationIssue[] => {
    if (!isRecord(plan)) return [structureIssue(path, `${path} must be an object.`)]
    if (hasProductionPlanLifecycleField(plan)) {
      return [structureIssue(path, 'A schema 8 ProductionPlan cannot carry the schema 9 lifecycle fields.')]
    }
    if (isTerminalProductionPlanRecord(plan)) {
      return [structureIssue(`${path}.status`, 'A schema 8 completed or abandoned ProductionPlan has no recorded lifecycle metadata and cannot be migrated.')]
    }
    return []
  }
  const issues = [
    ...root.productionPlans.flatMap((plan, index) => planIssues(plan, `productionPlans[${index}]`)),
    ...root.executionSavePoints.flatMap((savePoint, index) =>
      planIssues(savePoint.productionPlan, `executionSavePoints[${index}].productionPlan`)),
    ...root.executionHistory.map((_history, index) =>
      structureIssue(`executionHistory[${index}].undoSnapshot`, 'A schema 8 ExecutionHistory Undo snapshot lacks the Target and save point state and cannot be migrated.')),
  ]
  if (issues.length > 0) return { ok: false, issues }
  let migrated: ExportRootV8
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  migrated.productionPlans.forEach((plan) =>
    fillNonTerminalPlanLifecycle(plan as unknown as Record<string, unknown>))
  migrated.executionSavePoints.forEach((savePoint) =>
    fillNonTerminalPlanLifecycle(savePoint.productionPlan as unknown as Record<string, unknown>))
  return { ok: true, root: { ...migrated, schemaVersion: 9 } }
}

/**
 * Pure migration from Export schema 9 to 10 (`docs/DATA_MODEL.md` 15.3): the
 * Identification provenance `lastIdentifiedAt` is added as `null` to the
 * RngState (record schema version 2) and to every NormalArtianCounter, in the
 * root, in every game save point, in every ExecutionHistory Undo snapshot and
 * in the save point an Undo snapshot holds as `executionSavePointBefore`.
 * `null` is the only value a schema 9 record can state - no adoption time was
 * recorded - and is never backfilled from `updatedAt`, `lastObservedAt` or a
 * `source === 'observation'`. A schema 9 body that already carries the field,
 * or an RngState already at record schema version 2, is not a schema 9 record
 * and fails closed. Nothing else is converted.
 */
export function migrateExportRootV9ToV10(
  root: ExportRootV9,
): { ok: true; root: ExportRootV10 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['normalArtianCounters', 'executionHistory', 'executionSavePoints']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (record.rngState !== null && !isRecord(record.rngState)) {
    shapeIssues.push(structureIssue('rngState', 'rngState must be an object or null.'))
  }
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  const checkRngState = (value: unknown, path: string) => {
    if (!isRecord(value)) {
      issues.push(structureIssue(path, `${path} must be an object.`))
      return
    }
    if (hasIdentificationProvenanceField(value) || value.schemaVersion === RNG_STATE_PROVENANCE_SCHEMA_VERSION) {
      issues.push(structureIssue(path, 'A schema 9 RngState cannot carry the schema 10 Identification provenance.'))
    }
  }
  const checkCounters = (value: unknown, path: string) => {
    if (!Array.isArray(value)) {
      issues.push(structureIssue(path, `${path} must be an array.`))
      return
    }
    value.forEach((counter: unknown, index) => {
      const counterPath = `${path}[${index}]`
      if (!isRecord(counter)) {
        issues.push(structureIssue(counterPath, `${counterPath} must be an object.`))
      } else if (hasIdentificationProvenanceField(counter)) {
        issues.push(structureIssue(counterPath, 'A schema 9 NormalArtianCounter cannot carry the schema 10 Identification provenance.'))
      }
    })
  }
  if (record.rngState !== null) checkRngState(record.rngState, 'rngState')
  checkCounters(record.normalArtianCounters, 'normalArtianCounters')
  root.executionSavePoints.forEach((savePoint, index) => {
    const body = savePoint as unknown as Record<string, unknown>
    checkRngState(body.rngState, `executionSavePoints[${index}].rngState`)
    checkCounters(body.normalCounters, `executionSavePoints[${index}].normalCounters`)
  })
  root.executionHistory.forEach((history, index) => {
    const snapshot = (history as unknown as Record<string, unknown>).undoSnapshot
    const path = `executionHistory[${index}].undoSnapshot`
    if (!isRecord(snapshot)) {
      issues.push(structureIssue(path, `${path} must be an object.`))
      return
    }
    checkRngState(snapshot.rngStateBefore, `${path}.rngStateBefore`)
    checkCounters(snapshot.normalCountersBefore, `${path}.normalCountersBefore`)
    // The save point a terminal transition deleted into the Undo snapshot
    // carries its own RngState / Normal Counter bodies (`docs/DATA_MODEL.md`
    // 12); they are schema 9 bodies exactly like the snapshot's own.
    const savePointBefore = snapshot.executionSavePointBefore
    if (savePointBefore !== null && savePointBefore !== undefined) {
      const savePointPath = `${path}.executionSavePointBefore`
      if (!isRecord(savePointBefore)) {
        issues.push(structureIssue(savePointPath, `${savePointPath} must be an object or null.`))
        return
      }
      checkRngState(savePointBefore.rngState, `${savePointPath}.rngState`)
      checkCounters(savePointBefore.normalCounters, `${savePointPath}.normalCounters`)
    }
  })
  if (issues.length > 0) return { ok: false, issues }

  let migrated: ExportRootV9
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  const fillRngState = (value: unknown) => {
    if (isRecord(value)) fillRngStateIdentificationProvenance(value)
  }
  const fillCounters = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((counter: unknown) => {
        if (isRecord(counter)) fillNormalCounterIdentificationProvenance(counter)
      })
    }
  }
  const migratedRecord = migrated as unknown as Record<string, unknown>
  fillRngState(migratedRecord.rngState)
  fillCounters(migratedRecord.normalArtianCounters)
  migrated.executionSavePoints.forEach((savePoint) => {
    const body = savePoint as unknown as Record<string, unknown>
    fillRngState(body.rngState)
    fillCounters(body.normalCounters)
  })
  migrated.executionHistory.forEach((history) => {
    const snapshot = (history as unknown as Record<string, unknown>).undoSnapshot as Record<string, unknown>
    fillRngState(snapshot.rngStateBefore)
    fillCounters(snapshot.normalCountersBefore)
    const savePointBefore = snapshot.executionSavePointBefore
    if (isRecord(savePointBefore)) {
      fillRngState(savePointBefore.rngState)
      fillCounters(savePointBefore.normalCounters)
    }
  })
  return { ok: true, root: { ...migrated, schemaVersion: 10 } }
}

/**
 * Pure migration from Export schema 10 to 11 (`docs/DATA_MODEL.md` 15.3): every
 * `draft` ProductionPlan of `root.productionPlans` is deleted and nothing else
 * changes. A schema 10 root was written under the old Draft contract, in which
 * every Planner save added a Draft beside the earlier ones and no UI could list
 * or delete them, so it may hold any number of Drafts, each possibly naming
 * BuildListEntries the user has since removed. Schema 11 keeps at most one
 * Draft - the current one - and no persisted authority says which accumulated
 * Draft the user meant, so none is chosen by `createdAt`, `updatedAt` or ID: all
 * are deleted. The BuildListEntries, BuildCandidates and Targets a deleted Draft
 * referenced are kept, because a Draft owns no Entry and nothing is cascaded.
 * `active` / `stale` / `completed` / `abandoned` Plans, the Plan bodies inside an
 * ExecutionHistory Undo snapshot or a game save point, and every other
 * collection keep their exact contents. A root already at schema 11 never
 * passes through here, so a schema 11 Draft is kept.
 */
export function migrateExportRootV10ToV11(
  root: ExportRootV10,
): { ok: true; root: ExportRootV11 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const shapeIssues = collectionShapeIssues(root as unknown as Record<string, unknown>, 'productionPlans')
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }
  let migrated: ExportRootV10
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  const productionPlans = migrated.productionPlans.filter(
    (plan) => !isDraftProductionPlanRecord(plan as unknown as Record<string, unknown>),
  )
  return {
    ok: true,
    root: {
      ...migrated,
      productionPlans,
      schemaVersion: 11,
    },
  }
}

/**
 * Pure migration from Export schema 11 to 12 (`docs/DATA_MODEL.md` 15.3): the
 * AppSettings v1 record becomes v2 through the same `upgradeAppSettingsToV2()`
 * the Dexie v8 -> v9 upgrade uses - `candidateSearchDefaults` is the
 * recommended `350 / 500 / 1500` and the record version becomes 2 - and nothing
 * else changes. A schema 11 root never held user-chosen Candidate Search bounds,
 * so the recommendation is the only value it can state; `debugMode`,
 * `resultPageSize`, `defaultSearchLimit` and the timestamps keep their values,
 * and `defaultSearchLimit` is never copied into the new bounds. A schema 11
 * `settings` that is not an AppSettings v1 record - not an object, already
 * carrying `candidateSearchDefaults`, or at another record version - is not a
 * schema 11 body and fails closed instead of being guessed.
 */
export function migrateExportRootV11ToV12(
  root: ExportRootV11,
): { ok: true; root: ExportRootV12 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const settings = (root as unknown as Record<string, unknown>).settings
  if (!isRecord(settings)) {
    return { ok: false, issues: [structureIssue('settings', 'settings must be an object.')] }
  }
  if (!isLegacyAppSettingsRecord(settings)) {
    return {
      ok: false,
      issues: [structureIssue('settings', 'A schema 11 AppSettings must be an AppSettings v1 record without candidateSearchDefaults.')],
    }
  }
  let migrated: ExportRootV11
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  const migratedSettings = migrated.settings as unknown as Record<string, unknown>
  upgradeAppSettingsToV2(migratedSettings)
  return {
    ok: true,
    root: {
      ...migrated,
      settings: migratedSettings as unknown as AppSettings,
      schemaVersion: 12,
    },
  }
}

/**
 * Pure migration from Export schema 12 to 13 (`docs/DATA_MODEL.md` 11.1.1 /
 * 15.3, `docs/PLANNER_SPEC.md` 9.2.19.15): `conflictRepairLineage = null` is
 * added to every ProductionPlan body - `root.productionPlans`, the Plan of every
 * game save point, the `productionPlanBefore` of every ExecutionHistory Undo
 * snapshot and the Plan of the save point an Undo snapshot holds as
 * `executionSavePointBefore` - through the same
 * `fillProductionPlanConflictRepairLineage()` the Dexie v9 -> v10 upgrade uses.
 * `null` is the only value a schema 12 body can state: no repair decision was
 * ever saved, and none is reconstructed from selected Conflicts,
 * BuildListEntries or ExecutionHistory. A schema 12 body that already carries
 * the field is not a schema 12 body and fails closed instead of being
 * overwritten or trusted. Nothing else is converted.
 */
export function migrateExportRootV12ToV13(
  root: ExportRootV12,
): { ok: true; root: ExportRootV13 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['productionPlans', 'executionHistory', 'executionSavePoints']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  const checkPlan = (value: unknown, path: string) => {
    if (!isRecord(value)) {
      issues.push(structureIssue(path, `${path} must be an object.`))
    } else if (hasConflictRepairLineageField(value)) {
      issues.push(structureIssue(path, 'A schema 12 ProductionPlan cannot carry the schema 13 conflictRepairLineage.'))
    }
  }
  root.productionPlans.forEach((plan, index) => checkPlan(plan, `productionPlans[${index}]`))
  root.executionSavePoints.forEach((savePoint, index) => {
    checkPlan((savePoint as unknown as Record<string, unknown>).productionPlan, `executionSavePoints[${index}].productionPlan`)
  })
  root.executionHistory.forEach((history, index) => {
    const snapshot = (history as unknown as Record<string, unknown>).undoSnapshot
    const path = `executionHistory[${index}].undoSnapshot`
    if (!isRecord(snapshot)) {
      issues.push(structureIssue(path, `${path} must be an object.`))
      return
    }
    checkPlan(snapshot.productionPlanBefore, `${path}.productionPlanBefore`)
    const savePointBefore = snapshot.executionSavePointBefore
    if (savePointBefore !== null && savePointBefore !== undefined) {
      const savePointPath = `${path}.executionSavePointBefore`
      if (!isRecord(savePointBefore)) {
        issues.push(structureIssue(savePointPath, `${savePointPath} must be an object or null.`))
        return
      }
      checkPlan(savePointBefore.productionPlan, `${savePointPath}.productionPlan`)
    }
  })
  if (issues.length > 0) return { ok: false, issues }

  let migrated: ExportRootV12
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  const fillPlan = (value: unknown) => {
    if (isRecord(value)) fillProductionPlanConflictRepairLineage(value)
  }
  migrated.productionPlans.forEach((plan) => fillPlan(plan))
  migrated.executionSavePoints.forEach((savePoint) => fillPlan(savePoint.productionPlan))
  migrated.executionHistory.forEach((history) => {
    const snapshot = history.undoSnapshot as unknown as Record<string, unknown>
    fillPlan(snapshot.productionPlanBefore)
    const savePointBefore = snapshot.executionSavePointBefore
    if (isRecord(savePointBefore)) fillPlan(savePointBefore.productionPlan)
  })
  return { ok: true, root: { ...migrated, schemaVersion: 13 } }
}

/**
 * Pure migration from Export schema 13 to 14 (`docs/DATA_MODEL.md` 14.2 / 15.1,
 * `docs/PLANNER_SPEC.md` 19.8): every ExecutionHistory record becomes its
 * `docs/DATA_MODEL.md` 12.2 metadata and Undo body through
 * `convertExecutionHistoryCollection()` - the order rule, the reference Plan rule
 * and the per-record rule the Dexie version(11) upgrade uses - with the root's
 * `productionPlans` as the Plans as they are now. Nothing else is converted and
 * nothing is guessed.
 *
 * Fails closed, applying nothing, when any record cannot be converted (a schema
 * 14 root never holds such a record, unlike a database the upgrade left in
 * case 2), or when the root already holds a schema 14 part: `executionUndoSnapshots`,
 * a record with a top-level `addedOwnedWeaponIds`, or an Undo snapshot with a
 * `productionPlanStateBefore`.
 */
export function migrateExportRootV13ToV14(
  root: ExportRootV13,
): { ok: true; root: ExportRootV14 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['productionPlans', 'executionHistory']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  if ('executionUndoSnapshots' in record) {
    issues.push(structureIssue('executionUndoSnapshots', 'A schema 13 Export cannot carry executionUndoSnapshots.'))
  }
  root.executionHistory.forEach((history, index) => {
    const body = history as unknown as Record<string, unknown>
    const path = `executionHistory[${index}]`
    if ('addedOwnedWeaponIds' in body) {
      issues.push(structureIssue(`${path}.addedOwnedWeaponIds`, 'A schema 13 ExecutionHistory cannot carry the schema 14 addedOwnedWeaponIds.'))
    }
    if (isRecord(body.undoSnapshot) && 'productionPlanStateBefore' in body.undoSnapshot) {
      issues.push(structureIssue(`${path}.undoSnapshot.productionPlanStateBefore`, 'A schema 13 Undo snapshot cannot carry the schema 14 productionPlanStateBefore.'))
    }
  })
  if (issues.length > 0) return { ok: false, issues }

  let migrated: ExportRootV13
  try {
    migrated = structuredClone(root)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  const conversions = convertExecutionHistoryCollection(migrated.executionHistory, migrated.productionPlans)
  const executionHistory: ExecutionHistory[] = []
  const executionUndoSnapshots: ExecutionUndoSnapshot[] = []
  conversions.forEach((conversion, index) => {
    const path = `executionHistory[${index}]`
    if (conversion.kind === 'unconvertible') {
      issues.push(
        { path, code: 'invalid_structure', message: `${conversion.message} (${conversion.failure})` },
        ...conversion.issues.map((issue) => ({ ...issue, path: issue.path ? `${path}.${issue.path}` : path })),
      )
      return
    }
    executionHistory.push(conversion.executionHistory)
    executionUndoSnapshots.push(conversion.executionUndoSnapshot)
  })
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    root: { ...migrated, schemaVersion: 14, executionHistory, executionUndoSnapshots },
  }
}

/** Every TargetWeapon body list of an Export root with its path (`docs/DATA_MODEL.md` 15.1 schema 15). */
function targetWeaponBodyLists(root: Record<string, unknown>): { owner: Record<string, unknown>; field: string; path: string }[] {
  const lists: { owner: Record<string, unknown>; field: string; path: string }[] = [
    { owner: root, field: 'targetWeapons', path: 'targetWeapons' },
  ]
  const savePoints = root.executionSavePoints
  if (Array.isArray(savePoints)) {
    savePoints.forEach((savePoint: unknown, index) => {
      if (isRecord(savePoint)) lists.push({ owner: savePoint, field: 'targetWeapons', path: `executionSavePoints[${index}].targetWeapons` })
    })
  }
  const snapshots = root.executionUndoSnapshots
  if (Array.isArray(snapshots)) {
    snapshots.forEach((snapshot: unknown, index) => {
      if (!isRecord(snapshot)) return
      const path = `executionUndoSnapshots[${index}]`
      lists.push({ owner: snapshot, field: 'affectedTargetWeaponsBefore', path: `${path}.affectedTargetWeaponsBefore` })
      const deleted = snapshot.deletedExecutionSavePoint
      if (isRecord(deleted)) lists.push({ owner: deleted, field: 'targetWeapons', path: `${path}.deletedExecutionSavePoint.targetWeapons` })
    })
  }
  return lists
}

/**
 * Pure migration from Export schema 14 to 15 (`docs/DATA_MODEL.md` 8.6 / 15.1,
 * `docs/PLANNER_SPEC.md` 20.8): every TargetWeapon body - top-level, in a game
 * save point, in an Undo body and in the save point an Undo body holds - goes
 * through `migrateLegacyTargetWeaponToCompletionConditions()`, the conversion
 * the Dexie version(12) upgrade shares. Nothing else is converted and nothing
 * is guessed: BuildCandidate / BuildListEntry / ProductionPlan /
 * ExecutionHistory bodies keep their contents and fail closed at the
 * calculation schema 19 boundary.
 *
 * Fails closed, applying nothing, when a Target body already carries a schema
 * 15 field (it is not a schema 14 body) or lacks the legacy structure.
 */
export function migrateExportRootV14ToV15(
  root: ExportRootV14,
): { ok: true; root: ExportRootV15 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['targetWeapons', 'executionSavePoints', 'executionUndoSnapshots']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  targetWeaponBodyLists(record).forEach(({ owner, field, path }) => {
    const list = owner[field]
    if (!Array.isArray(list)) {
      issues.push(structureIssue(path, `${path} must be an array.`))
      return
    }
    list.forEach((target: unknown, index) => {
      if (isRecord(target) && hasCompletionConditionTargetField(target)) {
        issues.push(structureIssue(`${path}[${index}]`, 'A schema 14 TargetWeapon cannot carry a schema 15 completion condition field.'))
      }
    })
  })
  if (issues.length > 0) return { ok: false, issues }

  let migrated: Record<string, unknown>
  try {
    migrated = structuredClone(record)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  try {
    targetWeaponBodyLists(migrated).forEach(({ owner, field, path }) => {
      owner[field] = migrateLegacyTargetWeaponList(owner[field], path)
    })
  } catch (error) {
    if (error instanceof LegacyTargetWeaponMigrationError) {
      return { ok: false, issues: [structureIssue(error.path, error.message)] }
    }
    throw error
  }
  return { ok: true, root: { ...(migrated as unknown as ExportRootV15), schemaVersion: 15 } }
}

/**
 * Pure migration from Export schema 15 to 16 (Issue #334, `docs/DATA_MODEL.md`
 * 8.7 / 15.1, `docs/PLANNER_SPEC.md` 21.3 / 21.9): every TargetWeapon body -
 * top-level, in a game save point, in an Undo body and in the save point an
 * Undo body holds - gets `completedWithOwnedWeaponId = null` through
 * `fillTargetWeaponCompletionAssignment()`, the fill the Dexie version(13)
 * upgrade shares. A `completed` Target gets `null` ("not recorded") too:
 * nothing is inferred from `completedByProductionPlanId`, a Plan's
 * `targetCompletions` or an owned Ideal weapon, and every other collection and
 * field keeps its exact contents.
 *
 * Fails closed, applying nothing, when a Target body already carries the field
 * (a root claiming schema 15 whose bodies are not schema 15 bodies).
 */
export function migrateExportRootV15ToV16(
  root: ExportRootV15,
): { ok: true; root: ExportRootV16 } | { ok: false; issues: DomainValidationIssue[] } {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['targetWeapons', 'executionSavePoints', 'executionUndoSnapshots']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  targetWeaponBodyLists(record).forEach(({ owner, field, path }) => {
    const list = owner[field]
    if (!Array.isArray(list)) {
      issues.push(structureIssue(path, `${path} must be an array.`))
      return
    }
    list.forEach((target: unknown, index) => {
      if (isRecord(target) && TARGET_COMPLETION_ASSIGNMENT_FIELD in target) {
        issues.push(structureIssue(`${path}[${index}]`, 'A schema 15 TargetWeapon cannot carry the schema 16 completedWithOwnedWeaponId field.'))
      }
    })
  })
  if (issues.length > 0) return { ok: false, issues }

  let migrated: Record<string, unknown>
  try {
    migrated = structuredClone(record)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  try {
    targetWeaponBodyLists(migrated).forEach(({ owner, field, path }) => {
      fillTargetWeaponListCompletionAssignment(owner[field], path)
    })
  } catch (error) {
    if (error instanceof TargetCompletionAssignmentMigrationError) {
      return { ok: false, issues: [structureIssue(error.path, error.message)] }
    }
    throw error
  }
  return { ok: true, root: { ...(migrated as unknown as ExportRootV16), schemaVersion: 16 } }
}

/**
 * Pure migration from Export schema 16 to 17 (Issue #367, `docs/DATA_MODEL.md`
 * 8.4 / 15.1, `docs/PLANNER_SPEC.md` 22.7): every TargetWeapon body - top-level,
 * in a game save point, in an Undo body and in the save point an Undo body
 * holds - turns its one `completionSkillCondition` into one completion Skill
 * configuration with the same Series / Group IDs through
 * `migrateTargetWeaponCompletionSkillVariants()`, the conversion the Dexie
 * version(14) upgrade shares. Lossless and guessing nothing: no review reason is
 * added, every other collection and field keeps its exact contents, and the
 * Target definition hash does not move.
 *
 * Fails closed, applying nothing, when a Target body already carries
 * `completionSkillVariants`, has no `completionSkillCondition`, or holds one
 * whose `matchMode` is not `"all"` (a root claiming schema 16 whose bodies are
 * not schema 16 bodies).
 */
export function migrateExportRootV16ToV17(root: ExportRootV16): ExportRootMigrationResult {
  if (!isRecord(root)) {
    return { ok: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ['targetWeapons', 'executionSavePoints', 'executionUndoSnapshots']
    .flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = []
  targetWeaponBodyLists(record).forEach(({ owner, field, path }) => {
    const list = owner[field]
    if (!Array.isArray(list)) {
      issues.push(structureIssue(path, `${path} must be an array.`))
      return
    }
    list.forEach((target: unknown, index) => {
      if (isRecord(target) && TARGET_COMPLETION_SKILL_VARIANTS_FIELD in target) {
        issues.push(structureIssue(`${path}[${index}]`, 'A schema 16 TargetWeapon cannot carry the schema 17 completionSkillVariants field.'))
      }
    })
  })
  if (issues.length > 0) return { ok: false, issues }

  let migrated: Record<string, unknown>
  try {
    migrated = structuredClone(record)
  } catch {
    return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
  }
  try {
    targetWeaponBodyLists(migrated).forEach(({ owner, field, path }) => {
      migrateTargetWeaponListCompletionSkillVariants(owner[field], path)
    })
  } catch (error) {
    if (error instanceof TargetCompletionSkillVariantsMigrationError) {
      return { ok: false, issues: [structureIssue(error.path, error.message)] }
    }
    throw error
  }
  return { ok: true, root: { ...(migrated as unknown as ExportRoot), schemaVersion: EXPORT_SCHEMA_VERSION } }
}

function prefixed(
  prefix: string,
  nested: DomainValidationResult,
): DomainValidationIssue[] {
  return nested.issues.map((issue) => ({
    ...issue,
    path: issue.path
      ? `${prefix}${issue.path.startsWith('[') ? '' : '.'}${issue.path}`
      : prefix,
  }))
}

/**
 * The ExecutionHistory records of a current-schema root (`docs/DATA_MODEL.md`
 * 12.2 / 15.2), through the one record collection authority
 * `validateExecutionRecordCollection()`. A record of the schema 13 shape fails
 * the metadata validation, and no Plan body before a Step is validated record
 * by record.
 */
function executionRecordIssues(root: ExportRoot): DomainValidationIssue[] {
  return validateExecutionRecordCollection(root.executionHistory, root.executionUndoSnapshots, root.productionPlans).issues
}

/**
 * Validates the Execution lifecycle state of a current-schema Export root:
 * TargetWeapon lifecycle, `OwnedWeapon.executionInProgress`, and every game
 * save point with its Plan / ExecutionHistory references and the one-per-Plan
 * rule. It is one step of full-replacement Import validation, not all of it;
 * deep expected-state validation of a save point belongs to the Execution
 * service that restores it.
 */
export function validateExportRootExecutionLifecycle(
  root: ExportRoot,
): DomainValidationResult {
  if (!isRecord(root)) {
    return { isValid: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const issues: DomainValidationIssue[] = []
  if (root.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    issues.push({
      path: 'schemaVersion',
      code: 'invalid_literal',
      message: `Export schemaVersion must be ${EXPORT_SCHEMA_VERSION}.`,
    })
  }
  // Every collection this function reads is shape-checked element by element
  // before any typed validator dereferences a field.
  const shapeIssues = [
    'ownedWeapons',
    'targetWeapons',
    'productionPlans',
    'executionHistory',
    'executionUndoSnapshots',
    'executionSavePoints',
  ].flatMap((field) => collectionShapeIssues(record, field))
  if (shapeIssues.length > 0) {
    return { isValid: false, issues: [...issues, ...shapeIssues] }
  }
  const savePointShapeProblems = (root.executionSavePoints as unknown[]).flatMap(
    (savePoint, index) =>
      savePointShapeIssues(savePoint as Record<string, unknown>, `executionSavePoints[${index}]`),
  )
  if (savePointShapeProblems.length > 0) {
    return { isValid: false, issues: [...issues, ...savePointShapeProblems] }
  }

  root.ownedWeapons.forEach((weapon, index) => {
    const path = `ownedWeapons[${index}]`
    issues.push(...runTypedValidation(path, () => prefixed(path, validateOwnedWeapon(weapon))))
  })
  root.targetWeapons.forEach((target, index) => {
    const path = `targetWeapons[${index}]`
    issues.push(...runTypedValidation(path, () => prefixed(path, validateTargetWeapon(target))))
  })
  root.productionPlans.forEach((plan, index) => {
    const path = `productionPlans[${index}]`
    issues.push(...runTypedValidation(path, () => prefixed(path, validateProductionPlan(plan))))
  })
  issues.push(...executionRecordIssues(root))
  root.executionSavePoints.forEach((savePoint, index) => {
    const path = `executionSavePoints[${index}]`
    issues.push(...runTypedValidation(path, () => prefixed(path, validateExecutionSavePoint(savePoint))))
  })
  issues.push(
    ...runTypedValidation('executionSavePoints', () =>
      prefixed(
        'executionSavePoints',
        validateExecutionSavePointReferences(
          root.executionSavePoints,
          root.productionPlans,
          root.executionHistory,
        ),
      ),
    ),
  )
  return { isValid: issues.length === 0, issues }
}

/**
 * Validates the root-level RNG persistent state of a current-schema Export
 * root: `rngState` (`null`, or a RngState meeting the current Domain contract -
 * record schema version 2, KnownValue shapes and the Identification provenance
 * `lastIdentifiedAt`) and every `normalArtianCounters` record
 * (`validateNormalArtianCounter()`, provenance included). A root claiming the
 * current schema is never trusted by its cast: an untrusted body is shape-checked
 * before any typed validator dereferences a field, so a malformed one is refused
 * without throwing. The RngState / Normal Counter bodies inside a game save
 * point or an Undo snapshot are validated by their own entity validators through
 * `validateExportRootExecutionLifecycle()` and are not repeated here.
 */
export function validateExportRootPersistentState(
  root: ExportRoot,
): DomainValidationResult {
  if (!isRecord(root)) {
    return { isValid: false, issues: [structureIssue('', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const issues: DomainValidationIssue[] = []
  if (record.rngState !== null) {
    if (!isRecord(record.rngState)) {
      issues.push(structureIssue('rngState', 'rngState must be an object or null.'))
    } else {
      issues.push(...runTypedValidation('rngState', () => prefixed('rngState', validateRngState(root.rngState as RngState))))
    }
  }
  const shapeIssues = collectionShapeIssues(record, 'normalArtianCounters')
  if (shapeIssues.length > 0) return { isValid: false, issues: [...issues, ...shapeIssues] }
  root.normalArtianCounters.forEach((counter, index) => {
    const path = `normalArtianCounters[${index}]`
    issues.push(...runTypedValidation(path, () => prefixed(path, validateNormalArtianCounter(counter))))
  })
  return { isValid: issues.length === 0, issues }
}

/**
 * The whole current-schema Export root validation Import preparation runs: the
 * Execution lifecycle state (`validateExportRootExecutionLifecycle()`) and the
 * root-level RNG persistent state (`validateExportRootPersistentState()`).
 */
export function validateCurrentExportRoot(root: ExportRoot): DomainValidationResult {
  const lifecycle = validateExportRootExecutionLifecycle(root)
  const persistent = validateExportRootPersistentState(root)
  const issues = [...lifecycle.issues, ...persistent.issues]
  return { isValid: issues.length === 0, issues }
}

/**
 * Brings a parsed Export object to the current schema and validates its
 * Execution lifecycle state and root-level RNG persistent state, failing closed
 * on anything else. Schema 17 is read as is; schema 16 goes through
 * `migrateExportRootV16ToV17()`; schema 15 through `migrateExportRootV15ToV16()`
 * and then 16 -> 17; schema 14 through `migrateExportRootV14ToV15()` and then
 * 15 -> 16 -> 17; schema 13 through `migrateExportRootV13ToV14()` and then
 * 14 -> 15 -> 16 -> 17; schema 12 through `migrateExportRootV12ToV13()` and then
 * 13 -> ... -> 17; schema 11 through `migrateExportRootV11ToV12()` and then
 * 12 -> ... -> 17 (its one Draft is current data and is never deleted);
 * schema 10, 9, 8, 7 and 6 go through the pure migrations in order
 * (`migrateExportRootV6ToV7()`, `migrateExportRootV7ToV8()`,
 * `migrateExportRootV8ToV9()`, `migrateExportRootV9ToV10()`,
 * `migrateExportRootV10ToV11()`, `migrateExportRootV11ToV12()`,
 * `migrateExportRootV12ToV13()`, `migrateExportRootV13ToV14()`,
 * `migrateExportRootV14ToV15()`, `migrateExportRootV15ToV16()`, `migrateExportRootV16ToV17()`), and every other version is refused. Nothing is applied here: the caller replaces its data only
 * after a successful result.
 */
export function prepareExportRootForImport(
  input: unknown,
): ExportRootMigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: '', code: 'invalid_structure', message: 'Export root must be an object.' }],
    }
  }
  const candidate = input as Record<string, unknown>
  if (candidate.appName !== EXPORT_APP_NAME) {
    return {
      ok: false,
      issues: [{ path: 'appName', code: 'invalid_literal', message: 'Export appName is not supported.' }],
    }
  }
  // Each step of the chain runs the pure migrations in order and stops at the
  // first refusal.
  const fromV16 = (v16: ExportRootV16): ExportRootMigrationResult =>
    migrateExportRootV16ToV17(v16)
  const fromV15 = (v15: ExportRootV15): ExportRootMigrationResult => {
    const toV16 = migrateExportRootV15ToV16(v15)
    return toV16.ok ? fromV16(toV16.root) : toV16
  }
  const fromV14 = (v14: ExportRootV14): ExportRootMigrationResult => {
    const toV15 = migrateExportRootV14ToV15(v14)
    return toV15.ok ? fromV15(toV15.root) : toV15
  }
  const fromV13 = (v13: ExportRootV13): ExportRootMigrationResult => {
    const toV14 = migrateExportRootV13ToV14(v13)
    return toV14.ok ? fromV14(toV14.root) : toV14
  }
  const fromV12 = (v12: ExportRootV12): ExportRootMigrationResult => {
    const toV13 = migrateExportRootV12ToV13(v12)
    return toV13.ok ? fromV13(toV13.root) : toV13
  }
  const fromV11 = (v11: ExportRootV11): ExportRootMigrationResult => {
    const toV12 = migrateExportRootV11ToV12(v11)
    return toV12.ok ? fromV12(toV12.root) : toV12
  }
  const fromV10 = (v10: ExportRootV10): ExportRootMigrationResult => {
    const toV11 = migrateExportRootV10ToV11(v10)
    return toV11.ok ? fromV11(toV11.root) : toV11
  }
  const fromV9 = (v9: ExportRootV9): ExportRootMigrationResult => {
    const toV10 = migrateExportRootV9ToV10(v9)
    return toV10.ok ? fromV10(toV10.root) : toV10
  }
  const fromV8 = (v8: ExportRootV8): ExportRootMigrationResult => {
    const toV9 = migrateExportRootV8ToV9(v8)
    return toV9.ok ? fromV9(toV9.root) : toV9
  }
  const fromV7 = (v7: ExportRootV7): ExportRootMigrationResult => {
    const toV8 = migrateExportRootV7ToV8(v7)
    return toV8.ok ? fromV8(toV8.root) : toV8
  }
  let migrated: ExportRootMigrationResult
  if (candidate.schemaVersion === EXPORT_SCHEMA_VERSION) {
    const shapeIssues = [
      'ownedWeapons',
      'targetWeapons',
      'productionPlans',
      'executionHistory',
      'executionUndoSnapshots',
      'executionSavePoints',
    ].flatMap((field) => collectionShapeIssues(candidate, field))
    if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }
    try {
      migrated = { ok: true, root: structuredClone(input as ExportRoot) }
    } catch {
      return { ok: false, issues: [structureIssue('', 'Export root cannot be copied.')] }
    }
  } else if (candidate.schemaVersion === 16) {
    migrated = fromV16(input as ExportRootV16)
  } else if (candidate.schemaVersion === 15) {
    migrated = fromV15(input as ExportRootV15)
  } else if (candidate.schemaVersion === 14) {
    migrated = fromV14(input as ExportRootV14)
  } else if (candidate.schemaVersion === 13) {
    migrated = fromV13(input as ExportRootV13)
  } else if (candidate.schemaVersion === 12) {
    migrated = fromV12(input as ExportRootV12)
  } else if (candidate.schemaVersion === 11) {
    migrated = fromV11(input as ExportRootV11)
  } else if (candidate.schemaVersion === 10) {
    migrated = fromV10(input as ExportRootV10)
  } else if (candidate.schemaVersion === 9) {
    migrated = fromV9(input as ExportRootV9)
  } else if (candidate.schemaVersion === 8) {
    migrated = fromV8(input as ExportRootV8)
  } else if (candidate.schemaVersion === 7) {
    migrated = fromV7(input as ExportRootV7)
  } else if (candidate.schemaVersion === 6) {
    const shapeIssues = ['productionPlans', 'executionHistory']
      .flatMap((field) => collectionShapeIssues(candidate, field))
    if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }
    const toV7 = migrateExportRootV6ToV7(input as ExportRootV6)
    migrated = toV7.ok ? fromV7(toV7.root) : toV7
  } else {
    return {
      ok: false,
      issues: [{
        path: 'schemaVersion',
        code: 'invalid_literal',
        message: 'Export schemaVersion is not supported.',
      }],
    }
  }
  if (!migrated.ok) return migrated
  const root = migrated.root
  const validation = validateCurrentExportRoot(root)
  return validation.isValid ? { ok: true, root } : { ok: false, issues: validation.issues }
}
