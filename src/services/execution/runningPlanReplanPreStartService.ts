import { RepositoryError } from '../../db/repositoryError'
import { ExecutionRuntimeError } from '../../domain/execution/executionRuntimeError'
import {
  prepareRunningPlanReplanOptimization,
  type RunningPlanReplanOptimizationUnsupportedReason,
} from '../../domain/execution/runningPlanReplanOptimization'
import type { ReplanTargetSelection } from '../../domain/execution/runningPlanReplanTargets'
import type { ProductionPlanId } from '../../domain/models/publicTypes'
import type { PlannerDependencies } from '../../domain/planner'
import {
  runningPlanIdentityRefusalOf,
  type RunningPlanReplanRefusal,
  type RunningPlanReplanStart,
  type RunningPlanReplanStartPreparation,
  type RunningPlanReplanStartReader,
} from './runningPlanReplanService'

/**
 * The read-only pre-start judgement of the running Plan replan's target confirmation (`docs/PLANNER_SPEC.md` 18.2 / 18.5,
 * `docs/UI_FLOW.md` 16.5 「1. 目標の確認」, Issue #276 PR-6A).
 *
 * One call reads the current persisted state through PR-4's start reader (one read-only transaction: the running Plan, its 18.5
 * per-old-Plan availability, PR-2's replan target set with the user's runtime-only selection and the fresh `createPlannerInput()`
 * value) and applies Stage 0R's own input conditions (`prepareRunningPlanReplanOptimization()`) to that very read. It is display only:
 * the calculation's start reads and judges again (18.5 「開始前の表示は実行のauthorityではなく、開始を押した時点のfresh inputで判定し直す」),
 * nothing is calculated, nothing is written, and no outcome starts a calculation or the ordinary Planner by itself.
 *
 * The read names the Plan the replan was opened for (`expectedPlanId`): another running Plan is `running_plan_changed`, so its
 * classification and availability are never shown for the opened Plan.
 */

/** Stage 0R's input conditions over the read replan target set: ready, or every reason that holds (18.5). */
export type RunningPlanReplanPreStartInputConditions =
  | { kind: 'ready' }
  | { kind: 'unsupported'; reasons: RunningPlanReplanOptimizationUnsupportedReason[] }

export type RunningPlanReplanPreStartInspection =
  /** The state could not be read (a read failure, a missing RngState, a broken invariant): never read as "no running Plan". */
  | { kind: 'read_failed'; code: string; message: string }
  /** The running Plan or the selection allows no replan (18.5 per old Plan, 18.2). */
  | { kind: 'refused'; refusal: RunningPlanReplanRefusal }
  /** The input judgement broke a contract: never read as an unsupported input. */
  | { kind: 'judgement_failed'; message: string }
  | { kind: 'ready'; start: RunningPlanReplanStart; inputConditions: RunningPlanReplanPreStartInputConditions }

export interface RunningPlanReplanPreStartInspector {
  /** Reads and judges the current state of `expectedPlanId`'s replan for `selection`. Never throws and never writes. */
  inspect(selection: ReplanTargetSelection, expectedPlanId: ProductionPlanId): Promise<RunningPlanReplanPreStartInspection>
}

export interface RunningPlanReplanPreStartInspectorDependencies {
  startReader: RunningPlanReplanStartReader
  /** The main-thread Planner dependencies, for the support queries of Stage 0R only (nothing is predicted). */
  plannerDependencies: PlannerDependencies
}

export function createRunningPlanReplanPreStartInspector(dependencies: RunningPlanReplanPreStartInspectorDependencies): RunningPlanReplanPreStartInspector {
  return {
    inspect: async (selection, expectedPlanId) => {
      let preparation: RunningPlanReplanStartPreparation
      try {
        preparation = await dependencies.startReader.read(selection, expectedPlanId)
      } catch (error: unknown) {
        return {
          kind: 'read_failed',
          code: error instanceof RepositoryError || error instanceof ExecutionRuntimeError ? error.code : 'transaction_failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      if (preparation.status === 'refused') return { kind: 'refused', refusal: preparation.refusal }
      const { start } = preparation
      const identityRefusal = runningPlanIdentityRefusalOf(start, expectedPlanId)
      if (identityRefusal !== null) return { kind: 'refused', refusal: identityRefusal }
      try {
        const prepared = prepareRunningPlanReplanOptimization(
          { plannerInput: start.plannerInput, replanTargets: start.replanTargets },
          dependencies.plannerDependencies,
        )
        return {
          kind: 'ready',
          start,
          inputConditions: prepared.kind === 'ready' ? { kind: 'ready' } : { kind: 'unsupported', reasons: prepared.reasons },
        }
      } catch (error: unknown) {
        return { kind: 'judgement_failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
