import type {
  OwnedWeapon,
  OwnedWeaponId,
  OwnedWeaponStatus,
} from '../../domain/models/publicTypes'
import { normalizeOwnedWeaponRestorationBonusScope } from '../../domain/models/persistenceCompatibility'
import { validateOwnedWeapon } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'
export class OwnedWeaponRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  async getOwnedWeapon(id: OwnedWeaponId): Promise<OwnedWeapon | undefined> {
    const weapon = await this.database.ownedWeapons.get(id)
    return weapon
      ? normalizeOwnedWeaponRestorationBonusScope(weapon)
      : undefined
  }

  async getAllOwnedWeapons(): Promise<OwnedWeapon[]> {
    return (await this.database.ownedWeapons.toArray()).map(
      normalizeOwnedWeaponRestorationBonusScope,
    )
  }

  async getOwnedWeaponsByStatus(
    status: OwnedWeaponStatus,
  ): Promise<OwnedWeapon[]> {
    return (await this.database.ownedWeapons.where('status').equals(status).toArray()).map(
      normalizeOwnedWeaponRestorationBonusScope,
    )
  }

  async putOwnedWeapon(weapon: OwnedWeapon): Promise<OwnedWeapon> {
    assertRepositoryValidation('OwnedWeapon', validateOwnedWeapon(weapon))
    await this.database.ownedWeapons.put(weapon)
    return weapon
  }

  deleteOwnedWeapon(id: OwnedWeaponId): Promise<void> {
    return this.database.ownedWeapons.delete(id)
  }
}

export const ownedWeaponRepository = new OwnedWeaponRepository(appDatabase)
