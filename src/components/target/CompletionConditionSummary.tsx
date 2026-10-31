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
  completionVariantHeading,
  minimumRankSlotLabel,
} from './completionConditionPresentation'

/**
 * The completion condition of one Target as a list shows it (`docs/UI_FLOW.md`
 * 8): how many Variants there are, every Variant's five slots with their
 * minimum ranks (each slot read as 「… III以上」, the highest rank as 「… EX」), and the completion Skill
 * condition. Display only.
 */
export function CompletionConditionSummary({ target, master }: {
  target: Pick<TargetWeapon, 'weaponTypeId' | 'completionBonusVariants' | 'completionSkillCondition'>
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
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        完成スキル: {skillConditionSummary(target.completionSkillCondition, master)}
      </Typography>
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
