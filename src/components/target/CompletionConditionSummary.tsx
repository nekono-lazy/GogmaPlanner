import { Box, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { TargetWeapon } from '../../domain/models/publicTypes'
import { completionVariantMinimumBonuses } from '../../domain/target/completionCondition'
import { BonusSlotList } from '../ManagementListItem'
import { StatusChip } from '../StatusChip'
import { skillConditionSummary } from '../search/searchPresentation'
import {
  COMPLETION_CONDITION_REVIEW_CHIP_LABEL,
  COMPLETION_CONDITION_REVIEW_LIST_HINT,
  completionConditionReviewReasonLabels,
  completionSkillVariantHeading,
  completionVariantHeading,
  minimumRankSlotLabel,
} from './completionConditionPresentation'

/**
 * The completion condition of one Target as a list shows it (`docs/UI_FLOW.md`
 * 8): how many Variants there are, every Variant's five slots with their
 * minimum ranks (each slot read as 「… III以上」, the highest rank as 「… EX」), and every completion Skill
 * configuration (Issue #367): one reads as the former single condition, two or more are counted, named and
 * said to complete with any one. No configuration is ever left out. Display only.
 */
export function CompletionConditionSummary({ target, master }: {
  target: Pick<TargetWeapon, 'weaponTypeId' | 'completionBonusVariants' | 'completionSkillVariants'>
  master: MasterDataRoot
}) {
  const count = target.completionBonusVariants.length
  const single = count === 1
  return (
    <Stack spacing={1}>
      {!single && (
        <Typography variant="body2" color="text.secondary">
          完成ボーナス構成 {count}件（いずれかを満たせば完成）
        </Typography>
      )}
      {target.completionBonusVariants.map((variant, index) => (
        <BonusSlotList
          key={variant.id}
          heading={single ? '完成ボーナス構成' : completionVariantHeading(index)}
          bonuses={completionVariantMinimumBonuses(variant)}
          weaponTypeId={target.weaponTypeId}
          master={master}
          scope="gogma_artian"
          formatLabel={(label, bonusRankId) => minimumRankSlotLabel(label, bonusRankId, master)}
        />
      ))}
      {target.completionSkillVariants.length === 1 ? (
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          完成スキル: {skillConditionSummary(target.completionSkillVariants[0]!, master)}
        </Typography>
      ) : (
        <Stack spacing={0.25}>
          <Typography variant="body2" color="text.secondary">
            完成スキル構成 {target.completionSkillVariants.length}件（いずれかを満たせば完成）
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {target.completionSkillVariants.map((variant, index) => (
              <Typography component="li" key={variant.id} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {completionSkillVariantHeading(index)}: {skillConditionSummary(variant, master)}
              </Typography>
            ))}
          </Box>
        </Stack>
      )}
    </Stack>
  )
}

/**
 * The 「完成条件の再設定が必要」 chip, its reasons in words and how to clear
 * it (`docs/UI_FLOW.md` 8.4). Nothing for a Target that needs no review.
 */
export function CompletionConditionReviewStatus({ target }: { target: Pick<TargetWeapon, 'completionConditionReview'> }) {
  if (target.completionConditionReview.length === 0) return null
  return (
    <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
      <StatusChip label={COMPLETION_CONDITION_REVIEW_CHIP_LABEL} tone="caution" />
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {target.completionConditionReview.map((reason) => (
          <Typography component="li" key={reason} variant="body2" color="text.secondary">
            {completionConditionReviewReasonLabels[reason]}
          </Typography>
        ))}
      </Box>
      <Typography variant="body2" color="text.secondary">{COMPLETION_CONDITION_REVIEW_LIST_HINT}</Typography>
    </Stack>
  )
}
