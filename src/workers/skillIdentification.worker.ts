import {
  identifySkillSeedAndCounter,
  SkillIdentificationError,
  type SkillIdentificationWorkerRequest,
  type SkillIdentificationWorkerResponse,
} from '../domain/rng/identification'
import type { RngEngine } from '../domain/rng/rngEngine'

export type SkillIdentificationWorkerPostMessage = (
  response: SkillIdentificationWorkerResponse,
) => void
export type SkillIdentificationWorkerRngEngineFactory = () => RngEngine

export interface SkillIdentificationWorkerController {
  handleMessage(request: SkillIdentificationWorkerRequest): Promise<void>
  isCancelled(requestId: string): boolean
}

interface ActiveSkillIdentificationRequest {
  cancelled: boolean
}

function workerYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Worker orchestration only; the Production Engine remains Worker-local. */
export function createSkillIdentificationWorkerController(
  engine: RngEngine,
  postMessage: SkillIdentificationWorkerPostMessage,
): SkillIdentificationWorkerController {
  const activeRequests = new Map<string, ActiveSkillIdentificationRequest>()
  return {
    isCancelled: (requestId) => activeRequests.get(requestId)?.cancelled ?? false,
    handleMessage: async (request) => {
      if (request.type === 'cancel') {
        const activeRequest = activeRequests.get(request.requestId)
        if (activeRequest) activeRequest.cancelled = true
        return
      }

      if (activeRequests.has(request.requestId)) {
        postMessage({
          type: 'error',
          requestId: request.requestId,
          message: `Skill identification requestId is already active: ${request.requestId}`,
          code: 'invalid_input',
          unsupportedReason: null,
        })
        return
      }

      const activeRequest: ActiveSkillIdentificationRequest = { cancelled: false }
      activeRequests.set(request.requestId, activeRequest)
      try {
        const result = await identifySkillSeedAndCounter(request.input, engine, {
          shouldCancel: () => activeRequest.cancelled,
          yieldControl: workerYield,
          onProgress: (progress) => {
            if (!activeRequest.cancelled) {
              postMessage({ type: 'progress', requestId: request.requestId, progress })
            }
          },
        })
        if (!activeRequest.cancelled) {
          postMessage({
            type: 'skill_identification_result',
            requestId: request.requestId,
            result,
          })
        }
      } catch (error: unknown) {
        if (
          activeRequest.cancelled ||
          (error instanceof SkillIdentificationError && error.code === 'cancelled')
        ) {
          return
        }
        postMessage({
          type: 'error',
          requestId: request.requestId,
          message: error instanceof Error ? error.message : 'Unknown Skill identification error.',
          code: error instanceof SkillIdentificationError ? error.code : 'unexpected_error',
          unsupportedReason:
            error instanceof SkillIdentificationError ? error.unsupportedReason : null,
        })
      } finally {
        if (activeRequests.get(request.requestId) === activeRequest) {
          activeRequests.delete(request.requestId)
        }
      }
    },
  }
}

export interface SkillIdentificationWorkerScope {
  postMessage(response: SkillIdentificationWorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: { data: SkillIdentificationWorkerRequest }) => void,
  ): void
}

export function attachSkillIdentificationWorker(
  scope: SkillIdentificationWorkerScope,
  createEngine: SkillIdentificationWorkerRngEngineFactory,
): SkillIdentificationWorkerController {
  const controller = createSkillIdentificationWorkerController(
    createEngine(),
    (response) => scope.postMessage(response),
  )
  scope.addEventListener('message', (event) => {
    void controller.handleMessage(event.data)
  })
  return controller
}
