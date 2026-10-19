import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import { ExecutionHistoryRepository } from '../../db/repositories/executionHistoryRepository'
import {
  deriveExecutionReidentificationReminder,
  deriveOperationCountRecovery,
  inspectExecutionSavePointRestore,
  inspectExecutionUndo,
  type ExecutionReidentificationReminder,
  type ExecutionSavePointRestoreAvailability,
  type ExecutionUndoAvailability,
  type OperationCountRecoveryAvailability,
} from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildListEntry,
  CalculationContext,
  ExecutionHistory,
  ExecutionSavePoint,
  OwnedWeapon,
  ProductionPlan,
  ProductionPlanId,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import { executionSavePointIdForPlan } from '../../domain/models/publicTypes'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import {
  createProductionPlanExecutionService,
  type ConfirmExpectedPlanStepRequest,
  type ConfirmExpectedPlanStepResult,
  type AbandonProductionPlanRequest,
  type AbandonProductionPlanResult,
  type ExecutionStepRecordResult,
  type InspectProductionPlanAbandonmentRequest,
  type RecordExecutionSavePointRequest,
  type RecoverOperationCountRequest,
  type RestoreExecutionSavePointRequest,
  type RestoreExecutionSavePointResult,
  type FinishProductionPlanAsCompromiseRequest,
  type FinishProductionPlanAsCompromiseResult,
  type ProductionPlanExecutionService,
  type RecordActualResultDifferentRequest,
  type RecordOperationUncertainRequest,
  type UndoLatestExecutionRequest,
  type UndoLatestExecutionResult,
} from './productionPlanExecutionService'

/**
 * The persisted state the Navigator displays. The Plan is the semantic
 * authority; the other collections only resolve names and the Entry
 * selections the compromise checkpoint projection reads.
 */
export interface ExecutionNavigatorSnapshot {
  plan: ProductionPlan
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
  buildListEntries: BuildListEntry[]
  /**
   * The Plan's latest ExecutionHistory by `compareExecutionHistoryOrder()`, or
   * `null` when none exists. A stale Plan's recovery guidance reads it to tell
   * which divergence record stopped the Plan.
   */
  latestExecutionHistory: ExecutionHistory | null
  /** The Plan's game save point, or `null` when none was recorded. */
  executionSavePoint: ExecutionSavePoint | null
  /**
   * Whether Current Position Recovery applies and its Recovery Window
   * (`docs/PLANNER_SPEC.md` 16.15), derived from this same read. Display only:
   * the recovery transaction derives it again.
   */
  operationCountRecovery: OperationCountRecoveryAvailability
  /**
   * Whether Undo of the latest ExecutionHistory is offered (16.16), from this
   * same read. Display only: the Undo transaction re-derives it.
   */
  undo: ExecutionUndoAvailability
  /**
   * Whether 「最後のゲーム内セーブ地点へ戻す」 is offered (UI_FLOW 12.8), from
   * this same read. Display only: the restore transaction re-derives it.
   */
  savePointRestore: ExecutionSavePointRestoreAvailability
  /**
   * Whether an unresolved `actual_result_different` of this Plan still asks for
   * re-identification (16.15), from this same read of the Plan's
   * ExecutionHistory, the RngState and the Normal Counters. Display only: none
   * of them is written here.
   */
  reidentificationReminder: ExecutionReidentificationReminder
}

