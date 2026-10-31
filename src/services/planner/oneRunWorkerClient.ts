/**
 * The main-thread lifecycle of a one-run Worker Client, shared by the two run requests of the dedicated Build List optimization
 * Worker (`docs/PLANNER_SPEC.md` 17.6 / 17.16 / 18.6): the Build List global optimization (`blo_run`, Issue #260 PR-4) and the running
 * Plan replan re-optimization (`blo_replan_run`, Issue #276 PR-4). Each request kind supplies its protocol (how a request is built and
 * how a message of its own is read); the lifecycle below is the same for both and touches no other Worker Client.
 *
 * Every run gets a new Worker and a new requestId:
 *
 *   idle ─run─▶ running ─result (checked)──────────────────────────────────▶ completed ─▶ Worker terminated
 *                  │  ├─result (check failed) / error response / error / messageerror ─▶ failed
 *                  │  └─cancel / a new run / dispose / pagehide ─────────────────▶ cancelled (synchronously, Worker terminated at once)
 *
 * A run settles exactly once, and its Worker is terminated right then: no cancel message, acknowledgement or cooperative stop is
 * waited for, so a Worker inside a long synchronous stretch is stopped from the main thread too. After a run settled, no message of
 * its Worker is applied, and a message naming another requestId is never applied to the current run. A run is never restarted, no
 * wall-clock timeout ends one, and nothing about a run is written to storage.
 */

export type OneRunWorkerClientState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'disposed'

/** Why a run ended without a result (never a result: no failure is turned into `unsupported` / `not_found`). */
export type OneRunWorkerRunFailure<TErrorCode extends string, TStage extends string> =
  /** This environment has no Web Worker: the calculation never runs on the main thread instead. */
  | { kind: 'worker_unavailable'; message: string }
  /** Creating the Worker or posting the request threw. */
  | { kind: 'worker_start_failed'; message: string }
  /** The Worker answered with its error response (the calculation failed or refused to run). */
  | { kind: 'calculation_error'; code: TErrorCode; domainCode: string | null; stage: TStage | null; message: string }
  /** The Worker's `error` event. Its cause is not presumed (in particular, never declared to be a lack of memory). */
  | { kind: 'worker_error'; message: string | null }
  /** The Worker's `messageerror` event. */
  | { kind: 'worker_message_error' }
  /** A message for this run broke the protocol. */
  | { kind: 'protocol_violation'; issues: string[] }
  /** A result whose body failed the main thread's structural check: it is never shown. */
  | { kind: 'invalid_result'; issues: string[] }

export type OneRunWorkerCancelReason =
  /** `cancel()` on the run or the Client (the screen's cancel, a route change, an unmount). */
  | 'cancelled'
  /** A new run started while this one was running. */
  | 'superseded'
  /** The Client was disposed. */
  | 'disposed'
  /** The page was hidden (`pagehide`). */
  | 'page_hidden'

export type OneRunWorkerRunOutcome<TResult, TFailure> =
  | { status: 'completed'; requestId: string; result: TResult }
  | { status: 'failed'; requestId: string; failure: TFailure }
  | { status: 'cancelled'; requestId: string; reason: OneRunWorkerCancelReason }

export interface OneRunWorkerRunObserver<TStage extends string> {
  /** The stage the calculation entered (a stage name only: no rate, count or remaining time exists to report). */
  onStage?(stage: TStage): void
}

export interface OneRunWorkerRunHandle<TOutcome> {
  readonly requestId: string
  /** Settles exactly once and never rejects. */
  readonly outcome: Promise<TOutcome>
  /** Cancels this run if it is still running (synchronously; the Worker is terminated at once). */
  cancel(): void
}

export interface OneRunWorkerClient<TInput, TStage extends string, TOutcome> {
  /** Starts a run on a new Worker; a run still running is cancelled first (`superseded`). Throws after `dispose()`. */
  run(input: TInput, observer?: OneRunWorkerRunObserver<TStage>): OneRunWorkerRunHandle<TOutcome>
  /** Cancels the current run, if any. */
  cancel(): void
  /** Cancels the current run and refuses every later run. */
  dispose(): void
  getState(): OneRunWorkerClientState
}

/** The event shape this Client reads from a Worker (`message` carries `data`, `error` may carry `message`). */
export interface OneRunWorkerEvent {
  data?: unknown
  message?: unknown
}

export interface OneRunWorkerLike<TRequest> {
  postMessage(message: TRequest): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: OneRunWorkerEvent) => void): void
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: OneRunWorkerEvent) => void): void
  terminate(): void
}

/** Where `pagehide` is observed (the Browser `window`; absent in Node). */
export interface OneRunWorkerPageLifecycle {
  addEventListener(type: 'pagehide', listener: () => void): void
  removeEventListener(type: 'pagehide', listener: () => void): void
}

export interface OneRunWorkerClientOptions<TRequest> {
  /** Creates the Worker of one run. Throwing the protocol's unavailable error reports `worker_unavailable`. */
  createWorker(): OneRunWorkerLike<TRequest>
  /** Mints the requestId of one run (a non-empty string). */
  createRequestId?: () => string
  /** `pagehide` source; defaults to `window` where it exists, and to none otherwise. */
  pageLifecycle?: OneRunWorkerPageLifecycle | null
}

