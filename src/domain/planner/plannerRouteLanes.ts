import type { RouteOperation } from '../models/publicTypes'
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

/** One Entry's Route units split by lane. */
export interface PlannerEntryLanes {
  base: readonly PlannerRouteUnit[]
  bonus: readonly PlannerRouteUnit[]
  skill: readonly PlannerRouteUnit[]
  unitCount: number
}

export function splitPlannerRouteUnitsByLane(
  units: readonly PlannerRouteUnit[],
): PlannerEntryLanes {
  return {
    base: units.filter(({ lane }) => lane === 'base'),
    bonus: units.filter(({ lane }) => lane === 'bonus'),
    skill: units.filter(({ lane }) => lane === 'skill'),
    unitCount: units.length,
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
 * Whether this pending unit holds its Counter position: no other Entry may
 * consume that position before the unit itself runs
 * (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 5 "holding"). It is decided
 * by `canSkipWhenCounterPassed` alone: a skippable unit is passed silently as a
 * historical position once the Counter is past it
 * (`fastForwardPlannerRouteProgress()`, `docs/PLANNER_SPEC.md` 7.0.2). The
 * deterministic scheduler's Route commitment, its frontier and its canonical
 * next-holding distance all judge holding through this one predicate.
 *
 * Calculation schema 11..18 also gated a lane by the pin of a selected
 * compromise checkpoint; Issue #100 removed that gate together with the
 * selection (`docs/PLANNER_SPEC.md` 20.7 / 20.10).
 */
export function isPlannerLaneUnitHolding(unit: PlannerRouteUnit): boolean {
  return !unit.canSkipWhenCounterPassed
}

/**
 * The units this Entry may execute next: the next base unit while the base
 * lane is unfinished, otherwise the next unit of each stream lane, Bonus lane
 * first in a fixed traversal order.
 *
 * Both stream lanes are genuine successors (`docs/PLANNER_SPEC.md` 7.0.4):
 * the Beam Search expands every unit returned here, so a Skill-first and a
 * Bonus-first branch both stay alive and scoring chooses between them. The
 * order here is a traversal order only; it never removes a branch.
 */
export function nextPlannerLaneUnits(
  lanes: PlannerEntryLanes,
  progress: PlannerLaneProgress,
): PlannerRouteUnit[] {
  if (progress.base < lanes.base.length) return [lanes.base[progress.base]]
  const next: PlannerRouteUnit[] = []
  for (const lane of ['bonus', 'skill'] as const) {
    const unit = lanes[lane][progress[lane]]
    if (unit) next.push(unit)
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
