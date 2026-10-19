import type { BuildListEntryId } from '../../domain/models/publicTypes'
import type {
  PlannerConflictDecisionNotCarriedReason,
  PlannerConflictDecisionRefusal,
  PlannerConflictDecisionSetResult,
  PlannerConflictDecisionSupersededReason,
  PlannerConflictResolutionOutcome,
  PlannerPreferredEntryIncompleteCause,
} from '../../domain/planner'
import { RepositoryError } from '../../db/repositoryError'
import { ExecutionRuntimeError } from '../../domain/execution'

/**
 * The Japanese of the Production Plan screen's 「この候補を優先」 (Issue #278,
 * `docs/UI_FLOW.md` 11.6.6, `docs/PLANNER_SPEC.md` 9.6.3 / 9.6.6). Every text is
 * chosen by a typed reason - a Domain refusal, an incomplete cause or a typed
 * save error code - and names Entries only through the caller's `nameOf`
 * (current Build List Entry -> current Target name). No internal ID, English
 * reason or Counter value is shown, and no message is parsed.
 */

/** Resolves a Build List Entry to the display name of its current Target. */
export type ConflictPreferenceEntryName = (buildListEntryId: BuildListEntryId) => string

/** The name used when a participant's Entry or Target cannot be read (`docs/UI_FLOW.md` 11.6.3). */
export const UNRESOLVED_CONFLICT_PARTICIPANT_NAME = '目標武器を確認できない候補'

export interface ConflictPreferenceNotice {
  title: string
  messages: string[]
}

const UNCHANGED = '表示中の生産計画は変更していません。'
const NEXT_STEPS =
  '優先する候補を選び直すか、作成リストで候補（途中採用する状態を含む）を見直してください。作成リスト画面の「生産計画を作成」から作り直すこともできます。'

function joinNames(names: readonly string[]): string {
  return names.map((name) => `「${name}」`).join('、')
}

/** The static explanation beside 「この候補を優先」 (11.6.6): what preferring this participant means. */
export function conflictPreferenceExplanation(otherParticipantNames: readonly string[]): string {
  return otherParticipantNames.length === 0
    ? 'この候補を優先すると、この競合の他の候補は今回の生産計画では作成しません。作成リストの候補は残ります。'
    : `この候補を優先すると、${joinNames(otherParticipantNames)}は今回の生産計画では作成しません。作成リストの候補は残ります。`
}

/** Why the press could not start (9.6.3 rules 1, 5, 6), in the user's words. */
export function presentConflictDecisionRefusal(
  refusal: PlannerConflictDecisionRefusal,
  nameOf: ConflictPreferenceEntryName,
): ConflictPreferenceNotice {
  switch (refusal.reason) {
    case 'plan_not_editable':
      return {
        title: 'この生産計画では優先する候補を変更できません',
        messages: ['未開始で、現在の計算方式と互換性のある生産計画だけが変更できます。', UNCHANGED],
      }
    case 'conflict_not_current':
    case 'entry_not_participant':
    case 'entry_not_valid':
      return {
        title: '現在の状態が変化したため、この候補を優先できませんでした',
        messages: ['作成リスト・目標武器・状態のいずれかが変わり、この競合または候補が現在の入力にありません。', UNCHANGED],
      }
    case 'checkpoint_conflict':
      return {
        title: 'この競合には途中採用する状態の選択が関係しています',
        messages: ['作成リストで途中採用する状態を変更または解除してください。', UNCHANGED],
      }
    case 'inconsistent_decision_set':
      return {
        title: '以前の選択どうしが矛盾しているため、計算を開始しませんでした',
        messages: [
          `${joinNames([nameOf(refusal.buildListEntryId)])}が、ある競合では優先され、別の競合では作成しない候補として記録されています。`,
          '作成リスト画面の「生産計画を作成」から作り直してください。',
          UNCHANGED,
        ],
      }
    case 'preferred_entries_conflict':
      return {
        title: '優先した候補どうしが両立しないため、計算を開始しませんでした',
        messages: [
          `優先した${joinNames(refusal.buildListEntryIds.map(nameOf))}は、まだ選んでいない競合で両立しません。先にその競合でどちらを優先するか選んでください。`,
          UNCHANGED,
        ],
      }
  }
}

const notCarriedReasonText: Record<PlannerConflictDecisionNotCarriedReason, string> = {
  conflict_not_current: '現在の入力にその競合がありません',
  entry_not_participant: 'その候補が現在の競合に含まれていません',
  entry_not_valid: 'その候補が現在の計画対象から外れています',
  checkpoint_conflict: '途中採用する状態の選択が関係するようになりました',
}

const supersededReasonText: Record<PlannerConflictDecisionSupersededReason, string> = {
  selected_entry_not_preferred: '今回の選択で、その候補は作成しない候補になります',
  preferred_entry_was_excluded: '今回優先する候補を、その選択では作成しない候補にしていました',
  checkpoint_participant_restored: '途中採用する状態の選択が関係するようになりました',
}

export interface ConflictPreferenceConfirmation {
  superseded: string[]
  notCarriedOver: string[]
}

