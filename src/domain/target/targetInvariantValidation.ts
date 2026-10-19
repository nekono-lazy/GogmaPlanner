import type {
  BonusRankId,
  GroupSkillId,
  SeriesSkillId,
  SkillCondition,
  TargetWeapon,
} from '../models/publicTypes'
import type {
  DomainValidationIssue,
  DomainValidationResult,
} from '../models/validation'
import { evaluateBonusCondition } from './bonusConditionEvaluator'
import { validateTargetWeapon } from '../models/validation'
import { hasPracticalSkillCondition } from './targetEvaluator'
import { evaluateSkillCondition } from './skillConditionEvaluator'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

const UNMATCHED_SKILL_ID = 'skill.unmatched.ideal_implies_practical'

function referencedBonusRankIds(target: TargetWeapon): BonusRankId[] {
  return [
    ...target.idealBonuses.map((bonus) => bonus.bonusRankId),
    ...target.practicalBonusConditions.map(
      (condition) => condition.minimumRankId,
    ),
    ...target.alternativeBonusRules.flatMap((group) =>
      group.options.map((option) => option.minimumRankId),
    ),
  ]
}

function unresolvableBonusRankIds(
  target: TargetWeapon,
  master: TargetEvaluationMasterSubset,
): BonusRankId[] {
  const known = new Set(master.bonusRanks.filter((rank) => rank.isEnabled).map((rank) => rank.id))
  return [
    ...new Set(referencedBonusRankIds(target).filter((id) => !known.has(id))),
  ]
}

/**
 * Finite symbolic universe for one skill slot.
 *
 * `evaluateSkillCondition` observes a skill value only through the equality
 * predicates `value === ideal.<slot>` and `value === practical.<slot>`, so the
 * mentioned IDs plus one value matching neither and `null` realize every
 * combination those two predicates can take. This is a logical implication
 * check over the SkillCondition expressions themselves, not an enumeration of
 * the Skill IDs that currently exist in Master Data.
 */
function symbolicSkillValues(
  idealSkillId: string | null,
  practicalSkillId: string | null,
): (string | null)[] {
  const mentioned = [idealSkillId, practicalSkillId].filter(
    (id): id is string => id !== null,
  )
  let unmatched = UNMATCHED_SKILL_ID
  while (mentioned.includes(unmatched)) unmatched = `${unmatched}.x`
  return [...new Set<string | null>([...mentioned, unmatched, null])]
}

export function skillConditionImplies(
  ideal: SkillCondition,
  practical: SkillCondition,
): boolean {
  const seriesValues = symbolicSkillValues(
    ideal.seriesSkillId,
    practical.seriesSkillId,
  ) as (SeriesSkillId | null)[]
  const groupValues = symbolicSkillValues(
    ideal.groupSkillId,
    practical.groupSkillId,
  ) as (GroupSkillId | null)[]

  return seriesValues.every((seriesSkillId) =>
    groupValues.every((groupSkillId) => {
      if (!evaluateSkillCondition(ideal, seriesSkillId, groupSkillId)) {
        return true
      }
      return evaluateSkillCondition(practical, seriesSkillId, groupSkillId)
    }),
  )
}

/**
 * Ideal ⇒ Practical containment invariant (`docs/DATA_MODEL.md` 8.1).
 *
 * Requires Master Data because Bonus Rank comparison uses the Master `order`
 * as its authority. The Bonus side reuses the Target evaluators verbatim, so
 * validation and Target evaluation can never disagree about the same
 * condition.
 */
export function validateTargetIdealImpliesPractical(
  target: TargetWeapon,
  master: TargetEvaluationMasterSubset,
): DomainValidationResult {
  const structural = validateTargetWeapon(target)
  if (!structural.isValid) return structural
  const issues: DomainValidationIssue[] = []

  const unresolvable = unresolvableBonusRankIds(target, master)
  if (unresolvable.length > 0) {
    issues.push({
      path: 'idealBonuses',
      code: 'invalid_reference',
      message: `Ideal ⇒ Practical containment cannot be evaluated because Bonus Rank ID(s) ${unresolvable.join(', ')} are missing from Master Data.`,
    })
  } else {
    target.practicalBonusConditions.forEach((condition, index) => {
      if (evaluateBonusCondition(condition, target.idealBonuses, master)) return
      issues.push({
        path: `practicalBonusConditions[${index}]`,
        code: 'invalid_structure',
        message:
          'Ideal ⇒ Practical containment violated on the Bonus side: idealBonuses does not satisfy this practical bonus condition.',
      })
    })

  }

  if (
    hasPracticalSkillCondition(target) && !skillConditionImplies(
      target.idealSkillCondition,
      target.practicalSkillCondition,
    )
  ) {
    issues.push({
      path: 'practicalSkillCondition',
      code: 'invalid_structure',
      message:
        'Ideal ⇒ Practical containment violated on the Skill side: a skill result satisfying idealSkillCondition does not always satisfy practicalSkillCondition.',
    })
  }

  return { isValid: issues.length === 0, issues }
}
