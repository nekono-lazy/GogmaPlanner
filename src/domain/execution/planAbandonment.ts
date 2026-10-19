import type {
  CalculationContext,
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionSavePoint,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  executionSavePointIdForPlan,
  validateOwnedWeapon,
  validateProductionPlan,
} from '../models/publicTypes'
import { validateTargetPreferredOwnedWeapons } from '../target/preferredOwnedWeapon'
import { ExecutionRuntimeError, executionFailure } from './executionRuntimeError'
import {
  prepareExecutionSavePointRestore,
  splitExecutionHistoryAtSavePoint,
} from './executionSavePoint'
import type { ExecutionPersistedState } from './planExecutionState'
import { inconsistent } from './stepExecution'

/** The Plan statuses a user abandonment, a replan adoption or a breaking change can end. */
export type RunningProductionPlanStatus = Extract<ProductionPlan['status'], 'active' | 'stale'>

/**
 * Whether a Plan-ending action on a running Plan must first ask the user
 * between 「現在地点を維持」 and 「最後のゲーム内セーブ地点へ戻す」
 * (`docs/PLANNER_SPEC.md` 16.10).
 *
 * The choice is required exactly when the Plan has a game save point and at
 * least one of the Plan's ExecutionHistory records is ordered after the save
 * point boundary by `compareExecutionHistoryOrder()`. With no save point, or
 * with a save point at the current position, nothing is asked.
 */
export type RunningPlanSavePointChoiceRequirement =
  | { required: false; savePoint: ExecutionSavePoint | null }
  | {
      required: true
      savePoint: ExecutionSavePoint
      /** The Plan's records after the save point, oldest first. */
      historyAfterSavePoint: ExecutionHistory[]
    }

/**
 * Derives the 16.10 save point choice of a running Plan purely from its
 * persisted save point and ExecutionHistory. It never guesses the game's save
 * state. The boundary is resolved by the same authority the save point restore
 * uses, so a boundary record that no longer exists or belongs to another Plan
 * is refused (`save_point_snapshot_invalid`), never read as `null`.
 *
 * It is not specific to user abandonment: replan adoption and an approved
 * breaking change ask the same question.
 */
export function deriveRunningPlanSavePointChoiceRequirement(
  plan: Pick<ProductionPlan, 'id'>,
  savePoint: ExecutionSavePoint | null,
  planExecutionHistory: readonly ExecutionHistory[],
): RunningPlanSavePointChoiceRequirement {
  if (savePoint === null) return { required: false, savePoint: null }
  if (savePoint.productionPlanId !== plan.id || savePoint.id !== executionSavePointIdForPlan(plan.id)) {
    executionFailure(
      'save_point_snapshot_invalid',
      `The game save point '${savePoint.id}' is not the save point of ProductionPlan '${plan.id}'.`,
    )
  }
  const { after } = splitExecutionHistoryAtSavePoint(plan, savePoint, planExecutionHistory)
  return after.length === 0
    ? { required: false, savePoint }
    : { required: true, savePoint, historyAfterSavePoint: after }
}

/**
 * Whether the Navigator offers 「最後のゲーム内セーブ地点へ戻す」 on its own
 * (`docs/UI_FLOW.md` 12.8): only a running Plan with a save point that at least
 * one of its records is ordered after. Read-only and display only, derived by
 * `deriveRunningPlanSavePointChoiceRequirement()` - the boundary authority the
 * restore and the 16.10 choice use - and never by array position or timestamps.
 * `prepareExecutionSavePointRestore()` stays the write authority.
 */
export type ExecutionSavePointRestoreAvailability =
  | { kind: 'no_save_point' }
  /** The Plan is not `active` / `stale`, so no save point restore applies. */
  | { kind: 'not_running'; savePoint: ExecutionSavePoint }
  /** The save point is the current position: nothing was confirmed after it. */
  | { kind: 'at_current_position'; savePoint: ExecutionSavePoint }
  | { kind: 'available'; savePoint: ExecutionSavePoint }
  /** Its boundary is missing or foreign: the restore would refuse it (`save_point_snapshot_invalid`). */
  | { kind: 'invalid'; savePoint: ExecutionSavePoint }

