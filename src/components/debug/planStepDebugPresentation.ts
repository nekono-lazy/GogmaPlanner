import type { ExpectedPlanState, PlanStep } from '../../domain/models/publicTypes'

/**
 * Debug presentation of one persisted PlanStep (`docs/REQUIREMENTS.md` 33,
 * `docs/UI_FLOW.md` 15, `docs/DATA_MODEL.md` 11.7).
 *
 * Everything here is a pure projection of the Step as it is persisted. No
 * value is recomputed, no delta is derived from the before / after pair, no
 * Candidate or current Counter fills a missing record, and no RNG prediction
 * runs. A missing record reads 記録なし and is never shown as `0`.
 */

/** What a Debug row shows when the Step recorded no value. */
export const debugMissingValueLabel = '記録なし'

/** `0` is a recorded value; only `null` is missing. */
export function debugNumberLabel(value: number | null): string {
  return value === null ? debugMissingValueLabel : String(value)
}

export function debugTextLabel(value: string | null): string {
  return value === null || value === '' ? debugMissingValueLabel : value
}

/** One Counter stream's persisted before / after pair plus its persisted delta. */
export interface PlanStepDebugCounterRow {
  /** Internal stream name; Debug shows raw English names deliberately. */
  stream: 'Gogma Counter' | 'Skill Counter' | 'Normal Counter'
  /** The persisted `PlanStepDebugInfo` start value, or 記録なし. */
  before: string
  /** The persisted `PlanStepDebugInfo` end value, or 記録なし. */
  after: string
  /** The persisted `RngAdvance` delta, or 記録なし for a `null` Normal delta. */
  delta: string
}

export interface PlanStepDebugView {
  /** `false` means `PlanStep.debug === null`: a legacy Step or an unrecorded one. */
  hasDebugInfo: boolean
  /** `PlanStepDebugInfo.startBaseSeed`, or 記録なし. */
  startBaseSeed: string
  counters: readonly PlanStepDebugCounterRow[]
  /** `RngAdvance.affectedNormalCounterId`, or 記録なし. */
  affectedNormalCounterId: string
  /** `PlanStepDebugInfo.plannerReason` exactly as stored, or `null` with no record. */
  plannerReason: string | null
}

/**
 * The Counter before / after rows of one Step.
 *
 * The before / after values come from `PlanStep.debug` and the deltas from
 * `PlanStep.rngAdvance`: two independent persisted records, never derived from
 * each other. A Step with no `debug` record still reports its persisted
 * `rngAdvance` deltas.
 */
export function createPlanStepDebugView(step: PlanStep): PlanStepDebugView {
  const { debug, rngAdvance } = step
  return {
    hasDebugInfo: debug !== null,
    startBaseSeed: debugTextLabel(debug?.startBaseSeed ?? null),
    counters: [
      {
        stream: 'Gogma Counter',
        before: debugNumberLabel(debug?.startGogmaCounter ?? null),
        after: debugNumberLabel(debug?.endGogmaCounter ?? null),
        delta: debugNumberLabel(rngAdvance.gogmaCounterDelta),
      },
      {
        stream: 'Skill Counter',
        before: debugNumberLabel(debug?.startSkillCounter ?? null),
        after: debugNumberLabel(debug?.endSkillCounter ?? null),
        delta: debugNumberLabel(rngAdvance.skillCounterDelta),
      },
      {
        stream: 'Normal Counter',
        before: debugNumberLabel(debug?.startNormalCounter ?? null),
        after: debugNumberLabel(debug?.endNormalCounter ?? null),
        delta: debugNumberLabel(rngAdvance.normalCounterDelta),
      },
    ],
    affectedNormalCounterId: debugTextLabel(rngAdvance.affectedNormalCounterId),
    plannerReason: debug === null ? null : debug.plannerReason,
  }
}

/** One persisted `ExpectedPlanState` hash row. Never recomputed in the UI. */
export interface ExpectedPlanStateHashRow {
  label: string
  value: string
}

/**
 * The persisted hashes of one expected state.
 *
 * `targetExecutionStateHash` is optional: `undefined` means a Plan of
 * calculation schema 11 or earlier and is reported as 記録なし rather than
 * normalized to a computed value.
 */
export function expectedPlanStateHashRows(
  state: ExpectedPlanState,
): readonly ExpectedPlanStateHashRow[] {
  return [
    { label: 'rngStateHash', value: state.rngStateHash },
    { label: 'normalCountersHash', value: state.normalCountersHash },
    { label: 'ownedWeaponsHash', value: state.ownedWeaponsHash },
    {
      label: 'targetExecutionStateHash',
      value: debugTextLabel(state.targetExecutionStateHash ?? null),
    },
  ]
}
