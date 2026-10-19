import type {
  ExecutionSavePoint,
  ProductionPlanId,
} from '../../domain/models/publicTypes'
import { executionSavePointIdForPlan } from '../../domain/models/planning'
import { validateExecutionSavePoint } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'
import { runInRepositoryTransaction } from '../transaction'

/**
 * Persistence of the one game save point per ProductionPlan
 * (`docs/DATA_MODEL.md` 12.1).
 *
 * The API is deliberately Plan-scoped: a save point is addressed by its Plan,
 * `putExecutionSavePoint()` replaces that Plan's previous one, and there is no
 * way to hold a second one. Recording, restoring, and deleting a save point as
 * part of an Execution transition are Execution service responsibilities; this
 * repository only stores what they decide.
 */
export class ExecutionSavePointRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getExecutionSavePointByPlan(
    planId: ProductionPlanId,
  ): Promise<ExecutionSavePoint | undefined> {
    return this.database.executionSavePoints.get(
      executionSavePointIdForPlan(planId),
    )
  }

  async getAllExecutionSavePoints(): Promise<ExecutionSavePoint[]> {
    return (await this.database.executionSavePoints.toArray()).sort(
      (left, right) => left.id.localeCompare(right.id),
    )
  }

  /** Stores the save point, replacing any earlier one of the same Plan. */
  async putExecutionSavePoint(
    savePoint: ExecutionSavePoint,
  ): Promise<ExecutionSavePoint> {
    assertRepositoryValidation(
      'ExecutionSavePoint',
      validateExecutionSavePoint(savePoint),
    )
    return runInRepositoryTransaction(
      this.database,
      [this.database.executionSavePoints],
      async () => {
        // The ID is derived from the Plan, so `put` already replaces. Removing
        // any other record of the Plan too keeps the one-per-Plan rule from
        // resting on the ID derivation alone.
        await this.database.executionSavePoints
          .where('productionPlanId')
          .equals(savePoint.productionPlanId)
          .and(({ id }) => id !== savePoint.id)
          .delete()
        await this.database.executionSavePoints.put(savePoint)
        return savePoint
      },
    )
  }

  deleteExecutionSavePointByPlan(planId: ProductionPlanId): Promise<void> {
    return runInRepositoryTransaction(
      this.database,
      [this.database.executionSavePoints],
      async () => {
        await this.database.executionSavePoints
          .where('productionPlanId')
          .equals(planId)
          .delete()
      },
    )
  }

  clearExecutionSavePoints(): Promise<void> {
    return this.database.executionSavePoints.clear()
  }
}

export const executionSavePointRepository = new ExecutionSavePointRepository(
  appDatabase,
)
