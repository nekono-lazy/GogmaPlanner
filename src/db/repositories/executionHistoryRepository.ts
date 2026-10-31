import {
  requireExecutionHistoryMetadata,
  type ExecutionHistoryJudgementScope,
} from '../../domain/execution/executionHistoryRecords'
import type {
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionUndoSnapshot,
  ProductionPlanId,
} from '../../domain/models/publicTypes'
import { compareExecutionHistoryOrder } from '../../domain/models/planning'
import { validateExecutionRecord } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'

function sortHistory(history: ExecutionHistory[]): ExecutionHistory[] {
  return history.sort(compareExecutionHistoryOrder)
}

/**
 * The ExecutionHistory records (`docs/DATA_MODEL.md` 12.2): the metadata in
 * `executionHistory` and the Undo bodies in `executionUndoSnapshots`, read
 * separately so a process reads only what `docs/DATA_MODEL.md` 14.6 lets it
 * (the metadata alone, or one body, or the bodies after a save point) and
 * written together so the two stay 1:1.
 *
 * Every metadata read is checked record by record (`requireExecutionHistoryMetadata()`):
 * a record the Dexie version 11 upgrade could not convert is never returned as
 * metadata, and inside the judged scope it refuses the read with
 * `execution_history_unconvertible`. Called inside a transaction over these
 * tables, every method joins it.
 */
export class ExecutionHistoryRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  /** The metadata of one Plan's records, ordered by `compareExecutionHistoryOrder()` (the latest last). */
  async getExecutionHistoryByPlan(planId: ProductionPlanId): Promise<ExecutionHistory[]> {
    const rows = await this.database.executionHistory.where('planId').equals(planId).toArray()
    return sortHistory(requireExecutionHistoryMetadata(rows, { kind: 'plan', planId }))
  }

  /** The metadata of one Plan's latest record, or `undefined` when it has none. */
  async getLatestExecutionHistory(planId: ProductionPlanId): Promise<ExecutionHistory | undefined> {
    return (await this.getExecutionHistoryByPlan(planId)).at(-1)
  }

  /**
   * The metadata of every record, for a process that judges `scope`: every
   * record, or the records of one Plan while it reads all of them.
   */
  async getAllExecutionHistory(scope: ExecutionHistoryJudgementScope): Promise<ExecutionHistory[]> {
    return requireExecutionHistoryMetadata(await this.database.executionHistory.toArray(), scope)
  }

  /** The Undo body of one record, or `undefined` when none is stored. */
  getExecutionUndoSnapshot(executionHistoryId: ExecutionHistoryId): Promise<ExecutionUndoSnapshot | undefined> {
    return this.database.executionUndoSnapshots.get(executionHistoryId)
  }

  /** The stored Undo bodies of the given records; a record without one is left out, never filled in. */
  async getExecutionUndoSnapshots(executionHistoryIds: readonly ExecutionHistoryId[]): Promise<ExecutionUndoSnapshot[]> {
    if (executionHistoryIds.length === 0) return []
    const bodies = await this.database.executionUndoSnapshots.bulkGet([...executionHistoryIds])
    return bodies.filter((body): body is ExecutionUndoSnapshot => body !== undefined)
  }

  /** Every Undo body: only the OwnedWeapon delete reference check and Export read them all (14.6). */
  getAllExecutionUndoSnapshots(): Promise<ExecutionUndoSnapshot[]> {
    return this.database.executionUndoSnapshots.toArray()
  }

  /**
   * Adds one record - its metadata and its Undo body - in one transaction, after
   * the 12.2 record validation. An ID already stored is a different record and
   * is never replaced: the add fails and nothing is kept.
   */
  async addExecutionRecord(history: ExecutionHistory, undoSnapshot: ExecutionUndoSnapshot): Promise<void> {
    assertRepositoryValidation('ExecutionHistory', validateExecutionRecord(history, undoSnapshot))
    await this.database.transaction('rw', [this.database.executionHistory, this.database.executionUndoSnapshots], async () => {
      await this.database.executionHistory.add(history)
      await this.database.executionUndoSnapshots.add(undoSnapshot)
    })
  }

  /** Deletes the metadata and the Undo body of each record together. */
  async deleteExecutionRecords(executionHistoryIds: readonly ExecutionHistoryId[]): Promise<void> {
    if (executionHistoryIds.length === 0) return
    await this.database.transaction('rw', [this.database.executionHistory, this.database.executionUndoSnapshots], async () => {
      await this.database.executionHistory.bulkDelete([...executionHistoryIds])
      await this.database.executionUndoSnapshots.bulkDelete([...executionHistoryIds])
    })
  }
}

export const executionHistoryRepository =
  new ExecutionHistoryRepository(appDatabase)