export function inspectExecutionSavePointRestore(
  plan: Pick<ProductionPlan, 'id' | 'status'>,
  savePoint: ExecutionSavePoint | null,
  planExecutionHistory: readonly ExecutionHistory[],
): ExecutionSavePointRestoreAvailability {
  if (savePoint === null) return { kind: 'no_save_point' }
  if (plan.status !== 'active' && plan.status !== 'stale') return { kind: 'not_running', savePoint }
  try {
    const choice = deriveRunningPlanSavePointChoiceRequirement(plan, savePoint, planExecutionHistory)
    return choice.required ? { kind: 'available', savePoint } : { kind: 'at_current_position', savePoint }
  } catch (caught: unknown) {
    if (caught instanceof ExecutionRuntimeError && caught.code === 'save_point_snapshot_invalid') {
      return { kind: 'invalid', savePoint }
    }
    throw caught
  }
}

/**
 * What the Plan abandonment confirmation must show (`docs/UI_FLOW.md` 16.2),
 * plus the tokens the abandonment request echoes back so the transaction can
 * refuse a state the user never saw. It is advisory only: the abandonment
 * re-derives everything inside its own transaction.
 */
export type ProductionPlanAbandonmentOptions = {
  planId: ProductionPlanId
  planStatus: RunningProductionPlanStatus
  planCurrentStepId: PlanStepId | null
  planUpdatedAt: ISODateTimeString
} & (
  | { savePointChoiceRequired: false }
  | {
      savePointChoiceRequired: true
      savePointRecordedAt: ISODateTimeString
      savePointLastExecutionHistoryId: ExecutionHistoryId | null
      /** The Plan's current Step when the save point was recorded. */
      savePointCurrentStepId: PlanStepId | null
    }
)

/**
 * The user's answer to the 16.10 choice. `null` is the plain abandonment when
 * no choice was offered. 「キャンセル」 is not a decision: cancelling means the
 * abandonment is never requested and nothing changes.
 */
export type PlanAbandonSavePointDecision =
  | null
  | { kind: 'keep_current'; recordedAt: ISODateTimeString }
  | { kind: 'restore_save_point'; recordedAt: ISODateTimeString }

/**
 * The user's 16.10 decision must answer exactly the choice re-derived inside
 * the transaction: a required choice needs a decision naming the very save
 * point the user saw, and no decision is accepted where no choice applies.
 * Shared by user abandonment and replan adoption.
 */
export function assertRunningPlanSavePointDecision(
  plan: Pick<ProductionPlan, 'id'>,
  choice: RunningPlanSavePointChoiceRequirement,
  savePointDecision: PlanAbandonSavePointDecision,
): void {
  if (choice.required && savePointDecision === null) {
    executionFailure(
      'save_point_choice_required',
      `ProductionPlan '${plan.id}' ran past its game save point; choose whether to keep the current state or return to the save point.`,
    )
  }
  if (!choice.required && savePointDecision !== null) {
    executionFailure(
      'save_point_choice_not_required',
      `ProductionPlan '${plan.id}' did not run past a game save point, so no save point decision applies.`,
    )
  }
  if (choice.required && savePointDecision !== null && savePointDecision.recordedAt !== choice.savePoint.recordedAt) {
    executionFailure(
      'save_point_changed',
      `The game save point of ProductionPlan '${plan.id}' was recorded at '${choice.savePoint.recordedAt}', not at the chosen '${savePointDecision.recordedAt}'.`,
    )
  }
}

/** The Plan as the user saw it when confirming the abandonment. */
export interface ObservedProductionPlanState {
  status: ProductionPlan['status']
  currentStepId: PlanStepId | null
  updatedAt: ISODateTimeString
}

