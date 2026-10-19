import type {
  PlanStep,
  ProductionPlan,
  ProductionPlanStatus,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import {
  hasProductionPlanTargetCompletionAuthority,
  summarizeProductionPlanCompletion,
  type ProductionPlanCompletionSummary,
} from '../../domain/planner/productionPlanCompletionSummary'

/**
 * Read-only presentation helpers over an already persisted `ProductionPlan`.
 *
 * The exact persisted Plan is the only authority here (UI_FLOW 11): nothing in
 * this module reads a BuildCandidate, reconstructs a PlanStep from a Candidate
 * route, or infers a missing attribution. `progressedTargetWeaponIds ===
 * undefined` means the Plan predates the field (DATA_MODEL 12.x), so its shared
 * attribution stays unknown and is never normalized to `[targetWeaponId]`.
 */

export interface TargetRouteGroup {
  targetWeaponId: TargetWeaponId
  steps: PlanStep[]
}

export interface ProductionPlanSummary {
  planId: string
  status: ProductionPlanStatus
  createdAt: string
  totalStepCount: number
  targetWeaponCount: number
  /**
   * The distinct TargetWeapons this Plan completes, or `null` when the Plan is
   * of the legacy form without `executionEffects` and the count is unknown.
   */
  plannedCompletionTargetCount: number | null
  /**
   * The shared Domain completion summary (Issue #121, `docs/PLANNER_SPEC.md`
   * 9.6.9.1): `N`, the Targets left out by a conflict, whether the ratio can
   * be told, and whether it is provisional. `plannedCompletionTargetCount` is
   * its `N`, so the two never disagree.
   */
  completion: ProductionPlanCompletionSummary
  /**
   * The number of persisted `ProductionPlan.conflicts` records. A Conflict
   * record count - never a Target or weapon count, and never re-derived from
   * the current input or `rejectedBuildListEntries`.
   */
  conflictCount: number
  /**
   * The persisted Conflicts whose `selectedBuildListEntryId` names a selected
   * participant. Only what is stored; it says nothing about the others being
   * unresolved.
   */
  selectedConflictCount: number
  isLegacy: boolean
}

/**
 * The Plan steps in their persisted `order`, ascending.
 *
 * The Plan itself is never mutated and no UI-local ordering is invented: a
 * stable sort keeps two steps that share an `order` in their persisted
 * sequence.
 */
export function orderPlanSteps(plan: ProductionPlan): PlanStep[] {
  return [...plan.steps].sort((left, right) => left.order - right.order)
}

/**
 * Every TargetWeapon this one physical Step is attributed to.
 *
 * `progressedTargetWeaponIds` and `targetWeaponId` are separate authorities:
 * a shared Route Step belongs to each progressed Target, while a Planner-only
 * Step such as `reserve_weapon` belongs to its primary Target without
 * progressing any Route. A legacy Step keeps only its primary attribution.
 */
export function getPlanStepRelatedTargetWeaponIds(
  step: PlanStep,
): TargetWeaponId[] {
  const related: TargetWeaponId[] = []
  for (const id of step.progressedTargetWeaponIds ?? []) {
    if (!related.includes(id)) related.push(id)
  }
  if (step.targetWeaponId !== null && !related.includes(step.targetWeaponId)) {
    related.push(step.targetWeaponId)
  }
  return related
}

/**
 * A Step whose single physical execution advances more than one Target Route.
 *
 * It is shown inside each Target's route as an attribution, never as a repeated
 * physical operation, and the global timeline lists it exactly once.
 */
export function isSharedPlanStep(step: PlanStep): boolean {
  return (step.progressedTargetWeaponIds?.length ?? 0) > 1
}

/** A Plan saved before `progressedTargetWeaponIds` existed. */
export function isLegacyProductionPlan(plan: ProductionPlan): boolean {
  return plan.steps.some((step) => step.progressedTargetWeaponIds === undefined)
}

/**
 * The Target-by-Target routes, each in global `step.order`.
 *
 * Groups appear in the order their first related Step appears, so the grouping
 * is fully determined by the persisted Plan.
 */
export function groupPlanStepsByTargetWeapon(
  plan: ProductionPlan,
): TargetRouteGroup[] {
  const groups = new Map<TargetWeaponId, PlanStep[]>()
  for (const step of orderPlanSteps(plan)) {
    for (const targetWeaponId of getPlanStepRelatedTargetWeaponIds(step)) {
      const steps = groups.get(targetWeaponId)
      if (steps === undefined) groups.set(targetWeaponId, [step])
      else steps.push(step)
    }
  }
  return [...groups].map(([targetWeaponId, steps]) => ({ targetWeaponId, steps }))
}

/**
 * Whether the Plan carries the execution effects that name its Target
 * completions. A Plan with any Step lacking `executionEffects` is of the legacy
 * form, and its completions are never reconstructed from `shouldSecure`.
 */
export function hasPlanTargetCompletionAuthority(plan: ProductionPlan): boolean {
  return hasProductionPlanTargetCompletionAuthority(plan)
}

/**
 * The Plan overview counts.
 *
 * `plannedCompletionTargetCount` is the number of distinct TargetWeapon IDs in
 * `steps[].executionEffects.targetCompletions`, the only authority (UI_FLOW
 * 11.0), read from the shared Domain completion summary. A shared Step
 * completing two Targets counts two, and a Target named twice counts once.
 * Neither `expectedResult.shouldSecure`, the number of completing or reserve
 * Steps, the Target count, nor `selectedBuildListEntryIds.length` is used; a
 * legacy Plan reports `null`.
 *
 * `conflictCount` is `plan.conflicts.length` of this exact persisted Plan
 * (UI_FLOW 11.0): neither recalculated from the current input nor added to
 * the rejected Entries, and never read as a number of Targets.
 */
export function createProductionPlanSummary(
  plan: ProductionPlan,
): ProductionPlanSummary {
  const targetWeaponIds = new Set<TargetWeaponId>()
  for (const step of plan.steps) {
    for (const id of getPlanStepRelatedTargetWeaponIds(step)) {
      targetWeaponIds.add(id)
    }
  }
  const completion = summarizeProductionPlanCompletion(plan)
  return {
    planId: plan.id,
    status: plan.status,
    createdAt: plan.createdAt,
    totalStepCount: plan.steps.length,
    targetWeaponCount: targetWeaponIds.size,
    plannedCompletionTargetCount:
      completion.status === 'completion_unknown' ? null : completion.completedCount,
    completion,
    conflictCount: plan.conflicts.length,
    selectedConflictCount: plan.conflicts.filter(
      ({ selectedBuildListEntryId }) => selectedBuildListEntryId !== null,
    ).length,
    isLegacy: isLegacyProductionPlan(plan),
  }
}

export interface TargetWeaponLookup {
  byId(id: TargetWeaponId): TargetWeapon | null
}

/**
 * Resolves display names from the current persisted Targets.
 *
 * An unresolved reference returns `null` so the caller can fall back to the raw
 * ID; no generation-time Target name is stored on the Plan for this.
 */
export function createTargetWeaponLookup(
  targetWeapons: readonly TargetWeapon[],
): TargetWeaponLookup {
  const index = new Map(targetWeapons.map((target) => [target.id, target]))
  return { byId: (id) => index.get(id) ?? null }
}
