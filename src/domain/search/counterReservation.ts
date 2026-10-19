import type { OwnedWeaponId } from '../models/publicTypes'

/**
 * The held / blocked positions of one Counter stream as Planner Alternative
 * Search consumes them (`docs/SEARCH_SPEC.md` 5.6.8, `docs/PLANNER_SPEC.md`
 * 9.2.19.3 / 9.2.19.4).
 *
 * The Planner derived both sets from the fixed Route set; the Search Domain
 * only reads them and never re-derives required / skippable or shareability.
 *
 * - held: a fixed Route is expected to move the Counter past this position, so
 *   an alternative Route may leave its own weapon untouched here
 * - blocked (a subset of held): the alternative Route must not place its own
 *   operation here (for a Normal Counter: its production-target forge)
 *
 * The ordinary Candidate Search never builds one: an empty reservation holds
 * and blocks nothing, which is exactly the contiguous Route the ordinary
 * Search composes.
 */
export interface CounterReservation {
  isHeld(position: number): boolean
  isBlocked(position: number): boolean
}

export const EMPTY_COUNTER_RESERVATION: CounterReservation = {
  isHeld: () => false,
  isBlocked: () => false,
}

/** A reservation over already validated position sets (`blocked ⊆ held`). */
export function createCounterReservation(
  held: readonly number[],
  blocked: readonly number[],
): CounterReservation {
  if (held.length === 0 && blocked.length === 0) return EMPTY_COUNTER_RESERVATION
  const heldSet = new Set(held)
  const blockedSet = new Set(blocked)
  return {
    isHeld: (position) => heldSet.has(position),
    isBlocked: (position) => blockedSet.has(position),
  }
}

/**
 * Where one stream's next own operation may stand, given that the Counter now
 * stands at `from` (the position right after the previous own operation, or the
 * stream origin), and every position must be an own operation or held
 * (the 5.6.8 coverage condition).
 *
 * Walking from `from`: a position that is not blocked is a legal operation
 * position; a held position may also be skipped, so the walk continues past it;
 * the first position that is not held ends the walk, because the Route cannot
 * leave it uncovered. So the result is `[from, f] \ blocked`, where `f` is the
 * first non-held position at or after `from`, cut at `limit` (exclusive).
 *
 * `beyondLimit` is true when the walk reached `limit`: a legal position still
 * lay at or beyond it (the first non-held position is never blocked, because
 * blocked positions are held), so the extent, not the stream, ended the walk.
 *
 * `onSkip` runs before every held position the walk passes beyond `from`, so a
 * long held run stays cancellable; an empty reservation never calls it.
 */
export async function nextOperationPositions(
  reservation: CounterReservation,
  from: number,
  limit: number,
  onSkip: () => Promise<void>,
): Promise<{ positions: number[]; beyondLimit: boolean }> {
  const positions: number[] = []
  for (let position = from; ; position += 1) {
    if (position >= limit) return { positions, beyondLimit: true }
    if (position !== from) await onSkip()
    if (!reservation.isBlocked(position)) positions.push(position)
    if (!reservation.isHeld(position)) return { positions, beyondLimit: false }
  }
}

/**
 * The canonical `create_normal_artian` of a predicted alternative Normal Route
 * (`docs/PLANNER_SPEC.md` 9.2.19.4 held prefix).
 *
 * `skippableHeldPrefix` is the run of held positions starting at `origin` and
 * ending before `targetPosition`; the fixed Routes forge it. Held positions at
 * or after `targetPosition` never extend it. The alternative Route forges every
 * position from right after that prefix through its own production target.
 * With no held position this is the ordinary `origin / target + 1` creation.
 */
export function heldPrefixNormalCreation(
  reservation: CounterReservation,
  origin: number,
  targetPosition: number,
): { normalCounterBefore: number; normalCounterAfter: number; count: number } {
  let normalCounterBefore = origin
  while (normalCounterBefore < targetPosition && reservation.isHeld(normalCounterBefore)) {
    normalCounterBefore += 1
  }
  const normalCounterAfter = targetPosition + 1
  return { normalCounterBefore, normalCounterAfter, count: normalCounterAfter - normalCounterBefore }
}

/**
 * The fixed Route set's reservation as the Route search primitives read it
 * (Planner Alternative Search only; `RouteSearchContext.reservation`).
 */
export interface RouteSearchReservation {
  /** The Normal Counter reservation of one `NormalArtianCounter.id`. */
  normal(counterId: string): CounterReservation
  skill: CounterReservation
  gogma: CounterReservation
  /**
   * OwnedWeapons a fixed Route uses or consumes. Never a Route source or an
   * amendment subject of an alternative Route: a hard constraint, unrelated to
   * `TargetWeapon.preferredOwnedWeaponId` (`docs/PLANNER_SPEC.md` 9.2.19.3).
   */
  exclusiveOwnedWeaponIds: ReadonlySet<OwnedWeaponId>
  /**
   * The exclusive upper bound of a conversion's Skill position: the Skill
   * window of a conversion Route is `origin .. origin + maxSkillAdvance`
   * (`docs/SEARCH_SPEC.md` 3.1), held positions included.
   */
  conversionSkillPositionLimit: number
}
