import { useId } from 'react'
import { Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import type { BuildListOptimizationStage } from '../../domain/planner/buildListOptimization'
import {
  BUILD_LIST_OPTIMIZATION_KEEP_SCREEN_NOTE,
  BUILD_LIST_OPTIMIZATION_LONG_RUN_NOTICE,
  BUILD_LIST_OPTIMIZATION_RUNNING_NOTE,
  BUILD_LIST_OPTIMIZATION_RUNNING_TITLE,
  buildListOptimizationStageStatusText,
} from './buildListOptimizationPresentation'
import { useBuildListOptimizationLongRunNotice, type BuildListOptimizationRunKey } from './useBuildListOptimizationLongRunNotice'

/**
 * The running state of the Build List global optimization (`docs/UI_FLOW.md` 10.4 「計算中」, `docs/PLANNER_SPEC.md` 17.16).
 *
 * One `role="status"` region holds the heading, an indeterminate progress bar, the current stage name and the cancel operation,
 * with no completion rate, remaining time or count denominator. A stage change only updates the stage line inside that region: focus
 * never moves. 30 s after this run's running state was first shown, the same region adds the long-run notice (U3) as plain
 * information - beside the stage and the cancel operation, never replacing them, never an error or a warning, never a timeout.
 *
 * The caller mounts it while the run is preparing or running and unmounts it when the run ends (a result, a cancellation or a
 * failure) or the screen is left; `runKey` names the run, so a new run restarts the 30 s count. The cancel operation is the
 * caller's: this component calls `onCancel` and does nothing else.
 */
export function BuildListOptimizationRunningPanel({
  runKey,
  stage,
  onCancel,
}: {
  runKey: BuildListOptimizationRunKey
  /** The latest stage the Worker reported, or null before the first one arrives. */
  stage: BuildListOptimizationStage | null
  onCancel(): void
}) {
  const headingId = useId()
  const longRunNotice = useBuildListOptimizationLongRunNotice(runKey)
  return (
    <Paper
      component="section"
      variant="outlined"
      role="status"
      aria-live="polite"
      aria-labelledby={headingId}
      sx={{ p: { xs: 1.5, md: 2 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Typography id={headingId} component="h3" variant="h3">
          {BUILD_LIST_OPTIMIZATION_RUNNING_TITLE}
        </Typography>
        <LinearProgress
          aria-label="生産計画の計算中"
          variant="indeterminate"
          sx={{
            // UI_FLOW 10.4: the indeterminate bar does not move when the user asks for reduced motion; the heading and
            // the stage line still say the calculation is running.
            '@media (prefers-reduced-motion: reduce)': {
              '& .MuiLinearProgress-bar': { animation: 'none' },
            },
          }}
        />
        <Typography variant="body1" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
          {buildListOptimizationStageStatusText(stage)}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {BUILD_LIST_OPTIMIZATION_RUNNING_NOTE}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {BUILD_LIST_OPTIMIZATION_KEEP_SCREEN_NOTE}
        </Typography>
        {longRunNotice && (
          // Plain information in the same status region (no alert role, no error or warning colour, no icon): the text says it.
          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              px: 1.5,
              py: 1,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {BUILD_LIST_OPTIMIZATION_LONG_RUN_NOTICE}
            </Typography>
          </Box>
        )}
        <Button
          variant="outlined"
          onClick={onCancel}
          sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          キャンセル
        </Button>
      </Stack>
    </Paper>
  )
}
