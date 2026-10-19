import type { TargetWeaponId } from '../../models/publicTypes'
import type { PlannerCheckpointRequirements } from '../plannerCheckpoints'
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
 */

/** One Target that must be re-searched because of one fixed conflict choice. */
export interface PlannerConflictWork {
  /** The `PlanConflict.id` of the original input; a diagnostic and budget key. */
  originalConflictId: string
  constraint: PlannerFixedConflictConstraint
  targetWeaponId: TargetWeaponId
  /**
   * This Target has a required checkpoint Entry somewhere in the current
   * Planner input - not necessarily among this conflict's participants. No
   * Route replacement is attempted for the Target: an alternate Route would
   * bypass that checkpoint, and the Planner never drops, moves, or empties a
   * selection (`docs/PLANNER_SPEC.md` 9.5.2). The conflict stays a conflict
   * until the Build List selection changes.
   */
  blockedBySelectedCheckpoint: boolean
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
  checkpointRequirements: PlannerCheckpointRequirements,
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
        // Target-wide, from the whole valid Entry set of the run: a required
        // checkpoint Entry of this Target blocks its re-search even when the
        // participant here is another, selection-free Entry. The participant
        // flag is kept as a second, narrower witness of the same fact.
        blockedBySelectedCheckpoint:
          checkpointRequirements.requiredEntryIdByTargetId.has(
            participant.targetWeaponId,
          ) ||
          context.participants.some(
            (other) =>
              other.targetWeaponId === participant.targetWeaponId &&
              other.hasSelectedCheckpoints,
          ),
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
