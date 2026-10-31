import { Stack, Typography } from '@mui/material'
import {
  ACHIEVED_COMPLETION_VARIANTS_LABEL,
  ACHIEVED_COMPLETION_VARIANTS_NOT_ACHIEVED_NOTE,
  achievedCompletionVariantsText,
  type AchievedCompletionVariants as AchievedCompletionVariantsResult,
} from './completionConditionPresentation'

/**
 * The completion Variants one concrete result achieves (`docs/REQUIREMENTS.md`
 * 13.2), shared by every screen that shows such a result: the Candidate card
 * (Search / Build List), the Build List replacement, the owned Ideal notice,
 * the Build List optimization Preview and the Execution Navigator.
 *
 * The caller judges with `describeAchievedCompletionVariants()` - the Domain's
 * `satisfiedCompletionBonusVariants()` - and this only says it: every achieved
 * Variant by name, 「現在の完成条件では満たしません」 when none is, or why it
 * cannot be told. The state is in the words, never in a colour alone.
 *
 * `layout="value"` is the value of a 「達成した完成構成」 row the caller labels
 * itself; `layout="line"` carries its own label. `component="span"` keeps the
 * whole statement phrasing content, for a caller that places it inside a
 * button (a disclosure's summary).
 */
export function AchievedCompletionVariants({
  achieved,
  layout = 'value',
  showNote = true,
  component = 'div',
}: {
  achieved: AchievedCompletionVariantsResult
  layout?: 'value' | 'line'
  /** Whether 「現在の完成条件では満たしません」 explains that the condition may have changed since. */
  showNote?: boolean
  component?: 'div' | 'span'
}) {
  const text = achievedCompletionVariantsText(achieved)
  const color = achieved.kind === 'achieved'
    ? 'text.primary'
    : achieved.kind === 'not_achieved' ? 'warning.main' : 'text.secondary'
  return (
    <Stack component={component} spacing={0.25} sx={{ minWidth: 0 }} data-achieved-completion-variants={achieved.kind}>
      <Typography component="span" variant="body2" sx={{ color, overflowWrap: 'anywhere' }}>
        {layout === 'line' ? `${ACHIEVED_COMPLETION_VARIANTS_LABEL}: ${text}` : text}
      </Typography>
      {achieved.kind === 'not_achieved' && showNote && (
        <Typography component="span" variant="caption" color="text.secondary">
          {ACHIEVED_COMPLETION_VARIANTS_NOT_ACHIEVED_NOTE}
        </Typography>
      )}
    </Stack>
  )
}
