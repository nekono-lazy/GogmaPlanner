import type { RunningPlanReplanAdoptionInspection } from '../../domain/execution/runningPlanReplanAdoption'
import type {
  RunningPlanReplanAuxiliaryShortfall,
  RunningPlanReplanAuxiliaryShortfallReason,
} from '../../domain/execution/runningPlanReplanAuxiliary'
import type {
  RunningPlanReplanOptimizationArtifact,
  RunningPlanReplanOptimizationResult,
  RunningPlanReplanOptimizationUnsupportedReason,
} from '../../domain/execution/runningPlanReplanOptimization'
import { deriveRunningPlanReplanBuildListAfterAdoption } from '../../domain/execution/runningPlanReplanPreview'
import type {
  ReplanTargetClassification,
  ReplanTargetNotEligibleReason,
  ReplanTargetRow,
  RunningPlanReplanUnavailableReason,
} from '../../domain/execution/runningPlanReplanTargets'
import type { ExecutionRuntimeErrorCode } from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { collectReferencedOwnedWeaponIds } from '../../domain/models/hashing'
import type {
  OwnedWeapon,
  OwnedWeaponId,
  ProductionPlan,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import { BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE } from '../../domain/planner/buildListOptimization'
import {
  artianWeaponKindLabels,
  plannerWarningLabels,
  productionPlanRecalculationReasonLabels,
  rejectedBuildListEntryReasonLabels,
  rejectedBuildListEntryResourceConflictCauseLabels,
  staleReasonLabels,
} from '../../presentation/labels'
import type {
  RunningPlanReplanRefusal,
  RunningPlanReplanSessionAuxiliaryOffer,
  RunningPlanReplanSessionFailure,
  RunningPlanReplanStart,
} from '../../services/execution/runningPlanReplanService'
import type { OneRunWorkerCancelReason } from '../../services/planner/oneRunWorkerClient'
import {
  buildListOptimizationRouteBaseOf,
  createBuildListOptimizationReplacementViews,
  createPlannedCompletionVariantRows,
  type PlannedCompletionVariantsRow,
  createBuildListOptimizationTargetResolver,
  resolveBuildListOptimizationTargets,
  type BuildListOptimizationReplacementView,
  type BuildListOptimizationRouteBase,
  type BuildListOptimizationTargetDisplay,
  type BuildListOptimizationTargetList,
  type BuildListOptimizationTargetResolver,
  type BuildListOptimizationUnsupportedReasonPresentation,
} from '../planner/buildListOptimizationPresentation'
import { createProductionPlanSummary } from '../planner/productionPlanPresentation'
import { EXECUTION_HISTORY_UNCONVERTIBLE_MESSAGE } from './executionStepPresentation'

/**
 * Presentation of the running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18, `docs/UI_FLOW.md` 16.5, Issue #276 PR-6A):
 * the target confirmation, the availability and input-condition refusals, the typed results, the unsaved Preview, the adoption
 * confirmation and the explicit auxiliary's shortfall.
 *
 * Everything here reads the typed Domain derivations and the Application session state as they are. The categories and counts are
 * PR-2's `deriveReplanTargetSet()` rows, the reasons are PR-2's / Stage 0R's / the session's own, the Entry changes are the artifact's
 * and the start effect changes are PR-4's `startTargetLinkChanges` (or the adoption inspection's re-derivation). Nothing classifies,
 * counts a Target set, decides support or parses a message of its own. Targets and weapons are named by their names - never by IDs -
 * and from the start-time state the calculation read (`RunningPlanReplanStart`), never from a later read.
 */

// ------------------------------------------------------------------------------------------------ wording

export const RUNNING_PLAN_REPLAN_SECTION_DESCRIPTION =
  '実行中の生産計画で作る目標武器を見直し、現在の確定済み状態から作成ルートをまとめて組み直します。試算しただけでは、現在の生産計画と作成リストは変更されません。'
export const RUNNING_PLAN_REPLAN_OPEN_LABEL = '再計画する目標武器を確認'
export const RUNNING_PLAN_REPLAN_START_LABEL = 'この内容で再計画を試算'
export const RUNNING_PLAN_REPLAN_CLOSE_LABEL = '再計画を閉じる'
export const RUNNING_PLAN_REPLAN_TARGETS_TITLE = '再計画する目標武器'
export const RUNNING_PLAN_REPLAN_EXCLUSION_NOTE =
  '今回は作らないことを選んでも、目標武器・作成リストの候補・作成途中の武器は削除されません。'
export const RUNNING_PLAN_REPLAN_LINK_NOTE =
  '採用時に、新しい計画が作成途中の武器を別の目標武器に使う場合は優先起点の紐付けが変わることがあり、試算で事前に示します。'
export const RUNNING_PLAN_REPLAN_EMPTY_MESSAGE =
  '再計画する目標武器が選ばれていないため、試算できません。何も作らない再計画は作成しません。'
export const RUNNING_PLAN_REPLAN_EMPTY_ABANDON_NOTE =
  '現在の生産計画を終える場合は、実行ナビの「実行状態の管理」から現在の生産計画を破棄してください。'
export const RUNNING_PLAN_REPLAN_PRE_START_UNSUPPORTED_TITLE = 'この選択では全体再最適化を使えません'
export const RUNNING_PLAN_REPLAN_PRE_START_UNSUPPORTED_NOTE =
  '試算を始めた時点の状態で改めて判定します。登録済みの候補で再計画する補助操作は、試算の結果の中から選べます。'
export const RUNNING_PLAN_REPLAN_RUNNING_TITLE = '再計画を計算中'
export const RUNNING_PLAN_REPLAN_RUNNING_NOTE =
  '選んだ目標武器について、現在の確定済み状態から作成ルートをまとめて組み直しています。計算が終わると結果を表示します。'
export const RUNNING_PLAN_REPLAN_SELECTION_LOCKED_NOTE = '計算中は目標武器の選択を変更できません。'
export const RUNNING_PLAN_REPLAN_ACTIVE_CONTINUES_NOTE =
  '現在の生産計画は変更されていません。試算を採用しなければ、現在の生産計画をそのまま続けられます。'
export const RUNNING_PLAN_REPLAN_UNCHANGED_MESSAGE = '現在の生産計画と作成リストは変更されていません。'
export const RUNNING_PLAN_REPLAN_RECALCULATE_NOTE = '目標武器の選択を変えて、もう一度試算できます。'

export const RUNNING_PLAN_REPLAN_PREVIEW_TITLE = '再計画の試算（未採用）'
export const RUNNING_PLAN_REPLAN_PREVIEW_UNCHANGED_MESSAGE =
  'まだ現在の生産計画と作成リストは変更されていません。この試算は保存されておらず、画面を離れると消えます。'
export const RUNNING_PLAN_REPLAN_PREVIEW_DESCRIPTION =
  '選んだ目標武器について、現在の確定済み状態から作成ルートを組み直し、生産計画として成立することを確認した試算です。最短であることは保証しません。'
export const RUNNING_PLAN_REPLAN_DRAFT_AFFECTED_MESSAGE =
  '未開始の下書きが、この試算で置き換わる作成リストの候補を参照しています。採用すると、その下書きは作成開始できなくなる可能性があります（下書き自体は変更しません）。'
export const RUNNING_PLAN_REPLAN_LINK_CHANGE_EFFECT_NOTE =
  '紐付けの変更・解除は、目標武器を外した操作によるものではなく、採用で新しい計画を開始したときの効果です。採用時に最新の状態から導出し直し、ここに示した内容と異なる場合は採用されません。'

export const RUNNING_PLAN_REPLAN_AUXILIARY_LABEL = '登録済みの候補で再計画を試算'
export const RUNNING_PLAN_REPLAN_AUXILIARY_TITLE = '登録済みの候補で再計画する場合'
export const RUNNING_PLAN_REPLAN_AUXILIARY_NOTES: readonly string[] = [
  '作成リストに登録したルートをそのまま使い、作成ルートの組み直しはしません。',
  '候補の再検索が必要な目標武器など、この試算では作られない目標武器があり得ます。作られない目標武器は試算の結果で示します。',
  '採用しても作成リストの候補は変更されません。',
]
export const RUNNING_PLAN_REPLAN_AUXILIARY_PREVIEW_TITLE = '登録済みの候補での再計画の試算（未採用）'
export const RUNNING_PLAN_REPLAN_AUXILIARY_RUNNING_TITLE = '登録済みの候補で再計画を試算しています…'
export const RUNNING_PLAN_REPLAN_AUXILIARY_OPTIONS_INVALID_MESSAGE =
  '通常Plannerの詳細設定の「最大計画ステップ数」が無効なため、開始できません。1以上の整数を入力してください。'

/**
 * Whether the replan shows the screen's 「詳細設定（通常Planner用）」 (Issue #359, `docs/UI_FLOW.md` 10.0 / 16.5): of the replan, only the
 * explicit auxiliary 「登録済みの候補で再計画を試算」 reads 「最大計画ステップ数」, so the settings are shown while the session offers it
 * (`runningPlanReplanAuxiliaryOfferOf()`) or its 16.8 Preview / adoption shows something - the auxiliary's own lifetime. The whole-set
 * re-optimization never reads the setting, so nothing else shows it.
 */
export function isRunningPlanReplanOrdinaryPlannerSettingsShown(replan: {
  open: boolean
  auxiliaryOffer: RunningPlanReplanSessionAuxiliaryOffer
  auxiliary: { preview: { status: string }; adoption: { status: string } }
}): boolean {
  return replan.open && (
    replan.auxiliaryOffer.offered || replan.auxiliary.preview.status !== 'idle' || replan.auxiliary.adoption.status !== 'idle'
  )
}

export const RUNNING_PLAN_REPLAN_ADOPT_LABEL = 'この再計画を採用'
/**
 * The running Plan is no longer the Plan the replan was opened for (`running_plan_changed`): nothing of the other Plan is shown or
 * calculated, and the screen never switches to it by itself.
 */
export const RUNNING_PLAN_REPLAN_PLAN_CHANGED_TITLE = '実行中の生産計画が変わりました'
export const RUNNING_PLAN_REPLAN_PLAN_CHANGED_DESCRIPTION =
  '再計画を開いた後に、実行中の生産計画が別の計画に変わりました。この計画の内容では試算できません。最新の状態を確認して、もう一度再計画してください。'
export const RUNNING_PLAN_REPLAN_PLAN_CHANGED_MESSAGE =
  '実行中の生産計画が変わりました。最新の状態を確認して、もう一度再計画してください。'

export const RUNNING_PLAN_REPLAN_SAVE_POINT_RESTORED_MESSAGE =
  '最後のゲーム内セーブ地点へ戻しました。この試算は採用していません。復元後の状態から、もう一度再計画を試算してください。'

// ------------------------------------------------------------------------------------------------ target confirmation

/** The 18.2 not-eligible reasons in words (UI_FLOW 16.5 「対象外」). */
export const replanTargetNotEligibleReasonLabels: Record<ReplanTargetNotEligibleReason, string> = {
  deleted: '削除済み',
  completed_elsewhere: '完了済み（この生産計画以外で完了）',
  disabled: '検索対象OFF',
  completion_condition_review_required: '完成条件の再設定が必要',
}

/** A Target row as the confirmation shows it. `key` is for React only and never shown. */
export interface ReplanTargetItem {
  key: TargetWeaponId
  target: BuildListOptimizationTargetDisplay | null
  /** Whether the row is part of the replan target set (continuing / added). */
  selected: boolean
}

export interface ReplanNotEligibleItem {
  key: TargetWeaponId
  target: BuildListOptimizationTargetDisplay | null
  reasonLabel: string
}

export interface ReplanTargetConfirmationModel {
  /** 続けて作る: the old Plan's unfinished Targets that can be replanned (selected = not excluded). Step order. */
  continuing: ReplanTargetItem[]
  /** 取り込める: the additional candidates (selected = included). ID order. */
  candidates: ReplanTargetItem[]
  completed: BuildListOptimizationTargetList
  notEligible: ReplanNotEligibleItem[]
  /** The replan target set's size, from the classification (never re-counted from the checkboxes). */
  replanTargetCount: number
  excludedCount: number
  addedCount: number
}

function rowsOf(classification: ReplanTargetClassification, categories: readonly ReplanTargetRow['category'][]): ReplanTargetRow[] {
  return classification.rows.filter(({ category }) => categories.includes(category))
}

/** The confirmation's groups over PR-2's classification (with the selection applied) and the start-time Targets. */
export function createReplanTargetConfirmationModel(start: RunningPlanReplanStart, master: MasterDataRoot): ReplanTargetConfirmationModel {
  const classification = start.replanTargets
  const resolve = createBuildListOptimizationTargetResolver(start.plannerInput.targetWeapons, master)
  const item = (row: ReplanTargetRow): ReplanTargetItem => ({
    key: row.targetWeaponId,
    target: resolve(row.targetWeaponId),
    selected: row.category === 'continuing' || row.category === 'added',
  })
  return {
    continuing: rowsOf(classification, ['continuing', 'excluded']).map(item),
    candidates: rowsOf(classification, ['additional_candidate', 'added']).map(item),
    completed: resolveBuildListOptimizationTargets(rowsOf(classification, ['completed']).map(({ targetWeaponId }) => targetWeaponId), resolve),
    notEligible: classification.rows.flatMap((row): ReplanNotEligibleItem[] => row.category === 'not_eligible'
      ? [{ key: row.targetWeaponId, target: resolve(row.targetWeaponId), reasonLabel: replanTargetNotEligibleReasonLabels[row.reason] }]
      : []),
    replanTargetCount: classification.replanTargetWeaponIds.length,
    excludedCount: rowsOf(classification, ['excluded']).length,
    addedCount: rowsOf(classification, ['added']).length,
  }
}

/** The one-line summary of the current selection (UI_FLOW 16.5), from the classification counts. */
export function replanSelectionSummaryText(model: Pick<ReplanTargetConfirmationModel, 'replanTargetCount' | 'excludedCount' | 'addedCount'>): string {
  return `今回の再計画で作る目標武器：${model.replanTargetCount}本（取り込む${model.addedCount}本・今回作らない${model.excludedCount}本）`
}

/** A Target's display name; a Target the start-time state does not hold (a deleted one) is never named by its ID. */
export function replanTargetLabel(target: BuildListOptimizationTargetDisplay | null): string {
  return target === null ? '削除された目標武器' : target.name
}

// ------------------------------------------------------------------------------------------------ availability and refusals

export interface ReplanGuidance {
  title: string
  description: string
  links: { to: string; label: string }[]
}

/** The 18.5 per-old-Plan reasons: neither the re-optimization nor the auxiliary starts while one holds. */
export function presentRunningPlanReplanUnavailableReason(
  reason: RunningPlanReplanUnavailableReason,
  planId: string,
): ReplanGuidance {
  switch (reason.kind) {
    case 'running_plan_targets_unknown':
      return {
        title: '作成予定の目標武器を確認できない生産計画です',
        description:
          'この生産計画は以前の形式で作成されているため、作成予定の目標武器を決められません。現在の生産計画を続けるか、実行ナビから破棄してください。',
        links: [{ to: `/plans/${planId}/run`, label: '実行ナビを開く' }],
      }
    case 'operation_uncertain_unresolved':
      return {
        title: '操作内容が不明と記録されています',
        description:
          '「何を何回操作したか分からない」が記録されているため、現在の状態がゲームの現在位置を表しているとは言えません。再計画は現在位置の確認の代わりにはならないため、先に実行ナビで現在位置を確認するか、ゲーム内セーブ地点へ戻してください。',
        links: [{ to: `/plans/${planId}/run`, label: '実行ナビで現在位置を確認' }],
      }
    case 'reidentification_required': {
      const destinations = new Set(reason.unresolved.map(({ destination }) => destination))
      const links: ReplanGuidance['links'] = []
      if (destinations.has('normal_counters')) links.push({ to: '/normal-counters', label: '通常アーティアカウンター設定へ' })
      if (destinations.has('rng')) links.push({ to: '/rng', label: 'RNG状態設定へ' })
      return {
        title: '予測の前提を確認する必要があります',
        description:
          '想定と異なる結果が記録されており、予測に使う状態（シード・カウンター）の再特定が済んでいません。再計画は再特定の代わりにはならないため、先に再特定してください。',
        links,
      }
    }
  }
}

/** Why the replan screen offers no target confirmation or start (a refused read or start). */
export function presentRunningPlanReplanRefusal(refusal: RunningPlanReplanRefusal): ReplanGuidance & { reasons: ReplanGuidance[] } {
  switch (refusal.kind) {
    case 'no_running_plan':
      return {
        title: '実行中の生産計画がありません',
        description: '現在地点から再計画できる実行中の生産計画はありません。最新の状態を読み込み直してください。',
        links: [{ to: '/plans', label: '生産計画一覧を見る' }],
        reasons: [],
      }
    case 'multiple_running_plans':
      return {
        title: '実行中の生産計画が複数あります',
        description: '実行中（または再計算が必要）の生産計画が複数保存されているため、どれから再計画するかを決められません。生産計画一覧で状態を確認してください。',
        links: [{ to: '/plans', label: '生産計画一覧を見る' }],
        reasons: [],
      }
    case 'unavailable':
      return {
        title: '現在地点からの再計画は今は使えません',
        description: '次の理由により、再計画の試算も、登録済みの候補での再計画も開始できません。',
        links: [],
        reasons: refusal.reasons.map((reason) => presentRunningPlanReplanUnavailableReason(reason, refusal.planId)),
      }
    case 'running_plan_changed':
      return {
        title: RUNNING_PLAN_REPLAN_PLAN_CHANGED_TITLE,
        description: RUNNING_PLAN_REPLAN_PLAN_CHANGED_DESCRIPTION,
        links: [{ to: '/plans', label: '生産計画一覧を見る' }],
        reasons: [],
      }
    case 'invalid_selection':
      return {
        title: '選んだ目標武器の状態が変わりました',
        description: '目標武器を確認した後に状態が変わったため、この選択では再計画できません。選択をやり直してください。',
        links: [],
        reasons: [],
      }
  }
}

// ------------------------------------------------------------------------------------------------ input conditions

const unconfirmedRngItemLabels: Record<Extract<RunningPlanReplanOptimizationUnsupportedReason, { kind: 'unconfirmed_rng_state' }>['missing'][number], string> = {
  base_seed: 'Base Seed（基準シード）',
  skill_counter: 'スキルカウンター',
  gogma_counter: '巨戟カウンター',
}

const noTargets: BuildListOptimizationTargetList = { targets: [], unresolvedCount: 0 }

/** One Stage 0R input condition (18.5) in the replan's words, with the Targets it names and where to resolve it. */
export function presentRunningPlanReplanUnsupportedReason(
  reason: RunningPlanReplanOptimizationUnsupportedReason,
  resolve: BuildListOptimizationTargetResolver,
): Omit<BuildListOptimizationUnsupportedReasonPresentation, 'kind'> & { kind: RunningPlanReplanOptimizationUnsupportedReason['kind'] } {
  switch (reason.kind) {
    case 'no_replan_target':
      return {
        kind: reason.kind,
        title: '再計画する目標武器がありません',
        description: `${RUNNING_PLAN_REPLAN_EMPTY_MESSAGE}${RUNNING_PLAN_REPLAN_EMPTY_ABANDON_NOTE}`,
        targets: noTargets,
        missingItems: [],
        links: [],
      }
    case 'invalid_planner_input':
      return {
        kind: reason.kind,
        title: '作成リストに整理が必要な項目があります',
        // Two causes, two recoveries (18.5): a Target holding two Entries is tidied in the Build List, which marks it 「要整理」; a legacy
        // Entry's broken selection (schema 11..18 or schema 10) has no clearing UI and is replaced through a new Candidate Search.
        description:
          '再計画する目標武器の候補に、同じ目標武器の候補の重複や、以前の形式の候補に残る途中採用状態の選択の不整合があるため、再計画できません。候補が重複している目標武器は作成リストに「要整理」と表示されるので、不要な候補を削除してください。以前の形式の候補に選択の不整合が残っている場合は、候補検索でその目標武器を検索し直して現在の候補へ置き換えてください。',
        targets: noTargets,
        missingItems: [],
        links: [
          { to: '/build-list', label: '作成リストへ' },
          { to: '/search', label: '候補検索へ' },
        ],
      }
    case 'checkpoint_selection':
      // A legacy Entry's selection (Issue #100 abolished it, and no screen can clear it any more): never cleared or read as empty.
      return {
        kind: reason.kind,
        title: '以前の形式の途中採用状態を持つ候補があります',
        description:
          '再計画は、以前の形式の候補に残る途中採用状態の選択を自動で解除したり読み替えたりしません。該当する目標武器を候補検索で検索し直して現在の候補へ置き換えるか、登録済みの候補で再計画する補助操作を使ってください。',
        targets: resolveBuildListOptimizationTargets(reason.entries.map(({ targetWeaponId }) => targetWeaponId), resolve),
        missingItems: [],
        links: [{ to: '/search', label: '候補検索へ' }],
      }
    case 'unconfirmed_rng_state':
      return {
        kind: reason.kind,
        title: 'RNG状態の一部が確定していません',
        description: '再計画には、次の値の確定が必要です。RNG状態設定で確定してください。',
        targets: noTargets,
        missingItems: reason.missing.map((item) => unconfirmedRngItemLabels[item]),
        links: [{ to: '/rng', label: 'RNG状態設定へ' }],
      }
    case 'target_without_source':
      return {
        kind: reason.kind,
        title: '起点にできる武器が無い目標武器があります',
        description:
          '起点にできる所持武器が無く、その武器種の通常アーティアカウンターも確定していない目標武器があります。通常アーティアカウンターを確定するか、起点にできる所持武器を登録してください。',
        targets: resolveBuildListOptimizationTargets(reason.targetWeaponIds, resolve),
        missingItems: [],
        links: [
          { to: '/normal-counters', label: '通常アーティアカウンターへ' },
          { to: '/owned-weapons', label: '所持武器へ' },
        ],
      }
    case 'blind_route_required':
      return {
        kind: reason.kind,
        title: '予測できない作成ルートしか無い目標武器があります',
        description:
          '起点にできる所持武器が無く、通常アーティアの予測に対応していないため、再計画では扱えない目標武器があります。起点にできる所持武器を登録すると扱える場合があります。',
        targets: resolveBuildListOptimizationTargets(reason.targetWeaponIds, resolve),
        missingItems: [],
        links: [{ to: '/owned-weapons', label: '所持武器へ' }],
      }
  }
}

// ------------------------------------------------------------------------------------------------ results

export interface ReplanResultView {
  title: string
  severity: 'info' | 'warning' | 'error'
  messages: string[]
}

export const runningPlanReplanCancelMessages: Record<OneRunWorkerCancelReason, string> = {
  cancelled: '再計画の計算をキャンセルしました。',
  superseded: '新しい計算を開始したため、前の計算を中止しました。',
  disposed: '画面を離れたため、再計画の計算を中止しました。',
  page_hidden: 'ページを閉じたか移動したため、再計画の計算を中止しました。',
}

export interface ReplanFailurePresentation {
  category: 'calculation_failed' | 'contract_violation'
  message: string
  /** Running again can help (a read or Worker failure); a contract violation repeats on the same input. */
  retryable: boolean
}

export const RUNNING_PLAN_REPLAN_FAILURE_TITLE = '計算を完了できませんでした'
export const RUNNING_PLAN_REPLAN_CONTRACT_VIOLATION_NOTE =
  'この結果は「再計画を使えない」や「計画が見つからなかった」という意味ではありません。'

/** A failure is an error, never a result (18.5): its typed kind decides the words; the message is Debug Mode only. */
export function presentRunningPlanReplanFailure(failure: RunningPlanReplanSessionFailure): ReplanFailurePresentation {
  switch (failure.kind) {
    case 'worker_unavailable':
      return { category: 'calculation_failed', message: 'この環境では計算用のWorkerを利用できないため、再計画を計算できませんでした。', retryable: false }
    case 'worker_start_failed':
      return { category: 'calculation_failed', message: '計算を開始できませんでした。もう一度試してください。', retryable: true }
    case 'worker_error':
    case 'worker_message_error':
      return {
        category: 'calculation_failed',
        message: '計算処理が途中で停止したため、計算を完了できませんでした。原因は特定できていません。もう一度試してください。',
        retryable: true,
      }
    case 'start_read_failed':
      // A record the database upgrade could not convert is no transient read
      // failure: retrying cannot help (`docs/DATA_MODEL.md` 14.2).
      if (failure.code === 'execution_history_unconvertible') {
        return { category: 'calculation_failed', message: EXECUTION_HISTORY_UNCONVERTIBLE_MESSAGE, retryable: false }
      }
      return {
        category: 'calculation_failed',
        message: '生産計画と作成リストの状態を読み込めなかったため、計算を開始できませんでした。もう一度試してください。',
        retryable: true,
      }
    case 'calculation_error':
      switch (failure.code) {
        case 'calculation_failed':
          return { category: 'calculation_failed', message: '計算中にエラーが発生したため、計算を完了できませんでした。もう一度試してください。', retryable: true }
        case 'invariant_violation':
        case 'materialization_failed':
          return { category: 'contract_violation', message: '計算結果の確認で前提に合わない状態が見つかったため、計算を完了できませんでした。', retryable: true }
        case 'input_contract_violation':
        case 'invalid_request':
        case 'worker_already_used':
        case 'search_bounds_unavailable':
          return { category: 'contract_violation', message: '計算の要求がアプリの前提に合わなかったため、計算を完了できませんでした。', retryable: true }
      }
      break
    case 'protocol_violation':
    case 'invalid_result':
      return { category: 'contract_violation', message: '計算結果を確認できなかったため、この結果は表示しません。', retryable: true }
  }
  return { category: 'contract_violation', message: '計算を完了できませんでした。', retryable: true }
}

/** The heading, tone and messages of a finished non-`optimized` outcome (UI_FLOW 16.5 「3. 結果」). */
export function runningPlanReplanResultViewOf(
  outcome:
    | { kind: 'result'; result: Exclude<RunningPlanReplanOptimizationResult, { status: 'optimized' }> }
    | { kind: 'cancelled'; reason: OneRunWorkerCancelReason }
    | { kind: 'failed'; failure: RunningPlanReplanSessionFailure },
): ReplanResultView {
  switch (outcome.kind) {
    case 'cancelled':
      return { title: '計算を中止しました', severity: 'info', messages: [runningPlanReplanCancelMessages[outcome.reason]] }
    case 'failed': {
      const failure = presentRunningPlanReplanFailure(outcome.failure)
      return {
        title: RUNNING_PLAN_REPLAN_FAILURE_TITLE,
        severity: 'error',
        messages: failure.category === 'contract_violation' ? [failure.message, RUNNING_PLAN_REPLAN_CONTRACT_VIOLATION_NOTE] : [failure.message],
      }
    }
    case 'result':
      switch (outcome.result.status) {
        case 'not_found':
          return {
            title: '計画を見つけられませんでした',
            severity: 'warning',
            messages: [
              'この探索範囲では、選んだ目標武器をすべて作る計画が見つかりませんでした。',
              '計画が存在しないという意味ではありません。どの目標武器が原因かは特定していません。',
            ],
          }
        case 'search_bound_reached':
          return {
            title: '結果を確定できませんでした',
            severity: 'warning',
            messages: ['探索の上限に達したため、結果を確定できませんでした。', '計画が存在しないという意味ではありません。'],
          }
        case 'unsupported':
          return { title: 'この選択では全体再最適化を使えません', severity: 'warning', messages: ['次の理由により、再計画の計算は行っていません。'] }
      }
  }
}

// ------------------------------------------------------------------------------------------------ Preview

export interface ReplanComparisonRow {
  key: 'steps' | 'physical_operations' | 'targets'
  label: string
  current: string
  next: string
}

export type ReplanComparison =
  /** The old Plan was `active` at the start: its remaining Steps beside the new Plan (18.7). */
  | { kind: 'active'; rows: ReplanComparisonRow[]; targetSetDiffers: boolean }
  /** The old Plan was `stale`: no figure is compared; it cannot be continued, for these reasons. */
  | { kind: 'stale'; reasonLabels: string[] }

export interface ReplanAdditionView {
  key: string
  target: BuildListOptimizationTargetDisplay | null
  after: BuildListOptimizationRouteBase
}

/** How the new Plan uses one weapon in progress for the old Plan (18.4), named for the user. */
export type ReplanInProgressHandling = 'same_target' | 'other_target' | 'unused'

export interface ReplanInProgressWeaponView {
  key: OwnedWeaponId
  name: string
  kindLabel: string
  handling: ReplanInProgressHandling
  /** The Targets the new Plan uses it for (empty for `unused`). */
  newTargets: BuildListOptimizationTargetList
}

/** Who the released Target is, relative to this replan (18.7: also when it is excluded or outside the replan). */
export type ReplanLinkReleasedRelation = 'excluded' | 'outside_replan' | 'replan_target'

export interface ReplanLinkChangeView {
  key: string
  target: BuildListOptimizationTargetDisplay | null
  weaponName: string
  released: { target: BuildListOptimizationTargetDisplay | null; relation: ReplanLinkReleasedRelation } | null
  previousWeaponName: string | null
}

export interface RunningPlanReplanPreviewModel {
  plan: ProductionPlan
  replanTargetCount: number
  /** The distinct Targets of the new Plan's `targetCompletions`, or null for a Plan without that authority. */
  plannedCompletionTargetCount: number | null
  breakdown: {
    continuing: BuildListOptimizationTargetList
    added: BuildListOptimizationTargetList
    excluded: BuildListOptimizationTargetList
    completed: BuildListOptimizationTargetList
    notEligible: ReplanNotEligibleItem[]
  }
  comparison: ReplanComparison
  physicalOperationCount: number
  planStepCount: number
  nonPhysicalStepCount: number
  conflictCount: number
  replacements: BuildListOptimizationReplacementView[]
  additions: ReplanAdditionView[]
  unchanged: BuildListOptimizationTargetList
  preferredSourceDifferences: BuildListOptimizationReplacementView[]
  inProgressWeapons: ReplanInProgressWeaponView[]
  linkChanges: ReplanLinkChangeView[]
  /** A Draft of the start names an Entry the adoption would replace (18.7): it may not start afterwards. */
  draftAffected: boolean
  /** Each Target the new Plan completes with the completion Variants it achieves (`docs/REQUIREMENTS.md` 13.2). */
  plannedCompletionVariants: PlannedCompletionVariantsRow[]
}

function weaponNameOf(weapons: ReadonlyMap<string, OwnedWeapon>, id: OwnedWeaponId | null): string | null {
  if (id === null) return null
  return weapons.get(id)?.name ?? '参照できない所持武器'
}

function idsOf(classification: ReplanTargetClassification, categories: readonly ReplanTargetRow['category'][]): TargetWeaponId[] {
  return rowsOf(classification, categories).map(({ targetWeaponId }) => targetWeaponId)
}

/** The relation of a Target whose preference the start effect releases, from the classification rows only. */
function releasedRelationOf(classification: ReplanTargetClassification, targetWeaponId: TargetWeaponId): ReplanLinkReleasedRelation {
  if (classification.replanTargetWeaponIds.includes(targetWeaponId)) return 'replan_target'
  return classification.rows.some((row) => row.targetWeaponId === targetWeaponId && row.category === 'excluded') ? 'excluded' : 'outside_replan'
}

export const replanLinkReleasedRelationLabels: Record<ReplanLinkReleasedRelation, string> = {
  excluded: '今回作らない目標武器',
  outside_replan: '今回の再計画の対象外の目標武器',
  replan_target: '今回の再計画の目標武器',
}

export const replanInProgressHandlingLabels: Record<ReplanInProgressHandling, string> = {
  same_target: '同じ目標武器の作成に続けて使います',
  other_target: '別の目標武器の作成に使います',
  unused: 'この再計画では使いません。作成中の状態は解除されますが、所持武器は削除されません',
}

/** The start effect's preference changes (PR-4's canonical list, or the adoption inspection's re-derivation), by name. */
export function createReplanLinkChangeViews(
  changes: RunningPlanReplanAdoptionInspection['startTargetLinkChanges'],
  start: RunningPlanReplanStart,
  resolve: BuildListOptimizationTargetResolver,
): ReplanLinkChangeView[] {
  const weapons = new Map(start.plannerInput.ownedWeapons.map((weapon) => [weapon.id, weapon] as const))
  return changes.map((change) => ({
    key: `${change.targetWeaponId}:${change.ownedWeaponId}`,
    target: resolve(change.targetWeaponId),
    weaponName: weaponNameOf(weapons, change.ownedWeaponId) ?? '参照できない所持武器',
    released: change.fromTargetWeaponId === null
      ? null
      : { target: resolve(change.fromTargetWeaponId), relation: releasedRelationOf(start.replanTargets, change.fromTargetWeaponId) },
    previousWeaponName: weaponNameOf(weapons, change.replacedOwnedWeaponId),
  }))
}

/**
 * The weapons in progress for the old Plan at the start and how the new Plan uses them (18.4): the Routes of the new Plan's selected
 * final Entries that reference the weapon (the same rule the adoption's in-progress transfer applies) name its new Targets, and the
 * old Plan's Steps tracking it name its old ones. No continuation preference is added: this only says what the calculation chose.
 */
export function createReplanInProgressWeaponViews(
  start: RunningPlanReplanStart,
  artifact: RunningPlanReplanOptimizationArtifact,
  resolve: BuildListOptimizationTargetResolver,
): ReplanInProgressWeaponView[] {
  const oldPlanId = start.runningPlanToken.planId
  const plan = artifact.plannerResult.plan
  const after = deriveRunningPlanReplanBuildListAfterAdoption(start.plannerInput.buildListEntries, artifact)
  const selected = new Set(plan?.selectedBuildListEntryIds ?? [])
  const finalEntries = after.kind === 'ready' ? after.buildListEntries.filter(({ id }) => selected.has(id)) : []
  return start.plannerInput.ownedWeapons
    .filter((weapon) => weapon.executionInProgress?.productionPlanId === oldPlanId)
    .map((weapon): ReplanInProgressWeaponView => {
      const newTargetIds = [...new Set(finalEntries
        .filter((entry) => collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route).includes(weapon.id))
        .map(({ targetWeaponId }) => targetWeaponId))]
      const oldTargetIds = new Set(start.runningPlan.steps
        .filter((step) => step.executionEffects?.trackedOwnedWeaponId === weapon.id && step.targetWeaponId !== null)
        .map((step) => step.targetWeaponId as TargetWeaponId))
      const handling: ReplanInProgressHandling = newTargetIds.length === 0
        ? 'unused'
        : newTargetIds.some((id) => oldTargetIds.has(id)) ? 'same_target' : 'other_target'
      return {
        key: weapon.id,
        name: weapon.name,
        kindLabel: artianWeaponKindLabels[weapon.kind],
        handling,
        newTargets: resolveBuildListOptimizationTargets(newTargetIds, resolve),
      }
    })
}

