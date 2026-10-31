import { currentExecutionActions } from './common'
import type { ExecutionHistory, PlanStep, ProductionPlan } from './planning'

/** The fields of one ExecutionHistory record the Undo eligibility reads. */
export type ExecutionUndoEligibilityRecord = Pick<ExecutionHistory, 'id' | 'action' | 'planStepId' | 'createdAt'>

/** The Plan just before the record, as far as the Undo eligibility reads it. */
export interface ExecutionUndoEligibilityPlanBefore {
  steps: readonly Pick<PlanStep, 'id' | 'isCompleted'>[]
}

/**
 * Undo eligibility (`docs/PLANNER_SPEC.md` 16.16): an `active` or `stale` Plan,
 * or a `completed` / `abandoned` Plan whose terminal transition this very
 * ExecutionHistory caused. `terminal` tells whether the Undo reverses a
 * terminal transition.
 */
export type ExecutionUndoEligibility =
  | { allowed: true; terminal: boolean }
  | { allowed: false; message: string }

/**
 * Whether the latest ExecutionHistory itself moved the Plan from `active` to
 * `completed`: the last incomplete Step of the Plan before it was confirmed as
 * expected, at the moment the Plan and that Step record as their completion.
 */
function causedCompletion(
  plan: ProductionPlan,
  record: ExecutionUndoEligibilityRecord,
  before: ExecutionUndoEligibilityPlanBefore,
): boolean {
  const step = plan.steps.find(({ id }) => id === record.planStepId)
  return (
    record.action === 'confirmed_expected' &&
    plan.status === 'completed' &&
    plan.currentStepId === null &&
    plan.completedAt === record.createdAt &&
    step !== undefined &&
    step.isCompleted &&
    step.completedAt === record.createdAt &&
    before.steps.filter(({ isCompleted }) => !isCompleted).map(({ id }) => id).join('\n') === record.planStepId
  )
}

/**
 * Whether the latest `operation_count_recovered` itself completed the Plan
 * (16.15): every Step incomplete in the Plan before it was completed by it.
 */
function causedRecoveryCompletion(
  plan: ProductionPlan,
  record: ExecutionUndoEligibilityRecord,
  before: ExecutionUndoEligibilityPlanBefore,
): boolean {
  const replayed = before.steps.filter(({ isCompleted }) => !isCompleted).map(({ id }) => id)
  return (
    record.action === 'operation_count_recovered' &&
    plan.status === 'completed' &&
    plan.currentStepId === null &&
    plan.completedAt === record.createdAt &&
    replayed.length > 0 &&
    replayed.at(-1) === record.planStepId &&
    replayed.every((id) => {
      const step = plan.steps.find((candidate) => candidate.id === id)
      return step !== undefined && step.isCompleted && step.completedAt === record.createdAt
    })
  )
}

/** Whether the latest ExecutionHistory itself finished the Plan as a compromise (16.12). */
function causedCompromiseFinish(plan: ProductionPlan, record: ExecutionUndoEligibilityRecord): boolean {
  return (
    record.action === 'finished_as_compromise' &&
    plan.status === 'abandoned' &&
    plan.abandonmentReason === 'finished_as_compromise' &&
    plan.abandonedAt === record.createdAt
  )
}

/**
 * The one Undo eligibility authority (`docs/PLANNER_SPEC.md` 16.16) of the
 * Undo runtime, the Navigator's display (`inspectExecutionUndo()`) and the
 * conversion of an existing record (`docs/DATA_MODEL.md` 14.2), which keeps the
 * deleted game save point only of a record this judges terminal.
 *
 * `plan` is the current Plan and `before` the Plan just before the record. A
 * Plan status outside the known literals is never eligible.
 */
export function deriveExecutionUndoEligibility(
  plan: ProductionPlan,
  record: ExecutionUndoEligibilityRecord,
  before: ExecutionUndoEligibilityPlanBefore,
): ExecutionUndoEligibility {
  const action: string = record.action
  if (!(currentExecutionActions as readonly string[]).includes(action)) {
    return { allowed: false, message: `ExecutionHistory '${record.id}' is a legacy '${action}' record and is never undone as a current Execution.` }
  }
  switch (plan.status) {
    case 'active':
    case 'stale':
      if (record.action === 'finished_as_compromise') {
        return { allowed: false, message: `ExecutionHistory '${record.id}' finished a Plan that is now '${plan.status}'.` }
      }
      return { allowed: true, terminal: false }
    case 'completed':
      if (!causedCompletion(plan, record, before) && !causedRecoveryCompletion(plan, record, before)) {
        return { allowed: false, message: `ExecutionHistory '${record.id}' did not complete ProductionPlan '${plan.id}'.` }
      }
      return { allowed: true, terminal: true }
    case 'abandoned':
      if (!causedCompromiseFinish(plan, record)) {
        return {
          allowed: false,
          message: `ProductionPlan '${plan.id}' was abandoned by '${plan.abandonmentReason}', not by ExecutionHistory '${record.id}'.`,
        }
      }
      return { allowed: true, terminal: true }
    case 'draft':
      return { allowed: false, message: `ProductionPlan '${plan.id}' has not started.` }
    default:
      return { allowed: false, message: `ProductionPlan '${plan.id}' has an unknown status.` }
  }
}
