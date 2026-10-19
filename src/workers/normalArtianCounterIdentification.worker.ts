import {
  NormalArtianCounterIdentificationError,
  identifyNormalArtianCounter,
  type NormalArtianCounterIdentificationWorkerRequest,
  type NormalArtianCounterIdentificationWorkerResponse,
} from '../domain/rng/identification'
import type { RngEngine } from '../domain/rng/rngEngine'

export type NormalArtianCounterIdentificationWorkerPostMessage = (
  response: NormalArtianCounterIdentificationWorkerResponse,
) => void
export type NormalArtianCounterIdentificationWorkerRngEngineFactory = () => RngEngine

export interface NormalArtianCounterIdentificationWorkerController {
  handleMessage(request: NormalArtianCounterIdentificationWorkerRequest): Promise<void>
  isCancelled(requestId: string): boolean
}

interface ActiveNormalArtianCounterIdentificationRequest {
  cancelled: boolean
}

/**
 * A macrotask yield between Counter chunks. `Promise.resolve()` would keep the
 * Worker event loop occupied, so a pending `cancel` message could never be
 * dispatched mid-search.
 */
function workerYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Worker orchestration only; the Production Engine remains Worker-local. */
export function createNormalArtianCounterIdentificationWorkerController(
  engine: RngEngine,
  postMessage: NormalArtianCounterIdentificationWorkerPostMessage,
): NormalArtianCounterIdentificationWorkerController {
  const activeRequests = new Map<string, ActiveNormalArtianCounterIdentificationRequest>()
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
          message: `Normal Artian Counter identification requestId is already active: ${request.requestId}`,
          code: 'invalid_input',
          unsupportedReason: null,
        })
        return
      }

      const activeRequest: ActiveNormalArtianCounterIdentificationRequest = { cancelled: false }
      activeRequests.set(request.requestId, activeRequest)
      try {
        const result = await identifyNormalArtianCounter(request.input, engine, {
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
            type: 'normal_artian_counter_identification_result',
            requestId: request.requestId,
            result,
          })
        }
      } catch (error: unknown) {
        if (
          activeRequest.cancelled ||
          (error instanceof NormalArtianCounterIdentificationError && error.code === 'cancelled')
        ) return
        postMessage({
          type: 'error',
          requestId: request.requestId,
          message: error instanceof Error
            ? error.message
            : 'Unknown Normal Artian Counter identification error.',
          code: error instanceof NormalArtianCounterIdentificationError
            ? error.code
            : 'unexpected_error',
          unsupportedReason: error instanceof NormalArtianCounterIdentificationError
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

export interface NormalArtianCounterIdentificationWorkerScope {
  postMessage(response: NormalArtianCounterIdentificationWorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: { data: NormalArtianCounterIdentificationWorkerRequest }) => void,
  ): void
}

export function attachNormalArtianCounterIdentificationWorker(
  scope: NormalArtianCounterIdentificationWorkerScope,
  createEngine: NormalArtianCounterIdentificationWorkerRngEngineFactory,
): NormalArtianCounterIdentificationWorkerController {
  const controller = createNormalArtianCounterIdentificationWorkerController(
    createEngine(),
    (response) => scope.postMessage(response),
  )
  scope.addEventListener('message', (event) => {
    void controller.handleMessage(event.data)
  })
  return controller
}
