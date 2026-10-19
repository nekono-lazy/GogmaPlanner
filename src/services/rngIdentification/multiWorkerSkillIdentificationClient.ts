import {
  CANONICAL_BASE_SEED_MAX,
  CANONICAL_BASE_SEED_MIN,
  SkillIdentificationError,
  mergeSkillIdentificationChunkResults,
  type InclusiveNumberRange,
  type SkillIdentificationInput,
  type SkillIdentificationProgress,
  type SkillIdentificationResult,
} from '../../domain/rng/identification'
import {
  createProductionSkillIdentificationWorkerClient,
  createUnavailableSkillIdentificationWorkerClient,
  SkillIdentificationCancelledError,
  SkillIdentificationDuplicateRequestError,
  SkillIdentificationWorkerError,
  type SkillIdentificationWorkerClient,
  type SkillIdentificationWorkerClientCallbacks,
} from './skillIdentificationWorkerClient'

export const MAX_PRODUCTION_SKILL_IDENTIFICATION_WORKERS = 4

export interface SkillIdentificationParallelDependencies {
  readonly workerClientFactory: () => SkillIdentificationWorkerClient
  readonly hardwareConcurrency?: number
}

interface ChildRequestState {
  readonly client: SkillIdentificationWorkerClient
  readonly requestId: string
  readonly seedRange: InclusiveNumberRange
  readonly totalSeeds: number
  searchedSeeds: number
  matchesFound: number
}

interface ActiveParallelRequest {
  readonly reject: (error: Error) => void
  readonly children: readonly ChildRequestState[]
  readonly onProgress?: (progress: SkillIdentificationProgress) => void
}

function rangeLength(range: InclusiveNumberRange): number {
  return range.endInclusive - range.startInclusive + 1
}

function invalidInput(message: string): SkillIdentificationWorkerError {
  return new SkillIdentificationWorkerError(message, 'invalid_input', null)
}

function normalizeOrchestrationError(error: unknown): Error {
  if (error instanceof SkillIdentificationError) {
    return new SkillIdentificationWorkerError(
      error.message,
      error.code,
      error.unsupportedReason,
    )
  }
  return error instanceof Error
    ? error
    : new SkillIdentificationWorkerError(
        'Unknown parallel Skill Identification error.',
        'unexpected_error',
        null,
      )
}

function resolveSeedRange(input: SkillIdentificationInput): InclusiveNumberRange {
  return input.seedRange ?? {
    startInclusive: CANONICAL_BASE_SEED_MIN,
    endInclusive: CANONICAL_BASE_SEED_MAX,
  }
}

function validateSeedRange(range: InclusiveNumberRange): void {
  if (
    !Number.isSafeInteger(range.startInclusive) ||
    !Number.isSafeInteger(range.endInclusive) ||
    range.startInclusive < CANONICAL_BASE_SEED_MIN ||
    range.endInclusive > CANONICAL_BASE_SEED_MAX ||
    range.endInclusive < range.startInclusive
  ) {
    throw invalidInput(
      `Base Seed range must be an inclusive ascending range from ${CANONICAL_BASE_SEED_MIN} to ${CANONICAL_BASE_SEED_MAX}.`,
    )
  }
}

function validateMaxMatches(maxMatches: number | undefined): void {
  if (
    maxMatches !== undefined &&
    (!Number.isSafeInteger(maxMatches) || maxMatches < 1)
  ) {
    throw invalidInput('maxMatches must be a safe integer of at least 1.')
  }
}

export function selectSkillIdentificationWorkerCount(
  hardwareConcurrency: number | undefined,
): 1 | 2 | 4 {
  if (!Number.isFinite(hardwareConcurrency)) return 1
  const logicalCores = Math.floor(hardwareConcurrency ?? 0)
  if (logicalCores >= MAX_PRODUCTION_SKILL_IDENTIFICATION_WORKERS) {
    return MAX_PRODUCTION_SKILL_IDENTIFICATION_WORKERS
  }
  if (logicalCores >= 2) return 2
  return 1
}

export function splitSkillIdentificationSeedRange(
  range: InclusiveNumberRange,
  targetChunkCount: number,
): readonly InclusiveNumberRange[] {
  validateSeedRange(range)
  if (!Number.isSafeInteger(targetChunkCount) || targetChunkCount < 1) {
    throw invalidInput('Skill Identification chunk count must be at least 1.')
  }

  const seedCount = rangeLength(range)
  const chunkCount = Math.min(seedCount, targetChunkCount)
  const baseChunkSize = Math.floor(seedCount / chunkCount)
  const remainder = seedCount % chunkCount
  const chunks: InclusiveNumberRange[] = []
  let nextStart = range.startInclusive

  for (let index = 0; index < chunkCount; index += 1) {
    const chunkSize = baseChunkSize + (index < remainder ? 1 : 0)
    const endInclusive = nextStart + chunkSize - 1
    chunks.push({ startInclusive: nextStart, endInclusive })
    nextStart = endInclusive + 1
  }

  return chunks
}

