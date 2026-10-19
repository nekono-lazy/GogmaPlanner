import { attachBuildListOptimizationWorker, type BuildListOptimizationWorkerScope } from './buildListOptimization.worker'
import { createProductionBuildListOptimizationWorkerRuntime } from './buildListOptimization.worker.production'

attachBuildListOptimizationWorker(
  self as unknown as BuildListOptimizationWorkerScope,
  createProductionBuildListOptimizationWorkerRuntime(),
)
