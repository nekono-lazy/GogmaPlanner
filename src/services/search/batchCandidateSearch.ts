import { isTargetWeaponPlanningEligible } from '../../domain/models/domainRules'
import type {
  BuildCandidate,
  BuildListEntry,
  CalculationContext,
  IntermediateStateSelection,
  OwnedWeaponId,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  CandidateRouteFilter,
  CandidateSearchProgress,
  CandidateSearchSettings,
} from '../../domain/search'
import { defaultIntermediateStateSelection, findBuildListRegisteredTargetIds } from '../../domain/buildList'
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
 * The existing single Candidate Search authorities a batch reuses unchanged:
 * one `prepareInput()` + `client.startSearch()` per Target, the ordinary
 * `saveCandidates()` of that Target's result, and the ordinary
 * `BuildListService.addCandidate()`.
 */
export interface BatchCandidateSearchDependencies {
  client: SearchWorkerClient
  createSearchRunId(): string
  /**
   * One Target's input, read from the persisted state right before its search
   * (`prepareCandidateSearchInput()`). With the exclusion on, the excluded set
   * is derived from that read, so an Entry an earlier Target of this batch
   * added is already counted (`docs/SEARCH_SPEC.md` 3.3「一括検索・追加」).
   */
  prepareInput(options: PrepareCandidateSearchInputOptions): Promise<PreparedCandidateSearchInput>
  saveCandidates(targetId: TargetWeapon['id'], candidates: BuildCandidate[]): Promise<unknown>
  addCandidate(
    candidate: BuildCandidate,
    target: TargetWeapon,
    intermediateStateSelection: IntermediateStateSelection,
  ): Promise<AddBuildListCandidateResult>
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
 * adding it to the Build List. None of them added an Entry.
 */
export type BatchCandidateSearchFailureStage = 'prepare_input' | 'search' | 'save_candidates' | 'add_candidate'

/**
 * The outcome of one Target. `not_added` carries the `addCandidate()` result
 * status as it came from the Service: the batch never replaces an Entry, never
 * opens the replacement confirmation, and never picks an Entry of a legacy
 * duplicate.
 */
export type BatchCandidateSearchTargetOutcome =
  | { status: 'added'; target: TargetWeapon; entry: BuildListEntry }
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
  | {
      status: 'not_added'
      target: TargetWeapon
      reason: Exclude<AddBuildListCandidateResult['status'], 'added'>
    }

/**
 * How the batch ended. `cancelled` and `aborted` keep every outcome recorded
 * before the stop, and nothing is rolled back. `aborted` is a broken Search
 * Worker (`SearchWorkerRuntimeError`): every later request would fail the same
 * way, so no further Target is started.
 */
export type BatchCandidateSearchTermination =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'aborted'; message: string }

export interface BatchCandidateSearchSummary {
  total: number
  /** The exclusion condition the whole batch ran with (`BatchCandidateSearchRequest`). */
  excludeOtherTargetSources: boolean
  outcomes: BatchCandidateSearchTargetOutcome[]
  /** The Targets never started because the batch stopped first. */
  notStarted: TargetWeapon[]
  termination: BatchCandidateSearchTermination
}

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

export interface BatchCandidateSearchRun {
  readonly promise: Promise<BatchCandidateSearchSummary>
  /**
   * Cancels the running Search through the Worker cancel contract and starts no
   * further Target. A Build List write already in flight completes and is kept.
   */
  cancel(): void
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback
}

/**
 * Runs the ordinary single Candidate Search once per Target, in order, and adds
 * each found canonical Ideal to the Build List with
 * `defaultIntermediateStateSelection()` (no intermediate state, improvement
 * preference `planner`). This is a UI / Application orchestration only: every
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
  let cancelled = false
  let activeRequestId: string | null = null

  const run = async (): Promise<BatchCandidateSearchSummary> => {
    const targets = [...request.targets]
    // Fixed at the start: a later change on the screen never reaches this batch.
    const excludeOtherTargetSources = request.excludeOtherTargetSources
    const outcomes: BatchCandidateSearchTargetOutcome[] = []
    const stop = (termination: BatchCandidateSearchTermination): BatchCandidateSearchSummary => ({
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
        // what earlier Targets of this batch used: only an Entry `addCandidate()`
        // really added is counted by the exclusion (`docs/SEARCH_SPEC.md` 3.3).
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
      // A cancel during the Candidate save adds nothing further to the Build List.
      if (cancelled) return stop({ status: 'cancelled' })
      try {
        // Once started, the write completes and is kept even when cancelled.
        const added = await dependencies.addCandidate(
          candidate,
          searchedTarget,
          defaultIntermediateStateSelection(),
        )
        outcomes.push(
          added.status === 'added'
            ? { status: 'added', target, entry: added.entry }
            : { status: 'not_added', target, reason: added.status },
        )
      } catch (caught: unknown) {
        outcomes.push({
          status: 'failed',
          target,
          failedAt: 'add_candidate',
          message: errorMessage(caught, '作成リストへの追加に失敗しました。'),
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
