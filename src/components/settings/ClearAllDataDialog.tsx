import { useId } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The confirmation before every user table is cleared (`docs/UI_FLOW.md` 14,
 * `docs/REQUIREMENTS.md` 30). One explicit confirmation, no typed phrase;
 * 「キャンセル」 calls nothing.
 */
export function ClearAllDataDialog({
  open,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean
  submitting: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>すべてのデータを削除しますか？</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            この操作は元に戻せません。保存されているユーザーデータをすべて削除し、アプリを初期状態へ戻します。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            必要な場合は先にエクスポートしてください。キャンセルすると何も変更されません。
          </Typography>
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={submitting}
          onClick={() => {
            if (!submitting) onConfirm()
          }}
          sx={actionSx}
        >
          すべてのデータを削除
        </Button>
      </DialogActions>
    </Dialog>
  )
}
