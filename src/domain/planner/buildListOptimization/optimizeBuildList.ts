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
 * Stage A - D' are one calculation core (`runBuildListOptimizationStages()`) over the scope a Stage 0 fixed. The Build List global
 * optimization's Stage 0 is here; the running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.6, Issue #276) has its own Stage 0R
 * (the replan target set, its scope and Entry rule) and runs the very same core, so the two never drift apart.
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
  BuildListOptimizationInputExclusion, BuildListOptimizationPlanSummary, BuildListOptimizationResult, BuildListOptimizationRun,
  BuildListOptimizationStage,
} from './buildListOptimizationResult'
import {
  BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET, BuildListOptimizationInvariantError, type BuildListOptimizationContext, type ReachTable,
} from './buildListOptimizationTypes'
import { noCandidateReason } from './coverageSearch'
import type { CoverageSearch, NoStructuralCandidateReason, StructuralSearchDiagnostics } from './coverageSearchTypes'
import type { StructuralCandidate } from './coverageTypes'
import {
  buildListOptimizationInputExclusionsOf, verifyBuildListOptimizationCandidate, type BuildListOptimizationEntryChangeRule,
  type FinalVerificationOutcome,
} from './finalVerification'
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
 * The stage bookkeeping of one calculation, from its Stage 0 to its end: the diagnostics, the stage notifications and (with the
 * caller's monotonic clock) the stage timings. One tracker serves one calculation; Stage 0 enters `input_check` on it before the core
 * continues on the same tracker.
 */
export interface BuildListOptimizationStageTracker {
  readonly diagnostics: BuildListOptimizationDiagnostics
  /** Closes the open stage (recording its time) and opens `stage`, notifying the caller. */
  enter(stage: BuildListOptimizationStage): void
  /** Closes the open stage, if any. */
  close(): void
}

export function createBuildListOptimizationStageTracker(execution: Pick<BuildListOptimizationExecution, 'onStage' | 'now'>): BuildListOptimizationStageTracker {
  const { now } = execution
  const diagnostics: BuildListOptimizationDiagnostics = { reachTable: null, structuralSearch: null, candidates: [], plannerVerifications: 0, elapsedMs: now ? {} : null }
  let open: { stage: BuildListOptimizationStage; at: number } | null = null
  const close = () => {
    if (open !== null && now && diagnostics.elapsedMs) diagnostics.elapsedMs[open.stage] = (diagnostics.elapsedMs[open.stage] ?? 0) + (now() - open.at)
    open = null
  }
  return {
    diagnostics,
    enter: (stage) => {
      close()
      execution.onStage?.(stage)
      if (now) open = { stage, at: now() }
    },
    close,
  }
}

/**
 * What a Stage 0 fixed for Stage A - D' of one calculation: the planning Targets and the input every later Stage reads (the context),
 * the Entries the input validation excluded with their warnings (the final input must exclude exactly these, 17.7 item 3) and how a
 * generated Entry enters the final input.
 *
 * - the Build List global optimization (17.3): the valid Entries' planning Targets over the whole Build List, Stage 0's exclusions,
 *   `replace_only`
 * - the running Plan replan re-optimization (18.6): the replan target set over the replan Targets' current Entries only, no exclusion
 *   (every replan Target's Entry is replaced, reused or added), `replace_or_add`
 */
export interface BuildListOptimizationScope {
  context: BuildListOptimizationContext
  inputExclusions: readonly BuildListOptimizationInputExclusion[]
  entryChanges: BuildListOptimizationEntryChangeRule
}

/** Stage A - D' of one calculation over a fixed scope. */
export type BuildListOptimizationStagesOutcome =
  | { kind: 'cancelled' }
  /** Stage D' accepted a candidate: the verdict and the candidate's structural objective. The tracker's diagnostics are final. */
  | { kind: 'optimized'; verdict: Extract<FinalVerificationOutcome, { kind: 'optimized' }>; structuralObjective: number }
  /** No candidate was accepted: the 17.8 class with its diagnostics, independent of the scope's Stage 0. */
  | { kind: 'concluded'; result: Extract<BuildListOptimizationResult, { status: 'not_found' | 'search_bound_reached' }> }

/**
 * Stage A - D' over the scope a Stage 0 fixed (`docs/PLANNER_SPEC.md` 17.6; 18.6 runs the same core): the ReachTable, the structural
 * candidate search, the route generation and the final verification, under the caller's bounds, with the result classes of 17.8. It
 * reads the scope alone - never a Stage 0 rule, the Build List outside the scope's input, or a persisted state - and closes the
 * tracker before it returns. The bounds must have been asserted by the caller.
 */
export async function runBuildListOptimizationStages(scope: BuildListOptimizationScope, dependencies: PlannerDependencies, bounds: BuildListOptimizationBounds,
  execution: BuildListOptimizationExecution, tracker: BuildListOptimizationStageTracker): Promise<BuildListOptimizationStagesOutcome> {
  const { context, inputExclusions, entryChanges } = scope
  const engine = dependencies.rngEngine
  const { shouldCancel, yieldControl } = execution
  const { diagnostics } = tracker
  const cancelled = (): BuildListOptimizationStagesOutcome => {
    tracker.close()
    return { kind: 'cancelled' }
  }
  const concluded = (result: Extract<BuildListOptimizationResult, { status: 'not_found' | 'search_bound_reached' }>): BuildListOptimizationStagesOutcome => {
    tracker.close()
    return { kind: 'concluded', result }
  }

  // Stage A.
  tracker.enter('reach_table')
  const built = await buildReachTable(context, engine, bounds.window, BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET, { shouldCancel, yieldControl })
  if (built.kind === 'cancelled') return cancelled()
  if (built.kind === 'unsupported_input') {
    throw new BuildListOptimizationInvariantError('stage_contract_violation', `Stage 0 accepted the input the ReachTable refuses (${built.reason}: ${built.detail}).`)
  }
  const table = built.table
  diagnostics.reachTable = reachTableDiagnostics(table)

  // Stage B / C.
  tracker.enter('assignment_search')
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
    tracker.enter('route_generation')
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
      tracker.enter('plan_verification')
      diagnostics.plannerVerifications += 1
      const verdict = await verifyBuildListOptimizationCandidate({
        context, inputExclusions, generation, entryChanges, dependencies, shouldCancel, yieldControl, planner: execution.planner,
      })
      if (verdict.kind === 'cancelled') return cancelled()
      record.verification = {
        outcome: verdict.kind, maxPlanSteps: verdict.maxPlanSteps, fullPlannerRuns: verdict.fullPlannerRuns,
        rejections: verdict.kind === 'rejected' ? structuredClone(verdict.rejections) : [],
      }
      if (verdict.kind === 'optimized') {
        tracker.close()
        diagnostics.structuralSearch = structuralDiagnostics(search, null)
        return { kind: 'optimized', verdict, structuralObjective: generation.objective }
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
    tracker.enter('assignment_search')
  }
  tracker.close()
  if (completeness === 'cancelled') return cancelled()
  diagnostics.structuralSearch = structuralDiagnostics(search, completeness === 'exhausted' && candidatesTried === 0 ? noCandidateReason(search) : null)
  if (stop !== null) return concluded({ status: 'search_bound_reached', bounds: [...reached, stop], diagnostics })
  if (completeness === 'node_budget_reached') {
    return concluded({ status: 'search_bound_reached', bounds: [...reached, { kind: 'structural_search_node_budget', nodeBudget: bounds.nodeBudget }], diagnostics })
  }
  if (candidatesTried === 0) return concluded({ status: 'not_found', reason: 'no_structural_candidate', diagnostics })
  if (unconfirmed) return concluded({ status: 'search_bound_reached', bounds: reached, diagnostics })
  return concluded({ status: 'not_found', reason: 'candidates_rejected', diagnostics })
}

/** The final Plan's figures of an accepted Stage D' verdict (`docs/PLANNER_SPEC.md` 17.9 / 17.13; 18.7 reads the same). */
export function buildListOptimizationPlanSummaryOf(verdict: Extract<FinalVerificationOutcome, { kind: 'optimized' }>, structuralObjective: number): BuildListOptimizationPlanSummary {
  const { termination } = verdict.plannerResult
  return {
    physicalOperationCount: verdict.physical.physicalOperations,
    planStepCount: verdict.physical.planSteps,
    nonPhysicalStepCount: verdict.nonPhysicalStepCount,
    structuralObjective,
    completedTargetCount: termination.completedTargetCount,
    totalTargetCount: termination.totalTargetCount,
    maxPlanSteps: verdict.maxPlanSteps,
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
  const tracker = createBuildListOptimizationStageTracker(execution)
  const finish = (result: BuildListOptimizationResult): BuildListOptimizationRun => {
    tracker.close()
    return { kind: 'result', result }
  }

  // Stage 0: the planning Targets, every unsupported reason the Domain decides, the exclusions and the out-of-scope Targets.
  tracker.enter('input_check')
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
  if (execution.shouldCancel?.()) {
    tracker.close()
    return { kind: 'cancelled' }
  }

  // Stage A - D'.
  const outcome = await runBuildListOptimizationStages({ context, inputExclusions, entryChanges: 'replace_only' }, dependencies, bounds, execution, tracker)
  if (outcome.kind === 'cancelled') return { kind: 'cancelled' }
  if (outcome.kind === 'concluded') return { kind: 'result', result: outcome.result }
  const { verdict } = outcome
  return {
    kind: 'result',
    result: {
      status: 'optimized',
      artifact: {
        plannerResult: verdict.plannerResult,
        generatedBuildListEntries: verdict.finalInput.generatedBuildListEntries,
        replacements: verdict.finalInput.replacements,
        unchangedTargetWeaponIds: verdict.finalInput.unchangedTargetWeaponIds,
        planningTargetWeaponIds: context.planningTargets.map(target => target.id),
        inputExclusions,
        inputToken: deriveBuildListOptimizationInputToken(plannerInput, verdict.plannerResult.plan!),
        summary: { ...buildListOptimizationPlanSummaryOf(verdict, outcome.structuralObjective), outOfScopeTargetCounts },
        diagnostics: tracker.diagnostics,
      },
    },
  }
}
