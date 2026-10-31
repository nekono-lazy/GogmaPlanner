import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  BuildListEntryRepository,
  NormalArtianCounterRepository,
  OwnedWeaponRepository,
  ProductionPlanRepository,
  RngStateRepository,
  TargetWeaponRepository,
} from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import {
  selectBuildListResearchTargets,
  type BuildListResearchSelection,
} from '../../domain/buildList'
import { PlanBreakingChangeApprovalRequiredError } from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import {
  BuildListStaleCandidateReplacementError,
  type BuildListStaleCandidateReplacementErrorCode,
  type BuildListStaleCandidateReplacementRequest,
} from '../buildList/buildListService'
import {
  runBatchCandidateSearchLoop,
  type BatchCandidateSearchCommonOutcome,
  type BatchCandidateSearchLoopDependencies,
  type BatchCandidateSearchProgress,
  type BatchCandidateSearchRequest,
  type BatchCandidateSearchRunOf,
  type BatchCandidateSearchSummaryOf,
} from './batchCandidateSearch'

/**
 * 「再検索が必要な候補を一括再検索・置換」 (`docs/UI_FLOW.md` 9.3, Issue #347): the
 * Application side. The selection of Targets is the Domain's
 * (`selectBuildListResearchTargets()`), read here from the persisted state;
 * the batch is the shared search loop of 9.1 with the stale Entry's re-search
 * replacement (`BuildListService.replaceStaleCandidate()`) as its commit.
 */

export interface BuildListResearchSelectionReader {
  /**
   * Reads RngState, every Normal Artian Counter, OwnedWeapon, TargetWeapon,
   * BuildListEntry and the running Plan as one snapshot of the persisted
   * state and selects the Targets to re-search from it. A read failure - two
   * running Plans included - throws (fail closed): a partial selection is
   * never returned, and the screen then offers no batch.
   */
  read(): Promise<BuildListResearchSelection>
}

/**
 * The Dexie reader. It first makes sure the RngState exists (creating the
 * initial record when it does not, in its own transaction, exactly like the
 * search input), then reads the six tables in one read-only transaction so the
 * staleness, the cardinality and the running Plan are judged over one state.
 * The CalculationContext is the Build List's (`createBuildListCalculationContext()`),
 * the same the Build List screen refreshes its staleness with.
 */
export function createBuildListResearchSelectionReader(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
): BuildListResearchSelectionReader {
  const rngStates = new RngStateRepository(database)
  const normalCounters = new NormalArtianCounterRepository(database)
  const ownedWeapons = new OwnedWeaponRepository(database)
  const targetWeapons = new TargetWeaponRepository(database)
  const buildListEntries = new BuildListEntryRepository(database)
  const productionPlans = new ProductionPlanRepository(database)
  const calculationContext = createBuildListCalculationContext(master)
  return {
    read: async () => {
      await rngStates.ensureInitialRngState()
      try {
        return await database.transaction(
          'r',
          [
            database.rngState,
            database.normalArtianCounters,
            database.ownedWeapons,
            database.targetWeapons,
            database.buildListEntries,
            database.productionPlans,
          ],
          async (): Promise<BuildListResearchSelection> => {
            const [rngState, counters, weapons, targets, entries, runningPlan] = await Promise.all([
              rngStates.getCurrentRngState(),
              normalCounters.getAllNormalArtianCounters(),
              ownedWeapons.getAllOwnedWeapons(),
              targetWeapons.getAllTargetWeapons(),
              buildListEntries.getAllBuildListEntries(),
              productionPlans.getRunningProductionPlan(),
            ])
            if (rngState === undefined) {
              throw new RepositoryError('not_found', 'No RngState is stored, so no Build List staleness can be judged.')
            }
            return selectBuildListResearchTargets({
              targetWeapons: targets,
              buildListEntries: entries,
              rngState,
              normalCounters: counters,
              ownedWeapons: weapons,
              calculationContext,
              runningPlan: runningPlan ?? null,
            })
          },
        )
      } catch (error: unknown) {
        if (error instanceof RepositoryError) throw error
        throw new RepositoryError('transaction_failed', 'Reading the Build List re-search selection failed.', { cause: error })
      }
    },
  }
}

/** One Target of the batch: the Target and the stale Entry the user saw in the confirmation. */
export interface BatchCandidateResearchTarget {
  target: TargetWeapon
  entry: BuildListEntry
}

