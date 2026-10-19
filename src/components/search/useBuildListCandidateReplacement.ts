import { useCallback, useState } from 'react'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../../domain/execution'
import type { BuildListEntry, BuildListEntryId } from '../../domain/models/publicTypes'
import type { BuildListCandidateReplacementRequest } from '../../services/buildList/buildListService'
import type { PlanBreakingChangeApprovalController } from '../execution/usePlanBreakingChangeApproval'
import {
  BUILD_LIST_REPLACEMENT_PLAN_BREAKING_NOTE,
  buildListCardinalityRefusalMessage,
} from './buildListReplacementPresentation'

/** The two calls a confirmed replacement makes, as a screen injects them. */
export interface BuildListCandidateReplacementApi {
  /** The read-only breaking-change inspection of that very replacement. Writes nothing. */
  inspectCandidateReplacement(request: BuildListCandidateReplacementRequest): Promise<PlanBreakingChangeInspection>
  /** `approval` is the breaking-change approval when the inspection required one (`docs/UI_FLOW.md` 16.3). */
  replaceCandidate(
    request: BuildListCandidateReplacementRequest,
    approval?: PlanBreakingChangeApproval | null,
  ): Promise<BuildListEntry>
}

/**
 * The replacement waiting for the user's confirmation: the request the
 * confirmation will send, and the Target's one Entry the addition reported
 * (`replacement_required`), which the request names as
 * `expectedExistingEntryId`.
 */
export interface BuildListCandidateReplacementPending {
  request: BuildListCandidateReplacementRequest
  existingEntry: BuildListEntry
}

export interface BuildListCandidateReplacementController {
  pending: BuildListCandidateReplacementPending | null
  submitting: boolean
  /** A refusal or failure the user can retry from the confirmation itself. */
  error: string | null
  /** Opens the confirmation. Nothing is inspected or written yet. */
  begin(pending: BuildListCandidateReplacementPending): void
  /** 「キャンセル」: nothing is saved. */
  cancel(): void
  /** 「置き換える」: one guarded replacement, warned first when it breaks the active Plan. */
  confirm(): Promise<void>
}

export interface UseBuildListCandidateReplacementOptions {
  api: BuildListCandidateReplacementApi | null
  planGuard: PlanBreakingChangeApprovalController
  /** The replacement was saved: `replacedEntryId` is gone and `entry` took its place. */
  onApplied(entry: BuildListEntry, replacedEntryId: BuildListEntryId, planAbandoned: boolean): void
  /**
   * The Build List Service refused the replacement by typed code (the Target's
   * Entries changed since the confirmation opened, a legacy duplicate, the
   * Target is gone, the Candidate is that Entry's own). The confirmation
   * closes, because the Entry it shows is no longer the one to replace, and
   * the screen reports the refusal; nothing is retried or guessed.
   */
  onRefused(message: string): void
}

/**
 * The Search screen's confirmed `replace BuildListEntry for Target`
 * (`docs/UI_FLOW.md` 9, `docs/DATA_MODEL.md` 9.4.1): the replacement is
 * confirmed first on its own, and only then run as one guarded change through
 * the shared breaking-change controller, which warns when the runtime says the
 * replacement breaks the `active` Plan (16.3). The screen judges nothing
 * itself: whether a warning is shown, whether the replacement is still valid
 * and what the new Entry is all come from the Service.
 */
export function useBuildListCandidateReplacement({
  api,
  planGuard,
  onApplied,
  onRefused,
}: UseBuildListCandidateReplacementOptions): BuildListCandidateReplacementController {
  const [pending, setPending] = useState<BuildListCandidateReplacementPending | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const begin = useCallback((next: BuildListCandidateReplacementPending) => {
    setPending(next)
    setError(null)
  }, [])

  const cancel = useCallback(() => {
    if (submitting) return
    setPending(null)
    setError(null)
  }, [submitting])

  const confirm = useCallback(async () => {
    if (api === null || pending === null || submitting) return
    const { request, existingEntry } = pending
    setSubmitting(true)
    setError(null)
    try {
      // The inspection and the save close over the very same request; the
      // Service re-reads the Target's Entries inside its own transaction.
      const outcome = await planGuard.run({
        inspect: () => api.inspectCandidateReplacement(request),
        apply: (approval) => api.replaceCandidate(request, approval),
        note: BUILD_LIST_REPLACEMENT_PLAN_BREAKING_NOTE,
      })
      // A cancelled warning saved nothing; the replacement confirmation stays
      // open, exactly as it was, for the user to cancel or confirm again.
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'refused') {
        setError(outcome.message)
        return
      }
      setPending(null)
      onApplied(outcome.result, existingEntry.id, outcome.planAbandoned)
    } catch (caught: unknown) {
      const refusal = buildListCardinalityRefusalMessage(caught)
      if (refusal !== null) {
        setPending(null)
        onRefused(refusal)
        return
      }
      setError(caught instanceof Error ? caught.message : '作成リストの候補を置き換えられませんでした。')
    } finally {
      setSubmitting(false)
    }
  }, [api, onApplied, onRefused, pending, planGuard, submitting])

  return { pending, submitting, error, begin, cancel, confirm }
}
