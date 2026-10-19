/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 - 17.13): one calculation from a fresh PlannerInput to a typed result.
 *
 *   Stage 0   the planning Target context (`validatePlannerInput()` -> `derivePlannerPlanningTargets()`), every unsupported reason of
 *             17.4 the Domain can decide, the excluded Entries and their warning kinds, the out-of-scope Target counts
 *   Stage A   the ReachTable over the caller's window (`BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET`)
 *   Stage B/C the coverage-gated structural candidate search (coverage-driven ordering; node budget and MRV lookahead from the caller)
 *   Stage D   the route generation of each structural candidate (`generateStructuralCandidateRoutes()`)
 *   Stage D'  the final verification by the ordinary Planner (`verifyBuildListOptimizationCandidate()`)
 *
 * The first candidate Stage D' accepts is the result (`optimized`); a rejected candidate moves the search to the next one inside the
 * caller's bounds. The classification never reads an unexamined candidate as absent: a node budget, a structural candidate limit, a
 * verification budget, a shape-constrained gate or runtime budget is `search_bound_reached`; only an exhausted search whose every
 * candidate was rejected outright is `not_found(candidates_rejected)`, and one that delivered none is
 * `not_found(no_structural_candidate)`. A cancellation is `{ kind: 'cancelled' }`; a broken contract throws.
 *
 * The calculation is pure apart from the Engine and the Planner's Production ID factory and Clock: it reads no persisted state,
 * writes nothing, holds no default bound and reads neither the Candidate Search defaults nor a saved setting. Minimality is never
 * claimed.
 */
import { SHAPE_CONSTRAINED_ROUTE_POLICY_VERSION } from '../../search/shapeConstrained'
import type { PlannerDependencies, PlannerInput } from '../plannerTypes'
import type { createProductionPlanWithObserver } from '../productionPlanGeneration'
import type {
  BuildListOptimizationBound, BuildListOptimizationBounds, BuildListOptimizationCandidateDiagnostics, BuildListOptimizationDiagnostics,
  BuildListOptimizationResult, BuildListOptimizationRun, BuildListOptimizationStage,
} from './buildListOptimizationResult'
import { BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET, BuildListOptimizationInvariantError, type ReachTable } from './buildListOptimizationTypes'
import { noCandidateReason } from './coverageSearch'
import type { CoverageSearch, NoStructuralCandidateReason, StructuralSearchDiagnostics } from './coverageSearchTypes'
import type { StructuralCandidate } from './coverageTypes'
import { buildListOptimizationInputExclusionsOf, verifyBuildListOptimizationCandidate } from './finalVerification'
import { countBuildListOptimizationOutOfScopeTargets, deriveBuildListOptimizationInputToken } from './optimizationInputScope'
import { createBuildListOptimizationContext } from './planningContext'
import { assertReachWindow, buildReachTable, deriveBuildListOptimizationUnsupportedReasons } from './reachTable'
import { generateStructuralCandidateRoutes, isValidRouteGenerationSettings, ROUTE_GENERATION_SETTINGS_ISSUE, type RouteGenerationSearchPort } from './routeGeneration'
import type { RouteGenerationIdentityTokens, RouteGenerationMethod } from './routeGenerationTypes'
import { createStructuralCandidateSearch } from './structuralSearch'

/** The algorithm token of every Build List global optimization search identity (`docs/PLANNER_SPEC.md` 17.12). */
export const BUILD_LIST_OPTIMIZATION_MATERIALIZATION_ALGORITHM = 'build-list-optimization-materialization:v1'

/**
 * The Production identity tokens of the route generation (`docs/PLANNER_SPEC.md` 17.12): the Production algorithm token and route
 * policy, and the Production identity / Candidate ID prefixes. No Research token, request ID, UUID, Clock value or ordinal enters
 * them. Generated Entry IDs do not depend on them: they keep the shared deterministic materializer's `build-list.constrained.` rule.
 */
