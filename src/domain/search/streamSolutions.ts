import type {
  BonusAmendmentResult,
  GroupSkillId,
  RestorationBonusScope,
  RestorationBonusSet,
  RouteOperation,
  SeriesSkillId,
  SkillAmendmentResult,
  TargetWeapon,
} from '../models/publicTypes'
import { stableStringify } from '../models/publicTypes'
import { bonusOutcomeKey, bonusSolutionRetentionKey, compareStableKeys } from './semanticKeys'
export { compareStableKeys } from './semanticKeys'
import {
  createBonusIdealDifference,
  evaluateSkillCondition,
  satisfiesIdealBonuses,
} from '../target'
import { totalMaterialQuantity } from './candidateFactory'
import type { CandidateSearchInput } from './searchTypes'

/**
 * One Skill stream solution as seen by a single Route base, including the
 * zero-operation solution (SEARCH_SPEC 5.5.5).
 *
 * `resetCount = 0` is the Route base's own current Skills: the source Gogma's
 * stored Skills, or the Skills assigned by `convert_normal_to_gogma`.
 */
export interface RouteSkillSolution {
  resetCount: number
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  /** `resetCount` for existing Gogma bases, `resetCount + 1` for conversion. */
  estimatedSkillAdvance: number
  /** Reset Skills operations in execution order; empty when `resetCount = 0`. */
  operations: readonly RouteOperation[]
  /**
   * The predicted Skills right after each entry of `operations`, aligned
   * index-for-index with it. Observational only: no retention key, ordering
   * comparator, or Candidate identity reads it.
   */
  amendmentResults: readonly SkillAmendmentResult[]
}

/**
 * One Bonus stream solution as seen by a single Route base, including the
 * zero-operation solution (SEARCH_SPEC 5.5.5).
 *
 * `gogmaAdvance = 0` is the Route base's own five slots: the source Gogma's
 * stored bonuses, or the five `normal_artian` scope slots a conversion
 * inherits. `lastResetDepth` carries the canonical amendment history so the
 * existing-Gogma RouteKind follows from `(d, lastResetDepth)` alone.
 */
export interface RouteBonusSolution {
  gogmaAdvance: number
  lastResetDepth: number
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  /** Bonus amendment operations in execution order; empty when `d = 0`. */
  operations: readonly RouteOperation[]
  /**
   * The predicted five slots right after each entry of `operations`, aligned
   * index-for-index with it. Observational only: no retention key, ordering
   * comparator, or Candidate identity reads it.
   */
  amendmentResults: readonly BonusAmendmentResult[]
}

export interface EvaluatedSkillSolution {
  /** Position in the retained, deterministically ordered stream set. */
  index: number
  solution: RouteSkillSolution
  idealMatch: boolean
  /** Matched count among the series / group actually specified by Ideal. */
  idealCloseness: number
  semanticKey: string
}

export interface EvaluatedBonusSolution {
  index: number
  solution: RouteBonusSolution
  idealMatch: boolean
  matchedIdealBonusCount: number
  /** Anchor-ordering tie-break only; never a dominance input. */
  materialQuantity: number
  /** Pure completed multiset, used for existing semantic ordering. */
  bonusKey: string
  /** Scope plus multiset, shared by full-prefix, incremental and delta Cross. */
  retentionKey: string
  operationTypeKey: string
}

/**
 * SEARCH_SPEC 5.5.2 stream-local ideal closeness. A `null` side of
 * `idealSkillCondition` is unconstrained, so it is never counted as a match.
 */
function skillIdealCloseness(
  target: TargetWeapon,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): number {
  const condition = target.idealSkillCondition
  return (
    Number(
      condition.seriesSkillId !== null &&
        condition.seriesSkillId === seriesSkillId,
    ) +
    Number(
      condition.groupSkillId !== null && condition.groupSkillId === groupSkillId,
    )
  )
}

