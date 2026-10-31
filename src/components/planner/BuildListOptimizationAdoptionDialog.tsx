import { useId } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import type { BuildListOptimizationAdoptionInspection } from '../../services/planner/plannerResultPersistenceService'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

export const ADOPTION_DIALOG_TITLE = 'この計画を採用しますか？'
export const ADOPTION_DIALOG_CONFIRM_LABEL = 'この計画を採用'

/**
 * The adoption confirmation of a Build List global optimization (`docs/UI_FLOW.md` 10.4 「採用」, `docs/PLANNER_SPEC.md` 17.5 /
 * 17.11). Everything it states comes from the read-only adoption inspection taken when 「この計画を採用」 was pressed - how many
 * Entries are replaced, how many Targets keep theirs, whether a Draft is replaced - never from the Preview or a count of its own.
 *
 * It is one all-or-nothing adoption over the planning Targets: there is no per-Target choice. Nothing is written before
 * 「この計画を採用」; 「キャンセル」, Escape and the backdrop write nothing (and are inert while the save runs).
 */
export function BuildListOptimizationAdoptionDialog({
  inspection,
  submitting,
  onCancel,
  onConfirm,
}: {
  /** The inspection of the shown run; `null` keeps the dialog closed. */
  inspection: BuildListOptimizationAdoptionInspection | null
  submitting: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  if (inspection === null) return null
  const replacementCount = inspection.replacements.length
  const unchangedCount = inspection.unchangedTargetWeaponIds.length
  const close = () => {
    if (!submitting) onCancel()
  }
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      scroll="paper"
      onClose={close}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>{ADOPTION_DIALOG_TITLE}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography id={descriptionId} variant="body2">
            今回の計画対象の目標武器全体について、試算した作成ルートと生産計画をまとめて採用します。目標武器ごとに一部だけ採用することはできません。
          </Typography>
          <Box
            component="dl"
            aria-label="採用による変更"
            sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'max-content minmax(0, 1fr)' }, columnGap: 2, rowGap: 0.5 }}
          >
            <Typography component="dt" variant="body2" color="text.secondary">置き換える作成リストの候補</Typography>
            <Typography component="dd" variant="body2" className="tabular-nums" sx={{ m: 0, fontWeight: 600 }}>
              {replacementCount}件
            </Typography>
            <Typography component="dt" variant="body2" color="text.secondary">変更なしの目標武器</Typography>
            <Typography component="dd" variant="body2" className="tabular-nums" sx={{ m: 0, fontWeight: 600 }}>
              {unchangedCount}件
            </Typography>
            <Typography component="dt" variant="body2" color="text.secondary">未開始の生産計画（下書き）</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, fontWeight: 600 }}>
              {inspection.replacedDraftPlanId === null ? 'ありません（新しく保存します）' : 'この計画に置き換えます'}
            </Typography>
          </Box>
          {replacementCount === 0 ? (
            <Typography variant="body2">
              置き換える候補はありません。作成リストは変更せず、生産計画（下書き）だけを保存します。
            </Typography>
          ) : (
            <Alert severity="warning">
              <AlertTitle>置き換えた候補は自動では元に戻せません</AlertTitle>
              <Typography variant="body2">
                元の候補に戻す場合は、候補検索で検索し直して作成リストへ追加してください。
              </Typography>
            </Alert>
          )}
          {inspection.replacedDraftPlanId !== null && (
            <Typography variant="body2">
              現在の未開始の生産計画（下書き）は、この計画に置き換えられます。置き換えた下書きは元に戻せません。
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            採用すると生産計画を下書きとして保存し、その生産計画の画面へ移動します。作成開始は生産計画の画面で行います。
          </Typography>
          {submitting && <LinearProgress aria-label="採用した計画を保存中" />}
        </Stack>
      </DialogContent>
      {/* `disableSpacing`: the MUI sibling margin would offset the second full-width button on a phone. */}
      <DialogActions disableSpacing sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={close} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={submitting} sx={actionSx}>
          {submitting ? '保存しています…' : ADOPTION_DIALOG_CONFIRM_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
