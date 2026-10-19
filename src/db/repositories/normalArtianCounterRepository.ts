import type {
  NormalArtianCounter,
  NormalArtianRarity,
  WeaponTypeId,
} from '../../domain/models/publicTypes'
import { validateNormalArtianCounter } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'

export function normalArtianCounterId(
  weaponTypeId: WeaponTypeId,
  rarity: NormalArtianRarity,
): string {
  return `${weaponTypeId}:${rarity}`
}

export class NormalArtianCounterRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getAllNormalArtianCounters(): Promise<NormalArtianCounter[]> {
    return this.database.normalArtianCounters.toArray()
  }

  getNormalArtianCounter(
    weaponTypeId: WeaponTypeId,
    rarity: NormalArtianRarity,
  ): Promise<NormalArtianCounter | undefined> {
    return this.database.normalArtianCounters
      .where('[weaponTypeId+rarity]')
      .equals([weaponTypeId, rarity])
      .first()
  }

  async putNormalArtianCounter(
    counter: NormalArtianCounter,
  ): Promise<NormalArtianCounter> {
    assertRepositoryValidation(
      'NormalArtianCounter',
      validateNormalArtianCounter(counter),
    )
    await this.database.normalArtianCounters.put(counter)
    return counter
  }

  deleteNormalArtianCounter(
    weaponTypeId: WeaponTypeId,
    rarity: NormalArtianRarity,
  ): Promise<void> {
    return this.database.normalArtianCounters.delete(
      normalArtianCounterId(weaponTypeId, rarity),
    )
  }
}

export const normalArtianCounterRepository =
  new NormalArtianCounterRepository(appDatabase)