type AbandonmentReadState = Pick<
  ExecutionPersistedState,
  'ownedWeapons' | 'targetWeapons' | 'buildListEntries' | 'planExecutionHistory' | 'executionSavePoint'
>

function requireRunningPlan(plan: ProductionPlan): RunningProductionPlanStatus {
  if (plan.status !== 'active' && plan.status !== 'stale') {
    executionFailure(
      'plan_abandon_not_allowed',
      `ProductionPlan '${plan.id}' is '${plan.status}'; only an active or stale Plan can be abandoned.`,
    )
  }
  return plan.status
}

/**
 * Reads what abandoning the Plan would ask (`docs/PLANNER_SPEC.md` 16.10). It
 * changes nothing.
 */
export function inspectProductionPlanAbandonment(
  plan: ProductionPlan,
  state: Pick<AbandonmentReadState, 'planExecutionHistory' | 'executionSavePoint'>,
): ProductionPlanAbandonmentOptions {
  const planStatus = requireRunningPlan(plan)
  const base = {
    planId: plan.id,
    planStatus,
    planCurrentStepId: plan.currentStepId,
    planUpdatedAt: plan.updatedAt,
  }
  const choice = deriveRunningPlanSavePointChoiceRequirement(plan, state.executionSavePoint, state.planExecutionHistory)
  if (!choice.required) return { ...base, savePointChoiceRequired: false }
  return {
    ...base,
    savePointChoiceRequired: true,
    savePointRecordedAt: choice.savePoint.recordedAt,
    savePointLastExecutionHistoryId: choice.savePoint.lastExecutionHistoryId,
    savePointCurrentStepId: choice.savePoint.productionPlan.currentStepId,
  }
}

export interface ProductionPlanAbandonmentInput {
  /** The current persisted Plan. */
  plan: ProductionPlan
  observedPlan: ObservedProductionPlanState
  savePointDecision: PlanAbandonSavePointDecision
  state: AbandonmentReadState
  currentCalculationContext: CalculationContext
  now: ISODateTimeString
}

/**
 * Everything one user abandonment writes (`docs/DATA_MODEL.md` 14.4), decided
 * and validated before a single write happens. Values are exact bodies.
 */
export interface ProductionPlanAbandonmentWrite {
  /** How the abandonment treated the game save point. */
  savePointHandling: 'no_choice' | 'keep_current' | 'restore_save_point'
  /** The restored RngState; `null` leaves it untouched. */
  rngState: RngState | null
  /** The whole restored NormalArtianCounter collection; `null` leaves the collection untouched. */
  normalCounters: NormalArtianCounter[] | null
  /** OwnedWeapons this Plan's Execution registered after the save point. */
  deletedOwnedWeaponIds: OwnedWeaponId[]
  /** OwnedWeapons to put: restored bodies and weapons no longer in progress. */
  ownedWeapons: OwnedWeapon[]
  /** TargetWeapons to put: only a save point restore returns any. */
  targetWeapons: TargetWeapon[]
  plan: ProductionPlan
  /** The Plan's ExecutionHistory after the save point, deleted by the restore. */
  deletedExecutionHistoryIds: ExecutionHistoryId[]
  /** The Plan's game save point is deleted with the terminal transition. */
  deletesExecutionSavePoint: boolean
}

export function withoutPlanInProgress(
  planId: ProductionPlanId,
  weapons: readonly OwnedWeapon[],
  now: ISODateTimeString,
): OwnedWeapon[] {
  return weapons.map((weapon) =>
    weapon.executionInProgress?.productionPlanId === planId
      ? { ...weapon, executionInProgress: null, updatedAt: now }
      : weapon)
}

/**
 * The Plan-ending transition to `abandoned` with the given reason, shared by
 * user abandonment and an approved breaking change (16.2 / 16.6).
 */
