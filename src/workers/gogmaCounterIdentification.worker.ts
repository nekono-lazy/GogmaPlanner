import {
  GogmaCounterIdentificationError,
  identifyGogmaCounter,
  type GogmaCounterIdentificationWorkerRequest,
  type GogmaCounterIdentificationWorkerResponse,
} from '../domain/rng/identification'
import type { RngEngine } from '../domain/rng/rngEngine'

export type GogmaCounterIdentificationWorkerPostMessage = (
  response: GogmaCounterIdentificationWorkerResponse,
) => void
export type GogmaCounterIdentificationWorkerRngEngineFactory = () => RngEngine

export interface GogmaCounterIdentificationWorkerController {
  handleMessage(request: GogmaCounterIdentificationWorkerRequest): Promise<void>
  isCancelled(requestId: string): boolean
}

interface ActiveGogmaCounterIdentificationRequest {
  cancelled: boolean
}

function workerYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Worker orchestration only; the Production Engine remains Worker-local. */
export function createGogmaCounterIdentificationWorkerController(
  engine: RngEngine,
  postMessage: GogmaCounterIdentificationWorkerPostMessage,
): GogmaCounterIdentificationWorkerController {
  const activeRequests = new Map<string, ActiveGogmaCounterIdentificationRequest>()
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
          message: `Gogma Counter identification requestId is already active: ${request.requestId}`,
          code: 'invalid_input',
          unsupportedReason: null,
        })
        return
      }

      const activeRequest: ActiveGogmaCounterIdentificationRequest = { cancelled: false }
      activeRequests.set(request.requestId, activeRequest)
      try {
        const result = await identifyGogmaCounter(request.input, engine, {
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
            type: 'gogma_counter_identification_result',
            requestId: request.requestId,
            result,
          })
        }
      } catch (error: unknown) {
        if (
          activeRequest.cancelled ||
          (error instanceof GogmaCounterIdentificationError && error.code === 'cancelled')
        ) return
        postMessage({
          type: 'error',
          requestId: request.requestId,
          message: error instanceof Error
            ? error.message
            : 'Unknown Gogma Counter identification error.',
          code: error instanceof GogmaCounterIdentificationError
            ? error.code
            : 'unexpected_error',
          unsupportedReason: error instanceof GogmaCounterIdentificationError
            ? error.unsupportedReason
            : null,
        })
      } finally {
        if (activeRequests.get(request.requestId) === activeRequest) {
          activeRequests.delete(request.requestId)
        }
      }
    },
  }
}

export interface GogmaCounterIdentificationWorkerScope {
  postMessage(response: GogmaCounterIdentificationWorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: { data: GogmaCounterIdentificationWorkerRequest }) => void,
  ): void
}

export function attachGogmaCounterIdentificationWorker(
  scope: GogmaCounterIdentificationWorkerScope,
  createEngine: GogmaCounterIdentificationWorkerRngEngineFactory,
): GogmaCounterIdentificationWorkerController {
  const controller = createGogmaCounterIdentificationWorkerController(
    createEngine(),
    (response) => scope.postMessage(response),
  )
  scope.addEventListener('message', (event) => {
    void controller.handleMessage(event.data)
  })
  return controller
}
