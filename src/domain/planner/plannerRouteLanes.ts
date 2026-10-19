import type { RouteOperation } from '../models/publicTypes'
import type { IntermediatePin } from './plannerCheckpoints'
import type { PlannerRouteUnit } from './plannerRouteProgress'

/**
 * The three execution lanes of one Route (`docs/PLANNER_SPEC.md` 7.0.4).
 *
 * `base` is the creation / conversion prefix and runs strictly first. `bonus`
 * (Reset / Keep Bonuses) and `skill` (Reset Skills) are the two independent
 * RNG streams: each keeps its own Route order, but the Planner interleaves the
 * two freely, because a Bonus amendment reads nothing a Skill amendment writes
 * and vice versa (`docs/SEARCH_SPEC.md` 5.4).
 */
export type PlannerRouteLane = 'base' | 'bonus' | 'skill'

export function routeOperationLane(operation: RouteOperation): PlannerRouteLane {
  switch (operation.type) {
    case 'create_normal_artian':
    case 'convert_normal_to_gogma':
      return 'base'
    case 'reset_bonuses':
    case 'keep_bonuses':
      return 'bonus'
    case 'reset_skills':
      return 'skill'
  }
}

/** Units executed (or silently passed) per lane; Planner runtime state only. */
export interface PlannerLaneProgress {
  base: number
  bonus: number
  skill: number
}

export function initialPlannerLaneProgress(): PlannerLaneProgress {
  return { base: 0, bonus: 0, skill: 0 }
}

export function totalPlannerLaneProgress(progress: PlannerLaneProgress): number {
  return progress.base + progress.bonus + progress.skill
}

/** One Entry's Route units split by lane, plus its compromise checkpoint pin. */
export interface PlannerEntryLanes {
  base: readonly PlannerRouteUnit[]
  bonus: readonly PlannerRouteUnit[]
  skill: readonly PlannerRouteUnit[]
  unitCount: number
  /** `null` means the Entry selected no intermediate state and has no checkpoint. */
  pin: IntermediatePin | null
}

export function splitPlannerRouteUnitsByLane(
  units: readonly PlannerRouteUnit[],
  pin: IntermediatePin | null,
): PlannerEntryLanes {
  return {
    base: units.filter(({ lane }) => lane === 'base'),
    bonus: units.filter(({ lane }) => lane === 'bonus'),
    skill: units.filter(({ lane }) => lane === 'skill'),
    unitCount: units.length,
    pin,
  }
}

export function isPlannerLaneRouteComplete(
  lanes: PlannerEntryLanes,
  progress: PlannerLaneProgress,
): boolean {
  return (
    progress.base >= lanes.base.length &&
    progress.bonus >= lanes.bonus.length &&
    progress.skill >= lanes.skill.length
  )
}

/**
 * Whether running this lane unit now would move its lane past the Entry's
 * pinned checkpoint position before the other lane reached its own pin.
 *
 * The compromise checkpoint is the moment both lanes hold their pinned state
 * at once (`docs/PLANNER_SPEC.md` 7.5.2). A lane may therefore not advance
 * beyond its pin until the other lane has arrived, and a fast-forward may not
 * pass it either. Base units are never gated, and an Entry with no selection
 * has no pin.
 */
export function isPlannerLaneUnitBlockedByPin(
  unit: PlannerRouteUnit,
  progress: PlannerLaneProgress,
  pin: IntermediatePin | null,
): boolean {
  if (pin === null || unit.lane === 'base') return false
  const other = unit.lane === 'bonus' ? 'skill' : 'bonus'
  return unit.laneIndex + 1 > pin[unit.lane] && progress[other] < pin[other]
}

