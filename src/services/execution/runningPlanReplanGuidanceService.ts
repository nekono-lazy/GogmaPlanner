import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import { ExecutionHistoryRepository, ProductionPlanRepository } from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import {
  deriveReplanAdditionalCandidates,
  deriveReplanProposalAfterBuildListChange,
  deriveReplanTargetSet,
  deriveRunningPlanReplanAvailability,
  emptyReplanTargetSelection,
  ExecutionRuntimeError,
  runningProductionPlanIdOf,
  type ReplanProposal,
  type ReplanProposalBuildListChange,
} from '../../domain/execution'
import type {
  BuildListEntry,
  BuildListEntryId,
  ExecutionHistory,
  NormalArtianCounter,
  ProductionPlan,
  ProductionPlanId,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'

/**
 * The read-only guidance around the running Plan replan (`docs/PLANNER_SPEC.md` 18.3, `docs/UI_FLOW.md` 9 / 10 / 16.3 / 16.5, Issue #276
 * PR-6B): whether a Build List save just made proposes a replan, how many additional candidates the Build List holds, and whether the
 * breaking-change warning may offer to exclude a Target in a replan instead of saving the change.
 *
 * Every call reads the persisted state it needs in one read-only transaction and applies PR-2's Domain derivations to that one read
 * (`deriveRunningPlanReplanAvailability()`, `deriveReplanTargetSet()`, `deriveReplanAdditionalCandidates()`,
 * `deriveReplanProposalAfterBuildListChange()`); nothing here classifies, counts or judges availability on its own. It writes nothing,
 * starts no calculation, and never persists a proposal, a closed proposal or a selection (18.12 R1). A failed read throws: an unknown
 * state is never read as "no running Plan" or "nothing to propose" - the caller shows no guidance then.
 */

/** The Build List's passive count (18.3): the additional candidates of the Plan the screen shows, or no count at all. */
export type RunningPlanReplanAdditionalCandidates =
  | { kind: 'counted'; planId: ProductionPlanId; targetWeaponIds: readonly TargetWeaponId[] }
  /**
   * No count is shown: no running Plan, several, another Plan than the screen's, or a running Plan that allows no replan now (18.5,
   * per old Plan: operation unknown, re-identification pending, planned Targets unknown).
   */
  | { kind: 'not_counted' }

export interface RunningPlanReplanGuidanceReader {
  /** The Build List as persisted now: the "before" of the next save whose proposal is asked (18.3). */
  readBuildListEntryIds(): Promise<BuildListEntryId[]>
  /**
   * The proposal of one Build List save, from the state persisted right after it (`deriveReplanProposalAfterBuildListChange()`).
   * `buildListEntriesBefore` is the Build List read before the operation started.
   */
  proposeAfterBuildListChange(
    change: ReplanProposalBuildListChange,
    buildListEntriesBefore: readonly Pick<BuildListEntry, 'id'>[],
  ): Promise<ReplanProposal>
  /** The additional candidates of `expectedPlanId`'s replan (18.2 / 18.3); never the count of another running Plan. */
  inspectAdditionalCandidates(expectedPlanId: ProductionPlanId): Promise<RunningPlanReplanAdditionalCandidates>
  /**
   * Whether a replan of `planId` could leave `targetWeaponId` out (18.3 「Planを壊す変更（16.6）との関係」): `planId` is the one running
   * Plan, it allows a replan now (18.5, per old Plan), and the Target is a `continuing` one of its replan target set (18.2). Display
   * only: the replan's own reads judge again, and the warning, its approval and its save are untouched.
   */
  canExcludeInReplan(planId: ProductionPlanId, targetWeaponId: TargetWeaponId): Promise<boolean>
}

interface ReplanGuidanceSnapshot {
  productionPlans: ProductionPlan[]
  executionHistory: ExecutionHistory[]
  rngState: RngState | null
  normalCounters: NormalArtianCounter[]
  targetWeapons: TargetWeapon[]
  buildListEntries: BuildListEntry[]
}

async function readSnapshot(database: AppDatabase): Promise<ReplanGuidanceSnapshot> {
  try {
    return await database.transaction(
      'r',
      [database.productionPlans, database.executionHistory, database.rngState, database.normalArtianCounters, database.targetWeapons, database.buildListEntries],
      async (): Promise<ReplanGuidanceSnapshot> => {
        const productionPlans = await new ProductionPlanRepository(database).getAllProductionPlans()
        return {
          productionPlans,
          // The metadata only (`docs/DATA_MODEL.md` 14.6), judged for the one running Plan.
          executionHistory: await new ExecutionHistoryRepository(database).getAllExecutionHistory({
            kind: 'plan',
            planId: runningProductionPlanIdOf(productionPlans),
          }),
          rngState: (await database.rngState.get('current')) ?? null,
          normalCounters: await database.normalArtianCounters.toArray(),
          targetWeapons: await database.targetWeapons.toArray(),
          buildListEntries: await database.buildListEntries.toArray(),
        }
      },
    )
  } catch (error: unknown) {
    if (error instanceof RepositoryError || error instanceof ExecutionRuntimeError) throw error
    throw new RepositoryError('transaction_failed', 'Reading the running Plan replan guidance state failed.', { cause: error })
  }
}

export function createRunningPlanReplanGuidanceReader(database: AppDatabase = appDatabase): RunningPlanReplanGuidanceReader {
  return {
    readBuildListEntryIds: async () => {
      try {
        return (await database.buildListEntries.toCollection().primaryKeys()) as BuildListEntryId[]
      } catch (error: unknown) {
        throw new RepositoryError('transaction_failed', 'Reading the Build List failed.', { cause: error })
      }
    },
    proposeAfterBuildListChange: async (change, buildListEntriesBefore) => {
      const after = await readSnapshot(database)
      return deriveReplanProposalAfterBuildListChange({ change, buildListEntriesBefore, after })
    },
    inspectAdditionalCandidates: async (expectedPlanId) => {
      const snapshot = await readSnapshot(database)
      const availability = deriveRunningPlanReplanAvailability(snapshot)
      if (availability.kind !== 'available' || availability.plan.id !== expectedPlanId) return { kind: 'not_counted' }
      const candidates = deriveReplanAdditionalCandidates({
        plan: availability.plan,
        targetWeapons: snapshot.targetWeapons,
        buildListEntries: snapshot.buildListEntries,
      })
      return candidates.kind === 'derived'
        ? { kind: 'counted', planId: availability.plan.id, targetWeaponIds: candidates.targetWeaponIds }
        : { kind: 'not_counted' }
    },
    canExcludeInReplan: async (planId, targetWeaponId) => {
      const snapshot = await readSnapshot(database)
      const availability = deriveRunningPlanReplanAvailability(snapshot)
      if (availability.kind !== 'available' || availability.plan.id !== planId) return false
      const derivation = deriveReplanTargetSet({
        plan: availability.plan,
        targetWeapons: snapshot.targetWeapons,
        buildListEntries: snapshot.buildListEntries,
        selection: emptyReplanTargetSelection,
      })
      return derivation.kind === 'derived'
        && derivation.classification.rows.some((row) => row.targetWeaponId === targetWeaponId && row.category === 'continuing')
    },
  }
}
