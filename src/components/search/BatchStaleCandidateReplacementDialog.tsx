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
import type { BuildListResearchSelection } from '../../domain/buildList'
import { BatchCandidateResearchExclusionDisclosure } from './BatchStaleCandidateReplacementExclusionDisclosure'
import {
  BATCH_RESEARCH_DIALOG_CONFIRM_LABEL,
  BATCH_RESEARCH_DIALOG_EXCLUSION_NOTE,
  BATCH_RESEARCH_DIALOG_KEEP_NOTE,
  BATCH_RESEARCH_DIALOG_TARGETS_HEADING,
  BATCH_RESEARCH_DIALOG_TITLE,
  batchResearchDialogExcludedHeading,
  batchResearchDialogLead,
} from './batchStaleCandidateReplacementPresentation'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/** The Targets are read as a plain list; a long one scrolls inside the dialog instead of growing it past the viewport. */
const targetListSx = {
  m: 0,
  mt: 0.5,
  pl: 2.5,
  maxHeight: { xs: '30vh', sm: '36vh' },
  overflowY: 'auto',
} as const

export interface BatchCandidateResearchDialogProps {
  /** The selection the confirmation shows; `null` keeps the dialog closed. */
  selection: BuildListResearchSelection | null
  onCancel(): void
  onConfirm(): void
}

/**
 * The confirmation 「再検索が必要な候補を一括再検索・置換」 needs before it starts
 * (`docs/UI_FLOW.md` 9.3): how many and which Targets are re-searched, that the
 * registered candidate is replaced only where a new one is found and kept
 * otherwise, and - collapsed, with each reason - the stale candidates the
 * batch leaves alone. Nothing is searched or written before 「一括再検索・置換を
 * 開始」; 「キャンセル」 and Escape change nothing. The screen opens it only
 * with at least one Target to re-search (the excluded candidates alone are
 * read on the screen itself), and the start stays disabled with none.
 */
export function BatchCandidateResearchDialog({ selection, onCancel, onConfirm }: BatchCandidateResearchDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const targetsHeadingId = useId()
  if (selection === null) return null
  const { targets, excluded } = selection
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
      <DialogTitle id={titleId}>{BATCH_RESEARCH_DIALOG_TITLE}</DialogTitle>
      <DialogContent dividers>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            {batchResearchDialogLead(targets.length)}
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            {BATCH_RESEARCH_DIALOG_KEEP_NOTE}
          </Typography>
        </DialogContentText>
        <Box component="section" aria-labelledby={targetsHeadingId} sx={{ mt: 2, minWidth: 0 }}>
          <Typography id={targetsHeadingId} component="h3" variant="subtitle2">
            {BATCH_RESEARCH_DIALOG_TARGETS_HEADING}（{targets.length}件）
          </Typography>
          <Box component="ol" sx={targetListSx}>
            {targets.map(({ target }) => (
              <Typography component="li" variant="body2" key={target.id} sx={{ overflowWrap: 'anywhere' }}>
                {target.name}
              </Typography>
            ))}
          </Box>
        </Box>
        {excluded.length > 0 && (
          <Box sx={{ mt: 2, minWidth: 0 }}>
            <BatchCandidateResearchExclusionDisclosure
              excluded={excluded}
              title={batchResearchDialogExcludedHeading(excluded.length)}
              headingLevel="h3"
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {BATCH_RESEARCH_DIALOG_EXCLUSION_NOTE}
            </Typography>
          </Box>
        )}
      </DialogContent>
      {/* `disableSpacing`: the MUI sibling margin would offset the second full-width button on a phone. */}
      <DialogActions disableSpacing sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={targets.length === 0} sx={actionSx}>
          {BATCH_RESEARCH_DIALOG_CONFIRM_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
