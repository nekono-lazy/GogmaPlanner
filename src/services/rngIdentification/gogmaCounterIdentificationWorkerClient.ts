import type {
  GogmaCounterIdentificationErrorCode,
  GogmaCounterIdentificationInput,
  GogmaCounterIdentificationProgress,
  GogmaCounterIdentificationResult,
  GogmaCounterIdentificationWorkerRequest,
  GogmaCounterIdentificationWorkerResponse,
} from '../../domain/rng/identification'
import type { RngPredictionUnsupportedReason } from '../../domain/rng/rngEngine'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../../domain/rng/production/productionRngEngine'

export class GogmaCounterIdentificationCancelledError extends Error {
  constructor() {
    super('Gogma Counter identification was cancelled.')
    this.name = 'GogmaCounterIdentificationCancelledError'
  }
}

export class GogmaCounterIdentificationDuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`Gogma Counter identification requestId is already active: ${requestId}`)
    this.name = 'GogmaCounterIdentificationDuplicateRequestError'
  }
}

export class GogmaCounterIdentificationWorkerError extends Error {
  readonly code: GogmaCounterIdentificationErrorCode | 'unexpected_error'
  readonly unsupportedReason: RngPredictionUnsupportedReason | null

  constructor(
    message: string,
    code: GogmaCounterIdentificationErrorCode | 'unexpected_error',
    unsupportedReason: RngPredictionUnsupportedReason | null,
  ) {
    super(message)
    this.name = 'GogmaCounterIdentificationWorkerError'
    this.code = code
    this.unsupportedReason = unsupportedReason
  }
}

export class GogmaCounterIdentificationWorkerUnavailableError extends Error {
  constructor() {
    super('この環境ではGogma Counter Identification Workerを利用できません。')
    this.name = 'GogmaCounterIdentificationWorkerUnavailableError'
  }
}

export interface GogmaCounterIdentificationWorkerClientCallbacks {
  readonly onProgress?: (progress: GogmaCounterIdentificationProgress) => void
}

export interface GogmaCounterIdentificationWorkerClient {
  readonly engineVersion: string
  identify(
    requestId: string,
    input: GogmaCounterIdentificationInput,
    callbacks?: GogmaCounterIdentificationWorkerClientCallbacks,
  ): Promise<GogmaCounterIdentificationResult>
  cancel(requestId: string): void
  dispose(): void
}

export interface GogmaCounterIdentificationWorkerLike {
  postMessage(message: GogmaCounterIdentificationWorkerRequest): void
  addEventListener(
    type: 'message',
    listener: (event: { data: GogmaCounterIdentificationWorkerResponse }) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: { data: GogmaCounterIdentificationWorkerResponse }) => void,
  ): void
  terminate(): void
}

interface PendingIdentification {
  readonly resolve: (result: GogmaCounterIdentificationResult) => void
  readonly reject: (error: Error) => void
  readonly onProgress?: (progress: GogmaCounterIdentificationProgress) => void
}

export function createGogmaCounterIdentificationWorkerClient(
  worker: GogmaCounterIdentificationWorkerLike,
  engineVersion: string,
): GogmaCounterIdentificationWorkerClient {
  const pending = new Map<string, PendingIdentification>()
  let disposed = false
  const handleMessage = ({ data }: { data: GogmaCounterIdentificationWorkerResponse }) => {
    const current = pending.get(data.requestId)
    if (!current) return
    if (data.type === 'progress') {
      current.onProgress?.(data.progress)
      return
    }
    pending.delete(data.requestId)
    if (data.type === 'error') {
      current.reject(new GogmaCounterIdentificationWorkerError(
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
        return Promise.reject(new Error('Gogma Counter Identification Worker Client is disposed.'))
      }
      if (pending.has(requestId)) {
        return Promise.reject(new GogmaCounterIdentificationDuplicateRequestError(requestId))
      }
      return new Promise<GogmaCounterIdentificationResult>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, onProgress: callbacks.onProgress })
        worker.postMessage({ type: 'identify_gogma_counter', requestId, input })
      })
    },
    cancel: (requestId) => {
      const current = pending.get(requestId)
      if (!current) return
      pending.delete(requestId)
      current.reject(new GogmaCounterIdentificationCancelledError())
      worker.postMessage({ type: 'cancel', requestId })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      pending.forEach(({ reject }) => reject(new GogmaCounterIdentificationCancelledError()))
      pending.clear()
      worker.removeEventListener('message', handleMessage)
      worker.terminate()
    },
  }
}

export function createUnavailableGogmaCounterIdentificationWorkerClient(): GogmaCounterIdentificationWorkerClient {
  return {
    engineVersion: 'production-engine-unavailable',
    identify: () => Promise.reject(new GogmaCounterIdentificationWorkerUnavailableError()),
    cancel: () => undefined,
    dispose: () => undefined,
  }
}

/** Foundation only; no Production UI calls this factory in C5-E2B2. */
export function createProductionGogmaCounterIdentificationWorkerClient(): GogmaCounterIdentificationWorkerClient {
  if (typeof Worker === 'undefined') {
    return createUnavailableGogmaCounterIdentificationWorkerClient()
  }
  const worker = new Worker(
    new URL('../../workers/gogmaCounterIdentification.worker.entry.ts', import.meta.url),
    { type: 'module' },
  )
  return createGogmaCounterIdentificationWorkerClient(
    worker as unknown as GogmaCounterIdentificationWorkerLike,
    PRODUCTION_RNG_ENGINE_VERSION,
  )
}
