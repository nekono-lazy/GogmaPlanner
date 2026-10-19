import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  BuildListEntryRepository,
  NormalArtianCounterRepository,
  OwnedWeaponRepository,
  RngStateRepository,
  TargetWeaponRepository,
} from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import { createSettingsRepository } from '../../db/settingsRepository'
import {
  deriveOtherTargetSourceExclusion,
  type OtherTargetSourceExclusion,
} from '../../domain/buildList'
import type {
  BuildListEntry,
  OwnedWeapon,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import type { CandidateSearchInput } from '../../domain/search'
import {
  buildCandidateSearchInput,
  createCandidateSearchInput,
  defaultSearchInputRepositories,
  type CandidateSearchInputState,
  type CreateCandidateSearchInputOptions,
  type SearchInputRepositories,
} from './createCandidateSearchInput'

/**
 * The Application side of 「他の目標武器で使用する所持武器を除外する」 (`docs/SEARCH_SPEC.md` 3.3, Issue #157 PR-3):
 * building one Candidate Search input with the exclusion on or off, and keeping, beside the input, what the
 * exclusion was derived from so the screen can name the excluded weapons and their reasons later.
 *
 * Nothing here is persisted. The exclusion is a search condition, never a Candidate, Entry or Planner constraint.
 */

/** One read of the persisted state a Candidate Search with the exclusion on is built and derived from. */
export interface CandidateSearchPersistedState extends CandidateSearchInputState {
  buildListEntries: BuildListEntry[]
}

export interface CandidateSearchStateReader {
  /**
   * Reads RngState, every Normal Artian Counter, OwnedWeapon, TargetWeapon and BuildListEntry as one snapshot of the
   * persisted state. A read failure throws (fail closed): a partial state is never returned.
   */
  read(): Promise<CandidateSearchPersistedState>
}

/**
 * The Dexie state reader. Like `createCandidateSearchInput()`, it first makes sure the RngState and the AppSettings
 * exist (creating the initial records when they do not), each in its own transaction; then it reads the five tables in
 * one read-only transaction, so no write can fall between the search input and the exclusion derived from it. An
 * RngState missing inside that transaction (removed in between) fails closed with `not_found` instead of being created
 * there.
 */
export function createCandidateSearchStateReader(database: AppDatabase = appDatabase): CandidateSearchStateReader {
  const rngStates = new RngStateRepository(database)
  const settings = createSettingsRepository(database)
  const normalCounters = new NormalArtianCounterRepository(database)
  const ownedWeapons = new OwnedWeaponRepository(database)
  const targetWeapons = new TargetWeaponRepository(database)
  const buildListEntries = new BuildListEntryRepository(database)
  return {
    read: async () => {
      await rngStates.ensureInitialRngState()
      await settings.ensureSettings()
      try {
        return await database.transaction(
          'r',
          [database.rngState, database.normalArtianCounters, database.ownedWeapons, database.targetWeapons, database.buildListEntries],
          async (): Promise<CandidateSearchPersistedState> => {
            const [rngState, counters, weapons, targets, entries] = await Promise.all([
              rngStates.getCurrentRngState(),
              normalCounters.getAllNormalArtianCounters(),
              ownedWeapons.getAllOwnedWeapons(),
              targetWeapons.getAllTargetWeapons(),
              buildListEntries.getAllBuildListEntries(),
            ])
            if (rngState === undefined) {
              throw new RepositoryError('not_found', 'No RngState is stored, so no Candidate Search input can be read.')
            }
            return {
              rngState,
              normalCounters: counters,
              ownedWeapons: weapons,
              targetWeapons: targets,
              buildListEntries: entries,
            }
          },
        )
      } catch (error: unknown) {
        if (error instanceof RepositoryError) throw error
        throw new RepositoryError('transaction_failed', 'Reading the Candidate Search input failed.', { cause: error })
      }
    },
  }
}

export interface PrepareCandidateSearchInputOptions extends CreateCandidateSearchInputOptions {
  /**
   * 「他の目標武器で使用する所持武器を除外する」, as fixed when the search (or the batch) started
   * (`docs/UI_FLOW.md` 9.2). `false` builds exactly the input `createCandidateSearchInput()` builds.
   */
  excludeOtherTargetSources: boolean
}

/**
 * What the exclusion of one search was derived from, taken from the same read as its input (`docs/UI_FLOW.md` 9.2:
 * the names and reasons are resolved from this, never from a later read).
 */
export interface CandidateSearchSourceExclusionSnapshot {
  /** The derivation result; its `excludedOwnedWeaponIds` is the input's `excludedSourceOwnedWeaponIds`. */
  exclusion: OtherTargetSourceExclusion
  /** The OwnedWeapons of `exclusion.usages`, as read, in the same order. */
  ownedWeapons: OwnedWeapon[]
  /** The TargetWeapons the reasons name, as read, in code unit ID order. */
  targetWeapons: TargetWeapon[]
}

export interface PreparedCandidateSearchInput {
  input: CandidateSearchInput
  /** `null` when the exclusion is off; never `null` when it is on, even when nothing is excluded. */
  sourceExclusion: CandidateSearchSourceExclusionSnapshot | null
}

export interface CandidateSearchInputPreparationDependencies {
  /** The exclusion-off path: the unchanged `createCandidateSearchInput()` repositories. */
  repositories: SearchInputRepositories
  /** The exclusion-on path: one consistent read of the persisted state. */
  stateReader: CandidateSearchStateReader
}

export const defaultCandidateSearchInputPreparationDependencies: CandidateSearchInputPreparationDependencies = {
  repositories: defaultSearchInputRepositories,
  stateReader: createCandidateSearchStateReader(),
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function createSourceExclusionSnapshot(
  exclusion: OtherTargetSourceExclusion,
  state: CandidateSearchPersistedState,
): CandidateSearchSourceExclusionSnapshot {
  const weaponById = new Map(state.ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const targetById = new Map(state.targetWeapons.map((target) => [target.id, target]))
  const reasonTargetIds = new Set<TargetWeaponId>(
    exclusion.usages.flatMap(({ reasons }) => reasons.map(({ targetWeaponId }) => targetWeaponId)),
  )
  return {
    exclusion,
    ownedWeapons: exclusion.usages.map(({ ownedWeaponId }) => {
      const weapon = weaponById.get(ownedWeaponId)
      // The derivation returns only weapons of this read.
      if (weapon === undefined) throw new Error(`The excluded OwnedWeapon ${ownedWeaponId} is not in the read state.`)
      return weapon
    }),
    targetWeapons: [...reasonTargetIds].sort(compareCodeUnits).map((targetWeaponId) => {
      const target = targetById.get(targetWeaponId)
      if (target === undefined) throw new Error(`The TargetWeapon ${targetWeaponId} of an exclusion reason is not in the read state.`)
      return target
    }),
  }
}

/**
 * Builds one Candidate Search input (`docs/SEARCH_SPEC.md` 3.3). With the exclusion off it is
 * `createCandidateSearchInput()` unchanged - the input has no `excludedSourceOwnedWeaponIds` - and `sourceExclusion` is
 * `null`. With it on, one read of the persisted state builds the input and, through
 * `deriveOtherTargetSourceExclusion()`, the excluded set it carries as `excludedSourceOwnedWeaponIds` (an empty array
 * when nothing is excluded); the derivation and the records it names are returned beside it. The Search Domain still
 * decides Route eligibility; it receives the IDs only, never the reasons.
 */
export async function prepareCandidateSearchInput(
  options: PrepareCandidateSearchInputOptions,
  dependencies: CandidateSearchInputPreparationDependencies = defaultCandidateSearchInputPreparationDependencies,
): Promise<PreparedCandidateSearchInput> {
  const { excludeOtherTargetSources, ...inputOptions } = options
  if (!excludeOtherTargetSources) {
    return { input: await createCandidateSearchInput(inputOptions, dependencies.repositories), sourceExclusion: null }
  }
  const state = await dependencies.stateReader.read()
  const exclusion = deriveOtherTargetSourceExclusion({
    targetWeaponId: inputOptions.targetWeaponId,
    targetWeapons: state.targetWeapons,
    ownedWeapons: state.ownedWeapons,
    buildListEntries: state.buildListEntries,
    rngState: state.rngState,
    normalCounters: state.normalCounters,
    calculationContext: inputOptions.calculationContext,
  })
  return {
    input: {
      ...buildCandidateSearchInput(inputOptions, state),
      excludedSourceOwnedWeaponIds: [...exclusion.excludedOwnedWeaponIds],
    },
    sourceExclusion: createSourceExclusionSnapshot(exclusion, state),
  }
}

/**
 * Checks that a prepared input says what the requested condition asks for, so a preparation that ignored the
 * exclusion is never searched as if it had applied it: off means no `sourceExclusion` and no
 * `excludedSourceOwnedWeaponIds`; on means a `sourceExclusion` for this Target whose excluded IDs are exactly the
 * input's. Returns the problem, or `null`.
 */
export function preparedCandidateSearchInputIssue(
  prepared: PreparedCandidateSearchInput,
  excludeOtherTargetSources: boolean,
): string | null {
  const { input, sourceExclusion } = prepared
  if (!excludeOtherTargetSources) {
    if (sourceExclusion !== null || input.excludedSourceOwnedWeaponIds !== undefined) {
      return 'The exclusion is off, but the prepared input carries an exclusion.'
    }
    return null
  }
  if (sourceExclusion === null || input.excludedSourceOwnedWeaponIds === undefined) {
    return 'The exclusion is on, but the prepared input carries no exclusion.'
  }
  if (sourceExclusion.exclusion.targetWeaponId !== input.targetWeaponId) {
    return 'The prepared exclusion was derived for another Target.'
  }
  const expected = sourceExclusion.exclusion.excludedOwnedWeaponIds
  const actual = input.excludedSourceOwnedWeaponIds
  if (expected.length !== actual.length || expected.some((id, index) => actual[index] !== id)) {
    return 'The prepared input does not exclude the derived OwnedWeapons.'
  }
  return null
}
