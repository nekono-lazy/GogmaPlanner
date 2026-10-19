import type {
  OwnedWeaponId,
  PlanStepId,
  ProductionPlanId,
} from '../models/publicTypes'
import type { RngEngine } from '../rng/rngEngine'
import type { PlannerDependencies } from './plannerTypes'

export function createProductionPlannerDependencies(
  rngEngine: RngEngine,
): PlannerDependencies {
  return {
    rngEngine,
    idFactory: {
      productionPlanId: () => crypto.randomUUID() as ProductionPlanId,
      planStepId: () => crypto.randomUUID() as PlanStepId,
      ownedWeaponId: () => crypto.randomUUID() as OwnedWeaponId,
    },
    clock: {
      now: () => new Date().toISOString(),
    },
  }
}

