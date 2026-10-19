import type { BuildCandidateId, TargetWeaponId } from '../models/publicTypes'
import { CandidateSearchError } from './searchTypes'
import type {
  CandidateSearchProgress,
  CandidateSearchProgressPhase,
} from './searchTypes'

/**
 * Settled scheduler work items between two `searching` progress events. Total
 * work is discovered while the Target searches, so this only bounds how often
 * an activity signal is published; it never affects Search semantics, the
 * canonical Ideal, the retained set, or the checkpoint yield interval.
 */
export const SEARCH_ACTIVITY_PROGRESS_INTERVAL = 100

export interface TargetProgressScope {
  targetWeaponId: TargetWeaponId
}

export interface CandidateIdInput {
  targetWeaponId: TargetWeaponId
  semanticHash: string
}

export interface CandidateSearchExecutionOptions {
  createCandidateId?: (input: CandidateIdInput) => BuildCandidateId
  now?: () => string
  nowMs?: () => number
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
  onProgress?: (progress: CandidateSearchProgress) => void
}

export interface SearchExecutionContext {
  createCandidateId: (input: CandidateIdInput) => BuildCandidateId
  now: () => string
  nowMs: () => number
  checkpoint: () => Promise<void>
  onProgress: (progress: CandidateSearchProgress) => void
  /** Starts a Target scope, resets the work counter, and reports `preparing`. */
  beginTarget: (scope: TargetProgressScope) => void
  /** Counts one settled scheduler work item and reports activity periodically. */
  onWorkSettled: () => void
  /** Closes the active Target scope and reports the final `finalizing` value. */
  completeTarget: () => void
}

export function createSearchExecutionContext(
  options: CandidateSearchExecutionOptions = {},
): SearchExecutionContext {
  let checkpointCount = 0
  const shouldCancel = options.shouldCancel ?? (() => false)
  const yieldControl = options.yieldControl ?? (() => Promise.resolve())
  const onProgress = options.onProgress ?? (() => undefined)

  let scope: TargetProgressScope | null = null
  let processedWorkItems = 0
  let reportedWorkItems = 0
  const report = (
    current: TargetProgressScope,
    phase: CandidateSearchProgressPhase,
  ) => {
    onProgress({
      targetWeaponId: current.targetWeaponId,
      phase,
      processedWorkItems,
    })
  }

  return {
    beginTarget: (next) => {
      scope = next
      processedWorkItems = 0
      reportedWorkItems = 0
      report(next, 'preparing')
    },
    onWorkSettled: () => {
      processedWorkItems += 1
      if (
        scope !== null &&
        processedWorkItems - reportedWorkItems >= SEARCH_ACTIVITY_PROGRESS_INTERVAL
      ) {
        reportedWorkItems = processedWorkItems
        report(scope, 'searching')
      }
    },
    completeTarget: () => {
      const current = scope
      if (current === null) return
      scope = null
      report(current, 'finalizing')
    },
    createCandidateId:
      options.createCandidateId ??
      (({ semanticHash }) => `candidate.${semanticHash}` as BuildCandidateId),
    now: options.now ?? (() => new Date().toISOString()),
    nowMs: options.nowMs ?? (() => performance.now()),
    onProgress,
    checkpoint: async () => {
      if (shouldCancel()) {
        throw new CandidateSearchError('cancelled', 'Candidate search was cancelled.')
      }
      checkpointCount += 1
      if (checkpointCount % 50 === 0) {
        await yieldControl()
        if (shouldCancel()) {
          throw new CandidateSearchError(
            'cancelled',
            'Candidate search was cancelled.',
          )
        }
      }
    },
  }
}
