import type { OwnedWeaponId, TargetWeapon } from '../../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../../models/publicTypes'
import {
  collectConstrainedSearchOriginIssues,
  type ConstrainedSearchValidationIssue,
} from '../constrained/constrainedValidation'
import {
  PlannerAlternativeSearchError,
  type PlannerAlternativeNormalReservation,
  type PlannerAlternativeReservation,
  type PlannerAlternativeSearchExtent,
  type PlannerAlternativeSearchInput,
  type PlannerAlternativeStreamReservation,
} from './plannerAlternativeTypes'

function positiveIntegerIssue(
  value: number,
  path: string,
): ConstrainedSearchValidationIssue | null {
  return Number.isInteger(value) && value >= 1
    ? null
    : { path, message: `${path} must be an integer greater than or equal to 1.` }
}

/**
 * Every extent value is a caller-supplied integer of at least 1
 * (`docs/PLANNER_SPEC.md` 9.2.19.12). No default substitution, fallback, clamp
 * or field-wise completion happens here.
 */
export function validatePlannerAlternativeSearchExtent(
  extent: PlannerAlternativeSearchExtent,
): ConstrainedSearchValidationIssue[] {
  return [
    positiveIntegerIssue(extent.maxNormalAdvance, 'extent.maxNormalAdvance'),
    positiveIntegerIssue(extent.maxGogmaAdvance, 'extent.maxGogmaAdvance'),
    positiveIntegerIssue(extent.maxSkillAdvance, 'extent.maxSkillAdvance'),
  ].filter((issue): issue is ConstrainedSearchValidationIssue => issue !== null)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUniquePositions(positions: readonly number[]): number[] {
  return [...new Set(positions)].sort((left, right) => left - right)
}

function positionIssues(
  positions: readonly number[],
  path: string,
): ConstrainedSearchValidationIssue[] {
  return positions.flatMap((position, index) =>
    Number.isInteger(position) && position >= 0
      ? []
      : [{ path: `${path}[${index}]`, message: `${path} holds Counter positions, which must be non-negative integers.` }],
  )
}

function subsetIssues(
  held: readonly number[],
  blocked: readonly number[],
  path: string,
): ConstrainedSearchValidationIssue[] {
  const heldSet = new Set(held)
  const outside = sortedUniquePositions(blocked.filter((position) => !heldSet.has(position)))
  return outside.length === 0
    ? []
    : [{ path: `${path}.blocked`, message: `${path}.blocked must be a subset of held; not held: ${outside.join(', ')}.` }]
}

function streamIssues(
  stream: PlannerAlternativeStreamReservation,
  path: string,
): ConstrainedSearchValidationIssue[] {
  return [
    ...positionIssues(stream.held, `${path}.held`),
    ...positionIssues(stream.blocked, `${path}.blocked`),
  ]
}

function mergeNormalEntries(
  entries: readonly PlannerAlternativeNormalReservation[],
): PlannerAlternativeNormalReservation[] {
  const byCounter = new Map<string, { held: number[]; blocked: number[] }>()
  entries.forEach((entry) => {
    const merged = byCounter.get(entry.counterId) ?? { held: [], blocked: [] }
    merged.held.push(...entry.held)
    merged.blocked.push(...entry.blocked)
    byCounter.set(entry.counterId, merged)
  })
  return [...byCounter]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([counterId, { held, blocked }]) => ({
      counterId,
      held: sortedUniquePositions(held),
      blocked: sortedUniquePositions(blocked),
    }))
}

/**
 * Fails closed on a reservation the Search cannot read as a semantic set
 * (`docs/SEARCH_SPEC.md` 5.6.8):
 *
 * - every Counter position is a non-negative integer
 * - `blocked ⊆ held` on every stream (on a Normal Counter, over the union of
 *   every entry naming that Counter)
 * - a Normal entry names a rarity-8 `NormalArtianCounter.id` (`<weaponTypeId>:8`,
 *   the form the Planner's Route units and Counter validation share)
 * - an exclusive OwnedWeapon ID is a non-empty string
 *
 * Array order and duplicates are not errors: the reservation is a set, and
 * `normalizePlannerAlternativeReservation()` folds them.
 */
