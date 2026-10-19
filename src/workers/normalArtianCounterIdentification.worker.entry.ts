import { attachNormalArtianCounterIdentificationWorker } from './normalArtianCounterIdentification.worker'
import { createProductionNormalArtianCounterIdentificationRngEngine } from './normalArtianCounterIdentification.worker.production'

attachNormalArtianCounterIdentificationWorker(
  self,
  createProductionNormalArtianCounterIdentificationRngEngine,
)
