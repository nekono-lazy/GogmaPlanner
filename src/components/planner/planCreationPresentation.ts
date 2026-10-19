import { RepositoryError } from '../../db/repositoryError'
import { ExecutionRuntimeError } from '../../domain/execution'
import type { PlanCreationMethodSelection } from '../../domain/planner/buildListOptimization'
import type { PlanCreationNotStartedReason, PlanCreationOperation } from '../../services/planner/planCreationService'
import { ORDINARY_PLANNER_AUXILIARY_LABEL } from './buildListOptimizationPresentation'
import { productionPlannerDetailSettingsTitle } from './productionPlannerSettingsPresentation'

/**
 * Presentation of the Build List's plan creation (`docs/PLANNER_SPEC.md` 17.2 U1 / 17.11, `docs/UI_FLOW.md` 10.2 / 10.4, Issue #260
 * PR-6C): what the one primary operation 「生産計画を作成」 does for the judged state, why a press started nothing, and why an adoption
 * was refused.
 *
 * Every text here is chosen by a typed value - the Domain's `PlanCreationMethodSelection`, the Application's not-started reason, a
 * Persistence error code. Nothing counts Entries, judges a method or a support, or parses a message.
 */

// ------------------------------------------------------------------------------------------------ the primary operation

export const PLAN_CREATION_PRIMARY_LABEL = '生産計画を作成'

export const PLAN_CREATION_JUDGING_MESSAGE = '作成方法を確認しています…'

/** The pre-start body of the ordinary Planner (one valid Entry, U1): the registered Route as it is, no reconstruction. */
export const PLAN_CREATION_ORDINARY_LINES: readonly string[] = [
  '有効な候補は1件です。「生産計画を作成」は、作成リストに登録した候補のルートをそのまま使って生産計画を作成します（ルートの組み直しはしません）。',
  '作成に成功すると、保存された生産計画の画面へ移動します。再検索が必要な候補は生産計画に含まれません。',
]

/** The pre-start body of the global optimization (two or more valid Entries, U1; `docs/UI_FLOW.md` 10.4 「入口」). */
export function planCreationOptimizationLines(validEntryCount: number): string[] {
  return [
    `有効な候補が${validEntryCount}件あります。「生産計画を作成」は、作成リストの目標武器全体について作成ルートを組み直し、生産計画を試算します。`,
    '試算の結果を確認してから採用できます。採用するまで、作成リストと生産計画は変更されません。最短であることは保証しません。',
    '再検索が必要な候補や完了済みの目標武器の候補は、計画の対象になりません。',
  ]
}

export function planCreationUnsupportedLead(validEntryCount: number): string {
  return `有効な候補が${validEntryCount}件ありますが、次の理由により全体最適化を使えないため、「生産計画を作成」は開始できません。`
}

export const PLAN_CREATION_INVALID_INPUT_MESSAGE =
  '作成リストに整理が必要な項目があるため、生産計画を作成できません。候補一覧で「要整理」と表示された目標武器や、途中採用する状態の選択を確認してください。'

export const PLAN_CREATION_NO_VALID_ENTRY_MESSAGE =
  '有効な候補が無いため、生産計画を作成できません。再検索が必要な候補や完了済みの目標武器の候補は、計画の対象になりません。候補検索で候補を作成リストへ追加し直してください。'

export const PLAN_CREATION_READ_FAILED_MESSAGE =
  '作成リストと生産計画の状態を確認できないため、生産計画の作成はできません。'

export const PLAN_CREATION_JUDGEMENT_FAILED_MESSAGE =
  '作成方法の判定で前提に合わない状態が見つかったため、生産計画の作成はできません。'

export const PLAN_CREATION_RUNNING_PLAN_MESSAGE =
  '実行中の生産計画があるため、新しい生産計画は作成できません。画面の表示を更新します。'

/** The Draft note beside the primary operation (`docs/UI_FLOW.md` 10.3): the existing atomic replacement, never a new rule. */
export const PLAN_CREATION_DRAFT_REPLACED_NOTE =
  '新しい生産計画を保存すると（全体最適化では試算を採用すると）、現在の未開始の生産計画（下書き）は置き換えられます。'