export function collectPlannerAlternativeReservationIssues(
  reservation: PlannerAlternativeReservation,
): ConstrainedSearchValidationIssue[] {
  const issues: ConstrainedSearchValidationIssue[] = [
    ...streamIssues(reservation.skill, 'reservation.skill'),
    ...subsetIssues(reservation.skill.held, reservation.skill.blocked, 'reservation.skill'),
    ...streamIssues(reservation.gogma, 'reservation.gogma'),
    ...subsetIssues(reservation.gogma.held, reservation.gogma.blocked, 'reservation.gogma'),
  ]
  const suffix = `:${V1_NORMAL_ARTIAN_RARITY}`
  reservation.normal.forEach((entry, index) => {
    const path = `reservation.normal[${index}]`
    if (
      typeof entry.counterId !== 'string' ||
      !entry.counterId.endsWith(suffix) ||
      entry.counterId.length === suffix.length
    ) {
      issues.push({ path: `${path}.counterId`, message: `${path}.counterId must be a rarity-8 NormalArtianCounter ID ('<weaponTypeId>${suffix}').` })
    }
    issues.push(...streamIssues(entry, path))
  })
  mergeNormalEntries(reservation.normal).forEach((entry) => {
    issues.push(...subsetIssues(entry.held, entry.blocked, `reservation.normal[${entry.counterId}]`))
  })
  reservation.exclusiveOwnedWeaponIds.forEach((id, index) => {
    if (typeof id !== 'string' || id.length === 0) {
      issues.push({ path: `reservation.exclusiveOwnedWeaponIds[${index}]`, message: 'An exclusive OwnedWeapon ID must be a non-empty string.' })
    }
  })
  return issues
}

/**
 * The semantic-set form of a valid reservation: every position list sorted and
 * deduplicated, Normal entries merged per Counter ID, sorted by it and dropped
 * when they reserve nothing, exclusive OwnedWeapon IDs sorted and
 * deduplicated. Two reservations that differ only in array order or
 * duplicates normalize to the same value, so neither the search nor its
 * deterministic identity depends on them.
 */
export function normalizePlannerAlternativeReservation(
  reservation: PlannerAlternativeReservation,
): PlannerAlternativeReservation {
  return {
    normal: mergeNormalEntries(reservation.normal)
      .filter(({ held, blocked }) => held.length > 0 || blocked.length > 0),
    skill: {
      held: sortedUniquePositions(reservation.skill.held),
      blocked: sortedUniquePositions(reservation.skill.blocked),
    },
    gogma: {
      held: sortedUniquePositions(reservation.gogma.held),
      blocked: sortedUniquePositions(reservation.gogma.blocked),
    },
    exclusiveOwnedWeaponIds: [...new Set(reservation.exclusiveOwnedWeaponIds)]
      .sort(compareStrings) as OwnedWeaponId[],
  }
}

/**
 * `excludedRouteKeys` as a semantic set: sorted and deduplicated, so the
 * caller's array order never reaches the search identity.
 */
export function normalizePlannerAlternativeExcludedRouteKeys(
  keys: readonly string[],
): string[] {
  return [...new Set(keys)].sort(compareStrings)
}

/**
 * Whether the reservation reserves nothing at all: no held or blocked position
 * on any stream and no exclusive OwnedWeapon. That is the "no fixed Route" case
 * (`docs/SEARCH_SPEC.md` 5.6.8).
 */
export function isEmptyPlannerAlternativeReservation(
  reservation: PlannerAlternativeReservation,
): boolean {
  const empty = (stream: PlannerAlternativeStreamReservation) =>
    stream.held.length === 0 && stream.blocked.length === 0
  return (
    reservation.normal.every(empty) &&
    empty(reservation.skill) &&
    empty(reservation.gogma) &&
    reservation.exclusiveOwnedWeaponIds.length === 0
  )
}

/**
 * Fails closed on an invalid origin, Target selection, extent or reservation,
 * and returns the searched Target with the normalized reservation.
 */
export function assertPlannerAlternativeSearchInput(
  input: PlannerAlternativeSearchInput,
): { target: TargetWeapon; reservation: PlannerAlternativeReservation } {
  const issues = validatePlannerAlternativeSearchExtent(input.extent)
  const origin = collectConstrainedSearchOriginIssues(
    input.origin,
    input.targetWeaponId,
  )
  issues.push(...origin.issues)
  if (issues.length > 0 || !origin.target) {
    throw new PlannerAlternativeSearchError(
      'invalid_input',
      issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }
  const reservationIssues = collectPlannerAlternativeReservationIssues(input.reservation)
  if (reservationIssues.length > 0) {
    throw new PlannerAlternativeSearchError(
      'invalid_reservation',
      reservationIssues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }
  return {
    target: origin.target,
    reservation: normalizePlannerAlternativeReservation(input.reservation),
  }
}
