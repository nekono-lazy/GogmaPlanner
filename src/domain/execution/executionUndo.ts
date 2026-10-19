import type {
  DomainValidationIssue,
  DomainValidationResult,
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionSavePoint,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  ProductionPlan,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  compareExecutionHistoryOrder,
  currentExecutionActions,
  isExecutionContractProductionPlan,
  validateExecutionHistory,
  validateExecutionSavePoint,
  validateExecutionSavePointReferences,
  validateNormalArtianCounter,
  validateOwnedWeapon,
  validateProductionPlan,
  validateRngState,
  validateTargetWeapon,
} from '../models/publicTypes'
import { validateTargetPreferredOwnedWeapons } from '../target/preferredOwnedWeapon'
import { executionFailure } from './executionRuntimeError'
import type { ExecutionPersistedState } from './planExecutionState'

export interface ExecutionUndoInput {
  /** The current persisted Plan. */
  plan: ProductionPlan
  /** The ExecutionHistory the user asked to undo. */
  executionHistoryId: ExecutionHistoryId
  state: Pick<
    ExecutionPersistedState,
    'normalCounters' | 'ownedWeapons' | 'targetWeapons' | 'planExecutionHistory' | 'executionSavePoint'
  >
}

/** What happens to the Plan's game save point on Undo (`docs/PLANNER_SPEC.md` 16.9 / 16.16). */
export type ExecutionUndoSavePointWrite =
  | { kind: 'keep' }
  | { kind: 'delete' }
  | { kind: 'restore'; savePoint: ExecutionSavePoint }

/**
 * Everything one Undo transaction writes, decided and validated before a single
 * write happens (`docs/DATA_MODEL.md` 12 / 14.4). Every value is the exact
 * snapshot body; nothing is recomputed, re-predicted or re-timestamped.
 */
export interface ExecutionUndoWrite {
  rngState: RngState
  /** The whole NormalArtianCounter collection after Undo; it replaces the current collection. */
  normalCounters: NormalArtianCounter[]
  /** The OwnedWeapons the undone Step added. */
  deletedOwnedWeaponIds: OwnedWeaponId[]
  /** The OwnedWeapons the undone Step updated or removed, as they were before it. */
  restoredOwnedWeapons: OwnedWeapon[]
  /** The TargetWeapons the undone Step changed, as they were before it. */
  restoredTargetWeapons: TargetWeapon[]
  plan: ProductionPlan
  executionSavePoint: ExecutionUndoSavePointWrite
  /** The undone ExecutionHistory; no Undo record is added in its place. */
  deletedExecutionHistoryId: ExecutionHistoryId
}

function snapshotInvalid(message: string, issues: readonly DomainValidationIssue[] = []): never {
  executionFailure('undo_snapshot_invalid', message, issues)
}

function assertResultValid(label: string, validation: DomainValidationResult): void {
  if (!validation.isValid) {
    executionFailure('undo_result_invalid', `${label} fails validation after Undo.`, validation.issues)
  }
}

function hasDuplicateIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map(({ id }) => id)).size !== values.length
}

/**
 * The latest ExecutionHistory of the Plan, by the one chronological order
 * authority. The requested entry must be exactly that entry: a newer entry the
 * user never saw is never undone in its place.
 */
function requireLatestHistory(input: ExecutionUndoInput): { history: ExecutionHistory; remaining: ExecutionHistory[] } {
  const { plan, executionHistoryId } = input
  const ordered = input.state.planExecutionHistory
    .filter(({ planId }) => planId === plan.id)
    .sort(compareExecutionHistoryOrder)
  const history = ordered.find(({ id }) => id === executionHistoryId)
  if (!history) {
    executionFailure('undo_history_not_found', `ExecutionHistory '${executionHistoryId}' is not a history of ProductionPlan '${plan.id}'.`)
  }
  if (ordered.at(-1)?.id !== history.id) {
    executionFailure('undo_history_not_latest', `ExecutionHistory '${history.id}' is not the latest ExecutionHistory of ProductionPlan '${plan.id}'.`)
  }
  return { history, remaining: ordered.slice(0, -1) }
}

/**
 * Every current Execution record starts from the `active` Plan whose current
 * Step is the recorded Step, so a snapshot Plan that is not exactly that cannot
 * be the state before this record.
 *
 * `operation_count_recovered` starts from the `stale` Plan an
 * `operation_uncertain` record left (16.15): its current Step is incomplete and
 * the recorded Step - the last Step the recovery reached, or the current Step
 * itself for a position 0 recovery - is incomplete at or after it.
 */
