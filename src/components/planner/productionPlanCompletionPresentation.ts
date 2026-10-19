import type { ProductionPlanStatus, RejectedBuildListEntry } from '../../domain/models/publicTypes'
import type {
  ProductionPlanCompletionRatioUndeterminableReason,
  ProductionPlanCompletionSummary,
} from '../../domain/planner/productionPlanCompletionSummary'
import {
  rejectedBuildListEntryReasonLabels,
  rejectedBuildListEntryResourceConflictCauseLabels,
} from '../../presentation/labels'

/** A rejected Entry whose persisted reason or cause has no label: said as unknown, never guessed. */
export const UNKNOWN_REJECTED_REASON_LABEL = '採用されなかった理由を確認できません'

/**
 * The label of one persisted rejection (「採用されなかった候補」, `docs/UI_FLOW.md`
 * 11.0 / 11.6.5). A `resource_conflict` record with a recorded cause is said by
 * its cause, so a stuck drop is never called a resource conflict; a record
 * without a cause (saved before it was recorded) keeps its reason label, and
 * an unknown literal reads as unknown.
 */
export function rejectedBuildListEntryLabel(record: RejectedBuildListEntry): string {
  if (record.reason === 'resource_conflict' && record.resourceConflictCause !== undefined) {
    return (
      (rejectedBuildListEntryResourceConflictCauseLabels as Partial<Record<string, string>>)[record.resourceConflictCause] ??
      UNKNOWN_REJECTED_REASON_LABEL
    )
  }
  return (rejectedBuildListEntryReasonLabels as Partial<Record<string, string>>)[record.reason] ?? UNKNOWN_REJECTED_REASON_LABEL
}

/**
 * The words of the Plan overview's 「完成予定の目標武器数」 (Issue #121,
 * `docs/UI_FLOW.md` 11.0) over the shared Domain summary
 * (`summarizeProductionPlanCompletion()`, `docs/PLANNER_SPEC.md` 9.6.9.1).
 * Presentation only: every number comes from the summary, and nothing is
 * counted, guessed or read from the current Build List here.
 */

function count(value: number): string {
  return value.toLocaleString('ja-JP')
}

export interface PlanCompletionFigure {
  /** The visible value: `N / (N + M)本`, `0本`, `N本` or the legacy unknown. */
  value: string
  numeric: boolean
  /**
   * What a screen reader reads instead of a `/` ratio, so the meaning of each
   * side is said in words; `null` when the value reads well as it is.
   */
  accessibleValue: string | null
  /** The line under the value inside the figure, `暫定・` first when provisional. */
  detail: string | null
}

export function planCompletionFigure(summary: ProductionPlanCompletionSummary): PlanCompletionFigure {
  if (summary.status === 'completion_unknown') {
    return { value: '不明（旧形式の計画）', numeric: false, accessibleValue: null, detail: null }
  }
  // Provisional is said in text, never by colour alone.
  const provisional = summary.isProvisional ? '暫定・' : ''
  const completed = summary.completedCount
  if (summary.status === 'ratio_undeterminable') {
    return {
      value: `${count(completed)}本`,
      numeric: true,
      accessibleValue: null,
      detail: `${provisional}競合による未完成数：確認できません`,
    }
  }
  const notCreated = summary.conflictNotCreatedCount
  const total = completed + notCreated
  if (total === 0) {
    return { value: '0本', numeric: true, accessibleValue: null, detail: `${provisional}競合のため作成しない目標武器はありません` }
  }
  return {
    value: `${count(completed)} / ${count(total)}本`,
    numeric: true,
    accessibleValue: notCreated > 0
      ? `完成予定${count(completed)}本、競合のため今回作成しない${count(notCreated)}本を含めて合計${count(total)}本`
      : `完成予定${count(completed)}本、合計${count(total)}本`,
    detail: notCreated > 0
      ? `${provisional}競合のため今回作成しない${count(notCreated)}本を含む`
      : `${provisional}競合のため作成しない目標武器はありません`,
  }
}

