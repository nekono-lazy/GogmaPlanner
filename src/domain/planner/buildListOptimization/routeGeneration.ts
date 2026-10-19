/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.12), Stage D: the route generation of one structural candidate
 * (moved from the Global Assignment Research Phase D-0A-2b, Issue #154, the method rule the Research accepted at D-1C).
 *
 * The planning Targets are taken in the candidate's materialization order. For each Target:
 *
 * - the formal reservation is `emptyPlannerAlternativeReservation` for the first Target and
 *   `derivePlannerAlternativeReservation(generated Entries)` afterwards, passed unchanged: no held / blocked / exclusive weapon is
 *   added for a Target not generated yet, and none is edited to steer the shape (the shape restricts the Route base instead);
 * - a continuation shape and a non-continuous shape use the shape-constrained Route search alone; a continuous shape tries the
 *   projected Candidate Search first and the shape-constrained Route search once when it does not match (`selectRouteGenerationMethods()`);
 * - a shape-constrained delivery is accepted only after its match and its independent Route checks;
 * - only a generated Entry reaches the reservation of a later Target.
 *
 * The run stops at the first Target without a generated Route and keeps everything up to it. No Planner run happens here (Stage D'
 * does that), nothing is persisted, and the generated Entries are runtime-only Preview data. A generated Entry whose semantic
 * content equals the PlannerInput's own Entry is that Entry (the deterministic materializer's reuse rule).
 */
import type { BuildListEntry } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import { emptyPlannerAlternativeReservation, type PlannerAlternativeReservation } from '../../search/alternative'
import type { searchCandidates } from '../../search/candidateSearch'
import type { visitShapeConstrainedRouteCandidates } from '../../search/shapeConstrained'
import { derivePlannerAlternativeReservation, PlannerAlternativeReservationError } from '../alternative/plannerAlternativeReservation'
import type { BuildListOptimizationContext, ReachTable } from './buildListOptimizationTypes'
import type { ExpectedRouteShape, StructuralCandidate } from './coverageTypes'
import { buildProjectedRouteRequest, runProjectedRouteRequest } from './projectedRouteGeneration'
import { isValidSearchScaleGate } from './projectedSearchScale'
import { shapeOwnPositions } from './routeShape'
import {
  BuildListOptimizationMaterializationError,
  type RouteGenerationAttempt, type RouteGenerationIdentity, type RouteGenerationInspection, type RouteGenerationOutcome, type RouteGenerationSettings,
  type RouteGenerationStageOutcome, type ShapeConstrainedAttempt, type ShapeConstrainedRouteRequest, type StructuralCandidateRouteGeneration,
  type TargetRouteGenerationRecord,
} from './routeGenerationTypes'
import { assembleShapeConstrainedRouteRequest, selectRouteGenerationMethods } from './shapeConstrainedRequest'
import { executeShapeConstrainedRoute } from './shapeConstrainedRun'
import { isValidShapeSearchBudget, isValidShapeSearchScaleGate } from './shapeSearchScale'

/** The Production Search entry points of the route generation, injectable so a test can observe or stand in for them. */
export interface RouteGenerationSearchPort {
  visitShapeConstrainedRouteCandidates: typeof visitShapeConstrainedRouteCandidates
  searchCandidates: typeof searchCandidates
}

export interface RouteGenerationInputs {
  /** The Stage 0 context the structural candidate was built from. */
  context: BuildListOptimizationContext
  /** The Stage A ReachTable of that context. */
  table: ReachTable
  /** The Engine of the table, the Searches and the Route unit plans. */
  engine: RngEngine
  settings: RouteGenerationSettings
  identity: RouteGenerationIdentity
  /** Defaults to the Production Search APIs. */
  search?: RouteGenerationSearchPort
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
  /** Execution-only: every Candidate a Search returned to the route generation, after its match. */
  onInspected?: (inspection: RouteGenerationInspection) => void
}

