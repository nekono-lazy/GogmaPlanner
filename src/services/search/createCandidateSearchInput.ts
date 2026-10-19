import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  CalculationContext,
  NormalArtianCounter,
  OwnedWeapon,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import type {
  CandidateRouteFilter,
  CandidateSearchInput,
  CandidateSearchSettings,
} from '../../domain/search'
import {
  normalArtianCounterRepository,
  ownedWeaponRepository,
  rngStateRepository,
  targetWeaponRepository,
} from '../../db/repositories'
import { settingsRepository } from '../../db/settingsRepository'

export interface SearchInputRepositories {
  ensureInitialRngState: typeof rngStateRepository.ensureInitialRngState
  getAllNormalArtianCounters: typeof normalArtianCounterRepository.getAllNormalArtianCounters
  getAllOwnedWeapons: typeof ownedWeaponRepository.getAllOwnedWeapons
  getAllTargetWeapons: typeof targetWeaponRepository.getAllTargetWeapons
  ensureSettings: typeof settingsRepository.ensureSettings
}

export const defaultSearchInputRepositories: SearchInputRepositories = {
  ensureInitialRngState: () => rngStateRepository.ensureInitialRngState(),
  getAllNormalArtianCounters: () =>
    normalArtianCounterRepository.getAllNormalArtianCounters(),
  getAllOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
  getAllTargetWeapons: () => targetWeaponRepository.getAllTargetWeapons(),
  ensureSettings: () => settingsRepository.ensureSettings(),
}

export interface CreateCandidateSearchInputOptions {
  searchRunId: string
  targetWeaponId: TargetWeaponId
  routeFilter: CandidateRouteFilter
  settings: CandidateSearchSettings
  master: MasterDataRoot
  calculationContext: CalculationContext
}

/** The persisted state one Candidate Search input carries, as read. */
export interface CandidateSearchInputState {
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
}

/**
 * Builds the Candidate Search input from the caller's options and one read of
 * the persisted state. Pure: it reads and writes nothing, and it never sets
 * `excludedSourceOwnedWeaponIds` (`docs/SEARCH_SPEC.md` 3.3); only
 * `prepareCandidateSearchInput()` with the exclusion on adds it.
 */
export function buildCandidateSearchInput(
  options: CreateCandidateSearchInputOptions,
  state: CandidateSearchInputState,
): CandidateSearchInput {
  return {
    searchRunId: options.searchRunId,
    targetWeaponId: options.targetWeaponId,
    routeFilter: options.routeFilter,
    rngState: state.rngState,
    normalCounters: state.normalCounters,
    ownedWeapons: state.ownedWeapons,
    targetWeapons: state.targetWeapons,
    settings: { ...options.settings },
    master: {
      weaponBonusDefinitions: options.master.weaponBonusDefinitions,
      weaponTypes: options.master.weaponTypes,
      elements: options.master.elements,
      bonusTypes: options.master.bonusTypes,
      bonusRanks: options.master.bonusRanks,
      artianBonusTypeMappings: options.master.artianBonusTypeMappings,
      materialCosts: options.master.materialCosts,
    },
    calculationContext: { ...options.calculationContext },
  }
}

export async function createCandidateSearchInput(
  options: CreateCandidateSearchInputOptions,
  repositories: SearchInputRepositories = defaultSearchInputRepositories,
): Promise<CandidateSearchInput> {
  const [rngState, normalCounters, ownedWeapons, targetWeapons] =
    await Promise.all([
      repositories.ensureInitialRngState(),
      repositories.getAllNormalArtianCounters(),
      repositories.getAllOwnedWeapons(),
      repositories.getAllTargetWeapons(),
      repositories.ensureSettings(),
    ])
  return buildCandidateSearchInput(options, {
    rngState,
    normalCounters,
    ownedWeapons,
    targetWeapons,
  })
}
