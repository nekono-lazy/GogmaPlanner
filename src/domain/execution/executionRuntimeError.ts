import type { DomainValidationIssue } from '../models/validation'

/**
 * Why an Execution runtime operation refused to change anything
 * (`docs/PLANNER_SPEC.md` 16.1 / 16.2).
 *
 * Every code means nothing was written: the Plan, its current Step, and every
 * persisted entity keep their state from before the call.
 */
export type ExecutionRuntimeErrorCode =
  /** The requested ProductionPlan does not exist. */
  | 'plan_not_found'
  /** Only a draft Plan with at least one Step can start. */
  | 'plan_not_startable'
  /** Another Plan is already running (`active` or `stale`). */
  | 'running_plan_conflict'
  /** Step confirmation requires an `active` Plan. */
  | 'plan_not_active'
  /**
   * The Plan is not an executable current Execution contract Plan: it fails
   * Domain validation, predates calculation schema 12, or carries a legacy Step.
   */
  | 'plan_not_executable'
  /** The current CalculationContext is incompatible with the Plan. */
  | 'calculation_context_changed'
  /** The requested Step is not the Plan's current incomplete Step. */
  | 'step_not_current'
  /** A Plan-dependent Target definition or BuildListEntry changed. */
  | 'plan_dependency_changed'
  /** The persisted state differs from the current Step's `expectedStateBefore`. */
  | 'execution_state_mismatch'
  /** A blind production-target Normal needs the user's observed five slots. */
  | 'observation_required'
  /** The Step has no observation binding, so no observation may be supplied. */
  | 'observation_not_expected'
  /** The observed five slots fail OwnedWeapon validation. */
  | 'observation_invalid'
  /**
   * The Step has no result that can differ from a prediction: an owned Ideal
   * confirmation, or a blind observation that is `confirmed_expected`.
   */
  | 'actual_result_not_applicable'
  /** The actual result does not fit the operation or fails entity validation. */
  | 'actual_result_invalid'
  /** The actual result equals the expected result, so it is `confirmed_expected`. */
  | 'actual_result_matches_expected'
  /** The Step's recorded Counter advance or Execution effects cannot apply to the state. */
  | 'execution_effect_inconsistent'
  /** The resulting state differs from the Step's `expectedStateAfter`. */
  | 'expected_state_after_mismatch'
  /** The resulting Target preference collection is invalid. */
  | 'collection_validation_failed'
  /** A resulting entity fails Domain validation. */
  | 'entity_validation_failed'
  /**
   * The Plan has no selected compromise checkpoint the request can finish at:
   * the named BuildListEntry is not a selected Entry of the Plan, no longer
   * exists, plans another Target, selected no intermediate state, or holds its
   * checkpoint with another weapon (`docs/PLANNER_SPEC.md` 16.12).
   */
  | 'compromise_finish_not_applicable'
  /**
   * The Entry's selected compromise checkpoint is not the current state (16.12):
   * it is either not reached yet, or already left behind by a confirmed Step on
   * the same tracked weapon.
   */
  | 'compromise_checkpoint_not_current'
  /** The ExecutionHistory to undo does not exist or belongs to another Plan. */
  | 'undo_history_not_found'
  /** The ExecutionHistory to undo is not the Plan's latest ExecutionHistory. */
  | 'undo_history_not_latest'
  /**
   * The Plan's status, or the terminal transition the ExecutionHistory did not
   * cause, or a legacy action does not allow Undo (`docs/PLANNER_SPEC.md` 16.16).
   */
  | 'undo_not_allowed'
  /** The ExecutionHistory or its ExecutionUndoSnapshot cannot restore the Step exactly. */
  | 'undo_snapshot_invalid'
  /** The state restored from the snapshot fails entity, collection or reference validation. */
  | 'undo_result_invalid'
  /** A game save point is recorded only for an active Plan (`docs/PLANNER_SPEC.md` 16.9). */
  | 'save_point_record_not_allowed'
  /** A game save point is restored only for an active or stale Plan (16.9). */
  | 'save_point_restore_not_allowed'
  /** The Plan has no game save point to restore. */
  | 'save_point_not_found'
  /** The Plan's game save point is not the one the user saw (it was recorded again). */
  | 'save_point_changed'
  /**
   * The game save point cannot be restored exactly: it fails Domain validation,
   * its ExecutionHistory boundary is missing or foreign, its snapshot Plan is not
   * active, or it does not cover its execution scope.
   */
  | 'save_point_snapshot_invalid'
  /**
   * An entity the Plan needs no longer exists: a snapshot OwnedWeapon, a selected
   * BuildListEntry or a Plan-dependent Target. It is never revived.
   */
  | 'save_point_required_entity_missing'
  /** The state restored from the save point fails entity, collection or reference validation. */
  | 'save_point_restore_invalid'
  /**
   * Only an `active` or `stale` Plan can be abandoned by the user
   * (`docs/PLANNER_SPEC.md` 16.2): a draft has not started, and a completed or
   * abandoned Plan has already ended.
   */
  | 'plan_abandon_not_allowed'
  /**
   * The Plan's status, current Step or `updatedAt` is no longer what the user
   * saw when confirming the abandonment, so a state the user never saw is not
   * abandoned.
   */
  | 'plan_abandon_state_changed'
  /**
   * The Plan ran past its game save point, so the user must choose between
   * keeping the current state and returning to the save point (16.10).
   */
  | 'save_point_choice_required'
  /**
   * A save point decision was given although the Plan did not run past a game
   * save point, so no choice was offered and none is applied (16.10).
   */
  | 'save_point_choice_not_required'
  /**
   * Only an `active` or `stale` Plan can be replanned from the current state
   * (`docs/PLANNER_SPEC.md` 16.8): a draft has not started, and a completed or
   * abandoned Plan has already ended.
   */
  | 'replan_preview_not_allowed'
  /**
   * The state the replan Preview was calculated from no longer holds: the
   * running Plan's status or current Step, the RNG / Normal Counter / OwnedWeapon
   * state, a Target or BuildListEntry the new Plan depends on, a generated
   * Entry, or the CalculationContext changed (16.8). Nothing was written; a new
   * Preview from the current state is the recovery.
   */
  | 'replan_state_changed'
  /**
   * The replan Preview's Planner result cannot become the running Plan: it has
   * no Plan, a truncated search, a non-draft or Domain-invalid Plan or Entry,
   * or broken BuildListEntry references (16.8, PLANNER_SPEC 9.2.15).
   */
  | 'replan_result_invalid'
  /** The Preview's new ProductionPlan ID is already persisted, or equals the running Plan's. */
  | 'replan_plan_id_collision'
  /**
   * More than one ProductionPlan is `active` or `stale`. The one-running-Plan
   * invariant (16.2) is broken, and no Plan is picked by guessing.
   */
  | 'running_plan_invariant_violated'
  /**
   * The change would break the `active` Plan (`docs/PLANNER_SPEC.md` 16.6) and
   * no approval was given. Nothing was saved and the Plan is unchanged; the
   * error carries the inspection the warning is built from.
   */
  | 'plan_breaking_change_approval_required'
  /**
   * The Plan the approval names is no longer the `active` Plan with the status,
   * current Step and `updatedAt` the user saw, so a Plan the user never saw is
   * not abandoned.
   */
  | 'plan_breaking_change_state_changed'
  /**
   * An approval was given although the change no longer breaks an `active`
   * Plan; nothing is abandoned on a stale approval.
   */
  | 'plan_breaking_change_approval_not_required'
  /**
   * Current Position Recovery (`docs/PLANNER_SPEC.md` 16.15) does not apply:
   * the Plan is not `stale` with `execution_operation_uncertain` alone, its
   * latest ExecutionHistory is not the `operation_uncertain` record of its
   * current Step, or the current Step has no comparable same-operation window.
   */
  | 'operation_count_recovery_not_applicable'
  /**
   * The `operation_uncertain` record, the current Step or the recovered
   * position the user saw is no longer what the persisted state derives.
   */
  | 'operation_count_recovery_changed'
  /** An observation does not fit the window's result contract. */
  | 'operation_count_recovery_observation_invalid'
  /**
   * The observations do not match exactly one position of the Recovery Window,
   * so no position is guessed.
   */
  | 'operation_count_recovery_not_unique'

export class ExecutionRuntimeError extends Error {
  readonly code: ExecutionRuntimeErrorCode
  readonly validationIssues: readonly DomainValidationIssue[]

  constructor(
    code: ExecutionRuntimeErrorCode,
    message: string,
    validationIssues: readonly DomainValidationIssue[] = [],
  ) {
    super(message)
    this.name = 'ExecutionRuntimeError'
    this.code = code
    this.validationIssues = validationIssues
  }
}

export function executionFailure(
  code: ExecutionRuntimeErrorCode,
  message: string,
  validationIssues: readonly DomainValidationIssue[] = [],
): never {
  throw new ExecutionRuntimeError(code, message, validationIssues)
}
