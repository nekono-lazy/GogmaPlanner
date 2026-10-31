import { isTargetWeaponPlanningEligible } from '../../domain/models/domainRules'
import type {
  BuildCandidate,
  BuildListEntry,
  CalculationContext,
  OwnedWeaponId,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  CandidateRouteFilter,
  CandidateSearchProgress,
  CandidateSearchSettings,
} from '../../domain/search'
import { findBuildListRegisteredTargetIds } from '../../domain/buildList'
import type { AddBuildListCandidateResult } from '../buildList/buildListService'
import {
  preparedCandidateSearchInputIssue,
  type PrepareCandidateSearchInputOptions,
  type PreparedCandidateSearchInput,
} from './prepareCandidateSearchInput'
import {
  SearchCancelledError,
  SearchWorkerRuntimeError,
  type SearchWorkerClient,
} from './searchWorkerClient'

/**
 * 「未登録を一括検索・追加」 (`docs/UI_FLOW.md` 9.1): the Targets a batch
 * searches, in the given order. A Target qualifies when the ordinary single
 * Candidate Search could search it (search enabled, lifecycle `active`) and the
 * Build List holds no Entry for it at all - a stale Entry and a legacy
 * duplicate both count as registered (`findBuildListRegisteredTargetIds()`).
 */
export function selectBatchCandidateSearchTargets(
  targets: readonly TargetWeapon[],
  buildListEntries: readonly Pick<BuildListEntry, 'targetWeaponId'>[],
): TargetWeapon[] {
  const registered = findBuildListRegisteredTargetIds(buildListEntries)
  return targets.filter((target) => isTargetWeaponPlanningEligible(target) && !registered.has(target.id))
}

/**
 * The existing single Candidate Search authorities every batch reuses
 * unchanged: one `prepareInput()` + `client.startSearch()` per Target and the
 * ordinary `saveCandidates()` of that Target's result. What a batch then does
 * with a found Candidate is its own commit (`BatchCandidateSearchCommit`).
 */
export interface BatchCandidateSearchLoopDependencies {
  client: SearchWorkerClient
  createSearchRunId(): string
  /**
   * One Target's input, read from the persisted state right before its search
   * (`prepareCandidateSearchInput()`). With the exclusion on, the excluded set
   * is derived from that read, so an Entry an earlier Target of this batch
   * added or replaced is already counted (`docs/SEARCH_SPEC.md` 3.3「一括検索・追加」).
   */
  prepareInput(options: PrepareCandidateSearchInputOptions): Promise<PreparedCandidateSearchInput>
  saveCandidates(targetId: TargetWeapon['id'], candidates: BuildCandidate[]): Promise<unknown>
}

/**
 * 「未登録を一括検索・追加」's dependencies: the shared search loop plus the
 * ordinary `BuildListService.addCandidate()`.
 */
export interface BatchCandidateSearchDependencies extends BatchCandidateSearchLoopDependencies {
  addCandidate(candidate: BuildCandidate, target: TargetWeapon): Promise<AddBuildListCandidateResult>
}

/**
 * One batch: the Targets (already selected) and the search conditions the
 * screen showed when the batch started, shared by every Target.
 */
export interface BatchCandidateSearchRequest {
  targets: readonly TargetWeapon[]
  routeFilter: CandidateRouteFilter
  settings: CandidateSearchSettings
  master: MasterDataRoot
  calculationContext: CalculationContext
  /**
   * 「他の目標武器で使用する所持武器を除外する」 when the batch started
   * (`docs/UI_FLOW.md` 9.1 / 9.2): every Target of the batch uses this value,
   * whatever the screen shows later.
   */
  excludeOtherTargetSources: boolean
}

/**
 * Where a `failed` Target stopped: reading its input (`prepare_input`, which
 * includes deriving the exclusion), the Search itself, saving its Candidate, or
 * the batch's own commit - adding it to the Build List (`add_candidate`,
 * 9.1) or replacing the stale Entry (`replace_entry`, 9.3). None of them
 * changed the Build List.
 */
export type BatchCandidateSearchFailureStage =
  | 'prepare_input'
  | 'search'
  | 'save_candidates'
  | 'add_candidate'
  | 'replace_entry'

/**
 * The outcomes every batch records before its own commit runs: the search
 * found no Candidate, or a stage failed.
 */
export type BatchCandidateSearchCommonOutcome =
  | {
      status: 'no_candidate'
      target: TargetWeapon
      /**
       * The OwnedWeapons this Target's search did not use as a Route base
       * because of the exclusion (the result's `excludedSourceOwnedWeaponIds`,
       * code unit order); empty when the exclusion was off or removed nothing.
       */
      excludedSourceOwnedWeaponIds: OwnedWeaponId[]
    }
  | { status: 'failed'; target: TargetWeapon; failedAt: BatchCandidateSearchFailureStage; message: string }

/**
 * The outcome of one Target of 「未登録を一括検索・追加」. `not_added` carries the
 * `addCandidate()` result status as it came from the Service: the batch never
 * replaces an Entry, never opens the replacement confirmation, and never picks
 * an Entry of a legacy duplicate.
 */
