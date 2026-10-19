import type {
  BuildListEntry,
  BuildListEntryId,
  OwnedWeaponId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'

/**
 * The Plan start effect (`docs/PLANNER_SPEC.md` 16.2 / 16.11).
 *
 * A ProductionPlan decides which *existing* OwnedWeapon each of its Targets is
 * produced from. Generating or saving the Draft changes nothing persisted; the
 * decision is applied when the Plan starts (`draft -> active`), in the same
 * transaction, as the Target preferred-weapon links below. A production-target
 * Normal the Plan registers later does not exist at start and is linked by its
 * own registration Step instead.
 *
 * The links are a pure function of the Plan's selected BuildListEntries, whose
 * contents the start verifies through `dependentBuildListEntriesHash`, so the
 * execution projection, the Plan start runtime and the Production Plan screen
 * preview all read the same authority and nothing extra is persisted.
 */
export interface ProductionPlanStartTargetLink {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
  ownedWeaponId: OwnedWeaponId
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The Target links the Plan applies at start, sorted by Target ID.
 *
 * A selected Entry qualifies when its Route starts from an existing OwnedWeapon
 * (`BuildRoute.sourceOwnedWeaponId`) and performs at least one operation on it;
 * a zero-operation `existing_gogma_current` Entry only confirms and completes.
 *
 * The preference relation is 1:1, so a link is made only for a weapon that
 * exactly one qualifying Entry starts from, whose Target no other qualifying
 * Entry links. Several selected Entries of different Targets can share one
 * existing Gogma through shared physical actions; such a Plan designates no
 * single Target for that weapon, so no link is made for it rather than picking
 * one by order. A selected Entry absent from `buildListEntries` contributes
 * nothing; callers verify the selected Entries separately.
 */
export function deriveProductionPlanStartTargetLinks(
  selectedBuildListEntryIds: readonly BuildListEntryId[],
  buildListEntries: readonly BuildListEntry[],
): ProductionPlanStartTargetLink[] {
  const entryById = new Map(buildListEntries.map((entry) => [entry.id, entry]))
  const candidates = [...new Set(selectedBuildListEntryIds)].flatMap((id): ProductionPlanStartTargetLink[] => {
    const entry = entryById.get(id)
    if (entry === undefined) return []
    const route = entry.candidateSnapshot.route
    if (route.sourceOwnedWeaponId === null || route.operations.length === 0) return []
    return [{ buildListEntryId: entry.id, targetWeaponId: entry.targetWeaponId, ownedWeaponId: route.sourceOwnedWeaponId }]
  })
  const count = <K extends string>(keys: readonly K[]) => {
    const counts = new Map<K, number>()
    keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1))
    return counts
  }
  const byWeapon = count(candidates.map(({ ownedWeaponId }) => ownedWeaponId))
  const byTarget = count(candidates.map(({ targetWeaponId }) => targetWeaponId))
  return candidates
    .filter(({ ownedWeaponId, targetWeaponId }) =>
      byWeapon.get(ownedWeaponId) === 1 && byTarget.get(targetWeaponId) === 1)
    .sort((left, right) =>
      compareStableStrings(left.targetWeaponId, right.targetWeaponId) ||
      compareStableStrings(left.ownedWeaponId, right.ownedWeaponId))
}

/**
 * The Targets after the start links: each linked Target prefers its weapon and
 * any other Target that preferred that weapon prefers nothing (16.11). Only
 * `preferredOwnedWeaponId` changes; nothing is stamped. The links are unique on
 * both sides, so the result does not depend on their order.
 */
export function applyProductionPlanStartTargetLinks(
  targets: readonly TargetWeapon[],
  links: readonly ProductionPlanStartTargetLink[],
): TargetWeapon[] {
  const next = targets.map((target) => structuredClone(target))
  links.forEach(({ targetWeaponId, ownedWeaponId }) => {
    next.forEach((target) => {
      if (target.id === targetWeaponId) {
        target.preferredOwnedWeaponId = ownedWeaponId
      } else if (target.preferredOwnedWeaponId === ownedWeaponId) {
        target.preferredOwnedWeaponId = null
      }
    })
  })
  return next
}

/** One real preference change the Plan start makes, for the pre-start preview. */
export interface ProductionPlanStartTargetLinkChange {
  buildListEntryId: BuildListEntryId
  ownedWeaponId: OwnedWeaponId
  /** The Target the weapon moves to. */
  targetWeaponId: TargetWeaponId
  /** The Target currently preferring the weapon, or `null` when none does. */
  fromTargetWeaponId: TargetWeaponId | null
  /** The weapon the destination Target currently prefers instead, which it drops. */
  replacedOwnedWeaponId: OwnedWeaponId | null
}

/**
 * The start links that actually change something against the current Targets;
 * a Target already preferring its weapon is no change. A Target that does not
 * exist yields no change here; the start itself refuses a missing dependency.
 */
export function inspectProductionPlanStartTargetLinkChanges(
  targets: readonly TargetWeapon[],
  links: readonly ProductionPlanStartTargetLink[],
): ProductionPlanStartTargetLinkChange[] {
  return links.flatMap((link): ProductionPlanStartTargetLinkChange[] => {
    const destination = targets.find(({ id }) => id === link.targetWeaponId)
    if (destination === undefined || destination.preferredOwnedWeaponId === link.ownedWeaponId) return []
    const from = targets.find(
      ({ id, preferredOwnedWeaponId }) => id !== link.targetWeaponId && preferredOwnedWeaponId === link.ownedWeaponId,
    )
    return [{
      buildListEntryId: link.buildListEntryId,
      ownedWeaponId: link.ownedWeaponId,
      targetWeaponId: link.targetWeaponId,
      fromTargetWeaponId: from?.id ?? null,
      replacedOwnedWeaponId: destination.preferredOwnedWeaponId,
    }]
  })
}
