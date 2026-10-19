import type { ElementId, WeaponTypeId } from '../domain/models/common'

/**
 * The display-only weapon type / element filter of the management lists
 * (`docs/UI_FLOW.md` 3.2): Owned Weapons, Target Weapons and the Build List.
 *
 * `null` means "every value". The filter only decides which already loaded
 * items are shown: it is never persisted, and it never narrows registered
 * data, Build List membership, a Candidate Search input or a Planner input.
 */
export interface WeaponListFilter {
  weaponTypeId: WeaponTypeId | null
  elementId: ElementId | null
}

export const emptyWeaponListFilter: WeaponListFilter = { weaponTypeId: null, elementId: null }

export function isWeaponListFilterActive(filter: WeaponListFilter): boolean {
  return filter.weaponTypeId !== null || filter.elementId !== null
}

/** Whether an item with this weapon type and element is shown under the filter. */
export function matchesWeaponListFilter(
  item: { weaponTypeId: WeaponTypeId; elementId: ElementId },
  filter: WeaponListFilter,
): boolean {
  return (
    (filter.weaponTypeId === null || item.weaponTypeId === filter.weaponTypeId) &&
    (filter.elementId === null || item.elementId === filter.elementId)
  )
}
