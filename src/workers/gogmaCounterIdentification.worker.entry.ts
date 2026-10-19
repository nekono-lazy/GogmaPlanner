import { attachGogmaCounterIdentificationWorker } from './gogmaCounterIdentification.worker'
import { createProductionGogmaCounterIdentificationRngEngine } from './gogmaCounterIdentification.worker.production'

attachGogmaCounterIdentificationWorker(
  self,
  createProductionGogmaCounterIdentificationRngEngine,
)
