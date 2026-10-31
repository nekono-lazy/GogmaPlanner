import {
  AchievedCompletionSkillVariants,
  AchievedCompletionVariants,
} from '../target/AchievedCompletionVariants'
import {
  ACHIEVED_COMPLETION_SKILL_VARIANTS_LABEL,
  ACHIEVED_COMPLETION_VARIANTS_LABEL,
  type AchievedCompletionSkillVariants as AchievedCompletionSkillVariantsResult,
  type AchievedCompletionVariants as AchievedCompletionVariantsResult,
} from '../target/completionConditionPresentation'
import { SearchDefinitionItem } from './SearchDefinitionList'

/**
 * The 「達成した完成構成」 row of one concrete result and, for a Target with two
 * or more completion Skill configurations (Issue #367), the
 * 「達成した完成スキル構成」 row beside it (`docs/UI_FLOW.md` 8), for the
 * Candidate card and the Build List replacement. Both are judged by the caller
 * at display time; the note that the condition may have changed since is said
 * once, under the last row that does not hold.
 */
export function AchievedCompletionDefinitionItems({
  achieved,
  skill,
}: {
  achieved: AchievedCompletionVariantsResult
  skill: AchievedCompletionSkillVariantsResult | null
}) {
  return (
    <>
      <SearchDefinitionItem label={ACHIEVED_COMPLETION_VARIANTS_LABEL}>
        <AchievedCompletionVariants achieved={achieved} showNote={skill?.kind !== 'not_achieved'} />
      </SearchDefinitionItem>
      {skill !== null && (
        <SearchDefinitionItem label={ACHIEVED_COMPLETION_SKILL_VARIANTS_LABEL}>
          <AchievedCompletionSkillVariants achieved={skill} />
        </SearchDefinitionItem>
      )}
    </>
  )
}
