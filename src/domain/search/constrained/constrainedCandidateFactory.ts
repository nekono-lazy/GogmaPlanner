import {
  createReferencedOwnedWeaponsHash,
  createSearchStateHash,
} from '../../models/hashing'
import type {
  BuildRoute,
  GroupSkillId,
  OwnedWeaponId,
  RestorationBonusScope,
  RestorationBonusSet,
  SeriesSkillId,
  TargetWeapon,
} from '../../models/publicTypes'
import { validateBuildRoute } from '../../models/publicTypes'
import { createIdealDifference, satisfiesIdealTarget } from '../../target'
import { candidateStableKey } from '../candidateProcessing'
import { compareStableKeys, preferredSourceRank } from '../semanticKeys'
import { createCandidateRouteEstimates } from '../candidateFactory'
import {
  ConstrainedSearchError,
  type ConstrainedCandidate,
  type ConstrainedSearchOrigin,
} from './constrainedTypes'

export interface ConstrainedCandidatePrediction {
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  route: BuildRoute
}

/**
 * Builds one transient `ConstrainedCandidate`.
 *
 * Every field comes from an existing Domain authority: `satisfiesIdealTarget()`,
 * `createIdealDifference()`, `createCandidateRouteEstimates()`,
 * `createSearchStateHash()` and `createReferencedOwnedWeaponsHash()`.
 * `CandidateSearchSettings` never reaches this boundary, and no `id`,
 * `searchRunId`, `createdAt`, Clock value, or enumeration ordinal is produced.
 *
 * Returns `null` when the composed result is not an Ideal result, which is the
 * yield contract of SEARCH_SPEC 5.6.7.
 */
export function createConstrainedCandidate(
  target: TargetWeapon,
  origin: ConstrainedSearchOrigin,
  prediction: ConstrainedCandidatePrediction,
  /**
   * `origin_reach`: measure the advances as the reach from the origin Counters
   * (`createCandidateRouteEstimates()` with an origin). Planner Alternative
   * Search passes it, because its Routes may cross held positions; the
   * constrained enumerator keeps the operation sum, which equals the reach for
   * its origin-continuous Routes.
   */
  advanceMeasure: 'operation_sum' | 'origin_reach' = 'operation_sum',
): ConstrainedCandidate | null {
  if (
    !satisfiesIdealTarget(
      target,
      prediction.finalBonuses,
      prediction.restorationBonusScope,
      prediction.seriesSkillId,
      prediction.groupSkillId,
      origin.master,
    )
  ) {
    return null
  }

  const valid = validateBuildRoute(prediction.route, origin.ownedWeapons)
  if (!valid.isValid) {
    throw new ConstrainedSearchError(
      'invalid_candidate',
      valid.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }

  const idealDifference = createIdealDifference(
    target,
    prediction.finalBonuses,
    prediction.seriesSkillId,
    prediction.groupSkillId,
  )
  return {
    targetWeaponId: target.id,
    finalBonuses: prediction.finalBonuses.map((bonus) => ({
      ...bonus,
    })) as RestorationBonusSet,
    restorationBonusScope: prediction.restorationBonusScope,
    seriesSkillId: prediction.seriesSkillId,
    groupSkillId: prediction.groupSkillId,
    route: prediction.route,
    ...createCandidateRouteEstimates(
      prediction.route,
      target.weaponTypeId,
      { master: origin.master },
      advanceMeasure === 'origin_reach'
        ? {
            gogmaCounter: origin.rngState.gogmaCounter.value,
            skillCounter: origin.rngState.skillCounter.value,
            normalCounters: origin.normalCounters,
          }
        : undefined,
    ),
    idealDifference,
    searchStateHash: createSearchStateHash(
      prediction.route,
      origin.rngState,
      origin.normalCounters,
    ),
    referencedOwnedWeaponsHash: createReferencedOwnedWeaponsHash(
      prediction.route,
      origin.ownedWeapons,
    ),
    calculationContext: { ...origin.calculationContext },
  }
}

/**
 * The run-independent semantic identity of one constrained Candidate, reusing
 * the `candidateStableKey()` authority. Two solutions reaching the same result
 * at different Counter positions have different concrete operations, so they
 * keep different keys and are never collapsed into one.
 */
export function constrainedCandidateStableKey(
  candidate: ConstrainedCandidate,
): string {
  return candidateStableKey(candidate)
}

function nullableAscending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return left - right
}

/**
 * The deterministic enumeration order, mirroring the canonical Ideal ordering:
 * cheaper routes, then the smallest advance on each stream, then the Target's
 * preferred source, then the stable semantic key.
 *
 * `preferredOwnedWeaponId` sits immediately before the stable tie-break, in the
 * same position the ordinary Candidate comparisons give it, so it separates
 * only solutions every existing priority already rates equally
 * (`docs/SEARCH_SPEC.md` 8.1). It changes no enumeration bound, no route scope,
 * no termination condition, and no yield eligibility.
 *
 * No run-dependent value participates: there is no Candidate ID, no
 * `searchRunId`, no Clock value, and no Map insertion or Promise resolution
 * order in this comparison.
 */
export function compareConstrainedCandidates(
  left: ConstrainedCandidate,
  right: ConstrainedCandidate,
  preferredOwnedWeaponId: OwnedWeaponId | null = null,
): number {
  return (
    left.estimatedOperationCount - right.estimatedOperationCount ||
    left.estimatedGogmaAdvance - right.estimatedGogmaAdvance ||
    left.estimatedSkillAdvance - right.estimatedSkillAdvance ||
    nullableAscending(left.estimatedNormalAdvance, right.estimatedNormalAdvance) ||
    preferredSourceRank(
      left.route.sourceOwnedWeaponId,
      preferredOwnedWeaponId,
    ) -
      preferredSourceRank(
        right.route.sourceOwnedWeaponId,
        preferredOwnedWeaponId,
      ) ||
    compareStableKeys(
      constrainedCandidateStableKey(left),
      constrainedCandidateStableKey(right),
    )
  )
}