/**
 * Whether this pending unit holds its Counter position: no other Entry may
 * consume that position before the unit itself runs
 * (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 5 "holding"). It is decided
 * by `canSkipWhenCounterPassed` alone - every selected checkpoint endpoint is
 * among the holding units, because the unit that produces a pinned state is
 * never skippable (`docs/PLANNER_SPEC.md` 7.5.1).
 *
 * The checkpoint pin is deliberately not read here. A pin gates the Entry's
 * own lane progress, not the Counter position of a skippable unit: another
 * Entry may consume that position while the pin blocks the unit, the Entry's
 * progress stays at the pin, and once the pin is released the unit is passed
 * silently as a historical position (`isPlannerLaneUnitFastForwardable()`,
 * PLANNER_SPEC 7.5.2). The deterministic scheduler's Route commitment, its
 * frontier and its canonical next-holding distance all judge holding through
 * this one predicate.
 */
export function isPlannerLaneUnitHolding(unit: PlannerRouteUnit): boolean {
  return !unit.canSkipWhenCounterPassed
}

/**
 * Whether `fastForwardPlannerRouteProgress()` may pass this unit at the
 * Entry's current lane progress once the Counter is past its position: it is
 * `canSkipWhenCounterPassed` and its checkpoint pin does not block it now
 * (design 5 "fast-forwardable now"). A pin-blocked skippable unit is not
 * holding, but its progress waits at the pin until the other lane arrives.
 */
export function isPlannerLaneUnitFastForwardable(
  unit: PlannerRouteUnit,
  progress: PlannerLaneProgress,
  pin: IntermediatePin | null,
): boolean {
  return unit.canSkipWhenCounterPassed && !isPlannerLaneUnitBlockedByPin(unit, progress, pin)
}

/**
 * Whether the Entry's weapon holds both pinned lane states (`false` without a
 * pin). The base lane must be finished too: a conversion Route's lane starts
 * describe the converted weapon, which does not exist before the conversion
 * ran, whereas an existing Gogma's lane starts are held from the very start
 * (`docs/PLANNER_SPEC.md` 7.5.2).
 */
export function hasReachedIntermediatePin(
  lanes: PlannerEntryLanes,
  progress: PlannerLaneProgress,
): boolean {
  const { pin } = lanes
  return (
    pin !== null &&
    progress.base >= lanes.base.length &&
    progress.skill >= pin.skill &&
    progress.bonus >= pin.bonus
  )
}

/**
 * The units this Entry may execute next: the next base unit while the base
 * lane is unfinished, otherwise the next unit of each stream lane that the
 * checkpoint pin allows, Bonus lane first in a fixed traversal order.
 *
 * Both stream lanes are genuine successors (`docs/PLANNER_SPEC.md` 7.0.4):
 * the Beam Search expands every unit returned here, so a Skill-first and a
 * Bonus-first branch both stay alive and scoring - including the soft
 * improvement preference of 7.6 - chooses between them. The order here is a
 * traversal order only; it never removes a branch and never expresses the
 * preference.
 */
export function nextPlannerLaneUnits(
  lanes: PlannerEntryLanes,
  progress: PlannerLaneProgress,
): PlannerRouteUnit[] {
  if (progress.base < lanes.base.length) return [lanes.base[progress.base]]
  const next: PlannerRouteUnit[] = []
  for (const lane of ['bonus', 'skill'] as const) {
    const unit = lanes[lane][progress[lane]]
    if (unit && !isPlannerLaneUnitBlockedByPin(unit, progress, lanes.pin)) next.push(unit)
  }
  return next
}

/** Every unit not yet executed or passed, in lane order: base, bonus, skill. */
export function remainingPlannerLaneUnits(
  lanes: PlannerEntryLanes,
  progress: PlannerLaneProgress,
): PlannerRouteUnit[] {
  return [
    ...lanes.base.slice(progress.base),
    ...lanes.bonus.slice(progress.bonus),
    ...lanes.skill.slice(progress.skill),
  ]
}

export function advancePlannerLaneProgress(
  progress: PlannerLaneProgress,
  unit: PlannerRouteUnit,
): PlannerLaneProgress {
  return { ...progress, [unit.lane]: progress[unit.lane] + 1 }
}
