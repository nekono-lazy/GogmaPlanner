import {
  RunningPlanReplanOptimizationInputError,
  type RunningPlanReplanOptimizationInput,
  type RunningPlanReplanOptimizationRun,
} from '../domain/execution/runningPlanReplanOptimization'
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
} from './buildListOptimizationWorkerContracts'
import {
  isRunningPlanReplanRunMessage,
  runningPlanReplanRunRequestIssues,
  type RunningPlanReplanWorkerErrorResponse,
  type RunningPlanReplanWorkerResponse,
  type RunningPlanReplanWorkerRunRequest,
} from './runningPlanReplanWorkerContracts'

/**
 * The Build List global optimization this Worker runs for `blo_run`. The Production adapter composes `runBuildListOptimization()`
 * with its search bounds; the controller re-implements no Stage and decides no result of its own.
 */
export type BuildListOptimizationWorkerCalculation = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
  execution: BuildListOptimizationExecution,
) => Promise<BuildListOptimizationRun>

/**
 * The running Plan replan re-optimization this Worker runs for `blo_replan_run` (Issue #276 PR-4). The Production adapter composes
 * `runRunningPlanReplanOptimization()` with the same search bounds (`docs/PLANNER_SPEC.md` 18.6, 18.12 R5).
 */
export type RunningPlanReplanWorkerCalculation = (
  input: RunningPlanReplanOptimizationInput,
  dependencies: PlannerDependencies,
  execution: BuildListOptimizationExecution,
) => Promise<RunningPlanReplanOptimizationRun>