function comparisonOf(start: RunningPlanReplanStart, model: Pick<RunningPlanReplanPreviewModel, 'planStepCount' | 'physicalOperationCount' | 'plannedCompletionTargetCount' | 'replanTargetCount'>): ReplanComparison {
  const oldPlan = start.runningPlan
  if (start.runningPlanToken.status === 'stale') {
    return { kind: 'stale', reasonLabels: oldPlan.recalculationReasons.map((reason) => productionPlanRecalculationReasonLabels[reason]) }
  }
  const remaining = oldPlan.steps.filter(({ isCompleted }) => !isCompleted)
  const remainingPhysical = remaining.filter(({ operationType }) => operationType !== BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE)
  const classification = start.replanTargets
  const unfinished = classification.plannedTargetWeaponIds.length - rowsOf(classification, ['completed']).length
  return {
    kind: 'active',
    targetSetDiffers: rowsOf(classification, ['excluded', 'added', 'not_eligible']).length > 0,
    rows: [
      { key: 'steps', label: '計画ステップ数', current: String(remaining.length), next: String(model.planStepCount) },
      { key: 'physical_operations', label: 'ゲーム内の操作回数', current: String(remainingPhysical.length), next: String(model.physicalOperationCount) },
      {
        key: 'targets',
        label: '作る予定の目標武器',
        current: `${unfinished}本`,
        next: model.plannedCompletionTargetCount === null ? '不明' : `${model.plannedCompletionTargetCount}本`,
      },
    ],
  }
}

