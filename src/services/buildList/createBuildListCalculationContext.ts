import { CURRENT_CALCULATION_APP_SCHEMA_VERSION } from '../../domain/models/publicTypes'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CalculationContext } from '../../domain/models/publicTypes'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../../domain/rng/production/productionRngEngine'

export function createBuildListCalculationContext(
  master: MasterDataRoot,
): CalculationContext {
  return {
    gameVersion: master.manifest.gameVersion,
    masterDataVersion: master.manifest.dataVersion,
    rngEngineVersion: PRODUCTION_RNG_ENGINE_VERSION,
    appSchemaVersion: CURRENT_CALCULATION_APP_SCHEMA_VERSION,
  }
}
