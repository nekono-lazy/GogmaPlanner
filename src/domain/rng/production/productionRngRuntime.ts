import type { RngEngineCapabilities } from '../rngEngine'
import {
  ProductionRngEngine,
  PRODUCTION_RNG_ENGINE_VERSION,
} from './productionRngEngine'

export interface ProductionRngRuntimeDescriptor {
  readonly mode: 'Production'
  readonly version: string
  readonly capabilities: Readonly<RngEngineCapabilities>
}

/** Main-thread Production authority for lightweight UI and setup operations. */
export const productionRngEngine = new ProductionRngEngine()

/** Non-persistent runtime provenance shown by Settings, Debug, and RNG Setup. */
export const productionRngRuntime: ProductionRngRuntimeDescriptor = Object.freeze({
  mode: 'Production',
  version: productionRngEngine.version,
  capabilities: Object.freeze({ ...productionRngEngine.capabilities }),
})

if (productionRngRuntime.version !== PRODUCTION_RNG_ENGINE_VERSION) {
  throw new Error('Production RNG runtime version does not match its Engine authority.')
}
