import type { TargetWeaponId } from '../../models/publicTypes'
import {
  plannerConflictResourceKey,
  type PlannerConflictContext,
  type PlannerFixedConflictConstraint,
} from './plannerConflictContext'

/**
 * The Targets a Route replacement search works on for one fixed conflict
 * choice (PLANNER_SPEC 9.2.6 / 9.2.19.3).
 *
 * A shared Planner Domain primitive since Phase 6-B2a (PLANNER_SPEC
 * 9.2.19.16): the Planner Alternative kernel reads the scenario-only works of
 * `preparePlannerConflictScenario()`. The legacy B8 constrained re-search that
 * also built them was removed in Phase 6-B2b.
 *
 * Calculation schema 11..18 also marked a work blocked by a selected compromise
 * checkpoint; Issue #100 removed the selection (`docs/PLANNER_SPEC.md` 20.7 /
 * 20.10), and an input with one fails closed before any scenario exists.
 */

/** One Target that must be re-searched because of one fixed conflict choice. */
export interface PlannerConflictWork {
  /** The `PlanConflict.id` of the original input; a diagnostic and budget key. */
  originalConflictId: string
  constraint: PlannerFixedConflictConstraint
  targetWeaponId: TargetWeaponId
  orderKey: string
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The Targets a Route replacement search may work on, one per
 * `(fixed constraint, non-fixed participant Target)` pair.
 *
 * The fixed side never yields: a participant carrying the fixed BuildListEntry
 * ID, and any participant of the fixed Target itself, is excluded. One Target
 * participating through several Route units or several Entries produces one
 * work item. The order is a stable semantic key, so the caller's array order,
 * the participant order, and Map insertion order cannot change the outcome.
 */
export function createPlannerConflictWorks(
  constraints: readonly PlannerFixedConflictConstraint[],
  conflictContexts: readonly PlannerConflictContext[],
): PlannerConflictWork[] {
  const contextById = new Map(
    conflictContexts.map((context) => [context.conflictId, context]),
  )
  const works: PlannerConflictWork[] = []
  const seen = new Set<string>()
  constraints.forEach((constraint) => {
    const context = contextById.get(constraint.originalConflictId)
    if (context === undefined) return
    context.participants.forEach((participant) => {
      if (participant.buildListEntryId === constraint.fixedBuildListEntryId) return
      if (participant.targetWeaponId === constraint.fixedTargetWeaponId) return
      const dedupeKey = `${constraint.originalConflictId}\u0000${participant.targetWeaponId}`
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      works.push({
        originalConflictId: constraint.originalConflictId,
        constraint,
        targetWeaponId: participant.targetWeaponId,
        orderKey: [
          plannerConflictResourceKey(constraint.resourceIdentity),
          constraint.fixedBuildListEntryId,
          participant.targetWeaponId,
          constraint.originalConflictId,
        ].join('\u0000'),
      })
    })
  })
  return works.sort((left, right) =>
    compareStableStrings(left.orderKey, right.orderKey),
  )
}
