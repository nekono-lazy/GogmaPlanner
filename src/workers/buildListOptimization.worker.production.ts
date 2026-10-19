import { createProductionPlannerDependencies, type PlannerDependencies } from '../domain/planner'
import {
  runBuildListOptimization,
  type BuildListOptimizationBounds,
} from '../domain/planner/buildListOptimization'
import { ProductionRngEngine } from '../domain/rng/production/productionRngEngine'
import {
  BuildListOptimizationSearchBoundsUnavailableError,
  type BuildListOptimizationWorkerCalculation,
  type BuildListOptimizationWorkerRuntime,
} from './buildListOptimization.worker'

/**
 * The Production search bounds of the Build List global optimization (`docs/PLANNER_SPEC.md` 17.13): the window, the structural
 * search's node budget and lookahead, the structural candidate and verification budgets, and Stage D's gates and runtime budget.
 *
 * Decided by 17.19 U2 (Issue #260 PR-5B): the bounds set `w0-candidates-3` of the registered measurement plan
 * (`docs/BUILD_LIST_OPTIMIZATION_BROWSER_MEASUREMENT_PLAN.md`, series `pr5b-r2`), copied field by field with nothing completed or
 * guessed. It passed every criterion of the PC Browser measurement of this very Production calculation (series `pr5b-r2`,
 * `docs/BUILD_LIST_OPTIMIZATION_BROWSER_MEASUREMENT.md` 8), and the Owner chose it on 2026-10-15 over `w0-research` (the same bounds
 * with one structural candidate and one verification) to keep room for verifying the next structural candidate when the Planner
 * rejects the first. What a second or third candidate costs was not measured (the representative case accepts the first).
 *
 * Never the Candidate Search defaults or a saved setting; no request, Client, Application or UI ever carries a bound.
 */
export const PRODUCTION_BUILD_LIST_OPTIMIZATION_BOUNDS: BuildListOptimizationBounds = {
  window: { normal: 350, gogma: 500, skill: 1500 },
  nodeBudget: 2000,
  mrvLookahead: 8,
  maxStructuralCandidates: 3,
  maxPlannerVerifications: 3,
  routeGeneration: {
    projectedSearchScaleGate: { maxConversionPositions: 32, maxGogmaLegalWidth: 500, maxSkillLegalWidth: 1501, maxNormalForgeCount: 350 },
    shapeSearchScaleGate: { maxDepthUpperBound: 2000, maxGogmaGeneratedStateUpperBound: 502_000_000, maxNormalForgeCount: 350, maxConversionWalkPositions: 1501 },
    shapeSearchBudget: {
      maxGogmaGeneratedStates: 50_000_000,
      maxSkillStates: 2_250_000,
      maxSettledWork: 100_000,
      maxPredictions: { normalArtian: 350, skill: 1501, gogmaReset: 500, gogmaKeep: 500 },
    },
  },
}

/** Creates the Production Engine, ID factory and Clock inside the Worker boundary. */
export function createProductionBuildListOptimizationWorkerDependencies(): PlannerDependencies {
  return createProductionPlannerDependencies(new ProductionRngEngine())
}

/**
 * The Production calculation with the given search bounds: `runBuildListOptimization()` itself, handed a copy of the bounds. With
 * `null` it refuses before any Stage (`search_bounds_unavailable`: only the benchmark-only measurement Worker can pass none, when a
 * run arrives before its bounds message). The Domain keeps every bound caller-required (no default, fallback, completion or clamp),
 * and the final verification's `maxPlanSteps` stays the Domain's own derivation: nothing here computes a step bound.
 *
 * This is the one injection point of the bounds: the Production Worker passes `PRODUCTION_BUILD_LIST_OPTIMIZATION_BOUNDS`, and the
 * benchmark-only measurement Worker passes the bounds a measurement run is configured with.
 */
export function createBuildListOptimizationCalculation(
  bounds: BuildListOptimizationBounds | null,
): BuildListOptimizationWorkerCalculation {
  const fixed = bounds === null ? null : structuredClone(bounds)
  return async (input, dependencies, execution) => {
    if (fixed === null) throw new BuildListOptimizationSearchBoundsUnavailableError()
    return runBuildListOptimization(input, dependencies, structuredClone(fixed), execution)
  }
}

/** The Worker runtime over the given search bounds, with the Production dependencies and the Worker's monotonic clock. */
export function createBuildListOptimizationWorkerRuntime(
  bounds: BuildListOptimizationBounds | null,
): BuildListOptimizationWorkerRuntime {
  return {
    createDependencies: createProductionBuildListOptimizationWorkerDependencies,
    calculation: createBuildListOptimizationCalculation(bounds),
    now: () => performance.now(),
  }
}

/** The Production Worker runtime: the Production search bounds (`PRODUCTION_BUILD_LIST_OPTIMIZATION_BOUNDS`). */
export function createProductionBuildListOptimizationWorkerRuntime(): BuildListOptimizationWorkerRuntime {
  return createBuildListOptimizationWorkerRuntime(PRODUCTION_BUILD_LIST_OPTIMIZATION_BOUNDS)
}
