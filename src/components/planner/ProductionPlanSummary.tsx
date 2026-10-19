import { useId } from 'react'
import { Alert, Box, Paper, Stack, Typography } from '@mui/material'
import type { ProductionPlan, ProductionPlanStatus } from '../../domain/models/publicTypes'
import { productionPlanStatusLabels } from '../../presentation/labels'
import { StatusChip, type StatusTone } from '../StatusChip'
import {
  planCompletionExplanation,
  planCompletionFigure,
  planConflictNote,
} from './productionPlanCompletionPresentation'
import { createProductionPlanSummary } from './productionPlanPresentation'

const statusTones: Record<ProductionPlanStatus, StatusTone> = {
  draft: 'info',
  active: 'positive',
  completed: 'positive',
  stale: 'caution',
  abandoned: 'neutral',
}

/** Read by a screen reader, never shown (the usual visually hidden pattern). */
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  p: 0,
  m: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const

/**
 * One figure of the overview (a `dt` / `dd` pair inside the caller's `dl`).
 * Numbers are tabular; long tokens wrap. Shared with the Build List
 * optimization Preview overview so both read alike.
 */
export function SummaryFigure({
  label,
  value,
  span = false,
  numeric = false,
  detail,
  gridColumn,
  accessibleValue,
}: {
  label: string
  value: string | number
  span?: boolean
  numeric?: boolean
  /** A secondary line under the value, inside the same `dd`. */
  detail?: string
  /** A responsive grid placement; `span` (the whole row everywhere) wins when both are given. */
  gridColumn?: string | { xs?: string; sm?: string; md?: string }
  /**
   * What a screen reader reads instead of the visible value, when the value
   * alone (a `/` ratio) does not say what each number means. The visible value
   * is then hidden from the accessibility tree, so it is not read twice.
   */
  accessibleValue?: string
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 1,
        minWidth: 0,
        gridColumn: span ? '1 / -1' : gridColumn,
      }}
    >
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography
        component="dd"
        variant={numeric ? 'h3' : 'body2'}
        className={numeric ? 'tabular-nums' : undefined}
        sx={{ m: 0, overflowWrap: 'anywhere', ...(numeric ? { fontSize: '1.25rem' } : {}) }}
      >
        {accessibleValue === undefined ? (
          value
        ) : (
          <>
            <span aria-hidden="true">{value}</span>
            <Box component="span" sx={visuallyHidden}>{accessibleValue}</Box>
          </>
        )}
        {detail !== undefined && (
          <Typography
            component="span"
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', overflowWrap: 'anywhere' }}
          >
            {detail}
          </Typography>
        )}
      </Typography>
    </Box>
  )
}

/**
 * The Plan overview, derived only from the exact persisted Plan.
 *
 * 「完成予定の目標武器数」 is `N / (N + M)本` (Issue #121, UI_FLOW 11.0): `N` is
 * the distinct Targets of `executionEffects.targetCompletions` and `M` the
 * Targets a conflict with another Target leaves out, both from the shared
 * Domain summary (`summarizeProductionPlanCompletion()`, PLANNER_SPEC
 * 9.6.9.1), so the Conflict section reads the same numbers. When the records
 * cannot tell `M`, only `N本` is shown with the typed reason; a legacy Plan
 * shows the count as unknown. The denominator is never the Build List size,
 * and neither the Target count nor `selectedBuildListEntryIds.length` is
 * treated as a weapon count. The adopted BuildListEntry count is shown as its
 * own figure, named as an Entry count, so the two are never confused.
 *
 * The Conflict figure is `plan.conflicts.length` of this exact persisted Plan:
 * a count of Conflict records, never of Targets or weapons, never re-derived
 * from the current input, and never added to the rejected Entries. The stored
 * selections are shown as stored, so no Conflict is declared unresolved.
 * When any Conflict is recorded, a note says how many Targets the conflicts
 * leave out when the records tell it - never a guessed number - and whether
 * the result includes the Planner's provisional outcome.
 *
 * This is the single place the Plan ID and status are shown on the page.
 */
export function ProductionPlanSummary({
  plan,
  conflictPreferenceAvailable = false,
}: {
  plan: ProductionPlan
  /**
   * A draft whose CalculationContext is compatible, where a participant can
   * still be preferred: the provisional wording then says choosing may change
   * the result. Wording only; nothing is decided from it.
   */
  conflictPreferenceAvailable?: boolean
}) {
  const summary = createProductionPlanSummary(plan)
  const hasConflicts = summary.conflictCount > 0
  const completionFigure = planCompletionFigure(summary.completion)
  const completionExplanation = planCompletionExplanation(summary.completion, summary.status)
  const headingId = useId()
  return (
    <Paper
      component="section"
      aria-labelledby={headingId}
      variant="outlined"
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', alignItems: 'center' }}
        >
          <Typography id={headingId} component="h2" variant="h2">
            計画の概要
          </Typography>
          <StatusChip
            label={productionPlanStatusLabels[summary.status]}
            tone={statusTones[summary.status]}
          />
          {/* Text carries the state; the tone only reinforces it. */}
          <StatusChip
            label={hasConflicts ? `競合あり（${summary.conflictCount}件）` : '競合なし'}
            tone={hasConflicts ? 'caution' : 'neutral'}
          />
        </Stack>
        {/* A persistent part of the overview, not a status change: a `note`,
            so it is never announced as an alert. */}
        {hasConflicts && (
          <Alert severity="info" role="note">
            {planConflictNote(summary.completion, summary.conflictCount, conflictPreferenceAvailable)}
          </Alert>
        )}
        <Box
          component="dl"
          sx={{
            m: 0,
            display: 'grid',
            gridTemplateColumns: {
              xs: 'repeat(2, minmax(0, 1fr))',
              md: 'repeat(4, minmax(0, 1fr))',
            },
            gap: 1,
          }}
        >
          <SummaryFigure label="全ステップ数" value={summary.totalStepCount} numeric />
          <SummaryFigure label="目標武器数" value={summary.targetWeaponCount} numeric />
          <SummaryFigure
            label="完成予定の目標武器数"
            value={completionFigure.value}
            numeric={completionFigure.numeric}
            accessibleValue={completionFigure.accessibleValue ?? undefined}
            detail={completionFigure.detail ?? undefined}
          />
          <SummaryFigure
            label="採用候補（BuildListEntry）"
            value={plan.selectedBuildListEntryIds.length}
            numeric
          />
          <SummaryFigure
            label="競合（記録件数）"
            value={hasConflicts ? `${summary.conflictCount}件` : 'なし'}
            numeric={hasConflicts}
            detail={
              hasConflicts
                ? `うち候補を選択済み ${summary.selectedConflictCount}件`
                : undefined
            }
          />
          <SummaryFigure label="作成日時" value={summary.createdAt} />
          <SummaryFigure label="計画ID" value={summary.planId} />
        </Box>
        {/* What the ratio's denominator counts, or why no ratio is shown:
            always beside the figure, in text. */}
        {completionExplanation !== null && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {completionExplanation}
          </Typography>
        )}
      </Stack>
    </Paper>
  )
}
