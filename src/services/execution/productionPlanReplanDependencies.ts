import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import type {
  ProductionPlanReplanAdoptionOptions,
  ProductionPlanReplanPreview,
  ProductionPlanReplanPreviewRequest,
} from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { PlannerResult } from '../../domain/planner'
import {
  createProductionPlanExecutionService,
  type AdoptProductionPlanReplanPreviewRequest,
  type AdoptProductionPlanReplanPreviewResult,
  type InspectProductionPlanReplanAdoptionRequest,
  type ProductionPlanExecutionService,
} from './productionPlanExecutionService'
import {
  createProductionPlanReplanPreviewService,
  type PrepareProductionPlanReplanPreviewRequest,
  type ProductionPlanReplanPreviewService,
} from './productionPlanReplanPreviewService'

/**
 * The 16.8 replan runtime as the Build List and the Production Plan page use
 * it (`docs/UI_FLOW.md` 16.4). Both screens run the same Preview and adoption
 * flow through exactly these four calls; the UI never rebuilds the Preview
 * request, the running Plan token or the adoption decision on its own.
 */
export interface ProductionPlanReplanDependencies {
  /** The Preview input, read in one read-only transaction from the current persisted state. */
  prepareProductionPlanReplanPreview(
    request: PrepareProductionPlanReplanPreviewRequest,
  ): Promise<ProductionPlanReplanPreviewRequest>
  /** Bundles the ordinary Planner Worker result into the transient Preview; it writes nothing. */
  createProductionPlanReplanPreview(
    request: ProductionPlanReplanPreviewRequest,
    result: PlannerResult,
  ): ProductionPlanReplanPreview
  /** The read-only inspection the adoption confirmation is built from (16.10). */
  inspectProductionPlanReplanAdoption(
    request: InspectProductionPlanReplanAdoptionRequest,
  ): Promise<ProductionPlanReplanAdoptionOptions>
  /** 「この再計画を採用」: one runtime transaction, or the save point restore alone. */
  adoptProductionPlanReplanPreview(
    request: AdoptProductionPlanReplanPreviewRequest,
  ): Promise<AdoptProductionPlanReplanPreviewResult>
}

export function createProductionPlanReplanDependencies(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
  executionService: ProductionPlanExecutionService = createProductionPlanExecutionService(master, database),
  previewService: ProductionPlanReplanPreviewService = createProductionPlanReplanPreviewService(master, database),
): ProductionPlanReplanDependencies {
  return {
    prepareProductionPlanReplanPreview: (request) => previewService.prepareProductionPlanReplanPreview(request),
    createProductionPlanReplanPreview: (request, result) =>
      previewService.createProductionPlanReplanPreview(request, result),
    inspectProductionPlanReplanAdoption: (request) => executionService.inspectProductionPlanReplanAdoption(request),
    adoptProductionPlanReplanPreview: (request) => executionService.adoptProductionPlanReplanPreview(request),
  }
}
