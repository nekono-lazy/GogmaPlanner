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
  NormalArtianCounter,
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
  type ConfirmPlanStepOnAlternateWeaponRequest,
  type AbandonProductionPlanRequest,
  type AbandonProductionPlanResult,
  type ExecutionStepRecordResult,
  type InspectProductionPlanAbandonmentRequest,
  type RecordExecutionSavePointRequest,
  type RecoverOperationCountRequest,
  type RestoreExecutionSavePointRequest,
  type RestoreExecutionSavePointResult,
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
   * Every persisted Normal Artian Counter, from this same read. Display only:
   * a Normal creation Step names the weapon type to forge from the Counter its
   * `rngAdvance.affectedNormalCounterId` advances (Issue #275).
   */
  normalCounters: NormalArtianCounter[]
  /**
   * The Plan's latest ExecutionHistory by `compareExecutionHistoryOrder()`, or
   * `null` when none exists. A stale Plan's recovery guidance reads it to tell
   * which divergence record stopped the Plan.
   */
  latestExecutionHistory: ExecutionHistory | null
  /** The Plan's game save point, or `null` when none was recorded. */
  executionSavePoint: ExecutionSavePoint | null
  /**
   * The metadata of every ExecutionHistory record of the Plan, from this same
   * read (`docs/DATA_MODEL.md` 14.6: no Undo body). Display only: the weapon
   * switch guidance reads which completed Steps were performed on an unneeded
   * weapon (`executed_on_alternate_weapon`, `docs/UI_FLOW.md` 12.6 / 12.12).
   */
  planExecutionHistory: ExecutionHistory[]
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
  /** 「スキル再付与済み・次へ」 (`docs/UI_FLOW.md` 12.12): the Skill Counter alone advances. */
  confirmPlanStepOnAlternateWeapon(request: ConfirmPlanStepOnAlternateWeaponRequest): Promise<ExecutionStepRecordResult>
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

/**
 * The Navigator's read (`docs/DATA_MODEL.md` 14.6): the Plan's ExecutionHistory
 * metadata and the Undo body of its latest record - for the Undo display - and
 * no other Undo body, so the read does not grow with the confirmed Steps. A
 * record of the Plan the Dexie version 11 upgrade could not convert rejects the
 * read (`execution_history_unconvertible`); it is never shown as "no history".
 * The save point restore availability is judged under the CalculationContext
 * the restore itself runs with (Issue #335).
 */
export async function loadExecutionNavigatorSnapshot(
  database: AppDatabase,
  planId: ProductionPlanId,
  currentCalculationContext: CalculationContext,
): Promise<ExecutionNavigatorSnapshot | null> {
  const plan = await database.productionPlans.get(planId)
  if (!plan) return null
  const history = new ExecutionHistoryRepository(database)
  const [ownedWeapons, targetWeapons, buildListEntries, planExecutionHistory, executionSavePoint, rngState, normalCounters] = await Promise.all([
    database.ownedWeapons.toArray(),
    database.targetWeapons.toArray(),
    database.buildListEntries.toArray(),
    // Ordered by `compareExecutionHistoryOrder()`: the last one is the latest.
    history.getExecutionHistoryByPlan(planId),
    database.executionSavePoints.get(executionSavePointIdForPlan(planId)),
    database.rngState.get('current'),
    database.normalArtianCounters.toArray(),
  ])
  const latestExecutionHistory = planExecutionHistory.at(-1) ?? null
  const latestUndoSnapshot = latestExecutionHistory === null
    ? null
    : (await history.getExecutionUndoSnapshot(latestExecutionHistory.id)) ?? null
  const savePoint = executionSavePoint ?? null
  return {
    plan,
    ownedWeapons,
    targetWeapons,
    buildListEntries,
    normalCounters,
    latestExecutionHistory,
    executionSavePoint: savePoint,
    planExecutionHistory,
    operationCountRecovery: deriveOperationCountRecovery(plan, { ownedWeapons, planExecutionHistory }),
    undo: inspectExecutionUndo(plan, latestExecutionHistory, latestUndoSnapshot, savePoint),
    savePointRestore: inspectExecutionSavePointRestore(plan, savePoint, planExecutionHistory, currentCalculationContext),
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
  const currentCalculationContext = createBuildListCalculationContext(master)
  return {
    master,
    currentCalculationContext,
    loadSnapshot: (planId) => loadExecutionNavigatorSnapshot(database, planId, currentCalculationContext),
    confirmExpectedPlanStep: (request) => service.confirmExpectedPlanStep(request),
    confirmPlanStepOnAlternateWeapon: (request) => service.confirmPlanStepOnAlternateWeapon(request),
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
