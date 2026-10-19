import type {
  BuildListEntryStaleReason,
  RecalculationReason,
  CompromiseConditionMatch,
  ConflictKind,
  ImprovementPreference,
  NormalArtianRarity,
  OwnedWeaponStatus,
  PlanStepOperationType,
  ProductionPlanStatus,
  ProductionPlanAbandonmentReason,
  RejectedBuildListEntry,
  RejectedBuildListEntryResourceConflictCause,
  RngStateSource,
  RouteKind,
  RouteOperation,
  ArtianWeaponKind,
} from '../domain/models/publicTypes'
import { isBlindCreateNormalArtianOperation } from '../domain/models/publicTypes'
import type { SkillMatchMode } from '../domain/models/common'
import type { ArtianBonusScope } from '../domain/master/masterTypes'
import type {
  CandidateRouteFilter,
  CandidateSearchNoticeSeverity,
  CandidateSearchProgressPhase,
  SkippedRouteReason,
} from '../domain/search'
import type { RngCapabilityMissingRequirement } from '../domain/rng/capabilities'
import type { PlannerWarningKind } from '../domain/planner'

export const ownedWeaponStatusLabels: Record<OwnedWeaponStatus, string> = {
  unclassified: '未分類',
  practical: '実用',
  ideal: '理想',
}

export const artianWeaponKindLabels: Record<ArtianWeaponKind, string> = {
  normal: '通常アーティア',
  gogma: '巨戟アーティア',
}

/**
 * The restoration bonus scope a weapon currently holds, in the everyday wording
 * of `docs/UI_FLOW.md` 3.3. A Gogma weapon keeps `normal_artian` slots
 * inherited at conversion until its first bonus amendment (`docs/UI_FLOW.md` 7 /
 * `docs/DATA_MODEL.md` 7.1). The internal scope ids never change; the labels
 * name the bonus family a user sees in the game and leak no internal term.
 */
export const restorationBonusScopeLabels: Record<ArtianBonusScope, string> = {
  normal_artian: '通常アーティア系',
  gogma_artian: '巨戟アーティア系',
}

/** The field name every normal-user screen uses for the restoration bonus scope. */
export const restorationBonusScopeFieldLabel = '復元ボーナスの種類'

/**
 * Explains, where a Gogma weapon's scope is chosen, why a converted weapon
 * still holds the normal family (`docs/UI_FLOW.md` 3.3 / 7).
 */
export const restorationBonusScopeGogmaHelpText =
  '巨戟化直後、まだ復元ボーナス変更前は「通常アーティア系」です。'

export const skillMatchModeLabels: Record<SkillMatchMode, string> = {
  all: 'すべて一致',
  any: 'いずれか一致',
}

/**
 * How one compromise checkpoint state rates on each Target axis.
 *
 * Explanatory display only: an intermediate state is never an independent
 * Candidate, so these labels classify a lane state of the canonical Ideal
 * Route and the compromise checkpoint it forms, not a category.
 */
export const compromiseBonusMatchLabels: Record<
  CompromiseConditionMatch['bonus'],
  string
> = {
  ideal: '理想',
  practical: '実用',
  alternative: '代替',
}

export const compromiseSkillMatchLabels: Record<
  CompromiseConditionMatch['skill'],
  string
> = {
  ideal: '理想',
  practical: '実用',
}

/** The improvement order the user asks the Planner to prefer after the checkpoint. */
export const improvementPreferenceLabels: Record<ImprovementPreference, string> = {
  planner: '生産計画に任せる',
  skill_first: 'スキルを優先',
  bonus_first: '復元ボーナスを優先',
}

/** The short badge one compromise checkpoint shows: the weaker of its two axes. */
export function compromiseCheckpointBadgeLabel(
  conditionMatch: CompromiseConditionMatch,
): string {
  if (conditionMatch.bonus === 'alternative') return '代替'
  return conditionMatch.bonus === 'practical' || conditionMatch.skill === 'practical'
    ? '実用'
    : '理想'
}