/** Every gate and budget value is the caller's explicit non-negative safe integer (no default, no clamp). */
export function isValidRouteGenerationSettings(settings: RouteGenerationSettings): boolean {
  return settings !== null && typeof settings === 'object' && isValidSearchScaleGate(settings.projectedSearchScaleGate)
    && isValidShapeSearchScaleGate(settings.shapeSearchScaleGate) && isValidShapeSearchBudget(settings.shapeSearchBudget)
}

export const ROUTE_GENERATION_SETTINGS_ISSUE = 'projectedSearchScaleGate, shapeSearchScaleGate and shapeSearchBudget must name every value as a non-negative safe integer'

/**
 * The formal reservation of the Entries generated so far: empty with no Entry, otherwise exactly
 * `derivePlannerAlternativeReservation(generatedEntries)`. Never edited afterwards.
 */
export function deriveFormalReservation(shape: ExpectedRouteShape, generatedEntries: readonly BuildListEntry[], engine: RngEngine): PlannerAlternativeReservation {
  if (generatedEntries.length === 0) return structuredClone(emptyPlannerAlternativeReservation)
  try {
    return derivePlannerAlternativeReservation(generatedEntries, engine)
  } catch (error) {
    if (error instanceof PlannerAlternativeReservationError) {
      throw new BuildListOptimizationMaterializationError('reservation_derivation_failed', shape.targetWeaponId, `${error.code} (${error.buildListEntryId}): ${error.message}`)
    }
    throw error
  }
}

/** The shape-constrained request of one Target after `generatedEntries` (in materialization order). Nothing is predicted or searched. */
export async function buildShapeConstrainedRouteRequest(shape: ExpectedRouteShape, generatedEntries: readonly BuildListEntry[],
  inputs: Pick<RouteGenerationInputs, 'context' | 'table' | 'engine' | 'identity'>): Promise<ShapeConstrainedRouteRequest> {
  const reservation = deriveFormalReservation(shape, generatedEntries, inputs.engine)
  return assembleShapeConstrainedRouteRequest({
    shape, reservation, reservationSourceEntryIds: generatedEntries.map(entry => entry.id), context: inputs.context, table: inputs.table,
  }, inputs.identity)
}

function runShapeConstrained(request: ShapeConstrainedRouteRequest, generatedEntries: readonly BuildListEntry[], inputs: RouteGenerationInputs): Promise<ShapeConstrainedAttempt> {
  return executeShapeConstrainedRoute(request, {
    context: inputs.context, table: inputs.table, engine: inputs.engine, settings: inputs.settings, materializedEntries: generatedEntries,
    collisionCheckEntries: inputs.context.plannerInput.buildListEntries, clock: inputs.identity.clock, candidateIdPrefix: inputs.identity.shapeCandidateIdPrefix,
    visit: inputs.search?.visitShapeConstrainedRouteCandidates,
    shouldCancel: inputs.shouldCancel, yieldControl: inputs.yieldControl, onInspected: inputs.onInspected,
  })
}

/**
 * One Target after `generatedEntries`. A continuation shape and a non-continuous shape use the shape-constrained method alone; a
 * continuous shape tries the projected Candidate Search first and, when it returns another canonical Ideal, none, or is gated, the
 * shape-constrained method once (never after a cancellation). The formal reservation is the same for both attempts, each has its own
 * gate, and the Target outcome is the projected match or the shape-constrained attempt's own.
 */
