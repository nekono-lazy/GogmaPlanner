import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { OwnedWeaponId, ProductionPlan, TargetWeaponId } from '../../domain/models/publicTypes'
import { productionPlanAbandonmentReasonLabels } from '../../presentation/labels'
import type { ProductionPlanStartInspection } from '../../services/execution/productionPlanExecutionService'

/**
 * The read-only pre-start preview of a draft Plan (`docs/UI_FLOW.md` 11). The
 * user sees the Target link changes before starting, so 「作成開始」 is enabled
 * only once the preview is `ready`. It only informs: the start re-derives and
 * re-verifies every change itself and never takes the preview as authority.
 */
export type PlanStartPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; inspection: ProductionPlanStartInspection }
  | { status: 'failed' }

function StartLinkPreview({ preview, onRetry }: { preview: PlanStartPreviewState; onRetry(): void }) {
  if (preview.status === 'loading') {
    return (
      <Typography variant="body2" color="text.secondary" role="status">
        開始時に変わる目標武器の優先起点を確認しています。
      </Typography>
    )
  }
  if (preview.status === 'failed') {
    return (
      <Alert severity="warning">
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2">
            開始時に変わる目標武器の優先起点を確認できませんでした。確認できるまで作成を開始できません。
          </Typography>
          <Button variant="outlined" color="inherit" onClick={onRetry} sx={{ minHeight: 44 }}>
            再確認
          </Button>
        </Stack>
      </Alert>
    )
  }
  const { inspection } = preview
  if (inspection.changes.length === 0) return null
  const weaponName = (id: OwnedWeaponId) =>
    inspection.ownedWeapons.find((weapon) => weapon.id === id)?.name ?? `所持武器（${id}）`
  const targetName = (id: TargetWeaponId | null) =>
    id === null ? '未設定' : inspection.targetWeapons.find((target) => target.id === id)?.name ?? `目標武器（${id}）`
  return (
    <Alert severity="info" role="region" aria-label="開始時の優先起点の変更">
      <AlertTitle>この生産計画を開始すると、目標武器の優先起点が変更されます。</AlertTitle>
      <Stack spacing={1}>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
          {inspection.changes.map((change) => (
            <Typography component="li" variant="body2" key={`${change.ownedWeaponId}:${change.targetWeaponId}`} sx={{ overflowWrap: 'anywhere' }}>
              <Box component="span" sx={{ fontWeight: 600 }}>所持武器「{weaponName(change.ownedWeaponId)}」</Box>
              <br />
              {targetName(change.fromTargetWeaponId)} → {targetName(change.targetWeaponId)}
              {change.replacedOwnedWeaponId !== null && (
                <>
                  <br />
                  「{targetName(change.targetWeaponId)}」の優先起点だった「{weaponName(change.replacedOwnedWeaponId)}」は解除されます。
                </>
              )}
            </Typography>
          ))}
        </Box>
        <Typography variant="body2">変更は「作成開始」を押した時点で反映されます。</Typography>
      </Stack>
    </Alert>
  )
}

/**
 * The Execution entry point of the Production Plan page (`docs/UI_FLOW.md` 11):
 * 「作成開始」 for a draft with the preview of the Target links its start makes,
 * 「実行ナビを再開する」 for an active Plan, and a read-only note for an ended
 * Plan. Starting is the runtime's decision; this component never changes a Plan
 * status or a Target on its own. A stale Plan is left to the page's existing
 * recalculation guidance.
 */
export function PlanExecutionEntry({
  plan,
  starting,
  startError,
  startPreview,
  onRetryStartPreview,
  onStart,
}: {
  plan: ProductionPlan
  starting: boolean
  startError: string | null
  startPreview: PlanStartPreviewState
  onRetryStartPreview(): void
  onStart(): void
}) {
  const buttonSx = { minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }
  switch (plan.status) {
    case 'draft':
      return (
        <Stack spacing={1.5}>
          <StartLinkPreview preview={startPreview} onRetry={onRetryStartPreview} />
          <Button
            variant="contained"
            size="large"
            disabled={starting || startPreview.status !== 'ready'}
            onClick={onStart}
            sx={buttonSx}
          >
            作成開始
          </Button>
          {starting && (
            <Typography variant="body2" role="status">
              生産計画を開始しています。
            </Typography>
          )}
          {startError !== null && <Alert severity="error">{startError}</Alert>}
        </Stack>
      )
    case 'active':
      return (
        <Button
          component={RouterLink}
          to={`/plans/${plan.id}/run`}
          variant="contained"
          size="large"
          sx={buttonSx}
        >
          実行ナビを再開する
        </Button>
      )
    case 'completed':
      return <Alert severity="success">この生産計画は完了しています。</Alert>
    case 'abandoned':
      return (
        <Alert severity="info">
          この生産計画は終了しています（
          {plan.abandonmentReason === null
            ? '終了理由の記録なし'
            : productionPlanAbandonmentReasonLabels[plan.abandonmentReason]}
          ）。
        </Alert>
      )
    case 'stale':
      return null
  }
}
