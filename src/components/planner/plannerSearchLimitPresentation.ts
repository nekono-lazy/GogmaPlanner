import type {
  PlannerRunLimitKind,
  PlannerRunTermination,
} from '../../domain/planner'

/**
 * Presentation for a Production full Planner run that its bound truncated
 * (UI_FLOW 10.1, PLANNER_SPEC 7.2.1). The Production settings and running
 * state live in `productionPlannerSettingsPresentation.ts`.
 *
 * Every string here is derived from the typed `PlannerRunTermination`. No
 * function in this module reads a `PlannerWarning`, and none parses a warning
 * message to decide what to show.
 *
 * The Production deterministic scheduler's one bound is `maxPlanSteps`, so
 * `max_plan_steps` is the only limit kind a Production termination can carry
 * (Issue #103 Phase D-2a). The Beam Search oracle's own limit kinds are shown
 * by its benchmark page only, never through this module.
 */

export const plannerSearchLimitLabels: Record<PlannerRunLimitKind, string> = {
  max_plan_steps: '最大計画ステップ数',
}

function formatCount(value: number): string {
  return value.toLocaleString('ja-JP')
}

export const plannerIncompleteSearchTitle = '生産計画の探索が完了していません'

/**
 * Where the bound is set and what to run again (UI_FLOW 10.1). The Build List
 * names its detail settings by their U7 heading 「詳細設定（通常Planner用）」, and
 * an ordinary Planner auxiliary run is re-run through that very operation, not
 * through 「生産計画を作成」 (which runs the global optimization there). The
 * defaults are the wording every other caller keeps.
 */
export interface PlannerReachedLimitMessageOptions {
  /** The heading of the detail settings that hold 「最大計画ステップ数」. */
  settingsHeading?: string
  /** What to do again, completing 「もう一度…してください」. */
  retryAction?: string
}

/**
 * One line per reached bound, naming the bound, the value it ran with, and
 * the detail setting to raise.
 */
export function createPlannerReachedLimitMessages(
  termination: PlannerRunTermination,
  { settingsHeading = '詳細設定', retryAction = '生産計画を作成' }: PlannerReachedLimitMessageOptions = {},
): string[] {
  return termination.reachedLimits.map(
    () =>
      `最大計画ステップ数 ${formatCount(termination.limits.maxPlanSteps)} に到達しました。すべての目標武器を含む完成計画を作成できませんでした。「${settingsHeading}」の「最大計画ステップ数」を増やして、もう一度${retryAction}してください。`,
  )
}

/**
 * The conflict resolution recalculation on the Production Plan page runs with
 * a bound derived from the Plan it shows (`conflictResolutionMaxPlanSteps()`,
 * Issue #130), never with the Build List detail settings. So its truncation
 * message names the bound it actually used and never suggests that editing
 * the Build List input would change that recalculation.
 */
export function createConflictResolutionIncompleteMessage(
  termination: PlannerRunTermination,
): string {
  return `競合解決の再計算が最大計画ステップ数 ${formatCount(termination.limits.maxPlanSteps)} に到達したため、完成した生産計画を作成できませんでした。この上限は表示中の生産計画のステップ数から自動で決まります。ビルドリスト画面から生産計画を作り直してください。`
}

export function createPlannerCompletedTargetsText(
  termination: PlannerRunTermination,
): string {
  return `完成した目標武器: ${formatCount(termination.completedTargetCount)} / ${formatCount(termination.totalTargetCount)}`
}