export function abandonedProductionPlan(
  base: ProductionPlan,
  now: ISODateTimeString,
  abandonmentReason: 'user_abandoned' | 'breaking_change_approved' = 'user_abandoned',
): ProductionPlan {
  // `currentStepId`, every Step completion and `recalculationReasons` stay as
  // they are on the base: the Plan records where it stopped, and a stale reason
  // survives the abandonment (16.2).
  return {
    ...structuredClone(base),
    status: 'abandoned',
    abandonmentReason,
    abandonedAt: now,
    completedAt: null,
    updatedAt: now,
  }
}

/**
 * Decides one 「現在Planを破棄する」 (`docs/PLANNER_SPEC.md` 16.2 / 16.10,
 * `docs/UI_FLOW.md` 16.2) of an `active` or `stale` Plan.
 *
 * It is refused unless the Plan's status, current Step and `updatedAt` are
 * still what the user saw, and the save point decision matches the 16.10 choice
 * re-derived inside the transaction: a required choice needs a decision naming
 * the very save point the user saw, and no decision is accepted where no choice
 * applies.
 *
 * - No choice / 「現在地点を維持」: the current persisted state is kept exactly -
 *   RngState, Counters, OwnedWeapon performance, status and protection, Targets
 *   with their preferences, Build List, every ExecutionHistory record, the Plan's
 *   current Step, Step completions and recalculation reasons. Only the Plan
 *   becomes `abandoned` (`user_abandoned`), every weapon in progress for it
 *   stops being in progress, and its save point is deleted. The Plan need not be
 *   executable under the current CalculationContext: ending it is not executing
 *   it, so a `calculation_context_changed` Plan can be abandoned too.
 * - 「最後のゲーム内セーブ地点へ戻す」: the save point restore
 *   (`prepareExecutionSavePointRestore()`) is decided first with all its
 *   fail-closed checks, then the restored snapshot Plan becomes `abandoned`
 *   (`user_abandoned`) - its own recalculation reasons, never the current Plan's
 *   - every restored weapon in progress for it stops being in progress, and the
 *   save point is deleted. Targets and preferences stay as restored.
 *
 * No ExecutionHistory is added in either case, so the abandonment itself is
 * never undoable (16.16).
 */
export function prepareProductionPlanAbandonment(input: ProductionPlanAbandonmentInput): ProductionPlanAbandonmentWrite {
  const { plan, observedPlan, savePointDecision, state, now } = input
  if (
    plan.status !== observedPlan.status ||
    plan.currentStepId !== observedPlan.currentStepId ||
    plan.updatedAt !== observedPlan.updatedAt
  ) {
    executionFailure(
      'plan_abandon_state_changed',
      `ProductionPlan '${plan.id}' changed after the abandonment was confirmed; confirm it again.`,
    )
  }
  requireRunningPlan(plan)

  const choice = deriveRunningPlanSavePointChoiceRequirement(plan, state.executionSavePoint, state.planExecutionHistory)
  assertRunningPlanSavePointDecision(plan, choice, savePointDecision)

  return savePointDecision?.kind === 'restore_save_point'
    ? abandonAtSavePoint(input, savePointDecision.recordedAt)
    : abandonAtCurrentState(plan, state, now, savePointDecision === null ? 'no_choice' : 'keep_current')
}

function abandonAtCurrentState(
  plan: ProductionPlan,
  state: AbandonmentReadState,
  now: ISODateTimeString,
  savePointHandling: 'no_choice' | 'keep_current',
): ProductionPlanAbandonmentWrite {
  const nextWeapons = withoutPlanInProgress(plan.id, state.ownedWeapons, now)
  const changedWeapons = nextWeapons.filter((weapon, index) => weapon !== state.ownedWeapons[index])
  const nextPlan = abandonedProductionPlan(plan, now)
  assertAbandonedStateValid(nextPlan, changedWeapons, nextWeapons, state.targetWeapons)
  return {
    savePointHandling,
    rngState: null,
    normalCounters: null,
    deletedOwnedWeaponIds: [],
    ownedWeapons: changedWeapons,
    targetWeapons: [],
    plan: nextPlan,
    deletedExecutionHistoryIds: [],
    deletesExecutionSavePoint: state.executionSavePoint !== null,
  }
}

