import type {
  BuildListEntryId,
  CalculationContext,
  ProductionPlan,
} from '../models/publicTypes'
import { isProductionPlanCalculationCompatible } from '../models/publicTypes'
import {
  applyPlannerConflictResolutions,
  type PlannerResolvableConflict,
} from './plannerConflictDetection'
import type { PlannerConflictResolution } from './plannerTypes'

/**
 * The explicit decision set of one 「この候補を優先」 (`docs/PLANNER_SPEC.md`
 * 9.6.3): which earlier decisions of the displayed Draft are carried over, which
 * the new decision replaces or supersedes, and whether the run may start at all.
 *
 * It is the one pure authority for rules 1 - 6. The Application builds the run
 * input and the confirmation from its typed result only, and the participant
 * availability of the Production Plan screen reads the same function, so no UI
 * re-implements a rule. The applicability of each decision is the Planner's own
 * fixpoint (`applyPlannerConflictResolutions()`), so the set this function lets
 * start is the set the Planner applies.
 */

/**
 * The current preparation the decisions are judged against: the valid Entry
 * IDs and the current initial Conflicts of a fresh input (the Planner Worker's
 * interaction preparation, `docs/PLANNER_SPEC.md` 9.2.4.14). Only the `ready`
 * projection carries them.
 */
export interface PlannerConflictDecisionPreparation {
  readonly validBuildListEntryIds: readonly BuildListEntryId[]
  readonly currentConflicts: readonly PlannerResolvableConflict[]
}

/** Why an earlier decision cannot be reproduced over the current input (rule 2). */
export type PlannerConflictDecisionNotCarriedReason =
  /** Its conflict is not a current initial Conflict. */
  | 'conflict_not_current'
  /** Its Entry is not a participant of that Conflict any more. */
  | 'entry_not_participant'
  /** Its Entry is not a valid Entry of the current input. */
  | 'entry_not_valid'

/** Why an earlier decision cannot hold together with the new one (rule 4). */
export type PlannerConflictDecisionSupersededReason =
  /** The Entry it preferred is one the new decision does not select. */
  | 'selected_entry_not_preferred'
  /** It did not select the Entry the new decision prefers. */
  | 'preferred_entry_was_excluded'

export interface PlannerConflictDecisionNotCarried {
  readonly resolution: PlannerConflictResolution
  readonly reason: PlannerConflictDecisionNotCarriedReason
}

export interface PlannerConflictDecisionSuperseded {
  readonly resolution: PlannerConflictResolution
  readonly reason: PlannerConflictDecisionSupersededReason
}

/** Why the run may not start (rules 1, 5 and 6). */
export type PlannerConflictDecisionRefusal =
  /** The displayed Plan is not a draft, or its CalculationContext is not compatible. */
  | { reason: 'plan_not_editable' }
  /** The decided conflict is not a current initial Conflict (a dynamic or a stale one). */
  | { reason: 'conflict_not_current' }
  /** The preferred Entry is not a participant of that Conflict. */
  | { reason: 'entry_not_participant' }
  /** The preferred Entry is not a valid Entry of the current input. */
  | { reason: 'entry_not_valid' }
  /** An Entry is preferred by one decision and excluded by another (rule 5). */
  | { reason: 'inconsistent_decision_set'; buildListEntryId: BuildListEntryId }
  /** Two preferred Entries meet in an undecided current initial Conflict (rule 6). */
  | {
      reason: 'preferred_entries_conflict'
      conflictId: string
      buildListEntryIds: BuildListEntryId[]
    }

export type PlannerConflictDecisionSetResult =
  | {
      status: 'ready'
      /** The set the run is given as `conflictResolutions`, in conflict ID order. */
      resolutions: PlannerConflictResolution[]
      /** The earlier decisions passed on unchanged. */
      carriedOver: PlannerConflictResolution[]
      /** The earlier decisions the current input cannot reproduce. */
      notCarriedOver: PlannerConflictDecisionNotCarried[]
      /** The earlier decisions dropped because they cannot hold with the new one. */
      superseded: PlannerConflictDecisionSuperseded[]
      /** The earlier decision of the same conflict the new decision replaces, if any. */
      replaced: PlannerConflictResolution | null
      /** The Entries the passed set excludes from this run. */
      excludedBuildListEntryIds: BuildListEntryId[]
      /** Rule 7: something earlier is dropped, so the user must confirm first. */
      requiresConfirmation: boolean
    }
  | {
      status: 'refused'
      refusal: PlannerConflictDecisionRefusal
      /** What the earlier decisions would be without this decision (display only). */
      notCarriedOver: PlannerConflictDecisionNotCarried[]
    }

