import type {
  CreateProductionPlanCalculation,
  PlannerDependencies,
  PlannerExecutionOptions,
  PlannerInput,
} from '../domain/planner'
import type {
  PlannerInteractionPreparationResult,
  PlannerWorkerProtocolRequest,
  PlannerWorkerProtocolResponse,
} from './plannerWorkerContracts'

export type PlannerWorkerPostMessage = (
  response: PlannerWorkerProtocolResponse,
) => void
export type PlannerDependenciesFactory = () => PlannerDependencies

/**
 * The two Planner calculations this Worker routes to.
 *
 * Both are injected, so the controller performs no full Planner run, no
 * Candidate search, no Trace Replay, and no conflict preparation of its own:
 * the ordinary Planner Domain owns all of that, and the Production adapter
 * composes it. The legacy B8 constrained re-search and B9 what-if calculations
 * are no longer Worker calculations (Phase 6-B1, `docs/PLANNER_SPEC.md`
 * 9.2.19.16), and neither are the Planner Alternative what-if and actual
 * repair (Issue #278 PR-4, 9.6.12).
 */
export interface PlannerWorkerCalculations {
  createPlan: CreateProductionPlanCalculation
  prepareInteraction: PreparePlannerInteractionCalculation
}

/** Synchronous initial preparation needs no cancellation hooks. */
export type PreparePlannerInteractionCalculation = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
) => PlannerInteractionPreparationResult

export interface PlannerWorkerController {
  handleMessage(request: PlannerWorkerProtocolRequest): Promise<void>
  isCancelled(requestId: string): boolean
}

function workerYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Message orchestration only. All calculations are supplied separately and
 * receive the worker-local runtime dependencies rather than structured-cloned
 * methods.
 *
 * `cancel` and error conversion are shared by the request kinds: a cancel
 * stops the task instance it names, and Domain cancellation semantics are never
 * reimplemented here. The Production Worker forwards no progress (Issue #103
 * Phase D-2a): a task answers with its result or an error, and cancellation
 * reaches the calculation through `shouldCancel`, never through a progress
 * message.
 */
export function createPlannerWorkerController(
  dependencies: PlannerDependencies,
  calculations: PlannerWorkerCalculations,
  postMessage: PlannerWorkerPostMessage,
): PlannerWorkerController {
  /**
   * The Client-minted task generation that currently owns each logical request
   * id, and the generations that have been cancelled.
   *
   * The Worker never mints a generation of its own: doing so would lose the
   * correspondence with the Client token, which is what lets the Client discard
   * a stale response it receives before its own newer task has even been
   * delivered here. All Planner tasks keep sharing one logical id
   * namespace; only the generation distinguishes task instances.
   *
   * Cancellation is tracked per generation rather than per request id, so a new
   * task instance is never born cancelled and an older instance can never be
   * revived by a newer one.
   */
  const generationByRequestId = new Map<string, number>()
  const cancelledGenerations = new Set<number>()

  const isCurrent = (requestId: string, generation: number): boolean =>
    generationByRequestId.get(requestId) === generation
  /** A retired calculation is silent: it posts no result or error. */
  const isActive = (requestId: string, generation: number): boolean =>
    isCurrent(requestId, generation) && !cancelledGenerations.has(generation)

  /** Exactly the Production hooks: cancellation and cooperative yielding. */
  const executionOptions = (
    requestId: string,
    generation: number,
  ): PlannerExecutionOptions => ({
    shouldCancel: () =>
      !isCurrent(requestId, generation) || cancelledGenerations.has(generation),
    yieldControl: workerYield,
  })
  return {
    isCancelled: (requestId) => {
      const generation = generationByRequestId.get(requestId)
      return generation !== undefined && cancelledGenerations.has(generation)
    },
    handleMessage: async (request) => {
      const { requestId, generation } = request
      if (request.type === 'cancel') {
        // Only the instance the Client is actually waiting on is cancelled: a
        // cancel minted for an older generation never reaches a newer task.
        if (!isCurrent(requestId, generation)) return
        cancelledGenerations.add(generation)
        return
      }
      const owning = generationByRequestId.get(requestId)
      // A task that a newer generation has already superseded is dropped
      // outright rather than run and then silenced.
      if (owning !== undefined && generation <= owning) return
      generationByRequestId.set(requestId, generation)
      try {
        // Every calculation has an explicit branch. In particular, preparation
        // is never treated as the ordinary fallback.
        let response: PlannerWorkerProtocolResponse
        switch (request.type) {
          case 'prepare_interaction':
            response = {
              type: 'prepare_interaction_result',
              requestId,
              generation,
              result: calculations.prepareInteraction(request.input, dependencies),
            }
            break
          case 'create_plan':
            response = {
              type: 'create_plan_result',
              requestId,
              generation,
              result: await calculations.createPlan(
                request.input,
                dependencies,
                executionOptions(requestId, generation),
              ),
            }
            break
        }
        if (isActive(requestId, generation)) postMessage(response)
      } catch (error: unknown) {
        // A Domain error keeps its meaning: it is reported as the existing
        // Worker error response and never reclassified from its message text,
        // nor converted into a result.
        if (!isActive(requestId, generation)) return
        postMessage({
          type: 'error',
          requestId,
          generation,
          message: error instanceof Error ? error.message : 'Unknown Planner error.',
        })
      }
    },
  }
}

export interface PlannerWorkerScope {
  postMessage: PlannerWorkerPostMessage
  addEventListener(
    type: 'message',
    listener: (event: { data: PlannerWorkerProtocolRequest }) => void,
  ): void
}

/** Creates Engine/ID/Clock dependencies inside the Worker module boundary. */
export function attachPlannerWorker(
  scope: PlannerWorkerScope,
  createDependencies: PlannerDependenciesFactory,
  calculations: PlannerWorkerCalculations,
): PlannerWorkerController {
  const controller = createPlannerWorkerController(
    createDependencies(),
    calculations,
    (response) => scope.postMessage(response),
  )
  scope.addEventListener('message', (event) => {
    void controller.handleMessage(event.data)
  })
  return controller
}
