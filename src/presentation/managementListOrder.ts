/**
 * Display-order contract of the management lists (`docs/UI_FLOW.md` 3.2).
 *
 * Owned Weapons and Target Weapons are never auto-sorted: a new item is
 * appended, an edited item replaces itself at its original index, and a
 * deletion keeps every other item's relative order. Editing alone must never
 * move an item to the end.
 */
export function upsertPreservingOrder<T extends { id: string }>(
  items: readonly T[],
  saved: T,
): T[] {
  const index = items.findIndex(({ id }) => id === saved.id)
  if (index === -1) return [...items, saved]
  return items.map((item, position) => (position === index ? saved : item))
}

/** An entity with the creation timestamp `docs/DATA_MODEL.md` sets once and never updates. */
export interface RegistrationOrdered {
  id: string
  createdAt: string
}

/**
 * Registration order (`docs/UI_FLOW.md` 3.2): oldest `createdAt` first, then
 * the ID as a stable tie-break for items registered at the same instant.
 *
 * `createdAt` is set when the item is created and is never rewritten by an
 * edit, so this order is the same before and after a reload: a new item lands
 * at the end, an edit keeps its position, and a deletion keeps the others'
 * relative order. Neither the ID nor a repository's array order is read as
 * the registration order. A timestamp that cannot be parsed sorts after every
 * valid one (still by ID), so it never breaks the order of the rest.
 *
 * Presentation only: repositories, Search and Planner inputs keep their own
 * order.
 */
export function compareByRegistrationOrder(
  left: RegistrationOrdered,
  right: RegistrationOrdered,
): number {
  const leftTime = Date.parse(left.createdAt)
  const rightTime = Date.parse(right.createdAt)
  const leftValid = !Number.isNaN(leftTime)
  const rightValid = !Number.isNaN(rightTime)
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  if (leftValid && leftTime !== rightTime) return leftTime - rightTime
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** A registration-ordered copy; the input array is left untouched. */
export function sortByRegistrationOrder<T extends RegistrationOrdered>(items: readonly T[]): T[] {
  return [...items].sort(compareByRegistrationOrder)
}