function applyGlobalMaxMatches(
  completeResult: SkillIdentificationResult,
  maxMatches: number | undefined,
): SkillIdentificationResult {
  if (maxMatches === undefined || completeResult.matches.length < maxMatches) {
    return completeResult
  }

  const matches = completeResult.matches.slice(0, maxMatches)
  const completedSeed = matches.at(-1)!.baseSeed
  return {
    matches,
    searchedSeedRange: {
      startInclusive: completeResult.searchedSeedRange.startInclusive,
      endInclusive: completedSeed,
    },
    isTruncated:
      completeResult.matches.length > maxMatches ||
      completedSeed < completeResult.searchedSeedRange.endInclusive,
  }
}

function isCompleteChildResult(
  result: SkillIdentificationResult,
  child: ChildRequestState,
  skillCounterRange: InclusiveNumberRange,
): boolean {
  return (
    !result.isTruncated &&
    result.searchedSeedRange.startInclusive === child.seedRange.startInclusive &&
    result.searchedSeedRange.endInclusive === child.seedRange.endInclusive &&
    result.matches.every((match) =>
      Number.isSafeInteger(match.baseSeed) &&
      match.baseSeed >= child.seedRange.startInclusive &&
      match.baseSeed <= child.seedRange.endInclusive &&
      Number.isSafeInteger(match.startSkillCounter) &&
      match.startSkillCounter >= skillCounterRange.startInclusive &&
      match.startSkillCounter <= skillCounterRange.endInclusive
    )
  )
}

function safeProgressCount(value: number, maximum?: number): number {
  if (!Number.isFinite(value)) return 0
  const normalized = Math.max(0, Math.floor(value))
  return maximum === undefined ? normalized : Math.min(normalized, maximum)
}

function createChildRequestId(
  parentRequestId: string,
  token: number,
  chunkIndex: number,
): string {
  return `${parentRequestId}.parallel${token}.chunk${chunkIndex}`
}

function createInitializationFailureClient(): SkillIdentificationWorkerClient {
  return createUnavailableSkillIdentificationWorkerClient()
}

