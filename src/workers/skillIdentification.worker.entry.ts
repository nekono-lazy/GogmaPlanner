import {
  attachSkillIdentificationWorker,
  type SkillIdentificationWorkerScope,
} from './skillIdentification.worker'
import { createProductionSkillIdentificationRngEngine } from './skillIdentification.worker.production'

attachSkillIdentificationWorker(
  self as unknown as SkillIdentificationWorkerScope,
  createProductionSkillIdentificationRngEngine,
)
