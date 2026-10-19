import { createProductionPlanWithObserver } from '../productionPlanGeneration'
import type {
  PlannerDependencies,
  PlannerExecutionOptions,
  PlannerInput,
  PlannerResult,
  PlannerRouteCommitmentEvidence,
  PlannerRunBuildListContext,
  ProductionPlanGenerationObserver,
} from '../plannerTypes'
import {
  PlannerAlternativeRerunLimitError,
  type PlannerAlternativeFullRunBudget,
} from './plannerAlternativeTrial'

/**
 * The one full Planner run path of a Planner Alternative request
 * (`docs/PLANNER_SPEC.md` 9.2.19.6 / 9.2.19.12): the kernel's individual
 * trials and a research caller's own full runs go through it, so every run -
 * and every runtime-unsupported retry inside
 * `createProductionPlanWithObserver()` - consumes the one request-global
 * `PlannerAlternativeFullRunBudget` it was created with. (The scenario
 * composition's adoption and final runs of 9.2.19.8.1 did too, until Issue
 * #278 PR-7 removed the what-if and the actual repair.)
 */

/** A cancelled Planner Alternative request. It is never an outcome. */
export class PlannerAlternativeCancelledError extends Error {
  constructor(message = 'The Planner Alternative calculation was cancelled.') {
    super(message)
    this.name = 'PlannerAlternativeCancelledError'
  }
}

/** One full Planner run + Trace Replay that was started and finished. */
export interface PlannerAlternativeFullRun {
  result: PlannerResult
  /**
   * The route commitment evidence of the run the Plan was built from (the
   * last run of one Production Plan generation, after any runtime-unsupported
   * retry), or `null` when that run made no route commitment. Runtime-only.
   */
  routeCommitment: PlannerRouteCommitmentEvidence | null
}

export interface PlannerAlternativeFullRunner {
  readonly budget: PlannerAlternativeFullRunBudget
  /**
   * Starts one Production Plan generation. `'rerun_budget_reached'` is the
   * typed stop of a run the budget refused; cancellation throws
   * `PlannerAlternativeCancelledError`; every other failure - Plan generation,
   * a Trace Replay failure included, prediction, Planner or Search invariant -
   * propagates unchanged.
   */
  run(
    input: PlannerInput,
    buildListContext: PlannerRunBuildListContext,
  ): Promise<PlannerAlternativeFullRun | 'rerun_budget_reached'>
}

export function createPlannerAlternativeFullRunner(
  budget: PlannerAlternativeFullRunBudget,
  dependencies: PlannerDependencies,
  executionOptions: PlannerExecutionOptions | undefined,
): PlannerAlternativeFullRunner {
  let cancelledPlannerRun = false
  const readCancelledPlannerRun = (): boolean => cancelledPlannerRun
  // Reset before every generation: the evidence of its last full run.
  let lastRouteCommitment: PlannerRouteCommitmentEvidence | null = null
  const readLastRouteCommitment = (): PlannerRouteCommitmentEvidence | null => lastRouteCommitment
  const observer: ProductionPlanGenerationObserver = {
    beforePlannerRun: () => budget.beforePlannerRun(),
    afterPlannerRun: (runResult) => {
      if (runResult.cancelled) cancelledPlannerRun = true
      lastRouteCommitment = runResult.routeCommitment ?? null
    },
  }
  return {
    budget,
    run: async (input, buildListContext) => {
      cancelledPlannerRun = false
      lastRouteCommitment = null
      let result: PlannerResult
      try {
        result = await createProductionPlanWithObserver(
          input,
          dependencies,
          executionOptions,
          observer,
          buildListContext,
        )
      } catch (error) {
        if (error instanceof PlannerAlternativeRerunLimitError) return 'rerun_budget_reached'
        throw error
      }
      // A cancelled run returns a safe `plan: null` result, which is no verdict.
      if (readCancelledPlannerRun()) throw new PlannerAlternativeCancelledError()
      return { result, routeCommitment: readLastRouteCommitment() }
    },
  }
}
