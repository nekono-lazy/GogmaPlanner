import Dexie, { type Table, type Transaction } from 'dexie'
import { upgradeExecutionHistoryToV11 } from './executionHistoryV11Migration'
import { migrateLegacyTargetCompromise } from './migrateLegacyTargetCompromise'
import {
  LegacyTargetWeaponMigrationError,
  migrateLegacyTargetWeaponList,
  migrateLegacyTargetWeaponToCompletionConditions,
} from '../domain/models/legacyTargetWeapon'
import {
  fillNonTerminalPlanLifecycle,
  fillNormalCounterIdentificationProvenance,
  fillProductionPlanConflictRepairLineage,
  fillRngStateIdentificationProvenance,
  fillTargetWeaponCompletionAssignment,
  fillTargetWeaponListCompletionAssignment,
  isDraftProductionPlanRecord,
  migrateTargetWeaponCompletionSkillVariants,
  migrateTargetWeaponListCompletionSkillVariants,
  TargetCompletionAssignmentMigrationError,
  TargetCompletionSkillVariantsMigrationError,
  upgradeAppSettingsToV2,
} from '../domain/models/persistenceCompatibility'
import type {
  AppSettings,
  BuildCandidate,
  BuildListEntry,
  ExecutionHistory,
  ExecutionSavePoint,
  ExecutionUndoSnapshot,
  NormalArtianCounter,
  OwnedWeapon,
  ProductionPlan,
  RngState,
  TargetWeapon,
} from '../domain/models/publicTypes'

export const DATABASE_NAME = 'mh-wilds-gogma-artian-planner'
export const DATABASE_SCHEMA_VERSION = 14

export class AppDatabase extends Dexie {
  rngState!: Table<RngState, 'current'>
  normalArtianCounters!: Table<NormalArtianCounter, string>
  ownedWeapons!: Table<OwnedWeapon, string>
  targetWeapons!: Table<TargetWeapon, string>
  buildCandidates!: Table<BuildCandidate, string>
  buildListEntries!: Table<BuildListEntry, string>
  productionPlans!: Table<ProductionPlan, string>
  /**
   * The ExecutionHistory metadata (`docs/DATA_MODEL.md` 12.2). A record the
   * version 11 upgrade could not convert is kept here in its version 10 shape;
   * read the table through `ExecutionHistoryRepository`, which never returns
   * such a record as metadata.
   */
  executionHistory!: Table<ExecutionHistory, string>
  /** The ExecutionHistory Undo bodies, keyed by `executionHistoryId` (`docs/DATA_MODEL.md` 12.2). */
  executionUndoSnapshots!: Table<ExecutionUndoSnapshot, string>
  executionSavePoints!: Table<ExecutionSavePoint, string>
  settings!: Table<AppSettings, 'settings'>