/** What the Worker module supplies inside its own boundary: never structured-cloned from the main thread. */
export interface BuildListOptimizationWorkerRuntime {
  /** The Production Engine, ID factory and Clock, created inside the Worker. */
  createDependencies(): PlannerDependencies
  calculation: BuildListOptimizationWorkerCalculation
  replanCalculation: RunningPlanReplanWorkerCalculation
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

/** Every message this Worker posts: the responses of `blo_run` and those of `blo_replan_run`, never mixed within one request. */
export type BuildListOptimizationWorkerOutgoingMessage = BuildListOptimizationWorkerResponse | RunningPlanReplanWorkerResponse

export type BuildListOptimizationWorkerPostMessage = (response: BuildListOptimizationWorkerOutgoingMessage) => void

export interface BuildListOptimizationWorkerController {
  /**
   * Receives one message. A run request starts the calculation and the returned Promise settles when its terminal response has been
   * posted. A malformed message that names no requestId throws synchronously instead (nothing can be posted for it).
   */
  handleMessage(message: unknown): Promise<void>
}

/** The fields an error carries, read as plain fields: a DOMException (a DataCloneError) need not be an `Error` instance in every realm. */
function errorFieldsOf(error: unknown): { domainCode: string | null; message: string } {
  const fields = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : {}
  return {
    domainCode: error instanceof Error && typeof fields.code === 'string' ? fields.code : null,
    message: typeof fields.message === 'string' ? fields.message : 'Unknown Build List optimization error.',
  }
}

function errorCodeOf(error: unknown): BuildListOptimizationWorkerErrorCode {
  if (error instanceof BuildListOptimizationSearchBoundsUnavailableError) return 'search_bounds_unavailable'
  if (error instanceof BuildListOptimizationInvariantError) return 'invariant_violation'
  if (error instanceof BuildListOptimizationMaterializationError) return 'materialization_failed'
  return 'calculation_failed'
}

function errorResponseOf(requestId: string, stage: BuildListOptimizationStage | null, error: unknown): BuildListOptimizationWorkerErrorResponse {
  return { type: 'blo_error', requestId, stage, code: errorCodeOf(error), ...errorFieldsOf(error) }
}

function replanErrorResponseOf(requestId: string, stage: BuildListOptimizationStage | null, error: unknown): RunningPlanReplanWorkerErrorResponse {
  const code = error instanceof RunningPlanReplanOptimizationInputError ? 'input_contract_violation' : errorCodeOf(error)
  return { type: 'blo_replan_error', requestId, stage, code, ...errorFieldsOf(error) }
}

/** How one request kind is answered: its progress, result and error responses (each request is answered in its own protocol). */
interface RunResponses<TResult> {
  progress(stage: BuildListOptimizationStage): BuildListOptimizationWorkerOutgoingMessage
  result(result: TResult): BuildListOptimizationWorkerOutgoingMessage
  error(stage: BuildListOptimizationStage | null, error: unknown): BuildListOptimizationWorkerOutgoingMessage
}

type CalculationRun<TResult> = { kind: 'result'; result: TResult } | { kind: 'cancelled' }

function buildListOptimizationResponses(requestId: string): RunResponses<Extract<BuildListOptimizationRun, { kind: 'result' }>['result']> {
  return {
    progress: stage => ({ type: 'blo_progress', requestId, stage }),
    result: result => ({ type: 'blo_result', requestId, result }),
    error: (stage, error) => errorResponseOf(requestId, stage, error),
  }
}

function runningPlanReplanResponses(requestId: string): RunResponses<Extract<RunningPlanReplanOptimizationRun, { kind: 'result' }>['result']> {
  return {
    progress: stage => ({ type: 'blo_replan_progress', requestId, stage }),
    result: result => ({ type: 'blo_replan_result', requestId, result }),
    error: (stage, error) => replanErrorResponseOf(requestId, stage, error),
  }
}

/**
 * The message orchestration of the one-run Worker (`docs/PLANNER_SPEC.md` 17.16, 18.6):
 *
 * - a `blo_replan_run` message is a running Plan replan request (Issue #276 PR-4); every other message is read as a Build List
 *   optimization `blo_run` request exactly as before, so a malformed one is still answered `blo_error` / `invalid_request`;
 * - the first well-formed request of either kind starts the one calculation of this Worker; a later request is refused
 *   (`worker_already_used`, in its own protocol), a repeat of the running requestId is dropped, so one request never gets two terminal
 *   responses;
 * - every stage the calculation enters is posted as the request's progress (the stage name only) until the terminal response, never
 *   after;
 * - the terminal response is the typed result or an error; a Domain error keeps its meaning and is never converted into
 *   `unsupported` / `not_found` / `search_bound_reached`;
 * - nothing here cancels: the main thread cancels by terminating the Worker, which holds no state and writes nothing.
 */
export function createBuildListOptimizationWorkerController(
  runtime: BuildListOptimizationWorkerRuntime,
  postMessage: BuildListOptimizationWorkerPostMessage,
): BuildListOptimizationWorkerController {
  /** The requestId this Worker serves; null until the first addressable request arrives. */
  let servedRequestId: string | null = null

  const runOnce = async <TResult>(
    responses: RunResponses<TResult>,
    calculate: (dependencies: PlannerDependencies, execution: BuildListOptimizationExecution) => Promise<CalculationRun<TResult>>,
  ): Promise<void> => {
    let stage: BuildListOptimizationStage | null = null
    let settled = false
    const settle = (response: BuildListOptimizationWorkerOutgoingMessage) => {
      if (settled) return
      settled = true
      try {
        postMessage(response)
      } catch (error: unknown) {
        // A result that cannot be structured-cloned is still answered: the run failed, it did not return nothing.
        postMessage(responses.error(stage, error))
      }
    }
    const onStage = (next: BuildListOptimizationStage) => {
      if (settled) return
      stage = next
      postMessage(responses.progress(next))
    }
    try {
      const dependencies = runtime.createDependencies()
      const run = await calculate(dependencies, runtime.now ? { onStage, now: runtime.now } : { onStage })
      if (run.kind !== 'result') {
        throw new Error('The calculation reported a cancellation no one requested: the Worker cancels only by being terminated.')
      }
      settle(responses.result(run.result))
    } catch (error: unknown) {
      settle(responses.error(stage, error))
    }
  }

  return {
    handleMessage: (message) => {
      const replan = isRunningPlanReplanRunMessage(message)
      const issues = replan ? runningPlanReplanRunRequestIssues(message) : buildListOptimizationRunRequestIssues(message)
      const requestId = addressableBuildListOptimizationRequestId(message)
      if (requestId === null) throw new BuildListOptimizationWorkerProtocolError(issues)
      const refuse = (code: 'invalid_request' | 'worker_already_used', text: string) => postMessage(replan
        ? { type: 'blo_replan_error', requestId, stage: null, code, domainCode: null, message: text }
        : { type: 'blo_error', requestId, stage: null, code, domainCode: null, message: text })
      if (servedRequestId !== null) {
        // The requestId already being served got (or will get) its own terminal response; a different one is refused.
        if (requestId !== servedRequestId) refuse('worker_already_used', 'This Worker serves one run only.')
        return Promise.resolve()
      }
      servedRequestId = requestId
      if (issues.length > 0) {
        refuse('invalid_request', issues.join(' '))
        return Promise.resolve()
      }
      if (replan) {
        const request = message as RunningPlanReplanWorkerRunRequest
        return runOnce(runningPlanReplanResponses(requestId), (dependencies, execution) =>
          runtime.replanCalculation({ plannerInput: request.input, replanTargets: request.replanTargets }, dependencies, execution))
      }
      const request = message as BuildListOptimizationWorkerRunRequest
      return runOnce(buildListOptimizationResponses(requestId), (dependencies, execution) =>
        runtime.calculation(request.input, dependencies, execution))
    },
  }
}

export interface BuildListOptimizationWorkerScope {
  postMessage(response: BuildListOptimizationWorkerOutgoingMessage): void
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
