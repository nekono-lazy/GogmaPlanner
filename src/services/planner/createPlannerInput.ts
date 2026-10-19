import { CURRENT_CALCULATION_APP_SCHEMA_VERSION } from '../../domain/models/publicTypes'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CalculationContext } from '../../domain/models/publicTypes'
import {
  defaultPlannerOptions,
  type PlannerInput,
} from '../../domain/planner'
import {
  buildListEntryRepository,
  normalArtianCounterRepository,
  ownedWeaponRepository,
  rngStateRepository,
  targetWeaponRepository,
} from '../../db/repositories'

export interface PlannerInputRepositories {
  ensureInitialRngState: typeof rngStateRepository.ensureInitialRngState
  getAllNormalArtianCounters: typeof normalArtianCounterRepository.getAllNormalArtianCounters
  getAllOwnedWeapons: typeof ownedWeaponRepository.getAllOwnedWeapons
  getAllTargetWeapons: typeof targetWeaponRepository.getAllTargetWeapons
  getAllBuildListEntries: typeof buildListEntryRepository.getAllBuildListEntries
}

export const defaultPlannerInputRepositories: PlannerInputRepositories = {
  ensureInitialRngState: () => rngStateRepository.ensureInitialRngState(),
  getAllNormalArtianCounters: () =>
    normalArtianCounterRepository.getAllNormalArtianCounters(),
  getAllOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
  getAllTargetWeapons: () => targetWeaponRepository.getAllTargetWeapons(),
  getAllBuildListEntries: () => buildListEntryRepository.getAllBuildListEntries(),
}

export function createPlannerCalculationContext(
  master: MasterDataRoot,
  rngEngineVersion: string,
): CalculationContext {
  return {
    gameVersion: master.manifest.gameVersion,
    masterDataVersion: master.manifest.dataVersion,
    rngEngineVersion,
    appSchemaVersion: CURRENT_CALCULATION_APP_SCHEMA_VERSION,
  }
}

export async function createPlannerInput(
  master: MasterDataRoot,
  calculationContext: CalculationContext,
  repositories: PlannerInputRepositories = defaultPlannerInputRepositories,
): Promise<PlannerInput> {
  const [rngState, normalCounters, ownedWeapons, targetWeapons, buildListEntries] =
    await Promise.all([
      repositories.ensureInitialRngState(),
      repositories.getAllNormalArtianCounters(),
      repositories.getAllOwnedWeapons(),
      repositories.getAllTargetWeapons(),
      repositories.getAllBuildListEntries(),
    ])
  return {
    rngState,
    normalCounters,
    ownedWeapons,
    targetWeapons,
    buildListEntries,
    calculationContext: { ...calculationContext },
    options: { ...defaultPlannerOptions },
    master: {
      weaponBonusDefinitions: master.weaponBonusDefinitions,
      weaponTypes: master.weaponTypes,
      elements: master.elements,
      bonusTypes: master.bonusTypes,
      bonusRanks: master.bonusRanks,
      artianBonusTypeMappings: master.artianBonusTypeMappings,
      materialCosts: master.materialCosts,
    },
    conflictResolutions: [],
  }
}
