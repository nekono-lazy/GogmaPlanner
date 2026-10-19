import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import { validateBuildListEntry } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'
import { runInRepositoryTransaction } from '../transaction'

/**
 * One Build List addition decided over the persisted Build List: the Entry to
 * add (`null` adds nothing) and the caller's own result.
 */
export interface BuildListEntryAdditionDecision<R> {
  entry: BuildListEntry | null
  result: R
}

function sortEntries(entries: BuildListEntry[]): BuildListEntry[] {
  return entries.sort((left, right) => left.id.localeCompare(right.id))
}

export class BuildListEntryRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getBuildListEntry(
    id: BuildListEntryId,
  ): Promise<BuildListEntry | undefined> {
    return this.database.buildListEntries.get(id)
  }

  async getAllBuildListEntries(): Promise<BuildListEntry[]> {
    return sortEntries(await this.database.buildListEntries.toArray())
  }

  async getBuildListEntriesByTarget(
    targetWeaponId: TargetWeaponId,
  ): Promise<BuildListEntry[]> {
    return sortEntries(
      await this.database.buildListEntries
        .where('targetWeaponId')
        .equals(targetWeaponId)
        .toArray(),
    )
  }

  async getNonStaleBuildListEntries(): Promise<BuildListEntry[]> {
    return sortEntries(
      (await this.database.buildListEntries.toArray()).filter(
        ({ isStale }) => !isStale,
      ),
    )
  }

  /**
   * Inserts an Entry that must not already exist.
   *
   * Planner-generated Entries are deterministic history (PLANNER_SPEC 9.2.12):
   * an existing ID is never reused or overwritten, so persistence uses `add`
   * and lets Dexie reject a colliding key instead of silently replacing the
   * stored Entry. Domain validation is the same authority `put` uses.
   */
  async addBuildListEntry(entry: BuildListEntry): Promise<BuildListEntry> {
    assertRepositoryValidation(
      'BuildListEntry',
      validateBuildListEntry(entry),
    )
    await this.database.buildListEntries.add(entry)
    return entry
  }

  /**
   * Reads the whole Build List and adds the Entry `decide` returns, in one
   * read-write transaction, so no concurrent save can slip another Entry of the
   * same Target in between the decision and the write (`docs/DATA_MODEL.md`
   * 9.4.1). `decide` is a pure decision over the Entries in stable ID order; the
   * add uses `add`, so a colliding ID is refused rather than overwritten. Any
   * failure rolls the whole transaction back.
   */
  decideAndAddBuildListEntry<R>(
    decide: (entries: BuildListEntry[]) => BuildListEntryAdditionDecision<R>,
  ): Promise<R> {
    return runInRepositoryTransaction(this.database, [this.database.buildListEntries], async () => {
      const decision = decide(sortEntries(await this.database.buildListEntries.toArray()))
      if (decision.entry !== null) await this.addBuildListEntry(decision.entry)
      return decision.result
    })
  }

  async putBuildListEntry(entry: BuildListEntry): Promise<BuildListEntry> {
    assertRepositoryValidation(
      'BuildListEntry',
      validateBuildListEntry(entry),
    )
    await this.database.buildListEntries.put(entry)
    return entry
  }

  deleteBuildListEntry(id: BuildListEntryId): Promise<void> {
    return this.database.buildListEntries.delete(id)
  }
}

export const buildListEntryRepository = new BuildListEntryRepository(appDatabase)
