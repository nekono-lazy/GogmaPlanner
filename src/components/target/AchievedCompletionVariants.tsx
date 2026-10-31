import { Stack, Typography } from '@mui/material'
import {
  ACHIEVED_COMPLETION_SKILL_VARIANTS_LABEL,
  ACHIEVED_COMPLETION_VARIANTS_LABEL,
  ACHIEVED_COMPLETION_VARIANTS_NOT_ACHIEVED_NOTE,
  achievedCompletionSkillVariantsText,
  achievedCompletionVariantsText,
  type AchievedCompletionSkillVariants as AchievedCompletionSkillVariantsResult,
  type AchievedCompletionVariants as AchievedCompletionVariantsResult,
} from './completionConditionPresentation'

type AchievedKind = AchievedCompletionVariantsResult['kind']

const achievedColor = (kind: AchievedKind) =>
  kind === 'achieved' ? 'text.primary' : kind === 'not_achieved' ? 'warning.main' : 'text.secondary'

function AchievedNote() {
  return (
    <Typography component="span" variant="caption" color="text.secondary">
      {ACHIEVED_COMPLETION_VARIANTS_NOT_ACHIEVED_NOTE}
    </Typography>
  )
}

/**
 * The completion Variants one concrete result achieves (`docs/REQUIREMENTS.md`
 * 13.2), shared by every screen that shows such a result: the Candidate card
 * (Search / Build List), the Build List replacement, the owned Ideal notice,
 * the Build List optimization Preview, the running Plan replan Preview and the
 * Execution Navigator.
 *
 * The caller judges with `describeAchievedCompletionVariants()` - the Domain's
 * `satisfiedCompletionBonusVariants()` - and, for a Target with two or more
 * completion Skill configurations (Issue #367), with
 * `describeAchievedCompletionSkillVariants()` - the Domain's
 * `satisfiedCompletionSkillVariants()` - and this only says it: every achieved
 * Variant by name, 「現在の完成条件では満たしません」 when none is, or why it
 * cannot be told. The two sides stay apart: the Bonus side is never read as the
 * Skill side or the other way round. The state is in the words, never in a
 * colour alone, and the note that the condition may have changed since is said
 * once, whichever side does not hold.
 *
 * `layout="value"` is the value of a 「達成した完成構成」 row the caller labels
 * itself (the Skill side then goes in its own row,
 * `AchievedCompletionSkillVariants`); `layout="line"` carries its own labels and
 * adds the 「達成した完成スキル構成」 line when `skill` is given.
 * `component="span"` keeps the whole statement phrasing content, for a caller
 * that places it inside a button (a disclosure's summary).
 */
export function AchievedCompletionVariants({
  achieved,
  skill = null,
  layout = 'value',
  showNote = true,
  component = 'div',
}: {
  achieved: AchievedCompletionVariantsResult
  /** The completion Skill configurations the same result achieves; `null` when the Target holds one (nothing extra is shown). */
  skill?: AchievedCompletionSkillVariantsResult | null
  layout?: 'value' | 'line'
  /** Whether 「現在の完成条件では満たしません」 explains that the condition may have changed since. */
  showNote?: boolean
  component?: 'div' | 'span'
}) {
  const text = achievedCompletionVariantsText(achieved)
  const skillLine = layout === 'line' ? skill : null
  const noteShown = showNote && (achieved.kind === 'not_achieved' || skillLine?.kind === 'not_achieved')
  return (
    <Stack component={component} spacing={0.25} sx={{ minWidth: 0 }} data-achieved-completion-variants={achieved.kind}>
      <Typography component="span" variant="body2" sx={{ color: achievedColor(achieved.kind), overflowWrap: 'anywhere' }}>
        {layout === 'line' ? `${ACHIEVED_COMPLETION_VARIANTS_LABEL}: ${text}` : text}
      </Typography>
      {skillLine !== null && (
        <Typography
          component="span"
          variant="body2"
          data-achieved-completion-skill-variants={skillLine.kind}
          sx={{ color: achievedColor(skillLine.kind), overflowWrap: 'anywhere' }}
        >
          {`${ACHIEVED_COMPLETION_SKILL_VARIANTS_LABEL}: ${achievedCompletionSkillVariantsText(skillLine)}`}
        </Typography>
      )}
      {noteShown && <AchievedNote />}
    </Stack>
  )
}

/**
 * The value of a 「達成した完成スキル構成」 row (Issue #367), beside the
 * 「達成した完成構成」 row of the same result: the satisfied completion Skill
 * configurations by name and Skills, 「現在の完成条件では満たしません」, or why it
 * cannot be told. Only for a Target with two or more configurations.
 */
export function AchievedCompletionSkillVariants({
  achieved,
  showNote = true,
}: {
  achieved: AchievedCompletionSkillVariantsResult
  showNote?: boolean
}) {
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }} data-achieved-completion-skill-variants={achieved.kind}>
      <Typography component="span" variant="body2" sx={{ color: achievedColor(achieved.kind), overflowWrap: 'anywhere' }}>
        {achievedCompletionSkillVariantsText(achieved)}
      </Typography>
      {achieved.kind === 'not_achieved' && showNote && <AchievedNote />}
    </Stack>
  )
}
