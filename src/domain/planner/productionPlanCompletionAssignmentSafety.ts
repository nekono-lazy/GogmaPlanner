import type {
  OwnedWeaponId,
  PlanStepId,
  ProductionPlan,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'

/**
 * Why a Plan's recorded completions would break the completion assignment
 * invariant (one weapon completes at most one Target; Issue #334,
 * `docs/PLANNER_SPEC.md` 21.4.1, `docs/DATA_MODEL.md` 8.7). Typed: callers
 * name the Targets and weapons from these fields and never parse a message.
 */
export type ProductionPlanCompletionAssignmentIssue =
  /**
   * Two or more distinct Targets of the Plan complete with the same weapon, and
   * at least one of those completions is on a Step not yet confirmed. Several
   * processing Steps on one weapon never count: only `targetCompletions` do.
   */
  | {
      reason: 'duplicate_completion_weapon'
      ownedWeaponId: OwnedWeaponId
      /** Every Target the Plan completes with the weapon, in Step order. */
      targetWeaponIds: TargetWeaponId[]
      /** The Steps carrying those completions, in Step order. */
      planStepIds: PlanStepId[]
    }
  /**
   * A not-yet-confirmed completion `(targetWeaponId, ownedWeaponId)` names a
   * weapon another Target is already completed with
   * (`assignedTargetWeaponId.completedWithOwnedWeaponId === ownedWeaponId`),
   * whoever completed it.
   */
  | {
      reason: 'completion_weapon_assigned_elsewhere'
      ownedWeaponId: OwnedWeaponId
      targetWeaponId: TargetWeaponId
      assignedTargetWeaponId: TargetWeaponId
      planStepId: PlanStepId
    }
  /** The Plan's records do not state its completion assignments unambiguously; nothing is guessed. */
  | {
      reason: 'completion_assignment_unverifiable'
      planStepId: PlanStepId | null
      detail:
        | 'missing_execution_effects'
        | 'malformed_target_completion'
        | 'target_completed_more_than_once'
    }

export type ProductionPlanCompletionAssignmentIssueReason = ProductionPlanCompletionAssignmentIssue['reason']

export type ProductionPlanCompletionAssignmentSafety =
  | { safe: true }
  | { safe: false; issues: ProductionPlanCompletionAssignmentIssue[] }

interface RecordedCompletion {
  planStepId: PlanStepId
  stepIndex: number
  isCompleted: boolean
  targetWeaponId: TargetWeaponId
  ownedWeaponId: OwnedWeaponId
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Whether continuing a saved or started Plan could assign one weapon to two
 * Targets (Issue #334, `docs/PLANNER_SPEC.md` 21.4.1) - the one authority the
 * Execution runtime (Plan start, Step confirmations, the Current Position
 * Recovery), the Planner result saves, the replan Preview / adoption and every
 * read-only screen share.
 *
 * It reads only the exact persisted Plan and the current TargetWeapon
 * collection: no RNG prediction, no Planner run, no Candidate, Build List,
 * ExecutionHistory or Undo body. A completion assignment is exactly one
 * `steps[].executionEffects.targetCompletions[]` pair; `trackedOwnedWeaponId`,
 * `PlanStep.ownedWeaponId`, a registration and `targetLinks` are not, so many
 * processing Steps on one weapon are never a duplicate. A reserved ID of a
 * weapon the Plan creates counts like any other ID.
 *
 * - `duplicate_completion_weapon`: distinct Targets complete with one weapon
 *   and at least one of those completions is on an incomplete Step. When every
 *   such completion is on a confirmed Step (a history confirmed before Issue
 *   #334) no new duplicate can be written, so the Plan stays safe; an Undo that
 *   returns one of them to incomplete makes it unsafe again.
 * - `completion_weapon_assigned_elsewhere`: an incomplete Step's completion
 *   `(T, W)` while another Target `U` holds `completedWithOwnedWeaponId === W`.
 *   A `null` ("not recorded") assignment never conflicts.
 * - `completion_assignment_unverifiable`: a Step without `executionEffects`, a
 *   malformed completion, or one Target completed by two completions.
 *
 * It decides nothing else: callers apply it only after the CalculationContext
 * compatibility and the execution contract, which win first, and it never
 * writes, stales or ends a Plan.
 */
export function inspectProductionPlanCompletionAssignmentSafety(
  plan: Pick<ProductionPlan, 'steps'>,
  targetWeapons: readonly Pick<TargetWeapon, 'id' | 'lifecycleStatus' | 'completedWithOwnedWeaponId'>[],
): ProductionPlanCompletionAssignmentSafety {
  const issues: ProductionPlanCompletionAssignmentIssue[] = []
  const completions: RecordedCompletion[] = []
  const steps: readonly unknown[] = Array.isArray(plan.steps) ? plan.steps : []

  steps.forEach((value, stepIndex) => {
    const step = isRecord(value) ? value : null
    const planStepId = (step !== null && isNonEmptyString(step.id) ? step.id : null) as PlanStepId | null
    const effects = step?.executionEffects
    if (step === null || !isRecord(effects) || !Array.isArray(effects.targetCompletions)) {
      issues.push({ reason: 'completion_assignment_unverifiable', planStepId, detail: 'missing_execution_effects' })
      return
    }
    for (const completion of effects.targetCompletions as unknown[]) {
      if (
        planStepId === null ||
        !isRecord(completion) ||
        !isNonEmptyString(completion.targetWeaponId) ||
        !isNonEmptyString(completion.ownedWeaponId)
      ) {
        issues.push({ reason: 'completion_assignment_unverifiable', planStepId, detail: 'malformed_target_completion' })
        continue
      }
      completions.push({
        planStepId,
        stepIndex,
        isCompleted: step.isCompleted === true,
        targetWeaponId: completion.targetWeaponId as TargetWeaponId,
        ownedWeaponId: completion.ownedWeaponId as OwnedWeaponId,
      })
    }
  })

  // One Target completed by two completions cannot be read as one assignment.
  const byTarget = new Map<TargetWeaponId, RecordedCompletion[]>()
  completions.forEach((completion) => {
    byTarget.set(completion.targetWeaponId, [...(byTarget.get(completion.targetWeaponId) ?? []), completion])
  })
  ;[...byTarget.values()]
    .filter((list) => list.length > 1)
    .forEach((list) => {
      issues.push({ reason: 'completion_assignment_unverifiable', planStepId: list[1].planStepId, detail: 'target_completed_more_than_once' })
    })

  const byWeapon = new Map<OwnedWeaponId, RecordedCompletion[]>()
  completions.forEach((completion) => {
    byWeapon.set(completion.ownedWeaponId, [...(byWeapon.get(completion.ownedWeaponId) ?? []), completion])
  })
  ;[...byWeapon.entries()]
    .sort(([left], [right]) => compareStable(left, right))
    .forEach(([ownedWeaponId, list]) => {
      const targetWeaponIds = [...new Set(list.map(({ targetWeaponId }) => targetWeaponId))]
      if (targetWeaponIds.length < 2 || list.every(({ isCompleted }) => isCompleted)) return
      issues.push({
        reason: 'duplicate_completion_weapon',
        ownedWeaponId,
        targetWeaponIds,
        planStepIds: [...new Set(list.map(({ planStepId }) => planStepId))],
      })
    })

  // The current assignments of the completed Targets; a `null` assigns nothing.
  const assignedTargetByWeapon = new Map<OwnedWeaponId, TargetWeaponId>()
  targetWeapons.forEach((target) => {
    if (target.lifecycleStatus !== 'completed') return
    const weaponId = target.completedWithOwnedWeaponId
    if (weaponId === null || weaponId === undefined || assignedTargetByWeapon.has(weaponId)) return
    assignedTargetByWeapon.set(weaponId, target.id)
  })
  completions
    .filter(({ isCompleted }) => !isCompleted)
    .forEach((completion) => {
      const assignedTargetWeaponId = assignedTargetByWeapon.get(completion.ownedWeaponId)
      if (assignedTargetWeaponId === undefined || assignedTargetWeaponId === completion.targetWeaponId) return
      issues.push({
        reason: 'completion_weapon_assigned_elsewhere',
        ownedWeaponId: completion.ownedWeaponId,
        targetWeaponId: completion.targetWeaponId,
        assignedTargetWeaponId,
        planStepId: completion.planStepId,
      })
    })

  return issues.length === 0 ? { safe: true } : { safe: false, issues }
}
