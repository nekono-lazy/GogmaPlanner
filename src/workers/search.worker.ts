import type { RngEngine } from '../domain/rng/rngEngine'
import { searchCandidates } from '../domain/search/candidateSearch'
import { CandidateSearchError } from '../domain/search/searchTypes'
import type {
  SearchWorkerRequest,
  SearchWorkerResponse,
} from '../domain/search/searchTypes'

export type SearchWorkerPostMessage = (response: SearchWorkerResponse) => void
export type SearchWorkerRngEngineFactory = () => RngEngine

export interface SearchWorkerController {
  handleMessage: (request: SearchWorkerRequest) => Promise<void>
  isCancelled: (requestId: string) => boolean
}

/**
 * Candidate Search checkpoints yield to the Worker's task queue so a pending
 * `cancel` message is dispatched mid-search. It must be a macrotask; a
 * microtask would never let a message event run.
 *
 * B5 measured `setTimeout(resolve, 0)` against a MessagePort turn in the real
 * Browser Worker (`docs/B5_CANDIDATE_SEARCH_BROWSER_WORKER_BENCHMARK.md`). The
 * timer's minimum clamp dominated the larger workloads; the port turn preserved
 * the retained semantic candidate set up to 3.4x faster and kept cancellation
 * within milliseconds. Resolvers are queued in FIFO order because MessagePort
 * delivery is ordered and two searches can be in flight in one Worker.
 */
const yieldChannel =
  typeof MessageChannel === 'function' ? new MessageChannel() : null
const yieldResolvers: Array<() => void> = []
if (yieldChannel !== null) {
  yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.()
}

/** Exported for the macrotask-contract test; not part of the Worker protocol. */
export function workerYield(): Promise<void> {
  const channel = yieldChannel
  if (channel === null) return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    yieldResolvers.push(resolve)
    channel.port2.postMessage(null)
  })
}

export function createSearchWorkerController(
  engine: RngEngine,
  postMessage: SearchWorkerPostMessage,
): SearchWorkerController {
  const cancelledRequestIds = new Set<string>()

  return {
    isCancelled: (requestId) => cancelledRequestIds.has(requestId),
    handleMessage: async (request) => {
      if (request.type === 'cancel') {
        cancelledRequestIds.add(request.requestId)
        return
      }

      cancelledRequestIds.delete(request.requestId)
      try {
        const result = await searchCandidates(request.input, engine, {
          shouldCancel: () => cancelledRequestIds.has(request.requestId),
          yieldControl: workerYield,
          onProgress: (progress) => {
            if (!cancelledRequestIds.has(request.requestId)) {
              postMessage({
                type: 'progress',
                requestId: request.requestId,
                ...progress,
              })
            }
          },
        })
        if (!cancelledRequestIds.has(request.requestId)) {
          postMessage({
            type: 'candidate_search_result',
            requestId: request.requestId,
            result,
          })
        }
      } catch (error: unknown) {
        if (
          cancelledRequestIds.has(request.requestId) ||
          (error instanceof CandidateSearchError && error.code === 'cancelled')
        ) {
          return
        }
        postMessage({
          type: 'error',
          requestId: request.requestId,
          message: error instanceof Error ? error.message : 'Unknown search error.',
        })
      }
    },
  }
}

export interface CandidateSearchWorkerScope {
  postMessage: SearchWorkerPostMessage
  addEventListener: (
    type: 'message',
    listener: (event: { data: SearchWorkerRequest }) => void,
  ) => void
}

/**
 * Creates the worker-local Engine from the entry composition and attaches the
 * structured-clone message contract.
 */
export function attachSearchWorker(
  scope: CandidateSearchWorkerScope,
  createEngine: SearchWorkerRngEngineFactory,
): SearchWorkerController {
  const engine = createEngine()
  const controller = createSearchWorkerController(engine, (response) =>
    scope.postMessage(response),
  )
  scope.addEventListener('message', (event) => {
    void controller.handleMessage(event.data)
  })
  return controller
}
