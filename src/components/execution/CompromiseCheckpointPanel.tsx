import { useId, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material'

/**
 * The panel shown while a selected compromise checkpoint is the tracked
 * weapon's current state (`docs/UI_FLOW.md` 12.3).
 *
 * 「次の操作へ進む」 only closes the panel for this page session; it records
 * nothing, so a reload may show it again. The finish always goes through a
 * confirmation dialog, and the save point choice of 16.10 is never offered
 * here.
 */
export function CompromiseCheckpointPanel({
  weaponLabel,
  targetLabel,
  labelledPractical,
  finishing,
  onContinue,
  onFinish,
}: {
  weaponLabel: string
  targetLabel: string
  /** The labelling Step is confirmed, so the weapon is now `practical`. */
  labelledPractical: boolean
  finishing: boolean
  onContinue(): void
  onFinish(): void
}) {
  const [confirming, setConfirming] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Alert severity="success" icon={false} role="region" aria-label="途中採用状態への到達">
      <AlertTitle>作成リストで選んだ途中採用状態に到達しました。</AlertTitle>
      <Stack spacing={1.5}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {labelledPractical
            ? 'この武器は「実用」になりました。'
            : 'この武器は開始時点で途中採用状態です。'}
        </Typography>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          武器: {weaponLabel} ／ 目標武器: {targetLabel}
        </Typography>
        <Button
          variant="contained"
          size="large"
          onClick={onContinue}
          disabled={finishing}
          sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }}
        >
          次の操作へ進む
        </Button>
        {/* Kept apart from the primary action so it is never tapped by mistake. */}
        <Divider />
        <Box sx={{ pt: 1 }}>
          <Button
            variant="outlined"
            color="warning"
            onClick={() => setConfirming(true)}
            disabled={finishing}
            sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
          >
            この武器を妥協品として確定して終了
          </Button>
        </Box>
      </Stack>
      <Dialog
        open={confirming}
        onClose={() => {
          if (!finishing) setConfirming(false)
        }}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <DialogTitle id={titleId}>妥協品として確定して終了</DialogTitle>
        <DialogContent>
          <DialogContentText id={descriptionId} component="div">
            <Typography component="p" variant="body2">
              この武器を妥協品として確定し、現在の生産計画を終了します。
            </Typography>
            <Typography component="p" variant="body2" sx={{ mt: 1 }}>
              残りの作成手順は実行されません。
              未完了の目標武器がある場合は現在状態から再計画できます。
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button onClick={() => setConfirming(false)} disabled={finishing} sx={{ minHeight: 44 }}>
            キャンセル
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={finishing}
            onClick={() => {
              setConfirming(false)
              onFinish()
            }}
            sx={{ minHeight: 44 }}
          >
            妥協品として確定して終了
          </Button>
        </DialogActions>
      </Dialog>
    </Alert>
  )
}
