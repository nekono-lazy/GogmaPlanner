import type {
  ElementId,
  NormalArtianRarity,
  WeaponTypeId,
} from '../../models/publicTypes'

/**
 * Numeric values used only by the pinned reference implementation.
 *
 * Reference-verified against GARP.lua v0.9.4 from
 * WiseHorror/Gogma-Artian-Roll-Planner
 * @ eceb2bd9ca6f4897ec516387acab2ad6beb8b38b: `weapon_type_names` with
 * `target_weapon_type - 1`, `skill_attribute_force_for_recipe`, and
 * `capture_target_planning_inputs`. This project adapts that numeric namespace
 * to semantic Domain IDs; the numeric values are not Domain IDs and must not
 * be persisted. See docs/RNG_REFERENCE_AUDIT.md section 9.
 */
const REFERENCE_WEAPON_TYPE_BY_ID: Readonly<Record<string, number>> = {
  'weapon.great_sword': 0,
  'weapon.sword_and_shield': 1,
  'weapon.dual_blades': 2,
  'weapon.long_sword': 3,
  'weapon.hammer': 4,
  'weapon.hunting_horn': 5,
  'weapon.lance': 6,
  'weapon.gunlance': 7,
  'weapon.switch_axe': 8,
  'weapon.charge_blade': 9,
  'weapon.insect_glaive': 10,
  'weapon.bow': 11,
  'weapon.heavy_bowgun': 12,
  'weapon.light_bowgun': 13,
}

/**
 * `attributeForce` is the seed input for Skill and Gogma streams. In
 * particular, Thunder and Ice intentionally differ from Master display order.
 */
const REFERENCE_ATTRIBUTE_FORCE_BY_ELEMENT_ID: Readonly<Record<string, number>> = {
  'element.none': 0,
  'element.fire': 1,
  'element.water': 2,
  'element.ice': 3,
  'element.thunder': 4,
  'element.dragon': 5,
  'element.poison': 6,
  'element.paralysis': 7,
  'element.sleep': 8,
  'element.blast': 9,
}

/** The one-based reference final-attribute selector used only by Normal pools. */
const REFERENCE_NORMAL_FINAL_ATTRIBUTE_BY_ELEMENT_ID: Readonly<Record<string, number>> = {
  'element.none': 1,
  'element.fire': 2,
  'element.water': 3,
  'element.thunder': 4,
  'element.ice': 5,
  'element.dragon': 6,
  'element.poison': 7,
  'element.paralysis': 8,
  'element.sleep': 9,
  'element.blast': 10,
}

function missingReferenceAdapterValue(kind: string, semanticId: string): never {
  throw new RangeError(`Unsupported ${kind} for reference RNG adapter: ${semanticId}`)
}

/** Maps a semantic Domain WeaponTypeId to the reference implementation value. */
export function toReferenceWeaponType(weaponTypeId: WeaponTypeId): number {
  const mapped = REFERENCE_WEAPON_TYPE_BY_ID[weaponTypeId]
  return mapped === undefined
    ? missingReferenceAdapterValue('weapon type', weaponTypeId)
    : mapped
}

/** Maps a semantic Domain ElementId to the reference `attributeForce` value. */
export function toReferenceAttributeForce(elementId: ElementId): number {
  const mapped = REFERENCE_ATTRIBUTE_FORCE_BY_ELEMENT_ID[elementId]
  return mapped === undefined
    ? missingReferenceAdapterValue('element', elementId)
    : mapped
}

/** Maps a semantic Domain ElementId to the Normal lottery's display attribute. */
export function toReferenceNormalFinalAttribute(elementId: ElementId): number {
  const mapped = REFERENCE_NORMAL_FINAL_ATTRIBUTE_BY_ELEMENT_ID[elementId]
  return mapped === undefined
    ? missingReferenceAdapterValue('Normal final attribute element', elementId)
    : mapped
}

/**
 * v1 only supports visible rarity 8. The reference's internal rarity value is
 * a deliberately explicit mapping, not a generic display-rarity subtraction.
 */
export function toReferenceNormalInternalRarity(displayRarity: number): number {
  if (displayRarity !== 8) {
    throw new RangeError(`Unsupported Normal Artian display rarity: ${displayRarity}`)
  }
  return 7
}

/** Keeps the production-internal API aligned with the existing Domain type. */
export function toReferenceRarity8(rarity: NormalArtianRarity): number {
  return toReferenceNormalInternalRarity(rarity)
}