/** While a calculation, a save or an adoption is in progress, the Build List is not edited on this screen (`docs/UI_FLOW.md` 10.4). */
export const PLAN_CREATION_BUILD_LIST_LOCKED_NOTE =
  '生産計画の計算・保存・採用の確認中は、作成リストの変更（途中採用する状態・改善優先の変更、削除）はできません。'

/** The valid Entry count of a judgement: the Domain's `validBuildListEntries`, never a count of the screen's own. */
export function planCreationValidEntryCount(selection: PlanCreationMethodSelection): number {
  return selection.validation.validBuildListEntries.length
}

// ------------------------------------------------------------------------------------------------ a press that started nothing

export type PlanCreationNoticeSeverity = 'info' | 'warning' | 'error'

export interface PlanCreationNotStartedPresentation {
  severity: PlanCreationNoticeSeverity
  message: string
}

/**
 * Why a press started no calculation, judged at the press (`docs/PLANNER_SPEC.md` 17.2: the press's fresh judgement decides, never
 * the one shown before). The reasons and the current state are shown again by the refreshed pre-start body.
 */
export function presentPlanCreationNotStarted(
  operation: PlanCreationOperation,
  reason: PlanCreationNotStartedReason,
): PlanCreationNotStartedPresentation {
  const what = operation === 'primary' ? '生産計画の作成' : `「${ORDINARY_PLANNER_AUXILIARY_LABEL}」`
  switch (reason.kind) {
    case 'start_read_failed':
      return { severity: 'error', message: `作成リストと生産計画の状態を読み込めなかったため、${what}を開始しませんでした。もう一度試してください。` }
    case 'judgement_failed':
      return { severity: 'error', message: `作成方法の判定で前提に合わない状態が見つかったため、${what}を開始しませんでした。` }
    case 'running_plan_exists':
      return { severity: 'info', message: `実行中の生産計画があるため、${what}を開始しませんでした。画面の表示を更新します。` }
    case 'invalid_planner_input':
      return { severity: 'warning', message: `押した時点の作成リストに整理が必要な項目があったため、${what}を開始しませんでした。` }
    case 'no_valid_build_list_entry':
      return { severity: 'warning', message: `押した時点の作成リストに有効な候補が無かったため、${what}を開始しませんでした。` }
    case 'build_list_optimization_unsupported':
      return {
        severity: 'warning',
        message: '押した時点の作成リストでは全体最適化を使えなかったため、計算を開始しませんでした。理由を下に表示しています。',
      }
    case 'ordinary_planner_auxiliary_not_offered':
      return {
        severity: 'info',
        message: `押した時点の作成リストでは「${ORDINARY_PLANNER_AUXILIARY_LABEL}」の対象ではなくなっていたため、開始しませんでした。表示を最新の状態に更新しました。`,
      }
    case 'planner_options_invalid':
      return {
        severity: 'warning',
        message: `押した時点の作成リストでは通常Plannerで作成しますが、「${productionPlannerDetailSettingsTitle}」の「最大計画ステップ数」が無効なため、開始しませんでした。1以上の整数を入力してください。`,
      }
  }
}

// ------------------------------------------------------------------------------------------------ the ordinary Planner run

export const PLAN_CREATION_PREPARING_TITLE = '作成リストを確認しています…'
/** Why an operation waits while another calculation, save or adoption check runs (shown beside it, never only as a tooltip). */
export const PLAN_CREATION_BUSY_MESSAGE = '生産計画の計算・保存・採用の確認中は開始できません。'
export const PLAN_CREATION_SAVING_MESSAGE = '生産計画を保存しています…'
export const PLAN_CREATION_CANCELLED_MESSAGE = '生産計画の作成をキャンセルしました。'
export const PLAN_CREATION_NO_PLAN_MESSAGE = '現在の入力から作成できる生産計画はありませんでした。'
export const PLAN_CREATION_FAILED_MESSAGE = '生産計画の作成に失敗しました。'

