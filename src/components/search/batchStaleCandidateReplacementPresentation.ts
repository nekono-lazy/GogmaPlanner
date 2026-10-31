import type {
  BuildListResearchExclusion,
  BuildListResearchExclusionReason,
} from '../../domain/buildList'
import type { TargetWeaponPlanningIneligibilityCause } from '../../domain/models/domainRules'
import type { BatchCandidateResearchRefusalReason } from '../../services/search/batchStaleCandidateReplacement'

/*
 * 「再検索が必要な候補を一括再検索・置換」 on the Search screen (`docs/UI_FLOW.md` 9.3,
 * Issue #347). Presentation only: which Targets are re-searched and why one is
 * left alone is the Domain's selection (`selectBuildListResearchTargets()`), and
 * whether a found Candidate replaced the stale Entry is the batch's outcome.
 * Nothing here judges staleness, Plan dependence or a replacement.
 */

export function batchResearchButtonLabel(count: number): string {
  return `再検索が必要な候補を一括再検索・置換（${count}件）`
}

/** Neither a Target to re-search nor an excluded one: the only case that reads as "nothing to re-search". */
export const BATCH_RESEARCH_NONE_NOTE = '再検索が必要な作成リストの候補はありません。'

/** Stale candidates exist, but every one is excluded: the batch cannot start, and the reasons are listed below. */
export function batchResearchExcludedOnlyNote(excludedCount: number): string {
  return `再検索が必要な候補が${excludedCount}件ありますが、いずれも一括再検索・置換の対象外のため、一括処理は開始できません。対象外の理由は下の一覧で確認できます。`
}

/** Both counts, told apart, when some stale candidates are re-searched and others are excluded. */
export function batchResearchCountsNote(targetCount: number, excludedCount: number): string {
  return `再検索が必要な候補${targetCount + excludedCount}件のうち、${targetCount}件を一括再検索・置換の対象とし、${excludedCount}件は対象外です。対象外の理由は下の一覧で確認できます。`
}

/** The read-only disclosure of the excluded candidates on the Search screen, shown whenever any is excluded. */
export function batchResearchExcludedDisclosureTitle(excludedCount: number): string {
  return `一括再検索・置換の対象外の候補（${excludedCount}件）`
}

export const BATCH_RESEARCH_DESCRIPTION =
  '一括再検索・置換では、作成リストで「再検索が必要」になっている候補の目標武器を、現在の作成ルートと探索量の上限で1件ずつ順に検索し直します。完成条件を満たす候補が見つかった目標武器だけ、作成リストの候補を新しい候補へ置き換えます。'

/** The selection could not be read: the batch is withheld, never offered as "nothing to re-search". */
export const BATCH_RESEARCH_SELECTION_READ_FAILED =
  '再検索が必要な候補を確認できなかったため、一括再検索・置換は使えません。'

export const BATCH_RESEARCH_DIALOG_TITLE = '再検索が必要な候補を一括再検索・置換しますか？'

export function batchResearchDialogLead(count: number): string {
  return `作成リストで再検索が必要になっている${count}件の目標武器を、現在の検索条件で1件ずつ順に検索し直します。`
}

export const BATCH_RESEARCH_DIALOG_KEEP_NOTE =
  '元の候補は、新しい候補が見つかった目標武器だけ置き換えます。候補が見つからなかった目標武器、検索に失敗した目標武器、途中でキャンセルして処理しなかった目標武器の候補は、そのまま作成リストに残ります。'

export const BATCH_RESEARCH_DIALOG_EXCLUSION_NOTE =
  '置き換えに実行中の生産計画の破棄の確認が必要な候補は、一括処理では置き換えません。単体検索の「ビルドリストへ追加」から個別に置き換えてください。'

export const BATCH_RESEARCH_DIALOG_TARGETS_HEADING = '再検索する目標武器'

export function batchResearchDialogExcludedHeading(count: number): string {
  return `再検索しない候補（${count}件）`
}

export const BATCH_RESEARCH_DIALOG_CONFIRM_LABEL = '一括再検索・置換を開始'

export const BATCH_RESEARCH_PROGRESS_TITLE = '一括再検索・置換中'
export const BATCH_RESEARCH_CANCEL_LABEL = '一括再検索をキャンセル'
export const BATCH_RESEARCH_SUMMARY_TITLE = '一括再検索・置換の結果'
export const BATCH_RESEARCH_SUMMARY_COUNTS_LABEL = '一括再検索・置換の件数'

/** The name an Entry whose Target no longer exists is listed under; no ID is shown in the ordinary UI. */
export const BATCH_RESEARCH_UNNAMED_TARGET = '削除済みの目標武器'

/** Why the single search could not search the Target either (the Domain's cause; nothing is judged here). */
function targetNotSearchableLabel(cause: TargetWeaponPlanningIneligibilityCause): string {
  switch (cause) {
    case 'completed':
      return '完了済みの目標武器のため検索しません。候補が不要であれば作成リストで削除してください。'
    case 'disabled':
      return '検索対象OFFの目標武器のため検索しません。'
    case 'review_required':
      return '完成条件の再設定が必要な目標武器のため検索できません。目標武器画面で内容を確認して保存してください。'
  }
}

export function batchResearchExclusionReasonLabel(reason: BuildListResearchExclusionReason): string {
  switch (reason.kind) {
    case 'target_not_found':
      return '目標武器が存在しないため検索できません。作成リストで候補を整理してください。'
    case 'target_not_searchable':
      return targetNotSearchableLabel(reason.cause)
    case 'legacy_duplicate':
      return '作成リストに複数の候補が登録されているため置き換えません。作成リストで候補を1件に整理してください。'
    case 'active_plan_dependent':
      return '実行中の生産計画がこの候補を使用しています。置き換えには生産計画の破棄の確認が必要なため、単体検索から個別に操作してください。'
  }
}

/** The name an exclusion is listed under: the Target's, or the fixed label of a missing Target. */
export function batchResearchExclusionName(exclusion: Pick<BuildListResearchExclusion, 'target'>): string {
  return exclusion.target?.name ?? BATCH_RESEARCH_UNNAMED_TARGET
}

/** Why a found Candidate did not replace the stale Entry, which is still registered. */
export const batchResearchRefusalReasonLabels: Record<BatchCandidateResearchRefusalReason, string> = {
  plan_approval_required:
    '実行中の生産計画がこの候補を使用しているため、置き換えませんでした。置き換えには生産計画の破棄の確認が必要です。単体検索から個別に操作してください。',
  target_not_found: '目標武器が存在しなくなったため、置き換えませんでした。',
  replacement_target_changed:
    '検索の間に作成リストのこの目標武器の候補が変わっていたため、置き換えませんでした。作成リストを確認してください。',
  legacy_duplicate_entries:
    '作成リストにこの目標武器の候補が複数登録されているため、置き換えませんでした。作成リストで候補を1件に整理してください。',
  target_completed: '検索の間にこの目標武器が完了済みになったため、置き換えませんでした。',
  target_disabled: '検索の間にこの目標武器が検索対象OFFになったため、置き換えませんでした。',
  target_review_required:
    '検索の間にこの目標武器の完成条件の再設定が必要になったため、置き換えませんでした。目標武器画面で内容を確認して保存してください。',
  entry_no_longer_stale: '検索の間にこの候補の再検索が不要になっていたため、置き換えませんでした。',
  candidate_not_current:
    '検索の後にRNG状態・所持武器・目標武器が変わったため、検索結果を登録しませんでした。もう一度検索してください。',
}

export const BATCH_RESEARCH_KEPT_NOTE = '元の候補はそのまま作成リストに残っています。'