/** The Preview of an `optimized` replan over the start it was calculated from (`docs/PLANNER_SPEC.md` 18.7). */
export function createRunningPlanReplanPreviewModel(
  start: RunningPlanReplanStart,
  artifact: RunningPlanReplanOptimizationArtifact,
  startTargetLinkChanges: RunningPlanReplanAdoptionInspection['startTargetLinkChanges'],
  master: MasterDataRoot,
): RunningPlanReplanPreviewModel | null {
  const plan = artifact.plannerResult.plan
  if (plan === null) return null
  const classification = start.replanTargets
  const resolve = createBuildListOptimizationTargetResolver(start.plannerInput.targetWeapons, master)
  const startContext = {
    buildListEntries: start.plannerInput.buildListEntries,
    targetWeapons: start.plannerInput.targetWeapons,
    ownedWeapons: start.plannerInput.ownedWeapons,
  }
  const replacements = createBuildListOptimizationReplacementViews(artifact, startContext, resolve)
  const weapons = new Map(start.plannerInput.ownedWeapons.map((weapon) => [weapon.id, weapon] as const))
  const generated = new Map(artifact.generatedBuildListEntries.map((entry) => [entry.id, entry] as const))
  const additions = artifact.additions.map(({ targetWeaponId, generatedBuildListEntryId }): ReplanAdditionView => {
    const entry = generated.get(generatedBuildListEntryId)
    return {
      key: generatedBuildListEntryId,
      target: resolve(targetWeaponId),
      after: entry === undefined ? { kind: 'unavailable' } : buildListOptimizationRouteBaseOf(entry, weapons),
    }
  })
  const replacedIds = new Set<string>(artifact.replacements.map(({ replacedBuildListEntryId }) => replacedBuildListEntryId))
  const base = {
    replanTargetCount: artifact.replanTargetWeaponIds.length,
    plannedCompletionTargetCount: createProductionPlanSummary(plan).plannedCompletionTargetCount,
    physicalOperationCount: artifact.summary.physicalOperationCount,
    planStepCount: artifact.summary.planStepCount,
  }
  const listOf = (categories: readonly ReplanTargetRow['category'][]) => resolveBuildListOptimizationTargets(idsOf(classification, categories), resolve)
  return {
    plan,
    ...base,
    breakdown: {
      continuing: listOf(['continuing']),
      added: listOf(['added']),
      excluded: listOf(['excluded']),
      completed: listOf(['completed']),
      notEligible: classification.rows.flatMap((row): ReplanNotEligibleItem[] => row.category === 'not_eligible'
        ? [{ key: row.targetWeaponId, target: resolve(row.targetWeaponId), reasonLabel: replanTargetNotEligibleReasonLabels[row.reason] }]
        : []),
    },
    comparison: comparisonOf(start, base),
    nonPhysicalStepCount: artifact.summary.nonPhysicalStepCount,
    conflictCount: plan.conflicts.length,
    replacements,
    additions,
    unchanged: resolveBuildListOptimizationTargets(artifact.unchangedTargetWeaponIds, resolve),
    preferredSourceDifferences: replacements.filter(({ preferredSourceNotUsed }) => preferredSourceNotUsed !== null),
    inProgressWeapons: createReplanInProgressWeaponViews(start, artifact, resolve),
    linkChanges: createReplanLinkChangeViews(startTargetLinkChanges, start, resolve),
    draftAffected: start.draftPlans.some((draft) => draft.selectedBuildListEntryIds.some((id) => replacedIds.has(id))),
    // The start's Build List and the generated Entries together hold every Entry the new Plan selects.
    plannedCompletionVariants: createPlannedCompletionVariantRows(
      plan,
      [...start.plannerInput.buildListEntries, ...artifact.generatedBuildListEntries],
      start.plannerInput.targetWeapons,
      resolve,
      master,
    ),
  }
}

