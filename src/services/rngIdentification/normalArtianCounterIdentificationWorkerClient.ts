import type {
  NormalArtianCounterIdentificationErrorCode,
  NormalArtianCounterIdentificationInput,
  NormalArtianCounterIdentificationProgress,
  NormalArtianCounterIdentificationResult,
  NormalArtianCounterIdentificationWorkerRequest,
  NormalArtianCounterIdentificationWorkerResponse,
} from '../../domain/rng/identification'
import type { RngPredictionUnsupportedReason } from '../../domain/rng/rngEngine'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../../domain/rng/production/productionRngEngine'

export class NormalArtianCounterIdentificationCancelledError extends Error {
  constructor() {
    super('Normal Artian Counter identification was cancelled.')
    this.name = 'NormalArtianCounterIdentificationCancelledError'
  }
}

export class NormalArtianCounterIdentificationDuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`Normal Artian Counter identification requestId is already active: ${requestId}`)
    this.name = 'NormalArtianCounterIdentificationDuplicateRequestError'
  }
}

export class NormalArtianCounterIdentificationWorkerError extends Error {
  readonly code: NormalArtianCounterIdentificationErrorCode | 'unexpected_error'
  readonly unsupportedReason: RngPredictionUnsupportedReason | null

  constructor(
    message: string,
    code: NormalArtianCounterIdentificationErrorCode | 'unexpected_error',
    unsupportedReason: RngPredictionUnsupportedReason | null,
  ) {
    super(message)
    this.name = 'NormalArtianCounterIdentificationWorkerError'
    this.code = code
    this.unsupportedReason = unsupportedReason
  }
}

export class NormalArtianCounterIdentificationWorkerUnavailableError extends Error {
  constructor() {
    super('この環境では通常アーティアCounter Identification Workerを利用できません。')
    this.name = 'NormalArtianCounterIdentificationWorkerUnavailableError'
  }
}

export interface NormalArtianCounterIdentificationWorkerClientCallbacks {
  readonly onProgress?: (progress: NormalArtianCounterIdentificationProgress) => void
}

export interface NormalArtianCounterIdentificationWorkerClient {
  readonly engineVersion: string
  identify(
    requestId: string,
    input: NormalArtianCounterIdentificationInput,
    callbacks?: NormalArtianCounterIdentificationWorkerClientCallbacks,
  ): Promise<NormalArtianCounterIdentificationResult>
  cancel(requestId: string): void
  dispose(): void
}

export interface NormalArtianCounterIdentificationWorkerLike {
  postMessage(message: NormalArtianCounterIdentificationWorkerRequest): void
  addEventListener(
    type: 'message',
    listener: (event: { data: NormalArtianCounterIdentificationWorkerResponse }) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: { data: NormalArtianCounterIdentificationWorkerResponse }) => void,
  ): void
  terminate(): void
}

interface PendingIdentification {
  readonly resolve: (result: NormalArtianCounterIdentificationResult) => void
  readonly reject: (error: Error) => void
  readonly onProgress?: (progress: NormalArtianCounterIdentificationProgress) => void
}

export function createNormalArtianCounterIdentificationWorkerClient(
  worker: NormalArtianCounterIdentificationWorkerLike,
  engineVersion: string,
): NormalArtianCounterIdentificationWorkerClient {
  const pending = new Map<string, PendingIdentification>()
  let disposed = false
  const handleMessage = ({ data }: { data: NormalArtianCounterIdentificationWorkerResponse }) => {
    const current = pending.get(data.requestId)
    if (!current) return
    if (data.type === 'progress') {
      current.onProgress?.(data.progress)
      return
    }
    pending.delete(data.requestId)
    if (data.type === 'error') {
      current.reject(new NormalArtianCounterIdentificationWorkerError(
        data.message,
        data.code,
        data.unsupportedReason,
      ))
      return
    }
    current.resolve(data.result)
  }
  worker.addEventListener('message', handleMessage)

  return {
    engineVersion,
    identify: (requestId, input, callbacks = {}) => {
      if (disposed) {
        return Promise.reject(
          new Error('Normal Artian Counter Identification Worker Client is disposed.'),
        )
      }
      if (pending.has(requestId)) {
        return Promise.reject(new NormalArtianCounterIdentificationDuplicateRequestError(requestId))
      }
      return new Promise<NormalArtianCounterIdentificationResult>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, onProgress: callbacks.onProgress })
        worker.postMessage({ type: 'identify_normal_artian_counter', requestId, input })
      })
    },
    cancel: (requestId) => {
      const current = pending.get(requestId)
      if (!current) return
      pending.delete(requestId)
      current.reject(new NormalArtianCounterIdentificationCancelledError())
      worker.postMessage({ type: 'cancel', requestId })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      pending.forEach(({ reject }) => reject(new NormalArtianCounterIdentificationCancelledError()))
      pending.clear()
      worker.removeEventListener('message', handleMessage)
      worker.terminate()
    },
  }
}

export function createUnavailableNormalArtianCounterIdentificationWorkerClient(): NormalArtianCounterIdentificationWorkerClient {
  return {
    engineVersion: 'production-engine-unavailable',
    identify: () => Promise.reject(new NormalArtianCounterIdentificationWorkerUnavailableError()),
    cancel: () => undefined,
    dispose: () => undefined,
  }
}

/**
 * The Production Client the Normal Counter Setup screen uses
 * (`docs/UI_FLOW.md` 6): `NormalCountersPage` creates one per observation
 * session and disposes it when the session ends.
 */
export function createProductionNormalArtianCounterIdentificationWorkerClient(): NormalArtianCounterIdentificationWorkerClient {
  if (typeof Worker === 'undefined') {
    return createUnavailableNormalArtianCounterIdentificationWorkerClient()
  }
  const worker = new Worker(
    new URL('../../workers/normalArtianCounterIdentification.worker.entry.ts', import.meta.url),
    { type: 'module' },
  )
  return createNormalArtianCounterIdentificationWorkerClient(
    worker as unknown as NormalArtianCounterIdentificationWorkerLike,
    PRODUCTION_RNG_ENGINE_VERSION,
  )
}
