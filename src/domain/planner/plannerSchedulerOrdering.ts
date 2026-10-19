import type { BuildListEntryId } from '../models/publicTypes'
import type { PlannerRouteUnit } from './plannerRouteProgress'

/**
 * The canonical action order of the deterministic scheduler
 * (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 7.7).
 *
 * When several safe actions exist, exactly one is applied: the first by the
 * lexicographic key below. Safe actions commute (7.9), so this order never
 * decides whether a committed Route completes; it only decides Step order,
 * which weapon consumes a passable position, weapon switches and improvement
 * preference violations. Neither `evaluationScore` nor the preferred source
 * takes part (6.7 / 11).
 */

/**
 * - `holding`     the one physical action that runs the holding units of its
 *   stream position (7.3 case 1)
 * - `executor`    a passable unit consuming a position no holding unit needs,
 *   one candidate per executor (7.3 case 2)
 * - `blind_forge` a blind `create_normal_artian`, which has no stream position
 *   (7.3 case 3)
 */
export type PlannerScheduleActionKind = 'holding' | 'executor' | 'blind_forge'

export interface PlannerScheduleActionOrderKey {
  /** Key 1: the highest Target priority among the progressed Entries. */
  readonly maxTargetPriority: number
  /** Key 2: whether the action adds an improvement preference violation. */
  readonly addsImprovementPreferenceViolation: boolean
  /** Key 3: whether the action adds a weapon switch. */
  readonly addsWeaponSwitch: boolean
  /**
   * Key 4: for an executor, how far the executor Entry's next holding unit on
   * the same stream is; 0 for every other kind.
   */
  readonly executorHoldingDistance: number
  /** Key 5: the fewest remaining units among the progressed Entries. */
  readonly minRemainingPendingUnits: number
  /** Key 6: stream order (Normal / blind forge, then Skill, then Gogma). */
  readonly streamRank: number
  readonly streamKey: string
  /** Key 6: the Counter position, -1 for a blind forge. */
  readonly counterBefore: number
  /** Key 6: the primary Entry. */
  readonly primaryBuildListEntryId: BuildListEntryId
  /** Final tie-break: the primary unit's position in its Route. */
  readonly unitKey: string
}

export interface PlannerScheduleAction {
  readonly kind: PlannerScheduleActionKind
  /** `gogma`, `skill`, `normal:<NormalArtianCounter ID>`, or `null` for a blind forge. */
  readonly streamKey: string | null
  readonly primary: PlannerRouteUnit
  /** Every unit this one physical action progresses, the primary included. */
  readonly progressedUnits: readonly PlannerRouteUnit[]
  readonly orderKey: PlannerScheduleActionOrderKey
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareBooleansFalseFirst(left: boolean, right: boolean): number {
  return left === right ? 0 : left ? 1 : -1
}

/** The Counter stream a unit consumes, as the scheduler names it. */
export function plannerScheduleStreamKey(unit: PlannerRouteUnit): string | null {
  switch (unit.counterStream) {
    case 'gogma':
      return 'gogma'
    case 'skill':
      return 'skill'
    case 'normal':
      return `normal:${unit.counterId ?? ''}`
    case null:
      return null
  }
}

/** Normal streams and blind forges first, then Skill, then Gogma (7.7 key 6). */
export function plannerScheduleStreamRank(streamKey: string | null): number {
  if (streamKey === null || streamKey.startsWith('normal:')) return 0
  if (streamKey === 'skill') return 1
  return 2
}

/** Negative when `left` is applied before `right`. */
export function comparePlannerScheduleActions(
  left: PlannerScheduleAction,
  right: PlannerScheduleAction,
): number {
  const a = left.orderKey
  const b = right.orderKey
  return (
    b.maxTargetPriority - a.maxTargetPriority ||
    compareBooleansFalseFirst(
      a.addsImprovementPreferenceViolation,
      b.addsImprovementPreferenceViolation,
    ) ||
    compareBooleansFalseFirst(a.addsWeaponSwitch, b.addsWeaponSwitch) ||
    a.executorHoldingDistance - b.executorHoldingDistance ||
    a.minRemainingPendingUnits - b.minRemainingPendingUnits ||
    a.streamRank - b.streamRank ||
    compareStableStrings(a.streamKey, b.streamKey) ||
    a.counterBefore - b.counterBefore ||
    compareStableStrings(a.primaryBuildListEntryId, b.primaryBuildListEntryId) ||
    compareStableStrings(a.unitKey, b.unitKey)
  )
}