export interface PlannerConflictDecisionSetInput {
  /** The exact persisted Plan the user acted on. */
  readonly displayedPlan: Pick<
    ProductionPlan,
    'status' | 'calculationContext' | 'baseSnapshot' | 'conflictRepairLineage' | 'conflicts'
  >
  readonly currentCalculationContext: CalculationContext
  readonly preparation: PlannerConflictDecisionPreparation
  /**
   * The new decision (X, A), or `null` to read only what the earlier decisions
   * still mean over the current input (the screen's display and availability).
   */
  readonly decision: PlannerConflictResolution | null
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The earlier decisions: the displayed Plan's Conflicts that record a selection. */
export function plannerPersistedConflictDecisions(
  plan: Pick<ProductionPlan, 'conflicts'>,
): PlannerConflictResolution[] {
  return plan.conflicts.flatMap(({ id, selectedBuildListEntryId }) =>
    selectedBuildListEntryId === null ? [] : [{ conflictKey: id, selectedBuildListEntryId }],
  )
}

function basicRefusal(
  resolution: PlannerConflictResolution,
  conflictsById: ReadonlyMap<string, PlannerResolvableConflict>,
  validEntryIds: ReadonlySet<BuildListEntryId>,
): 'conflict_not_current' | 'entry_not_participant' | 'entry_not_valid' | null {
  const conflict = conflictsById.get(resolution.conflictKey)
  if (!conflict) return 'conflict_not_current'
  if (!conflict.buildListEntryIds.includes(resolution.selectedBuildListEntryId)) return 'entry_not_participant'
  if (!validEntryIds.has(resolution.selectedBuildListEntryId)) return 'entry_not_valid'
  return null
}

function nonSelectedParticipants(
  resolution: PlannerConflictResolution,
  conflictsById: ReadonlyMap<string, PlannerResolvableConflict>,
): BuildListEntryId[] {
  return (conflictsById.get(resolution.conflictKey)?.buildListEntryIds ?? []).filter(
    (entryId) => entryId !== resolution.selectedBuildListEntryId,
  )
}

/**
 * Builds the explicit decision set of one press (`docs/PLANNER_SPEC.md` 9.6.3).
 *
 * 1. The new decision must name a current initial Conflict, a participant and
 *    a valid Entry, of an editable displayed Plan.
 * 2. An earlier decision is carried over only when the same holds for it.
 *    Nothing is re-mapped.
 * 3. The earlier decision of the same conflict is replaced by the new one.
 * 4. An earlier decision that preferred an Entry the new decision does not
 *    select, or that did not select the Entry the new decision prefers, is
 *    superseded. Every remaining decision then applies through the Planner's
 *    own `applyPlannerConflictResolutions()`.
 * 5. No Entry may be both preferred and excluded.
 * 6. No two preferred Entries may meet in an undecided current initial Conflict.
 *
 * Calculation schema 11..18 also refused, did not carry over or superseded a
 * decision whose conflict kept an effective selected compromise checkpoint
 * (9.5.1 / 9.6.2). Issue #100 removed the selection (20.7 / 20.10): no current
 * initial Conflict carries a checkpoint participant, so a decision that passes
 * rules 1 - 4 always applies.
 */
export function derivePlannerConflictDecisionSet(
  input: PlannerConflictDecisionSetInput,
): PlannerConflictDecisionSetResult {
  const conflictsById = new Map(input.preparation.currentConflicts.map((conflict) => [conflict.id, conflict]))
  const validEntryIds = new Set(input.preparation.validBuildListEntryIds)
  const earlier = plannerPersistedConflictDecisions(input.displayedPlan)

  // Rule 2.
  const notCarriedOver: PlannerConflictDecisionNotCarried[] = []
  const basicCarried = earlier.filter((resolution) => {
    const reason = basicRefusal(resolution, conflictsById, validEntryIds)
    if (reason !== null) notCarriedOver.push({ resolution, reason })
    return reason === null
  })
  const refuse = (refusal: PlannerConflictDecisionRefusal): PlannerConflictDecisionSetResult => ({
    status: 'refused',
    refusal,
    notCarriedOver: [...notCarriedOver],
  })

  // Rule 1 (Plan and the new decision's own validity).
  if (
    input.displayedPlan.status !== 'draft' ||
    !isProductionPlanCalculationCompatible(input.displayedPlan, input.currentCalculationContext)
  ) {
    return refuse({ reason: 'plan_not_editable' })
  }
  const decision = input.decision
  if (decision !== null) {
    const reason = basicRefusal(decision, conflictsById, validEntryIds)
    if (reason !== null) return refuse({ reason })
  }

  // Rules 3 and 4 (replacement and the two supersede directions).
  const superseded: PlannerConflictDecisionSuperseded[] = []
  let replaced: PlannerConflictResolution | null = null
  const excludedByDecision = new Set(decision === null ? [] : nonSelectedParticipants(decision, conflictsById))
  const candidates = basicCarried.filter((resolution) => {
    if (decision === null) return true
    if (resolution.conflictKey === decision.conflictKey) {
      replaced = resolution
      return false
    }
    if (excludedByDecision.has(resolution.selectedBuildListEntryId)) {
      superseded.push({ resolution, reason: 'selected_entry_not_preferred' })
      return false
    }
    if (nonSelectedParticipants(resolution, conflictsById).includes(decision.selectedBuildListEntryId)) {
      superseded.push({ resolution, reason: 'preferred_entry_was_excluded' })
      return false
    }
    return true
  })

  // The Planner's own application of the set to pass. Every candidate and the
  // new decision name a distinct current Conflict and one of its participants
  // (rules 1 - 3), so each one applies.
  const passed = decision === null ? candidates : [...candidates, decision]
  const application = applyPlannerConflictResolutions(input.preparation.currentConflicts, passed)
  const carriedOver = [...candidates]
  const resolutions = (decision === null ? carriedOver : [...carriedOver, decision])
    .map((resolution) => ({ ...resolution }))
    .sort((left, right) => compareStableStrings(left.conflictKey, right.conflictKey))

  // Rule 5: one Entry preferred by one decision and excluded by another.
  const preferred = new Set(resolutions.map(({ selectedBuildListEntryId }) => selectedBuildListEntryId))
  const inconsistent = [...application.excludedBuildListEntryIds]
    .filter((entryId) => preferred.has(entryId))
    .sort(compareStableStrings)[0]
  if (inconsistent !== undefined) {
    return refuse({ reason: 'inconsistent_decision_set', buildListEntryId: inconsistent })
  }

  // Rule 6: two preferred Entries in one current initial Conflict nobody decided.
  if (decision !== null) {
    const decided = new Set(resolutions.map(({ conflictKey }) => conflictKey))
    const clash = [...input.preparation.currentConflicts]
      .sort((left, right) => compareStableStrings(left.id, right.id))
      .flatMap((conflict) => {
        if (decided.has(conflict.id)) return []
        const meeting = conflict.buildListEntryIds.filter((entryId) => preferred.has(entryId))
        return meeting.length > 1 ? [{ conflictId: conflict.id, buildListEntryIds: [...meeting].sort(compareStableStrings) }] : []
      })[0]
    if (clash !== undefined) return refuse({ reason: 'preferred_entries_conflict', ...clash })
  }

  return {
    status: 'ready',
    resolutions,
    carriedOver,
    notCarriedOver,
    superseded,
    replaced,
    excludedBuildListEntryIds: [...application.excludedBuildListEntryIds].sort(compareStableStrings),
    requiresConfirmation: notCarriedOver.length > 0 || superseded.length > 0,
  }
}

/**
 * Which decisions of a decision set exclude each Entry from the run
 * (`docs/PLANNER_SPEC.md` 9.6.2 / 9.6.3): for every decision, each participant
 * of its current initial Conflict other than the selected Entry, attributed to
 * that decision, in conflict ID order. Over the `resolutions` of a `ready`
 * result - every one of which applies - the keys are exactly its
 * `excludedBuildListEntryIds`. Read-only attribution: it decides nothing, and a
 * decision naming no current initial Conflict excludes nothing.
 */
export function plannerConflictDecisionExclusions(
  currentConflicts: readonly PlannerResolvableConflict[],
  resolutions: readonly PlannerConflictResolution[],
): Map<BuildListEntryId, PlannerConflictResolution[]> {
  const conflictsById = new Map(currentConflicts.map((conflict) => [conflict.id, conflict]))
  const exclusions = new Map<BuildListEntryId, PlannerConflictResolution[]>()
  ;[...resolutions]
    .sort((left, right) => compareStableStrings(left.conflictKey, right.conflictKey))
    .forEach((resolution) => {
      nonSelectedParticipants(resolution, conflictsById).forEach((entryId) => {
        exclusions.set(entryId, [...(exclusions.get(entryId) ?? []), { ...resolution }])
      })
    })
  return exclusions
}