export interface ExecutionNavigatorPageDependencies {
  master: MasterDataRoot
  currentCalculationContext: CalculationContext
  /** The exact persisted Plan of the route and its display data; `null` when the Plan does not exist. */
  loadSnapshot(planId: ProductionPlanId): Promise<ExecutionNavigatorSnapshot | null>
  confirmExpectedPlanStep(request: ConfirmExpectedPlanStepRequest): Promise<ConfirmExpectedPlanStepResult>
  finishProductionPlanAsCompromise(
    request: FinishProductionPlanAsCompromiseRequest,
  ): Promise<FinishProductionPlanAsCompromiseResult>
  recordActualResultDifferent(request: RecordActualResultDifferentRequest): Promise<ExecutionStepRecordResult>
  recordOperationUncertain(request: RecordOperationUncertainRequest): Promise<ExecutionStepRecordResult>
  recoverOperationCount(request: RecoverOperationCountRequest): Promise<ExecutionStepRecordResult>
  undoLatestExecution(request: UndoLatestExecutionRequest): Promise<UndoLatestExecutionResult>
  recordExecutionSavePoint(request: RecordExecutionSavePointRequest): Promise<ExecutionSavePoint>
  restoreExecutionSavePoint(request: RestoreExecutionSavePointRequest): Promise<RestoreExecutionSavePointResult>
  inspectProductionPlanAbandonment(
    request: InspectProductionPlanAbandonmentRequest,
  ): ReturnType<ProductionPlanExecutionService['inspectProductionPlanAbandonment']>
  abandonProductionPlan(request: AbandonProductionPlanRequest): Promise<AbandonProductionPlanResult>
}

export async function loadExecutionNavigatorSnapshot(
  database: AppDatabase,
  planId: ProductionPlanId,
): Promise<ExecutionNavigatorSnapshot | null> {
  const plan = await database.productionPlans.get(planId)
  if (!plan) return null
  const [ownedWeapons, targetWeapons, buildListEntries, planExecutionHistory, executionSavePoint, rngState, normalCounters] = await Promise.all([
    database.ownedWeapons.toArray(),
    database.targetWeapons.toArray(),
    database.buildListEntries.toArray(),
    // Ordered by `compareExecutionHistoryOrder()`: the last one is the latest.
    new ExecutionHistoryRepository(database).getExecutionHistoryByPlan(planId),
    database.executionSavePoints.get(executionSavePointIdForPlan(planId)),
    database.rngState.get('current'),
    database.normalArtianCounters.toArray(),
  ])
  const latestExecutionHistory = planExecutionHistory.at(-1) ?? null
  const savePoint = executionSavePoint ?? null
  return {
    plan,
    ownedWeapons,
    targetWeapons,
    buildListEntries,
    latestExecutionHistory,
    executionSavePoint: savePoint,
    operationCountRecovery: deriveOperationCountRecovery(plan, { ownedWeapons, planExecutionHistory }),
    undo: inspectExecutionUndo(plan, latestExecutionHistory, savePoint),
    savePointRestore: inspectExecutionSavePointRestore(plan, savePoint, planExecutionHistory),
    reidentificationReminder: deriveExecutionReidentificationReminder({
      plan,
      planExecutionHistory,
      rngState: rngState ?? null,
      normalCounters,
    }),
  }
}

export function createExecutionNavigatorDependencies(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
  service: ProductionPlanExecutionService = createProductionPlanExecutionService(master, database),
): ExecutionNavigatorPageDependencies {
  return {
    master,
    currentCalculationContext: createBuildListCalculationContext(master),
    loadSnapshot: (planId) => loadExecutionNavigatorSnapshot(database, planId),
    confirmExpectedPlanStep: (request) => service.confirmExpectedPlanStep(request),
    finishProductionPlanAsCompromise: (request) => service.finishProductionPlanAsCompromise(request),
    recordActualResultDifferent: (request) => service.recordActualResultDifferent(request),
    recordOperationUncertain: (request) => service.recordOperationUncertain(request),
    recoverOperationCount: (request) => service.recoverOperationCount(request),
    undoLatestExecution: (request) => service.undoLatestExecution(request),
    recordExecutionSavePoint: (request) => service.recordExecutionSavePoint(request),
    restoreExecutionSavePoint: (request) => service.restoreExecutionSavePoint(request),
    inspectProductionPlanAbandonment: (request) => service.inspectProductionPlanAbandonment(request),
    abandonProductionPlan: (request) => service.abandonProductionPlan(request),
  }
}
