import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import { ExecutionHistoryRepository } from '../../db/repositories/executionHistoryRepository'
import { RepositoryError } from '../../db/repositoryError'
import { validateOwnedWeaponMasterReferences } from '../../domain/artian/entityMasterValidation'
import {
  ExecutionRuntimeError,
  executionFailure,
  executionHistoryIdsAfterSavePoint,
  prepareActualResultDifferent,
  prepareExecutionSavePointRecord,
  prepareExecutionSavePointRestore,
  prepareExecutionUndo,
  prepareExpectedStepConfirmation,
  inspectProductionPlanAbandonment,
  inspectProductionPlanReplanAdoption,
  evaluateProductionPlanContinuation,
  inspectProductionPlanStartTargetLinks,
  type ProductionPlanContinuation,
  deriveOperationCountRecovery,
  prepareOperationCountRecovery,
  prepareOperationUncertain,
  prepareProductionPlanAbandonment,
  prepareProductionPlanReplanAdoption,
  prepareProductionPlanStart,
  type ExecutionActualResultObservation,
  type ExecutionCounterAuthority,
  type ExecutionNormalRestorationBonusObservation,
  type ExecutionPersistedState,
  type ExecutionResultingWeaponValidator,
  type ExecutionSavePointRestoreWrite,
  type ExecutionStepWrite,
  type ExecutionUndoWrite,
  type ObservedProductionPlanState,
  type OperationCountRecoveryAvailability,
  type OperationCountRecoveryObservation,
  type PlanAbandonSavePointDecision,
  type ProductionPlanAbandonmentOptions,
  type ProductionPlanAbandonmentWrite,
  type ProductionPlanReplanAdoptionOptions,
  type ProductionPlanReplanAdoptionWrite,
  type ProductionPlanReplanPreview,
} from '../../domain/execution'
import {
  inspectRunningPlanReplanAdoption,
  prepareRunningPlanReplanAdoption,
  type RunningPlanReplanAdoptionInspection,
  type RunningPlanReplanAdoptionPreview,
  type RunningPlanReplanAdoptionReadState,
  type RunningPlanReplanAdoptionWrite,
} from '../../domain/execution/runningPlanReplanAdoption'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlanStartTargetLinkChange } from '../../domain/planner/productionPlanStartEffects'
import type {
  BuildListEntryId,
  CalculationContext,
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionSavePoint,
  ExecutionUndoSnapshot,
  ISODateTimeString,
  OwnedWeapon,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import { executionSavePointIdForPlan } from '../../domain/models/publicTypes'
import { productionRngEngine } from '../../domain/rng/production/productionRngRuntime'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import { writeExecutionSavePointRestore } from './executionSavePointRestoreWrite'
import { runningPlanReplanPreviewIssues } from './runningPlanReplanResultCheck'

/** Runtime ID source of ExecutionHistory records. */
export interface ExecutionIdFactory {
  executionHistoryId(): ExecutionHistoryId
}

/** Runtime UTC clock of Execution writes. */
export interface ExecutionClock {
  now(): ISODateTimeString
}

export interface ProductionPlanExecutionServiceDependencies {
  database: AppDatabase
  currentCalculationContext: CalculationContext
  counterAuthority: ExecutionCounterAuthority
  /**
   * The Master / Production availability authority for an OwnedWeapon whose
   * contents come from the game: a blind observation or an actual result.
   */
  validateResultingWeapon: ExecutionResultingWeaponValidator
  idFactory: ExecutionIdFactory
  clock: ExecutionClock
}

/**
 * The pre-start preview of a draft Plan: the real Target preference changes
 * its start would make, with the weapons and Targets they name for display.
 */
export interface ProductionPlanStartInspection {
  planId: ProductionPlanId
  changes: ProductionPlanStartTargetLinkChange[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
}

/**
 * Whether a saved or started Plan can be continued, read in one read-only
 * transaction for the Production Plan page, the Production Plan list and the
 * Build List's running Plan guidance (Issue #334, `docs/UI_FLOW.md` 12.11). Never
 * write authority: start and every Step confirmation re-judge in their own
 * transaction. `targetWeapons` / `ownedWeapons` are the records the judgement's
 * issues name, for display only.
 */
export interface ProductionPlanContinuationInspection {
  planId: ProductionPlanId
  continuation: ProductionPlanContinuation
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
}

export interface ConfirmExpectedPlanStepRequest {
  planId: ProductionPlanId
  planStepId: PlanStepId
  /** The observed five slots; required exactly for a blind production-target Normal Step. */
  observation?: ExecutionNormalRestorationBonusObservation | null
}

/** The Plan after a Step transaction and the ExecutionHistory it recorded. */
export interface ConfirmExpectedPlanStepResult {
  plan: ProductionPlan
  history: ExecutionHistory
}

export type ExecutionStepRecordResult = ConfirmExpectedPlanStepResult

export interface RecordActualResultDifferentRequest {
  planId: ProductionPlanId
  planStepId: PlanStepId
  /** What the game actually showed after the one planned operation. */
  actualResult: ExecutionActualResultObservation
  note?: string | null
}

export interface RecordOperationUncertainRequest {
  planId: ProductionPlanId
  planStepId: PlanStepId
}

/**
 * 「この位置に合わせて続ける」 (`docs/PLANNER_SPEC.md` 16.15). Every field is
 * what the user saw; the transaction derives the Recovery Window and the
 * position again from the persisted state and refuses on any difference.
 */
export interface RecoverOperationCountRequest {
  planId: ProductionPlanId
  /** The Plan's current Step, which the `operation_uncertain` record named. */
  planStepId: PlanStepId
  /** The `operation_uncertain` record the user saw as the latest. */
  uncertainExecutionHistoryId: ExecutionHistoryId
  /** The current game result, then the results of the extra Plan operations, in order. */
  observations: OperationCountRecoveryObservation[]
  /** The Window position the user confirmed. */
  recoveredPosition: number
}

export interface UndoLatestExecutionRequest {
  planId: ProductionPlanId
  /**
   * The ExecutionHistory the user saw as the latest. It must still be the
   * Plan's latest ExecutionHistory inside the transaction; a newer record is
   * never undone in its place.
   */
  executionHistoryId: ExecutionHistoryId
}

/** The Plan restored by Undo and the ExecutionHistory ID that was deleted. */
export interface UndoLatestExecutionResult {
  plan: ProductionPlan
  undoneExecutionHistoryId: ExecutionHistoryId
}

export interface RecordExecutionSavePointRequest {
  planId: ProductionPlanId
}

export interface RestoreExecutionSavePointRequest {
  planId: ProductionPlanId
  /**
   * The `recordedAt` of the save point the user saw. The Plan's save point must
   * still be exactly that one inside the transaction; a save point recorded
   * again later is never restored in its place.
   */
  recordedAt: ISODateTimeString
}

/** The Plan restored from its game save point, the kept save point and the deleted records. */
export interface RestoreExecutionSavePointResult {
  plan: ProductionPlan
  savePoint: ExecutionSavePoint
  deletedExecutionHistoryIds: ExecutionHistoryId[]
}

export interface InspectProductionPlanAbandonmentRequest {
  planId: ProductionPlanId
}

/**
 * 「現在Planを破棄する」 (`docs/PLANNER_SPEC.md` 16.2 / 16.10). 「キャンセル」 is
 * not a request: cancelling simply never calls the abandonment.
 */
export interface AbandonProductionPlanRequest {
  planId: ProductionPlanId
  /**
   * The Plan's status, current Step and `updatedAt` as the user saw them when
   * confirming. Any difference inside the transaction refuses the request.
   */
  observedPlan: ObservedProductionPlanState
  /**
   * `null` when no save point choice was offered; otherwise the user's choice
   * naming the `recordedAt` of the save point they saw.
   */
  savePointDecision: PlanAbandonSavePointDecision
}

/** The abandoned Plan and what the abandonment did to the save point state. */
export interface AbandonProductionPlanResult {
  plan: ProductionPlan
  savePointHandling: ProductionPlanAbandonmentWrite['savePointHandling']
  /** The records after the save point a restore deleted; empty otherwise. */
  deletedExecutionHistoryIds: ExecutionHistoryId[]
}

export interface InspectProductionPlanReplanAdoptionRequest {
  preview: ProductionPlanReplanPreview
}

/**
 * 「この再計画を採用」 (`docs/PLANNER_SPEC.md` 16.8). 「キャンセル」 is not a
 * request: cancelling simply never calls the adoption.
 */
export interface AdoptProductionPlanReplanPreviewRequest {
  /** The transient Preview the user reviewed. */
  preview: ProductionPlanReplanPreview
  /**
   * `null` when no save point choice was offered; otherwise the user's 16.10
   * choice naming the `recordedAt` of the save point they saw.
   */
  savePointDecision: PlanAbandonSavePointDecision
}

/**
 * The outcome of a replan adoption request. Returning to the game save point
 * never adopts the Preview: it restores the save point only and a new Preview
 * from the restored state is required (16.8).
 */
export type AdoptProductionPlanReplanPreviewResult =
  | {
      kind: 'adopted'
      savePointHandling: 'no_choice' | 'keep_current'
      /** The running Plan, now `abandoned` with `replan_adopted`. */
      oldPlan: ProductionPlan
      /** The Preview's Plan, now `active`. */
      newPlan: ProductionPlan
    }
  | {
      kind: 'save_point_restored_repreview_required'
      restoredPlan: ProductionPlan
      savePoint: ExecutionSavePoint
      deletedExecutionHistoryIds: ExecutionHistoryId[]
    }

export interface InspectRunningPlanReplanAdoptionRequest {
  /** The runtime-only Preview of the running Plan replan re-optimization the user reviewed (Issue #276 PR-4's session). */
  preview: RunningPlanReplanAdoptionPreview
}

/**
 * 「この再計画を採用」 of a running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.8). 「キャンセル」 is not a request.
 */
export interface AdoptRunningPlanReplanPreviewRequest {
  preview: RunningPlanReplanAdoptionPreview
  /** `null` when no save point choice was offered; otherwise the user's 16.10 choice naming the `recordedAt` of the save point they saw. */
  savePointDecision: PlanAbandonSavePointDecision
}

/**
 * The outcome of a running Plan replan adoption request. Returning to the game save point never adopts the Preview: it restores the
 * save point only, and a new calculation from the restored state is required (18.8 / 16.10).
 */
export type AdoptRunningPlanReplanPreviewResult =
  | {
      kind: 'adopted'
      savePointHandling: 'no_choice' | 'keep_current'
      /** The running Plan, now `abandoned` with `replan_adopted`. */
      oldPlan: ProductionPlan
      /** The Preview's Plan, now `active`. */
      newPlan: ProductionPlan
      /** The replaced Entries `O`, deleted. */
      deletedBuildListEntryIds: BuildListEntryId[]
      /** The generated Entries `G`, replacing and added, in the artifact's order. */
      addedBuildListEntryIds: BuildListEntryId[]
    }
  | {
      kind: 'save_point_restored_repreview_required'
      restoredPlan: ProductionPlan
      savePoint: ExecutionSavePoint
      deletedExecutionHistoryIds: ExecutionHistoryId[]
    }

/**
 * The Execution runtime of a calculation schema 12 ProductionPlan
 * (`docs/PLANNER_SPEC.md` 16.1 / 16.2 / 16.15, `docs/DATA_MODEL.md` 14.4).
 *
 * Each operation is one Dexie read-write transaction: it reads the current
 * persisted state inside the transaction, lets the pure Execution Domain decide
 * and validate every change, and only then writes. A refusal throws
 * `ExecutionRuntimeError` and a storage failure `RepositoryError`; in both
 * cases the transaction is rolled back and nothing is changed.
 *
 * Implemented: starting a draft Plan, the ordinary `confirmed_expected` Step
 * confirmation (including a blind observation and `confirm_owned_ideal`), and
 * the two divergence records `actual_result_different` and
 * `operation_uncertain`, the Current Position Recovery after
 * `operation_uncertain` (`operation_count_recovered`), the Undo of the latest ExecutionHistory, recording /
 * restoring the Plan's game save point, finishing as a compromise, and the
 * user's abandonment with its save point choice, the 16.8 replan adoption with
 * its save point choice, and the adoption of a running Plan replan
 * re-optimization (18.8, Issue #276 PR-5), which also replaces and adds the
 * replan Targets' BuildListEntries in its one transaction. An approved breaking
 * change ends the Plan through `PlanBreakingChangeGuard` together with the
 * change that breaks it; neither replan adoption goes through that guard.
 */
export class ProductionPlanExecutionService {
  private readonly dependencies: ProductionPlanExecutionServiceDependencies

  constructor(dependencies: ProductionPlanExecutionServiceDependencies) {
    this.dependencies = dependencies
  }

  /**
   * The Target preference changes starting this Plan would make, read in one
   * read-only transaction for the pre-start preview (`docs/UI_FLOW.md` 11). It
   * is never write authority: the start re-derives and re-verifies them.
   */
  inspectProductionPlanStart(planId: ProductionPlanId): Promise<ProductionPlanStartInspection> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(planId)
      const [targetWeapons, buildListEntries, ownedWeapons] = await Promise.all([
        database.targetWeapons.toArray(),
        database.buildListEntries.toArray(),
        database.ownedWeapons.toArray(),
      ])
      const changes = inspectProductionPlanStartTargetLinks(plan, { targetWeapons, buildListEntries })
      const named = new Set(changes.flatMap((change) => [change.ownedWeaponId, change.replacedOwnedWeaponId]))
      return {
        planId: plan.id,
        changes,
        ownedWeapons: ownedWeapons.filter(({ id }) => named.has(id)),
        targetWeapons: targetWeapons.filter(({ id }) =>
          changes.some((change) => change.targetWeaponId === id || change.fromTargetWeaponId === id)),
      }
    }, 'r')
  }

  /**
   * The read-only continuation judgement of one Plan (Issue #334,
   * `docs/PLANNER_SPEC.md` 21.4.1): the CalculationContext compatibility, then the
   * completion assignment safety against the current Targets, through
   * `evaluateProductionPlanContinuation()` - the very judgement the runtime
   * applies. Writes nothing and changes no status.
   */
  inspectProductionPlanContinuation(planId: ProductionPlanId): Promise<ProductionPlanContinuationInspection> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(planId)
      const [targetWeapons, ownedWeapons] = await Promise.all([
        database.targetWeapons.toArray(),
        database.ownedWeapons.toArray(),
      ])
      const continuation = evaluateProductionPlanContinuation(plan, targetWeapons, this.dependencies.currentCalculationContext)
      const issues = continuation.kind === 'completion_assignment_conflict' ? continuation.issues : []
      const namedWeapons = new Set<string>(issues.flatMap((issue) => ('ownedWeaponId' in issue ? [issue.ownedWeaponId] : [])))
      const namedTargets = new Set<string>(issues.flatMap((issue) =>
        issue.reason === 'duplicate_completion_weapon'
          ? issue.targetWeaponIds
          : issue.reason === 'completion_weapon_assigned_elsewhere'
            ? [issue.targetWeaponId, issue.assignedTargetWeaponId]
            : []))
      return {
        planId: plan.id,
        continuation,
        ownedWeapons: ownedWeapons.filter(({ id }) => namedWeapons.has(id)),
        targetWeapons: targetWeapons.filter(({ id }) => namedTargets.has(id)),
      }
    }, 'r')
  }

  /**
   * `draft -> active` together with the Plan start effect's Target links, in
   * one transaction (16.2 / 16.11).
   */
  startProductionPlan(planId: ProductionPlanId): Promise<ProductionPlan> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(planId)
      const runningPlans = await database.productionPlans
        .where('status')
        .anyOf(['active', 'stale'])
        .toArray()
      const start = prepareProductionPlanStart({
        plan,
        runningPlans,
        state: await this.readState(plan),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      })
      if (start.targetWeapons.length > 0) await database.targetWeapons.bulkPut(start.targetWeapons)
      await database.productionPlans.put(start.plan)
      return start.plan
    })
  }

  /** One `confirmed_expected` Step confirmation, persisted immediately (16.1). */
  confirmExpectedPlanStep(
    request: ConfirmExpectedPlanStepRequest,
  ): Promise<ConfirmExpectedPlanStepResult> {
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const confirmation = prepareExpectedStepConfirmation({
        plan,
        planStepId: request.planStepId,
        observation: request.observation ?? null,
        state: await this.readState(plan),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        counterAuthority: this.dependencies.counterAuthority,
        validateResultingWeapon: this.dependencies.validateResultingWeapon,
        executionHistoryId: this.dependencies.idFactory.executionHistoryId(),
        now: this.dependencies.clock.now(),
      })
      await this.writeStep(confirmation)
      return { plan: confirmation.plan, history: confirmation.history }
    })
  }

  /**
   * The current Step's one planned operation was performed but its result
   * differs from the prediction (16.15): the Counter consumption and the actual
   * result are persisted, the Step is completed, and the Plan becomes `stale`
   * with `unexpected_result`.
   */
  recordActualResultDifferent(
    request: RecordActualResultDifferentRequest,
  ): Promise<ExecutionStepRecordResult> {
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const record = prepareActualResultDifferent({
        plan,
        planStepId: request.planStepId,
        actualResult: request.actualResult,
        note: request.note ?? null,
        state: await this.readState(plan),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        counterAuthority: this.dependencies.counterAuthority,
        validateResultingWeapon: this.dependencies.validateResultingWeapon,
        executionHistoryId: this.dependencies.idFactory.executionHistoryId(),
        now: this.dependencies.clock.now(),
      })
      await this.writeStep(record)
      return { plan: record.plan, history: record.history }
    })
  }

  /**
   * What or how many operations were performed is unknown (16.15): only the
   * Plan (`stale`, `execution_operation_uncertain`) and the ExecutionHistory
   * record are written.
   */
  recordOperationUncertain(
    request: RecordOperationUncertainRequest,
  ): Promise<ExecutionStepRecordResult> {
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const record = prepareOperationUncertain({
        plan,
        planStepId: request.planStepId,
        state: await this.readState(plan),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        executionHistoryId: this.dependencies.idFactory.executionHistoryId(),
        now: this.dependencies.clock.now(),
      })
      await this.writeStep(record)
      return { plan: record.plan, history: record.history }
    })
  }

  /**
   * Whether Current Position Recovery applies to the Plan and its Recovery
   * Window (16.15), read in one read-only transaction. Never write authority:
   * the recovery derives the Window again.
   */
  inspectOperationCountRecovery(planId: ProductionPlanId): Promise<OperationCountRecoveryAvailability> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(planId)
      return deriveOperationCountRecovery(plan, {
        ownedWeapons: await database.ownedWeapons.toArray(),
        planExecutionHistory: await this.readPlanExecutionHistory(plan),
      })
    }, 'r')
  }

  /**
   * Follows a unique Recovery Window position after `operation_uncertain`
   * (16.15): replays the Plan's own Steps up to it, returns the Plan to
   * `active` (or `completed`), and records `operation_count_recovered`.
   */
  recoverOperationCount(request: RecoverOperationCountRequest): Promise<ExecutionStepRecordResult> {
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const recovery = prepareOperationCountRecovery({
        plan,
        planStepId: request.planStepId,
        uncertainExecutionHistoryId: request.uncertainExecutionHistoryId,
        observations: request.observations,
        recoveredPosition: request.recoveredPosition,
        state: await this.readState(plan),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        counterAuthority: this.dependencies.counterAuthority,
        validateResultingWeapon: this.dependencies.validateResultingWeapon,
        executionHistoryId: this.dependencies.idFactory.executionHistoryId(),
        now: this.dependencies.clock.now(),
      })
      await this.writeStep(recovery)
      return { plan: recovery.plan, history: recovery.history }
    })
  }

  /**
   * Undoes the Plan's latest ExecutionHistory (16.16 / 19.5): the Plan before
   * the record is rebuilt from the current Plan and its Undo body, the app state
   * is restored exactly from that body, and the record's metadata and body are
   * deleted, without adding an Undo record. The one Undo body read is the
   * requested record's (`docs/DATA_MODEL.md` 14.6). The in-game operation is
   * not reversed.
   */
  undoLatestExecution(request: UndoLatestExecutionRequest): Promise<UndoLatestExecutionResult> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const undo = prepareExecutionUndo({
        plan,
        executionHistoryId: request.executionHistoryId,
        state: {
          normalCounters: await database.normalArtianCounters.toArray(),
          ownedWeapons: await database.ownedWeapons.toArray(),
          targetWeapons: await database.targetWeapons.toArray(),
          planExecutionHistory: await this.readPlanExecutionHistory(plan),
          undoSnapshot: (await this.historyRepository().getExecutionUndoSnapshot(request.executionHistoryId)) ?? null,
          executionSavePoint:
            (await database.executionSavePoints.get(executionSavePointIdForPlan(plan.id))) ?? null,
        },
      })
      await this.writeUndo(undo)
      return { plan: undo.plan, undoneExecutionHistoryId: undo.deletedExecutionHistoryId }
    })
  }

  /**
   * "ゲーム内セーブ済みとして記録" (16.9): stores the snapshot of the current
   * execution state as the Plan's one save point, replacing an earlier one. Only
   * the user's explicit action calls this. No other entity changes and no
   * ExecutionHistory is added.
   */
  recordExecutionSavePoint(request: RecordExecutionSavePointRequest): Promise<ExecutionSavePoint> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const savePoint = prepareExecutionSavePointRecord({
        plan,
        state: await this.readState(plan),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      })
      // The ID is derived from the Plan, so `put` replaces the previous one; any
      // other record of the Plan is removed too.
      await database.executionSavePoints
        .where('productionPlanId')
        .equals(plan.id)
        .and(({ id }) => id !== savePoint.id)
        .delete()
      await database.executionSavePoints.put(savePoint)
      return savePoint
    })
  }

  /**
   * "最後のゲーム内セーブ地点へ戻す" (16.9): restores the Execution state the game
   * save corresponds to and deletes the Plan's later ExecutionHistory, keeping
   * the save point. The in-game state itself is the user's responsibility.
   */
  restoreExecutionSavePoint(request: RestoreExecutionSavePointRequest): Promise<RestoreExecutionSavePointResult> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const planExecutionHistory = await this.readPlanExecutionHistory(plan)
      const executionSavePoint = (await database.executionSavePoints.get(executionSavePointIdForPlan(plan.id))) ?? null
      const restore = prepareExecutionSavePointRestore({
        plan,
        recordedAt: request.recordedAt,
        state: {
          ownedWeapons: await database.ownedWeapons.toArray(),
          targetWeapons: await database.targetWeapons.toArray(),
          buildListEntries: await database.buildListEntries.toArray(),
          planExecutionHistory,
          undoSnapshotsAfterSavePoint: await this.readUndoSnapshotsAfterSavePoint(plan, executionSavePoint, planExecutionHistory),
          executionSavePoint,
        },
        currentCalculationContext: this.dependencies.currentCalculationContext,
      })
      await this.writeSavePointRestore(restore)
      return {
        plan: restore.plan,
        savePoint: restore.savePoint,
        deletedExecutionHistoryIds: restore.deletedExecutionHistoryIds,
      }
    })
  }

  /**
   * Reads whether abandoning the running Plan must ask the 16.10 save point
   * choice, with the tokens the abandonment request echoes back. It writes
   * nothing, and the abandonment re-derives everything itself.
   */
  inspectProductionPlanAbandonment(
    request: InspectProductionPlanAbandonmentRequest,
  ): Promise<ProductionPlanAbandonmentOptions> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      return inspectProductionPlanAbandonment(plan, {
        planExecutionHistory: await this.readPlanExecutionHistory(plan),
        executionSavePoint:
          (await database.executionSavePoints.get(executionSavePointIdForPlan(plan.id))) ?? null,
      }, this.dependencies.currentCalculationContext)
    }, 'r')
  }

  /**
   * 「現在Planを破棄する」 (16.2 / 16.10): the running Plan becomes `abandoned`
   * (`user_abandoned`) at the current state, or after restoring its game save
   * point when the user chose so. Every weapon in progress for the Plan stops
   * being in progress, Target preferences stay, the save point is deleted, and
   * no ExecutionHistory is added.
   */
  abandonProductionPlan(request: AbandonProductionPlanRequest): Promise<AbandonProductionPlanResult> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.planId)
      const planExecutionHistory = await this.readPlanExecutionHistory(plan)
      const executionSavePoint = (await database.executionSavePoints.get(executionSavePointIdForPlan(plan.id))) ?? null
      const abandonment = prepareProductionPlanAbandonment({
        plan,
        observedPlan: request.observedPlan,
        savePointDecision: request.savePointDecision,
        state: {
          ownedWeapons: await database.ownedWeapons.toArray(),
          targetWeapons: await database.targetWeapons.toArray(),
          buildListEntries: await database.buildListEntries.toArray(),
          planExecutionHistory,
          // Only 「最後のゲーム内セーブ地点へ戻す」 reads Undo bodies (14.6).
          undoSnapshotsAfterSavePoint: request.savePointDecision?.kind === 'restore_save_point'
            ? await this.readUndoSnapshotsAfterSavePoint(plan, executionSavePoint, planExecutionHistory)
            : [],
          executionSavePoint,
        },
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      })
      await this.writeAbandonment(abandonment)
      return {
        plan: abandonment.plan,
        savePointHandling: abandonment.savePointHandling,
        deletedExecutionHistoryIds: abandonment.deletedExecutionHistoryIds,
      }
    })
  }

  /**
   * Reads what adopting a replan Preview would ask (16.8 / 16.10), refusing a
   * Preview that can never be adopted or whose running Plan moved on. It
   * writes nothing, and the adoption re-derives everything itself.
   */
  inspectProductionPlanReplanAdoption(
    request: InspectProductionPlanReplanAdoptionRequest,
  ): Promise<ProductionPlanReplanAdoptionOptions> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const plan = await this.requirePlan(request.preview.runningPlanToken.planId)
      return inspectProductionPlanReplanAdoption(request.preview, plan, {
        planExecutionHistory: await this.readPlanExecutionHistory(plan),
        executionSavePoint:
          (await database.executionSavePoints.get(executionSavePointIdForPlan(plan.id))) ?? null,
      }, this.dependencies.currentCalculationContext)
    }, 'r')
  }

  /**
   * 「この再計画を採用」 (16.8): re-verifies the Preview against the current
   * persisted state and, in one transaction, abandons the running Plan
   * (`replan_adopted`), starts the Preview's Plan against the current Build
   * List - which it never writes - moves or clears the running Plan's
   * in-progress marks and deletes its game save point. The running Plan's ExecutionHistory stays and
   * no ExecutionHistory is added. Choosing to return to the save point restores
   * it and adopts nothing.
   */
  adoptProductionPlanReplanPreview(
    request: AdoptProductionPlanReplanPreviewRequest,
  ): Promise<AdoptProductionPlanReplanPreviewResult> {
    const { database } = this.dependencies
    return this.runExecutionTransaction(async () => {
      const runningPlan = await this.requirePlan(request.preview.runningPlanToken.planId)
      const newPlanId = request.preview.result.plan?.id ?? null
      const adoption = prepareProductionPlanReplanAdoption({
        preview: request.preview,
        runningPlan,
        savePointDecision: request.savePointDecision,
        state: {
          ...(await this.readState(runningPlan, request.savePointDecision?.kind === 'restore_save_point')),
          runningPlans: await database.productionPlans.where('status').anyOf(['active', 'stale']).toArray(),
          newPlanIdPersisted: newPlanId !== null && (await database.productionPlans.get(newPlanId)) !== undefined,
        },
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      })
      await this.writeReplanAdoption(adoption)
      return adoption.kind === 'save_point_restored'
        ? {
            kind: 'save_point_restored_repreview_required',
            restoredPlan: adoption.restore.plan,
            savePoint: adoption.restore.savePoint,
            deletedExecutionHistoryIds: adoption.restore.deletedExecutionHistoryIds,
          }
        : {
            kind: 'adopted',
            savePointHandling: adoption.savePointHandling,
            oldPlan: adoption.oldPlan,
            newPlan: adoption.newPlan,
          }
    })
  }

  /**
   * Reads what adopting a running Plan replan re-optimization would write and ask (`docs/PLANNER_SPEC.md` 18.8 / 16.10), in one
   * read-only transaction: the Preview is checked ([P1]) and re-verified against the current state ([T]) exactly as the adoption would
   * do on 「現在地点を維持」, and refused with the same typed codes. It writes nothing and is no write authority: the adoption
   * re-derives everything inside its own transaction.
   */
  async inspectRunningPlanReplanAdoption(request: InspectRunningPlanReplanAdoptionRequest): Promise<RunningPlanReplanAdoptionInspection> {
    const preview = this.checkedRunningPlanReplanPreview(request.preview)
    return this.runExecutionTransaction(async () => {
      const runningPlan = await this.requirePlan(preview.runningPlanToken.planId)
      return inspectRunningPlanReplanAdoption({
        preview,
        runningPlan,
        state: await this.readRunningPlanReplanAdoptionState(runningPlan, preview, false),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      })
    }, 'r')
  }

  /**
   * 「この再計画を採用」 of a running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.8): re-checks the Preview ([P1]) and
   * re-verifies it against the current persisted state ([T]) inside one read-write transaction and, only when everything holds, writes
   * there ([W]): the running Plan becomes `abandoned` (`replan_adopted`) with its current Step, Step completions and recalculation
   * reasons kept, each replaced Entry `O` is deleted and each generated Entry `G` added, the new Plan is added `active` with its start
   * effect, the running Plan's in-progress marks are moved or cleared, and its save point is deleted. No ExecutionHistory is added, no
   * Draft and no Entry outside the replan target set is written, and no Plan-breaking approval is asked. Choosing to return to the save
   * point restores it only and adopts nothing. Any refusal or failure writes nothing.
   */
  async adoptRunningPlanReplanPreview(request: AdoptRunningPlanReplanPreviewRequest): Promise<AdoptRunningPlanReplanPreviewResult> {
    const preview = this.checkedRunningPlanReplanPreview(request.preview)
    return this.runExecutionTransaction(async () => {
      const runningPlan = await this.requirePlan(preview.runningPlanToken.planId)
      const adoption = prepareRunningPlanReplanAdoption({
        preview,
        runningPlan,
        savePointDecision: request.savePointDecision,
        state: await this.readRunningPlanReplanAdoptionState(
          runningPlan,
          preview,
          request.savePointDecision?.kind === 'restore_save_point',
        ),
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      })
      await this.writeRunningPlanReplanAdoption(adoption)
      return adoption.kind === 'save_point_restored'
        ? {
            kind: 'save_point_restored_repreview_required',
            restoredPlan: adoption.restore.plan,
            savePoint: adoption.restore.savePoint,
            deletedExecutionHistoryIds: adoption.restore.deletedExecutionHistoryIds,
          }
        : {
            kind: 'adopted',
            savePointHandling: adoption.savePointHandling,
            oldPlan: adoption.oldPlan,
            newPlan: adoption.newPlan,
            deletedBuildListEntryIds: [...adoption.deletedBuildListEntryIds],
            addedBuildListEntryIds: adoption.addedBuildListEntries.map(({ id }) => id),
          }
    })
  }

  /**
   * The runtime-only Preview is untrusted until its structure passes the same artifact check a Worker result passes
   * (`runningPlanReplanPreviewIssues()`): having passed that check once in the session is no authority.
   */
  private checkedRunningPlanReplanPreview(preview: unknown): RunningPlanReplanAdoptionPreview {
    const issues = runningPlanReplanPreviewIssues(preview)
    if (issues.length > 0) {
      executionFailure('replan_result_invalid', `The running Plan replan Preview is malformed: ${issues.join(' ')}`)
    }
    return preview as RunningPlanReplanAdoptionPreview
  }

  private async readRunningPlanReplanAdoptionState(
    runningPlan: ProductionPlan,
    preview: RunningPlanReplanAdoptionPreview,
    restoresSavePoint: boolean,
  ): Promise<RunningPlanReplanAdoptionReadState> {
    const { database } = this.dependencies
    const newPlanId = preview.artifact.plannerResult.plan?.id ?? null
    return {
      ...(await this.readState(runningPlan, restoresSavePoint)),
      runningPlans: await database.productionPlans.where('status').anyOf(['active', 'stale']).toArray(),
      newPlanIdPersisted: newPlanId !== null && (await database.productionPlans.get(newPlanId)) !== undefined,
    }
  }

  private async writeRunningPlanReplanAdoption(write: RunningPlanReplanAdoptionWrite): Promise<void> {
    if (write.kind === 'save_point_restored') {
      await this.writeSavePointRestore(write.restore)
      return
    }
    const { database } = this.dependencies
    await database.productionPlans.put(write.oldPlan)
    // Each replaced `O` is deleted before its `G` is added. Every `G` is added, never put: an Entry that already exists is a
    // different record and is never overwritten (the transaction fails and nothing is kept).
    if (write.deletedBuildListEntryIds.length > 0) await database.buildListEntries.bulkDelete(write.deletedBuildListEntryIds)
    if (write.addedBuildListEntries.length > 0) await database.buildListEntries.bulkAdd(write.addedBuildListEntries)
    await database.productionPlans.add(write.newPlan)
    if (write.targetWeapons.length > 0) await database.targetWeapons.bulkPut(write.targetWeapons)
    if (write.ownedWeapons.length > 0) await database.ownedWeapons.bulkPut(write.ownedWeapons)
    if (write.deletesExecutionSavePoint) {
      await database.executionSavePoints
        .where('productionPlanId')
        .equals(write.oldPlan.id)
        .delete()
    }
  }

  private async writeReplanAdoption(write: ProductionPlanReplanAdoptionWrite): Promise<void> {
    if (write.kind === 'save_point_restored') {
      await this.writeSavePointRestore(write.restore)
      return
    }
    const { database } = this.dependencies
    // The Build List is not written (Phase 6-A). The new Plan is added, never
    // put: a Plan that already exists is a different record and is never
    // overwritten.
    await database.productionPlans.put(write.oldPlan)
    await database.productionPlans.add(write.newPlan)
    if (write.ownedWeapons.length > 0) await database.ownedWeapons.bulkPut(write.ownedWeapons)
    if (write.targetWeapons.length > 0) await database.targetWeapons.bulkPut(write.targetWeapons)
    if (write.deletesExecutionSavePoint) {
      await database.executionSavePoints
        .where('productionPlanId')
        .equals(write.oldPlan.id)
        .delete()
    }
  }

  private async writeAbandonment(write: ProductionPlanAbandonmentWrite): Promise<void> {
    const { database } = this.dependencies
    if (write.rngState !== null) await database.rngState.put(write.rngState)
    if (write.normalCounters !== null) {
      // A save point restore replaces the whole collection.
      await database.normalArtianCounters.clear()
      if (write.normalCounters.length > 0) await database.normalArtianCounters.bulkPut(write.normalCounters)
    }
    if (write.deletedOwnedWeaponIds.length > 0) await database.ownedWeapons.bulkDelete(write.deletedOwnedWeaponIds)
    if (write.ownedWeapons.length > 0) await database.ownedWeapons.bulkPut(write.ownedWeapons)
    if (write.targetWeapons.length > 0) await database.targetWeapons.bulkPut(write.targetWeapons)
    await database.productionPlans.put(write.plan)
    await this.historyRepository().deleteExecutionRecords(write.deletedExecutionHistoryIds)
    if (write.deletesExecutionSavePoint) {
      await database.executionSavePoints
        .where('productionPlanId')
        .equals(write.plan.id)
        .delete()
    }
  }

  private async writeSavePointRestore(restore: ExecutionSavePointRestoreWrite): Promise<void> {
    await writeExecutionSavePointRestore(this.dependencies.database, restore)
  }

  private async writeUndo(undo: ExecutionUndoWrite): Promise<void> {
    const { database } = this.dependencies
    await database.rngState.put(undo.rngState)
    // The snapshot holds the whole collection: a Counter record absent from it
    // must not survive the Undo.
    await database.normalArtianCounters.clear()
    if (undo.normalCounters.length > 0) await database.normalArtianCounters.bulkPut(undo.normalCounters)
    if (undo.deletedOwnedWeaponIds.length > 0) await database.ownedWeapons.bulkDelete(undo.deletedOwnedWeaponIds)
    if (undo.restoredOwnedWeapons.length > 0) await database.ownedWeapons.bulkPut(undo.restoredOwnedWeapons)
    if (undo.restoredTargetWeapons.length > 0) await database.targetWeapons.bulkPut(undo.restoredTargetWeapons)
    await database.productionPlans.put(undo.plan)
    switch (undo.executionSavePoint.kind) {
      case 'delete':
        await database.executionSavePoints.delete(executionSavePointIdForPlan(undo.plan.id))
        break
      case 'restore':
        await database.executionSavePoints.put(undo.executionSavePoint.savePoint)
        break
      case 'keep':
        break
    }
    // The undone record's metadata and Undo body go together (12.2).
    await this.historyRepository().deleteExecutionRecords([undo.deletedExecutionHistoryId])
  }

  private async writeStep(write: ExecutionStepWrite): Promise<void> {
    const { database } = this.dependencies
    if (write.rngState !== null) await database.rngState.put(write.rngState)
    if (write.normalCounters.length > 0) {
      await database.normalArtianCounters.bulkPut(write.normalCounters)
    }
    if (write.ownedWeapons.length > 0) {
      await database.ownedWeapons.bulkPut(write.ownedWeapons)
    }
    if (write.targetWeapons.length > 0) {
      await database.targetWeapons.bulkPut(write.targetWeapons)
    }
    await database.productionPlans.put(write.plan)
    if (write.deletesExecutionSavePoint) {
      await database.executionSavePoints
        .where('productionPlanId')
        .equals(write.plan.id)
        .delete()
    }
    // The record's metadata and Undo body are added together; a history ID that
    // already exists is a different record and is never replaced.
    await database.executionHistory.add(write.history)
    await database.executionUndoSnapshots.add(write.undoSnapshot)
  }

  private async requirePlan(planId: ProductionPlanId): Promise<ProductionPlan> {
    const plan = await this.dependencies.database.productionPlans.get(planId)
    if (!plan) executionFailure('plan_not_found', `ProductionPlan '${planId}' was not found.`)
    return plan
  }

  /**
   * The persisted state an Execution transaction decides from: the Plan's
   * metadata only, and the Undo bodies after its game save point only when the
   * operation restores that save point (`docs/DATA_MODEL.md` 14.6).
   */
  private async readState(plan: ProductionPlan, restoresSavePoint = false): Promise<ExecutionPersistedState> {
    const { database } = this.dependencies
    const rngState = await database.rngState.get('current')
    if (!rngState) {
      executionFailure('execution_state_mismatch', 'No RngState is stored, so the Plan cannot be executed.')
    }
    const planExecutionHistory = await this.readPlanExecutionHistory(plan)
    const executionSavePoint = (await database.executionSavePoints.get(executionSavePointIdForPlan(plan.id))) ?? null
    return {
      rngState,
      normalCounters: await database.normalArtianCounters.toArray(),
      ownedWeapons: await database.ownedWeapons.toArray(),
      targetWeapons: await database.targetWeapons.toArray(),
      buildListEntries: await database.buildListEntries.toArray(),
      planExecutionHistory,
      undoSnapshotsAfterSavePoint: restoresSavePoint
        ? await this.readUndoSnapshotsAfterSavePoint(plan, executionSavePoint, planExecutionHistory)
        : [],
      executionSavePoint,
    }
  }

  private historyRepository(): ExecutionHistoryRepository {
    return new ExecutionHistoryRepository(this.dependencies.database)
  }

  /** The metadata of the Plan's records; a record that could not be converted refuses the operation. */
  private readPlanExecutionHistory(plan: ProductionPlan): Promise<ExecutionHistory[]> {
    return this.historyRepository().getExecutionHistoryByPlan(plan.id)
  }

  /** The Undo bodies of the Plan's records after its game save point, and no other body. */
  private readUndoSnapshotsAfterSavePoint(
    plan: ProductionPlan,
    savePoint: ExecutionSavePoint | null,
    planExecutionHistory: readonly ExecutionHistory[],
  ): Promise<ExecutionUndoSnapshot[]> {
    return this.historyRepository().getExecutionUndoSnapshots(
      executionHistoryIdsAfterSavePoint(plan, savePoint, planExecutionHistory),
    )
  }

  private async runExecutionTransaction<T>(operation: () => Promise<T>, mode: 'rw' | 'r' = 'rw'): Promise<T> {
    const { database } = this.dependencies
    try {
      return await database.transaction(
        mode,
        [
          database.rngState,
          database.normalArtianCounters,
          database.ownedWeapons,
          database.targetWeapons,
          database.buildListEntries,
          database.productionPlans,
          database.executionHistory,
          database.executionUndoSnapshots,
          database.executionSavePoints,
        ],
        operation,
      )
    } catch (error: unknown) {
      if (error instanceof ExecutionRuntimeError || error instanceof RepositoryError) throw error
      throw new RepositoryError(
        'transaction_failed',
        'The Execution transaction failed and was rolled back.',
        { cause: error },
      )
    }
  }
}

/** The Production Execution runtime over the loaded Master Data. */
export function createProductionPlanExecutionService(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
): ProductionPlanExecutionService {
  return new ProductionPlanExecutionService({
    database,
    currentCalculationContext: createBuildListCalculationContext(master),
    counterAuthority: productionRngEngine,
    // The same Master / Production availability authority an Owned Weapon save
    // applies (`docs/PLANNER_SPEC.md` 16.4 / 16.15).
    validateResultingWeapon: (weapon) => validateOwnedWeaponMasterReferences(weapon, master),
    idFactory: { executionHistoryId: () => globalThis.crypto.randomUUID() as ExecutionHistoryId },
    clock: { now: () => new Date().toISOString() },
  })
}
