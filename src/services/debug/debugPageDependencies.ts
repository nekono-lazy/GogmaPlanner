import {
  normalArtianCounterRepository,
  productionPlanRepository,
  rngStateRepository,
} from '../../db/repositories'
import type {
  NormalArtianCounter,
  ProductionPlan,
  RngState,
} from '../../domain/models/publicTypes'

/**
 * The Application boundary of the Debug Details screen
 * (`docs/UI_FLOW.md` 15).
 *
 * Read-only by contract: Debug Details observes the persisted state and adds
 * no save or edit of its own. Debug Mode never changes RNG prediction,
 * Candidate Search, Planner, Execution, validation or persistence semantics,
 * so this boundary exposes reads and nothing else.
 */
export interface DebugPageDependencies {
  getRngState(): Promise<RngState | undefined>
  getNormalCounters(): Promise<NormalArtianCounter[]>
  /**
   * The one running (`active` / `stale`) Plan, or `undefined`. A Draft is not a
   * running Plan and is deliberately not substituted here; a Repository
   * invariant failure throws and is reported as a read error, never as
   * "no Plan".
   */
  getRunningProductionPlan(): Promise<ProductionPlan | undefined>
}

/** The application database boundary; tests inject their own. */
export function createDebugPageDependencies(): DebugPageDependencies {
  return {
    getRngState: () => rngStateRepository.getCurrentRngState(),
    getNormalCounters: () => normalArtianCounterRepository.getAllNormalArtianCounters(),
    getRunningProductionPlan: () => productionPlanRepository.getRunningProductionPlan(),
  }
}