export const routeKindLabels: Record<RouteKind, string> = {
  normal_artian_to_gogma: '新規通常アーティアから巨戟化',
  owned_normal_artian_to_gogma: '所持通常アーティアから巨戟化',
  existing_gogma_current: '所持巨戟の現在性能（操作なし）',
  existing_gogma_reset_bonuses: '所持巨戟の復元ボーナス再抽選',
  existing_gogma_keep_bonuses: '所持巨戟の復元ボーナス保持再抽選',
  existing_gogma_reset_skills: '所持巨戟のスキル再抽選',
  existing_gogma_mixed: '所持巨戟の複合ルート',
}

/**
 * `abandoned` reads as 終了, not 破棄済み: it covers the user's own abandonment
 * as well as replan adoption, finishing as a compromise and an approved
 * breaking change (`docs/PLANNER_SPEC.md` 16.2), so the reason label beside it
 * says which.
 */
export const productionPlanStatusLabels: Record<ProductionPlanStatus, string> = {
  draft: '下書き',
  active: '実行中',
  completed: '完了',
  stale: '再計算が必要',
  abandoned: '終了',
}

/**
 * Why a `stale` Plan needs recalculation (`docs/DATA_MODEL.md` 11.1,
 * `docs/PLANNER_SPEC.md` 16.6). Every `RecalculationReason` is named here, the
 * legacy ones included, so a persisted reason is never shown as a raw enum.
 */
export const productionPlanRecalculationReasonLabels: Record<RecalculationReason, string> = {
  rng_state_changed: 'RNG状態が変更されています',
  normal_counter_changed: '通常アーティアカウンターが変更されています',
  target_changed: '目標武器が変更されています',
  build_list_changed: 'ビルドリストが変更されています',
  owned_weapon_changed: '所持武器が変更されています',
  calculation_context_changed: 'ゲーム・マスターデータ・予測エンジンのバージョンに互換性がありません',
  unexpected_result: '想定外の結果が記録されています',
  execution_operation_uncertain: '操作内容が不明と記録されています',
  planned_candidate_not_secured: '計画した候補を確保できませんでした',
  different_candidate_secured: '別の候補を確保しました',
  manual_recalculate: '手動で再計算が要求されています',
}

/** Why an `abandoned` Plan ended (`docs/PLANNER_SPEC.md` 16.2). */
export const productionPlanAbandonmentReasonLabels: Record<ProductionPlanAbandonmentReason, string> = {
  user_abandoned: 'ユーザーが破棄',
  replan_adopted: '再計画を採用',
  finished_as_compromise: '妥協品で終了',
  breaking_change_approved: '前提を壊す変更を承認',
}

/**
 * Why the Planner left a BuildListEntry out of a persisted Plan
 * (`docs/DATA_MODEL.md` 11.9). Display only: the persisted `detail` string is
 * shown beside it and is never parsed to decide anything.
 */
export const rejectedBuildListEntryReasonLabels: Record<
  RejectedBuildListEntry['reason'],
  string
> = {
  lower_priority: '優先度の高い目標武器の候補を優先しました',
  resource_conflict: '他の候補と資源（RNG位置または所持武器）が競合しました',
  longer_route: 'より短い作成ルートの候補を優先しました',
  already_satisfied: '目標武器はすでに満たされています',
  requires_protected_weapon: '保護中の武器を変更する必要があるため使用できません',
  dominated_by_better_candidate: 'より良い候補があるため採用されませんでした',
}

/**
 * Why a `resource_conflict` rejection is one, when the Plan recorded its cause
 * (Issue #121, `docs/DATA_MODEL.md` 11.9, `docs/UI_FLOW.md` 11.6.5). A stuck
 * drop (deadlock / stall) is never said to be a resource conflict: only the
 * explicit decision and the provisional outcome establish a competition with
 * another Target. A record without a cause keeps the reason label above.
 */
export const rejectedBuildListEntryResourceConflictCauseLabels: Record<
  RejectedBuildListEntryResourceConflictCause,
  string