export type BatchCandidateSearchTargetOutcome =
  | BatchCandidateSearchCommonOutcome
  | { status: 'added'; target: TargetWeapon; entry: BuildListEntry }
  | {
      status: 'not_added'
      target: TargetWeapon
      reason: Exclude<AddBuildListCandidateResult['status'], 'added'>
    }

/**
 * How a batch ended. `cancelled` and `aborted` keep every outcome recorded
 * before the stop, and nothing is rolled back. `aborted` is a broken Search
 * Worker (`SearchWorkerRuntimeError`): every later request would fail the same
 * way, so no further Target is started.
 */
export type BatchCandidateSearchTermination =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'aborted'; message: string }

/** A finished batch over its own outcome type. */
export interface BatchCandidateSearchSummaryOf<TOutcome> {
  total: number
  /** The exclusion condition the whole batch ran with (`BatchCandidateSearchRequest`). */
  excludeOtherTargetSources: boolean
  outcomes: TOutcome[]
  /** The Targets never started because the batch stopped first. */
  notStarted: TargetWeapon[]
  termination: BatchCandidateSearchTermination
}

export type BatchCandidateSearchSummary = BatchCandidateSearchSummaryOf<BatchCandidateSearchTargetOutcome>

/**
 * Progress of the Target being searched. `index` is 0-based; `completed` is how
 * many Targets already have an outcome. `search` is the single Search's own
 * progress, never turned into a batch percentage.
 */
export interface BatchCandidateSearchProgress {
  /** The exclusion condition the whole batch runs with (`BatchCandidateSearchRequest`). */
  excludeOtherTargetSources: boolean
  index: number
  total: number
  completed: number
  target: TargetWeapon
  search: CandidateSearchProgress
}

export interface BatchCandidateSearchRunOf<TSummary> {
  readonly promise: Promise<TSummary>
  /**
   * Cancels the running Search through the Worker cancel contract and starts no
   * further Target. A Build List write already in flight completes and is kept.
   */
  cancel(): void
}

export type BatchCandidateSearchRun = BatchCandidateSearchRunOf<BatchCandidateSearchSummary>

/**
 * What one batch does with a found Candidate, once its search result was saved
 * (`docs/UI_FLOW.md` 9.1 / 9.3). `run` returns the Target's outcome; a refusal
 * it means to record as an outcome of its own (a Service result, a typed
 * refusal) is returned, and an exception it lets through is recorded by the
 * loop as `failed` at `stage` with `failureMessage` when the error carries no
 * message of its own. Once started, a commit completes and is kept even when
 * the batch is cancelled meanwhile.
 */
export interface BatchCandidateSearchCommit<TCommit> {
  stage: BatchCandidateSearchFailureStage
  failureMessage: string
  /** `searchedTarget` is the Target the search ran with (its definition describes the Candidate); `target` the batch's own record of it. */
  run(candidate: BuildCandidate, searchedTarget: TargetWeapon, target: TargetWeapon): Promise<TCommit>
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback
}

/**
 * The one search loop every batch of this screen runs (`docs/UI_FLOW.md` 9.1 /
 * 9.3): the ordinary single Candidate Search once per Target, in order, each
 * request covering exactly one Target with its own `searchRunId`, the result
 * saved through the ordinary `saveCandidates()`, and the batch's own commit
 * for a found Candidate. No Search, Candidate or Build List semantics are
 * re-implemented here.
 *
 * A Target with no Candidate, and a Target whose search, save or commit fails,
 * is recorded and the next Target runs. A cancel stops the current Search and
 * starts no other; a broken Worker stops the batch the same way.
 */
