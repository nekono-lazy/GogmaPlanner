import type { ProductionPlan, ProductionPlanUndoState } from '../models/publicTypes'
import {
  ProductionPlanUndoStateError,
  reconstructProductionPlanFromUndoState,
} from '../models/publicTypes'
import { executionFailure } from './executionRuntimeError'

/**
 * The Plan just before the record an Undo removes, rebuilt from the current
 * Plan and the record's Plan undo state (`docs/PLANNER_SPEC.md` 19.5): the
 * undo state is validated, the current Plan's content hash and the rebuilt
 * Plan's execution state hash are verified, and every changed Step must be
 * exactly one Step of the Plan in Plan order. Any mismatch refuses with
 * `undo_snapshot_invalid` before anything is written; no value is filled in
 * from an RNG prediction, a Counter or a Plan transition. `prepareExecutionUndo()`
 * takes the result as the Plan before the record.
 */
export function reconstructExecutionUndoPlan(
  currentPlan: ProductionPlan,
  undoState: ProductionPlanUndoState,
): ProductionPlan {
  try {
    return reconstructProductionPlanFromUndoState(currentPlan, undoState)
  } catch (error) {
    if (error instanceof ProductionPlanUndoStateError) {
      executionFailure('undo_snapshot_invalid', error.message, error.issues)
    }
    throw error
  }
}
