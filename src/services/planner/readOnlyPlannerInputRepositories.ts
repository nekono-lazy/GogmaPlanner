import type { AppDatabase } from '../../db/AppDatabase'
import {
  BuildListEntryRepository,
  NormalArtianCounterRepository,
  OwnedWeaponRepository,
  TargetWeaponRepository,
} from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import type { PlannerInputRepositories } from './createPlannerInput'

/**
 * The ordinary `createPlannerInput()` repositories for a read inside a read-only transaction the caller opened: the existing
 * repositories of `database`, with one difference - a missing RngState is never created (an initial state is a write) and is a
 * read failure, `RepositoryError('not_found', missingRngStateMessage)`, instead.
 *
 * Shared by the Build List global optimization start reader (Issue #260 PR-4) and the running Plan replan start reader (Issue #276
 * PR-4). It writes nothing.
 */
export function createReadOnlyPlannerInputRepositories(database: AppDatabase, missingRngStateMessage: string): PlannerInputRepositories {
  const normalCounters = new NormalArtianCounterRepository(database)
  const ownedWeapons = new OwnedWeaponRepository(database)
  const targetWeapons = new TargetWeaponRepository(database)
  const buildListEntries = new BuildListEntryRepository(database)
  return {
    ensureInitialRngState: async () => {
      const rngState = await database.rngState.get('current')
      if (!rngState) throw new RepositoryError('not_found', missingRngStateMessage)
      return rngState
    },
    getAllNormalArtianCounters: () => normalCounters.getAllNormalArtianCounters(),
    getAllOwnedWeapons: () => ownedWeapons.getAllOwnedWeapons(),
    getAllTargetWeapons: () => targetWeapons.getAllTargetWeapons(),
    getAllBuildListEntries: () => buildListEntries.getAllBuildListEntries(),
  }
}