export function runBatchCandidateSearchLoop<TCommit>(
  request: BatchCandidateSearchRequest,
  dependencies: BatchCandidateSearchLoopDependencies,
  commit: BatchCandidateSearchCommit<TCommit>,
  onProgress?: (progress: BatchCandidateSearchProgress) => void,
): BatchCandidateSearchRunOf<BatchCandidateSearchSummaryOf<BatchCandidateSearchCommonOutcome | TCommit>> {
  type Outcome = BatchCandidateSearchCommonOutcome | TCommit
  type Summary = BatchCandidateSearchSummaryOf<Outcome>
  let cancelled = false
  let activeRequestId: string | null = null

  const run = async (): Promise<Summary> => {
    const targets = [...request.targets]
    // Fixed at the start: a later change on the screen never reaches this batch.
    const excludeOtherTargetSources = request.excludeOtherTargetSources
    const outcomes: Outcome[] = []
    const stop = (termination: BatchCandidateSearchTermination): Summary => ({
      total: targets.length,
      excludeOtherTargetSources,
      outcomes,
      notStarted: targets.slice(outcomes.length),
      termination,
    })

    for (const [index, target] of targets.entries()) {
      if (cancelled) return stop({ status: 'cancelled' })
      const searchRunId = dependencies.createSearchRunId()
      activeRequestId = searchRunId
      onProgress?.({
        excludeOtherTargetSources,
        index,
        total: targets.length,
        completed: outcomes.length,
        target,
        search: { targetWeaponId: target.id, phase: 'preparing', processedWorkItems: 0 },
      })
      let candidate: BuildCandidate | null
      let excludedSourceOwnedWeaponIds: OwnedWeaponId[]
      let searchedTarget: TargetWeapon
      let stage: BatchCandidateSearchFailureStage = 'prepare_input'
      try {
        // Read from the persisted state now, never from an in-memory record of
        // what earlier Targets of this batch used: only an Entry the commit
        // really persisted is counted by the exclusion (`docs/SEARCH_SPEC.md` 3.3).
        const prepared = await dependencies.prepareInput({
          searchRunId,
          targetWeaponId: target.id,
          routeFilter: request.routeFilter,
          settings: request.settings,
          master: request.master,
          calculationContext: request.calculationContext,
          excludeOtherTargetSources,
        })
        const issue = preparedCandidateSearchInputIssue(prepared, excludeOtherTargetSources)
        if (issue !== null) throw new Error('検索条件（他の目標武器で使用する所持武器の除外）を検索入力へ反映できませんでした。', { cause: issue })
        const { input } = prepared
        if (cancelled) return stop({ status: 'cancelled' })
        stage = 'search'
        const result = await dependencies.client.startSearch(input, {
          onProgress: (search) => {
            if (!cancelled && activeRequestId === searchRunId) {
              onProgress?.({ excludeOtherTargetSources, index, total: targets.length, completed: outcomes.length, target, search })
            }
          },
        })
        // A result that arrives after a cancel is dropped, exactly as the single
        // Search drops a late result: nothing of it is saved.
        if (cancelled) return stop({ status: 'cancelled' })
        candidate = result.targetResult.candidate
        excludedSourceOwnedWeaponIds = [...result.targetResult.excludedSourceOwnedWeaponIds]
        stage = 'save_candidates'
        await dependencies.saveCandidates(target.id, candidate === null ? [] : [candidate])
        // The Target the Search actually ran with, so the new Entry's Target
        // definition hash describes the Candidate.
        searchedTarget = input.targetWeapons.find(({ id }) => id === target.id) ?? target
      } catch (caught: unknown) {
        if (caught instanceof SearchCancelledError || cancelled) return stop({ status: 'cancelled' })
        const message = errorMessage(caught, '検索に失敗しました。')
        outcomes.push({ status: 'failed', target, failedAt: stage, message })
        if (caught instanceof SearchWorkerRuntimeError) return stop({ status: 'aborted', message })
        continue
      } finally {
        activeRequestId = null
      }

      if (candidate === null) {
        outcomes.push({ status: 'no_candidate', target, excludedSourceOwnedWeaponIds })
        continue
      }
      // A cancel during the Candidate save changes nothing further in the Build List.
      if (cancelled) return stop({ status: 'cancelled' })
      try {
        // Once started, the write completes and is kept even when cancelled.
        outcomes.push(await commit.run(candidate, searchedTarget, target))
      } catch (caught: unknown) {
        outcomes.push({
          status: 'failed',
          target,
          failedAt: commit.stage,
          message: errorMessage(caught, commit.failureMessage),
        })
      }
    }
    return stop(cancelled ? { status: 'cancelled' } : { status: 'completed' })
  }

  return {
    promise: run(),
    cancel: () => {
      if (cancelled) return
      cancelled = true
      const requestId = activeRequestId
      if (requestId !== null) dependencies.client.cancelSearch(requestId)
    },
  }
}

/**
 * Runs the ordinary single Candidate Search once per Target, in order, and adds
 * each found Candidate to the Build List through the ordinary addition (a new
 * Entry carries no intermediate state selection, Issue #100). This is a UI /
 * Application orchestration only: every
 * request still covers exactly one Target with its own `searchRunId`, and no
 * Search, Candidate or Build List semantics are re-implemented here.
 *
 * A Target with no Candidate, and a Target whose search, save or addition
 * fails, is recorded and the next Target runs. A cancel stops the current
 * Search and starts no other; a broken Worker stops the batch the same way.
 */
export function runBatchCandidateSearch(
  request: BatchCandidateSearchRequest,
  dependencies: BatchCandidateSearchDependencies,
  onProgress?: (progress: BatchCandidateSearchProgress) => void,
): BatchCandidateSearchRun {
  return runBatchCandidateSearchLoop<Exclude<BatchCandidateSearchTargetOutcome, BatchCandidateSearchCommonOutcome>>(
    request,
    dependencies,
    {
      stage: 'add_candidate',
      failureMessage: '作成リストへの追加に失敗しました。',
      run: async (candidate, searchedTarget, target) => {
        const added = await dependencies.addCandidate(candidate, searchedTarget)
        return added.status === 'added'
          ? { status: 'added', target, entry: added.entry }
          : { status: 'not_added', target, reason: added.status }
      },
    },
    onProgress,
  )
}
