import { createTargetDefinitionHash } from '../../buildList'
import {
  normalizeKnownValue,
  normalizeReferencedOwnedWeapon,
  V1_NORMAL_ARTIAN_RARITY,
} from '../../models/publicTypes'
import type {
  TargetWeapon,
  TargetWeaponId,
} from '../../models/publicTypes'
import {
  selectCompatibleOwnedGogmaWeapons,
  selectConvertibleOwnedNormalArtianWeapons,
} from '../../search'
import type { ConstrainedSearchOrigin } from '../../search'
import type { PlannerInput } from '../plannerTypes'
import { ConstrainedMaterializationError } from './plannerMaterializationErrors'

/**
 * The Planner-start Search / RNG origin (PLANNER_SPEC 9.2.1, 9.2.9): building
 * it from a Planner input, resolving a Target from it, and normalizing it into
 * the stable value a deterministic search identity hashes.
 *
 * A shared Planner Domain primitive since Phase 6-B2a (PLANNER_SPEC 9.2.19.16):
 * the Planner Alternative search identity normalizes the origin here and keeps
 * only its own route policy token (the legacy B8 constrained search identity
 * that shared it was removed in Phase 6-B2b). The origin value itself is the
 * Search Domain's `ConstrainedSearchOrigin` shape.
 */

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The Planner-start Search / RNG snapshot (PLANNER_SPEC 9.2.1, 9.2.9).
 *
 * It is built once, from the *original* Planner input, and reused by every
 * search of that request. It is never rebuilt from an adopted Planner state,
 * from a full Planner run bestState, or from `conflictingCounter + 1`, and it
 * needs no historical UI Candidate Search request: it carries no `searchRunId`,
 * `routeFilter`, or `settings`.
 */
export function createPlannerStartSearchOrigin(
  input: PlannerInput,
): ConstrainedSearchOrigin {
  return {
    rngState: structuredClone(input.rngState),
    normalCounters: structuredClone(input.normalCounters),
    ownedWeapons: structuredClone(input.ownedWeapons),
    targetWeapons: structuredClone(input.targetWeapons),
    master: structuredClone(input.master),
    calculationContext: structuredClone(input.calculationContext),
  }
}

/** The origin's own TargetWeapon; a Target outside the origin fails closed. */
export function resolvePlannerSearchOriginTarget(
  origin: ConstrainedSearchOrigin,
  targetWeaponId: TargetWeaponId,
): TargetWeapon {
  const target = origin.targetWeapons.find(({ id }) => id === targetWeaponId)
  if (!target) {
    throw new ConstrainedMaterializationError(
      'target_mismatch',
      `TargetWeapon '${targetWeaponId}' is not part of the constrained search origin.`,
    )
  }
  return target
}

/**
 * The Planner-start Search / RNG semantic origin, normalized for a stable value.
 *
 * PLANNER_SPEC 9.2.13 names its constituents: Base Seed, the relevant Counter
 * group, the referenced OwnedWeapon semantics, and the Target definition. Every
 * collection here is set-shaped, so it is sorted by ID; the five restoration
 * bonus slots inside a weapon stay in stored order, because Keep preserves the
 * family at each slot position, which makes that order semantic.
 *
 * Deliberately absent:
 *
 * - Legacy `RngState.counterGate`, which is not Production prediction authority
 * - `KnownValue.source`, notes, and observation timestamps
 * - The `SearchMasterSubset` itself. Master identity reaches the value through
 *   `CalculationContext.masterDataVersion`, which is the versioning authority;
 *   hashing the loaded Master subset would make the identity depend on how the
 *   subset happened to be assembled.
 * - Every other Target in the snapshot, and every OwnedWeapon that cannot be a
 *   Route source for this Target - including a protected Owned Normal Artian
 *   weapon, which no automatic conversion Route may consume. Both are decided
 *   with the same shared eligibility selectors the Search Domain builds its
 *   Route bases with, never with a second Planner-only rule.
 */
export function normalizePlannerSearchOrigin(
  origin: ConstrainedSearchOrigin,
  target: TargetWeapon,
) {
  const relevantNormalCounters = origin.normalCounters
    .filter(
      (counter) =>
        counter.weaponTypeId === target.weaponTypeId &&
        counter.rarity === V1_NORMAL_ARTIAN_RARITY,
    )
    .map(({ id, counter, isConfirmed }) => ({ id, counter, isConfirmed }))
    .sort((left, right) => compareIds(left.id, right.id))

  // The very selectors the Search Domain builds its Route bases with, so the
  // identity covers exactly the sources a search can use. A protected Owned
  // Normal is never an automatic conversion source, so it is absent here; an
  // Owned Gogma stays in scope while protected, because
  // `existing_gogma_reset_skills` may use it, and its protection state is part
  // of the normalized semantics.
  const relevantOwnedWeapons = [
    ...selectConvertibleOwnedNormalArtianWeapons(target, origin.ownedWeapons),
    ...selectCompatibleOwnedGogmaWeapons(target, origin.ownedWeapons),
  ]
    .sort((left, right) => compareIds(left.id, right.id))
    .map(normalizeReferencedOwnedWeapon)

  return {
    baseSeed: normalizeKnownValue(origin.rngState.baseSeed),
    gogmaCounter: normalizeKnownValue(origin.rngState.gogmaCounter),
    skillCounter: normalizeKnownValue(origin.rngState.skillCounter),
    normalCounters: relevantNormalCounters,
    ownedWeapons: relevantOwnedWeapons,
    targetDefinitionHash: createTargetDefinitionHash(target),
  }
}
