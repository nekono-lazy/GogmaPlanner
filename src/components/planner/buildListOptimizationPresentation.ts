import type { MasterDataRoot } from '../../domain/master/masterTypes'
import {
  isProductionPlanCalculationCompatible,
  type BuildListEntry,
  type ExpectedPlanState,
  type ImprovementPreference,
  type OwnedWeapon,
  type ProductionPlan,
  type TargetWeapon,
  type TargetWeaponId,
} from '../../domain/models/publicTypes'
import {
  BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE,
  type BuildListOptimizationArtifact,
  type BuildListOptimizationOutOfScopeTargetCounts,
  type BuildListOptimizationResult,
  type BuildListOptimizationStage,
  type BuildListOptimizationUnsupportedReason,
} from '../../domain/planner/buildListOptimization'
import { artianWeaponKindLabels } from '../../presentation/labels'
import type {
  BuildListOptimizationSessionFailure,
  BuildListOptimizationSessionState,
} from '../../services/planner/buildListOptimizationService'
import type { BuildListOptimizationCancelReason } from '../../services/planner/buildListOptimizationWorkerClient'
import { createProductionPlanSummary } from './productionPlanPresentation'

/**
 * Presentation of the Build List global optimization (`docs/PLANNER_SPEC.md` 17.2 / 17.8 / 17.9 / 17.16, `docs/UI_FLOW.md` 10.4,
 * Issue #260 PR-6B2): the running state, the typed results and the unsaved Preview.
 *
 * Everything here reads the typed Domain result and the Application session state as they are. It decides no method, no result
 * class, no support and no offer of its own, parses no message and recomputes no Domain figure: the counts of the Preview are the
 * artifact's `summary`, `replacements` and `unchangedTargetWeaponIds` and the final Plan's own records. A Target is named by its
 * name, weapon type and element - never by its ID - and nothing that cannot be resolved is guessed.
 */

// ------------------------------------------------------------------------------------------------ running

/** The stage names of the running state (`docs/PLANNER_SPEC.md` 17.16): a name, never a completion rate. */
export const buildListOptimizationStageLabels: Record<BuildListOptimizationStage, string> = {
  input_check: '入力確認',
  reach_table: '到達条件の計算',
  assignment_search: '割当の探索',
  route_generation: 'ルートの生成',
  plan_verification: '計画の検証',
}

export const BUILD_LIST_OPTIMIZATION_RUNNING_TITLE = '生産計画を計算中'

/** The stage line of the running state; before the first stage arrives it still says the calculation is running. */
export function buildListOptimizationStageStatusText(stage: BuildListOptimizationStage | null): string {
  return stage === null ? '現在の段階：計算を開始しています' : `現在の段階：${buildListOptimizationStageLabels[stage]}`
}

export const BUILD_LIST_OPTIMIZATION_RUNNING_NOTE =
  '作成リストの目標武器全体について作成ルートを組み直しています。計算が終わると結果を表示します。'

/** A note for every device (no device-specific branch): leaving the screen ends the calculation (pagehide / unmount). */
export const BUILD_LIST_OPTIMIZATION_KEEP_SCREEN_NOTE =
  '計算中はこの画面を表示したままにしてください。画面を閉じたり別の画面へ移動したりすると、計算は中止されます。'

/**
 * U3 (`docs/PLANNER_SPEC.md` 17.16, `docs/UI_FLOW.md` 10.4): the threshold after which the running state adds the long-run notice.
 * A display threshold, never a timeout: nothing stops, cancels or changes at it, and the elapsed time stays in the screen.
 */
export const BUILD_LIST_OPTIMIZATION_LONG_RUN_NOTICE_DELAY_MS = 30_000

export const BUILD_LIST_OPTIMIZATION_LONG_RUN_NOTICE =
  '計算に時間がかかっています。処理は継続しています。途中で中止する場合は「キャンセル」を押してください。'

// ------------------------------------------------------------------------------------------------ outcomes

/**
 * What a finished optimization session shows: the typed result (the Application's `running_plan_exists` refusal included), the
 * cancellation, or the failure. Running and idle states are no outcome.
 */
export type BuildListOptimizationOutcome =
  | { kind: 'result'; result: BuildListOptimizationResult }
  | { kind: 'cancelled'; reason: BuildListOptimizationCancelReason }
  | { kind: 'failed'; failure: BuildListOptimizationSessionFailure }

