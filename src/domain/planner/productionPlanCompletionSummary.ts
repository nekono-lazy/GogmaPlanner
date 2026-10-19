import {
  rejectedBuildListEntryResourceConflictCauses,
  type ProductionPlan,
  type RejectedBuildListEntry,
  type TargetWeaponId,
} from '../models/publicTypes'

/**
 * The planned completion count and the Targets this Plan leaves out because of
 * a conflict with another Target (Issue #121, `docs/PLANNER_SPEC.md` 9.6.9.1).
 *
 * A read-only projection of the exact persisted ProductionPlan: it reads
 * nothing else - no current Build List Entry, TargetWeapon, name or Master -
 * so the counts never move because the Build List or a Target changed after
 * the Plan was made, or because the current data could not be read. The
 * overview ratio (`docs/UI_FLOW.md` 11.0) and the Conflict section's cause
 * groups (11.6.5) both read this one function and never count again.
 *
 * Only typed records decide anything: `steps[].executionEffects.targetCompletions`,
 * `rejectedBuildListEntries[].reason` / `targetWeaponId` /
 * `resourceConflictCause`, `conflicts[].selectedBuildListEntryId` and
 * `calculationContext.appSchemaVersion`. No `detail`, `PlanConflict.reason`,
 * warning message or label is parsed, and nothing missing is inferred: a
 * ratio that cannot be told from the records is reported as undeterminable
 * with its typed reason, never guessed (an unknown cause must not shrink the
 * denominator).
 */

/**
 * The calculation schemas whose rejection records follow the deterministic
 * scheduler mapping the ratio is defined over (`docs/PLANNER_SPEC.md` 9.6.9.1
 * condition 2). An explicit set, never a range: version 13 and earlier (the
 * Beam Search Production Planner) had no provisional outcome and recorded
 * `resource_conflict` for explicit decisions only. A future version joins only
 * when it keeps the meaning of the rejection records, by adding it here.
 */
export const PLAN_COMPLETION_RATIO_CALCULATION_APP_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18,
])

/** Why the ratio cannot be told from the records (`docs/PLANNER_SPEC.md` 9.6.9.1 conditions 2 - 5). */
export type ProductionPlanCompletionRatioUndeterminableReason =
  /** Condition 2: the Plan was calculated before the deterministic scheduler mapping. */
  | 'calculation_version_unsupported'
  /** Condition 3: a rejection reason or cause is not a known literal (an old or broken record). */
  | 'unknown_rejection_reason'
  /** Condition 4: a `resource_conflict` record lacks its Target or its cause (saved before they were recorded). */
  | 'rejection_details_not_recorded'
  /** Condition 5: a stuck drop happened while other Routes were pending; whether it was a conflict cannot be told. */
  | 'conflict_cause_not_established'

/**
 * The Targets the rejection records classify, readable only when every
 * rejection is recorded with its cause (conditions 1 - 4 hold).
 */
export interface ProductionPlanRejectionCauseBreakdown {
  /**
   * `R \ C`: the Targets of the `resource_conflict` records whose cause is an
   * explicit decision or a provisional outcome - a competition with another
   * Target is established - minus the planned completions. Record order, no
   * duplicates.
   */
  conflictNotCreatedTargetWeaponIds: readonly TargetWeaponId[]
  /**
   * The Targets of the `stuck_drop_with_other_routes` records that are neither
   * planned completions nor in `R`: whether a conflict left them out cannot be
   * told. Record order, no duplicates.
   */
  unestablishedNotCreatedTargetWeaponIds: readonly TargetWeaponId[]
}

interface ProductionPlanCompletionSummaryBase {
  /**
   * Some persisted Conflict has no explicit decision (`selectedBuildListEntryId
   * === null`): the result includes the Planner's provisional outcome, which is
   * never a choice the user made.
   */
  isProvisional: boolean
}

/** Condition 1 fails: some Step has no `executionEffects`, so even the completions are unknown (a legacy Plan). */
export interface ProductionPlanCompletionUnknown extends ProductionPlanCompletionSummaryBase {
  status: 'completion_unknown'
}