function assertSnapshotPlanIsStepStart(history: ExecutionHistory): void {
  const before = history.undoSnapshot.productionPlanBefore
  if (history.action === 'operation_count_recovered') {
    const currentIndex = before.steps.findIndex(({ id }) => id === before.currentStepId)
    const recordedIndex = before.steps.findIndex(({ id }) => id === history.planStepId)
    if (
      before.status !== 'stale' ||
      !before.recalculationReasons.includes('execution_operation_uncertain') ||
      currentIndex < 0 ||
      before.steps[currentIndex].isCompleted ||
      recordedIndex < currentIndex ||
      before.steps[recordedIndex].isCompleted
    ) {
      snapshotInvalid(
        `The snapshot Plan of ExecutionHistory '${history.id}' is not the stale Plan an uncertain operation left before PlanStep '${history.planStepId}'.`,
      )
    }
    return
  }
  if (before.status !== 'active' || before.currentStepId !== history.planStepId) {
    snapshotInvalid(
      `The snapshot Plan of ExecutionHistory '${history.id}' is not the active Plan at PlanStep '${history.planStepId}'.`,
    )
  }
  const step = before.steps.find(({ id }) => id === history.planStepId)
  if (!step || step.isCompleted) {
    snapshotInvalid(`The snapshot Plan of ExecutionHistory '${history.id}' has no incomplete PlanStep '${history.planStepId}'.`)
  }
}

/**
 * Whether the latest ExecutionHistory itself moved the Plan from `active` to
 * `completed`: the last incomplete Step of the snapshot Plan was confirmed as
 * expected, at the moment the Plan and that Step record as their completion.
 */
function causedCompletion(plan: ProductionPlan, history: ExecutionHistory): boolean {
  const before = history.undoSnapshot.productionPlanBefore
  const step = plan.steps.find(({ id }) => id === history.planStepId)
  return (
    history.action === 'confirmed_expected' &&
    plan.status === 'completed' &&
    plan.currentStepId === null &&
    plan.completedAt === history.createdAt &&
    step !== undefined &&
    step.isCompleted &&
    step.completedAt === history.createdAt &&
    before.steps.filter(({ isCompleted }) => !isCompleted).map(({ id }) => id).join('\n') === history.planStepId
  )
}

/**
 * Whether the latest `operation_count_recovered` itself completed the Plan
 * (16.15): every Step incomplete in the snapshot Plan was completed by it.
 */
function causedRecoveryCompletion(plan: ProductionPlan, history: ExecutionHistory): boolean {
  const before = history.undoSnapshot.productionPlanBefore
  const replayed = before.steps.filter(({ isCompleted }) => !isCompleted).map(({ id }) => id)
  return (
    history.action === 'operation_count_recovered' &&
    plan.status === 'completed' &&
    plan.currentStepId === null &&
    plan.completedAt === history.createdAt &&
    replayed.length > 0 &&
    replayed.at(-1) === history.planStepId &&
    replayed.every((id) => {
      const step = plan.steps.find((candidate) => candidate.id === id)
      return step !== undefined && step.isCompleted && step.completedAt === history.createdAt
    })
  )
}

/** Whether the latest ExecutionHistory itself finished the Plan as a compromise (16.12). */
function causedCompromiseFinish(plan: ProductionPlan, history: ExecutionHistory): boolean {
  return (
    history.action === 'finished_as_compromise' &&
    plan.status === 'abandoned' &&
    plan.abandonmentReason === 'finished_as_compromise' &&
    plan.abandonedAt === history.createdAt
  )
}

/**
 * Undo eligibility (`docs/PLANNER_SPEC.md` 16.16): an `active` or `stale` Plan,
 * or a `completed` / `abandoned` Plan whose terminal transition this very
 * ExecutionHistory caused. `terminal` tells whether the Undo reverses a
 * terminal transition. The one eligibility authority of both the Undo runtime
 * and the Navigator's display (`inspectExecutionUndo()`).
 */
type ExecutionUndoEligibility =
  | { allowed: true; terminal: boolean }
  | { allowed: false; message: string }

