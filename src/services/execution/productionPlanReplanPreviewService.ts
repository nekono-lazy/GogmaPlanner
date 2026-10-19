import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  BuildListEntryRepository,
  NormalArtianCounterRepository,
  OwnedWeaponRepository,
  TargetWeaponRepository,
} from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import {
  ExecutionRuntimeError,
  createProductionPlanReplanPreview,
  createReplanRunningPlanToken,
  executionFailure,
  type ProductionPlanReplanPreview,
  type ProductionPlanReplanPreviewRequest,
} from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  CalculationContext,
  ProductionPlanId,
} from '../../domain/models/publicTypes'
import type { PlannerResult } from '../../domain/planner'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import {
  createPlannerInput,
  type PlannerInputRepositories,
} from '../planner/createPlannerInput'

export interface ProductionPlanReplanPreviewServiceDependencies {
  database: AppDatabase
  /** The loaded Master Data `createPlannerInput()` takes its Planner subset from. */
  master: MasterDataRoot
  /** The CalculationContext the Preview is calculated under. */
  currentCalculationContext: CalculationContext
}

export interface PrepareProductionPlanReplanPreviewRequest {
  runningPlanId: ProductionPlanId
}

/**
 * 「現在地点から再計画を試算」 (`docs/PLANNER_SPEC.md` 16.8, `docs/UI_FLOW.md`
 * 16.4), the side-effect-free half.
 *
 * `prepareProductionPlanReplanPreview()` reads, in one read-only transaction,
 * the running Plan's token and a PlannerInput built by the ordinary
 * `createPlannerInput()` from the current confirmed RngState, Normal Counters,
 * OwnedWeapons, TargetWeapons and Build List. It never reads the running Plan's
 * `baseSnapshot`, expected states, past PlannerInput or repair lineage, and
 * never copies its conflict resolutions: the replan is an ordinary
 * current-state Planner run with no conflict resolution.
 *
 * The caller then runs the ordinary Planner Worker entry
 * (`PlannerWorkerClient.createPlan()`, cancellable through `cancelPlan()`;
 * Phase 6-A) and bundles the `PlannerResult` with
 * `createProductionPlanReplanPreview()`. Nothing is written at any point: the
 * Preview and its new draft Plan stay in memory until the Execution runtime
 * adopts them, and no BuildListEntry is ever generated for it.
 */
export class ProductionPlanReplanPreviewService {
  private readonly dependencies: ProductionPlanReplanPreviewServiceDependencies

  constructor(dependencies: ProductionPlanReplanPreviewServiceDependencies) {
    this.dependencies = dependencies
  }

  async prepareProductionPlanReplanPreview(
    request: PrepareProductionPlanReplanPreviewRequest,
  ): Promise<ProductionPlanReplanPreviewRequest> {
    const { database, master, currentCalculationContext } = this.dependencies
    try {
      return await database.transaction(
        'r',
        [
          database.productionPlans,
          database.rngState,
          database.normalArtianCounters,
          database.ownedWeapons,
          database.targetWeapons,
          database.buildListEntries,
        ],
        async () => {
          const plan = await database.productionPlans.get(request.runningPlanId)
          if (!plan) {
            executionFailure('plan_not_found', `ProductionPlan '${request.runningPlanId}' was not found.`)
          }
          const runningPlanToken = createReplanRunningPlanToken(plan)
          const plannerInput = await createPlannerInput(
            master,
            currentCalculationContext,
            readOnlyPlannerInputRepositories(database),
          )
          return {
            runningPlanToken,
            plannerInput,
            calculationContext: { ...currentCalculationContext },
          }
        },
      )
    } catch (error: unknown) {
      if (error instanceof ExecutionRuntimeError || error instanceof RepositoryError) throw error
      throw new RepositoryError(
        'transaction_failed',
        'Reading the replan Preview input failed.',
        { cause: error },
      )
    }
  }

  /** Bundles the Planner Worker result into the transient Preview. It writes nothing. */
  createProductionPlanReplanPreview(
    request: ProductionPlanReplanPreviewRequest,
    result: PlannerResult,
  ): ProductionPlanReplanPreview {
    return createProductionPlanReplanPreview(request, result)
  }
}

/**
 * The ordinary `createPlannerInput()` repositories, read inside the read-only
 * Preview transaction. The only difference is the RngState: a running Plan
 * always has one, so a missing RngState refuses the Preview instead of
 * creating an initial state.
 */
function readOnlyPlannerInputRepositories(database: AppDatabase): PlannerInputRepositories {
  const normalCounters = new NormalArtianCounterRepository(database)
  const ownedWeapons = new OwnedWeaponRepository(database)
  const targetWeapons = new TargetWeaponRepository(database)
  const buildListEntries = new BuildListEntryRepository(database)
  return {
    ensureInitialRngState: async () => {
      const rngState = await database.rngState.get('current')
      if (!rngState) {
        executionFailure('replan_preview_not_allowed', 'No RngState is stored, so no replan Preview can be calculated.')
      }
      return rngState
    },
    getAllNormalArtianCounters: () => normalCounters.getAllNormalArtianCounters(),
    getAllOwnedWeapons: () => ownedWeapons.getAllOwnedWeapons(),
    getAllTargetWeapons: () => targetWeapons.getAllTargetWeapons(),
    getAllBuildListEntries: () => buildListEntries.getAllBuildListEntries(),
  }
}

/** The Production replan Preview runtime over the loaded Master Data. */
export function createProductionPlanReplanPreviewService(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
): ProductionPlanReplanPreviewService {
  return new ProductionPlanReplanPreviewService({
    database,
    master,
    currentCalculationContext: createBuildListCalculationContext(master),
  })
}