interface ProductionPlanCompletionKnown extends ProductionPlanCompletionSummaryBase {
  /** `C`: the distinct Targets of `steps[].executionEffects.targetCompletions`, in Step order. */
  completedTargetWeaponIds: readonly TargetWeaponId[]
  /** `N = |C|`. */
  completedCount: number
}

/** Every condition holds: the overview shows `N / (N + M)`. */
export interface ProductionPlanCompletionRatioDetermined extends ProductionPlanCompletionKnown {
  status: 'ratio_determined'
  /** `unestablishedNotCreatedTargetWeaponIds` is always empty here (condition 5 holds). */
  causeBreakdown: ProductionPlanRejectionCauseBreakdown
  /** `M = |R \ C|`. */
  conflictNotCreatedCount: number
}

/** Condition 1 holds and one of conditions 2 - 5 fails: only `N` is shown. */
export interface ProductionPlanCompletionRatioUndeterminable extends ProductionPlanCompletionKnown {
  status: 'ratio_undeterminable'
  /** The first failing condition, in the order 2, 3, 4, 5. */
  reason: ProductionPlanCompletionRatioUndeterminableReason
  /**
   * The cause classification when only condition 5 fails
   * (`conflict_cause_not_established`): the records are complete, so the
   * established and the undetermined Targets are still known. `null` for the
   * other reasons - then no rejection is classified at all.
   */
  causeBreakdown: ProductionPlanRejectionCauseBreakdown | null
}

export type ProductionPlanCompletionSummary =
  | ProductionPlanCompletionUnknown
  | ProductionPlanCompletionRatioDetermined
  | ProductionPlanCompletionRatioUndeterminable

/** Every `RejectedBuildListEntry.reason` literal, completeness checked by the Record type. */
const knownRejectionReasons: Record<RejectedBuildListEntry['reason'], true> = {
  lower_priority: true,
  resource_conflict: true,
  longer_route: true,
  already_satisfied: true,
  requires_protected_weapon: true,
  dominated_by_better_candidate: true,
}

const ESTABLISHED_CONFLICT_CAUSES: ReadonlySet<string> = new Set([
  'explicit_resolution_not_selected',
  'provisional_outcome_not_committed',
])

/**
 * Whether the Plan carries the execution effects that name its Target
 * completions (`docs/PLANNER_SPEC.md` 9.6.9.1 condition 1). A Plan with any
 * Step lacking `executionEffects` is of the legacy form, and its completions
 * are never reconstructed from `shouldSecure` or the Step kinds.
 */
export function hasProductionPlanTargetCompletionAuthority(plan: ProductionPlan): boolean {
  return plan.steps.every((step) => step.executionEffects !== undefined)
}

function hasKnownLiterals(record: RejectedBuildListEntry): boolean {
  const reason: unknown = record.reason
  if (typeof reason !== 'string' || !Object.hasOwn(knownRejectionReasons, reason)) return false
  const cause: unknown = record.resourceConflictCause
  if (cause === undefined) return true
  // A cause on another reason is a broken record (validation refuses it): it
  // is not read as a known one.
  return (
    record.reason === 'resource_conflict' &&
    (rejectedBuildListEntryResourceConflictCauses as readonly unknown[]).includes(cause)
  )
}

function hasRecordedCause(record: RejectedBuildListEntry): boolean {
  return (
    record.reason !== 'resource_conflict' ||
    (typeof record.targetWeaponId === 'string' && record.resourceConflictCause !== undefined)
  )
}

function firstFailingCondition(plan: ProductionPlan): ProductionPlanCompletionRatioUndeterminableReason | null {
  if (!PLAN_COMPLETION_RATIO_CALCULATION_APP_SCHEMA_VERSIONS.has(plan.calculationContext.appSchemaVersion)) {
    return 'calculation_version_unsupported'
  }
  const records = plan.rejectedBuildListEntries
  if (!records.every(hasKnownLiterals)) return 'unknown_rejection_reason'
  // With no `resource_conflict` record, `R` is empty whether or not the fields
  // exist, so a Plan saved before they did is still determinable.
  if (!records.every(hasRecordedCause)) return 'rejection_details_not_recorded'
  if (records.some(({ resourceConflictCause }) => resourceConflictCause === 'stuck_drop_with_other_routes')) {
    return 'conflict_cause_not_established'
  }
  return null
}

