import { ProductionRngEngine } from '../domain/rng/production/productionRngEngine'
import type { RngEngine } from '../domain/rng/rngEngine'

/** Creates the active Candidate Search Engine inside the Worker boundary. */
export function createProductionSearchRngEngine(): RngEngine {
  return new ProductionRngEngine()
}
