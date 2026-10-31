import type {
  CalculationContext,
  ProductionPlan,
  TargetWeapon,
} from '../models/publicTypes'
import {
  isExecutionContractProductionPlan,
  isProductionPlanCalculationCompatible,
} from '../models/publicTypes'
import {
  inspectProductionPlanCompletionAssignmentSafety,
  type ProductionPlanCompletionAssignmentIssue,
} from '../planner/productionPlanCompletionAssignmentSafety'

/**
 * Whether a saved or started Plan can be continued, as every read-only screen
 * shows it (`docs/UI_FLOW.md` 12.11, `docs/PLANNER_SPEC.md` 21.4.1): the
 * Execution Navigator, the Production Plan page (start / resume), the
 * Production Plan list, the Build List's running Plan guidance and the
 * Dashboard's next action.
 *
 * - `calculation_incompatible`: the CalculationContext compatibility
 *   (`isProductionPlanCalculationCompatible()`) refuses the Plan. It wins first,
 *   so such a Plan never shows a completion assignment reason.
 * - `completion_assignment_conflict`: continuing could make one weapon the
 *   completion of two Targets (`inspectProductionPlanCompletionAssignmentSafety()`
 *   over the Plan and the current Targets) - the very judgement the Plan start,
 *   the Step confirmations and the Current Position Recovery refuse with
 *   `completion_assignment_conflict`.
 * - `continuable`: neither applies. Every other runtime premise (the current
 *   Step, the expected state) is still checked by the runtime itself.
 *
 * A Plan of an earlier calculation schema that has no Execution contract never
 * runs at all, so its completions are not judged. Derived only: nothing is
 * persisted, no status or recalculation reason changes.
 */
export type ProductionPlanContinuation =
  | { kind: 'continuable' }
  | { kind: 'calculation_incompatible' }
  | { kind: 'completion_assignment_conflict'; issues: ProductionPlanCompletionAssignmentIssue[] }

export function evaluateProductionPlanContinuation(
  plan: ProductionPlan,
  targetWeapons: readonly TargetWeapon[],
  currentCalculationContext: CalculationContext,
): ProductionPlanContinuation {
  if (!isProductionPlanCalculationCompatible(plan, currentCalculationContext)) {
    return { kind: 'calculation_incompatible' }
  }
  if (!isExecutionContractProductionPlan(plan)) return { kind: 'continuable' }
  const safety = inspectProductionPlanCompletionAssignmentSafety(plan, targetWeapons)
  return safety.safe ? { kind: 'continuable' } : { kind: 'completion_assignment_conflict', issues: safety.issues }
}