function abandonAtSavePoint(
  input: ProductionPlanAbandonmentInput,
  recordedAt: ISODateTimeString,
): ProductionPlanAbandonmentWrite {
  const { plan, state, now } = input
  // The restore contract as it is: every refusal happens here, before the
  // abandonment changes anything.
  const restore = prepareExecutionSavePointRestore({
    plan,
    recordedAt,
    state,
    currentCalculationContext: input.currentCalculationContext,
  })

  // The OwnedWeapon collection after the restore, then with this Plan's
  // in-progress marks cleared on it.
  const deleted = new Set<string>(restore.deletedOwnedWeaponIds)
  const restoredById = new Map(restore.restoredOwnedWeapons.map((weapon) => [weapon.id, weapon]))
  const restoredCollection = [
    ...state.ownedWeapons.filter(({ id }) => !deleted.has(id) && !restoredById.has(id)),
    ...restore.restoredOwnedWeapons,
  ]
  const nextWeapons = withoutPlanInProgress(plan.id, restoredCollection, now)
  const writtenWeapons = nextWeapons.filter((weapon, index) =>
    weapon !== restoredCollection[index] || restoredById.has(weapon.id))

  const restoredTargetIds = new Set<string>(restore.restoredTargetWeapons.map(({ id }) => id))
  const nextTargets = [
    ...state.targetWeapons.filter(({ id }) => !restoredTargetIds.has(id)),
    ...restore.restoredTargetWeapons,
  ]
  const nextPlan = abandonedProductionPlan(restore.plan, now)
  assertAbandonedStateValid(nextPlan, writtenWeapons, nextWeapons, nextTargets)
  return {
    savePointHandling: 'restore_save_point',
    rngState: restore.rngState,
    normalCounters: restore.normalCounters,
    deletedOwnedWeaponIds: restore.deletedOwnedWeaponIds,
    ownedWeapons: writtenWeapons,
    targetWeapons: restore.restoredTargetWeapons,
    plan: nextPlan,
    deletedExecutionHistoryIds: restore.deletedExecutionHistoryIds,
    deletesExecutionSavePoint: true,
  }
}

/**
 * The abandoned state validated before any write: the Plan and every weapon
 * this abandonment changed, the Target preference collection, and no weapon
 * left in progress for the abandoned Plan (16.10.1).
 */
export function assertAbandonedStateValid(
  plan: ProductionPlan,
  changedWeapons: readonly OwnedWeapon[],
  nextWeapons: readonly OwnedWeapon[],
  nextTargets: readonly TargetWeapon[],
): void {
  const planValidation = validateProductionPlan(plan)
  if (!planValidation.isValid) {
    executionFailure('entity_validation_failed', `ProductionPlan '${plan.id}' fails Domain validation after the abandonment.`, planValidation.issues)
  }
  for (const weapon of changedWeapons) {
    const validation = validateOwnedWeapon(weapon)
    if (!validation.isValid) {
      executionFailure('entity_validation_failed', `OwnedWeapon '${weapon.id}' fails Domain validation after the abandonment.`, validation.issues)
    }
  }
  const preferences = validateTargetPreferredOwnedWeapons([...nextTargets], [...nextWeapons])
  if (!preferences.isValid) {
    executionFailure('collection_validation_failed', 'The Target preferred owned weapon collection is invalid after the abandonment.', preferences.issues)
  }
  const stillInProgress = nextWeapons.find(({ executionInProgress }) => executionInProgress?.productionPlanId === plan.id)
  if (stillInProgress !== undefined) {
    inconsistent(`OwnedWeapon '${stillInProgress.id}' is still in progress for the abandoned ProductionPlan '${plan.id}'.`)
  }
}
