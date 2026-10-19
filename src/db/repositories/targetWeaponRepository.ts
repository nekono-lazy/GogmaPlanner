import type { TargetWeapon, TargetWeaponId } from '../../domain/models/publicTypes'
import { validateTargetWeapon } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import { assertRepositoryValidation } from '../repositoryError'

export class TargetWeaponRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getTargetWeapon(id: TargetWeaponId): Promise<TargetWeapon | undefined> {
    return this.database.targetWeapons.get(id)
  }

  getAllTargetWeapons(): Promise<TargetWeapon[]> {
    return this.database.targetWeapons.toArray()
  }

  async getEnabledTargetWeapons(): Promise<TargetWeapon[]> {
    return (await this.database.targetWeapons.toArray()).filter(
      ({ isEnabled }) => isEnabled,
    )
  }

  async putTargetWeapon(target: TargetWeapon): Promise<TargetWeapon> {
    assertRepositoryValidation('TargetWeapon', validateTargetWeapon(target))
    await this.database.targetWeapons.put(target)
    return target
  }

  deleteTargetWeapon(id: TargetWeaponId): Promise<void> {
    return this.database.targetWeapons.delete(id)
  }
}

export const targetWeaponRepository = new TargetWeaponRepository(appDatabase)