export const PLAN_COMPLETION_DENOMINATOR_EXPLANATION =
  '完成予定の目標武器数の「/」の右側は、完成予定の本数と、競合のため今回作成しない本数の合計です。' +
  '作成リストの登録数ではなく、計画の対象外だった候補（staleな候補、完了済み・無効の目標武器の候補など）や、' +
  '競合以外の理由（計画の途中で作成手順を進められなくなった場合を含む）で作成しない目標武器は含みません。'

/** Why the overview shows `N本` only, by the typed reason (`docs/UI_FLOW.md` 11.0). */
export function planCompletionUndeterminableText(
  reason: ProductionPlanCompletionRatioUndeterminableReason,
  planStatus: ProductionPlanStatus,
): string {
  switch (reason) {
    case 'calculation_version_unsupported':
      return 'この計画は以前の計算方式で作成されたため、競合のため作成しない目標武器の数を確認できません。'
    case 'rejection_details_not_recorded':
      return 'この計画は、競合のため作成しない目標武器とその原因を記録する前に保存されたため、その数を確認できません。' +
        (planStatus === 'draft' ? '作成リスト画面から生産計画を作り直すと確認できます。' : '')
    case 'conflict_cause_not_established':
      return '計画の途中で作成手順が行き詰まったため作成しない目標武器があり、ほかの目標武器との競合によるものか確認できないため、' +
        '競合のため作成しない目標武器の数を確認できません。'
    case 'unknown_rejection_reason':
      return '採用されなかった理由を確認できない候補があるため、競合のため作成しない目標武器の数を確認できません。'
  }
}

/**
 * The paragraph under the overview figures: what the `/` ratio counts, or why
 * no ratio is shown. `null` for a legacy Plan and for `0本`, which has no `/`.
 */
export function planCompletionExplanation(
  summary: ProductionPlanCompletionSummary,
  planStatus: ProductionPlanStatus,
): string | null {
  switch (summary.status) {
    case 'completion_unknown':
      return null
    case 'ratio_undeterminable':
      return planCompletionUndeterminableText(summary.reason, planStatus)
    case 'ratio_determined':
      return summary.completedCount + summary.conflictNotCreatedCount === 0
        ? null
        : PLAN_COMPLETION_DENOMINATOR_EXPLANATION
  }
}

/**
 * The overview note shown while the Plan records any Conflict
 * (`docs/UI_FLOW.md` 11.0): the Conflict count is a record count, never a
 * number of Targets; how many Targets the conflicts leave out when the
 * records tell it, never a guessed number otherwise; and, while a Conflict has
 * no decision, that the planned completions include the Planner's provisional
 * outcome rather than a choice the user made.
 *
 * `conflictPreferenceAvailable` is a draft whose CalculationContext is
 * compatible: a participant can still be preferred there, so the result may
 * change.
 */
export function planConflictNote(
  summary: ProductionPlanCompletionSummary,
  conflictCount: number,
  conflictPreferenceAvailable: boolean,
): string {
  const sentences = [
    `この計画には競合が${count(conflictCount)}件記録されています。`,
    '件数は競合の記録数で、作成できない目標武器の数ではありません。',
  ]
  if (summary.status === 'ratio_determined') {
    sentences.push(summary.conflictNotCreatedCount > 0
      ? `競合のため、この計画では${count(summary.conflictNotCreatedCount)}本の目標武器を作成しません（競合の件数と同じ数になるとは限りません）。`
      : '競合のため作成しない目標武器はありません。')
  } else {
    sentences.push('競合の扱いによっては、この計画では完成しない目標武器がある場合があります。')
  }
  if (summary.isProvisional && summary.status !== 'completion_unknown') {
    sentences.push(conflictPreferenceAvailable
      ? '未選択の競合があるため、完成予定数は暫定的な結果です。「競合と解決」で優先する候補を選ぶと変わる場合があります。'
      : '未選択の競合は、計画を作成したときにPlannerが暫定的に作成する候補を決めた結果です（優先する候補をユーザーが選んだ結果ではありません）。')
  }
  sentences.push('「完成予定の目標武器数」と、競合の内容を確認してください。')
  return sentences.join('')
}
