import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import type { RunningPlanReplanAdoptionInspection } from '../../domain/execution/runningPlanReplanAdoption'
import type { RunningPlanReplanAuxiliaryShortfall } from '../../domain/execution/runningPlanReplanAuxiliary'
import type { ReplanTargetSelection } from '../../domain/execution/runningPlanReplanTargets'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlanId } from '../../domain/models/publicTypes'
import type { PlannerOptions, PlannerResult } from '../../domain/planner'
import { createProductionPlannerDependencies } from '../../domain/planner/plannerDependencies'
import { productionRngEngine } from '../../domain/rng/production/productionRngRuntime'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import {
  createProductionPlanExecutionService,
  type AdoptRunningPlanReplanPreviewRequest,
  type AdoptRunningPlanReplanPreviewResult,
  type InspectRunningPlanReplanAdoptionRequest,
  type ProductionPlanExecutionService,
} from './productionPlanExecutionService'
import {
  createRunningPlanReplanAuxiliaryPreparer,
  type RunningPlanReplanAuxiliaryReadyPreparation,
  type RunningPlanReplanAuxiliaryRequestPreparation,
} from './runningPlanReplanAuxiliaryService'
import {
  createRunningPlanReplanPreStartInspector,
  type RunningPlanReplanPreStartInspection,
} from './runningPlanReplanPreStartService'
import {
  createRunningPlanReplanSession,
  createRunningPlanReplanStartReader,
  type RunningPlanReplanSession,
} from './runningPlanReplanService'
import { createProductionRunningPlanReplanWorkerClient } from './runningPlanReplanWorkerClient'

/**
 * The running Plan replan re-optimization as the Build List and the Production Plan page use it (`docs/PLANNER_SPEC.md` 18,
 * `docs/UI_FLOW.md` 16.5, Issue #276 PR-6A). Both screens run the same target confirmation, calculation, Preview, adoption and
 * explicit auxiliary through exactly these calls; the screen never rebuilds a start, a selection's classification, a Preview, an
 * adoption decision or an auxiliary input on its own.
 *
 * The auxiliary's ordinary Planner run, Preview and adoption stay the 16.8 ones (`ProductionPlanReplanDependencies` and the Production
 * Planner Worker); only its press-time input comes from here.
 */
export interface RunningPlanReplanDependencies {
  /** One session per screen mount (PR-4): its start reads, calculates on the dedicated Worker and holds the result. */
  createSession(): RunningPlanReplanSession
  /**
   * The read-only pre-start judgement of the target confirmation of `expectedPlanId`'s replan (display only; the start judges
   * again). Another running Plan is refused (`running_plan_changed`).
   */
  inspectTargets(selection: ReplanTargetSelection, expectedPlanId: ProductionPlanId): Promise<RunningPlanReplanPreStartInspection>
  /**
   * The auxiliary's press-time input (18.5): one fresh read of `expectedPlanId` (the result's own Plan), scoped to the replan
   * Targets' current Entries. Another running Plan is refused (`running_plan_changed`) before anything is prepared.
   */
  prepareAuxiliary(selection: ReplanTargetSelection, options: PlannerOptions, expectedPlanId: ProductionPlanId): Promise<RunningPlanReplanAuxiliaryRequestPreparation>
  /** The replan Targets the auxiliary's ordinary Planner result does not complete, by Target ID and typed reason (18.5). */
  auxiliaryShortfall(prepared: RunningPlanReplanAuxiliaryReadyPreparation, result: PlannerResult): RunningPlanReplanAuxiliaryShortfall
  /** 18.8: the read-only adoption inspection the confirmation dialog is built from. Never write authority. */
  inspectAdoption(request: InspectRunningPlanReplanAdoptionRequest): Promise<RunningPlanReplanAdoptionInspection>
  /** 18.8: the one adoption transaction, or the save point restore alone. */
  adopt(request: AdoptRunningPlanReplanPreviewRequest): Promise<AdoptRunningPlanReplanPreviewResult>
}

export function createProductionRunningPlanReplanDependencies(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
  executionService: ProductionPlanExecutionService = createProductionPlanExecutionService(master, database),
): RunningPlanReplanDependencies {
  const startReader = createRunningPlanReplanStartReader(database, master, createBuildListCalculationContext(master))
  const plannerDependencies = createProductionPlannerDependencies(productionRngEngine)
  const inspector = createRunningPlanReplanPreStartInspector({ startReader, plannerDependencies })
  const auxiliary = createRunningPlanReplanAuxiliaryPreparer({ startReader, plannerDependencies })
  return {
    createSession: () => createRunningPlanReplanSession({ startReader, createClient: createProductionRunningPlanReplanWorkerClient }),
    inspectTargets: (selection, expectedPlanId) => inspector.inspect(selection, expectedPlanId),
    prepareAuxiliary: (selection, options, expectedPlanId) => auxiliary.prepare(selection, options, expectedPlanId),
    auxiliaryShortfall: (prepared, result) => auxiliary.shortfall(prepared, result),
    inspectAdoption: (request) => executionService.inspectRunningPlanReplanAdoption(request),
    adopt: (request) => executionService.adoptRunningPlanReplanPreview(request),
  }
}