  constructor(name = DATABASE_NAME) {
    super(name)
    this.version(1).stores({
      rngState: 'id',
      normalArtianCounters: 'id, [weaponTypeId+rarity], isConfirmed',
      ownedWeapons: 'id, weaponTypeId, elementId, status, isProtected, updatedAt',
      targetWeapons: 'id, weaponTypeId, elementId, priority, isEnabled, updatedAt',
      buildCandidates: 'id, targetWeaponId, category, searchStateHash, searchRunId, createdAt',
      buildListEntries: 'id, candidateId, targetWeaponId, searchStateHash, isStale, createdAt',
      productionPlans: 'id, status, createdAt, updatedAt',
      executionHistory: 'id, planId, planStepId, createdAt',
      settings: 'id',
    })
    this.version(2).stores({}).upgrade(async (transaction) => {
      await transaction.table('targetWeapons').toCollection().modify((target: Record<string, unknown>) => {
        const migrated = migrateLegacyTargetCompromise(target)
        delete target.practicalAlternativeGroups
        Object.assign(target, migrated)
      })
    })
    // v3 replaces `OwnedWeapon.relatedTargetWeaponIds` with the Target-side
    // `preferredOwnedWeaponId`. The old field recorded which Targets a weapon
    // had been created in connection with - provenance metadata that could be
    // one-to-many - while the new one states which weapon a Target wants to
    // start from. The two meanings do not correspond, so nothing is converted:
    // every Target starts with no preference and the user sets it explicitly.
    // Past calculation artifacts (BuildCandidate, BuildListEntry,
    // ProductionPlan, ExecutionHistory) keep their exact persisted contents and
    // fail closed through CalculationContext instead
    // (`docs/DATA_MODEL.md` 14.2).
    this.version(3).stores({}).upgrade(async (transaction) => {
      await transaction.table('targetWeapons').toCollection().modify((target: Record<string, unknown>) => {
        target.preferredOwnedWeaponId = null
      })
      await transaction.table('ownedWeapons').toCollection().modify((weapon: Record<string, unknown>) => {
        delete weapon.relatedTargetWeaponIds
      })
    })
    // v4 renames the owned Gogma `material` status to `unclassified`. The
    // "consume an owned Artian weapon as material" model is gone, so the value
    // no longer means anything about how the weapon may be used; it is now a
    // user-facing organisation label like the other two. Only the literal is
    // converted: `practical` and `ideal` keep their values, a Normal Artian
    // keeps `status: null`, `isProtected` is never touched (a formerly Material
    // weapon that the user had protected stays protected), and
    // `TargetWeapon.preferredOwnedWeaponId` is left alone.
    //
    // Past calculation artifacts (BuildCandidate, BuildListEntry,
    // ProductionPlan, ExecutionHistory) are deliberately NOT rewritten. Their
    // stored `use_weapon_as_material` / `create_material_gogma` /
    // `change_owned_weapon_status` operations and `status: 'material'` snapshots
    // keep their exact persisted contents and fail closed through
    // CalculationContext version 9 instead of being guessed into current
    // operations (`docs/DATA_MODEL.md` 14.2).
    this.version(4).stores({}).upgrade(async (transaction) => {
      await transaction.table('ownedWeapons').toCollection().modify((weapon: Record<string, unknown>) => {
        if (weapon.kind === 'gogma' && weapon.status === 'material') {
          weapon.status = 'unclassified'
        }
      })
    })
    // v5 adds the Execution lifecycle persisted state (`docs/DATA_MODEL.md`
    // 7.1 / 8.1 / 12.1 / 14.3). Every value it writes is the deterministic
    // "no Execution has happened yet" value, never an inference:
    //
    // - every Target becomes `active` with no completion metadata, even when
    //   the user already owns a weapon meeting its Ideal
    // - every OwnedWeapon gets `executionInProgress = null`, whatever Plans
    //   exist
    // - the new `executionSavePoints` table starts empty; no game save is
    //   guessed from ExecutionHistory
    //
    // `targetWeapons` gains a `lifecycleStatus` index, and `executionSavePoints`
    // is keyed by the Plan-derived ID with a unique `productionPlanId` index as
    // a second guard of the one-save-point-per-Plan rule. Past calculation
    // artifacts (BuildCandidate, BuildListEntry, ProductionPlan,
    // ExecutionHistory) keep their exact persisted contents. None of this moves
    // `CURRENT_CALCULATION_APP_SCHEMA_VERSION`: no calculation semantics change.
    this.version(5).stores({
      targetWeapons: 'id, weaponTypeId, elementId, priority, isEnabled, lifecycleStatus, updatedAt',
      executionSavePoints: 'id, &productionPlanId, recordedAt',
    }).upgrade(async (transaction) => {
      await transaction.table('targetWeapons').toCollection().modify((target: Record<string, unknown>) => {
        target.lifecycleStatus = 'active'
        target.completedAt = null
        target.completedByProductionPlanId = null
      })
      await transaction.table('ownedWeapons').toCollection().modify((weapon: Record<string, unknown>) => {
        weapon.executionInProgress = null
      })
    })
    // v6 adds the ProductionPlan lifecycle metadata (`abandonmentReason`,
    // `abandonedAt`, `completedAt`, `docs/DATA_MODEL.md` 11.1) required by the
    // Execution runtime. No table or index changes.
    //
    // Before this version no runtime ever moved a Plan past `active`: the
    // Planner saves `draft` Plans only, and nothing wrote `completed`,
    // `abandoned`, or any ExecutionHistory. So a `draft` / `active` / `stale`
    // Plan deterministically gets the three `null`s - the value its status
    // requires, not an inference. A `completed` or `abandoned` record has no
    // known completion time or abandonment reason, so it is left exactly as
    // persisted and fails Domain validation instead of being guessed
    // (`completedAt = updatedAt`, `user_abandoned`, ...). The same rule applies
    // to the Plan snapshot inside a game save point.
    //
    // ExecutionHistory is not rewritten either: an Undo snapshot written before
    // this version carries no `affectedTargetWeaponsBefore` or
    // `executionSavePointBefore`, which cannot be reconstructed, so it keeps its
    // persisted contents and is never undoable. None of this moves
    // `CURRENT_CALCULATION_APP_SCHEMA_VERSION`.
    this.version(6).stores({}).upgrade(async (transaction) => {
      await transaction.table('productionPlans').toCollection().modify((plan: Record<string, unknown>) => {
        fillNonTerminalPlanLifecycle(plan)
      })
      await transaction.table('executionSavePoints').toCollection().modify((savePoint: Record<string, unknown>) => {
        const plan = savePoint.productionPlan
        if (typeof plan === 'object' && plan !== null && !Array.isArray(plan)) {
          fillNonTerminalPlanLifecycle(plan as Record<string, unknown>)
        }
      })
    })
    // v7 adds the Identification provenance `lastIdentifiedAt` to RngState
    // (record schema version 2) and NormalArtianCounter (`docs/DATA_MODEL.md`
    // 6.1 / 6.2 / 14.2). No table or index changes. Every RngState /
    // NormalArtianCounter body is filled: the `rngState` and
    // `normalArtianCounters` tables, the bodies inside a game save point, the
    // bodies inside an ExecutionHistory Undo snapshot and the bodies of the save
    // point an Undo snapshot holds as `executionSavePointBefore`. The value written is
    // always `null` - "no formal Identification adoption is recorded" - because
    // no earlier runtime recorded when an adoption happened, and `updatedAt`,
    // `lastObservedAt` or a `source === 'observation'` never prove one. It is
    // reminder / recovery provenance only, so no calculation semantics change
    // and `CURRENT_CALCULATION_APP_SCHEMA_VERSION` stays where it is.
    this.version(7).stores({}).upgrade(async (transaction) => {
      const fillCounters = (value: unknown) => {
        if (Array.isArray(value)) {
          value.forEach((counter: unknown) => {
            if (isPlainRecord(counter)) fillNormalCounterIdentificationProvenance(counter)
          })
        }
      }
      const fillRngState = (value: unknown) => {
        if (isPlainRecord(value)) fillRngStateIdentificationProvenance(value)
      }
      await transaction.table('rngState').toCollection().modify((state: Record<string, unknown>) => {
        fillRngStateIdentificationProvenance(state)
      })
      await transaction.table('normalArtianCounters').toCollection().modify((counter: Record<string, unknown>) => {
        fillNormalCounterIdentificationProvenance(counter)
      })
      await transaction.table('executionSavePoints').toCollection().modify((savePoint: Record<string, unknown>) => {
        fillRngState(savePoint.rngState)
        fillCounters(savePoint.normalCounters)
      })
      await transaction.table('executionHistory').toCollection().modify((history: Record<string, unknown>) => {
        const snapshot = history.undoSnapshot
        if (!isPlainRecord(snapshot)) return
        fillRngState(snapshot.rngStateBefore)
        fillCounters(snapshot.normalCountersBefore)
        // The save point a terminal transition deleted into the Undo snapshot
        // carries its own RngState / Normal Counter bodies; they are filled
        // exactly like the snapshot's own.
        const savePointBefore = snapshot.executionSavePointBefore
        if (isPlainRecord(savePointBefore)) {
          fillRngState(savePointBefore.rngState)
          fillCounters(savePointBefore.normalCounters)
        }
      })
    })
    // v8 deletes every `draft` ProductionPlan (`docs/DATA_MODEL.md` 11.1 / 14.2,
    // `docs/PLANNER_SPEC.md` 9.2.15). Before this version the Planner saved a
    // new Draft beside every earlier one and no UI could list or delete them,
    // so the collection could hold any number of Drafts, each possibly naming
    // BuildListEntries the user has since removed. The new contract keeps at
    // most one Draft - the current one, replaced atomically by the next Planner
    // save - and no persisted authority says which accumulated Draft the user
    // meant, so none is picked by `createdAt`, `updatedAt` or ID: all are
    // deleted. Nothing else changes: `active` / `stale` / `completed` /
    // `abandoned` Plans, BuildListEntries (a Draft owns no Entry, so nothing is
    // cascaded), BuildCandidates, Targets, OwnedWeapons, ExecutionHistory,
    // ExecutionSavePoints, RngState, Normal Counters and Settings keep their
    // exact persisted contents. No table or index changes and no calculation
    // semantics change, so `CURRENT_CALCULATION_APP_SCHEMA_VERSION` stays 13.
    this.version(8).stores({}).upgrade(async (transaction) => {
      await transaction
        .table('productionPlans')
        .toCollection()
        .filter((plan: unknown) => isPlainRecord(plan) && isDraftProductionPlanRecord(plan))
        .delete()
    })
    // v9 upgrades the AppSettings record to record schema version 2
    // (`docs/DATA_MODEL.md` 13 / 14.2): it gains `candidateSearchDefaults`,
    // the user's usual Candidate Search bounds. A v1 record never held such a
    // value - the Search screen's former fixed `500 / 350 / 1500` were never
    // saved - so it gets the recommended `350 / 500 / 1500`, and every other
    // field (`debugMode`, `resultPageSize`, `defaultSearchLimit`, timestamps)
    // keeps its exact value. No table or index changes, no other table is
    // touched, and no calculation semantics change, so
    // `CURRENT_CALCULATION_APP_SCHEMA_VERSION` stays where it is.
    this.version(9).stores({}).upgrade(async (transaction) => {
      await transaction.table('settings').toCollection().modify((settings: Record<string, unknown>) => {
        upgradeAppSettingsToV2(settings)
      })
    })
    // v10 adds `ProductionPlan.conflictRepairLineage` (`docs/DATA_MODEL.md`
    // 11.1.1 / 14.2, `docs/PLANNER_SPEC.md` 9.2.19.11 / 9.2.19.15): the repair
    // chain a 「この候補を優先」 actual repair saves with its Draft. No table or
    // index changes. Every ProductionPlan body gets `null` - "no repair chain" -
    // wherever it is stored: the `productionPlans` table, the Plan snapshot of a
    // game save point, the `productionPlanBefore` of an ExecutionHistory Undo
    // snapshot and the Plan of the save point an Undo snapshot holds as
    // `executionSavePointBefore`. No earlier runtime saved a repair decision, so
    // none is reconstructed from selected Conflicts, BuildListEntries or
    // ExecutionHistory, and a body already carrying the field is left as it is.
    // The calculation boundary is separate: `CURRENT_CALCULATION_APP_SCHEMA_VERSION`
    // 16 fails every earlier Plan closed through its CalculationContext.
    this.version(10).stores({}).upgrade(async (transaction) => {
      const fillPlan = (value: unknown) => {
        if (isPlainRecord(value)) fillProductionPlanConflictRepairLineage(value)
      }
      await transaction.table('productionPlans').toCollection().modify((plan: Record<string, unknown>) => {
        fillProductionPlanConflictRepairLineage(plan)
      })
      await transaction.table('executionSavePoints').toCollection().modify((savePoint: Record<string, unknown>) => {
        fillPlan(savePoint.productionPlan)
      })
      await transaction.table('executionHistory').toCollection().modify((history: Record<string, unknown>) => {
        const snapshot = history.undoSnapshot
        if (!isPlainRecord(snapshot)) return
        fillPlan(snapshot.productionPlanBefore)
        const savePointBefore = snapshot.executionSavePointBefore
        if (isPlainRecord(savePointBefore)) fillPlan(savePointBefore.productionPlan)
      })
    })
    // v11 splits ExecutionHistory into its metadata and its Undo body
    // (`docs/DATA_MODEL.md` 12.2 / 14.2, `docs/PLANNER_SPEC.md` 19.8, Issue #312):
    // the new `executionUndoSnapshots` table (key `executionHistoryId`, no index)
    // holds the bodies, which no longer copy the whole Plan, and every existing
    // record is converted in this one versionchange transaction. The
    // `executionHistory` indexes stay as they are and no compound index is
    // added. A record that cannot be converted - broken data only - stays in
    // its version 10 shape without a body (case 2); any failure aborts the
    // whole upgrade and leaves the database at version 10 (case 3). No other
    // table changes and no calculation semantics change, so
    // `CURRENT_CALCULATION_APP_SCHEMA_VERSION` stays where it is and no Plan
    // becomes stale.
    this.version(11).stores({
      executionUndoSnapshots: 'executionHistoryId',
    }).upgrade(upgradeExecutionHistoryToV11)
    // v12 moves every TargetWeapon body to the Issue #100 completion condition
    // (`docs/DATA_MODEL.md` 8.6 / 14.2, `docs/PLANNER_SPEC.md` 20.8): the
    // `targetWeapons` table, the Target bodies of every game save point, of
    // every Undo body and of the save point an Undo body holds as
    // `deletedExecutionSavePoint`, all through the one pure conversion the
    // Export schema 14 -> 15 migration shares. The Ideal five slots become one
    // Variant with those ranks as minimums, the compromise conditions are
    // removed (never turned into a Variant) and flagged for review, `any` is
    // normalized to `all` and flagged, and the former `compromiseNeedsReview`
    // is dropped. No table or index changes (no Target index holds a
    // performance definition). BuildCandidate, BuildListEntry, ProductionPlan
    // and ExecutionHistory bodies are untouched: the calculation schema 19
    // boundary makes them `calculation_context_changed`. A body without the
    // legacy structure throws, which aborts the whole upgrade and leaves the
    // database at version 11 for a retry.
    this.version(12).stores({}).upgrade(upgradeTargetWeaponsToV12)
    // v13 adds the completion assignment `completedWithOwnedWeaponId` to every
    // TargetWeapon body (Issue #334, `docs/DATA_MODEL.md` 8.7 / 14.2,
    // `docs/PLANNER_SPEC.md` 21.3 / 21.9): the `targetWeapons` table, the Target
    // bodies of every game save point, of every Undo body and of the save point
    // an Undo body holds as `deletedExecutionSavePoint` get `null` ("not
    // recorded") through the one fill the Export schema 15 -> 16 migration
    // shares. A completed Target gets `null` too: the weapon that completed it is
    // never inferred from `completedByProductionPlanId`, a Plan's
    // `targetCompletions`, an owned Ideal or a preference. No table or index
    // changes, and no BuildCandidate, BuildListEntry, ProductionPlan or
    // ExecutionHistory metadata body is rewritten; a version 10 record the
    // version 11 upgrade kept (case 2) is left exactly as persisted. No
    // assignment exists before this version, so no calculation result changes
    // and `CURRENT_CALCULATION_APP_SCHEMA_VERSION` stays where it is. A body that
    // already carries the field is not a version 12 body: it throws, which
    // aborts the whole upgrade and leaves the database at version 12 for a retry.
    this.version(13).stores({}).upgrade(upgradeTargetWeaponsToV13)
    // v14 moves every TargetWeapon body to the completion Skill configurations
    // (Issue #367, `docs/DATA_MODEL.md` 8.4 / 14.2, `docs/PLANNER_SPEC.md` 22.7):
    // the `targetWeapons` table, the Target bodies of every game save point, of
    // every Undo body and of the save point an Undo body holds as
    // `deletedExecutionSavePoint` turn their one `completionSkillCondition` into
    // one configuration with the same Series / Group IDs, through the one
    // conversion the Export schema 16 -> 17 migration shares. Lossless: no review
    // reason is added and every other field keeps its value. No table or index
    // changes (no Target index holds a performance definition), and no
    // BuildCandidate, BuildListEntry, ProductionPlan or ExecutionHistory metadata
    // body is rewritten; a version 10 record the version 11 upgrade kept (case 2)
    // is left exactly as persisted. One configuration hashes exactly as the former
    // condition did (`createTargetDefinitionHash()`), so no Entry goes stale, no
    // running Plan stops and `CURRENT_CALCULATION_APP_SCHEMA_VERSION` stays where
    // it is. A body that already carries the configurations, has no condition or
    // a condition other than `matchMode: "all"` is not a version 13 body: it
    // throws, which aborts the whole upgrade and leaves the database at version
    // 13 for a retry.
    this.version(DATABASE_SCHEMA_VERSION).stores({}).upgrade(upgradeTargetWeaponsToV14)
  }
}

