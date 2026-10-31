import type { ProductionPlanExecutionContractBlock } from '../../domain/execution'

/**
 * Why 「最後のゲーム内セーブ地点へ戻す」 cannot run for this Plan (Issue #335,
 * `docs/UI_FLOW.md` 12.8 / 16.2), in the user's words. The reason is the typed
 * one the Domain read-only judgement returned; no message text is parsed.
 */
export function savePointRestoreUnavailableMessage(reason: ProductionPlanExecutionContractBlock): string {
  switch (reason) {
    case 'calculation_context_changed':
      return 'この生産計画は現在の計算契約と互換性がないため、ゲーム内セーブ地点へ戻すことはできません。'
    case 'plan_not_executable':
      return 'この生産計画は現在の実行形式ではないため、ゲーム内セーブ地点へ戻すことはできません。'
  }
}

/** What the user can still do in each 16.2 choice, once the restore is unavailable. */
export const SAVE_POINT_RESTORE_UNAVAILABLE_GUIDANCE = {
  replanAdoption: '現在地点を維持して再計画を採用するか、キャンセルしてください。',
  abandonment: '現在地点を維持して作成プランを破棄するか、キャンセルしてください。',
  breakingChange: '現在地点を維持して変更を保存するか、キャンセルしてください。',
} as const

/** The `operation_uncertain` recovery's way on when the restore is unavailable (`docs/UI_FLOW.md` 12.5 / 12.8). */
export const SAVE_POINT_RESTORE_UNAVAILABLE_RECOVERY_GUIDANCE =
  '下の「実行状態の管理」の「現在Planを破棄する」で、現在地点を維持して作成プランを破棄してください。'

/**
 * A recorded save point whose ExecutionHistory boundary is missing or foreign (`invalid`): the restore - and every Plan-ending
 * action that derives the 16.10 choice - refuses it (`save_point_snapshot_invalid`), so it is never offered.
 */
export const SAVE_POINT_RESTORE_INVALID_MESSAGE =
  '記録されたゲーム内セーブ地点の情報が不正なため、このセーブ地点へ戻すことはできません。'