/** The outcome of the session state as it is, or null while nothing finished (idle, preparing, running, disposed). */
export function buildListOptimizationOutcomeOf(state: BuildListOptimizationSessionState): BuildListOptimizationOutcome | null {
  switch (state.status) {
    case 'completed':
      return { kind: 'result', result: state.completion.result }
    case 'cancelled':
      return { kind: 'cancelled', reason: state.reason }
    case 'failed':
      return { kind: 'failed', failure: state.failure }
    case 'idle':
    case 'preparing':
    case 'running':
    case 'disposed':
      return null
  }
}

/** Every outcome says the saved data stayed as it was (`docs/UI_FLOW.md` 10.4 「結果別の表示」). */
export const BUILD_LIST_OPTIMIZATION_UNCHANGED_MESSAGE = '作成リストと保存済みの生産計画は変更されていません。'

export const BUILD_LIST_OPTIMIZATION_NOT_FOUND_TITLE = '組み合わせを見つけられませんでした'
export const BUILD_LIST_OPTIMIZATION_NOT_FOUND_MESSAGE =
  '現在の探索範囲では、今回の計画対象の目標武器すべてが完成する組み合わせを見つけられませんでした。'
export const BUILD_LIST_OPTIMIZATION_NOT_FOUND_NOTE = '組み合わせが存在しないという意味ではありません。'

export const BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_TITLE = '結果を確定できませんでした'
export const BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_MESSAGE = '探索の上限に達したため、結果を確定できませんでした。'
export const BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_NOTE = '成立する組み合わせが無いという意味ではありません。'

export const BUILD_LIST_OPTIMIZATION_UNSUPPORTED_TITLE = 'この作成リストでは全体最適化を使えません'
export const BUILD_LIST_OPTIMIZATION_UNSUPPORTED_INTRO = '次の理由により、全体最適化の計算は行っていません。'

export const buildListOptimizationCancelMessages: Record<BuildListOptimizationCancelReason, string> = {
  cancelled: '全体最適化の計算をキャンセルしました。',
  superseded: '新しい計算を開始したため、前の計算を中止しました。',
  disposed: '画面を離れたため、全体最適化の計算を中止しました。',
  page_hidden: 'ページを閉じたか移動したため、全体最適化の計算を中止しました。',
}

/**
 * A failure is an error, never a result (`docs/PLANNER_SPEC.md` 17.8): a calculation that could not run or finish
 * (`calculation_failed`), or a broken premise or contract (`contract_violation`), which is never shown as unsupported or not found.
 * No cause is presumed - in particular never a lack of memory.
 */
export type BuildListOptimizationFailureCategory = 'calculation_failed' | 'contract_violation'

export interface BuildListOptimizationFailurePresentation {
  category: BuildListOptimizationFailureCategory
  message: string
  /** Running again can help (a read or Worker failure); a contract violation repeats on the same input. */
  retryable: boolean
}

export const BUILD_LIST_OPTIMIZATION_FAILURE_TITLE = '計算を完了できませんでした'
export const BUILD_LIST_OPTIMIZATION_CONTRACT_VIOLATION_NOTE =
  'この結果は「全体最適化を使えない」や「組み合わせが見つからなかった」という意味ではありません。'

/** The failure as its typed kind says; the Worker's message is Debug Mode only and is never parsed. */
export function presentBuildListOptimizationFailure(failure: BuildListOptimizationSessionFailure): BuildListOptimizationFailurePresentation {
  switch (failure.kind) {
    case 'worker_unavailable':
      return {
        category: 'calculation_failed',
        message: 'この環境では計算用のWorkerを利用できないため、全体最適化を実行できませんでした。',
        retryable: false,
      }
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
      return {
        category: 'calculation_failed',
        message: '作成リストと生産計画の状態を読み込めなかったため、計算を開始できませんでした。もう一度試してください。',
        retryable: true,
      }
    case 'calculation_error':
      switch (failure.code) {
        case 'calculation_failed':
          return {
            category: 'calculation_failed',
            message: '計算中にエラーが発生したため、計算を完了できませんでした。もう一度試してください。',
            retryable: true,
          }
        case 'invariant_violation':
        case 'materialization_failed':
          return {
            category: 'contract_violation',
            message: '計算結果の確認で前提に合わない状態が見つかったため、計算を完了できませんでした。',
            retryable: false,
          }
        case 'invalid_request':
        case 'worker_already_used':
        case 'search_bounds_unavailable':
          return {
            category: 'contract_violation',
            message: '計算の要求がアプリの前提に合わなかったため、計算を完了できませんでした。',
            retryable: false,
          }
      }
      break
    case 'protocol_violation':
    case 'invalid_result':
      return {
        category: 'contract_violation',
        message: '計算結果を確認できなかったため、この結果は表示しません。',
        retryable: false,
      }
  }
  // Every kind and code returns above; an unknown one is a contract violation, never a result.
  return { category: 'contract_violation', message: '計算を完了できませんでした。', retryable: false }
}