function evaluateSkillSolution(
  target: TargetWeapon,
  solution: RouteSkillSolution,
): Omit<EvaluatedSkillSolution, 'index'> {
  return {
    solution,
    idealMatch: evaluateSkillCondition(
      target.idealSkillCondition,
      solution.seriesSkillId,
      solution.groupSkillId,
    ),
    idealCloseness: skillIdealCloseness(
      target,
      solution.seriesSkillId,
      solution.groupSkillId,
    ),
    semanticKey: stableStringify({
      seriesSkillId: solution.seriesSkillId,
      groupSkillId: solution.groupSkillId,
    }),
  }
}

function evaluateBonusSolution(
  target: TargetWeapon,
  input: Pick<CandidateSearchInput, 'master'>,
  solution: RouteBonusSolution,
): Omit<EvaluatedBonusSolution, 'index'> {
  return {
    solution,
    idealMatch: satisfiesIdealBonuses(
      target,
      solution.finalBonuses,
      solution.restorationBonusScope,
      input.master,
    ),
    matchedIdealBonusCount: createBonusIdealDifference(
      target.idealBonuses,
      solution.finalBonuses,
    ).matchedBonusCount,
    materialQuantity: totalMaterialQuantity(
      solution.operations,
      target.weaponTypeId,
      input,
    ),
    bonusKey: bonusOutcomeKey(solution.finalBonuses),
    retentionKey: bonusSolutionRetentionKey(solution.finalBonuses, solution.restorationBonusScope),
    operationTypeKey: solution.operations
      .map((operation) => operation.type)
      .join(','),
  }
}

/** SEARCH_SPEC 5.5.2 ordering: resetCount, ideal closeness, stable key. */
export function compareSkillSolutions(
  left: Omit<EvaluatedSkillSolution, 'index'>,
  right: Omit<EvaluatedSkillSolution, 'index'>,
): number {
  return (
    left.solution.resetCount - right.solution.resetCount ||
    right.idealCloseness - left.idealCloseness ||
    compareStableKeys(left.semanticKey, right.semanticKey)
  )
}

/**
 * SEARCH_SPEC 5.5.3 ordering: gogmaAdvance, ideal closeness, summed material
 * quantity, then the stable semantic key (completed multiset, then operation
 * type sequence, then scope).
 */
export function compareBonusSolutions(
  left: Omit<EvaluatedBonusSolution, 'index'>,
  right: Omit<EvaluatedBonusSolution, 'index'>,
): number {
  return (
    left.solution.gogmaAdvance - right.solution.gogmaAdvance ||
    right.matchedIdealBonusCount - left.matchedIdealBonusCount ||
    left.materialQuantity - right.materialQuantity ||
    compareStableKeys(left.bonusKey, right.bonusKey) ||
    compareStableKeys(left.operationTypeKey, right.operationTypeKey) ||
    compareStableKeys(left.solution.restorationBonusScope, right.solution.restorationBonusScope)
  )
}

/**
 * Evaluates and deterministically orders the Skill stream solutions of one
 * Route base WITHOUT applying the initial-Search retention of SEARCH_SPEC
 * 5.5.2.
 *
 * Every comparator key is derived from its own solution alone and the sort is
 * stable, so ordering any subset (the Ideal solutions only, as the Planner
 * Alternative publication does) gives the same relative order as ordering the
 * whole set and then filtering. Keep that property when changing a key.
 *
 * The Planner-driven constrained enumerator (5.6.7) must be able to offer the
 * same Skill outcome reached at a later `resetCount`, because the Planner
 * matches `RouteOperation.counterBefore` against the runtime Counter. Ordering
 * is the same total order `buildSkillSolutionSet()` uses, so `K(c)[0]` is
 * identical in both boundaries.
 */
export function evaluateSkillSolutions(
  target: TargetWeapon,
  solutions: readonly RouteSkillSolution[],
): EvaluatedSkillSolution[] {
  return solutions
    .map((solution) => evaluateSkillSolution(target, solution))
    .sort(compareSkillSolutions)
    .map((evaluated, index) => ({ ...evaluated, index }))
}