async function upgradeTargetWeaponsToV14(transaction: Transaction): Promise<void> {
  await transaction.table('targetWeapons').toCollection().modify((target: Record<string, unknown>) => {
    migrateTargetWeaponCompletionSkillVariants(target, `targetWeapons[${String(target.id)}]`)
  })
  await transaction.table('executionSavePoints').toCollection().modify((savePoint: Record<string, unknown>) => {
    migrateTargetWeaponListCompletionSkillVariants(
      savePoint.targetWeapons,
      `executionSavePoints[${String(savePoint.id)}].targetWeapons`,
    )
  })
  await transaction.table('executionUndoSnapshots').toCollection().modify((snapshot: Record<string, unknown>) => {
    const path = `executionUndoSnapshots[${String(snapshot.executionHistoryId)}]`
    migrateTargetWeaponListCompletionSkillVariants(snapshot.affectedTargetWeaponsBefore, `${path}.affectedTargetWeaponsBefore`)
    const deleted = snapshot.deletedExecutionSavePoint
    if (deleted === null || deleted === undefined) return
    if (!isPlainRecord(deleted)) {
      throw new TargetCompletionSkillVariantsMigrationError(`${path}.deletedExecutionSavePoint`, 'A deleted save point must be an object or null.')
    }
    migrateTargetWeaponListCompletionSkillVariants(deleted.targetWeapons, `${path}.deletedExecutionSavePoint.targetWeapons`)
  })
}

