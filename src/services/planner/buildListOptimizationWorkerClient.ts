import type { PlannerInput } from '../../domain/planner'
import type {
  BuildListOptimizationResult,
  BuildListOptimizationStage,
} from '../../domain/planner/buildListOptimization'
import {
  addressableBuildListOptimizationRequestId,
  BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION,
  buildListOptimizationWorkerResponseIssues,
  type BuildListOptimizationWorkerErrorCode,
  type BuildListOptimizationWorkerRequest,
  type BuildListOptimizationWorkerResponse,
} from '../../workers/buildListOptimizationWorkerContracts'
import { buildListOptimizationResultIssues } from './buildListOptimizationResultCheck'
import {
  createOneRunWorkerClient,
  type OneRunWorkerCancelReason,
  type OneRunWorkerClient,
  type OneRunWorkerClientOptions,
  type OneRunWorkerClientState,
  type OneRunWorkerEvent,
  type OneRunWorkerLike,
  type OneRunWorkerPageLifecycle,
  type OneRunWorkerProtocol,
  type OneRunWorkerReading,
  type OneRunWorkerRunFailure,
  type OneRunWorkerRunHandle,
  type OneRunWorkerRunObserver,
  type OneRunWorkerRunOutcome,
} from './oneRunWorkerClient'

/**
 * The main-thread Client of the dedicated Build List global optimization Worker (`docs/PLANNER_SPEC.md` 17.6 / 17.16, Issue #260
 * PR-4). It is separate from the Production Planner Worker Client, whose protocol and lifecycle it does not touch.
 *
 * Its lifecycle is the shared one-run Client lifecycle (`oneRunWorkerClient.ts`): every run gets a new Worker and a new requestId,
 * settles exactly once - completed with a `blo_result` that passed `buildListOptimizationResultIssues()`, failed, or cancelled
 * (cancel / a new run / dispose / pagehide, synchronously, the Worker terminated at once) - and nothing about a run is written to
 * storage. It sends only `blo_run` and reads only the `blo_*` responses of `build-list-optimization:1`.
 */

export type BuildListOptimizationClientState = OneRunWorkerClientState

/** Why a run ended without a result (never a result: no failure is turned into `unsupported` / `not_found`). */
export type BuildListOptimizationRunFailure = OneRunWorkerRunFailure<BuildListOptimizationWorkerErrorCode, BuildListOptimizationStage>

export type BuildListOptimizationCancelReason = OneRunWorkerCancelReason

export type BuildListOptimizationRunOutcome = OneRunWorkerRunOutcome<BuildListOptimizationResult, BuildListOptimizationRunFailure>

export type BuildListOptimizationRunObserver = OneRunWorkerRunObserver<BuildListOptimizationStage>

export type BuildListOptimizationRunHandle = OneRunWorkerRunHandle<BuildListOptimizationRunOutcome>

export type BuildListOptimizationWorkerClient = OneRunWorkerClient<PlannerInput, BuildListOptimizationStage, BuildListOptimizationRunOutcome>

/** The event shape this Client reads from a Worker (`message` carries `data`, `error` may carry `message`). */
export type BuildListOptimizationWorkerEvent = OneRunWorkerEvent

export type BuildListOptimizationWorkerLike = OneRunWorkerLike<BuildListOptimizationWorkerRequest>

/** Where `pagehide` is observed (the Browser `window`; absent in Node). */
export type BuildListOptimizationPageLifecycle = OneRunWorkerPageLifecycle

/** `createWorker()` throwing `BuildListOptimizationWorkerUnavailableError` reports `worker_unavailable`. */
export type BuildListOptimizationWorkerClientOptions = OneRunWorkerClientOptions<BuildListOptimizationWorkerRequest>

export class BuildListOptimizationWorkerUnavailableError extends Error {
  constructor() {
    super('この環境ではWeb Workerを利用できないため、作成リストの全体最適化を実行できません。')
    this.name = 'BuildListOptimizationWorkerUnavailableError'
  }
}

export class BuildListOptimizationWorkerClientDisposedError extends Error {
  constructor() {
    super('The Build List optimization Worker Client is disposed.')
    this.name = 'BuildListOptimizationWorkerClientDisposedError'
  }
}

let requestSequence = 0

/** Reads one `blo_*` message: its envelope, then a result's body (an unchecked body is never a completed run). */
function readBuildListOptimizationMessage(data: unknown): OneRunWorkerReading<BuildListOptimizationResult, BuildListOptimizationWorkerErrorCode, BuildListOptimizationStage> {
  const issues = buildListOptimizationWorkerResponseIssues(data)
  if (issues.length > 0) return { kind: 'protocol_violation', issues }
  const response = data as BuildListOptimizationWorkerResponse
  switch (response.type) {
    case 'blo_progress':
      return { kind: 'progress', stage: response.stage }
    case 'blo_result': {
      const resultIssues = buildListOptimizationResultIssues(response.result)
      return resultIssues.length > 0 ? { kind: 'invalid_result', issues: resultIssues } : { kind: 'result', result: response.result }
    }
    case 'blo_error':
      return { kind: 'calculation_error', code: response.code, domainCode: response.domainCode, stage: response.stage, message: response.message }
  }
}

const BUILD_LIST_OPTIMIZATION_CLIENT_PROTOCOL: OneRunWorkerProtocol<PlannerInput, BuildListOptimizationWorkerRequest, BuildListOptimizationResult, BuildListOptimizationWorkerErrorCode, BuildListOptimizationStage> = {
  createRequest: (requestId, input) => ({ type: 'blo_run', protocolVersion: BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION, requestId, input }),
  addresseeOf: addressableBuildListOptimizationRequestId,
  read: data => readBuildListOptimizationMessage(data),
  defaultRequestId: () => {
    requestSequence += 1
    return `build-list-optimization-run-${requestSequence}`
  },
  isWorkerUnavailableError: (error): error is Error => error instanceof BuildListOptimizationWorkerUnavailableError,
  disposedError: () => new BuildListOptimizationWorkerClientDisposedError(),
}

export function createBuildListOptimizationWorkerClient(
  options: BuildListOptimizationWorkerClientOptions,
): BuildListOptimizationWorkerClient {
  return createOneRunWorkerClient(options, BUILD_LIST_OPTIMIZATION_CLIENT_PROTOCOL)
}

/**
 * One module Worker from the dedicated Build List optimization entry, which serves both of its run requests (the Build List global
 * optimization's `blo_run` and the running Plan replan's `blo_replan_run`, Issue #276 PR-4); `unavailable()` is thrown without Web
 * Workers.
 */
export function createBuildListOptimizationEntryWorker<TRequest>(unavailable: () => Error): OneRunWorkerLike<TRequest> {
  if (typeof Worker === 'undefined') throw unavailable()
  return new Worker(
    new URL('../../workers/buildListOptimization.worker.entry.ts', import.meta.url),
    { type: 'module' },
  ) as unknown as OneRunWorkerLike<TRequest>
}

/** The Production Client: one module Worker per run from the Production entry, or `worker_unavailable` without Web Workers. */
export function createProductionBuildListOptimizationWorkerClient(): BuildListOptimizationWorkerClient {
  return createBuildListOptimizationWorkerClient({
    createWorker: () => createBuildListOptimizationEntryWorker(() => new BuildListOptimizationWorkerUnavailableError()),
  })
}
