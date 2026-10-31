/**
 * The words of the guidance around the running Plan replan (`docs/UI_FLOW.md` 9 / 10 / 16.3 / 16.5, `docs/PLANNER_SPEC.md` 18.3,
 * Issue #276 PR-6B): the proposal right after a Build List addition, the Build List's passive count, the Plan-in-use stale Entry
 * guidance and the breaking-change warning's exclusion guidance. Text only: which Targets a proposal or a count names, which Entry is
 * in use and whether a Target can be excluded are the Domain derivations' answers, never judged here.
 */

/** A Target the screen cannot name any more (deleted meanwhile, or never loaded): never an internal ID. */
export const RUNNING_PLAN_REPLAN_UNNAMED_TARGET = '名前を確認できない目標武器'

export const RUNNING_PLAN_REPLAN_PROPOSAL_TITLE = '現在地点からの再計画で取り込めます'
export const RUNNING_PLAN_REPLAN_PROPOSAL_OPEN_LABEL = '再計画を開く'
export const RUNNING_PLAN_REPLAN_PROPOSAL_DISMISS_LABEL = '閉じる'
export const RUNNING_PLAN_REPLAN_PROPOSAL_ACTION_NOTE =
  '現在地点から再計画すると、実行中の生産計画に取り込めます。開いても自動では試算しません。'

/** The proposal's first sentence: one Target by name, several by count (the names follow as a list). */
export function runningPlanReplanProposalLead(names: readonly string[]): string {
  return names.length === 1
    ? `「${names[0]}」は実行中の生産計画では作成されません。`
    : `追加した目標武器のうち${names.length}件は、実行中の生産計画では作成されません。`
}

/** The Build List's passive sentence (18.3): distinct Targets, never Entries. Nothing is said for none. */
export function runningPlanReplanAdditionalCandidateCountText(count: number): string | null {
  return count > 0 ? `作成リストに候補があり、実行中の生産計画では作らない目標武器が${count}件あります。` : null
}

/** An Entry the `active` Plan keeps using whose staleness its planned progress alone caused (18.3, UI_FLOW 16.5). */
export const RUNNING_PLAN_IN_USE_STALE_TITLE = '実行中の生産計画で使用中'
export const RUNNING_PLAN_IN_USE_STALE_REASONS_LABEL = '候補を検索したときから変わったもの'
export const RUNNING_PLAN_IN_USE_STALE_LINES: readonly string[] = [
  '計画どおりに進めたため、候補を検索したときの状態と現在の状態が異なっています。ただし、実行中の生産計画はそのまま続けられます。',
  '作る目標武器を変更したい場合は「現在地点からの再計画」を利用してください。',
]
export const RUNNING_PLAN_IN_USE_STALE_GROUP_CHIP = '実行中の生産計画で使用中'

/** The breaking-change warning's exclusion guidance (16.3 / 18.3): an alternative to the change, never a reading of it. */
export const PLAN_BREAKING_REPLAN_EXCLUSION_TITLE = 'この目標武器を今回作らないだけの場合'
export const PLAN_BREAKING_REPLAN_EXCLUSION_TEXT =
  'この目標武器を今回の生産計画で作らないだけなら、変更を保存せずに「現在地点からの再計画」で除外できます。'
export const PLAN_BREAKING_REPLAN_EXCLUSION_LABEL = '保存せずに再計画を開く'

/** Opening the replan from a proposal or a warning: what the Build List says when it could not, or narrowed the initial choice. */
export const RUNNING_PLAN_REPLAN_REQUEST_NO_RUNNING_PLAN_MESSAGE =
  '実行中の生産計画が無いため、再計画は開いていません。'
export function runningPlanReplanInitialSelectionDroppedMessage(count: number): string {
  return `開いたときに選ばれていた目標武器のうち${count}件は、現在の状態では選べないため選択していません。`
}
