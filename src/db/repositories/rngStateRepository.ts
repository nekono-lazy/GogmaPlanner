import type { ISODateTimeString, RngState } from '../../domain/models/publicTypes'
import { createInitialRngState } from '../../domain/models/factories'
import { validateRngState } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'
import { runInRepositoryTransaction } from '../transaction'

export class RngStateRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getCurrentRngState(): Promise<RngState | undefined> {
    return this.database.rngState.get('current')
  }

  async putRngState(state: RngState): Promise<RngState> {
    assertRepositoryValidation('RngState', validateRngState(state))
    await this.database.rngState.put(state)
    return state
  }

  ensureInitialRngState(
    now: ISODateTimeString = new Date().toISOString(),
  ): Promise<RngState> {
    return runInRepositoryTransaction(
      this.database,
      [this.database.rngState],
      async () => {
        const existing = await this.database.rngState.get('current')
        if (existing) return existing
        const initial = createInitialRngState(now)
        assertRepositoryValidation('RngState', validateRngState(initial))
        await this.database.rngState.add(initial)
        return initial
      },
    )
  }
}

export const rngStateRepository = new RngStateRepository(appDatabase)
