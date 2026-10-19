import type {
  CandidateSearchInput,
  CandidateSearchProgress,
  CandidateSearchResult,
  SearchWorkerRequest,
  SearchWorkerResponse,
} from '../../domain/search'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../../domain/rng/production/productionRngEngine'

export class SearchCancelledError extends Error {
  constructor() {
    super('Candidate search was cancelled.')
    this.name = 'SearchCancelledError'
  }
}

export class ProductionRngEngineUnavailableError extends Error {
  constructor() {
    super('この環境ではSearch Workerを利用できないため、現在は実検索を開始できません。')
    this.name = 'ProductionRngEngineUnavailableError'
  }
}

/**
 * A native Worker `error` / `messageerror` event, which is separate from the
 * `type: 'error'` Worker protocol response. The protocol response reports a
 * handled search failure and leaves the Worker usable; a native event means the
 * Worker itself is broken, so this client fails closed and never reuses it.
 */
export type SearchWorkerRuntimeErrorCode = 'worker_error' | 'worker_message_error'

export class SearchWorkerRuntimeError extends Error {
  readonly code: SearchWorkerRuntimeErrorCode
  readonly detail: string | null

  constructor(code: SearchWorkerRuntimeErrorCode, detail: string | null = null) {
    super(
      'Search Workerでエラーが発生したため検索を続行できません。ページを再読み込みしてください。',
    )
    this.name = 'SearchWorkerRuntimeError'
    this.code = code
    this.detail = detail
  }
}

export interface SearchWorkerNativeErrorEvent {
  message?: unknown
}

export interface SearchWorkerClientCallbacks {
  onProgress?: (progress: CandidateSearchProgress) => void
}

export interface SearchWorkerClient {
  readonly engineVersion: string
  startSearch: (
    input: CandidateSearchInput,
    callbacks?: SearchWorkerClientCallbacks,
  ) => Promise<CandidateSearchResult>
  cancelSearch: (requestId: string) => void
  dispose: () => void
}

export interface SearchWorkerEventListenerMap {
  message: (event: { data: SearchWorkerResponse }) => void
  error: (event: SearchWorkerNativeErrorEvent) => void
  messageerror: (event: SearchWorkerNativeErrorEvent) => void
}

export interface WorkerLike {
  postMessage(message: SearchWorkerRequest): void
  addEventListener<K extends keyof SearchWorkerEventListenerMap>(
    type: K,
    listener: SearchWorkerEventListenerMap[K],
  ): void
  removeEventListener<K extends keyof SearchWorkerEventListenerMap>(
    type: K,
    listener: SearchWorkerEventListenerMap[K],
  ): void
  terminate(): void
}

interface PendingSearch {
  resolve: (result: CandidateSearchResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: CandidateSearchProgress) => void
}

export function createSearchWorkerClient(
  worker: WorkerLike,
  engineVersion: string,
): SearchWorkerClient {
  const pending = new Map<string, PendingSearch>()
  let disposed = false
  let runtimeFailure: SearchWorkerRuntimeError | null = null

  const handleMessage = ({ data }: { data: SearchWorkerResponse }) => {
    const current = pending.get(data.requestId)
    if (!current) return
    if (data.type === 'progress') {
      current.onProgress?.({
        targetWeaponId: data.targetWeaponId,
        phase: data.phase,
        processedWorkItems: data.processedWorkItems,
      })
      return
    }
    pending.delete(data.requestId)
    if (data.type === 'error') {
      current.reject(new Error(data.message))
      return
    }
    current.resolve(data.result)
  }

  const detach = () => {
    worker.removeEventListener('message', handleMessage)
    worker.removeEventListener('error', handleError)
    worker.removeEventListener('messageerror', handleMessageError)
  }

  /**
   * Fail closed: reject every pending search, drop the listeners, terminate the
   * broken Worker, and refuse later searches. No automatic Worker re-creation
   * or page reload happens here.
   */
  const failClosed = (
    code: SearchWorkerRuntimeErrorCode,
    event: SearchWorkerNativeErrorEvent,
  ) => {
    if (runtimeFailure !== null || disposed) return
    const failure = new SearchWorkerRuntimeError(
      code,
      typeof event?.message === 'string' ? event.message : null,
    )
    runtimeFailure = failure
    disposed = true
    pending.forEach(({ reject }) => reject(failure))
    pending.clear()
    detach()
    worker.terminate()
  }

  function handleError(event: SearchWorkerNativeErrorEvent) {
    failClosed('worker_error', event)
  }
  function handleMessageError(event: SearchWorkerNativeErrorEvent) {
    failClosed('worker_message_error', event)
  }

  worker.addEventListener('message', handleMessage)
  worker.addEventListener('error', handleError)
  worker.addEventListener('messageerror', handleMessageError)

  return {
    engineVersion,
    startSearch: (input, callbacks = {}) => {
      if (runtimeFailure !== null) return Promise.reject(runtimeFailure)
      if (disposed) return Promise.reject(new Error('Search Worker Client is disposed.'))
      const requestId = input.searchRunId
      const existing = pending.get(requestId)
      existing?.reject(new SearchCancelledError())
      pending.delete(requestId)
      return new Promise<CandidateSearchResult>((resolve, reject) => {
        pending.set(requestId, {
          resolve,
          reject,
          onProgress: callbacks.onProgress,
        })
        worker.postMessage({ type: 'candidate_search', requestId, input })
      })
    },
    cancelSearch: (requestId) => {
      const current = pending.get(requestId)
      if (!current) return
      pending.delete(requestId)
      current.reject(new SearchCancelledError())
      worker.postMessage({ type: 'cancel', requestId })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      pending.forEach(({ reject }) => reject(new SearchCancelledError()))
      pending.clear()
      detach()
      worker.terminate()
    },
  }
}

export function createUnavailableSearchWorkerClient(): SearchWorkerClient {
  return {
    engineVersion: 'production-engine-unavailable',
    startSearch: () => Promise.reject(new ProductionRngEngineUnavailableError()),
    cancelSearch: () => undefined,
    dispose: () => undefined,
  }
}

export function createProductionSearchWorkerClient(): SearchWorkerClient {
  if (typeof Worker === 'undefined') return createUnavailableSearchWorkerClient()
  const worker = new Worker(
    new URL('../../workers/search.worker.entry.ts', import.meta.url),
    { type: 'module' },
  )
  return createSearchWorkerClient(
    worker as unknown as WorkerLike,
    PRODUCTION_RNG_ENGINE_VERSION,
  )
}