function completedTargetWeaponIdsOf(plan: ProductionPlan): TargetWeaponId[] {
  const completed = new Set<TargetWeaponId>()
  for (const step of plan.steps) {
    for (const { targetWeaponId } of step.executionEffects?.targetCompletions ?? []) {
      completed.add(targetWeaponId)
    }
  }
  return [...completed]
}

/** Read only when conditions 1 - 4 hold: every `resource_conflict` record names its Target and cause. */
function causeBreakdownOf(
  plan: ProductionPlan,
  completed: ReadonlySet<TargetWeaponId>,
): ProductionPlanRejectionCauseBreakdown {
  const established = new Set<TargetWeaponId>()
  const unestablished = new Set<TargetWeaponId>()
  for (const record of plan.rejectedBuildListEntries) {
    if (record.reason !== 'resource_conflict' || record.targetWeaponId === undefined) continue
    if (record.resourceConflictCause !== undefined && ESTABLISHED_CONFLICT_CAUSES.has(record.resourceConflictCause)) {
      established.add(record.targetWeaponId)
    } else if (record.resourceConflictCause === 'stuck_drop_with_other_routes') {
      unestablished.add(record.targetWeaponId)
    }
  }
  const conflictNotCreated = [...established].filter((id) => !completed.has(id))
  return {
    conflictNotCreatedTargetWeaponIds: conflictNotCreated,
    unestablishedNotCreatedTargetWeaponIds: [...unestablished].filter(
      (id) => !completed.has(id) && !established.has(id),
    ),
  }
}

/**
 * The completion summary of one exact persisted ProductionPlan
 * (`docs/PLANNER_SPEC.md` 9.6.9.1). It takes the Plan alone - never the
 * current Build List or Targets - and is deterministic: the same Plan always
 * gives the same summary.
 *
 * - `C` = the distinct Targets of `executionEffects.targetCompletions`; a
 *   shared Step completing two Targets counts both, a Target named twice once
 * - `R` = the Targets of the `resource_conflict` records caused by an explicit
 *   decision or a provisional outcome; `M = |R \ C|`. Other reasons and a stuck
 *   drop without other pending Routes are no conflict and never counted
 * - `isProvisional` = some persisted Conflict has no explicit decision
 */
export function summarizeProductionPlanCompletion(plan: ProductionPlan): ProductionPlanCompletionSummary {
  const isProvisional = plan.conflicts.some(({ selectedBuildListEntryId }) => selectedBuildListEntryId === null)
  if (!hasProductionPlanTargetCompletionAuthority(plan)) {
    return { status: 'completion_unknown', isProvisional }
  }
  const completedTargetWeaponIds = completedTargetWeaponIdsOf(plan)
  const completedCount = completedTargetWeaponIds.length
  const failing = firstFailingCondition(plan)
  if (failing === null) {
    const causeBreakdown = causeBreakdownOf(plan, new Set(completedTargetWeaponIds))
    return {
      status: 'ratio_determined',
      completedTargetWeaponIds,
      completedCount,
      causeBreakdown,
      conflictNotCreatedCount: causeBreakdown.conflictNotCreatedTargetWeaponIds.length,
      isProvisional,
    }
  }
  return {
    status: 'ratio_undeterminable',
    reason: failing,
    completedTargetWeaponIds,
    completedCount,
    causeBreakdown:
      failing === 'conflict_cause_not_established'
        ? causeBreakdownOf(plan, new Set(completedTargetWeaponIds))
        : null,
    isProvisional,
  }
}

/** The cause classification when the records allow one (conditions 1 - 4), `null` otherwise. */
export function productionPlanRejectionCauseBreakdownOf(
  summary: ProductionPlanCompletionSummary,
): ProductionPlanRejectionCauseBreakdown | null {
  return summary.status === 'completion_unknown' ? null : summary.causeBreakdown
}
