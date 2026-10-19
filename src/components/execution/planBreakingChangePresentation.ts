import { RepositoryError } from '../../db/repositoryError'
import {
  ExecutionRuntimeError,
  type PlanBreakingChangeInspection,
  type PlanBreakingReason,
} from '../../domain/execution'
import { executionErrorMessage, SAVE_POINT_UNSAFE_MESSAGE } from './executionStepPresentation'

/** The inspection of a change that needs the breaking-change approval. */
export type PlanBreakingChangeRequiredInspection = Extract<PlanBreakingChangeInspection, { approvalRequired: true }>

/**
 * The warning's own words (`docs/UI_FLOW.md` 16.3). What the change breaks is
 * listed from `inspection.reasons` alone; the screen never adds a reason of
 * its own.
 */
export const PLAN_BREAKING_WARNING_TITLE = '実行中の生産計画があります'
export const PLAN_BREAKING_WARNING_LINES: readonly string[] = [
  'この変更を保存すると、現在の生産計画は続行できなくなります。',
  '変更を保存すると、この生産計画は破棄されます。',
]
export const PLAN_BREAKING_REASONS_HEADING = 'この変更で変わるもの'
export const PLAN_BREAKING_APPROVE_LABEL = '生産計画を破棄して保存'
/**
 * Ending the Plan itself changes no Target preference (`docs/PLANNER_SPEC.md`
 * 16.6: the preference changes only through the change being saved and its
 * existing CRUD side effects), so the note asserts neither that the link
 * survives nor that it is released.
 */
export const PLAN_BREAKING_NOT_UNDOABLE_NOTE =
  '破棄した生産計画は元に戻せません。作成途中の武器の「作成中」は解除されます。生産計画を破棄すること自体では優先起点を変更しませんが、今回保存する変更によって優先起点が変更・解除される場合があります。'

/** The transient warning reasons, in the user's words (`docs/PLANNER_SPEC.md` 16.6). */
export const planBreakingReasonLabels: Record<PlanBreakingReason, string> = {
  rng_state_changed: 'RNG状態が変わります',
  normal_counter_changed: '通常アーティアカウンターが変わります',
  owned_weapon_changed: '生産計画が使用する所持武器の状態が変わります',
  target_changed: '生産計画が使用する目標武器の条件または状態が変わります',
  build_list_changed: '生産計画が使用する作成リスト項目が変わります',
}

/** The 16.10 save point choice, asked only where the inspection says so (`docs/UI_FLOW.md` 16.2). */
export const PLAN_BREAKING_SAVE_POINT_CHOICE_MESSAGE =
  'この生産計画は、最後のゲーム内セーブ地点より先まで進んでいます。ゲーム側の状態に合わせて選んでください。'
export const PLAN_BREAKING_SAVE_POINT_CHOICE_EXPLANATION =
  '「現在地点を維持」は現在のアプリ状態へ変更を保存します。「最後のゲーム内セーブ地点へ戻す」はアプリ側をセーブ地点へ戻してから変更を保存します。どちらも生産計画は破棄されます。'
export const PLAN_BREAKING_RESTORE_NOTE =
  'セーブ地点へ戻した後、この変更を保存し、生産計画を破棄します。復元・保存・破棄は一度に行われ、途中で止まることはありません。'

/** Where the save point sits when the exact Step cannot be resolved on this screen. */
export const PLAN_BREAKING_SAVE_POINT_FALLBACK_LABEL = '最後のゲーム内セーブ地点'

export const PLAN_GUARDED_BUSY_MESSAGE = '別の変更を確認中です。完了してからもう一度操作してください。'

const STATE_CHANGED_MESSAGE =
  '確認後に生産計画の状態が変わったため、変更を保存していません。もう一度保存してください。'
const APPROVAL_NOT_REQUIRED_MESSAGE =
  '確認後に状態が変わったため、変更を保存していません。もう一度保存してください。'
const RUNNING_PLAN_INVARIANT_MESSAGE =
  '実行中の生産計画が複数存在するため保存できません。生産計画の状態を確認してください。'
const SAVE_POINT_CHOICE_CHANGED_MESSAGE =
  '確認後にゲーム内セーブ地点の状態が変わったため、変更を保存していません。もう一度保存してください。'
const SAVE_POINT_CONTEXT_MESSAGE =
  'ゲーム内セーブ地点は現在の計算契約と互換性がないため戻せません。変更を保存していません。'
const TRANSACTION_FAILED_MESSAGE = '保存に失敗しました。状態は変更されていません。再試行してください。'

/**
 * A guarded save the runtime refused, or a storage failure of it, in the
 * user's words. `null` means the error is the change's own (a validation
 * issue, a reference protection): the screen reports it as it always did.
 * Typed codes are the only authority; no message text is parsed.
 */
export function planGuardedRefusalMessage(caught: unknown): string | null {
  if (caught instanceof ExecutionRuntimeError) {
    switch (caught.code) {
      case 'plan_breaking_change_state_changed':
        return STATE_CHANGED_MESSAGE
      case 'plan_breaking_change_approval_not_required':
        return APPROVAL_NOT_REQUIRED_MESSAGE
      case 'running_plan_invariant_violated':
        return RUNNING_PLAN_INVARIANT_MESSAGE
      case 'save_point_choice_required':
      case 'save_point_choice_not_required':
      case 'save_point_changed':
      case 'save_point_not_found':
        return SAVE_POINT_CHOICE_CHANGED_MESSAGE
      case 'save_point_required_entity_missing':
      case 'save_point_snapshot_invalid':
      case 'save_point_restore_invalid':
        return SAVE_POINT_UNSAFE_MESSAGE
      case 'calculation_context_changed':
        return SAVE_POINT_CONTEXT_MESSAGE
      case 'plan_breaking_change_approval_required':
        // Promoted to the warning by the controller; never shown as an error.
        return caught.message
      default:
        return executionErrorMessage(caught.code)
    }
  }
  if (caught instanceof RepositoryError && caught.code === 'transaction_failed') {
    return TRANSACTION_FAILED_MESSAGE
  }
  return null
}

export function formatSavePointRecordedAt(recordedAt: string): string {
  const date = new Date(recordedAt)
  return Number.isNaN(date.getTime()) ? recordedAt : date.toLocaleString('ja-JP')
}
