import { useId } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material'
import type { OwnedGogmaArtianWeapon, TargetWeapon } from '../../domain/models/publicTypes'
import { DialogFormError } from '../DialogFormError'
import {
  COMPLETE_WITH_OWNED_IDEAL_AFFECTED_HEADING,
  COMPLETE_WITH_OWNED_IDEAL_AFFECTED_NOTE,
  COMPLETE_WITH_OWNED_IDEAL_LABEL,
  COMPLETE_WITH_OWNED_IDEAL_TITLE,
  COMPLETE_WITH_OWNED_IDEAL_UNCHANGED_NOTE,
} from './ownedIdealPresentation'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

export interface OwnedIdealCompletionDialogProps {
  /** The pending completion; `null` keeps the dialog closed. */
  pending: { target: TargetWeapon; weapon: OwnedGogmaArtianWeapon } | null
  /** The other Targets that prefer the weapon and will lose that preference. */
  affectedTargets: readonly TargetWeapon[]
  submitting: boolean
  error: string | null
  onCancel(): void
  onConfirm(): void
}

/**
 * The confirmation 「この武器で目標を完了にする」 requires (`docs/UI_FLOW.md` 8.2):
 * what the weapon and the Target become, that the weapon's performance stays,
 * and - by name - every other Target whose preference the completion releases.
 * The breaking-change warning, when the runtime asks for one, follows this
 * dialog through the shared controller; neither confirmation is skipped.
 */
export function OwnedIdealCompletionDialog({
  pending,
  affectedTargets,
  submitting,
  error,
  onCancel,
  onConfirm,
}: OwnedIdealCompletionDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  if (pending === null) return null
  return (
    <Dialog
      open
      onClose={() => {
        if (!submitting) onCancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>{COMPLETE_WITH_OWNED_IDEAL_TITLE}</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            武器「{pending.weapon.name}」を理想品・保護ありにし、目標武器「{pending.target.name}」を完了済みにします。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            {COMPLETE_WITH_OWNED_IDEAL_UNCHANGED_NOTE}
          </Typography>
          {affectedTargets.length > 0 && (
            <>
              <Typography component="p" variant="body2" sx={{ mt: 1.5 }}>
                {COMPLETE_WITH_OWNED_IDEAL_AFFECTED_HEADING}
              </Typography>
              <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                {affectedTargets.map((target) => (
                  <Typography component="li" variant="body2" key={target.id} sx={{ overflowWrap: 'anywhere' }}>
                    {target.name}
                  </Typography>
                ))}
              </Box>
              <Typography component="p" variant="body2" sx={{ mt: 1 }}>
                {COMPLETE_WITH_OWNED_IDEAL_AFFECTED_NOTE}
              </Typography>
            </>
          )}
        </DialogContentText>
      </DialogContent>
      {error !== null && <DialogFormError message={error} />}
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={submitting} sx={actionSx}>
          {COMPLETE_WITH_OWNED_IDEAL_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
