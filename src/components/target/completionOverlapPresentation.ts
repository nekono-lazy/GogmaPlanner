import type { TargetCompletionOverlap } from '../../domain/target'

/**
 * The Japanese wording of the completion condition overlap confirmation
 * (Issue #338, `docs/UI_FLOW.md` 8.5). Display only: which Targets are listed
 * and how each relates is decided by the Domain classification alone.
 */

export const COMPLETION_OVERLAP_TITLE = '完成条件が重なる目標武器があります'
export const COMPLETION_OVERLAP_LEAD = '同じ1本の武器で完成条件を満たせる、登録済みの目標武器があります。'
export const COMPLETION_OVERLAP_LIST_LABEL = '完成条件が重なる目標武器'
export const COMPLETION_OVERLAP_BACK_LABEL = '編集へ戻る'

/** The mode of the save the confirmation guards: a new Target or an edit of a stored one. */
export type CompletionOverlapSaveMode = 'new' | 'edit'

/** 「登録すると、それぞれ別の武器を作ります。…」 (`docs/UI_FLOW.md` 8.5); an edit says 保存すると. */
export function completionOverlapSeparateWeaponNote(mode: CompletionOverlapSaveMode): string {
  return `${mode === 'new' ? '登録すると' : '保存すると'}、それぞれ別の武器を作ります。1本の武器で両方の目標武器を完了にすることはありません。`
}

/** 「別の1本として登録する」 / 「別の1本として保存する」. */
export function completionOverlapContinueLabel(mode: CompletionOverlapSaveMode): string {
  return mode === 'new' ? '別の1本として登録する' : '別の1本として保存する'
}

/** The relation in words; `overlapping` is never called a duplicate (`docs/UI_FLOW.md` 8.5). */
export const completionOverlapLabels: Record<Exclude<TargetCompletionOverlap, 'disjoint'>, string> = {
  identical: '完成条件が同じ',
  overlapping: '一部の完成武器で条件が重なる',
}

export const COMPLETION_OVERLAP_DISABLED_LABEL = '検索対象OFF'
export const COMPLETION_OVERLAP_REVIEW_LABEL = '完成条件の再設定が必要'

/** The list's own count line, e.g. 「2件」. */
export function completionOverlapCountText(count: number): string {
  return `${count}件`
}