async function upgradeTargetWeaponsToV13(transaction: Transaction): Promise<void> {
  await transaction.table('targetWeapons').toCollection().modify((target: Record<string, unknown>) => {
    fillTargetWeaponCompletionAssignment(target, `targetWeapons[${String(target.id)}]`)
  })
  await transaction.table('executionSavePoints').toCollection().modify((savePoint: Record<string, unknown>) => {
    fillTargetWeaponListCompletionAssignment(
      savePoint.targetWeapons,
      `executionSavePoints[${String(savePoint.id)}].targetWeapons`,
    )
  })
  await transaction.table('executionUndoSnapshots').toCollection().modify((snapshot: Record<string, unknown>) => {
    const path = `executionUndoSnapshots[${String(snapshot.executionHistoryId)}]`
    fillTargetWeaponListCompletionAssignment(snapshot.affectedTargetWeaponsBefore, `${path}.affectedTargetWeaponsBefore`)
    const deleted = snapshot.deletedExecutionSavePoint
    if (deleted === null || deleted === undefined) return
    if (!isPlainRecord(deleted)) {
      throw new TargetCompletionAssignmentMigrationError(`${path}.deletedExecutionSavePoint`, 'A deleted save point must be an object or null.')
    }
    fillTargetWeaponListCompletionAssignment(deleted.targetWeapons, `${path}.deletedExecutionSavePoint.targetWeapons`)
  })
}

