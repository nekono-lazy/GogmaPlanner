import type { RestorationBonus } from '../models/publicTypes'
import { bonusRankOrder } from './completionCondition'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

/** Raises the Master Domain Error for an unknown Bonus Rank of any slot. */
export function assertRestorationBonusRankReferences(
  bonuses: readonly RestorationBonus[], master: TargetEvaluationMasterSubset,
): void {
  bonuses.forEach((bonus) => bonusRankOrder(master, bonus.bonusRankId))
}