/** The count of one Target list of the Preview: the named Targets and those the start cannot name (never recounted elsewhere). */
export function replanTargetListCount(list: BuildListOptimizationTargetList): number {
  return list.targets.length + list.unresolvedCount
}

// ------------------------------------------------------------------------------------------------ Preview adoption operations

/** The accessible name of the replan Previews' sticky adoption operations (Issue #324). */
export const RUNNING_PLAN_REPLAN_ADOPTION_ACTIONS_LABEL = '再計画の試算の採用'
/** Their lead for the re-optimization's Preview: which trial they adopt, and that it is checked before adopting (Issue #324). */
export const RUNNING_PLAN_REPLAN_ADOPTION_ACTIONS_LEAD = `採用前の確認：${RUNNING_PLAN_REPLAN_PREVIEW_TITLE}`
/** Shown beside the press while 「この再計画を採用」 checks the trial before its confirmation (UI_FLOW 16.5 「5. 採用」). */
export const RUNNING_PLAN_REPLAN_ADOPTION_INSPECTING_MESSAGE = '採用の条件を確認しています。'

/**
 * What the re-optimization Preview's adoption operations ask to check (Issue #324, `docs/UI_FLOW.md` 16.5 「4. Preview」): the
 * completions over this replan's Targets (the replan Targets are the denominator, 18.7), the Targets left out this time, the Conflicts
 * and the Build List change. Each is the Preview model's own figure, never recounted; the body keeps every detail.
 */