/**
 * One batch: the Targets with their stale Entries (already selected and
 * confirmed) and the search conditions the screen showed when the batch
 * started, shared by every Target.
 */
export interface BatchCandidateResearchRequest extends Omit<BatchCandidateSearchRequest, 'targets'> {
  targets: readonly BatchCandidateResearchTarget[]
}

export interface BatchCandidateResearchDependencies extends BatchCandidateSearchLoopDependencies {
  /**
   * The stale Entry's re-search replacement
   * (`BuildListService.replaceStaleCandidate()`): one guarded transaction with
   * no approval, so a replacement that would break the `active` Plan is refused
   * with `PlanBreakingChangeApprovalRequiredError` and nothing is written.
   */
  replaceStaleCandidate(request: BuildListStaleCandidateReplacementRequest): Promise<BuildListEntry>
}

/**
 * Why a found Candidate did not replace the stale Entry, which stays exactly
 * as persisted: the replacement would break the `active` Plan
 * (`plan_approval_required` - the batch never approves; the single search's
 * confirmed replacement does), or the Service refused it by typed code.
 */
export type BatchCandidateResearchRefusalReason =
  | 'plan_approval_required'
  | BuildListStaleCandidateReplacementErrorCode

/** The outcome of one Target of 「再検索が必要な候補を一括再検索・置換」. Only `replaced` changed the Build List. */
export type BatchCandidateResearchTargetOutcome =
  | BatchCandidateSearchCommonOutcome
  | { status: 'replaced'; target: TargetWeapon; entry: BuildListEntry; replacedEntryId: BuildListEntryId }
  | { status: 'not_replaced'; target: TargetWeapon; reason: BatchCandidateResearchRefusalReason }

export type BatchCandidateResearchSummary = BatchCandidateSearchSummaryOf<BatchCandidateResearchTargetOutcome>

export type BatchCandidateResearchRun = BatchCandidateSearchRunOf<BatchCandidateResearchSummary>

/**
 * Runs the ordinary single Candidate Search once per Target, in order, and
 * replaces each Target's stale Entry with a new Entry of the found Candidate
 * through the re-search replacement (`docs/DATA_MODEL.md` 9.4.1 「再検索による
 * 置換」). The stale Entry is never deleted first: a Target with no Candidate,
 * a failed search, save or replacement, a refused replacement and a Target the
 * batch never reached all keep their Entry exactly as persisted, and only a
 * found Candidate replaces it, Entry by Entry, in one transaction each. A
 * cancel stops the current Search and starts no other; a replacement already
 * in flight completes and is kept.
 */
export function runBatchCandidateResearch(
  request: BatchCandidateResearchRequest,
  dependencies: BatchCandidateResearchDependencies,
  onProgress?: (progress: BatchCandidateSearchProgress) => void,
): BatchCandidateResearchRun {
  // The Entry the user saw for each Target, fixed when the batch started: the
  // replacement names it, and the Service refuses when it is no longer the
  // Target's one Entry.
  const expectedEntryIds = new Map<TargetWeaponId, BuildListEntryId>(
    request.targets.map(({ target, entry }) => [target.id, entry.id]),
  )
  return runBatchCandidateSearchLoop<Exclude<BatchCandidateResearchTargetOutcome, BatchCandidateSearchCommonOutcome>>(
    { ...request, targets: request.targets.map(({ target }) => target) },
    dependencies,
    {
      stage: 'replace_entry',
      failureMessage: '作成リストの候補の置き換えに失敗しました。',
      run: async (candidate, searchedTarget, target) => {
        const expectedExistingEntryId = expectedEntryIds.get(target.id)
        if (expectedExistingEntryId === undefined) {
          throw new Error(`The batch holds no Build List Entry for TargetWeapon '${target.id}'.`)
        }
        try {
          const entry = await dependencies.replaceStaleCandidate({ candidate, target: searchedTarget, expectedExistingEntryId })
          return { status: 'replaced', target, entry, replacedEntryId: expectedExistingEntryId }
        } catch (caught: unknown) {
          if (caught instanceof PlanBreakingChangeApprovalRequiredError) {
            return { status: 'not_replaced', target, reason: 'plan_approval_required' }
          }
          if (caught instanceof BuildListStaleCandidateReplacementError) {
            return { status: 'not_replaced', target, reason: caught.code }
          }
          throw caught
        }
      },
    },
    onProgress,
  )
}
