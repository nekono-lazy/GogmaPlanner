import type {
  DomainValidationIssue,
  DomainValidationResult,
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionSavePoint,
  ExecutionUndoSnapshot,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  ProductionPlan,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  compareExecutionHistoryOrder,
  deriveExecutionUndoEligibility,
  isExecutionContractProductionPlan,
  overlayProductionPlanUndoState,
  validateExecutionRecord,
  validateExecutionSavePoint,
  validateExecutionSavePointReferences,
  validateNormalArtianCounter,
  validateOwnedWeapon,
  validateProductionPlan,
  validateRngState,
  validateTargetWeapon,
} from '../models/publicTypes'
import { validateTargetOwnedWeaponCollections } from '../target/preferredOwnedWeapon'
import { executionFailure } from './executionRuntimeError'
import { reconstructExecutionUndoPlan } from './executionUndoReconstruction'
import type { ExecutionPersistedState } from './planExecutionState'

export interface ExecutionUndoInput {
  /** The current persisted Plan. */
  plan: ProductionPlan
  /** The ExecutionHistory the user asked to undo. */
  executionHistoryId: ExecutionHistoryId
  state: Pick<
    ExecutionPersistedState,
    'normalCounters' | 'ownedWeapons' | 'targetWeapons' | 'planExecutionHistory' | 'executionSavePoint'
  > & {
    /**
     * The Undo body stored for `executionHistoryId` - the one body an Undo reads
     * (`docs/DATA_MODEL.md` 14.6) - or `null` when none is stored.
     */
    undoSnapshot: ExecutionUndoSnapshot | null
  }
}

/** What happens to the Plan's game save point on Undo (`docs/PLANNER_SPEC.md` 16.9 / 16.16). */
export type ExecutionUndoSavePointWrite =
  | { kind: 'keep' }
  | { kind: 'delete' }
  | { kind: 'restore'; savePoint: ExecutionSavePoint }

/**
 * Everything one Undo transaction writes, decided and validated before a single
 * write happens (`docs/DATA_MODEL.md` 12.2 / 14.4). Every value is the exact
 * body before the record; nothing is recomputed, re-predicted or re-timestamped.
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
  /** The Plan just before the record, rebuilt and verified (`docs/PLANNER_SPEC.md` 19.5). */
  plan: ProductionPlan
  executionSavePoint: ExecutionUndoSavePointWrite
  /**
   * The undone ExecutionHistory: its metadata and its Undo body are both
   * deleted, and no Undo record is added in their place.
   */
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
 * Step is the recorded Step, so a Plan before the record that is not exactly
 * that cannot be the state before this record.
 *
 * `operation_count_recovered` starts from the `stale` Plan an
 * `operation_uncertain` record left (16.15): its current Step is incomplete and
 * the recorded Step - the last Step the recovery reached, or the current Step
 * itself for a position 0 recovery - is incomplete at or after it.
 */
function assertPlanBeforeIsStepStart(history: ExecutionHistory, before: ProductionPlan): void {
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
        `The Plan before ExecutionHistory '${history.id}' is not the stale Plan an uncertain operation left before PlanStep '${history.planStepId}'.`,
      )
    }
    return
  }
  if (before.status !== 'active' || before.currentStepId !== history.planStepId) {
    snapshotInvalid(
      `The Plan before ExecutionHistory '${history.id}' is not the active Plan at PlanStep '${history.planStepId}'.`,
    )
  }
  const step = before.steps.find(({ id }) => id === history.planStepId)
  if (!step || step.isCompleted) {
    snapshotInvalid(`The Plan before ExecutionHistory '${history.id}' has no incomplete PlanStep '${history.planStepId}'.`)
  }
}

/**
 * Undo eligibility through the one authority, `deriveExecutionUndoEligibility()`,
 * shared by the Undo runtime, the Navigator's display (`inspectExecutionUndo()`)
 * and the conversion of an existing record. `before` is the Plan just before
 * the record.
 */
function assertUndoAllowed(plan: ProductionPlan, history: ExecutionHistory, before: ProductionPlan): { terminal: boolean } {
  const eligibility = deriveExecutionUndoEligibility(plan, history, before)
  if (!eligibility.allowed) executionFailure('undo_not_allowed', eligibility.message)
  return { terminal: eligibility.terminal }
}

/**
 * Whether the Navigator offers Undo of the Plan's latest ExecutionHistory
 * (`docs/PLANNER_SPEC.md` 16.16 / 19.5, `docs/UI_FLOW.md` 12.7). Read-only and
 * display only: it lays the latest record's Undo state over the current Plan
 * without the hash check (`overlayProductionPlanUndoState()`) and applies the
 * same Plan contract checks and the same eligibility as
 * `prepareExecutionUndo()`, which stays the write authority and re-derives
 * everything inside its transaction (the latest record, the hashes, the body
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
  latestUndoSnapshot: ExecutionUndoSnapshot | null,
  executionSavePoint: Pick<ExecutionSavePoint, 'lastExecutionHistoryId'> | null,
): ExecutionUndoAvailability {
  const history = latestExecutionHistory
  if (history === null || history.planId !== plan.id) return { kind: 'unavailable' }
  if (latestUndoSnapshot === null || latestUndoSnapshot.executionHistoryId !== history.id) return { kind: 'unavailable' }
  const before = overlayProductionPlanUndoState(plan, latestUndoSnapshot.productionPlanStateBefore)
  if (before === null) return { kind: 'unavailable' }
  if (!isExecutionContractProductionPlan(plan) || !isExecutionContractProductionPlan(before)) {
    return { kind: 'unavailable' }
  }
  const eligibility = deriveExecutionUndoEligibility(plan, history, before)
  if (!eligibility.allowed) return { kind: 'unavailable' }
  return {
    kind: 'available',
    history,
    terminal: eligibility.terminal,
    deletesExecutionSavePoint: executionSavePoint !== null && executionSavePoint.lastExecutionHistoryId === history.id,
  }
}

/**
 * The save point after Undo (`docs/PLANNER_SPEC.md` 16.9 / 16.16 / 19.5):
 * - the undone record is the save point's boundary: delete it, and never bring
 *   back an older save point in its place
 * - the undone record's terminal transition deleted the save point: restore the
 *   `deletedExecutionSavePoint` body
 * - otherwise the save point (or its absence) is left as it is
 */