> = {
  explicit_resolution_not_selected: '競合で別の候補を優先したため、採用されませんでした',
  provisional_outcome_not_committed: '未選択の競合で、Plannerが暫定的に別の候補を作成予定にしたため、採用されませんでした',
  stuck_drop_without_other_routes: '計画の途中で、この候補の作成手順を先へ進められなくなったため、採用されませんでした',
  stuck_drop_with_other_routes:
    '計画の途中で作成手順が行き詰まったため、採用されませんでした。ほかの目標武器との競合によるものかは確認できません',
}

/** The shared resource a persisted `PlanConflict` competes for (`docs/DATA_MODEL.md` 11.8). */
export const conflictKindLabels: Record<ConflictKind, string> = {
  same_gogma_counter: '同じ巨戟カウンター位置',
  same_skill_counter: '同じスキルカウンター位置',
  same_normal_counter: '同じ通常アーティアカウンター位置',
  same_owned_weapon_consumed: '同じ所持武器の使用',
}

export const planStepOperationLabels: Record<PlanStepOperationType, string> = {
  create_normal_artian: '通常アーティアを作成',
  convert_normal_to_gogma: '巨戟アーティアへ変換',
  reset_bonuses: '復元ボーナスをリセット',
  keep_bonuses: '復元ボーナスを保持して再抽選',
  reset_skills: 'スキルをリセット',
  confirm_owned_ideal: '所持している理想品を確認',
  reserve_weapon: '目標武器として確保',
  confirm_result: '結果を確認',
}

export const plannerWarningLabels: Record<PlannerWarningKind, string> = {
  no_build_list_entries: '利用できるビルドリスト項目がありません',
  rng_state_missing: '必要なRNG状態または予測機能が不足しています',
  rng_prediction_unsupported: '指定されたRNG予測入力には対応していません',
  protected_weapon_required: '保護中の武器が必要なため実行できません',
  build_list_entry_stale: '再検索が必要なビルドリスト項目があります',
  calculation_context_incompatible: '計算に使用したバージョンに互換性がありません',
  all_targets_already_satisfied: 'すべての目標武器をすでに満たしています',
  invalid_conflict_resolution: '選択した競合解決を現在の状態へ適用できません',
  max_steps_reached: '計画ステップ数の上限に到達しました',
  multiple_selected_checkpoint_entries:
    '同じ目標武器に途中採用する状態を選択した候補が2件以上あります。作成リストで片方の選択を解除してください',
  selected_checkpoint_target_already_ideal:
    '既に理想品を所持している目標武器に途中採用する状態が選択されています。作成リストでその選択を解除してください',
  selected_checkpoint_fixes_target_entry:
    '途中採用する状態を選択した候補がある目標武器では、その候補だけを作成ルートとして扱い、同じ目標武器の他の候補は使用しません',
  completed_target_excluded: '完了済みの目標武器は生産計画の対象外です',
  duplicate_build_list_entries_for_target:
    '同じ目標武器に複数の作成リスト候補が登録されています。使用する候補を1件にしてください',
  invalid_checkpoint_selection:
    '途中採用する状態の選択内容が候補の内容と一致しません。作成リストでその候補の選択を解除し、必要なら候補を追加し直してください',
}

export const candidateRouteFilterLabels: Record<CandidateRouteFilter, string> = {
  all: 'すべての作成ルート',
  normal_artian: '通常アーティア経由',
  existing_gogma: '所持巨戟アーティア経由',
}

/**
 * The Target-internal work total is discovered while searching, so the phase is
 * an activity signal. Never present it, or `processedWorkItems`, as a percent.
 */
export const candidateSearchProgressPhaseLabels: Record<CandidateSearchProgressPhase, string> = {
  preparing: '準備中',
  searching: '探索中',
  finalizing: '結果を整理中',
}

/**
 * A search that succeeded under a narrower method is an ordinary result, not a
 * failure, so it is headed as a notice rather than a warning.
 */
export const candidateSearchNoticeSeverityLabels: Record<CandidateSearchNoticeSeverity, string> = {
  info: 'お知らせ',
  warning: '警告',
}