// ------------------------------------------------------------------------------------------------ names

/** A Target as the screen names it: its name and its weapon type / element from the Master. `key` is for React only. */
export interface BuildListOptimizationTargetDisplay {
  key: TargetWeaponId
  name: string
  weaponLabel: string
}

export type BuildListOptimizationTargetResolver = (targetWeaponId: TargetWeaponId) => BuildListOptimizationTargetDisplay | null

/** Resolves Targets from the given collection only; an ID it does not hold resolves to null (never to the ID). */
export function createBuildListOptimizationTargetResolver(
  targetWeapons: readonly TargetWeapon[] | null,
  master: MasterDataRoot,
): BuildListOptimizationTargetResolver {
  const targets = new Map((targetWeapons ?? []).map((target) => [target.id, target] as const))
  const weaponTypeNames = new Map(master.weaponTypes.map((type) => [type.id, type.displayNameJa] as const))
  const elementNames = new Map(master.elements.map((element) => [element.id, element.displayNameJa] as const))
  return (targetWeaponId) => {
    const target = targets.get(targetWeaponId)
    if (target === undefined) return null
    return {
      key: target.id,
      name: target.name,
      weaponLabel: `${weaponTypeNames.get(target.weaponTypeId) ?? '不明な武器種'} / ${elementNames.get(target.elementId) ?? '不明な属性'}`,
    }
  }
}

/** The resolved Targets in the given order without repetition, and how many could not be resolved (never shown as IDs). */
export interface BuildListOptimizationTargetList {
  targets: BuildListOptimizationTargetDisplay[]
  unresolvedCount: number
}

export function resolveBuildListOptimizationTargets(
  targetWeaponIds: readonly TargetWeaponId[],
  resolve: BuildListOptimizationTargetResolver,
): BuildListOptimizationTargetList {
  const seen = new Set<TargetWeaponId>()
  const targets: BuildListOptimizationTargetDisplay[] = []
  let unresolvedCount = 0
  for (const id of targetWeaponIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const target = resolve(id)
    if (target === null) unresolvedCount += 1
    else targets.push(target)
  }
  return { targets, unresolvedCount }
}

export const UNRESOLVED_TARGET_LABEL = '参照できない目標武器'

// ------------------------------------------------------------------------------------------------ unsupported

export interface BuildListOptimizationUnsupportedReasonPresentation {
  kind: BuildListOptimizationUnsupportedReason['kind']
  title: string
  description: string
  /** The Targets the reason names (empty when it names none). */
  targets: BuildListOptimizationTargetList
  /** What is missing (the unconfirmed RNG values), by name - never a value. */
  missingItems: string[]
  /** Where the user can resolve it. */
  links: { to: string; label: string }[]
}

const unconfirmedRngItemLabels: Record<Extract<BuildListOptimizationUnsupportedReason, { kind: 'unconfirmed_rng_state' }>['missing'][number], string> = {
  base_seed: 'Base Seed（基準シード）',
  skill_counter: 'スキルカウンター',
  gogma_counter: '巨戟カウンター',
}

const noTargets: BuildListOptimizationTargetList = { targets: [], unresolvedCount: 0 }