export async function generateTargetRoute(shape: ExpectedRouteShape, generatedEntries: readonly BuildListEntry[], inputs: RouteGenerationInputs,
  orderIndex = 0): Promise<TargetRouteGenerationRecord> {
  if (!isValidRouteGenerationSettings(inputs.settings)) {
    throw new BuildListOptimizationMaterializationError('invalid_settings', null, `${ROUTE_GENERATION_SETTINGS_ISSUE} (got ${JSON.stringify(inputs.settings)}).`)
  }
  const attempts: RouteGenerationAttempt[] = []
  if (inputs.shouldCancel?.()) {
    return { targetWeaponId: shape.targetWeaponId, orderIndex, selection: null, attempts, outcome: { kind: 'unmeasured', reason: 'cancelled' } }
  }
  const own = shapeOwnPositions(shape)
  const request = await buildShapeConstrainedRouteRequest(shape, generatedEntries, inputs)
  const projected = own.continuous ? await buildProjectedRouteRequest(shape, inputs, inputs.identity, own) : null
  const selection = selectRouteGenerationMethods(shape, own, inputs.table, { shapeConstrained: request.predictedScale, projected: projected?.predictedSearchScale ?? null })
  const record = (outcome: RouteGenerationOutcome): TargetRouteGenerationRecord => ({ targetWeaponId: shape.targetWeaponId, orderIndex, selection, attempts, outcome })
  if (selection.order[0] === 'candidate_search_projected') {
    const first = await runProjectedRouteRequest(projected!, {
      context: inputs.context, engine: inputs.engine, searchScaleGate: inputs.settings.projectedSearchScaleGate, identity: inputs.identity,
      searchCandidates: inputs.search?.searchCandidates, shouldCancel: inputs.shouldCancel, yieldControl: inputs.yieldControl, onInspected: inputs.onInspected,
    })
    attempts.push(first)
    if (first.result.kind === 'matched') return record(first.result.outcome)
    if (first.result.kind === 'unmeasured') return record({ kind: 'unmeasured', reason: first.result.reason })
    // Not matched (another canonical Ideal, none in the projected extent, or gated): the shape-constrained method once.
  }
  const attempt = await runShapeConstrained(request, generatedEntries, inputs)
  attempts.push(attempt)
  return record(attempt.outcome)
}

/**
 * Generates a Route for every planning Target of one structural candidate in its materialization order, stopping at the first
 * Target without a generated Route. The candidate is Stage C's own output of the same run (its order and shapes are never edited).
 * Not a Planner verification.
 */
export async function generateStructuralCandidateRoutes(candidate: StructuralCandidate, inputs: RouteGenerationInputs): Promise<StructuralCandidateRouteGeneration> {
  if (!isValidRouteGenerationSettings(inputs.settings)) {
    throw new BuildListOptimizationMaterializationError('invalid_settings', null, `${ROUTE_GENERATION_SETTINGS_ISSUE} (got ${JSON.stringify(inputs.settings)}).`)
  }
  const shapes = new Map(candidate.expectedShapes.map(shape => [shape.targetWeaponId, shape]))
  const order = candidate.materializationOrder
  const targets: TargetRouteGenerationRecord[] = []
  const generatedEntries: BuildListEntry[] = []
  const finish = (outcome: RouteGenerationStageOutcome, notAttempted: StructuralCandidateRouteGeneration['notAttemptedTargetWeaponIds']): StructuralCandidateRouteGeneration => ({
    candidateOrdinal: candidate.ordinal,
    objective: candidate.assignment.objective,
    materializationOrder: [...order],
    targets,
    generatedEntries,
    outcome,
    notAttemptedTargetWeaponIds: notAttempted,
  })
  for (const [index, targetWeaponId] of order.entries()) {
    const shape = shapes.get(targetWeaponId)
    if (shape === undefined) throw new BuildListOptimizationMaterializationError('invalid_shape', targetWeaponId, `Target ${targetWeaponId} has no expected Route shape in the structural candidate.`)
    const record = await generateTargetRoute(shape, generatedEntries, inputs, index)
    targets.push(record)
    const { outcome } = record
    if (outcome.kind === 'materialized') {
      generatedEntries.push(outcome.entry)
      continue
    }
    const stage: RouteGenerationStageOutcome = outcome.kind === 'unsupported'
      ? { kind: 'generation_unsupported', targetWeaponId, outcome }
      : { kind: 'generation_unconfirmed', targetWeaponId, outcome }
    return finish(stage, order.slice(index + 1))
  }
  return finish({ kind: 'all_generated' }, [])
}
