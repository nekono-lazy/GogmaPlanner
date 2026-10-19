import type {
  AppSettings,
  CandidateSearchDefaults,
  ISODateTimeString,
} from '../domain/models/publicTypes'
import { createDefaultAppSettings } from '../domain/models/factories'
import { validateAppSettings } from '../domain/models/validation'
import { appDatabase, type AppDatabase } from './AppDatabase'
import {
  assertRepositoryValidation,
  RepositoryError,
} from './repositoryError'

/** The AppSettings fields a user setting change writes on its own. */
export type SettingsFieldChanges = Partial<Pick<AppSettings, 'debugMode' | 'candidateSearchDefaults' | 'updatedAt'>>

export interface SettingsDataSource {
  get(id: 'settings'): Promise<AppSettings | undefined>
  add(settings: AppSettings): Promise<unknown>
  put(settings: AppSettings): Promise<unknown>
  /**
   * Writes only the given fields of the stored record atomically and resolves
   * with the number of records updated (Dexie `Table.update()`). A field
   * change never rewrites the other fields, so two settings saved at the same
   * time never overwrite each other with a stale read.
   */
  update(id: 'settings', changes: SettingsFieldChanges): Promise<number>
}

export { createDefaultAppSettings as createDefaultSettings }

export class SettingsRepository {
  private readonly dataSource: SettingsDataSource

  constructor(dataSource: SettingsDataSource) {
    this.dataSource = dataSource
  }

  getSettings(): Promise<AppSettings | undefined> {
    return this.dataSource.get('settings')
  }

  async ensureSettings(
    now: ISODateTimeString = new Date().toISOString(),
  ): Promise<AppSettings> {
    const existing = await this.getSettings()
    if (existing) return existing

    const initial = createDefaultAppSettings(now)
    assertRepositoryValidation('AppSettings', validateAppSettings(initial))
    try {
      await this.dataSource.add(initial)
      return initial
    } catch (error: unknown) {
      const concurrentlyCreated = await this.getSettings()
      if (concurrentlyCreated) return concurrentlyCreated
      throw new RepositoryError(
        'transaction_failed',
        'Creating default AppSettings failed.',
        { cause: error },
      )
    }
  }

  async getOrCreateDefault(
    now: ISODateTimeString = new Date().toISOString(),
  ): Promise<AppSettings> {
    return this.ensureSettings(now)
  }

  async putSettings(settings: AppSettings): Promise<AppSettings> {
    assertRepositoryValidation('AppSettings', validateAppSettings(settings))
    try {
      await this.dataSource.put(settings)
      return settings
    } catch (error: unknown) {
      throw new RepositoryError(
        'transaction_failed',
        'Saving AppSettings failed.',
        { cause: error },
      )
    }
  }

  setDebugMode(debugMode: boolean): Promise<AppSettings> {
    return this.updateFields({ debugMode, updatedAt: new Date().toISOString() })
  }

  /**
   * Saves the user's usual Candidate Search bounds (`docs/DATA_MODEL.md` 13).
   * Only the Settings screen calls this; the Search screen never writes them.
   * The bounds are validated as part of the whole record, and an invalid value
   * is refused before any write.
   */
  setCandidateSearchDefaults(defaults: CandidateSearchDefaults): Promise<AppSettings> {
    return this.updateFields({
      candidateSearchDefaults: {
        maxNormalAdvance: defaults.maxNormalAdvance,
        maxGogmaAdvance: defaults.maxGogmaAdvance,
        maxSkillAdvance: defaults.maxSkillAdvance,
      },
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * One user setting change: the changed fields are validated as part of the
   * whole record and then written on their own, so a Debug Mode save and a
   * Candidate Search defaults save running together both persist.
   */
  private async updateFields(changes: SettingsFieldChanges): Promise<AppSettings> {
    const current = await this.ensureSettings()
    const updated: AppSettings = { ...current, ...changes }
    assertRepositoryValidation('AppSettings', validateAppSettings(updated))
    let count: number
    try {
      count = await this.dataSource.update('settings', changes)
    } catch (error: unknown) {
      throw new RepositoryError(
        'transaction_failed',
        'Saving AppSettings failed.',
        { cause: error },
      )
    }
    // Dexie also reports 0 when the stored values already equal the changes,
    // so only a record that is really gone is a failure.
    if (count !== 1 && (await this.getSettings()) === undefined) {
      throw new RepositoryError('transaction_failed', 'AppSettings record is missing.')
    }
    return updated
  }
}

/** A SettingsRepository over the `settings` table of one AppDatabase. */
export function createSettingsRepository(database: AppDatabase): SettingsRepository {
  return new SettingsRepository({
    get: (id) => database.settings.get(id),
    add: (settings) => database.settings.add(settings),
    put: (settings) => database.settings.put(settings),
    update: (id, changes) => database.settings.update(id, changes),
  })
}

export const settingsRepository = createSettingsRepository(appDatabase)
