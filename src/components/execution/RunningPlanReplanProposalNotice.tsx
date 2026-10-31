import { useId } from 'react'
import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material'
import {
  RUNNING_PLAN_REPLAN_PROPOSAL_ACTION_NOTE,
  RUNNING_PLAN_REPLAN_PROPOSAL_DISMISS_LABEL,
  RUNNING_PLAN_REPLAN_PROPOSAL_OPEN_LABEL,
  RUNNING_PLAN_REPLAN_PROPOSAL_TITLE,
  runningPlanReplanProposalLead,
} from './runningPlanReplanGuidancePresentation'

/**
 * The proposal right after a Build List addition (`docs/UI_FLOW.md` 9 / 16.5 「提案」, `docs/PLANNER_SPEC.md` 18.3): the Targets the
 * saved operation made available to take into the running Plan, and an explicit 「再計画を開く」. Which Targets it names is the Domain's
 * proposal (`deriveReplanProposalAfterBuildListChange()`), never decided here.
 *
 * Non-modal and polite: a `role="status"` region announced once, that never takes the focus, never closes by itself and never starts a
 * replan. 「閉じる」 drops it for good - nothing is persisted, so a re-visit or a reload never shows it again. The actions wrap under the
 * text at a phone width with 44px targets, and long names wrap instead of widening the page.
 */
export function RunningPlanReplanProposalNotice({
  targetNames,
  onOpen,
  onDismiss,
}: {
  /** The proposed Targets' names, in the proposal's order. */
  targetNames: readonly string[]
  onOpen(): void
  onDismiss(): void
}) {
  const noteId = useId()
  if (targetNames.length === 0) return null
  return (
    <Alert severity="info" role="status" aria-atomic="true" sx={{ '& .MuiAlert-message': { minWidth: 0, width: '100%' } }}>
      <AlertTitle>{RUNNING_PLAN_REPLAN_PROPOSAL_TITLE}</AlertTitle>
      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {runningPlanReplanProposalLead(targetNames)}
        </Typography>
        {targetNames.length > 1 && (
          <Box component="ul" aria-label="実行中の生産計画では作成されない目標武器" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
            {targetNames.map((name, index) => (
              <Typography component="li" variant="body2" key={`${index}:${name}`} sx={{ overflowWrap: 'anywhere' }}>
                {name}
              </Typography>
            ))}
          </Box>
        )}
        <Typography id={noteId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {RUNNING_PLAN_REPLAN_PROPOSAL_ACTION_NOTE}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            color="inherit"
            onClick={onOpen}
            aria-describedby={noteId}
            sx={{ minHeight: 44 }}
          >
            {RUNNING_PLAN_REPLAN_PROPOSAL_OPEN_LABEL}
          </Button>
          <Button variant="text" color="inherit" onClick={onDismiss} sx={{ minHeight: 44 }}>
            {RUNNING_PLAN_REPLAN_PROPOSAL_DISMISS_LABEL}
          </Button>
        </Stack>
      </Stack>
    </Alert>
  )
}
