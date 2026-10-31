import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildListResearchSelection } from '../../domain/buildList'
import type { BuildListEntry } from '../../domain/models/publicTypes'
import type { BuildListStaleCandidateReplacementRequest } from '../../services/buildList/buildListService'
import {
  runBatchCandidateResearch,
  type BatchCandidateResearchRequest,
  type BatchCandidateResearchRun,
  type BatchCandidateResearchSummary,
} from '../../services/search/batchStaleCandidateReplacement'
import type {
  BatchCandidateSearchLoopDependencies,
  BatchCandidateSearchProgress,
} from '../../services/search/batchCandidateSearch'
import { BATCH_RESEARCH_SELECTION_READ_FAILED } from './batchStaleCandidateReplacementPresentation'

/** The two Application calls 「再検索が必要な候補を一括再検索・置換」 makes, as a screen injects them. */
export interface BatchCandidateResearchApi {
  /**
   * The Targets to re-search and the stale candidates left alone, selected by
   * the Domain from one read of the persisted state
   * (`createBuildListResearchSelectionReader()`). Read-only; a failure throws.
   */
  readResearchSelection(): Promise<BuildListResearchSelection>
  /** The stale Entry's re-search replacement (`BuildListService.replaceStaleCandidate()`), never with an approval. */
  replaceStaleCandidate(request: BuildListStaleCandidateReplacementRequest): Promise<BuildListEntry>
}

/** What one batch runs with: the screen's search loop and the conditions it shows at the press. */
export interface BatchCandidateResearchRunContext {
  loop: BatchCandidateSearchLoopDependencies
  request: Omit<BatchCandidateResearchRequest, 'targets'>
}

export interface UseBatchCandidateResearchOptions {
  api: BatchCandidateResearchApi | null
  /** The context of a batch started now; `null` when the screen cannot search now (no Worker, no Master). */
  runContext(): BatchCandidateResearchRunContext | null
  /** Another operation of the screen runs or waits for a decision: no batch starts. */
  blocked: boolean
  /**
   * A batch is starting: the screen drops the results and notices of its other
   * operations. It may return a promise - the screen's read of the Build List
   * before the batch, for its replan proposal (`docs/PLANNER_SPEC.md` 18.3) -
   * and then no replacement of this batch starts before that promise settled,
   * exactly as the 9.1 batch waits in `addCandidate()`: a replaced Entry is
   * never read as "before". The searches themselves do not wait. A rejection
   * counts as settled (the screen proposes nothing on a failed read).
   */
  onStart(): Promise<unknown> | void
  /** The batch ended with its summary, or failed before it could (`failure`); the screen re-reads the persisted Build List. */
  onFinish(summary: BatchCandidateResearchSummary | null, failure: string | null): void
}

export interface BatchCandidateResearchController {
  /** The current selection, or `null` before the first read and after a failed one. */
  selection: BuildListResearchSelection | null
  /** The last read failed: the batch is withheld, never offered as "nothing to re-search". */
  selectionError: string | null
  /** Re-reads the selection from the persisted state (after a Build List change). A later read never lands behind a newer one. */
  reloadSelection(): void
  /** The selection the open confirmation shows; `null` while it is closed. */
  confirming: BuildListResearchSelection | null
  /** Opens the confirmation over the selection shown now. Nothing is searched or written yet. */
  openConfirmation(): void
  /** 「キャンセル」: nothing changes. */
  cancelConfirmation(): void
  /** 「一括再検索・置換を開始」: runs the confirmed Targets. */
  start(): void
  running: boolean
  cancelling: boolean
  progress: BatchCandidateSearchProgress | null
  summary: BatchCandidateResearchSummary | null
  /** Drops the finished batch's summary (another operation started). */
  clearSummary(): void
  /** Cancels the running batch through the Worker cancel contract; replacements already made are kept. */
  cancel(): void
}

/**
 * The Search screen's 「再検索が必要な候補を一括再検索・置換」 (`docs/UI_FLOW.md` 9.3,
 * Issue #347): the selection read, the confirmation, one batch at a time
 * (never beside a single search or the 9.1 batch), its progress and its
 * summary. The screen judges nothing itself: which Targets qualify is the
 * Domain's selection, and whether a found Candidate replaced the stale Entry
 * is the Service's answer inside the batch.
 */
