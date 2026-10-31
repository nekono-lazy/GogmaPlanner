import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  deriveRunningPlanReplanAuxiliaryShortfall,
  prepareRunningPlanReplanAuxiliaryInput,
  type RunningPlanReplanAuxiliaryPreparation,
  type RunningPlanReplanAuxiliaryShortfall,
} from '../../domain/execution/runningPlanReplanAuxiliary'
import type { ReplanTargetSelection } from '../../domain/execution/runningPlanReplanTargets'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlanId } from '../../domain/models/publicTypes'
import type { PlannerDependencies, PlannerOptions, PlannerResult } from '../../domain/planner'
import { createProductionPlannerDependencies } from '../../domain/planner/plannerDependencies'
import { productionRngEngine } from '../../domain/rng/production/productionRngRuntime'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import {
  createRunningPlanReplanStartReader,
  runningPlanIdentityRefusalOf,
  type RunningPlanReplanRefusal,
  type RunningPlanReplanStartReader,
} from './runningPlanReplanService'

/**
 * The Application half of the running Plan replan's explicit auxiliary (`docs/PLANNER_SPEC.md` 18.5 「補助導線（登録済みの候補での再計画）」,
 * Issue #276 PR-5): the ordinary Planner over the replan target set's registered Routes, prepared only when the user presses it.
 *
 * Each press reads the current state through PR-4's start reader (one read-only transaction: the running Plan, its 18.5 per-old-Plan
 * availability, PR-2's replan target set with the user's selection and the fresh `createPlannerInput()` value) and judges that fresh
 * state again (`prepareRunningPlanReplanAuxiliaryInput()`): a refused start, an empty replan target set, an input that fails closed as a
 * whole and an invalid 「最大計画ステップ数」 prepare nothing. The prepared input is the ordinary 16.8 replan Preview request scoped to the
 * replan Targets' current Entries, so the caller runs the ordinary Planner Worker entry and the unchanged 16.8 Preview and adoption
 * (which writes no BuildListEntry). This module runs no Planner, writes nothing, starts nothing by itself and is never an automatic
 * fallback of the re-optimization. Since Issue #276 PR-6A the screens reach it through `createProductionRunningPlanReplanDependencies()`.
 */

export type RunningPlanReplanAuxiliaryRequestPreparation =
  /** The running Plan or the selection allows no replan at all (18.5 per old Plan, 18.2): no auxiliary either. */
  | { kind: 'refused'; refusal: RunningPlanReplanRefusal }
  | RunningPlanReplanAuxiliaryPreparation

export type RunningPlanReplanAuxiliaryReadyPreparation = Extract<RunningPlanReplanAuxiliaryPreparation, { kind: 'ready' }>

export interface RunningPlanReplanAuxiliaryPreparer {
  /**
   * Prepares the auxiliary's input from the current persisted state for the user's runtime-only `selection` and their
   * 「最大計画ステップ数」 (`options`). A read failure or a missing RngState throws (fail closed); every other outcome is typed.
   *
   * `expectedPlanId` is the Plan of the re-optimization result the auxiliary sits in (`runningPlanToken.planId` of its start): the
   * fresh read must find that very Plan running, or the auxiliary is refused (`running_plan_changed`) before anything is prepared.
   */
  prepare(selection: ReplanTargetSelection, options: PlannerOptions, expectedPlanId: ProductionPlanId): Promise<RunningPlanReplanAuxiliaryRequestPreparation>
  /**
   * The replan Targets the auxiliary's ordinary Planner `result` over `prepared` does not complete, by Target ID and typed reason
   * (18.5: shown before adopting, so a partial result is never read as "every Target made").
   */
  shortfall(prepared: RunningPlanReplanAuxiliaryReadyPreparation, result: PlannerResult): RunningPlanReplanAuxiliaryShortfall
}

export interface RunningPlanReplanAuxiliaryPreparerDependencies {
  startReader: RunningPlanReplanStartReader
  /** The main-thread Planner dependencies, for the support queries of the input judgement only (nothing is predicted). */
  plannerDependencies: PlannerDependencies
}

export function createRunningPlanReplanAuxiliaryPreparer(dependencies: RunningPlanReplanAuxiliaryPreparerDependencies): RunningPlanReplanAuxiliaryPreparer {
  return {
    prepare: async (selection, options, expectedPlanId) => {
      const preparation = await dependencies.startReader.read(selection, expectedPlanId)
      if (preparation.status === 'refused') return { kind: 'refused', refusal: preparation.refusal }
      const { start } = preparation
      const identityRefusal = runningPlanIdentityRefusalOf(start, expectedPlanId)
      if (identityRefusal !== null) return { kind: 'refused', refusal: identityRefusal }
      return prepareRunningPlanReplanAuxiliaryInput(
        { runningPlanToken: start.runningPlanToken, replanTargets: start.replanTargets, plannerInput: start.plannerInput },
        options,
        dependencies.plannerDependencies,
      )
    },
    shortfall: (prepared, result) => deriveRunningPlanReplanAuxiliaryShortfall(prepared, result, dependencies.plannerDependencies),
  }
}

/** The Production preparer over the loaded Master Data (the screens use `createProductionRunningPlanReplanDependencies()`, Issue #276 PR-6A). */
export function createProductionRunningPlanReplanAuxiliaryPreparer(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
): RunningPlanReplanAuxiliaryPreparer {
  return createRunningPlanReplanAuxiliaryPreparer({
    startReader: createRunningPlanReplanStartReader(database, master, createBuildListCalculationContext(master)),
    plannerDependencies: createProductionPlannerDependencies(productionRngEngine),
  })
}
