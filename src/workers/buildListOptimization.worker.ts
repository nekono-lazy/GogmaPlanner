import type { PlannerDependencies, PlannerInput } from '../domain/planner'
import {
  BuildListOptimizationInvariantError,
  BuildListOptimizationMaterializationError,
  type BuildListOptimizationExecution,
  type BuildListOptimizationRun,
  type BuildListOptimizationStage,
} from '../domain/planner/buildListOptimization'
import {
  addressableBuildListOptimizationRequestId,
  buildListOptimizationRunRequestIssues,
  type BuildListOptimizationWorkerErrorCode,
  type BuildListOptimizationWorkerErrorResponse,
  type BuildListOptimizationWorkerResponse,
  type BuildListOptimizationWorkerRunRequest,
  type BuildListOptimizationWorkerTerminalResponse,
} from './buildListOptimizationWorkerContracts'

/**
 * The one calculation this Worker runs. The Production adapter composes `runBuildListOptimization()` with its search bounds; the
 * controller re-implements no Stage and decides no result of its own.
 */
export type BuildListOptimizationWorkerCalculation = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
  execution: BuildListOptimizationExecution,
) => Promise<BuildListOptimizationRun>

/** What the Worker module supplies inside its own boundary: never structured-cloned from the main thread. */
export interface BuildListOptimizationWorkerRuntime {
  /** The Production Engine, ID factory and Clock, created inside the Worker. */
  createDependencies(): PlannerDependencies
  calculation: BuildListOptimizationWorkerCalculation
  /** A monotonic clock for the diagnostics' stage timings only (Debug Mode display; never a judgement input). */
  now?: () => number
}

/**
 * The Production search bounds are not decided yet (`docs/PLANNER_SPEC.md` 17.13 / 17.19 U2): the Production adapter refuses to run
 * rather than guess a window or budget.
 */
export class BuildListOptimizationSearchBoundsUnavailableError extends Error {
  constructor() {
    super('The Production search bounds of the Build List global optimization are not decided yet, so no calculation runs.')
    this.name = 'BuildListOptimizationSearchBoundsUnavailableError'
  }
}

/** A message nothing can answer (it names no requestId): raised as an uncaught Worker error, which the main thread observes. */
export class BuildListOptimizationWorkerProtocolError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`The Build List optimization Worker received a message it cannot answer: ${issues.join(' ')}`)
    this.name = 'BuildListOptimizationWorkerProtocolError'
    this.issues = [...issues]
  }
}

export type BuildListOptimizationWorkerPostMessage = (response: BuildListOptimizationWorkerResponse) => void

export interface BuildListOptimizationWorkerController {
  /**
   * Receives one message. A run request starts the calculation and the returned Promise settles when its terminal response has been
   * posted. A malformed message that names no requestId throws synchronously instead (nothing can be posted for it).
   */
  handleMessage(message: unknown): Promise<void>
}

function errorResponseOf(requestId: string, stage: BuildListOptimizationStage | null, error: unknown): BuildListOptimizationWorkerErrorResponse {
  let code: BuildListOptimizationWorkerErrorCode = 'calculation_failed'
  if (error instanceof BuildListOptimizationSearchBoundsUnavailableError) code = 'search_bounds_unavailable'
  else if (error instanceof BuildListOptimizationInvariantError) code = 'invariant_violation'
  else if (error instanceof BuildListOptimizationMaterializationError) code = 'materialization_failed'
  // Read as plain fields: a DOMException (a DataCloneError) need not be an `Error` instance in every realm.
  const fields = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : {}
  const domainCode = error instanceof Error && typeof fields.code === 'string' ? fields.code : null
  const message = typeof fields.message === 'string' ? fields.message : 'Unknown Build List optimization error.'
  return { type: 'blo_error', requestId, stage, code, domainCode, message }
}

/**
 * The message orchestration of the one-run Worker (`docs/PLANNER_SPEC.md` 17.16):
 *
 * - the first well-formed `blo_run` starts the one calculation of this Worker; a later request is refused (`worker_already_used`), a
 *   repeat of the running requestId is dropped, so one request never gets two terminal responses;
 * - every stage the calculation enters is posted as `blo_progress` (the stage name only) until the terminal response, never after;
 * - the terminal response is the typed result (`blo_result`) or an error (`blo_error`); a Domain error keeps its meaning and is never
 *   converted into `unsupported` / `not_found` / `search_bound_reached`;
 * - nothing here cancels: the main thread cancels by terminating the Worker, which holds no state and writes nothing.
 */
export function createBuildListOptimizationWorkerController(
  runtime: BuildListOptimizationWorkerRuntime,
  postMessage: BuildListOptimizationWorkerPostMessage,
): BuildListOptimizationWorkerController {
  /** The requestId this Worker serves; null until the first addressable request arrives. */
  let servedRequestId: string | null = null

  const runOnce = async (request: BuildListOptimizationWorkerRunRequest): Promise<void> => {
    const { requestId } = request
    let stage: BuildListOptimizationStage | null = null
    let settled = false
    const settle = (response: BuildListOptimizationWorkerTerminalResponse) => {
      if (settled) return
      settled = true
      try {
        postMessage(response)
      } catch (error: unknown) {
        // A result that cannot be structured-cloned is still answered: the run failed, it did not return nothing.
        postMessage(errorResponseOf(requestId, stage, error))
      }
    }
    const onStage = (next: BuildListOptimizationStage) => {
      if (settled) return
      stage = next
      postMessage({ type: 'blo_progress', requestId, stage: next })
    }
    try {
      const dependencies = runtime.createDependencies()
      const run = await runtime.calculation(request.input, dependencies, runtime.now ? { onStage, now: runtime.now } : { onStage })
      if (run.kind !== 'result') {
        throw new Error('The calculation reported a cancellation no one requested: the Worker cancels only by being terminated.')
      }
      settle({ type: 'blo_result', requestId, result: run.result })
    } catch (error: unknown) {
      settle(errorResponseOf(requestId, stage, error))
    }
  }

  return {
    handleMessage: (message) => {
      const issues = buildListOptimizationRunRequestIssues(message)
      const requestId = addressableBuildListOptimizationRequestId(message)
      if (requestId === null) throw new BuildListOptimizationWorkerProtocolError(issues)
      if (servedRequestId !== null) {
        // The requestId already being served got (or will get) its own terminal response; a different one is refused.
        if (requestId !== servedRequestId) {
          postMessage({ type: 'blo_error', requestId, stage: null, code: 'worker_already_used', domainCode: null, message: 'This Worker serves one run only.' })
        }
        return Promise.resolve()
      }
      servedRequestId = requestId
      if (issues.length > 0) {
        postMessage({ type: 'blo_error', requestId, stage: null, code: 'invalid_request', domainCode: null, message: issues.join(' ') })
        return Promise.resolve()
      }
      return runOnce(message as BuildListOptimizationWorkerRunRequest)
    },
  }
}

export interface BuildListOptimizationWorkerScope {
  postMessage(response: BuildListOptimizationWorkerResponse): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

/** Attaches the controller to the Worker global scope with the runtime the Worker module composed. */
export function attachBuildListOptimizationWorker(
  scope: BuildListOptimizationWorkerScope,
  runtime: BuildListOptimizationWorkerRuntime,
): BuildListOptimizationWorkerController {
  const controller = createBuildListOptimizationWorkerController(runtime, (response) => scope.postMessage(response))
  scope.addEventListener('message', (event) => {
    // A synchronous throw (a message that names no requestId) escapes the listener as an uncaught Worker error on purpose.
    void controller.handleMessage(event.data)
  })
  return controller
}
