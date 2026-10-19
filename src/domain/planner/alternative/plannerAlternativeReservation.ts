import { collectReferencedOwnedWeaponIds } from '../../models/hashing'
import type {
  BuildListEntry,
  BuildListEntryId,
  OwnedWeaponId,
} from '../../models/publicTypes'
import { stableStringify } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import { normalizePlannerAlternativeReservation } from '../../search'
import type { PlannerAlternativeReservation } from '../../search'
import {
  createPlannerRouteUnitPlans,
  routeUnitOwnedWeaponId,
  type PlannerRouteUnit,
} from '../plannerRouteProgress'

export type PlannerAlternativeReservationErrorCode =
  /** A fixed Entry's Route has no Route unit plan (the same rejection the Planner raises). */
  | 'fixed_route_unplannable'
  /** Two fixed Entries share one ID with different content. */
  | 'conflicting_fixed_entry'

export class PlannerAlternativeReservationError extends Error {
  readonly code: PlannerAlternativeReservationErrorCode
  readonly buildListEntryId: BuildListEntryId

  constructor(
    code: PlannerAlternativeReservationErrorCode,
    buildListEntryId: BuildListEntryId,
    message: string,
  ) {
    super(message)
    this.name = 'PlannerAlternativeReservationError'
    this.code = code
    this.buildListEntryId = buildListEntryId
  }
}

/**
 * Whether an alternative Route's unit could be one shared physical action
 * with this fixed required unit, judged by the existing sharing authority's
 * meaning (`physicalActionKey` / `shareable`, `arePlannerRouteUnitsShareable()`).
 *
 * A shareable unit's physical action is keyed by its concrete OwnedWeapon, so
 * an alternative unit could share it only by operating on that same weapon.
 * Every weapon a fixed Route uses is exclusive to it, and an alternative Route
 * never uses an exclusive weapon; so in v1 this is always false - a transient
 * Gogma is Entry-local and a Normal creation is never shareable - and every
 * required unit's position is blocked. The check stays so a wider sharing
 * contract is re-derived here instead of being hard-coded away
 * (`docs/PLANNER_SPEC.md` 9.2.19.3).
 */
function alternativeCouldShareFixedUnit(
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
  exclusiveOwnedWeaponIds: ReadonlySet<OwnedWeaponId>,
): boolean {
  if (!unit.shareable) return false
  const subject = routeUnitOwnedWeaponId(entry, unit)
  return subject !== null && !exclusiveOwnedWeaponIds.has(subject)
}

function streamKey(unit: PlannerRouteUnit): string | null {
  if (unit.counterStream === null || unit.counterBefore === null) return null
  return unit.counterStream === 'normal' ? `normal\u0000${unit.counterId}` : unit.counterStream
}

/**
 * Derives the resource reservation of a fixed Route set
 * (`docs/PLANNER_SPEC.md` 9.2.19.3), on the Planner side only and only from the
 * existing authorities: `createPlannerRouteUnitPlans()` (each unit's Counter
 * stream, Counter ID, `counterBefore`, `canSkipWhenCounterPassed`,
 * `physicalActionKey` / `shareable`, `exclusiveConsumedOwnedWeaponId`) and
 * `collectReferencedOwnedWeaponIds()`.
 *
 * - held: every position a fixed unit holds, required and skippable alike
 *   (a Normal Counter per `counterId`); a fixed Route (or another Entry's real
 *   operation fast-forwarding it) is expected to move the Counter past it
 * - blocked: the positions of the fixed required units
 *   (`canSkipWhenCounterPassed = false`) an alternative unit cannot share; a
 *   Normal Counter-advance forge (Issue #129) is held but never blocked, the
 *   production-target forge is both
 * - exclusive OwnedWeapons: every weapon a fixed Route references or
 *   exclusively consumes
 *
 * A blind creation holds no Counter position and reserves none. The result is
 * a semantic set: the same fixed Routes in any order, or repeated, give the
 * same normalized reservation. A fixed Route without a unit plan fails closed.
 */
export function derivePlannerAlternativeReservation(
  fixedEntries: readonly BuildListEntry[],
  engine: RngEngine,
): PlannerAlternativeReservation {
  const byId = new Map<BuildListEntryId, BuildListEntry>()
  for (const entry of fixedEntries) {
    const known = byId.get(entry.id)
    if (known !== undefined && stableStringify(known) !== stableStringify(entry)) {
      throw new PlannerAlternativeReservationError(
        'conflicting_fixed_entry',
        entry.id,
        `Two fixed BuildListEntries share the ID '${entry.id}' with different content.`,
      )
    }
    byId.set(entry.id, entry)
  }
  const entries = [...byId.values()]
  const plans = createPlannerRouteUnitPlans(entries, engine)
  const [rejection] = plans.rejections
  if (rejection !== undefined) {
    throw new PlannerAlternativeReservationError(
      'fixed_route_unplannable',
      rejection.buildListEntryId,
      `Fixed BuildListEntry '${rejection.buildListEntryId}' has no Route unit plan: ${rejection.detail}`,
    )
  }

  const exclusive = new Set<OwnedWeaponId>()
  entries.forEach((entry) => {
    collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route).forEach((id) => exclusive.add(id))
    plans.unitPlans.get(entry.id)?.forEach((unit) => {
      if (unit.exclusiveConsumedOwnedWeaponId !== null) exclusive.add(unit.exclusiveConsumedOwnedWeaponId)
    })
  })

  const held = new Map<string, Set<number>>()
  const blocked = new Map<string, Set<number>>()
  const add = (sets: Map<string, Set<number>>, key: string, position: number) => {
    const set = sets.get(key) ?? new Set<number>()
    set.add(position)
    sets.set(key, set)
  }
  entries.forEach((entry) => {
    plans.unitPlans.get(entry.id)?.forEach((unit) => {
      const key = streamKey(unit)
      if (key === null || unit.counterBefore === null) return
      add(held, key, unit.counterBefore)
      if (!unit.canSkipWhenCounterPassed && !alternativeCouldShareFixedUnit(entry, unit, exclusive)) {
        add(blocked, key, unit.counterBefore)
      }
    })
  })

  const stream = (key: string) => ({
    held: [...(held.get(key) ?? [])],
    blocked: [...(blocked.get(key) ?? [])],
  })
  return normalizePlannerAlternativeReservation({
    normal: [...held.keys()]
      .filter((key) => key.startsWith('normal\u0000'))
      .map((key) => ({ counterId: key.slice('normal\u0000'.length), ...stream(key) })),
    skill: stream('skill'),
    gogma: stream('gogma'),
    exclusiveOwnedWeaponIds: [...exclusive],
  })
}
