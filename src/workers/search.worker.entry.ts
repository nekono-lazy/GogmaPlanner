import { attachSearchWorker, type CandidateSearchWorkerScope } from './search.worker'
import { createProductionSearchRngEngine } from './search.worker.production'

attachSearchWorker(
  self as unknown as CandidateSearchWorkerScope,
  createProductionSearchRngEngine,
)
