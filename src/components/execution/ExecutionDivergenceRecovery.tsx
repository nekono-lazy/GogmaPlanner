import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { ExecutionDivergenceView } from './executionStepPresentation'

const linkSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The stale Plan view after `actual_result_different` (`docs/UI_FLOW.md` 12.4,
 * `docs/PLANNER_SPEC.md` 16.15). The re-identification destination comes from
 * the operation of the recorded Step: Normal creation goes to the Normal
 * Counter setup, every other operation to RNG Setup. Nothing is recalculated
 * and no weapon is changed from here. `operation_uncertain` is recovered by
 * `OperationUncertainRecovery` instead.
 */
export function ExecutionDivergenceRecovery({
  divergence,
  planId,
}: {
  divergence: Extract<ExecutionDivergenceView, { action: 'actual_result_different' }>
  planId: string
}) {
  const reidentify =
    divergence.destination === 'normal_counters'
      ? { label: '通常アーティアCounterを特定し直す', to: '/normal-counters' }
      : { label: 'RNG状態を特定し直す', to: '/rng' }
  const links = [
    { label: '作成プランを見る', to: `/plans/${planId}` },
    { label: 'ビルドリストへ', to: '/build-list' },
  ]
  return (
    <Alert severity="warning" role="region" aria-label="生産計画の停止">
      <AlertTitle>予測と異なる結果を記録しました</AlertTitle>
      <Stack spacing={1.5}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          記録した操作: {divergence.operationLabel}
        </Typography>
        <Typography variant="body2">
          実行した操作と実際の結果は保存しました。この操作で消費したCounterは反映済みです。
        </Typography>
        <Typography variant="body2">
          以降の予測は使用できないため、生産計画を停止しています。RNG状態を特定し直してください。
        </Typography>
        <Button component={RouterLink} to={reidentify.to} variant="contained" color="warning" sx={linkSx}>
          {reidentify.label}
        </Button>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {links.map(({ label, to }) => (
            <Button key={to} component={RouterLink} to={to} variant="outlined" color="inherit" sx={linkSx}>
              {label}
            </Button>
          ))}
        </Stack>
      </Stack>
    </Alert>
  )
}
