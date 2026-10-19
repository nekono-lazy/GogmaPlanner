import type { RngEngine } from '../domain/rng/rngEngine'
import { ProductionRngEngine } from '../domain/rng/production/productionRngEngine'

export function createProductionNormalArtianCounterIdentificationRngEngine(): RngEngine {
  return new ProductionRngEngine()
}