export function createMultiWorkerSkillIdentificationClient(
  dependencies: SkillIdentificationParallelDependencies,
): SkillIdentificationWorkerClient {
  const targetWorkerCount = selectSkillIdentificationWorkerCount(
    dependencies.hardwareConcurrency,
  )
  const clients: SkillIdentificationWorkerClient[] = []

  try {
    for (let index = 0; index < targetWorkerCount; index += 1) {
      clients.push(dependencies.workerClientFactory())
    }
  } catch {
    clients.forEach((client) => client.dispose())
    return createInitializationFailureClient()
  }

  const engineVersion = clients[0]!.engineVersion
  if (clients.some((client) => client.engineVersion !== engineVersion)) {
    clients.forEach((client) => client.dispose())
    return createInitializationFailureClient()
  }

  const active = new Map<string, ActiveParallelRequest>()
  let requestToken = 0
  let disposed = false

  const isCurrent = (requestId: string, request: ActiveParallelRequest): boolean =>
    !disposed && active.get(requestId) === request

  const cancelChildren = (request: ActiveParallelRequest): void => {
    request.children.forEach(({ client, requestId }) => client.cancel(requestId))
  }

  const reportProgress = (
    parentRequestId: string,
    request: ActiveParallelRequest,
  ): void => {
    if (!isCurrent(parentRequestId, request)) return
    const searchedSeeds = request.children.reduce(
      (total, child) => total + child.searchedSeeds,
      0,
    )
    const totalSeeds = request.children.reduce(
      (total, child) => total + child.totalSeeds,
      0,
    )
    const matchesFound = request.children.reduce(
      (total, child) => total + child.matchesFound,
      0,
    )
    request.onProgress?.({ searchedSeeds, totalSeeds, matchesFound })
  }

  const updateChildProgress = (
    parentRequestId: string,
    request: ActiveParallelRequest,
    childIndex: number,
    progress: SkillIdentificationProgress,
  ): void => {
    if (!isCurrent(parentRequestId, request)) return
    const child = request.children[childIndex]!
    child.searchedSeeds = Math.max(
      child.searchedSeeds,
      safeProgressCount(progress.searchedSeeds, child.totalSeeds),
    )
    child.matchesFound = Math.max(
      child.matchesFound,
      safeProgressCount(progress.matchesFound),
    )
    reportProgress(parentRequestId, request)
  }

  return {
    engineVersion,
    identify: (requestId, input, callbacks: SkillIdentificationWorkerClientCallbacks = {}) => {
      if (disposed) {
        return Promise.reject(
          new Error('Multi-Worker Skill Identification Client is disposed.'),
        )
      }
      if (active.has(requestId)) {
        return Promise.reject(new SkillIdentificationDuplicateRequestError(requestId))
      }

      let chunks: readonly InclusiveNumberRange[]
      try {
        validateMaxMatches(input.maxMatches)
        chunks = splitSkillIdentificationSeedRange(
          resolveSeedRange(input),
          clients.length,
        )
      } catch (error) {
        return Promise.reject(normalizeOrchestrationError(error))
      }

      const token = ++requestToken
      let resolveParent: (result: SkillIdentificationResult) => void = () => undefined
      let rejectParent: (error: Error) => void = () => undefined
      const parentPromise = new Promise<SkillIdentificationResult>((resolve, reject) => {
        resolveParent = resolve
        rejectParent = reject
      })
      const children = chunks.map((chunk, chunkIndex): ChildRequestState => ({
        client: clients[chunkIndex]!,
        requestId: createChildRequestId(requestId, token, chunkIndex),
        seedRange: chunk,
        totalSeeds: rangeLength(chunk),
        searchedSeeds: 0,
        matchesFound: 0,
      }))
      const request: ActiveParallelRequest = {
        reject: rejectParent,
        children,
        onProgress: callbacks.onProgress,
      }
      active.set(requestId, request)

      const childPromises = children.map((child, childIndex) => {
        const childInput: SkillIdentificationInput = {
          ...input,
          seedRange: chunks[childIndex],
          maxMatches: undefined,
        }
        return Promise.resolve()
          .then(() => {
            if (!isCurrent(requestId, request)) {
              throw new SkillIdentificationCancelledError()
            }
            return child.client.identify(child.requestId, childInput, {
              onProgress: (progress) => {
                updateChildProgress(requestId, request, childIndex, progress)
              },
            })
          })
          .then((result) => {
            if (
              isCurrent(requestId, request) &&
              isCompleteChildResult(result, child, input.skillCounterRange)
            ) {
              child.searchedSeeds = child.totalSeeds
              child.matchesFound = Math.max(child.matchesFound, result.matches.length)
              reportProgress(requestId, request)
            }
            return result
          })
      })

      void Promise.all(childPromises).then(
        (results) => {
          if (!isCurrent(requestId, request)) return
          try {
            if (results.some((result, index) => !isCompleteChildResult(
              result,
              request.children[index]!,
              input.skillCounterRange,
            ))) {
              throw new SkillIdentificationError(
                'incomplete_parallel_chunk',
                'A parallel Skill Identification Worker returned an incomplete or out-of-range chunk result.',
              )
            }
            const completeResult = mergeSkillIdentificationChunkResults(results)
            const result = applyGlobalMaxMatches(completeResult, input.maxMatches)
            active.delete(requestId)
            resolveParent(result)
          } catch (error) {
            active.delete(requestId)
            cancelChildren(request)
            rejectParent(normalizeOrchestrationError(error))
          }
        },
        (error: unknown) => {
          if (!isCurrent(requestId, request)) return
          active.delete(requestId)
          cancelChildren(request)
          rejectParent(normalizeOrchestrationError(error))
        },
      )

      return parentPromise
    },
    cancel: (requestId) => {
      const request = active.get(requestId)
      if (!request) return
      active.delete(requestId)
      cancelChildren(request)
      request.reject(new SkillIdentificationCancelledError())
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const request of active.values()) {
        cancelChildren(request)
        request.reject(new SkillIdentificationCancelledError())
      }
      active.clear()
      clients.forEach((client) => client.dispose())
    },
  }
}

function getHardwareConcurrency(): number | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency
}

export function createProductionMultiWorkerSkillIdentificationClient(): SkillIdentificationWorkerClient {
  if (typeof Worker === 'undefined') {
    return createUnavailableSkillIdentificationWorkerClient()
  }
  return createMultiWorkerSkillIdentificationClient({
    hardwareConcurrency: getHardwareConcurrency(),
    workerClientFactory: createProductionSkillIdentificationWorkerClient,
  })
}