/** What the confirmation dialog of 9.6.3 rule 7 lists: every earlier decision that is dropped, with why. */
export function presentConflictDecisionConfirmation(
  result: Extract<PlannerConflictDecisionSetResult, { status: 'ready' }>,
  nameOf: ConflictPreferenceEntryName,
): ConflictPreferenceConfirmation {
  return {
    superseded: result.superseded.map(({ resolution, reason }) =>
      `以前の選択「${nameOf(resolution.selectedBuildListEntryId)}を優先」を取り消します（${supersededReasonText[reason]}）。`),
    notCarriedOver: result.notCarriedOver.map(({ resolution, reason }) =>
      `以前の選択「${nameOf(resolution.selectedBuildListEntryId)}を優先」は引き継ぎません（${notCarriedReasonText[reason]}）。`),
  }
}

function incompleteCauseText(
  cause: PlannerPreferredEntryIncompleteCause,
  nameOf: ConflictPreferenceEntryName,
): string {
  switch (cause.kind) {
    case 'preferred_entries_conflict':
      return `優先した${joinNames([nameOf(cause.otherBuildListEntryId)])}と競合するため、両方は作成できません。`
    case 'deadlock_or_stall':
      return '計画の途中で手順が行き詰まり、作成を続けられませんでした。'
    case 'execution_precondition_failed':
      return '実行の前提（抽選位置や所持武器の状態など）が満たせなくなりました。'
    case 'checkpoint_not_reached':
      return '選択した途中採用する状態に届きません。'
    case 'satisfied_by_other_entry':
      return '別の候補の武器でこの目標武器の条件を満たすため、この候補では作成しません。'
    case 'inconsistent_completion_record':
    case 'unknown':
      return '完成できません。'
  }
}

/** Why the result was not saved: a preferred Entry is not completed (9.6.6). */
export function presentPreferredEntriesIncomplete(
  outcome: PlannerConflictResolutionOutcome,
  nameOf: ConflictPreferenceEntryName,
): ConflictPreferenceNotice {
  const incomplete = outcome.preferredEntries.flatMap((entry) =>
    entry.status === 'incomplete' ? [entry] : [])
  return {
    title: `優先した${joinNames(incomplete.map(({ buildListEntryId }) => nameOf(buildListEntryId)))}は、この選択では完成できないため、生産計画を保存していません`,
    messages: [
      ...incomplete.map(({ buildListEntryId, cause }) =>
        `${nameOf(buildListEntryId)}: ${incompleteCauseText(cause, nameOf)}`),
      NEXT_STEPS,
      UNCHANGED,
    ],
  }
}

/** The result carries no completion judgement at all: fail closed (9.6.6). */
export const conflictPreferenceOutcomeMissingNotice: ConflictPreferenceNotice = {
  title: '優先した候補が完成するか確認できないため、生産計画を保存していません',
  messages: [NEXT_STEPS, UNCHANGED],
}

/** The run reached its derived `maxPlanSteps` (`docs/UI_FLOW.md` 11.4, unchanged). */
export function conflictPreferenceIncompleteRunMessage(maxPlanSteps: number): string {
  return `競合解決の再計算が最大計画ステップ数 ${maxPlanSteps.toLocaleString('ja-JP')} に到達したため、完成した生産計画を作成できませんでした。この上限は表示中の生産計画のステップ数から自動で決まります。ビルドリスト画面から生産計画を作り直してください。`
}

export const conflictPreferenceNoPlanMessage =
  'この選択では生産計画を作成できませんでした。表示中の生産計画は変更していません。'

export const conflictPreferenceInvalidResolutionMessage =
  '選択した競合候補を現在の状態では優先できませんでした。表示中の生産計画は変更していません。選び直すか、作成リスト画面から生産計画を作り直してください。'

/** A refused save in the user's words, by typed code only; nothing was written in every typed case. */
export function presentConflictPreferenceSaveRefusal(caught: unknown): string {
  if (caught instanceof RepositoryError) {
    switch (caught.code) {
      case 'planner_state_changed':
        return '計算した後に、表示していた生産計画（下書き）・作成リスト・目標武器・所持武器・RNG状態のいずれかが変わったため、保存しませんでした。表示中の生産計画は変更していません。'
      case 'draft_plan_conflict':
        return '未開始の生産計画（下書き）が複数あるため、保存しませんでした。生産計画一覧で状態を確認してください。'
      case 'production_plan_id_conflict':
        return '保存しようとした生産計画が既存の生産計画と重なったため、保存しませんでした。表示中の生産計画は変更していません。'
      case 'planner_result_invalid':
      case 'validation_failed':
        return '保存前の確認で、この計算結果が保存できる条件を満たしていないことが分かりました。表示中の生産計画は変更していません。'
      case 'transaction_failed':
        return '保存処理が完了しませんでした。表示中の生産計画は変更していません。'
      default:
        break
    }
  }
  if (caught instanceof ExecutionRuntimeError && caught.code === 'running_plan_invariant_violated') {
    return '実行中の生産計画が複数存在するため、保存しませんでした。生産計画一覧で状態を確認してください。'
  }
  return '生産計画の保存に失敗しました。生産計画一覧で現在の状態を確認してください。'
}
