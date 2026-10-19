import {
  executionReidentificationDestination,
  type ExecutionRuntimeErrorCode,
  type ReidentificationDestination,
} from '../../domain/execution'
import type {
  ExecutionHistory,
  ExpectedResult,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStep,
  PlanStepNormalCreationRole,
  ProductionPlan,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import { planStepOperationLabels } from '../../presentation/labels'
import { orderPlanSteps } from '../planner/productionPlanPresentation'

/**
 * Pure presentation over an exact persisted ProductionPlan for the Execution
 * Navigator (`docs/UI_FLOW.md` 12, `docs/PLANNER_SPEC.md` 16).
 *
 * Nothing here decides Execution semantics: the Plan's `currentStepId`, the
 * Steps' `isCompleted`, `order` and `executionEffects` are read as they were
 * persisted, no RNG prediction runs, and no Step is reconstructed from a
 * Candidate. The Execution runtime stays the authority that accepts or refuses
 * every confirmation.
 */

/** Where the Plan stands, from its persisted `order`, `isCompleted` and `currentStepId`. */
export interface ExecutionProgressView {
  totalStepCount: number
  completedStepCount: number
  remainingStepCount: number
  /** 1-based position of the current Step in Plan order, or `null` when there is none. */
  currentStepNumber: number | null
  currentStep: PlanStep | null
}

export function createExecutionProgress(plan: ProductionPlan): ExecutionProgressView {
  const steps = orderPlanSteps(plan)
  const completedStepCount = steps.filter(({ isCompleted }) => isCompleted).length
  // `currentStepId` is the only current-Step authority; an array index or the
  // first incomplete Step is never taken in its place.
  const currentIndex =
    plan.currentStepId === null ? -1 : steps.findIndex(({ id }) => id === plan.currentStepId)
  const currentStep = currentIndex < 0 ? null : steps[currentIndex]
  return {
    totalStepCount: steps.length,
    completedStepCount,
    remainingStepCount: steps.length - completedStepCount,
    currentStepNumber: currentStep === null || currentStep.isCompleted ? null : currentIndex + 1,
    currentStep: currentStep === null || currentStep.isCompleted ? null : currentStep,
  }
}

/** Which confirmation the current Step offers (`docs/PLANNER_SPEC.md` 16.4). */
export type ExecutionStepActionKind =
  /** 「結果一致・次へ」 */
  | 'confirm_expected'
  /** 「実際の5枠を入力して確定」: a blind production-target Normal. */
  | 'observe_normal_bonuses'
  /** 「所持武器で完成を確認」: no game operation. */
  | 'confirm_owned_ideal'
  /** A legacy or projection-less Step the Navigator never executes. */
  | 'not_executable'

export type ExecutionExpectedView =
  | { kind: 'none' }
  | { kind: 'observation_required' }
  | { kind: 'result'; result: ExpectedResult }

export interface ExecutionStepPresentation {
  step: PlanStep
  operationLabel: string
  actionKind: ExecutionStepActionKind
  normalCreationRole: PlanStepNormalCreationRole | null
  /**
   * The tracked weapon's current name (or its ID when it cannot be resolved).
   * `null` for a Counter-advance Normal and for the Step that registers the
   * production-target Normal, which does not exist yet.
   */
  weaponLabel: string | null
  /**
   * The exact persisted OwnedWeapon `weaponLabel` names, for the read-only
   * lookup beside it (Issue #76). `null` whenever no name is shown and
   * whenever the tracked ID cannot be resolved in the current snapshot, so the
   * ID fallback label is never backed by a guessed weapon.
   */
  weapon: OwnedWeapon | null
  /** The weapon type whose bonus names the expected result uses. */
  weaponTypeId: string
  /** The element the actual result input offers bonuses for (tracked weapon, else the Target). */
  elementId: string
  /** The Step's primary Target name, or its ID when it cannot be resolved. */
  targetLabel: string | null
  /**
   * The exact persisted TargetWeapon `targetLabel` names, for the read-only
   * lookup beside it (Issue #76). `null` when the Step names no Target or the
   * Target is not in the current snapshot.
   */
  target: TargetWeapon | null
  expected: ExecutionExpectedView
  /** Target names from `executionEffects.targetCompletions` only. */
  completionTargetLabels: string[]
  /** The Step carries `checkpointMilestones`: it reaches a selected intermediate state. */
  reachesCheckpoint: boolean
}

export function ownedWeaponLabel(
  weaponId: OwnedWeaponId,
  ownedWeapons: readonly OwnedWeapon[],
): string {
  return ownedWeapons.find(({ id }) => id === weaponId)?.name ?? `所持武器（${weaponId}）`
}

export function targetWeaponLabel(
  targetWeaponId: TargetWeaponId,
  targetWeapons: readonly TargetWeapon[],
): string {
  return targetWeapons.find(({ id }) => id === targetWeaponId)?.name ?? `目標武器（${targetWeaponId}）`
}

function actionKindFor(step: PlanStep): ExecutionStepActionKind {
  const effects = step.executionEffects
  if (effects === undefined) return 'not_executable'
  switch (step.operationType) {
    case 'confirm_owned_ideal':
      return 'confirm_owned_ideal'
    case 'create_normal_artian':
      return effects.observationBinding !== null ? 'observe_normal_bonuses' : 'confirm_expected'
    case 'convert_normal_to_gogma':
    case 'reset_bonuses':
    case 'keep_bonuses':
    case 'reset_skills':
      return 'confirm_expected'
    case 'reserve_weapon':
    case 'confirm_result':
      // Legacy Steps are displayed by the Plan page but never executed.
      return 'not_executable'
  }
}

export function createExecutionStepPresentation(
  step: PlanStep,
  ownedWeapons: readonly OwnedWeapon[],
  targetWeapons: readonly TargetWeapon[],
): ExecutionStepPresentation {
  const effects = step.executionEffects
  const actionKind = actionKindFor(step)
  const trackedId = effects?.trackedOwnedWeaponId ?? null
  const tracked = trackedId === null ? null : ownedWeapons.find(({ id }) => id === trackedId) ?? null
  const target = step.targetWeaponId === null
    ? null
    : targetWeapons.find(({ id }) => id === step.targetWeaponId) ?? null
  // A weapon the Step registers does not exist yet: the Target's type / element apply.
  const existingTracked = effects?.registersTrackedWeapon === true ? null : tracked
  const weaponLabel =
    trackedId === null || effects?.registersTrackedWeapon === true
      ? null
      : ownedWeaponLabel(trackedId, ownedWeapons)
  const expected: ExecutionExpectedView =
    actionKind === 'observe_normal_bonuses'
      ? { kind: 'observation_required' }
      : step.expectedResult === null
        ? { kind: 'none' }
        : { kind: 'result', result: step.expectedResult }
  return {
    step,
    operationLabel: planStepOperationLabels[step.operationType],
    actionKind,
    normalCreationRole: effects?.normalCreationRole ?? null,
    weaponLabel,
    weapon: weaponLabel === null ? null : existingTracked,
    weaponTypeId: tracked?.weaponTypeId ?? target?.weaponTypeId ?? '',
    elementId: existingTracked?.elementId ?? target?.elementId ?? '',
    targetLabel:
      step.targetWeaponId === null ? null : targetWeaponLabel(step.targetWeaponId, targetWeapons),
    target,
    expected,
    completionTargetLabels: (effects?.targetCompletions ?? []).map(({ targetWeaponId }) =>
      targetWeaponLabel(targetWeaponId, targetWeapons),
    ),
    reachesCheckpoint: (step.checkpointMilestones ?? []).length > 0,
  }
}

/** The physical operations the weapon switch guidance compares (16.14). */
const WEAPON_SWITCH_OPERATIONS: ReadonlySet<PlanStep['operationType']> = new Set([
  'convert_normal_to_gogma',
  'reset_bonuses',
  'keep_bonuses',
  'reset_skills',
])

function switchSubject(step: PlanStep): OwnedWeaponId | null {
  if (!WEAPON_SWITCH_OPERATIONS.has(step.operationType)) return null
  return step.executionEffects?.trackedOwnedWeaponId ?? null
}

/**
 * The weapon the user must switch to before the current Step
 * (`docs/UI_FLOW.md` 12.6, `docs/PLANNER_SPEC.md` 16.14), or `null`.
 *
 * Presentation only: it compares the current Step's tracked weapon with the
 * tracked weapon of the last *completed* conversion / Reset / Keep / Reset
 * Skills Step in Plan order. `create_normal_artian` and `confirm_owned_ideal`
 * are neither compared nor prompted. With no earlier compared Step there is no
 * weapon to switch from, so nothing is prompted.
 */
export function weaponSwitchTarget(
  plan: ProductionPlan,
  currentStep: PlanStep,
): OwnedWeaponId | null {
  const current = switchSubject(currentStep)
  if (current === null) return null
  let previous: OwnedWeaponId | null = null
  for (const step of orderPlanSteps(plan)) {
    if (!step.isCompleted) continue
    const subject = switchSubject(step)
    if (subject !== null) previous = subject
  }
  return previous !== null && previous !== current ? current : null
}

/**
 * The game save point cannot be restored safely (UI_FLOW 12.8): an entity the
 * restored Plan needs was deleted, or the record itself cannot be restored
 * exactly. Nothing is revived and nothing was changed.
 */
export const SAVE_POINT_UNSAFE_MESSAGE =
  'このセーブ地点を安全に復元できません。必要な所持武器・目標武器・作成リストの状態を確認し、現在状態から再計画してください。状態は変更されていません。'

/** A typed Execution runtime refusal, in the words the Navigator shows. */
export function executionErrorMessage(code: ExecutionRuntimeErrorCode): string {
  switch (code) {
    case 'plan_not_found':
      return '生産計画が見つかりません。'
    case 'plan_not_startable':
      return 'この生産計画は開始できる状態ではありません。'
    case 'running_plan_conflict':
      return '別の生産計画が実行中です。実行中の生産計画を終えてから開始してください。'
    case 'plan_not_active':
      return 'この生産計画は実行中ではないため、操作を確定できません。'
    case 'plan_not_executable':
      return 'この生産計画は現在の実行形式ではないため実行できません。ビルドリストから再計算してください。'
    case 'calculation_context_changed':
      return 'この生産計画は現在の計算契約と互換性がないため実行できません。ビルドリストから再計算してください。'
    case 'step_not_current':
      return 'このStepは現在のStepではありません。最新の状態を読み込み直しました。'
    case 'plan_dependency_changed':
      return 'この生産計画が前提とする目標武器または作成リストが変更されています。'
    case 'execution_state_mismatch':
      return '現在の保存状態が、このStep開始時の想定と一致しません。'
    case 'observation_required':
      return 'ゲーム画面で確認した実際の5枠を入力してください。'
    case 'observation_not_expected':
      return 'このStepでは5枠の入力は不要です。'
    case 'observation_invalid':
      return '入力した5枠は、この武器種・属性の通常アーティアとして保存できません。入力を確認してください。'
    case 'actual_result_not_applicable':
      return 'このStepには比較できる想定結果がないため、「結果が違う」として記録できません。'
    case 'actual_result_invalid':
      return '入力した実際の結果は、この武器の結果として保存できません。入力を確認してください。'
    case 'actual_result_matches_expected':
      return '入力した結果は想定結果と一致しています。「結果一致・次へ」を使用してください。'
    case 'operation_count_recovery_not_applicable':
      return 'この作成プランは、現在位置の確認で再開できる状態ではありません。'
    case 'operation_count_recovery_changed':
      return '表示後に作成プランの状態が変わったため、現在位置の確認を確定しませんでした。最新の状態を読み込み直しました。'
    case 'operation_count_recovery_observation_invalid':
      return '入力したゲームの結果が、この操作の結果として正しくありません。入力を確認してください。'
    case 'operation_count_recovery_not_unique':
      return '入力した結果から現在位置を1つに特定できないため、確定しませんでした。'
    case 'save_point_changed':
      return '表示後にゲーム内セーブ地点の記録が変わったため、操作を確定しませんでした。最新の状態を読み込み直しました。'
    case 'save_point_not_found':
      return 'ゲーム内セーブ地点の記録が見つかりません。最新の状態を読み込み直しました。'
    case 'save_point_restore_not_allowed':
      return 'この作成プランは、ゲーム内セーブ地点へ戻せる状態ではありません。'
    case 'save_point_record_not_allowed':
      return '実行中ではない作成プランでは、ゲーム内セーブ地点を記録できません。'
    case 'save_point_required_entity_missing':
    case 'save_point_snapshot_invalid':
    case 'save_point_restore_invalid':
      return SAVE_POINT_UNSAFE_MESSAGE
    case 'plan_abandon_state_changed':
      return '表示後に作成プランの状態が変わったため、破棄しませんでした。最新の状態を読み込み直しました。'
    case 'plan_abandon_not_allowed':
      return 'この作成プランは破棄できる状態ではありません。'
    case 'save_point_choice_required':
      return 'ゲーム内セーブ地点の扱いを選ぶ必要があります。最新の状態を読み込み直しました。もう一度操作してください。'
    case 'save_point_choice_not_required':
      return '表示後にゲーム内セーブ地点の状態が変わったため、破棄しませんでした。最新の状態を読み込み直しました。'
    case 'replan_preview_not_allowed':
      return '現在の生産計画からは再計画を試算できません。'
    case 'replan_state_changed':
      return '試算後に状態が変わりました。もう一度、現在地点から再計画を試算してください。'
    case 'replan_result_invalid':
    case 'replan_plan_id_collision':
      return 'この試算結果は採用できません。もう一度、現在地点から再計画を試算してください。'
    case 'running_plan_invariant_violated':
      return '実行中の生産計画が複数存在するため、操作できません。'
    case 'undo_history_not_latest':
      return '表示後に新しい操作が記録されたため、Undoしませんでした。最新の状態を読み込み直しました。'
    case 'undo_history_not_found':
      return '取り消す操作の記録が見つかりません。最新の状態を読み込み直しました。'
    case 'undo_not_allowed':
      return 'この作成プランの状態では、最後の操作を元に戻せません。'
    case 'undo_snapshot_invalid':
    case 'undo_result_invalid':
      return '操作前の状態を正しく復元できないため、Undoしませんでした。状態は変更されていません。'
    case 'compromise_finish_not_applicable':
      return 'この武器は作成リストで選んだ途中採用状態として終了できません。'
    case 'compromise_checkpoint_not_current':
      return '途中採用状態は既に通過しているため、妥協品として終了できません。'
    case 'execution_effect_inconsistent':
    case 'expected_state_after_mismatch':
    case 'collection_validation_failed':
    case 'entity_validation_failed':
      return 'Stepを確定すると保存状態の整合性が崩れるため、確定しませんでした。'
    default:
      return '操作を確定できませんでした。'
  }
}

/** Refusals whose recovery is recalculation, not a retry. */
export function isRecalculationRequiredError(code: ExecutionRuntimeErrorCode): boolean {
  return (
    code === 'execution_state_mismatch' ||
    code === 'plan_dependency_changed' ||
    code === 'calculation_context_changed' ||
    code === 'plan_not_executable'
  )
}

/**
 * The actual result input 「結果が違う」 offers for a Step
 * (`docs/UI_FLOW.md` 12.4, `docs/PLANNER_SPEC.md` 16.15), or `null` when the
 * Step has no predicted result that can differ.
 *
 * Presentation only: it mirrors the operation's result contract
 * (`docs/DATA_MODEL.md` 11.4) so the form asks for the right fields with a
 * fixed scope. The runtime still validates the kind, scope and content and
 * stays the authority that accepts or refuses the record.
 */
export type ActualResultInputKind =
  | { kind: 'restoration_bonuses'; scope: 'normal_artian' | 'gogma_artian' }
  | { kind: 'skills' }

export function actualResultInputKind(step: PlanStep): ActualResultInputKind | null {
  const effects = step.executionEffects
  if (effects === undefined) return null
  switch (step.operationType) {
    case 'create_normal_artian':
      // A blind production-target Normal predicts no five slots: its
      // observation is the result itself, never a differing one.
      return effects.observationBinding !== null ? null : { kind: 'restoration_bonuses', scope: 'normal_artian' }
    case 'reset_bonuses':
    case 'keep_bonuses':
      return { kind: 'restoration_bonuses', scope: 'gogma_artian' }
    case 'convert_normal_to_gogma':
    case 'reset_skills':
      return { kind: 'skills' }
    case 'confirm_owned_ideal':
    case 'reserve_weapon':
    case 'confirm_result':
      return null
  }
}

/**
 * Whether 「何を何回操作したか分からない」 applies: every executable game
 * operation, a blind production-target Normal included. An owned Ideal
 * confirmation involves no game operation and a legacy Step is never executed.
 */
export function offersOperationUncertain(step: PlanStep): boolean {
  if (step.executionEffects === undefined) return false
  switch (step.operationType) {
    case 'create_normal_artian':
    case 'convert_normal_to_gogma':
    case 'reset_bonuses':
    case 'keep_bonuses':
    case 'reset_skills':
      return true
    case 'confirm_owned_ideal':
    case 'reserve_weapon':
    case 'confirm_result':
      return false
  }
}

/** Where the RNG re-identification of a diverged operation happens (UI_FLOW 12.4 / 12.5). */
export type { ReidentificationDestination }

/**
 * The divergence a stale Plan stopped on, from the Plan's latest
 * ExecutionHistory (ordered by `compareExecutionHistoryOrder()` in the
 * repository). `null` whenever the latest record is not an
 * `actual_result_different` / `operation_uncertain` record of this Plan whose
 * reason the Plan still carries: a reason in `recalculationReasons` alone never
 * names the Step, so an older divergence record is never taken for the cause.
 *
 * Only `actual_result_different` names an RNG re-identification destination.
 * `operation_uncertain` is recovered inside the Execution Navigator
 * (`docs/PLANNER_SPEC.md` 16.15) and never sends the user straight to the
 * ordinary Identification.
 */
export type ExecutionDivergenceView =
  | {
      action: 'actual_result_different'
      planStepId: PlanStep['id']
      operationLabel: string
      destination: ReidentificationDestination
    }
  | {
      action: 'operation_uncertain'
      planStepId: PlanStep['id']
      operationLabel: string
    }

export function executionDivergenceView(
  plan: ProductionPlan,
  latestHistory: ExecutionHistory | null,
): ExecutionDivergenceView | null {
  if (plan.status !== 'stale' || latestHistory === null || latestHistory.planId !== plan.id) return null
  const { action } = latestHistory
  if (action !== 'actual_result_different' && action !== 'operation_uncertain') return null
  const reason = action === 'actual_result_different' ? 'unexpected_result' : 'execution_operation_uncertain'
  if (latestHistory.recalculationReason !== reason || !plan.recalculationReasons.includes(reason)) return null
  const step = plan.steps.find(({ id }) => id === latestHistory.planStepId)
  if (step === undefined) return null
  const operationLabel = planStepOperationLabels[step.operationType]
  return action === 'actual_result_different'
    ? {
        action,
        planStepId: step.id,
        operationLabel,
        destination: executionReidentificationDestination(step),
      }
    : { action, planStepId: step.id, operationLabel }
}

/** 「Step N（操作名）」 in the Plan's display order; the Step ID when it is unknown. */
export function planStepPositionLabel(plan: ProductionPlan, stepId: PlanStep['id']): string {
  const steps = orderPlanSteps(plan)
  const index = steps.findIndex(({ id }) => id === stepId)
  if (index < 0) return `Step（${stepId}）`
  return `Step ${index + 1}（${planStepOperationLabels[steps[index].operationType]}）`
}

/**
 * Where the game save point was recorded, as 「Step N完了時点」 in the Plan's
 * display order: the Step before the snapshot Plan's current Step. Derived from
 * the save point's own Plan snapshot `currentStepId` only; no Counter value.
 */
export function savePointPositionLabel(
  plan: ProductionPlan,
  savePointCurrentStepId: PlanStep['id'] | null,
): string {
  const steps = orderPlanSteps(plan)
  if (savePointCurrentStepId === null) return `Step ${steps.length}完了時点`
  const index = steps.findIndex(({ id }) => id === savePointCurrentStepId)
  if (index < 0) return '記録地点（Stepを特定できません）'
  return index === 0 ? '作成開始時点（最初の操作の前）' : `Step ${index}完了時点`
}

/** What Undo removes, in the Navigator's words (UI_FLOW 12.7). */
export function executionUndoTargetLabel(plan: ProductionPlan, history: ExecutionHistory): string {
  const step = planStepPositionLabel(plan, history.planStepId)
  switch (history.action) {
    case 'confirmed_expected':
      return `${step} の確定`
    case 'actual_result_different':
      return `${step} の「結果が違う」の記録`
    case 'operation_uncertain':
      return `${step} の「何を何回操作したか分からない」の記録`
    case 'operation_count_recovered':
      return `現在位置の確認による再開（${step}まで）`
    case 'finished_as_compromise':
      return '妥協品として確定して終了'
    case 'secured_weapon':
    case 'skipped_candidate':
      return step
  }
}

/**
 * How the Undo control introduces itself in 「実行状態の管理」
 * (`docs/UI_FLOW.md` 12.7).
 *
 * The generic wording names the last tool-side operation. A record of
 * 「何を何回操作したか分からない」 gets its own wording, because the user
 * reaches it from the recovery screen and has to recognise it as taking back
 * the record they made by mistake. It is deliberately not a bare
 * 「キャンセル」 / 「戻る」: a user whose in-game situation really is unknown
 * must not leave the recovery by mistake.
 *
 * This is presentation only. The record it applies to, its eligibility and
 * what Undo restores are the runtime's (`docs/PLANNER_SPEC.md` 16.16); nothing
 * here changes which record `undoLatestExecution()` removes.
 */
export interface ExecutionUndoControlPresentation {
  /** The short description above the button. */
  description: string
  buttonLabel: string
  dialogTitle: string
  confirmLabel: string
  /** Lines specific to this record, added to the generic Undo notice. */
  notes: readonly string[]
}

export function executionUndoControlPresentation(
  history: ExecutionHistory,
): ExecutionUndoControlPresentation {
  if (history.action === 'operation_uncertain') {
    return {
      description:
        '「何を何回操作したか分からない」を誤って記録した場合は、この記録を取り消して記録前の操作へ戻せます。実際にゲーム内の操作状況が分からない場合は取り消さず、上の現在位置の確認やゲーム内セーブ地点への復元を使用してください。',
      buttonLabel: '「操作内容不明」の記録を取り消す',
      dialogTitle: '「操作内容不明」の記録を取り消しますか？',
      confirmLabel: '記録を取り消して元の操作に戻る',
      notes: [
        '「何を何回操作したか分からない」を誤って記録し、ゲーム内の状況がツールの案内と一致している場合だけ使用してください。',
        'ゲーム内の操作状況が実際に分からない場合は取り消さず、現在位置の確認やゲーム内セーブ地点への復元を使用してください。',
      ],
    }
  }
  return {
    description: '最後に確定した記録をツール上だけ取り消します。ゲーム内の操作は戻りません。',
    buttonLabel: '最後の操作をUndo',
    dialogTitle: '最後のツール上の操作を元に戻します',
    confirmLabel: 'Undoする',
    notes: [],
  }
}
