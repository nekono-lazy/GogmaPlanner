import type {
  SkillIdentificationErrorCode,
  SkillIdentificationInput,
  SkillIdentificationProgress,
  SkillIdentificationResult,
  SkillIdentificationWorkerRequest,
  SkillIdentificationWorkerResponse,
} from '../../domain/rng/identification'
import type { RngPredictionUnsupportedReason } from '../../domain/rng/rngEngine'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../../domain/rng/production/productionRngEngine'

export class SkillIdentificationCancelledError extends Error {
  constructor() {
    super('Skill identification was cancelled.')
    this.name = 'SkillIdentificationCancelledError'
  }
}

export class SkillIdentificationDuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`Skill identification requestId is already active: ${requestId}`)
    this.name = 'SkillIdentificationDuplicateRequestError'
  }
}

export class SkillIdentificationWorkerError extends Error {
  readonly code: SkillIdentificationErrorCode | 'unexpected_error'
  readonly unsupportedReason: RngPredictionUnsupportedReason | null

  constructor(
    message: string,
    code: SkillIdentificationErrorCode | 'unexpected_error',
    unsupportedReason: RngPredictionUnsupportedReason | null,
  ) {
    super(message)
    this.name = 'SkillIdentificationWorkerError'
    this.code = code
    this.unsupportedReason = unsupportedReason
  }
}

export class SkillIdentificationWorkerUnavailableError extends Error {
  constructor() {
    super('この環境ではSkill Identification Workerを利用できません。')
    this.name = 'SkillIdentificationWorkerUnavailableError'
  }
}

export interface SkillIdentificationWorkerClientCallbacks {
  readonly onProgress?: (progress: SkillIdentificationProgress) => void
}

export interface SkillIdentificationWorkerClient {
  readonly engineVersion: string
  identify(
    requestId: string,
    input: SkillIdentificationInput,
    callbacks?: SkillIdentificationWorkerClientCallbacks,
  ): Promise<SkillIdentificationResult>
  cancel(requestId: string): void
  dispose(): void
}

export interface SkillIdentificationWorkerLike {
  postMessage(message: SkillIdentificationWorkerRequest): void
  addEventListener(
    type: 'message',
    listener: (event: { data: SkillIdentificationWorkerResponse }) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: { data: SkillIdentificationWorkerResponse }) => void,
  ): void
  terminate(): void
}

interface PendingIdentification {
  readonly resolve: (result: SkillIdentificationResult) => void
  readonly reject: (error: Error) => void
  readonly onProgress?: (progress: SkillIdentificationProgress) => void
}

export function createSkillIdentificationWorkerClient(
  worker: SkillIdentificationWorkerLike,
  engineVersion: string,
): SkillIdentificationWorkerClient {
  const pending = new Map<string, PendingIdentification>()
  let disposed = false

  const handleMessage = ({ data }: { data: SkillIdentificationWorkerResponse }) => {
    const current = pending.get(data.requestId)
    if (!current) return
    if (data.type === 'progress') {
      current.onProgress?.(data.progress)
      return
    }
    pending.delete(data.requestId)
    if (data.type === 'error') {
      current.reject(
        new SkillIdentificationWorkerError(
          data.message,
          data.code,
          data.unsupportedReason,
        ),
      )
      return
    }
    current.resolve(data.result)
  }
  worker.addEventListener('message', handleMessage)

  return {
    engineVersion,
    identify: (requestId, input, callbacks = {}) => {
      if (disposed) {
        return Promise.reject(new Error('Skill Identification Worker Client is disposed.'))
      }
      if (pending.has(requestId)) {
        return Promise.reject(new SkillIdentificationDuplicateRequestError(requestId))
      }
      return new Promise<SkillIdentificationResult>((resolve, reject) => {
        pending.set(requestId, {
          resolve,
          reject,
          onProgress: callbacks.onProgress,
        })
        worker.postMessage({ type: 'identify_skill_seed_counter', requestId, input })
      })
    },
    cancel: (requestId) => {
      const current = pending.get(requestId)
      if (!current) return
      pending.delete(requestId)
      current.reject(new SkillIdentificationCancelledError())
      worker.postMessage({ type: 'cancel', requestId })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      pending.forEach(({ reject }) => reject(new SkillIdentificationCancelledError()))
      pending.clear()
      worker.removeEventListener('message', handleMessage)
      worker.terminate()
    },
  }
}

export function createUnavailableSkillIdentificationWorkerClient(): SkillIdentificationWorkerClient {
  return {
    engineVersion: 'production-engine-unavailable',
    identify: () => Promise.reject(new SkillIdentificationWorkerUnavailableError()),
    cancel: () => undefined,
    dispose: () => undefined,
  }
}

/** Foundation only; no Production UI calls this factory in C5-E2B1. */
export function createProductionSkillIdentificationWorkerClient(): SkillIdentificationWorkerClient {
  if (typeof Worker === 'undefined') {
    return createUnavailableSkillIdentificationWorkerClient()
  }
  const worker = new Worker(
    new URL('../../workers/skillIdentification.worker.entry.ts', import.meta.url),
    { type: 'module' },
  )
  return createSkillIdentificationWorkerClient(
    worker as unknown as SkillIdentificationWorkerLike,
    PRODUCTION_RNG_ENGINE_VERSION,
  )
}
