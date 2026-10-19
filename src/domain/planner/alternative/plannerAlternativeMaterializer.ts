import { hashStableValue } from '../../models/publicTypes'
import type { CalculationContext, TargetWeaponId } from '../../models/publicTypes'
import {
  normalizePlannerAlternativeExcludedRouteKeys,
  normalizePlannerAlternativeReservation,
} from '../../search'
import type {
  ConstrainedSearchOrigin,
  PlannerAlternativeCandidate,
  PlannerAlternativeReservation,
  PlannerAlternativeSearchExtent,
} from '../../search'
import {
  createDeterministicMaterializer,
  type DeterministicMaterializer,
} from '../replacement/plannerDeterministicMaterializer'
import {
  normalizePlannerSearchOrigin,
  resolvePlannerSearchOriginTarget,
} from '../replacement/plannerSearchOrigin'
import type { PlannerClock } from '../plannerTypes'

/**
 * The Planner Alternative route policy of `docs/SEARCH_SPEC.md` 5.6.8, as one
 * stable token: every currently legal Search Route, no UI filter, the
 * `PlannerAlternativeSearchExtent` window, held-aware streams over a resource
 * reservation, every Ideal pair composed lazily, no initial-Search retention,
 * Cross-only or #104 reduction.
 *
 * Versioned so a future policy change yields a different search identity
 * instead of silently reusing this one. It is unrelated to the route policy
 * token of the legacy B8 constrained search identity (removed in Phase 6-B2b)
 * and to `PRODUCTION_RNG_ENGINE_VERSION`.
 */
export const PLANNER_ALTERNATIVE_ROUTE_POLICY_VERSION = 'planner-alternative-route-policy:v1'

export interface PlannerAlternativeSearchIdentityInput {
  origin: ConstrainedSearchOrigin
  targetWeaponId: TargetWeaponId
  extent: PlannerAlternativeSearchExtent
  reservation: PlannerAlternativeReservation
  excludedRouteKeys: readonly string[]
}

function normalizeCalculationContext(context: CalculationContext) {
  return {
    gameVersion: context.gameVersion,
    masterDataVersion: context.masterDataVersion,
    rngEngineVersion: context.rngEngineVersion,
    appSchemaVersion: context.appSchemaVersion,
  }
}

/**
 * The deterministic search identity of one Planner Alternative Search
 * (`docs/PLANNER_SPEC.md` 9.2.13 / `docs/SEARCH_SPEC.md` 5.6.8), composed from
 * the TargetWeapon ID, the normalized Planner-start Search / RNG origin (the
 * normalization the removed B8 identity also used), the `CalculationContext`, the
 * extent, the normalized reservation, the normalized `excludedRouteKeys` and
 * the route policy token.
 *
 * Never a random UUID, a Clock value, a request ID, an enumeration ordinal, a
 * historical UI `searchRunId`, or any array order: the reservation and the
 * excluded keys are semantic sets.
 */
export function createPlannerAlternativeSearchIdentity(
  input: PlannerAlternativeSearchIdentityInput,
): string {
  const target = resolvePlannerSearchOriginTarget(input.origin, input.targetWeaponId)
  const suffix = hashStableValue({
    targetWeaponId: target.id,
    origin: normalizePlannerSearchOrigin(input.origin, target),
    calculationContext: normalizeCalculationContext(input.origin.calculationContext),
    extent: {
      maxNormalAdvance: input.extent.maxNormalAdvance,
      maxGogmaAdvance: input.extent.maxGogmaAdvance,
      maxSkillAdvance: input.extent.maxSkillAdvance,
    },
    reservation: normalizePlannerAlternativeReservation(input.reservation),
    excludedRouteKeys: normalizePlannerAlternativeExcludedRouteKeys(input.excludedRouteKeys),
    routePolicy: PLANNER_ALTERNATIVE_ROUTE_POLICY_VERSION,
  }).replace(':', '-')
  return `planner-alternative-search.${suffix}`
}

export interface PlannerAlternativeMaterializationContext
  extends PlannerAlternativeSearchIdentityInput {
  clock: PlannerClock
}

export type PlannerAlternativeMaterializer = DeterministicMaterializer<PlannerAlternativeCandidate>

/**
 * The Planner Alternative adapter of the shared deterministic materialization
 * core (`docs/PLANNER_SPEC.md` 9.2.13 / 9.2.19.6): the Planner Alternative
 * search identity as `searchRunId`, a `candidate.planner-alternative.`
 * Candidate ID, and the Candidate's own observational traces carried into the
 * `BuildCandidate` unchanged, so its intermediate state groups come from the
 * same extraction an ordinary Candidate uses and nothing is predicted again.
 * The generated Entry ID, same-semantic reuse, collision refusal and staleness
 * are the shared core's (`../replacement/plannerDeterministicMaterializer`),
 * exactly as they were for the removed legacy B8 Entry.
 */
export function createPlannerAlternativeMaterializer(
  context: PlannerAlternativeMaterializationContext,
): PlannerAlternativeMaterializer {
  return createDeterministicMaterializer<PlannerAlternativeCandidate>({
    origin: context.origin,
    target: resolvePlannerSearchOriginTarget(context.origin, context.targetWeaponId),
    searchIdentity: createPlannerAlternativeSearchIdentity(context),
    candidateIdPrefix: 'candidate.planner-alternative.',
    clock: context.clock,
  })
}