/** What one message addressed to the run says, as its protocol reads it. */
export type OneRunWorkerReading<TResult, TErrorCode extends string, TStage extends string> =
  | { kind: 'progress'; stage: TStage }
  /** A result whose body passed the protocol's structural check. */
  | { kind: 'result'; result: TResult }
  | Extract<OneRunWorkerRunFailure<TErrorCode, TStage>, { kind: 'calculation_error' | 'protocol_violation' | 'invalid_result' }>

/** The request-kind specific half of a Client. */
export interface OneRunWorkerProtocol<TInput, TRequest, TResult, TErrorCode extends string, TStage extends string> {
  createRequest(requestId: string, input: TInput): TRequest
  /** The requestId a message validly names, or null when it names none. */
  addresseeOf(data: unknown): string | null
  /** Reads one message addressed to the run (or to nobody), knowing the input the run was started with. */
  read(data: unknown, input: TInput): OneRunWorkerReading<TResult, TErrorCode, TStage>
  /** A per-run requestId: each run has its own Worker, so it only has to differ from the Client's earlier runs. */
  defaultRequestId(): string
  /** True for the error `createWorker()` throws when this environment has no Web Worker. */
  isWorkerUnavailableError(error: unknown): error is Error
  /** The error `run()` throws after `dispose()`. */
  disposedError(): Error
}

function defaultPageLifecycle(): OneRunWorkerPageLifecycle | null {
  return typeof window === 'undefined' ? null : window
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ActiveRun<TInput, TStage extends string, TOutcome> {
  readonly requestId: string
  readonly input: TInput
  readonly observer: OneRunWorkerRunObserver<TStage> | undefined
  readonly resolve: (outcome: TOutcome) => void
  worker: { terminate(): void } | null
  detach: () => void
  settled: boolean
}

export function createOneRunWorkerClient<TInput, TRequest, TResult, TErrorCode extends string, TStage extends string>(
  options: OneRunWorkerClientOptions<TRequest>,
  protocol: OneRunWorkerProtocol<TInput, TRequest, TResult, TErrorCode, TStage>,
): OneRunWorkerClient<TInput, TStage, OneRunWorkerRunOutcome<TResult, OneRunWorkerRunFailure<TErrorCode, TStage>>> {
  type Failure = OneRunWorkerRunFailure<TErrorCode, TStage>
  type Outcome = OneRunWorkerRunOutcome<TResult, Failure>
  type Run = ActiveRun<TInput, TStage, Outcome>
  const createRequestId = options.createRequestId ?? (() => protocol.defaultRequestId())
  const pageLifecycle = options.pageLifecycle === undefined ? defaultPageLifecycle() : options.pageLifecycle
  let current: Run | null = null
  let state: OneRunWorkerClientState = 'idle'
  let disposed = false

  /** The one place a run ends: state first, then the Worker is terminated and released, then the outcome is delivered. */
  const settle = (run: Run, outcome: Outcome) => {
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
  const fail = (run: Run, failure: Failure) => settle(run, { status: 'failed', requestId: run.requestId, failure })
  const cancelRun = (run: Run, reason: OneRunWorkerCancelReason) => settle(run, { status: 'cancelled', requestId: run.requestId, reason })

  const receive = (run: Run, data: unknown) => {
    if (run.settled || current !== run) return
    // Only a message validly addressed to another request is stale and ignored. A message this run's Worker sent with no valid
    // requestId (not an object, no requestId, a null / empty / non-string one) is addressed to nobody: with no timeout to end the
    // run, ignoring it could leave the run waiting forever, so it fails the run below like any other protocol violation.
    const addressee = protocol.addresseeOf(data)
    if (addressee !== null && addressee !== run.requestId) return
    const reading = protocol.read(data, run.input)
    switch (reading.kind) {
      case 'progress':
        run.observer?.onStage?.(reading.stage)
        return
      case 'result':
        settle(run, { status: 'completed', requestId: run.requestId, result: reading.result })
        return
      default:
        fail(run, reading)
    }
  }

  return {
    run: (input, observer) => {
      if (disposed) throw protocol.disposedError()
      if (current !== null) cancelRun(current, 'superseded')
      const requestId = createRequestId()
      if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('A one-run Worker requestId must be a non-empty string.')
      let resolve!: (outcome: Outcome) => void
      const outcome = new Promise<Outcome>((settleOutcome) => {
        resolve = settleOutcome
      })
      const run: Run = { requestId, input, observer, resolve, worker: null, detach: () => undefined, settled: false }
      const handle: OneRunWorkerRunHandle<Outcome> = { requestId, outcome, cancel: () => cancelRun(run, 'cancelled') }
      current = run
      state = 'running'

      let worker: OneRunWorkerLike<TRequest>
      try {
        worker = options.createWorker()
      } catch (error: unknown) {
        fail(run, protocol.isWorkerUnavailableError(error)
          ? { kind: 'worker_unavailable', message: error.message }
          : { kind: 'worker_start_failed', message: messageOf(error) })
        return handle
      }
      run.worker = worker
      const onMessage = (event: OneRunWorkerEvent) => receive(run, event.data)
      const onError = (event: OneRunWorkerEvent) =>
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
        worker.postMessage(protocol.createRequest(requestId, input))
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
