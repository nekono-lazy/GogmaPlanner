import { useId } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import type { ConflictPreferenceConfirmation } from './productionPlanConflictPreferencePresentation'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

export const CONFLICT_PREFERENCE_DIALOG_TITLE = '以前の選択を変更して再計算しますか？'
export const CONFLICT_PREFERENCE_DIALOG_CONFIRM_LABEL = 'この候補を優先して再計算'

/**
 * The confirmation of `docs/PLANNER_SPEC.md` 9.6.3 rule 7 / `docs/UI_FLOW.md`
 * 11.6.6: before 「この候補を優先」 recalculates, every earlier decision of the
 * displayed Draft that the press drops - superseded by the new decision or not
 * reproducible over the current input - is listed, and nothing runs until the
 * user confirms. 「キャンセル」, Escape and the backdrop run nothing.
 *
 * Its lines come from the Domain decision set through the presentation helper
 * only; no rule is judged here.
 */
export function ProductionPlanConflictPreferenceDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  /** `null` keeps the dialog closed. */
  confirmation: ConflictPreferenceConfirmation | null
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  if (confirmation === null) return null
  return (
    <Dialog
      open
      fullWidth
      maxWidth="sm"
      scroll="paper"
      onClose={onCancel}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>{CONFLICT_PREFERENCE_DIALOG_TITLE}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography id={descriptionId} variant="body2">
            この候補を優先して生産計画を再計算すると、次の以前の選択は今回の計算に使われません。作成リストは変更しません。
          </Typography>
          {confirmation.superseded.length > 0 && (
            <Box component="ul" aria-label="取り消す以前の選択" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
              {confirmation.superseded.map((line) => (
                <Typography key={line} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>{line}</Typography>
              ))}
            </Box>
          )}
          {confirmation.notCarriedOver.length > 0 && (
            <Stack spacing={0.5}>
              <Typography variant="body2">以前の選択のうち次のものは、現在の作成リストでは再現できないため引き継ぎません。</Typography>
              <Box component="ul" aria-label="引き継がない以前の選択" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
                {confirmation.notCarriedOver.map((line) => (
                  <Typography key={line} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>{line}</Typography>
                ))}
              </Box>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions disableSpacing sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" onClick={onConfirm} sx={actionSx}>
          {CONFLICT_PREFERENCE_DIALOG_CONFIRM_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