export function runningPlanReplanAdoptionCheckItems(model: RunningPlanReplanPreviewModel): string[] {
  const completion = model.plannedCompletionTargetCount
  const excludedCount = replanTargetListCount(model.breakdown.excluded)
  const replacementCount = model.replacements.length
  const additionCount = model.additions.length
  const buildListChanges = [
    replacementCount === 0 ? null : `候補の置き換え${replacementCount}件`,
    additionCount === 0 ? null : `候補の追加${additionCount}件`,
  ].filter((item): item is string => item !== null)
  return [
    completion === null
      ? '完成予定の目標武器は不明'
      : completion === model.replanTargetCount
        ? `今回の再計画の目標武器${model.replanTargetCount}本すべてが完成予定`
        : `今回の再計画の目標武器${model.replanTargetCount}本のうち${completion}本が完成予定`,
    excludedCount === 0 ? '今回作らない目標武器なし' : `今回作らない目標武器${excludedCount}本`,
    model.conflictCount === 0 ? '競合なし' : `競合${model.conflictCount}件`,
    ...(buildListChanges.length === 0 ? ['作成リストの候補の変更なし'] : buildListChanges),
  ]
}

/**
 * The details of the re-optimization's body the adoption operations point at, when the Preview has them (Issue #324): the weapons in
 * progress, the preferred-weapon links the adoption changes, the comparison with an `active` old Plan (a `stale` one has no comparison
 * and is never called continuable here) and a Draft the adoption may affect. Null when there is none.
 */