export const BUILD_LIST_OPTIMIZATION_ROUTE_IDENTITY: RouteGenerationIdentityTokens = Object.freeze({
  projectedAlgorithm: BUILD_LIST_OPTIMIZATION_MATERIALIZATION_ALGORITHM,
  shapeAlgorithm: BUILD_LIST_OPTIMIZATION_MATERIALIZATION_ALGORITHM,
  routePolicy: SHAPE_CONSTRAINED_ROUTE_POLICY_VERSION,
  projectedSearchRunIdPrefix: 'build-list-optimization-search.projected.',
  originSearchIdentityPrefix: 'build-list-optimization-search.origin.',
  originCandidateIdPrefix: 'candidate.build-list-optimization.',
  shapeSearchIdentityPrefix: 'build-list-optimization-search.shape.',
  shapeCandidateIdPrefix: 'candidate.build-list-optimization.shape.',
})

export interface BuildListOptimizationExecution {
  /** The caller's cancel; a cancelled calculation returns `{ kind: 'cancelled' }` and no result. */
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
  /** Execution-only stage notifications (a progress display shows stage names, never a completion rate). */
  onStage?: (stage: BuildListOptimizationStage) => void
  /** A monotonic millisecond clock for the diagnostics' stage timings only; absent, no timing is recorded. */
  now?: () => number
  /** Tests only: the Search entry points of Stage D. */
  search?: RouteGenerationSearchPort
  /** Tests only: the Planner of Stage D'. The Production calculation is the ordinary Production Planner. */
  planner?: typeof createProductionPlanWithObserver
}

const isPositiveSafeInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Every bound is the caller's explicit value: no default, fallback, completion or clamp (`docs/PLANNER_SPEC.md` 17.13). */
export function assertBuildListOptimizationBounds(bounds: BuildListOptimizationBounds): void {
  if (bounds === null || typeof bounds !== 'object') throw new RangeError('The Build List optimization bounds are missing.')
  assertReachWindow(bounds.window)
  for (const key of ['nodeBudget', 'mrvLookahead', 'maxStructuralCandidates', 'maxPlannerVerifications'] as const) {
    if (!isPositiveSafeInteger(bounds[key])) throw new RangeError(`${key} must be a positive safe integer (got ${String(bounds[key])}).`)
  }
  if (!isValidRouteGenerationSettings(bounds.routeGeneration)) throw new RangeError(`${ROUTE_GENERATION_SETTINGS_ISSUE} (got ${JSON.stringify(bounds.routeGeneration)}).`)
}

function methodCounts(records: { outcome: { kind: string; method?: RouteGenerationMethod } }[]): Record<RouteGenerationMethod, number> {
  const counts: Record<RouteGenerationMethod, number> = { candidate_search_projected: 0, shape_constrained: 0 }
  for (const { outcome } of records) if (outcome.kind === 'materialized' && outcome.method !== undefined) counts[outcome.method] += 1
  return counts
}

function reachTableDiagnostics(table: ReachTable): BuildListOptimizationDiagnostics['reachTable'] {
  return { window: { ...table.window }, predictions: { ...table.summary.predictions }, memoHits: { ...table.summary.memoHits }, supportQueries: table.summary.supportQueries }
}

function structuralDiagnostics(search: CoverageSearch<StructuralCandidate, StructuralSearchDiagnostics>,
  noStructuralCandidateReason: NoStructuralCandidateReason | null): BuildListOptimizationDiagnostics['structuralSearch'] {
  const value = search.diagnostics
  return {
    completeness: value.completeness, expandedNodes: value.resource.expandedNodes, coverageRejections: value.coverageRejections,
    structuralCandidates: value.structuralCandidates, noStructuralCandidateReason,
  }
}

/**
 * Runs one Build List global optimization over `plannerInput` (a fresh `createPlannerInput()` value with `conflictResolutions = []`).
 * `dependencies` are the Production Planner's (Engine, Production ID factory, Production Clock); `bounds` are the caller's. Throws a
 * `RangeError` for invalid bounds or an input carrying conflict resolutions, and `BuildListOptimizationInvariantError` /
 * `BuildListOptimizationMaterializationError` / a Planner error for a broken contract (never a result).
 */
