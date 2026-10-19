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
import type { ExportRoot } from '../../domain/models/publicTypes'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The full-replacement Import confirmation (`docs/UI_FLOW.md` 14,
 * `docs/REQUIREMENTS.md` 30). It opens only for a root `prepareImportJson()`
 * accepted, states that the current data is replaced entirely, and asks the
 * user to export the current data first when they need it; the Import itself
 * never exports anything. 「キャンセル」 calls nothing.
 */
export function ImportConfirmDialog({
  root,
  submitting,
  onCancel,
  onConfirm,
}: {
  /** `null` keeps the dialog closed. */
  root: ExportRoot | null
  submitting: boolean
  onCancel(): void
  onConfirm(root: ExportRoot): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Dialog
      open={root !== null}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>バックアップからデータを復元しますか？</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            このインポートは全置換です。現在保存されているデータは、読み込んだバックアップの内容に置き換わります。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            必要な場合は、実行前に現在のデータをエクスポートしてください。キャンセルすると何も変更されません。
          </Typography>
          {root !== null && (
            <Typography
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1, overflowWrap: 'anywhere' }}
            >
              バックアップ作成日時: {root.exportedAt} / 所持武器 {root.ownedWeapons.length}件 / 目標武器 {root.targetWeapons.length}件 / 生産計画 {root.productionPlans.length}件
            </Typography>
          )}
        </DialogContentText>
      </DialogContent>
      {/* `disableSpacing`: the MUI sibling margin would offset the second full-width button on a phone. */}
      <DialogActions disableSpacing sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button
          variant="contained"
          color="warning"
          disabled={submitting}
          onClick={() => {
            if (root !== null && !submitting) onConfirm(root)
          }}
          sx={actionSx}
        >
          現在のデータを置き換えてインポート
        </Button>
      </DialogActions>
    </Dialog>
  )
}
