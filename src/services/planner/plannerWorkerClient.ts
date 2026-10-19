import type {
  PlannerInput,
  PlannerResult,
} from '../../domain/planner'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../../domain/rng/production/productionRngEngine'
import type {
  PlannerInteractionPreparationResult,
  PlannerWorkerProtocolRequest,
  PlannerWorkerProtocolResponse,
} from '../../workers/plannerWorkerContracts'

export class PlannerCancelledError extends Error {
  constructor() {
    super('Planner calculation was cancelled.')
    this.name = 'PlannerCancelledError'
  }
}

export class ProductionPlannerWorkerUnavailableError extends Error {
  constructor() {
    super('この環境ではPlanner Workerを利用できないため、生産計画を作成できません。')
    this.name = 'ProductionPlannerWorkerUnavailableError'
  }
}

/**
 * A Worker result whose discriminant does not match the pending request's
 * expected result type, for the pending request's own task generation.
 *
 * Every request kind shares one pending id namespace, so a `create_plan_result`
 * must never resolve a `prepareInteraction()` Promise and vice versa: the
 * result shapes differ and a caller would silently read the wrong one. A
 * discriminant this Client does not know is never read as one it does. This
 * fails closed instead.
 *
 * A response carrying a *different* generation is a stale message from a
 * superseded task instance, not a protocol violation, and is ignored silently
 * rather than raising this.
 */
export class PlannerWorkerProtocolError extends Error {
  readonly receivedResultType: string
  readonly expectedResultType: string

  constructor(receivedResultType: string, expectedResultType: string) {
    super(
      `Planner Worker returned '${receivedResultType}' for a request expecting '${expectedResultType}'.`,
    )
    this.name = 'PlannerWorkerProtocolError'
    this.receivedResultType = receivedResultType
    this.expectedResultType = expectedResultType
  }
}

export interface PlannerWorkerClient {
  readonly engineVersion: string
  /**
   * The ordinary Production Planner run. Like every entry point below it takes
   * no progress callback (Issue #103 Phase D-2a): the Promise settles with the
   * result, an error, or `PlannerCancelledError` from `cancelPlan()`. Since
   * Issue #278 PR-2 it is also the Production Plan screen's 「この候補を優先」,
   * with the explicit decision set in `PlannerInput.conflictResolutions`
   * (`docs/PLANNER_SPEC.md` 9.6.4).
   */
  createPlan(
    requestId: string,
    input: PlannerInput,
  ): Promise<PlannerResult>
  /** B10 current initial availability; calculation only, with no search bounds. */
  prepareInteraction(
    requestId: string,
    input: PlannerInput,
  ): Promise<PlannerInteractionPreparationResult>
  cancelPlan(requestId: string): void
  dispose(): void
}

export interface PlannerWorkerLike {
  postMessage(message: PlannerWorkerProtocolRequest): void
  addEventListener(
    type: 'message',
    listener: (event: { data: PlannerWorkerProtocolResponse }) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: { data: PlannerWorkerProtocolResponse }) => void,
  ): void
  terminate(): void
}

/**
 * One pending request, identified by its task generation and discriminated by
 * the response type it accepts.
 *
 * All request kinds share this Map, so the duplicate-requestId semantics stay
 * exactly as before: re-using an id rejects the previous pending request with
 * `PlannerCancelledError` and replaces it, whichever kind either request is.
 * The generation is what makes that replacement safe across the thread
 * boundary - the superseded task may still be running in the Worker, and its
 * response must not be read as this pending request's.
 */
interface PendingPlanIdentity {
  requestId: string
  generation: number
  reject: (error: Error) => void
}

type PendingPlan =
  | (PendingPlanIdentity & {
      expectedResultType: 'prepare_interaction_result'
      resolve: (result: PlannerInteractionPreparationResult) => void
    })
  | (PendingPlanIdentity & {
      expectedResultType: 'create_plan_result'
      resolve: (result: PlannerResult) => void
    })

