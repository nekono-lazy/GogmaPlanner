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

/**
 * The main-thread Client of the dedicated Build List global optimization Worker (`docs/PLANNER_SPEC.md` 17.6 / 17.16, Issue #260
 * PR-4). It is separate from the Production Planner Worker Client, whose protocol and lifecycle it does not touch.
 *
 * Every run gets a new Worker and a new requestId:
 *
 *   idle ─run─▶ running ─blo_result (checked)──────────────────────────────▶ completed ─▶ Worker terminated
 *                  │  ├─blo_result (check failed) / blo_error / error / messageerror ─▶ failed
 *                  │  └─cancel / a new run / dispose / pagehide ─────────────────▶ cancelled (synchronously, Worker terminated at once)
 *
 * A run settles exactly once, and its Worker is terminated right then: no cancel message, acknowledgement or cooperative stop is
 * waited for, so a Worker inside a long synchronous stretch is stopped from the main thread too. After a run settled, no message of
 * its Worker is applied, and a message naming another requestId is never applied to the current run. A run is never restarted, no
 * wall-clock timeout ends one, and nothing about a run is written to storage.
 */

export type BuildListOptimizationClientState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'disposed'

/** Why a run ended without a result (never a result: no failure is turned into `unsupported` / `not_found`). */
export type BuildListOptimizationRunFailure =
  /** This environment has no Web Worker: the calculation never runs on the main thread instead. */
  | { kind: 'worker_unavailable'; message: string }
  /** Creating the Worker or posting the request threw. */
  | { kind: 'worker_start_failed'; message: string }
  /** The Worker answered with `blo_error` (the calculation failed or refused to run). */
  | { kind: 'calculation_error'; code: BuildListOptimizationWorkerErrorCode; domainCode: string | null; stage: BuildListOptimizationStage | null; message: string }
  /** The Worker's `error` event. Its cause is not presumed (in particular, never declared to be a lack of memory). */
  | { kind: 'worker_error'; message: string | null }
  /** The Worker's `messageerror` event. */
  | { kind: 'worker_message_error' }
  /** A message for this run broke the protocol. */
  | { kind: 'protocol_violation'; issues: string[] }
  /** A `blo_result` whose body failed the main thread's structural check: it is never shown. */
  | { kind: 'invalid_result'; issues: string[] }

export type BuildListOptimizationCancelReason =
  /** `cancel()` on the run or the Client (the screen's cancel, a route change, an unmount). */
  | 'cancelled'
  /** A new run started while this one was running. */
  | 'superseded'
  /** The Client was disposed. */
  | 'disposed'
  /** The page was hidden (`pagehide`). */
  | 'page_hidden'

export type BuildListOptimizationRunOutcome =
  | { status: 'completed'; requestId: string; result: BuildListOptimizationResult }
  | { status: 'failed'; requestId: string; failure: BuildListOptimizationRunFailure }
  | { status: 'cancelled'; requestId: string; reason: BuildListOptimizationCancelReason }

export interface BuildListOptimizationRunObserver {
  /** The stage the calculation entered (a stage name only: no rate, count or remaining time exists to report). */
  onStage?(stage: BuildListOptimizationStage): void
}

export interface BuildListOptimizationRunHandle {
  readonly requestId: string
  /** Settles exactly once and never rejects. */
  readonly outcome: Promise<BuildListOptimizationRunOutcome>
  /** Cancels this run if it is still running (synchronously; the Worker is terminated at once). */
  cancel(): void
}

export interface BuildListOptimizationWorkerClient {
  /** Starts a run on a new Worker; a run still running is cancelled first (`superseded`). Throws after `dispose()`. */
  run(input: PlannerInput, observer?: BuildListOptimizationRunObserver): BuildListOptimizationRunHandle
  /** Cancels the current run, if any. */
  cancel(): void
  /** Cancels the current run and refuses every later run. */
  dispose(): void
  getState(): BuildListOptimizationClientState
}

/** The event shape this Client reads from a Worker (`message` carries `data`, `error` may carry `message`). */
export interface BuildListOptimizationWorkerEvent {
  data?: unknown
  message?: unknown
}

export interface BuildListOptimizationWorkerLike {
  postMessage(message: BuildListOptimizationWorkerRequest): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: BuildListOptimizationWorkerEvent) => void): void
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: BuildListOptimizationWorkerEvent) => void): void
  terminate(): void
}

/** Where `pagehide` is observed (the Browser `window`; absent in Node). */
export interface BuildListOptimizationPageLifecycle {
  addEventListener(type: 'pagehide', listener: () => void): void
  removeEventListener(type: 'pagehide', listener: () => void): void
}

export interface BuildListOptimizationWorkerClientOptions {
  /** Creates the Worker of one run. Throwing `BuildListOptimizationWorkerUnavailableError` reports `worker_unavailable`. */
  createWorker(): BuildListOptimizationWorkerLike
  /** Mints the requestId of one run (a non-empty string). */
  createRequestId?: () => string
  /** `pagehide` source; defaults to `window` where it exists, and to none otherwise. */
  pageLifecycle?: BuildListOptimizationPageLifecycle | null
}

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

/** A per-run requestId. Each run has its own Worker, so it only has to differ from the Client's earlier runs. */
function defaultRequestId(): string {
  requestSequence += 1
  return `build-list-optimization-run-${requestSequence}`
}