/** One typed unsupported reason (`docs/PLANNER_SPEC.md` 17.4): what it means, the Targets it names and where to resolve it. */
export function presentBuildListOptimizationUnsupportedReason(
  reason: BuildListOptimizationUnsupportedReason,
  resolve: BuildListOptimizationTargetResolver,
): BuildListOptimizationUnsupportedReasonPresentation {
  switch (reason.kind) {
    case 'running_plan_exists':
      return {
        kind: reason.kind,
        title: '実行中の生産計画があります',
        description:
          '実行中（または再計算が必要）の生産計画がある間は、新しい生産計画の作成と全体最適化は使えません。現在地点からの再計画を試算するか、生産計画を完了・破棄してください。',
        targets: noTargets,
        missingItems: [],
        links: [{ to: '/plans', label: '生産計画一覧を見る' }],
      }
    case 'invalid_planner_input':
      return {
        kind: reason.kind,
        title: '作成リストに整理が必要な項目があります',
        description:
          '同じ目標武器の候補の重複や、途中採用状態の選択の不整合などがあるため、生産計画を作成できません。作成リストで「要整理」と表示された目標武器を確認してください。',
        targets: noTargets,
        missingItems: [],
        links: [],
      }
    case 'no_planning_target':
      return {
        kind: reason.kind,
        title: '有効な候補がありません',
        description:
          '再検索が必要な候補や完了済みの目標武器の候補は、計画の対象になりません。候補検索で候補を作成リストへ追加してください。',
        targets: noTargets,
        missingItems: [],
        links: [{ to: '/search', label: '候補検索へ' }],
      }
    case 'checkpoint_selection':
      return {
        kind: reason.kind,
        title: '途中採用する状態を選択している候補があります',
        description:
          '全体最適化は、作成リストで選択した途中採用状態を自動で解除したり読み替えたりしません。全体最適化を使う場合は、作成リストで該当する目標武器の候補の選択を解除してください。',
        targets: resolveBuildListOptimizationTargets(reason.entries.map(({ targetWeaponId }) => targetWeaponId), resolve),
        missingItems: [],
        links: [],
      }
    case 'unconfirmed_rng_state':
      return {
        kind: reason.kind,
        title: 'RNG状態の一部が確定していません',
        description: '全体最適化には、次の値の確定が必要です。RNG状態設定で確定してください。',
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
          '起点にできる所持武器が無く、通常アーティアの予測に対応していないため、全体最適化では扱えない目標武器があります。起点にできる所持武器を登録すると扱える場合があります。',
        targets: resolveBuildListOptimizationTargets(reason.targetWeaponIds, resolve),
        missingItems: [],
        links: [{ to: '/owned-weapons', label: '所持武器へ' }],
      }
  }
}

// ------------------------------------------------------------------------------------------------ ordinary Planner auxiliary

/** The ordinary Planner auxiliary operation (`docs/UI_FLOW.md` 10.4 「通常Plannerの補助導線」); its final name is the screen PR's. */
export const ORDINARY_PLANNER_AUXILIARY_LABEL = '登録済みの候補で生産計画を作成'

export const ORDINARY_PLANNER_AUXILIARY_NOTES: readonly string[] = [
  '作成リストに登録したルートをそのまま使い、全体最適化によるルートの組み直しはしません。',
  'すべての目標武器が完成すること、競合が無いことは保証しません。',
  '作成リストの候補・途中採用状態の選択・改善優先は変更されません。現在の下書きがある場合は、作成した計画の保存時に置き換えられます。',
]

/** U7: shown next to the auxiliary operation while the ordinary Planner setting is invalid. */
export const ORDINARY_PLANNER_AUXILIARY_OPTIONS_INVALID_MESSAGE =
  '通常Plannerの詳細設定の「最大計画ステップ数」が無効なため、開始できません。1以上の整数を入力してください。'

// ------------------------------------------------------------------------------------------------ Preview

export const BUILD_LIST_OPTIMIZATION_PREVIEW_TITLE = '全体最適化の試算（未採用）'
export const BUILD_LIST_OPTIMIZATION_PREVIEW_UNCHANGED_MESSAGE =
  'まだ作成リストと生産計画は変更されていません。この試算は保存されておらず、画面を離れると消えます。'
export const BUILD_LIST_OPTIMIZATION_PREVIEW_DESCRIPTION =
  '作成リストの目標武器全体について作成ルートを組み直し、生産計画として成立することを確認した試算です。最短であることは保証しません。'
export const BUILD_LIST_OPTIMIZATION_PREVIEW_DRAFT_REPLACED_MESSAGE =
  '採用すると、現在の未開始の生産計画（下書き）はこの計画に置き換わります。'

