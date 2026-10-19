import { LinearProgress, Stack, Typography } from '@mui/material'
import type { ExecutionProgressView } from './executionStepPresentation'

/** Step X / Y plus the completed / remaining counts, in Plan order. */
export function ExecutionProgress({ progress }: { progress: ExecutionProgressView }) {
  const { totalStepCount, completedStepCount, remainingStepCount, currentStepNumber } = progress
  const percent = totalStepCount === 0 ? 0 : (completedStepCount / totalStepCount) * 100
  return (
    <Stack spacing={0.75}>
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'baseline' }}
      >
        {currentStepNumber !== null && (
          <Typography component="p" variant="subtitle1" className="tabular-nums" sx={{ fontWeight: 600 }}>
            Step {currentStepNumber} / {totalStepCount}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" className="tabular-nums">
          完了 {completedStepCount}件
        </Typography>
        <Typography variant="body2" color="text.secondary" className="tabular-nums">
          残り {remainingStepCount}件
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={percent}
        aria-label={`完了 ${completedStepCount}件 / 全 ${totalStepCount}件`}
      />
    </Stack>
  )
}