export function runningPlanReplanAdoptionAttention(model: RunningPlanReplanPreviewModel): string | null {
  const items = [
    model.inProgressWeapons.length === 0 ? null : `作成途中の武器${model.inProgressWeapons.length}本の扱い`,
    model.linkChanges.length === 0 ? null : `優先起点の紐付けの変更${model.linkChanges.length}件`,
    model.comparison.kind === 'active' ? '現在の生産計画との比較' : null,
    model.draftAffected ? '未開始の下書きへの影響' : null,
  ].filter((item): item is string => item !== null)
  return items.length === 0 ? null : `あわせて確認：${items.join('・')}`
}

// ------------------------------------------------------------------------------------------------ adoption

export interface ReplanAdoptionConfirmationModel {
  replacementCount: number
  additionCount: number
  inProgressWeapons: { key: string; name: string; moved: boolean }[]
  linkChanges: ReplanLinkChangeView[]
}

/** The confirmation dialog's content (UI_FLOW 16.5 「5. 採用」), from the read-only adoption inspection and the start's names. */
export function createReplanAdoptionConfirmationModel(
  inspection: RunningPlanReplanAdoptionInspection,
  start: RunningPlanReplanStart,
  master: MasterDataRoot,
): ReplanAdoptionConfirmationModel {
  const resolve = createBuildListOptimizationTargetResolver(start.plannerInput.targetWeapons, master)
  const weapons = new Map(start.plannerInput.ownedWeapons.map((weapon) => [weapon.id, weapon] as const))
  return {
    replacementCount: inspection.replacements.length,
    additionCount: inspection.additions.length,
    inProgressWeapons: inspection.inProgressOwnedWeapons.map(({ ownedWeaponId, handling }) => ({
      key: ownedWeaponId,
      name: weaponNameOf(weapons, ownedWeaponId) ?? '参照できない所持武器',
      moved: handling === 'moved_to_new_plan',
    })),
    linkChanges: createReplanLinkChangeViews(inspection.startTargetLinkChanges, start, resolve),
  }
}