export function useBatchCandidateResearch({
  api,
  runContext,
  blocked,
  onStart,
  onFinish,
}: UseBatchCandidateResearchOptions): BatchCandidateResearchController {
  const [selection, setSelection] = useState<BuildListResearchSelection | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<BuildListResearchSelection | null>(null)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<BatchCandidateSearchProgress | null>(null)
  const [summary, setSummary] = useState<BatchCandidateResearchSummary | null>(null)
  // The read whose answer may still land; an older read's answer is dropped.
  const readSequenceRef = useRef(0)
  // The batch whose progress and summary may still land on this screen.
  const runRef = useRef<BatchCandidateResearchRun | null>(null)
  const tokenRef = useRef<object | null>(null)
  const mountedRef = useRef(true)

  const reloadSelection = useCallback(() => {
    if (api === null) return
    readSequenceRef.current += 1
    const sequence = readSequenceRef.current
    void api.readResearchSelection().then(
      (next) => {
        if (!mountedRef.current || readSequenceRef.current !== sequence) return
        setSelection(next)
        setSelectionError(null)
      },
      () => {
        if (!mountedRef.current || readSequenceRef.current !== sequence) return
        // A failed read withholds the batch; it is never read as "no stale Entry".
        setSelection(null)
        setSelectionError(BATCH_RESEARCH_SELECTION_READ_FAILED)
      },
    )
  }, [api])

  useEffect(() => {
    mountedRef.current = true
    reloadSelection()
    return () => {
      mountedRef.current = false
      readSequenceRef.current += 1
      tokenRef.current = null
      runRef.current?.cancel()
      runRef.current = null
    }
  }, [reloadSelection])

  const openConfirmation = useCallback(() => {
    if (blocked || running || selection === null || selection.targets.length === 0) return
    setConfirming(selection)
  }, [blocked, running, selection])

  const cancelConfirmation = useCallback(() => {
    setConfirming(null)
  }, [])

  const start = useCallback(() => {
    const confirmed = confirming
    setConfirming(null)
    if (confirmed === null || confirmed.targets.length === 0 || blocked || running || api === null) return
    const context = runContext()
    if (context === null) return
    const token = {}
    tokenRef.current = token
    setRunning(true)
    setCancelling(false)
    setSummary(null)
    setProgress(null)
    // The gate every replacement of this batch waits for (see `onStart`).
    const started = Promise.resolve(onStart()).then(
      () => undefined,
      () => undefined,
    )
    const run = runBatchCandidateResearch(
      { ...context.request, targets: confirmed.targets.map(({ target, entry }) => ({ target, entry })) },
      {
        ...context.loop,
        replaceStaleCandidate: async (request) => {
          await started
          return api.replaceStaleCandidate(request)
        },
      },
      (next) => {
        if (tokenRef.current === token) setProgress(next)
      },
    )
    runRef.current = run
    const finish = (finished: BatchCandidateResearchSummary | null, failure: string | null) => {
      if (tokenRef.current !== token) return
      tokenRef.current = null
      runRef.current = null
      setRunning(false)
      setCancelling(false)
      setProgress(null)
      setSummary(finished)
      onFinish(finished, failure)
    }
    void run.promise.then(
      (finished) => finish(finished, null),
      (caught: unknown) => finish(null, caught instanceof Error ? caught.message : '一括再検索に失敗しました。'),
    )
  }, [api, blocked, confirming, onFinish, onStart, runContext, running])

  const cancel = useCallback(() => {
    if (runRef.current === null) return
    setCancelling(true)
    runRef.current.cancel()
  }, [])

  const clearSummary = useCallback(() => {
    setSummary(null)
  }, [])

  return {
    selection,
    selectionError,
    reloadSelection,
    confirming,
    openConfirmation,
    cancelConfirmation,
    start,
    running,
    cancelling,
    progress,
    summary,
    clearSummary,
    cancel,
  }
}
