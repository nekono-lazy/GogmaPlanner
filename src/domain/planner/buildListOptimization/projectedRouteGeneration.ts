/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.12), Stage D (moved from the Global Assignment Research
 * Phase D-0A and its Phase 0 origin-reach adapter, Issue #154).
 *
 * The projected Candidate Search of a continuous shape: one ordinary `searchCandidates()` from the projected start of each stream
 * (the first own position), with the source alone as inventory and the minimal extent. A matching canonical Ideal is rebuilt at the
 * Planner-start origin (`rebuildProjectedCandidateAtOrigin()`: `createConstrainedCandidate(..., 'origin_reach')` plus the
 * deterministic materializer), so its Candidate and Entry are the ones the Planner-start state would produce; no Search hash or
 * Candidate ID is rewritten. A non-match is this method's limit and never decides the Target outcome: the shape-constrained method
 * runs next.
 */
import { createBuildListEntry, createTargetDefinitionHash, evaluateBuildListEntryStaleness } from '../../buildList'
import { createReferencedOwnedWeaponsHash, hashStableValue, validateBuildCandidate, validateBuildListEntry } from '../../models/publicTypes'
import type { BuildCandidate, BuildListEntry, TargetWeapon } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import { emptyPlannerAlternativeReservation } from '../../search/alternative'
import { searchCandidates } from '../../search/candidateSearch'
import { createConstrainedCandidate } from '../../search/constrained'
import { CandidateSearchError, type CandidateSearchInput, type CandidateSearchResult } from '../../search/searchTypes'
import type { PlannerClock, PlannerInput } from '../plannerTypes'
import { createDeterministicMaterializer, type GeneratedBuildListEntryResult } from '../replacement/plannerDeterministicMaterializer'
import { createPlannerStartSearchOrigin, normalizePlannerSearchOrigin } from '../replacement/plannerSearchOrigin'
import type { BuildListOptimizationContext, ReachTable } from './buildListOptimizationTypes'
import type { ExpectedRouteShape } from './coverageTypes'
import { predictProjectedSearchScale, exceededSearchScaleGate } from './projectedSearchScale'
import { matchRouteShape, shapeOwnPositions, shapeSearchExtent, type ShapeOwnPositions, type StreamOrigins } from './routeShape'
import {
  BuildListOptimizationMaterializationError,
  type PredictedSearchScale, type ProjectedAttempt, type ProjectedRouteRequest, type ProjectedSearchOrigin, type RouteGenerationIdentity,
  type RouteGenerationIdentityTokens, type RouteGenerationInspection, type SearchScaleGate,
} from './routeGenerationTypes'

/** The identity a projected Candidate is rebuilt under at the Planner-start origin (`docs/PLANNER_SPEC.md` 17.12). */
export interface OriginRebuildIdentity {
  /** The algorithm token folded into the rebuild identity. */
  algorithm: string
  /** The prefix of the rebuild identity (also the rebuilt Candidate's `searchRunId`). */
  searchIdentityPrefix: string
  /** The rebuilt Candidate's `BuildCandidate.id` prefix. */
  candidateIdPrefix: string
  /** The Clock of the display-only `createdAt` (never an identity input). */
  clock: PlannerClock
}

/**
 * Rebuilds one Candidate a projected Candidate Search returned at the Planner-start origin of `originInput`: the Candidate's Route
 * already holds absolute positions, so its semantic result is re-derived from the origin (`createConstrainedCandidate(...,
 * 'origin_reach')`, which recomputes the hashes and estimates from the origin) and materialized by the shared deterministic
 * materializer (its Entry ID rule and same-semantic reuse rule over `originInput.buildListEntries`). The observational traces are
 * carried over unchanged, never re-predicted. Throws when the projected Candidate is invalid, stale against its own projected
 * state, reads a weapon the origin does not hold, or no longer satisfies the Ideal from the origin.
 */
export function rebuildProjectedCandidateAtOrigin(originInput: PlannerInput, projectedInput: CandidateSearchInput, candidate: BuildCandidate,
  identity: OriginRebuildIdentity): GeneratedBuildListEntryResult {
  const origin = createPlannerStartSearchOrigin(originInput)
  const target = origin.targetWeapons.find(t => t.id === candidate.targetWeaponId)
  if (!target) throw new Error('Candidate Target is absent from Planner origin.')
  const valid = validateBuildCandidate(candidate, projectedInput.ownedWeapons)
  if (!valid.isValid) throw new Error(JSON.stringify(valid.issues))
  const projectedTarget = projectedInput.targetWeapons.find(t => t.id === target.id)
  if (!projectedTarget || createTargetDefinitionHash(projectedTarget) !== createTargetDefinitionHash(target)) {
    throw new Error('Projected Target performance differs from the Planner origin.')
  }
  const projectedEntry = createBuildListEntry(candidate, projectedTarget, { createdAt: identity.clock.now() })
  const staleness = evaluateBuildListEntryStaleness(projectedEntry, { ...projectedInput, target: projectedTarget })
  if (staleness.isStale) throw new Error(`Projected Candidate is stale: ${staleness.staleReasons.join(', ')}`)
  // A previously changed / generated weapon cannot masquerade as an origin source.
  if (candidate.route.sourceOwnedWeaponId !== null && !origin.ownedWeapons.some(w => w.id === candidate.route.sourceOwnedWeaponId)) {
    throw new Error('Candidate references a weapon generated by the prefix; route-local references are unsupported.')
  }
  if (createReferencedOwnedWeaponsHash(candidate.route, origin.ownedWeapons) !== candidate.referencedOwnedWeaponsHash) {
    throw new Error('Candidate source changed during the prefix; origin materialization is unsupported.')
  }
  const semantic = createConstrainedCandidate(target, origin, candidate, 'origin_reach')
  if (!semantic) throw new Error('Candidate no longer satisfies the original Ideal.')
  const searchIdentity = `${identity.searchIdentityPrefix}${hashStableValue({
    algorithm: identity.algorithm, origin: normalizePlannerSearchOrigin(origin, target),
    projectedOrigin: normalizePlannerSearchOrigin(projectedInput, projectedTarget),
    extent: projectedInput.settings, routeFilter: projectedInput.routeFilter, calculationContext: origin.calculationContext,
  })}`
  const result = createDeterministicMaterializer({ origin, target, searchIdentity, candidateIdPrefix: identity.candidateIdPrefix, clock: identity.clock })
    .materializeBuildListEntry({ ...semantic, bonusAmendmentTrace: candidate.bonusAmendmentTrace,
      skillAmendmentTrace: candidate.skillAmendmentTrace, conversionSkillTrace: candidate.conversionSkillTrace }, originInput.buildListEntries)
  const entryValid = validateBuildListEntry(result.entry)
  if (!entryValid.isValid) throw new Error(JSON.stringify(entryValid.issues))
  return result
}

function planningTarget(context: Pick<BuildListOptimizationContext, 'planningTargets'>, shape: ExpectedRouteShape): TargetWeapon {
  const target = context.planningTargets.find(value => value.id === shape.targetWeaponId)
  if (!target) throw new BuildListOptimizationMaterializationError('invalid_shape', shape.targetWeaponId, `Target ${shape.targetWeaponId} is not a planning Target of the context.`)
  return target
}

/** The Route base family of a shape for a scale prediction: a conversion Route (new / owned Normal) or an existing Gogma Route. */
export function shapeRouteBase(shape: ExpectedRouteShape): 'conversion' | 'owned_gogma' {
  return shape.option.skillRequired.kind === 'conversion' ? 'conversion' : 'owned_gogma'
}

/** The Normal part of a scale prediction of one shape from `origins`. */
export function normalScaleInput(shape: ExpectedRouteShape, origins: StreamOrigins) {
  const forge = shape.option.normalRequired
  return forge === null ? null : { counterId: forge.counterId, origin: origins.normal!, productionTarget: forge.position }
}

/** The ordinary Candidate Search input of one projected request (the Planner-start input with the projected Counters and inventory). */
export function projectedRouteSearchInput(request: Pick<ProjectedRouteRequest, 'targetWeaponId' | 'projection' | 'extent'>, context: Pick<BuildListOptimizationContext, 'plannerInput'>,
  searchRunId: string): CandidateSearchInput {
  const input = context.plannerInput
  const { projection } = request
  const target = input.targetWeapons.find(value => value.id === request.targetWeaponId)
  if (!target) throw new BuildListOptimizationMaterializationError('invalid_shape', request.targetWeaponId, `Target ${request.targetWeaponId} is not in the PlannerInput.`)
  const rngState = structuredClone(input.rngState)
  rngState.skillCounter = { ...rngState.skillCounter, value: projection.skillCounter }
  rngState.gogmaCounter = { ...rngState.gogmaCounter, value: projection.gogmaCounter }
  return {
    searchRunId,
    targetWeaponId: target.id,
    routeFilter: projection.routeFilter,
    rngState,
    normalCounters: input.normalCounters.map(counter => (projection.normal !== null && counter.id === projection.normal.counterId
      ? { ...structuredClone(counter), counter: projection.normal.counter }
      : structuredClone(counter))),
    ownedWeapons: input.ownedWeapons.filter(weapon => projection.ownedWeaponIds.includes(weapon.id)).map(weapon => structuredClone(weapon)),
    // Only this Target: another Target's preference would name a weapon outside the restricted inventory.
    targetWeapons: [{ ...structuredClone(target), preferredOwnedWeaponId: projection.preferredOwnedWeaponId }],
    settings: { ...request.extent },
    master: input.master,
    calculationContext: input.calculationContext,
  }
}

/** The projected request of one continuous shape (a non-continuous shape fails closed: it is never projected). */
export async function buildProjectedRouteRequest(shape: ExpectedRouteShape,
  inputs: { context: Pick<BuildListOptimizationContext, 'plannerInput' | 'planningTargets'>; table: Pick<ReachTable, 'originSkill' | 'originGogma'> },
  tokens: Pick<RouteGenerationIdentityTokens, 'projectedAlgorithm' | 'projectedSearchRunIdPrefix'>, own: ShapeOwnPositions = shapeOwnPositions(shape)): Promise<ProjectedRouteRequest> {
  const { context, table } = inputs
  if (!own.continuous) {
    throw new BuildListOptimizationMaterializationError('invalid_shape', shape.targetWeaponId, `Target ${shape.targetWeaponId}: a projected Candidate Search needs a continuous shape.`)
  }
  const option = shape.option
  const forge = option.normalRequired
  const origins: StreamOrigins = {
    skill: own.skill.first ?? table.originSkill,
    gogma: own.gogma.first ?? table.originGogma,
    normal: forge === null ? null : own.normal.first,
  }
  const extent = shapeSearchExtent(shape, origins)
  const source = option.source
  const ownedWeaponIds = source.kind === 'new_normal' ? [] : [source.ownedWeaponId]
  const preferred = planningTarget(context, shape).preferredOwnedWeaponId
  const projection: ProjectedSearchOrigin = {
    skillCounter: origins.skill,
    gogmaCounter: origins.gogma,
    normal: forge === null ? null : { counterId: forge.counterId, counter: origins.normal! },
    routeFilter: source.kind === 'owned_gogma' ? 'existing_gogma' : 'normal_artian',
    ownedWeaponIds,
    preferredOwnedWeaponId: preferred !== null && ownedWeaponIds.includes(preferred) ? preferred : null,
  }
  const projectedState = projectedRouteSearchInput({ targetWeaponId: shape.targetWeaponId, projection, extent }, context, 'pending')
  const searchRunId = `${tokens.projectedSearchRunIdPrefix}${hashStableValue({
    algorithm: tokens.projectedAlgorithm,
    targetWeaponId: shape.targetWeaponId,
    origin: normalizePlannerSearchOrigin(projectedState, projectedState.targetWeapons[0]!),
    extent,
    routeFilter: projection.routeFilter,
  }).replace(':', '-')}`
  const { scale, detail } = await predictProjectedSearchScale({
    routeBase: shapeRouteBase(shape), reservation: emptyPlannerAlternativeReservation, origins: { skill: origins.skill, gogma: origins.gogma }, normal: normalScaleInput(shape, origins), extent,
  })
  return {
    method: 'candidate_search_projected',
    targetWeaponId: shape.targetWeaponId,
    shape,
    reservation: null,
    projection,
    extent: { ...extent },
    searchRunId,
    predictedSearchScale: scale,
    scaleDetail: detail,
  }
}

function gateOutcome(predictedSearchScale: PredictedSearchScale, searchScaleGate: SearchScaleGate) {
  const exceeded = exceededSearchScaleGate(predictedSearchScale, searchScaleGate)
  return exceeded.length === 0 ? null : { kind: 'not_executed' as const, reason: 'search_scale_gate' as const, predictedSearchScale: { ...predictedSearchScale }, exceeded }
}

/** What one projected Candidate Search needs. */
export interface ProjectedRunDependencies {
  context: Pick<BuildListOptimizationContext, 'plannerInput'>
  engine: RngEngine
  searchScaleGate: SearchScaleGate
  identity: Pick<RouteGenerationIdentity, 'projectedAlgorithm' | 'originSearchIdentityPrefix' | 'originCandidateIdPrefix' | 'clock'>
  /** The ordinary Candidate Search (injectable so a test can observe or stand in for it). */
  searchCandidates?: typeof searchCandidates
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
  onInspected?: (inspection: RouteGenerationInspection) => void
}

/**
 * Runs one projected request: the gate, the ordinary Candidate Search, the match of its canonical Ideal (whose Route already holds
 * absolute positions) and, on a match, the rebuild at the Planner-start origin and its confirmed match. A rebuild the materializer
 * refuses, or one that no longer matches, fails closed.
 */
export async function runProjectedRouteRequest(request: ProjectedRouteRequest, deps: ProjectedRunDependencies): Promise<ProjectedAttempt> {
  const { context, engine, identity } = deps
  const { shape } = request
  const gated = gateOutcome(request.predictedSearchScale, deps.searchScaleGate)
  if (gated !== null) return { method: 'candidate_search_projected', request, result: gated, observed: null }

  const searchInput = projectedRouteSearchInput(request, context, request.searchRunId)
  let result: CandidateSearchResult
  try {
    result = await (deps.searchCandidates ?? searchCandidates)(searchInput, engine, {
      now: () => identity.clock.now(), shouldCancel: deps.shouldCancel, yieldControl: deps.yieldControl,
    })
  } catch (error) {
    if (error instanceof CandidateSearchError && error.code === 'cancelled') {
      return { method: 'candidate_search_projected', request, result: { kind: 'unmeasured', reason: 'cancelled' }, observed: null }
    }
    if (error instanceof CandidateSearchError) {
      throw new BuildListOptimizationMaterializationError('search_refused', shape.targetWeaponId, `${error.code}: ${error.message}`)
    }
    throw error
  }
  const candidate = result.targetResult.candidate
  const observed = {
    searchedRoutes: [...result.targetResult.searchedRoutes],
    skippedRoutes: result.targetResult.skippedRoutes.map(({ route, reason }) => ({ route, reason })),
    candidateFound: candidate !== null,
  }
  if (candidate === null) return { method: 'candidate_search_projected', request, result: { kind: 'no_candidate' }, observed }
  // The projected Candidate's Route already holds absolute positions: match it before rebuilding it at the origin.
  const match = matchRouteShape(createBuildListEntry(candidate, searchInput.targetWeapons[0]!, { createdAt: identity.clock.now() }), shape, engine)
  deps.onInspected?.({ targetWeaponId: request.targetWeaponId, method: 'candidate_search_projected', deliveredIndex: 1, match })
  if (!match.matches) {
    return {
      method: 'candidate_search_projected', request, observed,
      result: { kind: 'canonical_mismatch', mismatch: { deliveredIndex: 1, reasons: match.reasons, plannerRequired: match.plannerRequired, sourceOwnedWeaponId: candidate.route.sourceOwnedWeaponId } },
    }
  }
  let entry: BuildListEntry
  try {
    entry = rebuildProjectedCandidateAtOrigin(context.plannerInput, searchInput, candidate, {
      algorithm: identity.projectedAlgorithm, searchIdentityPrefix: identity.originSearchIdentityPrefix, candidateIdPrefix: identity.originCandidateIdPrefix, clock: identity.clock,
    }).entry
  } catch (error) {
    throw new BuildListOptimizationMaterializationError('entry_materialization_refused', shape.targetWeaponId, error instanceof Error ? error.message : String(error))
  }
  const confirmed = matchRouteShape(entry, shape, engine)
  if (!confirmed.matches) {
    throw new BuildListOptimizationMaterializationError('match_inconsistent', shape.targetWeaponId, `The origin Entry ${entry.id} no longer matches (${confirmed.reasons.join(', ')}).`)
  }
  return {
    method: 'candidate_search_projected', request, observed,
    result: { kind: 'matched', outcome: { kind: 'materialized', method: 'candidate_search_projected', entry, plannerRequired: confirmed.plannerRequired, deliveredBeforeMatch: 0 } },
  }
}