/**
 * Why an adoption was refused, by its typed code (18.8 R8: the shared Execution runtime codes; never the message). Every refusal
 * drops the Preview and asks for a new calculation: nothing was saved, and nothing re-calculates or re-adopts by itself.
 */
export function runningPlanReplanAdoptionRefusalMessage(code: ExecutionRuntimeErrorCode | 'transaction_failed' | null): string {
  const suffix = '何も保存していません。もう一度、現在地点から再計画を試算してください。'
  switch (code) {
    case 'replan_state_changed':
      return `試算後に状態が変わったため、採用しませんでした。${suffix}`
    case 'replan_result_invalid':
    case 'replan_plan_id_collision':
      return `この試算結果は採用できないため、採用しませんでした。${suffix}`
    case 'running_plan_invariant_violated':
      return `実行中の生産計画が複数存在するため、採用しませんでした。${suffix}`
    case 'completion_assignment_conflict':
      return `新しい生産計画が、1本の所持武器を2件の目標武器の完成品にする予定を含む（または別の目標武器の完成品を使う）ため、採用しませんでした。再計画が成立しない場合は、現在の生産計画を破棄してから作成リストで候補を見直してください。何も保存していません。`
    case 'save_point_choice_required':
    case 'save_point_choice_not_required':
    case 'save_point_changed':
    case 'save_point_not_found':
      return `表示後にゲーム内セーブ地点の記録が変わったため、採用しませんでした。${suffix}`
    case 'save_point_restore_not_allowed':
    case 'save_point_required_entity_missing':
    case 'save_point_snapshot_invalid':
    case 'save_point_restore_invalid':
      return `このゲーム内セーブ地点を安全に復元できないため、何も変更しませんでした。${suffix}`
    case 'entity_validation_failed':
    case 'collection_validation_failed':
    case 'execution_effect_inconsistent':
      return `採用すると保存状態の整合性が崩れるため、採用しませんでした。${suffix}`
    case 'transaction_failed':
      return `保存に失敗したため、採用しませんでした。${suffix}`
    default:
      return `再計画を採用できませんでした。${suffix}`
  }
}