export async function runBuildListOptimization(plannerInput: PlannerInput, dependencies: PlannerDependencies, bounds: BuildListOptimizationBounds,
  execution: BuildListOptimizationExecution = {}): Promise<BuildListOptimizationRun> {
  assertBuildListOptimizationBounds(bounds)
  if (plannerInput.conflictResolutions.length > 0) {
    throw new RangeError('The Build List global optimization reads no conflict resolution: its input carries conflictResolutions = [].')
  }
  const engine = dependencies.rngEngine
  const { shouldCancel, yieldControl, now } = execution
  const diagnostics: BuildListOptimizationDiagnostics = { reachTable: null, structuralSearch: null, candidates: [], plannerVerifications: 0, elapsedMs: now ? {} : null }
  let open: { stage: BuildListOptimizationStage; at: number } | null = null
  const close = () => {
    if (open !== null && now && diagnostics.elapsedMs) diagnostics.elapsedMs[open.stage] = (diagnostics.elapsedMs[open.stage] ?? 0) + (now() - open.at)
    open = null
  }
  const enter = (stage: BuildListOptimizationStage) => {
    close()
    execution.onStage?.(stage)
    if (now) open = { stage, at: now() }
  }
  const finish = (result: BuildListOptimizationResult): BuildListOptimizationRun => {
    close()
    return { kind: 'result', result }
  }
  const cancelled = (): BuildListOptimizationRun => {
    close()
    return { kind: 'cancelled' }
  }

  // Stage 0: the planning Targets, every unsupported reason the Domain decides, the exclusions and the out-of-scope Targets.
  enter('input_check')
  const created = createBuildListOptimizationContext(plannerInput, dependencies)
  if (created.kind === 'unsupported_input') {
    return finish({ status: 'unsupported', reasons: [created.reason === 'invalid_planner_input'
      ? { kind: 'invalid_planner_input', issues: created.validation.issues.map(({ path, code, message }) => ({ path, code, message })) }
      : { kind: 'no_planning_target' }] })
  }
  const { context } = created
  const unsupportedReasons = deriveBuildListOptimizationUnsupportedReasons(context, engine)
  if (unsupportedReasons.length > 0) return finish({ status: 'unsupported', reasons: unsupportedReasons })
  const inputExclusions = buildListOptimizationInputExclusionsOf(context.validation)
  const outOfScopeTargetCounts = countBuildListOptimizationOutOfScopeTargets(plannerInput, context.planningTargetIds)
  if (shouldCancel?.()) return cancelled()

  // Stage A.
  enter('reach_table')
  const built = await buildReachTable(context, engine, bounds.window, BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET, { shouldCancel, yieldControl })
  if (built.kind === 'cancelled') return cancelled()
  if (built.kind === 'unsupported_input') {
    throw new BuildListOptimizationInvariantError('stage_contract_violation', `Stage 0 accepted the input the ReachTable refuses (${built.reason}: ${built.detail}).`)
  }
  const table = built.table
  diagnostics.reachTable = reachTableDiagnostics(table)

  // Stage B / C.
  enter('assignment_search')
  const createdSearch = createStructuralCandidateSearch({ table, context, engine }, {
    nodeBudget: bounds.nodeBudget, mrvLookahead: bounds.mrvLookahead, coverageDrivenOrdering: true, shouldCancel,
  })
  if (createdSearch.kind === 'invalid_input') {
    throw new BuildListOptimizationInvariantError('stage_contract_violation', `The structural search refused its own context and table (${createdSearch.reason}: ${createdSearch.detail}).`)
  }
  const search = createdSearch.search
  const routeInputs = {
    context, table, engine, settings: bounds.routeGeneration, identity: { ...BUILD_LIST_OPTIMIZATION_ROUTE_IDENTITY, clock: dependencies.clock },
    search: execution.search, shouldCancel, yieldControl,
  }
  const reached: BuildListOptimizationBound[] = []
  let candidatesTried = 0
  let unconfirmed = false
  let stop: BuildListOptimizationBound | null = null
  let completeness: 'exhausted' | 'node_budget_reached' | 'cancelled' | null = null
  for (;;) {
    // One node per step, so a Worker can receive its cancel between nodes; the candidate sequence is the same as without pauses.
    const event = search.next(1)
    if (event.kind === 'paused') {
      await yieldControl?.()
      continue
    }
    if (event.kind === 'finished') {
      completeness = event.completeness
      break
    }
    const candidate = event.candidate
    candidatesTried += 1

    // Stage D.
    enter('route_generation')
    const generation = await generateStructuralCandidateRoutes(candidate, routeInputs)
    const record: BuildListOptimizationCandidateDiagnostics = {
      ordinal: candidate.ordinal, objective: candidate.assignment.objective,
      routeGeneration: { outcome: generation.outcome.kind, generatedTargetCount: generation.generatedEntries.length, methods: methodCounts(generation.targets) },
      verification: null,
    }
    diagnostics.candidates.push(record)
    if (generation.outcome.kind === 'generation_unconfirmed') {
      const outcome = generation.outcome.outcome
      if (outcome.kind === 'unmeasured') return cancelled()
      unconfirmed = true
      reached.push(outcome.kind === 'not_executed'
        ? { kind: 'shape_search_scale_gate', targetWeaponId: generation.outcome.targetWeaponId, exceeded: [...outcome.exceeded] }
        : { kind: 'shape_search_budget', targetWeaponId: generation.outcome.targetWeaponId, exceeded: [...outcome.budgetExceeded] })
    } else if (generation.outcome.kind === 'all_generated') {
      // Stage D'.
      enter('plan_verification')
      diagnostics.plannerVerifications += 1
      const verdict = await verifyBuildListOptimizationCandidate({
        context, inputExclusions, generation, dependencies, shouldCancel, yieldControl, planner: execution.planner,
      })
      if (verdict.kind === 'cancelled') return cancelled()
      record.verification = {
        outcome: verdict.kind, maxPlanSteps: verdict.maxPlanSteps, fullPlannerRuns: verdict.fullPlannerRuns,
        rejections: verdict.kind === 'rejected' ? structuredClone(verdict.rejections) : [],
      }
      if (verdict.kind === 'optimized') {
        const plan = verdict.plannerResult.plan!
        const { termination } = verdict.plannerResult
        close()
        diagnostics.structuralSearch = structuralDiagnostics(search, null)
        return finish({
          status: 'optimized',
          artifact: {
            plannerResult: verdict.plannerResult,
            generatedBuildListEntries: verdict.finalInput.generatedBuildListEntries,
            replacements: verdict.finalInput.replacements,
            unchangedTargetWeaponIds: verdict.finalInput.unchangedTargetWeaponIds,
            planningTargetWeaponIds: context.planningTargets.map(target => target.id),
            inputExclusions,
            inputToken: deriveBuildListOptimizationInputToken(plannerInput, plan),
            summary: {
              physicalOperationCount: verdict.physical.physicalOperations,
              planStepCount: verdict.physical.planSteps,
              nonPhysicalStepCount: verdict.nonPhysicalStepCount,
              structuralObjective: generation.objective,
              completedTargetCount: termination.completedTargetCount,
              totalTargetCount: termination.totalTargetCount,
              maxPlanSteps: verdict.maxPlanSteps,
              outOfScopeTargetCounts,
            },
            diagnostics,
          },
        })
      }
    }
    // A generation_unsupported candidate needs a prediction the Engine does not offer: rejected outright, like a rejected verification.
    if (candidatesTried >= bounds.maxStructuralCandidates) {
      stop = { kind: 'structural_candidate_limit', maxStructuralCandidates: bounds.maxStructuralCandidates }
      break
    }
    if (diagnostics.plannerVerifications >= bounds.maxPlannerVerifications) {
      stop = { kind: 'planner_verification_budget', maxPlannerVerifications: bounds.maxPlannerVerifications }
      break
    }
    enter('assignment_search')
  }
  close()
  if (completeness === 'cancelled') return cancelled()
  diagnostics.structuralSearch = structuralDiagnostics(search, completeness === 'exhausted' && candidatesTried === 0 ? noCandidateReason(search) : null)
  if (stop !== null) return finish({ status: 'search_bound_reached', bounds: [...reached, stop], diagnostics })
  if (completeness === 'node_budget_reached') {
    return finish({ status: 'search_bound_reached', bounds: [...reached, { kind: 'structural_search_node_budget', nodeBudget: bounds.nodeBudget }], diagnostics })
  }
  if (candidatesTried === 0) return finish({ status: 'not_found', reason: 'no_structural_candidate', diagnostics })
  if (unconfirmed) return finish({ status: 'search_bound_reached', bounds: reached, diagnostics })
  return finish({ status: 'not_found', reason: 'candidates_rejected', diagnostics })
}
