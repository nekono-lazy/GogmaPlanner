import { attachPlannerWorker, type PlannerWorkerScope } from './planner.worker'
import {
  createProductionPlannerWorkerCalculations,
  createProductionPlannerWorkerDependencies,
} from './planner.worker.production'

attachPlannerWorker(
  self as unknown as PlannerWorkerScope,
  createProductionPlannerWorkerDependencies,
  createProductionPlannerWorkerCalculations(),
)
