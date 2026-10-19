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

/**
 * The confirmation before 「何を何回操作したか分からない」 is recorded
 * (`docs/UI_FLOW.md` 12.5). It states what the record does and does not do;
 * cancelling calls nothing.
 */
export function OperationUncertainDialog({
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
      <DialogTitle id={titleId}>操作内容が分からない状態として記録しますか？</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            Counterと武器の状態は変更しません。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            何を何回操作したかを推測せず、この生産計画を続行できない状態（再計算が必要）にします。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            記録すると生産計画をいったん停止し、この画面で現在位置の確認やゲーム内セーブ地点への復元など、回復方法を選びます。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            誤って記録した場合は、記録後に「実行状態の管理」からこの記録を取り消して元の操作へ戻せます。
          </Typography>
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={{ minHeight: 44 }}>
          キャンセル
        </Button>
        <Button variant="contained" color="warning" disabled={submitting} onClick={onConfirm} sx={{ minHeight: 44 }}>
          操作内容不明として記録
        </Button>
      </DialogActions>
    </Dialog>
  )
}
