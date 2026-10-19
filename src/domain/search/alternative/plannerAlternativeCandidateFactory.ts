import type { TargetWeapon } from '../../models/publicTypes'
import {
  createCandidateBonusAmendmentTrace,
  createCandidateConversionSkillStep,
  createCandidateSkillAmendmentTrace,
} from '../candidateFactory'
import { createConstrainedCandidate } from '../constrained/constrainedCandidateFactory'
import type { ConstrainedSearchOrigin } from '../constrained/constrainedTypes'
import { conversionSkillPrediction } from '../routeSearchShared'
import type { ScheduledComposition } from '../targetSearchScheduler'
import type { PlannerAlternativeCandidate } from './plannerAlternativeTypes'

/**
 * Builds one transient Planner Alternative Candidate from a scheduled
 * composition, or returns `null` when the composed result is not an Ideal
 * result (`docs/SEARCH_SPEC.md` 5.6.8).
 *
 * Every field comes from an existing authority. The semantic result is
 * `createConstrainedCandidate()` - the Ideal check, Route validation, the
 * `createCandidateRouteEstimates()` estimates and materials, and both semantic
 * hashes - and the traces are the ordinary Candidate factory's own binders over
 * the amendment results the streams already recorded, plus the Route base's
 * conversion Skill checked by `conversionSkillPrediction()`. Nothing here
 * predicts, and no `id`, `searchRunId`, `createdAt`, Clock value or ordinal is
 * produced.
 */
export function createPlannerAlternativeCandidate(
  target: TargetWeapon,
  origin: ConstrainedSearchOrigin,
  { base, bonus, skill, route }: ScheduledComposition,
): PlannerAlternativeCandidate | null {
  // The advances are the reach from the Planner-start Counters: a Route that
  // crosses held positions reaches further than its own operation count, and
  // an origin-continuous Route reaches exactly its operation sum
  // (`docs/SEARCH_SPEC.md` 5.6.8).
  const candidate = createConstrainedCandidate(target, origin, {
    finalBonuses: bonus.solution.finalBonuses,
    restorationBonusScope: bonus.solution.restorationBonusScope,
    seriesSkillId: skill.solution.seriesSkillId,
    groupSkillId: skill.solution.groupSkillId,
    route,
  }, 'origin_reach')
  if (candidate === null) return null
  const conversionSkill = conversionSkillPrediction(route, base.conversionSkill)
  return {
    ...candidate,
    bonusAmendmentTrace: createCandidateBonusAmendmentTrace(
      route.operations,
      bonus.solution.amendmentResults,
    ),
    skillAmendmentTrace: createCandidateSkillAmendmentTrace(
      route.operations,
      skill.solution.amendmentResults,
    ),
    ...(conversionSkill === undefined
      ? {}
      : {
          conversionSkillTrace: createCandidateConversionSkillStep(
            route.operations,
            conversionSkill,
          ),
        }),
  }
}
