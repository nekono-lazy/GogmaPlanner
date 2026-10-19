import { ProductionRngEngine } from '../domain/rng/production/productionRngEngine'
import type { RngEngine } from '../domain/rng/rngEngine'

/** Creates the Skill Identification forward authority inside its Worker. */
export function createProductionSkillIdentificationRngEngine(): RngEngine {
  return new ProductionRngEngine()
}
