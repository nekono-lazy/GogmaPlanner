import { getBonusRank } from '../master/masterSelectors'
import type {
  AlternativeBonusRule, PracticalBonusCondition, RestorationBonus,
  RestorationBonusSet, TargetWeapon,
} from '../models/publicTypes'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

export function assertRestorationBonusRankReferences(
  bonuses: readonly RestorationBonus[], master: TargetEvaluationMasterSubset,
): void {
  bonuses.forEach((bonus) => getBonusRank(master, bonus.bonusRankId))
}

function ranksMatch(
  bonuses: readonly RestorationBonus[], minimumRankId: string, requiredExCount: number,
  master: TargetEvaluationMasterSubset,
): boolean {
  const minimum = getBonusRank(master, minimumRankId).order
  return bonuses.every((bonus) => getBonusRank(master, bonus.bonusRankId).order >= minimum) &&
    bonuses.filter((bonus) => getBonusRank(master, bonus.bonusRankId).isEx).length >= requiredExCount
}

/** Checks every slot of this type; the Target supplies the required count. */
export function evaluateBonusCondition(
  condition: PracticalBonusCondition, bonuses: RestorationBonusSet,
  master: TargetEvaluationMasterSubset,
): boolean {
  assertRestorationBonusRankReferences(bonuses, master)
  const slots = bonuses.filter((bonus) => bonus.bonusTypeId === condition.bonusTypeId)
  return slots.length > 0 && ranksMatch(slots, condition.minimumRankId, condition.requiredExCount, master)
}

function key(bonus: RestorationBonus): string {
  return JSON.stringify([bonus.bonusTypeId, bonus.bonusRankId])
}

function subtract(remaining: RestorationBonus[], required: readonly RestorationBonus[]): boolean {
  for (const bonus of required) {
    const index = remaining.findIndex((value) => key(value) === key(bonus))
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  return true
}

export function evaluatePracticalBonusConditions(
  target: Pick<TargetWeapon, 'idealBonuses' | 'practicalBonusConditions'>,
  bonuses: RestorationBonusSet, master: TargetEvaluationMasterSubset,
): boolean {
  assertRestorationBonusRankReferences(target.idealBonuses, master)
  assertRestorationBonusRankReferences(bonuses, master)
  const types = new Set(target.idealBonuses.map((bonus) => bonus.bonusTypeId))
  if (bonuses.some((bonus) => !types.has(bonus.bonusTypeId))) return false
  return [...types].every((type) => {
    const ideal = target.idealBonuses.filter((bonus) => bonus.bonusTypeId === type)
    const actual = bonuses.filter((bonus) => bonus.bonusTypeId === type)
    if (ideal.length !== actual.length) return false
    const condition = target.practicalBonusConditions.find((entry) => entry.bonusTypeId === type)
    return condition
      ? ranksMatch(actual, condition.minimumRankId, condition.requiredExCount, master)
      : subtract([...actual], ideal)
  })
}

/** One rule / one option. Original destination slots are removed before EX counting. */
export function evaluateAlternativeBonusRule(
  rule: AlternativeBonusRule, ideal: RestorationBonusSet,
  bonuses: RestorationBonusSet, master: TargetEvaluationMasterSubset,
): boolean {
  assertRestorationBonusRankReferences(ideal, master)
  assertRestorationBonusRankReferences(bonuses, master)
  const source = ideal.filter((bonus) => bonus.bonusTypeId === rule.sourceBonusTypeId)
  const actualSource = bonuses.filter((bonus) => bonus.bonusTypeId === rule.sourceBonusTypeId)
  const count = source.length - actualSource.length
  if (count < 1 || count > rule.maxReplacementCount) return false
  if (!subtract([...source], actualSource)) return false
  const remaining = [...bonuses]
  if (!subtract(remaining, ideal.filter((bonus) => bonus.bonusTypeId !== rule.sourceBonusTypeId))) return false
  if (!subtract(remaining, actualSource) || remaining.length !== count) return false
  return rule.options.some((option) =>
    remaining.every((bonus) => bonus.bonusTypeId === option.alternativeBonusTypeId) &&
    ranksMatch(remaining, option.minimumRankId, option.requiredExCount, master),
  )
}
