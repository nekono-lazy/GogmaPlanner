import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import type { ProductionPlanCompletionAssignmentIssue } from '../../domain/planner/productionPlanCompletionAssignmentSafety'
import {
  completionAssignmentIssueDebugText,
  completionAssignmentIssueTexts,
  COMPLETION_ASSIGNMENT_ONE_WEAPON_NOTE,
  COMPLETION_ASSIGNMENT_ZERO_OPERATION_NOTE,
  hasDuplicateCompletionWeapon,
  type CompletionAssignmentNames,
} from './completionAssignmentConflictPresentation'

export interface CompletionAssignmentConflictLink {
  label: string
  to: string
}

/**
 * The one display of a Plan the completion assignment safety refuses (Issue
 * #334, `docs/UI_FLOW.md` 12.11): a heading, the typed reasons by name, why the
 * Plan cannot go on as it is, and the recovery the caller offers. It is a
 * warning, not an error - nothing is broken or lost - and it decides nothing:
 * the issues come from the Domain judgement, and the runtime refuses the same
 * operations on its own. Reasons are text, never colour alone; IDs and typed
 * codes appear in Debug Mode only.
 */
export function CompletionAssignmentConflictAlert({
  title,
  issues,
  names,
  debugMode,
  recovery,
  links = [],
  showsZeroOperationNote = true,
}: {
  title: string
  issues: readonly ProductionPlanCompletionAssignmentIssue[]
  names: CompletionAssignmentNames
  debugMode: boolean
  /** The recovery sentences of this screen (replan, abandonment, ...). */
  recovery?: ReactNode
  links?: readonly CompletionAssignmentConflictLink[]
  showsZeroOperationNote?: boolean
}) {
  const texts = completionAssignmentIssueTexts(issues, names)
  return (
    <Alert severity="warning">
      <AlertTitle>{title}</AlertTitle>
      <Stack spacing={1.25} sx={{ minWidth: 0 }}>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
          {texts.map((text) => (
            <li key={text}>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{text}</Typography>
            </li>
          ))}
        </Box>
        <Typography variant="body2">{COMPLETION_ASSIGNMENT_ONE_WEAPON_NOTE}</Typography>
        {recovery}
        {showsZeroOperationNote && hasDuplicateCompletionWeapon(issues) && (
          <Typography variant="body2">{COMPLETION_ASSIGNMENT_ZERO_OPERATION_NOTE}</Typography>
        )}
        {links.length > 0 && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {links.map(({ label, to }) => (
              <Button key={to} component={RouterLink} to={to} variant="outlined" color="inherit" sx={{ minHeight: 44 }}>
                {label}
              </Button>
            ))}
          </Stack>
        )}
        {debugMode && (
          <Box component="ul" aria-label="完成割当の判定（Debug）" sx={{ m: 0, pl: 2.5 }}>
            {issues.map((issue, index) => (
              <li key={`${issue.reason}:${index}`}>
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {completionAssignmentIssueDebugText(issue)}
                </Typography>
              </li>
            ))}
          </Box>
        )}
      </Stack>
    </Alert>
  )
}
