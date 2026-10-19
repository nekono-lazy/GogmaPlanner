import type {
  ElementId,
  NormalArtianRarity,
  WeaponTypeId,
} from '../../models/publicTypes'
import {
  toReferenceAttributeForce,
  toReferenceRarity8,
  toReferenceWeaponType,
} from './referenceAdapters'
import { toUint32 } from './referencePrng'

/** Shared XOR salt from the pinned reference implementation. */
export const REFERENCE_RNG_SEED_SALT = 0x00ac9365

function requireBaseSeed(baseSeed: number): void {
  if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 99_999_999) {
    throw new RangeError('Base seed must be a normalized integer between 0 and 99,999,999')
  }
}

function deriveReferenceSeed(
  baseSeed: number,
  referenceWeaponType: number,
  finalTerm: number,
): number {
  requireBaseSeed(baseSeed)
  return toUint32(
    toUint32(baseSeed + referenceWeaponType * 1000 + finalTerm) ^ REFERENCE_RNG_SEED_SALT,
  )
}

/** Seed material for the Normal Artian stream; only visible rarity 8 is valid. */
export function deriveNormalArtianSeed(
  baseSeed: number,
  weaponTypeId: WeaponTypeId,
  rarity: NormalArtianRarity,
): number {
  return deriveReferenceSeed(
    baseSeed,
    toReferenceWeaponType(weaponTypeId),
    toReferenceRarity8(rarity),
  )
}

function deriveAttributeStreamSeed(
  baseSeed: number,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): number {
  return deriveReferenceSeed(
    baseSeed,
    toReferenceWeaponType(weaponTypeId),
    toReferenceAttributeForce(elementId),
  )
}

/** Seed material for the Skill stream. Its counter remains independent. */
export function deriveSkillSeed(
  baseSeed: number,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): number {
  return deriveAttributeStreamSeed(baseSeed, weaponTypeId, elementId)
}

/** Seed material for the Gogma stream. Its counter remains independent. */
export function deriveGogmaSeed(
  baseSeed: number,
  weaponTypeId: WeaponTypeId,
  elementId: ElementId,
): number {
  return deriveAttributeStreamSeed(baseSeed, weaponTypeId, elementId)
}
