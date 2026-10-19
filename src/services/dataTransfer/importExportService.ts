import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import type {
  AppSettings,
  ExportRoot,
  ISODateTimeString,
} from '../../domain/models/publicTypes'
import {
  createDefaultAppSettings,
  EXPORT_APP_NAME,
  EXPORT_SCHEMA_VERSION,
  normalizeOwnedWeaponRestorationBonusScope,
  prepareExportRootForImport,
  validateAppSettings,
  type DomainValidationIssue,
} from '../../domain/models/publicTypes'
import {
  validateExportRootForFullReplacement,
  type ImportMasterSubset,
} from './importExportValidation'

/*
 * The Persistence / Application foundation of `docs/REQUIREMENTS.md` 4 / 30
 * and `docs/UI_FLOW.md` 14: whole-user-data Export, full-replacement Import and
 * the full data clear. It is UI-free (no File API, no Blob, no DOM, no React /
 * Zustand): the Settings screen connects it in a later PR.
 *
 * - Export reads every user table in one read-only Dexie transaction, so the
 *   root is one consistent snapshot, validates it with the same full validation
 *   Import applies, and never writes
 * - Import is split into `prepare` (JSON parse, schema migration through the
 *   existing `prepareExportRootForImport()`, full validation) and `apply`
 *   (re-validation, then one read-write transaction that clears every user
 *   table and inserts the root). Nothing is written before every check passed,
 *   and a failing write rolls the whole replacement back
 * - Clear empties every user table and recreates the default AppSettings in
 *   one transaction, so the app returns to its initial state
 */

export type DataTransferErrorCode =
  /** The current database holds state that fails the full Export validation; nothing was written. */
  | 'export_state_invalid'
  /** The root handed to `applyImport()` fails the full Import validation; nothing was written. */
  | 'invalid_import'
  /** The read or write transaction failed and was rolled back. */
  | 'transaction_failed'

export class DataTransferError extends Error {
  readonly code: DataTransferErrorCode
  readonly validationIssues: readonly DomainValidationIssue[]

  constructor(
    code: DataTransferErrorCode,
    message: string,
    options?: { cause?: unknown; validationIssues?: readonly DomainValidationIssue[] },
  ) {
    super(message, { cause: options?.cause })
    this.name = 'DataTransferError'
    this.code = code
    this.validationIssues = options?.validationIssues ?? []
  }
}

/**
 * The typed outcome of Import preparation. `invalid_json` is a body that is
 * not JSON at all; `invalid_import` is JSON that is not an importable Export
 * root (wrong app, unsupported schema, a failed migration or any validation
 * issue). Both carry structured issues for the UI and never throw.
 */
export type ImportPreparationResult =
  | { ok: true; root: ExportRoot }
  | { ok: false; code: 'invalid_json' | 'invalid_import'; issues: DomainValidationIssue[] }

export interface DataTransferClock {
  now(): ISODateTimeString
}

export interface ImportExportServiceDependencies {
  database: AppDatabase
  /** The current Master Data the persisted Master IDs are checked against. */
  master: ImportMasterSubset
  clock?: DataTransferClock
}

const systemClock: DataTransferClock = { now: () => new Date().toISOString() }

/** Code-unit order: deterministic on every platform, unlike a locale collation. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Top-level entity collections sorted by primary ID so two Exports of one
 * state serialize identically. Only the collection order is touched: the five
 * restoration bonus slots, PlanStep order, and every other nested array keep
 * the order they were persisted in, because that order is semantic.
 */
function sortedById<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => compareIds(left.id, right.id))
}

function transactionFailed(message: string, cause: unknown): DataTransferError {
  return cause instanceof DataTransferError
    ? cause
    : new DataTransferError('transaction_failed', message, { cause })
}

export class ImportExportService {
  private readonly database: AppDatabase
  private readonly master: ImportMasterSubset
  private readonly clock: DataTransferClock

  constructor(dependencies: ImportExportServiceDependencies) {
    this.database = dependencies.database
    this.master = dependencies.master
    this.clock = dependencies.clock ?? systemClock
  }

