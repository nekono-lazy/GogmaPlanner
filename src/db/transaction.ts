import type { Table } from 'dexie'
import type { AppDatabase } from './AppDatabase'
import { RepositoryError } from './repositoryError'

async function executeTransaction<T>(
  database: AppDatabase,
  tables: readonly Table[],
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await database.transaction('rw', tables, operation)
  } catch (error: unknown) {
    if (error instanceof RepositoryError) throw error
    throw new RepositoryError(
      'transaction_failed',
      'Persistence transaction failed and was rolled back.',
      { cause: error },
    )
  }
}

export function runInRepositoryTransaction<T>(
  database: AppDatabase,
  tables: readonly Table[],
  operation: () => Promise<T>,
): Promise<T> {
  return executeTransaction(database, tables, operation)
}

/**
 * Shared boundary for future Execution and full-replacement Import services.
 * Repository calls made in this callback participate in the same Dexie zone.
 */
export function runInPersistenceTransaction<T>(
  database: AppDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  return executeTransaction(database, database.tables, operation)
}