/**
 * The start-time state the calculation was judged and run on: its Build List, Targets and owned weapons (structurally the
 * `PlannerInput` the plan creation boundary read, which the caller keeps beside the result). The Preview reads the replaced Entries,
 * the Target names and preferences and the owned weapon names from it, and never from a later read: a current snapshot is a
 * different state and would mix the start-time route bases with today's.
 */
export interface BuildListOptimizationPreviewStartContext {
  buildListEntries: readonly BuildListEntry[]
  targetWeapons: readonly TargetWeapon[]
  ownedWeapons: readonly OwnedWeapon[]
}

/** Where a Route starts: a new Normal Artian, an owned weapon, or something the start context cannot tell. */
export type BuildListOptimizationRouteBase =
  | { kind: 'new_normal' }
  | { kind: 'owned'; name: string; weaponKindLabel: string }
  /** The Route names an owned weapon the start context does not hold. */
  | { kind: 'owned_unresolved' }
  /** The replaced Entry is not in the start context (or no start context was given): nothing is guessed. */
  | { kind: 'unavailable' }

export function buildListOptimizationRouteBaseLabel(base: BuildListOptimizationRouteBase): string {
  switch (base.kind) {
    case 'new_normal':
      return '新規の通常アーティア'
    case 'owned':
      return `${base.name}（${base.weaponKindLabel}）`
    case 'owned_unresolved':
      return '参照できない所持武器'
    case 'unavailable':
      return '確認できません'
  }
}

export interface BuildListOptimizationReplacementView {
  /** React key only (the generated Entry ID); never shown. */
  key: string
  target: BuildListOptimizationTargetDisplay | null
  before: BuildListOptimizationRouteBase
  after: BuildListOptimizationRouteBase
  /** Whether the Route base changed; null when the replaced Entry's base is unknown. */
  sourceChanged: boolean | null
  /** The Target's preferred owned weapon when the new Route does not start from it (17.14), else null. */
  preferredSourceNotUsed: { preferredName: string } | null
  /** The replaced Entry's improvement preference; null when the replaced Entry is unknown. */
  previousImprovementPreference: ImprovementPreference | null
}

export interface BuildListOptimizationOutOfScopeRow {
  key: keyof BuildListOptimizationOutOfScopeTargetCounts
  label: string
  count: number
}

const outOfScopeLabels: Record<keyof BuildListOptimizationOutOfScopeTargetCounts, string> = {
  noEntry: '作成リストに候補なし',
  excludedEntryOnly: '候補が計画の対象外（再検索が必要など）',
  disabled: '検索対象OFF',
  completed: '完了済み',
}

export interface BuildListOptimizationPreviewModel {
  plan: ProductionPlan
  /** The distinct Targets of the final Plan's `executionEffects.targetCompletions` (UI_FLOW 11.0), or null for a legacy Plan. */
  plannedCompletionTargetCount: number | null
  /** `summary.totalTargetCount`: this run's planning Targets, the only denominator. */
  planningTargetCount: number
  outOfScopeTotal: number
  outOfScopeRows: BuildListOptimizationOutOfScopeRow[]
  physicalOperationCount: number
  planStepCount: number
  nonPhysicalStepCount: number
  conflictCount: number
  replacements: BuildListOptimizationReplacementView[]
  unchangedTargets: BuildListOptimizationTargetList
  /** The replacements whose improvement preference returns to `planner` (17.5). */
  preferenceResets: BuildListOptimizationReplacementView[]
  /** The replacements that do not start from the Target's preferred owned weapon (17.14). */
  preferredSourceDifferences: BuildListOptimizationReplacementView[]
  /** False when no start context was given: the replaced Entries' bases and preferences are then not shown. */
  startContextAvailable: boolean
}

function routeBaseOf(entry: BuildListEntry, ownedWeapons: ReadonlyMap<string, OwnedWeapon>): BuildListOptimizationRouteBase {
  const sourceId = entry.candidateSnapshot.route.sourceOwnedWeaponId
  if (sourceId === null) return { kind: 'new_normal' }
  const weapon = ownedWeapons.get(sourceId)
  return weapon === undefined
    ? { kind: 'owned_unresolved' }
    : { kind: 'owned', name: weapon.name, weaponKindLabel: artianWeaponKindLabels[weapon.kind] }
}