/** Where an incomplete ordinary run asks the user to raise the bound and what to run again (`docs/UI_FLOW.md` 10.1). */
export function ordinaryPlannerRetryAction(operation: PlanCreationOperation): string {
  return operation === 'primary' ? '生産計画を作成' : `「${ORDINARY_PLANNER_AUXILIARY_LABEL}」を実行`
}

// ------------------------------------------------------------------------------------------------ adoption

export const ADOPTION_INSPECTING_MESSAGE = 'この試算を採用できるか確認しています…'

/** Which typed cause refused an adoption (`docs/UI_FLOW.md` 10.4 「採用」, `docs/PLANNER_SPEC.md` 17.11). */
export type BuildListOptimizationAdoptionRefusalCause =
  /** The state moved after the calculation started (the input token, a Draft, a running Plan, a stale generated Entry). */
  | 'state_changed'
  /** The trial itself cannot be stored (a contract the save checks). */
  | 'not_persistable'
  /** Storing failed; the transaction rolled back. */
  | 'save_failed'
  /** Not a typed refusal: whether anything was stored cannot be told here. */
  | 'unknown'

export interface BuildListOptimizationAdoptionRefusalPresentation {
  cause: BuildListOptimizationAdoptionRefusalCause
  title: string
  messages: string[]
}

const ADOPTION_UNCHANGED = '作成リストと生産計画は変更されていません。'
const ADOPTION_RECALCULATE = 'この試算は破棄しました。もう一度計算する場合は「生産計画を作成」を押してください（自動では計算しません）。'

/**
 * A refused adoption in the user's words. The Persistence API writes in one transaction and throws a typed error before or instead of
 * committing, so a typed refusal says nothing changed; an untyped error does not say so. The cause comes from the typed code only.
 */
export function presentBuildListOptimizationAdoptionRefusal(caught: unknown): BuildListOptimizationAdoptionRefusalPresentation {
  const refused = (cause: BuildListOptimizationAdoptionRefusalCause, title: string, reason: string) => ({
    cause,
    title,
    messages: [reason, ADOPTION_UNCHANGED, ADOPTION_RECALCULATE],
  })
  if (caught instanceof RepositoryError) {
    switch (caught.code) {
      case 'planner_state_changed':
        return refused(
          'state_changed',
          '試算の後に状態が変わったため、採用できませんでした',
          '計算した後に、作成リスト・目標武器・所持武器・RNG状態・生産計画のいずれかが変わったため、この試算は今の状態に合いません。',
        )
      case 'draft_plan_conflict':
        return refused(
          'state_changed',
          '未開始の生産計画の状態が変わったため、採用できませんでした',
          '未開始の生産計画（下書き）の状態が計算した時点と一致しません。生産計画一覧で状態を確認してください。',
        )
      case 'production_plan_id_conflict':
        return refused(
          'save_failed',
          '保存できなかったため、採用できませんでした',
          '保存しようとした生産計画が既存の生産計画と重なったため、保存しませんでした。',
        )
      case 'planner_result_invalid':
      case 'validation_failed':
        return refused(
          'not_persistable',
          'この試算は保存できる内容ではなかったため、採用できませんでした',
          '保存前の確認で、この試算が保存できる条件を満たしていないことが分かりました。',
        )
      case 'transaction_failed':
        return refused('save_failed', '保存に失敗したため、採用できませんでした', '保存処理が完了しませんでした。')
      default:
        break
    }
  }
  if (caught instanceof ExecutionRuntimeError && caught.code === 'running_plan_invariant_violated') {
    return refused(
      'state_changed',
      '実行中の生産計画の状態を確認できないため、採用できませんでした',
      '実行中の生産計画が複数存在します。生産計画一覧で状態を確認してください。',
    )
  }
  return {
    cause: 'unknown',
    title: '採用できませんでした',
    messages: [
      '採用の処理が完了しませんでした。作成リストと生産計画一覧で、現在の状態を確認してください。',
      ADOPTION_RECALCULATE,
    ],
  }
}

/** The ordinary Planner auxiliary run's own Accordion reference, for the incomplete display (`docs/UI_FLOW.md` 10.1). */
export const PLAN_CREATION_SETTINGS_HEADING = productionPlannerDetailSettingsTitle
