import type {
  ExecutionHistory,
  ExecutionHistoryId,
  ProductionPlanId,
} from '../../domain/models/publicTypes'
import { compareExecutionHistoryOrder } from '../../domain/models/planning'
import { validateExecutionHistory } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'

function sortHistory(history: ExecutionHistory[]): ExecutionHistory[] {
  return history.sort(compareExecutionHistoryOrder)
}

export class ExecutionHistoryRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getExecutionHistory(
    id: ExecutionHistoryId,
  ): Promise<ExecutionHistory | undefined> {
    return this.database.executionHistory.get(id)
  }

  async getExecutionHistoryByPlan(
    planId: ProductionPlanId,
  ): Promise<ExecutionHistory[]> {
    return sortHistory(
      await this.database.executionHistory
        .where('planId')
        .equals(planId)
        .toArray(),
    )
  }

  async getLatestExecutionHistory(
    planId: ProductionPlanId,
  ): Promise<ExecutionHistory | undefined> {
    const history = await this.getExecutionHistoryByPlan(planId)
    return history.at(-1)
  }

  async putExecutionHistory(
    history: ExecutionHistory,
  ): Promise<ExecutionHistory> {
    assertRepositoryValidation(
      'ExecutionHistory',
      validateExecutionHistory(history),
    )
    await this.database.executionHistory.put(history)
    return history
  }

  deleteExecutionHistory(id: ExecutionHistoryId): Promise<void> {
    return this.database.executionHistory.delete(id)
  }
}

export const executionHistoryRepository =
  new ExecutionHistoryRepository(appDatabase)