function decideSavePoint(
  history: ExecutionHistory,
  snapshot: ExecutionUndoSnapshot,
  current: ExecutionSavePoint | null,
  terminal: boolean,
): ExecutionUndoSavePointWrite {
  if (current !== null && current.lastExecutionHistoryId === history.id) return { kind: 'delete' }
  const deleted = snapshot.deletedExecutionSavePoint
  if (terminal && current === null && deleted !== null) {
    return { kind: 'restore', savePoint: structuredClone(deleted) }
  }
  return { kind: 'keep' }
}

/**
 * Decides one Execution Undo (`docs/PLANNER_SPEC.md` 16.16 / 19.5,
 * `docs/DATA_MODEL.md` 12.2) purely from the persisted state, the latest
 * ExecutionHistory and its Undo body:
 *
 * 1. the requested record is the Plan's latest (`compareExecutionHistoryOrder()`)
 * 2. its Undo body exists and belongs to it, and both pass the 12.2 validation
 * 3. the Plan just before the record is rebuilt from the current Plan and the
 *    body's Plan undo state, its content hash and execution state hash verified
 *    (`reconstructExecutionUndoPlan()`)
 * 4. the rebuilt Plan is the `productionPlanBefore` of the 16.16 contract, the
 *    eligibility, the Step start, the restored values and the write
 *
 * Any mismatch of 2 or 3 refuses with `undo_snapshot_invalid` before anything is
 * written. The body is the only authority: the RngState, the whole
 * NormalArtianCounter collection, the updated and removed OwnedWeapons and the
 * changed TargetWeapons are restored to their exact bodies (timestamps
 * included), the added OwnedWeapons are deleted, and the undone record's
 * metadata and body are deleted. No RNG prediction is re-run, no Counter is
 * derived backwards, no Plan transition is replayed, and the rebuilt Plan's
 * status and recalculation reasons are used as stored. The in-game operation
 * itself is not reversed.
 */
export function prepareExecutionUndo(input: ExecutionUndoInput): ExecutionUndoWrite {
  const { plan, state } = input
  const { history, remaining } = requireLatestHistory(input)

  const snapshot = state.undoSnapshot
  if (snapshot === null || snapshot.executionHistoryId !== history.id) {
    snapshotInvalid(`ExecutionHistory '${history.id}' has no Undo body of its own, so its Step cannot be restored exactly.`)
  }
  const recordValidation = validateExecutionRecord(history, snapshot)
  if (!recordValidation.isValid) {
    snapshotInvalid(`ExecutionHistory '${history.id}' fails Domain validation, so its Step cannot be restored exactly.`, recordValidation.issues)
  }
  const planBefore = reconstructExecutionUndoPlan(plan, snapshot.productionPlanStateBefore)
  if (!isExecutionContractProductionPlan(plan) || !isExecutionContractProductionPlan(planBefore)) {
    executionFailure('plan_not_executable', `ProductionPlan '${plan.id}' predates the Execution Plan contract and is never undone as a current Execution.`)
  }
  const { terminal } = assertUndoAllowed(plan, history, planBefore)
  assertPlanBeforeIsStepStart(history, planBefore)
  if (hasDuplicateIds(snapshot.normalCountersBefore)) {
    snapshotInvalid(`The Normal Counter snapshot of ExecutionHistory '${history.id}' holds a duplicate Counter ID.`)
  }

  const rngState = structuredClone(snapshot.rngStateBefore)
  const normalCounters = structuredClone(snapshot.normalCountersBefore)
  const deletedOwnedWeaponIds = [...history.addedOwnedWeaponIds]
  const restoredOwnedWeapons = structuredClone([
    ...snapshot.affectedOwnedWeaponsBefore,
    ...snapshot.removedOwnedWeaponsBefore,
  ])
  const restoredTargetWeapons = structuredClone(snapshot.affectedTargetWeaponsBefore)
  const savePoint = decideSavePoint(history, snapshot, state.executionSavePoint, terminal)

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
  assertResultValid(`ProductionPlan '${planBefore.id}'`, validateProductionPlan(planBefore))
  assertResultValid(
    'The Target preferred owned weapon and completion assignment collections',
    validateTargetOwnedWeaponCollections([...targets.values()], [...weapons.values()]),
  )
  const remainingSavePoint = savePoint.kind === 'restore'
    ? savePoint.savePoint
    : savePoint.kind === 'keep' ? state.executionSavePoint : null
  if (remainingSavePoint !== null) {
    assertResultValid('ExecutionSavePoint', validateExecutionSavePoint(remainingSavePoint))
    assertResultValid(
      'ExecutionSavePoint references',
      validateExecutionSavePointReferences([remainingSavePoint], [planBefore], remaining),
    )
  }

  return {
    rngState,
    normalCounters,
    deletedOwnedWeaponIds,
    restoredOwnedWeapons,
    restoredTargetWeapons,
    plan: planBefore,
    executionSavePoint: savePoint,
    deletedExecutionHistoryId: history.id,
  }
}
