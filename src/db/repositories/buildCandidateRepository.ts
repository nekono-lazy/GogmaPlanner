import type {
  BuildCandidate,
  BuildCandidateId,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import { validateBuildCandidate } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import {
  assertRepositoryValidation,
  RepositoryError,
} from '../repositoryError'
import { runInRepositoryTransaction } from '../transaction'

function sortCandidates(candidates: BuildCandidate[]): BuildCandidate[] {
  return candidates.sort((left, right) => left.id.localeCompare(right.id))
}

export class BuildCandidateRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getBuildCandidate(
    id: BuildCandidateId,
  ): Promise<BuildCandidate | undefined> {
    return this.database.buildCandidates.get(id)
  }

  async getBuildCandidatesByTarget(
    targetWeaponId: TargetWeaponId,
  ): Promise<BuildCandidate[]> {
    return sortCandidates(
      await this.database.buildCandidates
        .where('targetWeaponId')
        .equals(targetWeaponId)
        .toArray(),
    )
  }

  async putBuildCandidate(
    candidate: BuildCandidate,
  ): Promise<BuildCandidate> {
    assertRepositoryValidation(
      'BuildCandidate',
      validateBuildCandidate(candidate),
    )
    await this.database.buildCandidates.put(candidate)
    return candidate
  }

  replaceBuildCandidatesForTarget(
    targetWeaponId: TargetWeaponId,
    candidates: readonly BuildCandidate[],
  ): Promise<BuildCandidate[]> {
    candidates.forEach((candidate) => {
      assertRepositoryValidation(
        'BuildCandidate',
        validateBuildCandidate(candidate),
      )
      if (candidate.targetWeaponId !== targetWeaponId) {
        throw new RepositoryError(
          'reference_conflict',
          'Every replacement candidate must reference the requested TargetWeapon.',
        )
      }
    })

    return runInRepositoryTransaction(
      this.database,
      [this.database.buildCandidates],
      async () => {
        await this.database.buildCandidates
          .where('targetWeaponId')
          .equals(targetWeaponId)
          .delete()
        if (candidates.length > 0) {
          await this.database.buildCandidates.bulkAdd([...candidates])
        }
        return sortCandidates([...candidates])
      },
    )
  }

  deleteBuildCandidatesForTarget(
    targetWeaponId: TargetWeaponId,
  ): Promise<number> {
    return this.database.buildCandidates
      .where('targetWeaponId')
      .equals(targetWeaponId)
      .delete()
  }
}

export const buildCandidateRepository = new BuildCandidateRepository(appDatabase)