export function createPlannerWorkerClient(
  worker: PlannerWorkerLike,
  engineVersion: string,
): PlannerWorkerClient {
  const pending = new Map<string, PendingPlan>()
  /** Monotonic across all request kinds, so a generation is never reused. */
  let lastGeneration = 0
  let disposed = false

  const handleMessage = ({ data }: { data: PlannerWorkerProtocolResponse }) => {
    const current = pending.get(data.requestId)
    if (!current) return
    // A superseded task instance may still finish in the Worker before the
    // replacement task is even delivered there. Its response is stale, so it is
    // dropped here rather than treated as a wrong discriminant.
    if (data.generation !== current.generation) return
    pending.delete(data.requestId)
    if (data.type === 'error') {
      current.reject(new Error(data.message))
      return
    }
    if (
      data.type === 'create_plan_result' &&
      current.expectedResultType === 'create_plan_result'
    ) {
      current.resolve(data.result)
      return
    }
    if (
      data.type === 'prepare_interaction_result' &&
      current.expectedResultType === 'prepare_interaction_result'
    ) {
      current.resolve(data.result)
      return
    }
    current.reject(
      new PlannerWorkerProtocolError(data.type, current.expectedResultType),
    )
  }
  worker.addEventListener('message', handleMessage)

  /** Replaces any pending request holding this id and mints its generation. */
  const claimRequestId = (requestId: string): number => {
    const existing = pending.get(requestId)
    existing?.reject(new PlannerCancelledError())
    pending.delete(requestId)
    lastGeneration += 1
    return lastGeneration
  }

  return {
    engineVersion,
    createPlan: (requestId, input) => {
      if (disposed) {
        return Promise.reject(new Error('Planner Worker Client is disposed.'))
      }
      const generation = claimRequestId(requestId)
      return new Promise<PlannerResult>((resolve, reject) => {
        pending.set(requestId, {
          requestId,
          generation,
          expectedResultType: 'create_plan_result',
          resolve,
          reject,
        })
        worker.postMessage({ type: 'create_plan', requestId, generation, input })
      })
    },
    prepareInteraction: (requestId, input) => {
      if (disposed) {
        return Promise.reject(new Error('Planner Worker Client is disposed.'))
      }
      const generation = claimRequestId(requestId)
      return new Promise<PlannerInteractionPreparationResult>((resolve, reject) => {
        pending.set(requestId, {
          requestId,
          generation,
          expectedResultType: 'prepare_interaction_result',
          resolve,
          reject,
        })
        worker.postMessage({
          type: 'prepare_interaction',
          requestId,
          generation,
          input,
        })
      })
    },
    cancelPlan: (requestId) => {
      const current = pending.get(requestId)
      if (!current) return
      pending.delete(requestId)
      current.reject(new PlannerCancelledError())
      // Names the instance being waited on, so it can never cancel a newer one.
      worker.postMessage({
        type: 'cancel',
        requestId,
        generation: current.generation,
      })
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      pending.forEach(({ reject }) => reject(new PlannerCancelledError()))
      pending.clear()
      worker.removeEventListener('message', handleMessage)
      worker.terminate()
    },
  }
}

export function createUnavailablePlannerWorkerClient(): PlannerWorkerClient {
  return {
    engineVersion: 'production-engine-unavailable',
    createPlan: () => Promise.reject(new ProductionPlannerWorkerUnavailableError()),
    // The same explicit unavailable error, never a main-thread fallback
    // calculation.
    prepareInteraction: () =>
      Promise.reject(new ProductionPlannerWorkerUnavailableError()),
    cancelPlan: () => undefined,
    dispose: () => undefined,
  }
}

export function createProductionPlannerWorkerClient(): PlannerWorkerClient {
  if (typeof Worker === 'undefined') return createUnavailablePlannerWorkerClient()
  const worker = new Worker(
    new URL('../../workers/planner.worker.entry.ts', import.meta.url),
    { type: 'module' },
  )
  return createPlannerWorkerClient(
    worker as unknown as PlannerWorkerLike,
    PRODUCTION_RNG_ENGINE_VERSION,
  )
}