function defaultPageLifecycle(): BuildListOptimizationPageLifecycle | null {
  return typeof window === 'undefined' ? null : window
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ActiveRun {
  readonly requestId: string
  readonly observer: BuildListOptimizationRunObserver | undefined
  readonly resolve: (outcome: BuildListOptimizationRunOutcome) => void
  worker: BuildListOptimizationWorkerLike | null
  detach: () => void
  settled: boolean
}

export function createBuildListOptimizationWorkerClient(
  options: BuildListOptimizationWorkerClientOptions,
): BuildListOptimizationWorkerClient {
  const createRequestId = options.createRequestId ?? defaultRequestId
  const pageLifecycle = options.pageLifecycle === undefined ? defaultPageLifecycle() : options.pageLifecycle
  let current: ActiveRun | null = null
  let state: BuildListOptimizationClientState = 'idle'
  let disposed = false

  /** The one place a run ends: state first, then the Worker is terminated and released, then the outcome is delivered. */
  const settle = (run: ActiveRun, outcome: BuildListOptimizationRunOutcome) => {
    if (run.settled) return
    run.settled = true
    if (current === run) {
      current = null
      state = disposed ? 'disposed' : outcome.status
    }
    run.detach()
    const worker = run.worker
    run.worker = null
    worker?.terminate()
    run.resolve(outcome)
  }
  const fail = (run: ActiveRun, failure: BuildListOptimizationRunFailure) =>
    settle(run, { status: 'failed', requestId: run.requestId, failure })
  const cancelRun = (run: ActiveRun, reason: BuildListOptimizationCancelReason) =>
    settle(run, { status: 'cancelled', requestId: run.requestId, reason })

  const receive = (run: ActiveRun, data: unknown) => {
    if (run.settled || current !== run) return
    // Only a message validly addressed to another request is stale and ignored. A message this run's Worker sent with no valid
    // requestId (not an object, no requestId, a null / empty / non-string one) is addressed to nobody: with no timeout to end the
    // run, ignoring it could leave the run waiting forever, so it fails the run below like any other protocol violation.
    const addressee = addressableBuildListOptimizationRequestId(data)
    if (addressee !== null && addressee !== run.requestId) return
    const issues = buildListOptimizationWorkerResponseIssues(data)
    if (issues.length > 0) {
      fail(run, { kind: 'protocol_violation', issues })
      return
    }
    const response = data as BuildListOptimizationWorkerResponse
    switch (response.type) {
      case 'blo_progress':
        run.observer?.onStage?.(response.stage)
        return
      case 'blo_result': {
        const resultIssues = buildListOptimizationResultIssues(response.result)
        if (resultIssues.length > 0) fail(run, { kind: 'invalid_result', issues: resultIssues })
        else settle(run, { status: 'completed', requestId: run.requestId, result: response.result })
        return
      }
      case 'blo_error':
        fail(run, { kind: 'calculation_error', code: response.code, domainCode: response.domainCode, stage: response.stage, message: response.message })
        return
    }
  }

  return {
    run: (input, observer) => {
      if (disposed) throw new BuildListOptimizationWorkerClientDisposedError()
      if (current !== null) cancelRun(current, 'superseded')
      const requestId = createRequestId()
      if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('A Build List optimization requestId must be a non-empty string.')
      let resolve!: (outcome: BuildListOptimizationRunOutcome) => void
      const outcome = new Promise<BuildListOptimizationRunOutcome>((settleOutcome) => {
        resolve = settleOutcome
      })
      const run: ActiveRun = { requestId, observer, resolve, worker: null, detach: () => undefined, settled: false }
      const handle: BuildListOptimizationRunHandle = { requestId, outcome, cancel: () => cancelRun(run, 'cancelled') }
      current = run
      state = 'running'

      let worker: BuildListOptimizationWorkerLike
      try {
        worker = options.createWorker()
      } catch (error: unknown) {
        fail(run, error instanceof BuildListOptimizationWorkerUnavailableError
          ? { kind: 'worker_unavailable', message: error.message }
          : { kind: 'worker_start_failed', message: messageOf(error) })
        return handle
      }
      run.worker = worker
      const onMessage = (event: BuildListOptimizationWorkerEvent) => receive(run, event.data)
      const onError = (event: BuildListOptimizationWorkerEvent) =>
        fail(run, { kind: 'worker_error', message: typeof event.message === 'string' && event.message.length > 0 ? event.message : null })
      const onMessageError = () => fail(run, { kind: 'worker_message_error' })
      const onPageHide = () => cancelRun(run, 'page_hidden')
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', onMessageError)
      pageLifecycle?.addEventListener('pagehide', onPageHide)
      run.detach = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        worker.removeEventListener('messageerror', onMessageError)
        pageLifecycle?.removeEventListener('pagehide', onPageHide)
      }
      try {
        worker.postMessage({ type: 'blo_run', protocolVersion: BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION, requestId, input })
      } catch (error: unknown) {
        fail(run, { kind: 'worker_start_failed', message: messageOf(error) })
      }
      return handle
    },
    cancel: () => {
      if (current !== null) cancelRun(current, 'cancelled')
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (current !== null) cancelRun(current, 'disposed')
      state = 'disposed'
    },
    getState: () => state,
  }
}

/** The Production Client: one module Worker per run from the Production entry, or `worker_unavailable` without Web Workers. */
export function createProductionBuildListOptimizationWorkerClient(): BuildListOptimizationWorkerClient {
  return createBuildListOptimizationWorkerClient({
    createWorker: () => {
      if (typeof Worker === 'undefined') throw new BuildListOptimizationWorkerUnavailableError()
      return new Worker(
        new URL('../../workers/buildListOptimization.worker.entry.ts', import.meta.url),
        { type: 'module' },
      ) as unknown as BuildListOptimizationWorkerLike
    },
  })
}
