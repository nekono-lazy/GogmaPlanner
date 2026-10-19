import { useId, useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Typography,
} from '@mui/material'

/**
 * 「最後のゲーム内セーブ地点へ戻す」 (`docs/UI_FLOW.md` 12.8,
 * `docs/PLANNER_SPEC.md` 16.9). The app never restores before the user confirms
 * the game itself went back to the save point, so the confirmation stays
 * disabled until the checkbox is ticked. Shared by the ordinary Navigator and the
 * `operation_uncertain` recovery (16.15); what the restore does is the runtime's.
 */
export function ExecutionSavePointRestoreDialog({
  open,
  submitting,
  positionLabel,
  note,
  onCancel,
  onConfirm,
}: {
  open: boolean
  submitting: boolean
  /** Where the save point was recorded, e.g. 「Step 12完了時点」. */
  positionLabel: string | null
  /** An extra sentence the caller's situation needs. */
  note?: string
  onCancel(): void
  onConfirm(): void
}) {
  const [gameRestored, setGameRestored] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const close = () => {
    if (submitting) return
    setGameRestored(false)
    onCancel()
  }
  return (
    <Dialog open={open} onClose={close} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <DialogTitle id={titleId}>最後のゲーム内セーブ地点へ戻す</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          {positionLabel !== null && (
            <Typography component="p" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              最後のゲーム内セーブ地点: {positionLabel}
            </Typography>
          )}
          <Typography component="p" variant="body2" sx={{ mt: positionLabel === null ? 0 : 1 }}>
            先にゲームを記録したセーブ地点から読み込み直してください。アプリ側だけを先に戻すことはしません。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            アプリ側では、RNG状態・通常アーティアCounter・この計画で作成・加工した武器・関係する目標武器・計画の進行を記録地点へ戻します。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            その後に追加した目標武器や作成リストなど、ゲーム進行と無関係なデータは戻しません。
          </Typography>
          {note !== undefined && (
            <Typography component="p" variant="body2" sx={{ mt: 1 }}>
              {note}
            </Typography>
          )}
        </DialogContentText>
        <FormControlLabel
          sx={{ mt: 1.5, alignItems: 'flex-start' }}
          control={
            <Checkbox
              checked={gameRestored}
              onChange={(event) => setGameRestored(event.target.checked)}
              disabled={submitting}
              sx={{ mt: -0.5 }}
            />
          }
          label="ゲーム側を最後のゲーム内セーブ地点まで戻しました"
        />
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={close} disabled={submitting} sx={{ minHeight: 44 }}>
          キャンセル
        </Button>
        <Button
          variant="contained"
          color="warning"
          disabled={submitting || !gameRestored}
          onClick={() => {
            setGameRestored(false)
            onConfirm()
          }}
          sx={{ minHeight: 44 }}
        >
          アプリ側もセーブ地点へ戻す
        </Button>
      </DialogActions>
    </Dialog>
  )
}