// ------------------------------------------------------------------------------------------------ auxiliary

/** Why the auxiliary's ordinary Planner result does not make one replan Target (18.5), from its typed reason only. */
export function runningPlanReplanShortfallReasonLabel(reason: RunningPlanReplanAuxiliaryShortfallReason): string {
  switch (reason.kind) {
    case 'no_entry':
      return '作成リストに候補がありません'
    case 'entry_excluded':
      if (reason.warningKind === 'build_list_entry_stale') {
        const details = reason.staleReasons.map((stale) => staleReasonLabels[stale])
        return details.length === 0 ? '候補の再検索が必要です' : `候補の再検索が必要です（${details.join('、')}）`
      }
      return plannerWarningLabels[reason.warningKind]
    case 'search_incomplete':
      return '探索が完了していないため、作成されません'
    case 'no_plan':
      return '生産計画を作成できませんでした'
    case 'entry_rejected':
      return reason.reason === 'resource_conflict' && reason.resourceConflictCause !== null
        ? rejectedBuildListEntryResourceConflictCauseLabels[reason.resourceConflictCause]
        : rejectedBuildListEntryReasonLabels[reason.reason]
    case 'not_completed':
      return 'この試算では完成しません'
  }
}

export interface ReplanShortfallView {
  completedCount: number
  totalCount: number
  rows: { key: TargetWeaponId; target: BuildListOptimizationTargetDisplay | null; reasonLabel: string }[]
}

/**
 * The completions of the auxiliary's ordinary Planner trial for its adoption operations (Issue #324), from its shortfall view only
 * (18.5): every replan Target completed, or how many it completes and how many it does not make. A partial trial never reads as whole.
 */
export function replanShortfallAdoptionCheckItems(view: ReplanShortfallView): string[] {
  return view.rows.length === 0
    ? [`今回の再計画の目標武器${view.totalCount}本すべてが完成予定`]
    : [
        `今回の再計画の目標武器${view.totalCount}本のうち${view.completedCount}本が完成予定`,
        `この試算で作られない目標武器${view.rows.length}本`,
      ]
}

export function createReplanShortfallView(
  shortfall: RunningPlanReplanAuxiliaryShortfall,
  targetWeapons: RunningPlanReplanStart['plannerInput']['targetWeapons'],
  master: MasterDataRoot,
): ReplanShortfallView {
  const resolve = createBuildListOptimizationTargetResolver(targetWeapons, master)
  return {
    completedCount: shortfall.completedTargetWeaponIds.length,
    totalCount: shortfall.replanTargetWeaponIds.length,
    rows: shortfall.uncompleted.map(({ targetWeaponId, reason }) => ({
      key: targetWeaponId,
      target: resolve(targetWeaponId),
      reasonLabel: runningPlanReplanShortfallReasonLabel(reason),
    })),
  }
}
