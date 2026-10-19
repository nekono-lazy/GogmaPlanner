/**
 * Presentation for the Production Planner settings and its running state
 * (UI_FLOW 10.0, PLANNER_SPEC 7.2, Issue #103 Phase D-1 / D-2a).
 *
 * The Production Planner is the deterministic scheduler. Its only bound is
 * `PlannerOptions.maxPlanSteps` - the whole Production `PlannerOptions` - so
 * the Build List detail settings expose that one field.
 *
 * A running Production Planner is shown as indeterminate. The Production
 * Planner Worker reports no progress at all (Phase D-2a), and no single
 * authority knows the final Step count in advance
 * (physical action sharing, silent fast-forward, dynamic release / recommit and
 * deadlock / stall drops all change it while the schedule runs).
 */

export interface ProductionPlannerOptionFieldPresentation {
  key: 'maxPlanSteps'
  label: string
  helperText: string
}

/** The one Production Planner bound the Build List detail settings expose. */
export const productionPlannerMaxPlanStepsField: ProductionPlannerOptionFieldPresentation = {
  key: 'maxPlanSteps',
  label: '最大計画ステップ数',
  helperText:
    '計画で実行する操作数の安全上限です。通常は変更不要です。上限に達して計画が完了しなかった場合は、この値を増やして再実行してください。',
}

/**
 * The heading of the Build List detail settings (U7, `docs/UI_FLOW.md` 10.0, Issue #260 PR-6C): the setting belongs to the ordinary
 * Planner, never to the global optimization, so the heading says so instead of a bare 「詳細設定」.
 */
export const productionPlannerDetailSettingsTitle = '詳細設定（通常Planner用）'

/**
 * The Build List detail settings description (U7, `docs/UI_FLOW.md` 10.0): which operations use the bound - the one valid Entry
 * 「生産計画を作成」, the ordinary Planner auxiliary operation and the replan Preview - that the global optimization (two or more valid
 * Entries) does not, and the existing rules. The Build List's default is the recommended bound for the Entries it holds
 * (`recommendedBuildListMaxPlanSteps()`, Issue #130), so it says how that default is sized instead of naming a fixed number.
 */
export const productionPlannerDetailSettingsDescriptionLines: readonly string[] = [
  '通常Plannerで生産計画を作るときの安全上限です。',
  '有効な候補が1件のときの「生産計画を作成」、「登録済みの候補で生産計画を作成」、「現在地点から再計画を試算」で使います。',
  '有効な候補が2件以上のときの「生産計画を作成」（全体最適化）には適用されません。全体最適化の上限はアプリが決めます。',
  '1以上の整数だけが有効で、この画面を再読み込みすると既定値へ戻ります。既定値は登録候補の必要操作数に応じて500刻みで補正されます（最低1,000）。',
]

/** U7: shown beside an ordinary Planner operation (the one valid Entry 「生産計画を作成」, the replan Preview) while the setting is invalid. */
export const productionPlannerOptionsInvalidMessage =
  '通常Plannerの詳細設定の「最大計画ステップ数」が無効なため、開始できません。1以上の整数を入力してください。'

export const plannerOptionInvalidMessage = '1以上の整数を入力してください。'

/** The running state of each Production Planner entry point, never a ratio. */
export const productionPlannerRunningTitles = {
  plan: '生産計画を作成しています…',
  replanPreview: '再計画を試算しています…',
  recalculation: '再計算しています…',
  whatIf: '比較しています…',
} as const

export const productionPlannerRunningNote =
  '計算が終わると結果を表示します。途中で止める場合は「キャンセル」を押してください。'