function deriveExecutionUndoEligibility(plan: ProductionPlan, history: ExecutionHistory): ExecutionUndoEligibility {
  const action: string = history.action
  if (!(currentExecutionActions as readonly string[]).includes(action)) {
    return { allowed: false, message: `ExecutionHistory '${history.id}' is a legacy '${action}' record and is never undone as a current Execution.` }
  }
  switch (plan.status) {
    case 'active':
    case 'stale':
      if (history.action === 'finished_as_compromise') {
        return { allowed: false, message: `ExecutionHistory '${history.id}' finished a Plan that is now '${plan.status}'.` }
      }
      return { allowed: true, terminal: false }
    case 'completed':
      if (!causedCompletion(plan, history) && !causedRecoveryCompletion(plan, history)) {
        return { allowed: false, message: `ExecutionHistory '${history.id}' did not complete ProductionPlan '${plan.id}'.` }
      }
      return { allowed: true, terminal: true }
    case 'abandoned':
      if (!causedCompromiseFinish(plan, history)) {
        return {
          allowed: false,
          message: `ProductionPlan '${plan.id}' was abandoned by '${plan.abandonmentReason}', not by ExecutionHistory '${history.id}'.`,
        }
      }
      return { allowed: true, terminal: true }
    case 'draft':
      return { allowed: false, message: `ProductionPlan '${plan.id}' has not started.` }
  }
}

function assertUndoAllowed(plan: ProductionPlan, history: ExecutionHistory): { terminal: boolean } {
  const eligibility = deriveExecutionUndoEligibility(plan, history)
  if (!eligibility.allowed) executionFailure('undo_not_allowed', eligibility.message)
  return { terminal: eligibility.terminal }
}

/**
 * Whether the Navigator offers Undo of the Plan's latest ExecutionHistory
 * (`docs/PLANNER_SPEC.md` 16.16, `docs/UI_FLOW.md` 12.7). Read-only and display
 * only: it applies the same Plan / snapshot contract checks and the same
 * eligibility as `prepareExecutionUndo()`, which stays the write authority and
 * re-derives everything inside its transaction (the latest record, the snapshot
 * validation and the resulting state included).
 */
export type ExecutionUndoAvailability =
  | {
      kind: 'available'
      /** The record Undo removes; the request names it as the latest the user saw. */
      history: ExecutionHistory
      /** The Undo reverses the Plan's completion or compromise finish. */
      terminal: boolean
      /** The undone record is the game save point's boundary, so Undo deletes the save point too. */
      deletesExecutionSavePoint: boolean
    }
  | { kind: 'unavailable' }

export function inspectExecutionUndo(
  plan: ProductionPlan,
  latestExecutionHistory: ExecutionHistory | null,
  executionSavePoint: Pick<ExecutionSavePoint, 'lastExecutionHistoryId'> | null,
): ExecutionUndoAvailability {
  const history = latestExecutionHistory
  if (history === null || history.planId !== plan.id) return { kind: 'unavailable' }
  if (history.undoSnapshot.productionPlanBefore.id !== plan.id) return { kind: 'unavailable' }
  if (!isExecutionContractProductionPlan(plan) || !isExecutionContractProductionPlan(history.undoSnapshot.productionPlanBefore)) {
    return { kind: 'unavailable' }
  }
  const eligibility = deriveExecutionUndoEligibility(plan, history)
  if (!eligibility.allowed) return { kind: 'unavailable' }
  return {
    kind: 'available',
    history,
    terminal: eligibility.terminal,
    deletesExecutionSavePoint: executionSavePoint !== null && executionSavePoint.lastExecutionHistoryId === history.id,
  }
}

/**
 * The save point after Undo (`docs/PLANNER_SPEC.md` 16.9 / 16.16):
 * - the undone record is the save point's boundary: delete it, and never bring
 *   back an older save point from the snapshot in its place
 * - the undone record's terminal transition deleted the save point: restore the
 *   snapshot body
 * - otherwise the save point (or its absence) is left as it is
 */
function decideSavePoint(
  history: ExecutionHistory,
  current: ExecutionSavePoint | null,
  terminal: boolean,
): ExecutionUndoSavePointWrite {
  if (current !== null && current.lastExecutionHistoryId === history.id) return { kind: 'delete' }
  const before = history.undoSnapshot.executionSavePointBefore
  if (terminal && current === null && before !== null) {
    return { kind: 'restore', savePoint: structuredClone(before) }
  }
  return { kind: 'keep' }
}