async function upgradeTargetWeaponsToV12(transaction: Transaction): Promise<void> {
  await transaction.table('targetWeapons').toCollection().modify((target: Record<string, unknown>) => {
    replaceRecord(target, migrateLegacyTargetWeaponToCompletionConditions(target, `targetWeapons[${String(target.id)}]`))
  })
  await transaction.table('executionSavePoints').toCollection().modify((savePoint: Record<string, unknown>) => {
    savePoint.targetWeapons = migrateLegacyTargetWeaponList(
      savePoint.targetWeapons,
      `executionSavePoints[${String(savePoint.id)}].targetWeapons`,
    )
  })
  await transaction.table('executionUndoSnapshots').toCollection().modify((snapshot: Record<string, unknown>) => {
    const path = `executionUndoSnapshots[${String(snapshot.executionHistoryId)}]`
    snapshot.affectedTargetWeaponsBefore = migrateLegacyTargetWeaponList(
      snapshot.affectedTargetWeaponsBefore,
      `${path}.affectedTargetWeaponsBefore`,
    )
    const deleted = snapshot.deletedExecutionSavePoint
    if (deleted === null || deleted === undefined) return
    if (!isPlainRecord(deleted)) {
      throw new LegacyTargetWeaponMigrationError(`${path}.deletedExecutionSavePoint`, 'A deleted save point must be an object or null.')
    }
    deleted.targetWeapons = migrateLegacyTargetWeaponList(
      deleted.targetWeapons,
      `${path}.deletedExecutionSavePoint.targetWeapons`,
    )
  })
}

/** Replaces every field of a record Dexie `modify()` hands over, keeping the object identity Dexie writes back. */
function replaceRecord(record: Record<string, unknown>, next: Record<string, unknown>): void {
  Object.keys(record).forEach((key) => delete record[key])
  Object.assign(record, next)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const appDatabase = new AppDatabase()
