import { useId } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import type { TargetCompletionOverlapConfirmation } from '../../domain/target'
import { StatusChip } from '../StatusChip'
import {
  COMPLETION_OVERLAP_BACK_LABEL,
  COMPLETION_OVERLAP_DISABLED_LABEL,
  COMPLETION_OVERLAP_LEAD,
  COMPLETION_OVERLAP_LIST_LABEL,
  COMPLETION_OVERLAP_REVIEW_LABEL,
  COMPLETION_OVERLAP_TITLE,
  completionOverlapContinueLabel,
  completionOverlapCountText,
  completionOverlapLabels,
  completionOverlapSeparateWeaponNote,
  type CompletionOverlapSaveMode,
} from './completionOverlapPresentation'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

export interface TargetCompletionOverlapDialogProps {
  /** The Targets to confirm, in display order; `null` closes the dialog. */
  confirmations: readonly TargetCompletionOverlapConfirmation[] | null
  mode: CompletionOverlapSaveMode
  /** 「編集へ戻る」, Escape and the backdrop: nothing is saved. */
  onBack(): void
  /** 「別の1本として登録する」 / 「別の1本として保存する」: the ordinary save continues. */
  onContinue(): void
}

/**
 * The completion condition overlap confirmation (Issue #338,
 * `docs/UI_FLOW.md` 8.5), shown over the Target edit dialog before the
 * breaking-change inspection. Each listed Target carries its relation in words
 * - 「完成条件が同じ」 or 「一部の完成武器で条件が重なる」 - plus 「検索対象OFF」 /
 * 「完成条件の再設定が必要」 when they apply, so nothing relies on colour. Only the
 * list scrolls, keyboard reachable, while the title, the separate-weapon note
 * and the actions stay in view. 「編集へ戻る」 holds the initial focus and is what
 * Escape does. Focus is restored by the caller, which knows the control that
 * opened it.
 */
export function TargetCompletionOverlapDialog({
  confirmations,
  mode,
  onBack,
  onContinue,
}: TargetCompletionOverlapDialogProps) {
  const titleId = useId()
  const leadId = useId()
  const listHeadingId = useId()
  const open = confirmations !== null
  const entries = confirmations ?? []
  return (
    <Dialog
      open={open}
      onClose={onBack}
      aria-labelledby={titleId}
      aria-describedby={leadId}
      // The caller returns focus to 保存 once the save it paused is settled.
      disableRestoreFocus
      fullWidth
      maxWidth="sm"
      slotProps={{
        paper: {
          sx: {
            m: { xs: 1, sm: 4 },
            width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
            maxHeight: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
          },
        },
      }}
    >
      <DialogTitle id={titleId} sx={{ px: { xs: 2, sm: 3 }, overflowWrap: 'anywhere' }}>
        {COMPLETION_OVERLAP_TITLE}
      </DialogTitle>
      <DialogContent
        sx={{ px: { xs: 2, sm: 3 }, display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 0 }}
      >
        <Typography id={leadId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {COMPLETION_OVERLAP_LEAD}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Typography id={listHeadingId} component="h3" variant="subtitle2">
            {COMPLETION_OVERLAP_LIST_LABEL}
          </Typography>
          <Typography variant="body2" color="text.secondary" className="tabular-nums">
            {completionOverlapCountText(entries.length)}
          </Typography>
        </Stack>
        <Box
          role="region"
          aria-labelledby={listHeadingId}
          // Keyboard users can scroll a long list; Tab goes on to the actions.
          tabIndex={0}
          sx={(theme) => ({
            flexShrink: 1,
            minHeight: 0,
            maxHeight: { xs: 'min(36dvh, 280px)', sm: 'min(40vh, 320px)' },
            overflowY: 'auto',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            '&:focus-visible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          })}
        >
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {entries.map(({ target, overlap }, index) => (
              <Stack
                component="li"
                key={target.id}
                spacing={0.75}
                sx={{ px: 1.5, py: 1.25, minWidth: 0, borderTop: index === 0 ? 0 : 1, borderColor: 'divider' }}
              >
                <Typography variant="body1" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                  {target.name}
                </Typography>
                <Stack direction="row" useFlexGap spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                  <StatusChip
                    component="span"
                    label={completionOverlapLabels[overlap]}
                    tone={overlap === 'identical' ? 'caution' : 'info'}
                  />
                  {!target.isEnabled && (
                    <StatusChip component="span" label={COMPLETION_OVERLAP_DISABLED_LABEL} tone="neutral" />
                  )}
                  {target.completionConditionReview.length > 0 && (
                    <StatusChip component="span" label={COMPLETION_OVERLAP_REVIEW_LABEL} tone="caution" />
                  )}
                </Stack>
              </Stack>
            ))}
          </Box>
        </Box>
        <Alert severity="info" sx={{ flexShrink: 0, '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
          {completionOverlapSeparateWeaponNote(mode)}
        </Alert>
      </DialogContent>
      <DialogActions disableSpacing sx={{ px: { xs: 2, sm: 3 }, py: 1.5, gap: 1, flexWrap: 'wrap', flexShrink: 0 }}>
        <Button variant="outlined" autoFocus onClick={onBack} sx={actionSx}>
          {COMPLETION_OVERLAP_BACK_LABEL}
        </Button>
        <Button variant="contained" onClick={onContinue} sx={actionSx}>
          {completionOverlapContinueLabel(mode)}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
