import type { DomainValidationIssue, OwnedWeapon, OwnedWeaponId } from '../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../models/publicTypes'
import type { SimulatedInventory } from './plannerTypes'

export interface SimulatedInventoryResult {
  isValid: boolean
  inventory: SimulatedInventory | null
  issues: DomainValidationIssue[]
}

function issue(path: string, code: DomainValidationIssue['code'], message: string): DomainValidationIssue { return { path, code, message } }
function compareStableStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function copyInventory(inventory: SimulatedInventory): SimulatedInventory { return structuredClone(inventory) }
function success(inventory: SimulatedInventory): SimulatedInventoryResult { return { isValid: true, inventory: copyInventory(inventory), issues: [] } }
function failure(problem: DomainValidationIssue): SimulatedInventoryResult { return { isValid: false, inventory: null, issues: [problem] } }
function allKnownIds(inventory: SimulatedInventory): Set<OwnedWeaponId> { return new Set([...inventory.ownedWeapons.map(({ id }) => id), ...inventory.consumedWeaponIds, ...inventory.reservedWeaponIds, ...inventory.createdWeaponIds]) }

/** Creates a deep-copied inventory and rejects duplicate current weapon IDs. */
export function createSimulatedInventory(ownedWeapons: readonly OwnedWeapon[]): SimulatedInventoryResult {
  const ids = new Set<OwnedWeaponId>()
  for (const weapon of ownedWeapons) {
    if (ids.has(weapon.id)) return failure(issue('ownedWeapons', 'invalid_id', `OwnedWeapon '${weapon.id}' is duplicated.`))
    ids.add(weapon.id)
  }
  return success({ ownedWeapons: structuredClone(ownedWeapons) as OwnedWeapon[], consumedWeaponIds: [], reservedWeaponIds: [], createdWeaponIds: [] })
}

/** Returns a clone so a lookup cannot mutate an inventory branch. */
export function findOwnedWeapon(inventory: SimulatedInventory, ownedWeaponId: OwnedWeaponId): OwnedWeapon | null {
  const weapon = inventory.ownedWeapons.find(({ id }) => id === ownedWeaponId)
  return weapon ? structuredClone(weapon) : null
}

export function canUseAsDestructiveGogmaSource(weapon: OwnedWeapon | null): boolean { return weapon !== null && weapon.kind === 'gogma' && !weapon.isProtected }
export function canUseAsResetSkillsSource(weapon: OwnedWeapon | null): boolean { return weapon !== null && weapon.kind === 'gogma' && !weapon.isProtected }

/**
 * Consumes an owned unprotected rarity-8 Normal Artian without registering a
 * Gogma output.
 *
 * This is the only remaining weapon consumption in v1: `consumedWeaponIds`
 * exists for it, so an owned Normal source can never be converted twice. Owned
 * Gogma Artian weapons are never consumed as material (`docs/PLANNER_SPEC.md`
 * 8).
 */
export function consumeOwnedNormalForConversion(inventory: SimulatedInventory, ownedWeaponId: OwnedWeaponId): SimulatedInventoryResult {
  const weapon = findOwnedWeapon(inventory, ownedWeaponId)
  if (!weapon) return failure(issue('ownedWeaponId', 'invalid_reference', `Normal conversion source '${ownedWeaponId}' is unavailable.`))
  if (weapon.kind !== 'normal' || weapon.rarity !== V1_NORMAL_ARTIAN_RARITY) return failure(issue('ownedWeaponId', 'invalid_state', `OwnedWeapon '${ownedWeaponId}' is not a rarity-8 Normal Artian.`))
  if (weapon.isProtected) return failure(issue('ownedWeaponId', 'protected_destructive_use', `Protected Normal Artian '${ownedWeaponId}' cannot be converted.`))
  const next = copyInventory(inventory)
  next.ownedWeapons = next.ownedWeapons.filter(({ id }) => id !== ownedWeaponId)
  next.consumedWeaponIds = [...next.consumedWeaponIds, ownedWeaponId]
  return success(next)
}

/** Reserves an ID without making it available in ownedWeapons. */
export function reserveWeaponId(inventory: SimulatedInventory, ownedWeaponId: OwnedWeaponId): SimulatedInventoryResult {
  if (allKnownIds(inventory).has(ownedWeaponId)) return failure(issue('ownedWeaponId', 'invalid_id', `OwnedWeapon ID '${ownedWeaponId}' has already been used.`))
  const next = copyInventory(inventory)
  next.reservedWeaponIds = [...next.reservedWeaponIds, ownedWeaponId].sort(compareStableStrings)
  return success(next)
}

/** Registers a new weapon; a reserved ID becomes usable only at this point. */
export function addRegisteredWeapon(inventory: SimulatedInventory, weapon: OwnedWeapon): SimulatedInventoryResult {
  if (inventory.ownedWeapons.some(({ id }) => id === weapon.id) || inventory.consumedWeaponIds.includes(weapon.id) || inventory.createdWeaponIds.includes(weapon.id)) return failure(issue('weapon.id', 'invalid_id', `OwnedWeapon ID '${weapon.id}' cannot be registered again.`))
  if (!inventory.reservedWeaponIds.includes(weapon.id)) return failure(issue('weapon.id', 'invalid_reference', `OwnedWeapon ID '${weapon.id}' must be reserved before registration.`))
  const next = copyInventory(inventory)
  next.ownedWeapons = [...next.ownedWeapons, structuredClone(weapon)]
  next.reservedWeaponIds = next.reservedWeaponIds.filter((id) => id !== weapon.id)
  next.createdWeaponIds = [...next.createdWeaponIds, weapon.id].sort(compareStableStrings)
  return success(next)
}

export function updateOwnedWeapon(inventory: SimulatedInventory, weapon: OwnedWeapon): SimulatedInventoryResult {
  const current = findOwnedWeapon(inventory, weapon.id)
  if (!current) return failure(issue('weapon.id', 'invalid_reference', `OwnedWeapon '${weapon.id}' does not exist.`))
  if (current.kind !== weapon.kind) return failure(issue('weapon.kind', 'invalid_state', `OwnedWeapon '${weapon.id}' cannot change kind during update.`))
  const next = copyInventory(inventory)
  next.ownedWeapons = next.ownedWeapons.map((current) => current.id === weapon.id ? structuredClone(weapon) : current)
  return success(next)
}