/**
 * The Preview of an `optimized` artifact (`docs/PLANNER_SPEC.md` 17.9). The figures are the artifact's own: `summary` for the
 * planning Targets, the out-of-scope breakdown and the operation / step counts, `replacements` and `unchangedTargetWeaponIds` for
 * the Build List change, and the final Plan for the completions and the Conflicts. The replaced Entries, the names and the
 * preferences come from the start context only. Returns null when the artifact carries no Plan (an `optimized` artifact always does:
 * the Worker result check refuses one without it).
 */
export function createBuildListOptimizationPreviewModel(
  artifact: BuildListOptimizationArtifact,
  startContext: BuildListOptimizationPreviewStartContext | null,
  master: MasterDataRoot,
): BuildListOptimizationPreviewModel | null {
  const plan = artifact.plannerResult.plan
  if (plan === null) return null
  const { summary } = artifact
  const resolve = createBuildListOptimizationTargetResolver(startContext?.targetWeapons ?? null, master)
  const startEntries = new Map((startContext?.buildListEntries ?? []).map((entry) => [entry.id, entry] as const))
  const startTargets = new Map((startContext?.targetWeapons ?? []).map((target) => [target.id, target] as const))
  const ownedWeapons = new Map((startContext?.ownedWeapons ?? []).map((weapon) => [weapon.id, weapon] as const))
  const generatedEntries = new Map(artifact.generatedBuildListEntries.map((entry) => [entry.id, entry] as const))

  const replacements = artifact.replacements.map((replacement): BuildListOptimizationReplacementView => {
    const generated = generatedEntries.get(replacement.generatedBuildListEntryId)
    const replaced = startEntries.get(replacement.replacedBuildListEntryId)
    const after: BuildListOptimizationRouteBase = generated === undefined ? { kind: 'unavailable' } : routeBaseOf(generated, ownedWeapons)
    const before: BuildListOptimizationRouteBase = replaced === undefined ? { kind: 'unavailable' } : routeBaseOf(replaced, ownedWeapons)
    const afterSourceId = generated?.candidateSnapshot.route.sourceOwnedWeaponId
    const beforeSourceId = replaced?.candidateSnapshot.route.sourceOwnedWeaponId
    const target = startTargets.get(replacement.targetWeaponId)
    const preferredId = target?.preferredOwnedWeaponId ?? null
    let preferredSourceNotUsed: BuildListOptimizationReplacementView['preferredSourceNotUsed'] = null
    if (preferredId !== null && generated !== undefined && afterSourceId !== preferredId) {
      preferredSourceNotUsed = { preferredName: ownedWeapons.get(preferredId)?.name ?? '参照できない所持武器' }
    }
    return {
      key: replacement.generatedBuildListEntryId,
      target: resolve(replacement.targetWeaponId),
      before,
      after,
      sourceChanged: replaced === undefined || generated === undefined ? null : beforeSourceId !== afterSourceId,
      preferredSourceNotUsed,
      previousImprovementPreference: replaced === undefined ? null : replaced.intermediateStateSelection?.improvementPreference ?? 'planner',
    }
  })

  const outOfScopeRows = (Object.keys(outOfScopeLabels) as (keyof BuildListOptimizationOutOfScopeTargetCounts)[]).map((key) => ({
    key,
    label: outOfScopeLabels[key],
    count: summary.outOfScopeTargetCounts[key],
  }))

  return {
    plan,
    plannedCompletionTargetCount: createProductionPlanSummary(plan).plannedCompletionTargetCount,
    planningTargetCount: summary.totalTargetCount,
    outOfScopeTotal: outOfScopeRows.reduce((total, row) => total + row.count, 0),
    outOfScopeRows,
    physicalOperationCount: summary.physicalOperationCount,
    planStepCount: summary.planStepCount,
    nonPhysicalStepCount: summary.nonPhysicalStepCount,
    conflictCount: plan.conflicts.length,
    replacements,
    unchangedTargets: resolveBuildListOptimizationTargets(artifact.unchangedTargetWeaponIds, resolve),
    preferenceResets: replacements.filter(({ previousImprovementPreference }) =>
      previousImprovementPreference !== null && previousImprovementPreference !== 'planner'),
    preferredSourceDifferences: replacements.filter(({ preferredSourceNotUsed }) => preferredSourceNotUsed !== null),
    startContextAvailable: startContext !== null,
  }
}

// ------------------------------------------------------------------------------------------------ current Draft comparison

export interface BuildListOptimizationComparisonRow {
  key: 'completion' | 'physical_operations' | 'plan_steps' | 'conflicts'
  label: string
  draft: string
  preview: string
}