export const skippedRouteReasonLabels: Record<SkippedRouteReason, string> = {
  normal_counter_unconfirmed: '対象の通常アーティアカウンターを検索に使用できません',
  // Used by both owned Normal Artian and existing Gogma routes, so the label
  // stays weapon-kind neutral; the RouteKind label names the concrete route.
  no_owned_weapon_available: '条件に合う所持武器がありません',
  no_unprotected_source_weapon: '破壊的操作に使える未保護武器がありません',
  gogma_capability_missing: '巨戟アーティア予測に必要なRNG状態が不足しています',
  skill_capability_missing: 'スキル予測に必要なRNG状態が不足しています',
  keep_prediction_unsupported: '復元ボーナス保持予測は現在の予測エンジンで利用できません',
  calculation_context_incompatible: '計算に使用したバージョンに互換性がありません',
  disabled_by_filter: '検索条件で除外されています',
  master_data_unavailable: '作成ルートに必要なマスターデータが利用できません',
  rng_state_unconfirmed: '確認済みのRNG状態が不足しています',
  normal_prediction_unsupported: '通常アーティア予測は現在のRNGエンジンで未対応です',
  skill_prediction_unsupported: 'スキル予測は現在のRNGエンジンで未対応です',
  gogma_prediction_unsupported: '巨戟アーティア予測は現在のRNGエンジンで未対応です',
  source_excluded_for_other_targets: '使える所持武器が、他の目標武器で使用するため除外したものだけでした',
}

export const staleReasonLabels: Record<BuildListEntryStaleReason, string> = {
  target_definition_changed: '目標武器の条件が変更されています',
  rng_state_changed: 'RNG状態が検索時から変更されています',
  owned_weapon_changed: '参照している所持武器が変更されています',
  calculation_context_changed: 'ゲーム・マスターデータ・予測エンジンのバージョンが変更されています',
}

export const rngStateSourceLabels: Record<RngStateSource, string> = {
  manual: '手動入力',
  observation: '観測検索',
}

export const normalArtianRarityLabels: Record<NormalArtianRarity, string> = {
  8: 'レア8',
}

export function getPersistenceReferenceKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    owned_weapon: '所持武器',
    target_weapon: '目標武器',
    build_candidate: '検索候補',
    build_list_entry: 'ビルドリスト',
    production_plan: '生産計画',
    execution_history: '実行履歴',
  }
  return labels[kind] ?? '関連データ'
}

export function getRouteOperationLabel(operation: RouteOperation): string {
  switch (operation.type) {
    case 'create_normal_artian':
      // A blind creation predicts no restoration bonuses, so the label says so
      // instead of implying a known result (`docs/SEARCH_SPEC.md` 6.1.1).
      return isBlindCreateNormalArtianOperation(operation)
        ? '通常アーティアを作成 × 1（復元ボーナス内容は不問）'
        : `通常アーティアを作成 × ${operation.count}`
    case 'convert_normal_to_gogma':
      return '巨戟アーティアへ変換'
    case 'reset_bonuses':
      return '復元ボーナスをリセット'
    case 'keep_bonuses':
      return '復元ボーナスを保持して再抽選'
    case 'reset_skills':
      return 'スキルをリセット'
  }
}

export function getRngMissingRequirementLabel(
  requirement: RngCapabilityMissingRequirement,
): string {
  if (requirement.startsWith('normal_artian_counter:')) {
    return '対象の通常アーティアカウンターを検索に使用できません'
  }
  const labels: Record<Exclude<RngCapabilityMissingRequirement, `normal_artian_counter:${string}`>, string> = {
    base_seed: 'Base Seed（基準シード）を検索に使用できません',
    gogma_counter: '巨戟カウンターを検索に使用できません',
    skill_counter: 'スキルカウンターを検索に使用できません',
    'engine:gogma_prediction': '巨戟アーティア予測エンジンが未対応です',
    'engine:skill_prediction': 'スキル予測エンジンが未対応です',
    'engine:normal_artian_prediction': '通常アーティア予測エンジンが未対応です',
    'engine:keep_prediction': '復元ボーナス保持予測エンジンが未対応です',
  }
  return labels[requirement as Exclude<RngCapabilityMissingRequirement, `normal_artian_counter:${string}`>]
}