/**
 * The Bonus counterpart of `evaluateSkillSolutions()`: evaluation and ordering
 * without the initial-Search `(scope, completed multiset)` retention of
 * SEARCH_SPEC 5.5.3. The B2 family-layout frontier reduction is a Bonus stream
 * concern and is unaffected: this function only sees what the stream published.
 * The subset-ordering property of `evaluateSkillSolutions()` holds here too.
 */
export function evaluateBonusSolutions(
  target: TargetWeapon,
  input: Pick<CandidateSearchInput, 'master'>,
  solutions: readonly RouteBonusSolution[],
): EvaluatedBonusSolution[] {
  return solutions
    .map((solution) => evaluateBonusSolution(target, input, solution))
    .sort(compareBonusSolutions)
    .map((evaluated, index) => ({ ...evaluated, index }))
}

/**
 * Evaluates, retains, and deterministically orders the Skill stream solutions
 * of one Route base.
 *
 * Retention keeps the smallest `resetCount` per `(seriesSkillId, groupSkillId)`
 * (SEARCH_SPEC 5.5.2). That is an initial-Search retention rule, not a
 * permanent Planner dominance: a later position reaching the same Skills stays
 * reachable by the constrained re-search (5.6.4).
 */
export function buildSkillSolutionSet(
  target: TargetWeapon,
  solutions: readonly RouteSkillSolution[],
): EvaluatedSkillSolution[] {
  const retained = new Map<string, Omit<EvaluatedSkillSolution, 'index'>>()
  solutions.forEach((solution) => {
    const evaluated = evaluateSkillSolution(target, solution)
    const current = retained.get(evaluated.semanticKey)
    if (!current || compareSkillSolutions(evaluated, current) < 0) {
      retained.set(evaluated.semanticKey, evaluated)
    }
  })
  return [...retained.values()]
    .sort(compareSkillSolutions)
    .map((evaluated, index) => ({ ...evaluated, index }))
}

/**
 * Evaluates, retains, and deterministically orders the Bonus stream solutions
 * of one Route base.
 *
 * Retention keeps the smallest `gogmaAdvance` per (scope, completed multiset)
 * (SEARCH_SPEC 5.5.3). Slot order alone never creates a second solution, while
 * inherited Normal and Gogma outcomes stay distinct. Ties at the same depth pick the
 * representative that comes first in the ordering above. As with the Skill
 * stream this is initial-Search retention, not permanent dominance.
 */
export function buildBonusSolutionSet(
  target: TargetWeapon,
  input: Pick<CandidateSearchInput, 'master'>,
  solutions: readonly RouteBonusSolution[],
): EvaluatedBonusSolution[] {
  const retained = new Map<string, Omit<EvaluatedBonusSolution, 'index'>>()
  solutions.forEach((solution) => {
    const evaluated = evaluateBonusSolution(target, input, solution)
    const current = retained.get(evaluated.retentionKey)
    if (!current || compareBonusSolutions(evaluated, current) < 0) {
      retained.set(evaluated.retentionKey, evaluated)
    }
  })
  return [...retained.values()]
    .sort(compareBonusSolutions)
    .map((evaluated, index) => ({ ...evaluated, index }))
}

/**
 * `K`: the ordered Skill solutions satisfying the Target's Ideal Skill
 * condition.
 *
 * There is no Practical axis any more. Composing a Practical result would
 * create an independent compromise Candidate, and a compromise is only offered
 * as a checkpoint on a real Ideal Route (`docs/SEARCH_SPEC.md` 5.5.4).
 */
export function selectIdealSkillAxis(
  set: readonly EvaluatedSkillSolution[],
): EvaluatedSkillSolution[] {
  return set.filter((entry) => entry.idealMatch)
}

/** `B`: the ordered Bonus solutions satisfying the Target's Ideal Bonuses. */
export function selectIdealBonusAxis(
  set: readonly EvaluatedBonusSolution[],
): EvaluatedBonusSolution[] {
  return set.filter((entry) => entry.idealMatch)
}