export type BuildListOptimizationDraftComparison =
  | { status: 'no_draft' }
  /** A Draft exists but was not made from the same input state: no figure is compared or guessed. */
  | { status: 'not_comparable' }
  | { status: 'comparable'; rows: BuildListOptimizationComparisonRow[] }

function sameExpectedPlanState(left: ExpectedPlanState, right: ExpectedPlanState): boolean {
  return left.rngStateHash === right.rngStateHash && left.normalCountersHash === right.normalCountersHash
    && left.ownedWeaponsHash === right.ownedWeaponsHash && left.targetExecutionStateHash === right.targetExecutionStateHash
}

/**
 * Whether the current Draft was made from the same input state as the optimization (`docs/PLANNER_SPEC.md` 17.9): a `draft` Plan whose
 * CalculationContext (its own and its snapshot's) is compatible with the optimization input's, and whose `baseSnapshot`
 * `initialExecutionState`, `targetWeaponsHash` and `buildListEntriesHash` equal the input token's `initialExecutionState`,
 * `targetWeaponsHash` and `inputBuildListEntriesHash`. CalculationContext compatibility is the one Plan authority
 * `isProductionPlanCalculationCompatible()` against the input's CalculationContext (`docs/PLANNER_SPEC.md` 9.6.10): exact
 * four-field equality, or the explicit resolution-free `18 -> 17` Plan exception.
 */
export function isDraftComparableWithBuildListOptimization(draft: ProductionPlan, artifact: BuildListOptimizationArtifact): boolean {
  const token = artifact.inputToken
  return draft.status === 'draft'
    && isProductionPlanCalculationCompatible(draft, token.calculationContext)
    && sameExpectedPlanState(draft.baseSnapshot.initialExecutionState, token.initialExecutionState)
    && draft.baseSnapshot.targetWeaponsHash === token.targetWeaponsHash
    && draft.baseSnapshot.buildListEntriesHash === token.inputBuildListEntriesHash
}

const conflictCountText = (count: number): string => (count === 0 ? 'なし' : `${count}件`)
const countText = (count: number | null): string => (count === null ? '不明' : String(count))

/**
 * The current Draft beside the Preview, only when both come from the same input state. The Draft's figures are its own records
 * (completions from `targetCompletions`, physical operations as its Steps less `confirm_owned_ideal`, Steps, Conflict records); no
 * ordinary Planner runs for it and nothing ranks the two.
 */
export function compareBuildListOptimizationWithDraft(
  artifact: BuildListOptimizationArtifact,
  draft: ProductionPlan | null,
): BuildListOptimizationDraftComparison {
  if (draft === null) return { status: 'no_draft' }
  const plan = artifact.plannerResult.plan
  if (plan === null || !isDraftComparableWithBuildListOptimization(draft, artifact)) return { status: 'not_comparable' }
  const draftSummary = createProductionPlanSummary(draft)
  const draftNonPhysical = draft.steps.filter(({ operationType }) => operationType === BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE).length
  const { summary } = artifact
  return {
    status: 'comparable',
    rows: [
      {
        key: 'completion',
        label: `完成予定の目標武器数（今回の計画対象${summary.totalTargetCount}本中）`,
        draft: countText(draftSummary.plannedCompletionTargetCount),
        preview: countText(createProductionPlanSummary(plan).plannedCompletionTargetCount),
      },
      {
        key: 'physical_operations',
        label: 'ゲーム内の操作回数',
        draft: String(draft.steps.length - draftNonPhysical),
        preview: String(summary.physicalOperationCount),
      },
      { key: 'plan_steps', label: '計画ステップ数', draft: String(draft.steps.length), preview: String(summary.planStepCount) },
      { key: 'conflicts', label: '競合（記録件数）', draft: conflictCountText(draft.conflicts.length), preview: conflictCountText(plan.conflicts.length) },
    ],
  }
}

export const BUILD_LIST_OPTIMIZATION_NO_COMPARABLE_DRAFT_MESSAGE = '比較できる現在の生産計画（下書き）はありません。'
export const BUILD_LIST_OPTIMIZATION_DRAFT_NOT_COMPARABLE_DETAIL =
  '現在の下書きは、この試算とは異なる作成リスト・目標武器・状態から作られているため、数値を並べて比較しません。'
