import { areRestorationBonusSetsEqual } from '../models/domainRules'
import type {
  GroupSkillId, RestorationBonusScope, RestorationBonusSet,
  SeriesSkillId, TargetWeapon,
} from '../models/publicTypes'
import {
  assertRestorationBonusRankReferences, evaluateAlternativeBonusRule,
  evaluatePracticalBonusConditions,
} from './bonusConditionEvaluator'
import { createIdealDifference } from './idealDifference'
import { evaluateSkillCondition } from './skillConditionEvaluator'
import type { TargetEvaluationMasterSubset, TargetEvaluationResult } from './targetEvaluationTypes'

export function hasPracticalSkillCondition(target: TargetWeapon): boolean {
  const condition = target.practicalSkillCondition
  return condition.seriesSkillId !== null || condition.groupSkillId !== null
}

export function hasTargetCompromise(target: TargetWeapon): boolean {
  return target.practicalBonusConditions.length > 0 || target.alternativeBonusRules.length > 0 ||
    hasPracticalSkillCondition(target)
}

/** Scope is explicit; invalid Master references fail even for normal scope. */
export function satisfiesIdealBonuses(
  target: TargetWeapon, finalBonuses: RestorationBonusSet,
  restorationBonusScope: RestorationBonusScope, master: TargetEvaluationMasterSubset,
): boolean {
  assertRestorationBonusRankReferences(target.idealBonuses, master)
  assertRestorationBonusRankReferences(finalBonuses, master)
  return restorationBonusScope === 'gogma_artian' &&
    areRestorationBonusSetsEqual(target.idealBonuses, finalBonuses)
}

export function evaluateTargetBonusMatch(
  target: TargetWeapon, bonuses: RestorationBonusSet, scope: RestorationBonusScope,
  master: TargetEvaluationMasterSubset,
): TargetEvaluationResult['bonusMatch'] {
  if (satisfiesIdealBonuses(target, bonuses, scope, master)) return 'ideal'
  if (scope !== 'gogma_artian') return null
  if (target.practicalBonusConditions.length > 0 && evaluatePracticalBonusConditions(target, bonuses, master)) return 'practical'
  if (target.alternativeBonusRules.some((rule) => evaluateAlternativeBonusRule(rule, target.idealBonuses, bonuses, master))) return 'alternative'
  return null
}

export function evaluateTargetSkillMatch(
  target: TargetWeapon, series: SeriesSkillId | null, group: GroupSkillId | null,
): TargetEvaluationResult['skillMatch'] {
  if (evaluateSkillCondition(target.idealSkillCondition, series, group)) return 'ideal'
  return hasPracticalSkillCondition(target) && evaluateSkillCondition(target.practicalSkillCondition, series, group)
    ? 'practical' : null
}

export function satisfiesIdealTarget(
  target: TargetWeapon, bonuses: RestorationBonusSet, scope: RestorationBonusScope,
  series: SeriesSkillId | null, group: GroupSkillId | null, master: TargetEvaluationMasterSubset,
): boolean {
  return satisfiesIdealBonuses(target, bonuses, scope, master) &&
    evaluateSkillCondition(target.idealSkillCondition, series, group)
}

/** Inclusive accepted set, also used for Planner's hasPractical satisfaction. */
export function satisfiesPracticalTarget(
  target: TargetWeapon, bonuses: RestorationBonusSet, scope: RestorationBonusScope,
  series: SeriesSkillId | null, group: GroupSkillId | null, master: TargetEvaluationMasterSubset,
): boolean {
  return evaluateTargetBonusMatch(target, bonuses, scope, master) !== null &&
    evaluateTargetSkillMatch(target, series, group) !== null
}

/**
 * The two axis matches plus the ideal difference of one concrete state.
 *
 * It no longer classifies a Candidate: the caller decides what the pair means -
 * `satisfiesIdealTarget()` for a Candidate, and the intermediate state
 * extraction evaluates each axis on its own lane (`docs/SEARCH_SPEC.md` 5.8).
 */
export function evaluateTargetCandidate(
  target: TargetWeapon, bonuses: RestorationBonusSet, scope: RestorationBonusScope,
  series: SeriesSkillId | null, group: GroupSkillId | null, master: TargetEvaluationMasterSubset,
): TargetEvaluationResult {
  return {
    bonusMatch: evaluateTargetBonusMatch(target, bonuses, scope, master),
    skillMatch: evaluateTargetSkillMatch(target, series, group),
    idealDifference: createIdealDifference(target, bonuses, series, group),
  }
}