  /**
   * Builds the Export root from the current database: every user table read in
   * one read-only transaction, `schemaVersion` / `appName` set by this service,
   * `exportedAt` from the injected clock. The root is validated with the full
   * Import validation before it is returned, so a corrupted database is
   * reported (`export_state_invalid`) instead of being downloaded as a backup;
   * a missing AppSettings record is reported the same way rather than created,
   * because Export never writes. Historical calculation artifacts pass: an old
   * CalculationContext is not corruption.
   */
  async exportRoot(): Promise<ExportRoot> {
    const database = this.database
    const exportedAt = this.clock.now()
    let snapshot: Omit<ExportRoot, 'schemaVersion' | 'appName' | 'exportedAt' | 'settings'> & {
      settings: AppSettings | undefined
    }
    try {
      snapshot = await database.transaction('r', database.tables, async () => ({
        rngState: (await database.rngState.get('current')) ?? null,
        normalArtianCounters: sortedById(await database.normalArtianCounters.toArray()),
        // The documented read-boundary normalization of pre-B1 records; a record
        // already carrying its scope is returned exactly as persisted.
        ownedWeapons: sortedById(
          (await database.ownedWeapons.toArray()).map(normalizeOwnedWeaponRestorationBonusScope),
        ),
        targetWeapons: sortedById(await database.targetWeapons.toArray()),
        buildCandidates: sortedById(await database.buildCandidates.toArray()),
        buildListEntries: sortedById(await database.buildListEntries.toArray()),
        productionPlans: sortedById(await database.productionPlans.toArray()),
        executionHistory: sortedById(await database.executionHistory.toArray()),
        executionSavePoints: sortedById(await database.executionSavePoints.toArray()),
        settings: await database.settings.get('settings'),
      }))
    } catch (error: unknown) {
      throw transactionFailed('Reading the current data for Export failed.', error)
    }
    if (snapshot.settings === undefined) {
      throw new DataTransferError(
        'export_state_invalid',
        'AppSettings record is missing; Export does not create one.',
        { validationIssues: [{ path: 'settings', code: 'invalid_reference', message: 'AppSettings record is missing.' }] },
      )
    }
    const root: ExportRoot = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      appName: EXPORT_APP_NAME,
      exportedAt,
      ...snapshot,
      settings: snapshot.settings,
    }
    const validation = validateExportRootForFullReplacement(root, this.master)
    if (!validation.isValid) {
      throw new DataTransferError(
        'export_state_invalid',
        'The current data failed the Export validation.',
        { validationIssues: validation.issues },
      )
    }
    return root
  }

  /** The Export root as human-readable UTF-8 JSON text. */
  async serializeExport(): Promise<string> {
    return JSON.stringify(await this.exportRoot(), null, 2)
  }

  /**
   * Import step 1 + 2 + 3 over a JSON text: parse, then `prepareImportRoot()`.
   * A parse failure is a typed result, never an exception.
   */
  prepareImportJson(json: string): ImportPreparationResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'invalid_json',
        issues: [{
          path: '',
          code: 'invalid_structure',
          message: error instanceof Error ? `JSONとして読み取れません: ${error.message}` : 'JSONとして読み取れません。',
        }],
      }
    }
    return this.prepareImportRoot(parsed)
  }

  /**
   * Import step 2 + 3 over a parsed value: the existing schema migration and
   * current-schema validation (`prepareExportRootForImport()`, schema 6..10),
   * then the full-replacement validation. Nothing is written; the returned root
   * is the migrated, validated copy the UI shows for confirmation and later
   * hands to `applyImport()`.
   */
  prepareImportRoot(value: unknown): ImportPreparationResult {
    const migrated = prepareExportRootForImport(value)
    if (!migrated.ok) return { ok: false, code: 'invalid_import', issues: migrated.issues }
    const validation = validateExportRootForFullReplacement(migrated.root, this.master)
    if (!validation.isValid) return { ok: false, code: 'invalid_import', issues: validation.issues }
    return { ok: true, root: migrated.root }
  }

  /**
   * Import step 4: the atomic full replacement.
   *
   * The root is re-validated here, whatever the caller did with it since
   * `prepare` (an in-memory edit must not reach the database), and only then
   * one read-write transaction over every user table clears them and inserts
   * the root's records with duplicate-failing `add` / `bulkAdd`. No ordinary
   * CRUD service, guard or side effect runs: Import restores the validated
   * snapshot exactly, so no `updatedAt` moves, no Plan is abandoned, no Target
   * preference is released. `exportedAt` is Export metadata and is stored
   * nowhere. Any failure rolls the whole transaction back and leaves the
   * previous data untouched.
   */
  async applyImport(root: ExportRoot): Promise<void> {
    const validation = validateExportRootForFullReplacement(root, this.master)
    if (!validation.isValid) {
      throw new DataTransferError(
        'invalid_import',
        'The Import root failed the full-replacement validation.',
        { validationIssues: validation.issues },
      )
    }
    const database = this.database
    try {
      await database.transaction('rw', database.tables, async () => {
        await clearUserTables(database)
        if (root.rngState !== null) await database.rngState.add(root.rngState)
        await database.normalArtianCounters.bulkAdd(root.normalArtianCounters)
        await database.ownedWeapons.bulkAdd(root.ownedWeapons)
        await database.targetWeapons.bulkAdd(root.targetWeapons)
        await database.buildCandidates.bulkAdd(root.buildCandidates)
        await database.buildListEntries.bulkAdd(root.buildListEntries)
        await database.productionPlans.bulkAdd(root.productionPlans)
        await database.executionHistory.bulkAdd(root.executionHistory)
        await database.executionSavePoints.bulkAdd(root.executionSavePoints)
        await database.settings.add(root.settings)
      })
    } catch (error: unknown) {
      throw transactionFailed('Applying the Import failed and was rolled back.', error)
    }
  }

  /**
   * The full data clear (`docs/UI_FLOW.md` 14): every user table is emptied and
   * one default AppSettings record is created, in one transaction, so the app
   * is back at its initial state. No RngState, Target or any other entity is
   * created; a failure keeps the previous data entirely.
   */
  async clearAllData(): Promise<AppSettings> {
    const settings = createDefaultAppSettings(this.clock.now())
    const validation = validateAppSettings(settings)
    if (!validation.isValid) {
      throw new DataTransferError(
        'transaction_failed',
        'Default AppSettings failed Domain validation.',
        { validationIssues: validation.issues },
      )
    }
    const database = this.database
    try {
      await database.transaction('rw', database.tables, async () => {
        await clearUserTables(database)
        await database.settings.add(settings)
      })
    } catch (error: unknown) {
      throw transactionFailed('Clearing all data failed and was rolled back.', error)
    }
    return settings
  }
}

/** Every user table, cleared inside the caller's transaction. */
async function clearUserTables(database: AppDatabase): Promise<void> {
  await database.rngState.clear()
  await database.normalArtianCounters.clear()
  await database.ownedWeapons.clear()
  await database.targetWeapons.clear()
  await database.buildCandidates.clear()
  await database.buildListEntries.clear()
  await database.productionPlans.clear()
  await database.executionHistory.clear()
  await database.executionSavePoints.clear()
  await database.settings.clear()
}

export function createImportExportService(
  master: ImportMasterSubset,
  database: AppDatabase = appDatabase,
  clock?: DataTransferClock,
): ImportExportService {
  return new ImportExportService({ database, master, clock })
}
