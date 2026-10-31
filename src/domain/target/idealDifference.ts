import type {
  GroupSkillId,
  IdealDifference,
  RestorationBonus,
  SeriesSkillId,
  TargetWeapon,
} from '../models/publicTypes'
import { selectClosestVariant } from './completionCondition'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

/** The Bonus half of `IdealDifference`, decomposed per SEARCH_SPEC 5.4. */
export interface BonusIdealDifference {
  missingBonuses: RestorationBonus[]
  extraBonuses: RestorationBonus[]
  matchedBonusCount: number
}

/**
 * The difference to the closest completion Variant (`docs/DATA_MODEL.md` 8.2 /
 * 9.3): the partial match count of `selectClosestVariant()` and the missing /
 * extra slots of that one mapping. A missing slot carries the Variant's minimum
 * rank ("this rank or higher"). The single authority for `matchedBonusCount`,
 * shared with the Bonus stream ordering and the constrained frontier.
 */
export function createBonusIdealDifference(
  target: Pick<TargetWeapon, 'completionBonusVariants'>,
  finalBonuses: readonly RestorationBonus[],
  master: TargetEvaluationMasterSubset,
): BonusIdealDifference {
  const closest = selectClosestVariant(finalBonuses, target.completionBonusVariants, master)
  if (closest === null) {
    return { missingBonuses: [], extraBonuses: finalBonuses.map((bonus) => ({ ...bonus })), matchedBonusCount: 0 }
  }
  return {
    missingBonuses: closest.match.missingBonuses,
    extraBonuses: closest.match.extraBonuses,
    matchedBonusCount: closest.match.matchedCount,
  }
}

/**
 * The display-only difference between one concrete state and the Target's
 * completion condition (`docs/DATA_MODEL.md` 9.3). It never takes part in
 * acceptance, ordering, identity or hashing.
 */
export function createIdealDifference(
  target: Pick<TargetWeapon, 'completionBonusVariants' | 'completionSkillCondition'>,
  finalBonuses: readonly RestorationBonus[],
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
  master: TargetEvaluationMasterSubset,
): IdealDifference {
  const bonusDifference = createBonusIdealDifference(target, finalBonuses, master)
  const matchedBonusCount = bonusDifference.matchedBonusCount
  const seriesSkillMatches =
    target.completionSkillCondition.seriesSkillId === null ||
    target.completionSkillCondition.seriesSkillId === seriesSkillId
  const groupSkillMatches =
    target.completionSkillCondition.groupSkillId === null ||
    target.completionSkillCondition.groupSkillId === groupSkillId

  return {
    missingBonuses: bonusDifference.missingBonuses,
    extraBonuses: bonusDifference.extraBonuses,
    matchedBonusCount,
    seriesSkillMatches,
    groupSkillMatches,
    summary: `ボーナス一致 ${matchedBonusCount}/5、シリーズ${seriesSkillMatches ? '一致' : '不一致'}、グループ${groupSkillMatches ? '一致' : '不一致'}`,
  }
}