/**
 * Decides one Execution Undo (`docs/PLANNER_SPEC.md` 16.16, `docs/DATA_MODEL.md`
 * 12) purely from the persisted state and the latest ExecutionHistory's
 * `ExecutionUndoSnapshot`.
 *
 * The snapshot is the only authority: the RngState, the whole NormalArtianCounter
 * collection, the updated and removed OwnedWeapons, the changed TargetWeapons and
 * the Plan are restored to their exact snapshot bodies (timestamps included),
 * the added OwnedWeapons are deleted, and the undone ExecutionHistory is
 * deleted. No RNG prediction is re-run, no before value is derived from the
 * current state, and the restored Plan's status and recalculation reasons are
 * used as stored. The in-game operation itself is not reversed.
 */
export function prepareExecutionUndo(input: ExecutionUndoInput): ExecutionUndoWrite {
  const { plan, state } = input
  const { history, remaining } = requireLatestHistory(input)

  const historyValidation = validateExecutionHistory(history)
  if (!historyValidation.isValid) {
    snapshotInvalid(`ExecutionHistory '${history.id}' fails Domain validation, so its Step cannot be restored exactly.`, historyValidation.issues)
  }
  const snapshot = history.undoSnapshot
  if (snapshot.productionPlanBefore.id !== plan.id) {
    snapshotInvalid(`The snapshot Plan of ExecutionHistory '${history.id}' is not ProductionPlan '${plan.id}'.`)
  }
  if (!isExecutionContractProductionPlan(plan) || !isExecutionContractProductionPlan(snapshot.productionPlanBefore)) {
    executionFailure('plan_not_executable', `ProductionPlan '${plan.id}' predates the Execution Plan contract and is never undone as a current Execution.`)
  }
  const { terminal } = assertUndoAllowed(plan, history)
  assertSnapshotPlanIsStepStart(history)
  if (hasDuplicateIds(snapshot.normalCountersBefore)) {
    snapshotInvalid(`The Normal Counter snapshot of ExecutionHistory '${history.id}' holds a duplicate Counter ID.`)
  }

  const rngState = structuredClone(snapshot.rngStateBefore)
  const normalCounters = structuredClone(snapshot.normalCountersBefore)
  const deletedOwnedWeaponIds = [...snapshot.addedOwnedWeaponIds]
  const restoredOwnedWeapons = structuredClone([
    ...snapshot.affectedOwnedWeaponsBefore,
    ...snapshot.removedOwnedWeaponsBefore,
  ])
  const restoredTargetWeapons = structuredClone(snapshot.affectedTargetWeaponsBefore)
  const restoredPlan = structuredClone(snapshot.productionPlanBefore)
  const savePoint = decideSavePoint(history, state.executionSavePoint, terminal)

  // The resulting collections, as they will be persisted.
  const weapons = new Map(state.ownedWeapons.map((weapon) => [weapon.id, weapon]))
  deletedOwnedWeaponIds.forEach((id) => weapons.delete(id))
  restoredOwnedWeapons.forEach((weapon) => weapons.set(weapon.id, weapon))
  const targets = new Map(state.targetWeapons.map((target) => [target.id, target]))
  restoredTargetWeapons.forEach((target) => targets.set(target.id, target))

  assertResultValid('RngState', validateRngState(rngState))
  normalCounters.forEach((counter) =>
    assertResultValid(`NormalArtianCounter '${counter.id}'`, validateNormalArtianCounter(counter)))
  restoredOwnedWeapons.forEach((weapon) =>
    assertResultValid(`OwnedWeapon '${weapon.id}'`, validateOwnedWeapon(weapon)))
  restoredTargetWeapons.forEach((target) =>
    assertResultValid(`TargetWeapon '${target.id}'`, validateTargetWeapon(target)))
  assertResultValid(`ProductionPlan '${restoredPlan.id}'`, validateProductionPlan(restoredPlan))
  assertResultValid(
    'The Target preferred owned weapon collection',
    validateTargetPreferredOwnedWeapons([...targets.values()], [...weapons.values()]),
  )
  const remainingSavePoint = savePoint.kind === 'restore'
    ? savePoint.savePoint
    : savePoint.kind === 'keep' ? state.executionSavePoint : null
  if (remainingSavePoint !== null) {
    assertResultValid('ExecutionSavePoint', validateExecutionSavePoint(remainingSavePoint))
    assertResultValid(
      'ExecutionSavePoint references',
      validateExecutionSavePointReferences([remainingSavePoint], [restoredPlan], remaining),
    )
  }

  return {
    rngState,
    normalCounters,
    deletedOwnedWeaponIds,
    restoredOwnedWeapons,
    restoredTargetWeapons,
    plan: restoredPlan,
    executionSavePoint: savePoint,
    deletedExecutionHistoryId: history.id,
  }
}
