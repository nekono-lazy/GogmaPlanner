import type {
  GroupSkillId,
  IdealDifference,
  RestorationBonus,
  RestorationBonusSet,
  SeriesSkillId,
  TargetWeapon,
} from '../models/publicTypes'

function bonusesEqual(
  left: RestorationBonus,
  right: RestorationBonus,
): boolean {
  return (
    left.bonusTypeId === right.bonusTypeId &&
    left.bonusRankId === right.bonusRankId
  )
}

/** The Bonus half of `IdealDifference`, decomposed per SEARCH_SPEC 5.4. */
export interface BonusIdealDifference {
  missingBonuses: RestorationBonus[]
  extraBonuses: RestorationBonus[]
  matchedBonusCount: number
}

/**
 * Matches the ideal five slots against the candidate five slots as a multiset,
 * so duplicate counts are preserved and slot index never decides a match. This
 * is the single authority for `matchedBonusCount`: the Bonus stream-local
 * evaluation and `createIdealDifference()` both call it, which keeps the
 * decomposed value identical to the composed one.
 */
export function createBonusIdealDifference(
  idealBonuses: RestorationBonusSet,
  finalBonuses: RestorationBonusSet,
): BonusIdealDifference {
  const matchedCandidateSlots = new Set<number>()
  const missingBonuses: RestorationBonus[] = []

  idealBonuses.forEach((idealBonus) => {
    const matchedIndex = finalBonuses.findIndex(
      (candidateBonus, index) =>
        !matchedCandidateSlots.has(index) &&
        bonusesEqual(idealBonus, candidateBonus),
    )
    if (matchedIndex >= 0) {
      matchedCandidateSlots.add(matchedIndex)
    } else {
      missingBonuses.push({ ...idealBonus })
    }
  })

  return {
    missingBonuses,
    extraBonuses: finalBonuses
      .filter((_, index) => !matchedCandidateSlots.has(index))
      .map((bonus) => ({ ...bonus })),
    matchedBonusCount: matchedCandidateSlots.size,
  }
}

export function createIdealDifference(
  target: TargetWeapon,
  finalBonuses: RestorationBonusSet,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): IdealDifference {
  const bonusDifference = createBonusIdealDifference(
    target.idealBonuses,
    finalBonuses,
  )
  const matchedBonusCount = bonusDifference.matchedBonusCount
  const seriesSkillMatches =
    target.idealSkillCondition.seriesSkillId === null ||
    target.idealSkillCondition.seriesSkillId === seriesSkillId
  const groupSkillMatches =
    target.idealSkillCondition.groupSkillId === null ||
    target.idealSkillCondition.groupSkillId === groupSkillId

  return {
    missingBonuses: bonusDifference.missingBonuses,
    extraBonuses: bonusDifference.extraBonuses,
    matchedBonusCount,
    seriesSkillMatches,
    groupSkillMatches,
    summary: `ボーナス一致 ${matchedBonusCount}/5、シリーズ${seriesSkillMatches ? '一致' : '不一致'}、グループ${groupSkillMatches ? '一致' : '不一致'}`,
  }
}
