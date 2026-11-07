import type {
  ActualResult,
  CalculationContext,
  ExecutionHistoryId,
  ISODateTimeString,
  OwnedWeaponId,
  PlanStep,
  PlanStepId,
  ProductionPlan,
} from '../models/publicTypes'
import { executionFailure } from './executionRuntimeError'
import { nextPlanAfterStep } from './expectedStepConfirmation'
import {
  collectPlanSkillRetentionBindings,
  createActualExecutionState,
  executionStateMatches,
  type ExecutionPersistedState,
} from './planExecutionState'
import {
  applyRngAdvance,
  assertStepResultValid,
  changedEntity,
  changedNormalCounters,
  collectEntityChanges,
  createExecutionRecord,
  createMutableExecutionState,
  inconsistent,
  requireExecutableCurrentStep,
  type ExecutionCounterAuthority,
  type ExecutionRecordMetadata,
  type ExecutionStepWrite,
} from './stepExecution'

/**
 * Why a Step cannot be performed on an alternate weapon (Issue #379,
 * `docs/PLANNER_SPEC.md` 16.20). Every reason is fail closed: a Step whose
 * role cannot be read from the Plan is never offered.
 */
export type AlternateWeaponExecutionUnavailableReason =
  /** The Plan has no such Step. */
  | 'step_not_found'
  /** A legacy Step without an execution projection. */
  | 'no_execution_projection'
  /** Only a Reset Skills can advance the Skill Counter without a needed result. */
  | 'not_reset_skills'
  /** The projection names no existing tracked weapon, or registers, binds or links one. */
  | 'projection_inconsistent'
  /** The Step predicts no Skills, so the Skills the Plan expects after it are unknown. */
  | 'no_expected_result'
  /** The Step itself completes a Target (or carries a legacy compromise label). */
  | 'completes_target'
  /** A later Step uses the weapon's Skills before another Reset Skills overwrites them. */
  | 'result_used_before_overwrite'
  /** No later Reset Skills on the weapon overwrites this result. */
  | 'no_later_reset_skills'
  /** A later Step of the Plan cannot be read, so the result may be needed. */
  | 'unknown_later_step'

export type AlternateWeaponExecutionAvailability =
  | {
      kind: 'available'
      /** The weapon the Plan guides the user to, whose Skills stay as they are. */
      trackedOwnedWeaponId: OwnedWeaponId
      /** The later Reset Skills on that weapon that overwrites this Step's result. */
      overwritingStepId: PlanStepId
    }
  | { kind: 'unavailable'; reason: AlternateWeaponExecutionUnavailableReason }

function unavailable(reason: AlternateWeaponExecutionUnavailableReason): AlternateWeaponExecutionAvailability {
  return { kind: 'unavailable', reason }
}

/**
 * Whether a Step of the Plan only advances the Skill Counter, so the user may
 * perform it on an unneeded Gogma weapon instead of the tracked weapon
 * (`docs/PLANNER_SPEC.md` 16.20). Pure and display-safe: the runtime judges
 * the same function again inside its transaction.
 *
 * The judgement is made on the persisted Plan's own Steps, never on the
 * Planner's Route unit `canSkipWhenCounterPassed`, because a Plan Step is the
 * physical operation after sharing and fast-forward: the Step must be a
 * `reset_skills` whose projection tracks an existing Gogma weapon and predicts
 * its Skills, must complete no Target itself, and - walking the later Steps in
 * Plan order - must be followed by a `reset_skills` on the same weapon before
 * any Step completes a Target with that weapon or otherwise processes it apart
 * from Reset / Keep Bonuses, which read no Skill. A shared Step is judged the
 * same way: every Entry it progresses operates on the one tracked weapon, and
 * any Entry whose Route ends on this result completes its Target on this Step
 * or on a later Step of that weapon before the overwriting Reset Skills, so it
 * makes the Step unavailable. A later Step without a projection fails closed.
 */
export function inspectAlternateWeaponExecution(
  plan: Pick<ProductionPlan, 'steps'>,
  planStepId: PlanStepId,
): AlternateWeaponExecutionAvailability {
  const index = plan.steps.findIndex(({ id }) => id === planStepId)
  if (index < 0) return unavailable('step_not_found')
  const step: PlanStep = plan.steps[index]
  const effects = step.executionEffects
  if (effects === undefined) return unavailable('no_execution_projection')
  if (step.operationType !== 'reset_skills') return unavailable('not_reset_skills')
  const weaponId = effects.trackedOwnedWeaponId
  if (
    weaponId === null ||
    effects.registersTrackedWeapon ||
    effects.observationBinding !== null ||
    effects.normalCreationRole !== null ||
    effects.targetLinks.length > 0
  ) {
    return unavailable('projection_inconsistent')
  }
  if (step.expectedResult === null) return unavailable('no_expected_result')
  if (effects.targetCompletions.length > 0 || effects.compromiseLabels.length > 0) {
    return unavailable('completes_target')
  }
  for (const later of plan.steps.slice(index + 1)) {
    const laterEffects = later.executionEffects
    if (laterEffects === undefined) return unavailable('unknown_later_step')
    const completesWeapon =
      laterEffects.targetCompletions.some((completion) => completion.ownedWeaponId === weaponId) ||
      laterEffects.compromiseLabels.some((label) => label.ownedWeaponId === weaponId)
    if (laterEffects.trackedOwnedWeaponId === weaponId && later.operationType === 'reset_skills') {
      // The next Reset Skills on the weapon redraws the pair positionally
      // before anything - its own Target completion included - reads it.
      return { kind: 'available', trackedOwnedWeaponId: weaponId, overwritingStepId: later.id }
    }
    if (completesWeapon) return unavailable('result_used_before_overwrite')
    if (laterEffects.trackedOwnedWeaponId !== weaponId) continue
    switch (later.operationType) {
      case 'reset_bonuses':
      case 'keep_bonuses':
        // Reset / Keep Bonuses read no Skill and write none.
        continue
      case 'reset_skills':
      case 'create_normal_artian':
      case 'convert_normal_to_gogma':
      case 'confirm_owned_ideal':
      case 'reserve_weapon':
      case 'confirm_result':
        return unavailable('result_used_before_overwrite')
    }
  }
  return unavailable('no_later_reset_skills')
}

export interface AlternateWeaponStepExecutionInput {
  plan: ProductionPlan
  planStepId: PlanStepId
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  counterAuthority: ExecutionCounterAuthority
  executionHistoryId: ExecutionHistoryId
  now: ISODateTimeString
}

/**
 * Decides one 「他武器で実行」 of the current Step (`docs/PLANNER_SPEC.md`
 * 16.20) purely from the persisted state: the same premises as
 * `confirmed_expected` (an active executable Plan, its current Step, unchanged
 * dependencies, the `expectedStateBefore`), then the Step must be a Skill
 * Counter-advance-only Reset Skills (`inspectAlternateWeaponExecution()`).
 *
 * The Skill Counter advances through the Counter authority exactly as the
 * ordinary confirmation does. Nothing else changes: the tracked weapon keeps
 * its Skills, its protection, its status and its in-progress state (it was
 * not operated on), no weapon is registered, no Target changes, and the
 * alternate weapon is recorded nowhere. The record is
 * `executed_on_alternate_weapon` with the Skills the tracked weapon kept as
 * its `actualResult`; from then on the actual state normalizes that weapon's
 * Skills to the Skills the Plan expects while it still holds exactly those
 * kept Skills (`collectPlanSkillRetentionBindings()`), so the
 * `expectedStateAfter` and the next Step's `expectedStateBefore` are verified
 * as usual and an unplanned change of the weapon is still detected. The Step
 * is never the Plan's last Step, so the Plan stays `active`.
 */
export function prepareAlternateWeaponStepExecution(
  input: AlternateWeaponStepExecutionInput,
): ExecutionStepWrite {
  const { plan, state, now } = input
  const { step, bindings } = requireExecutableCurrentStep(input)
  const availability = inspectAlternateWeaponExecution(plan, step.id)
  if (availability.kind !== 'available') {
    executionFailure(
      'alternate_weapon_not_allowed',
      `PlanStep '${step.id}' must be performed on its tracked weapon (${availability.reason}).`,
    )
  }
  const weapon = state.ownedWeapons.find(({ id }) => id === availability.trackedOwnedWeaponId)
  if (weapon === undefined || weapon.kind !== 'gogma') {
    inconsistent(`PlanStep '${step.id}' tracks OwnedWeapon '${availability.trackedOwnedWeaponId}', which is not an existing Gogma weapon.`)
  }

  const counters = applyRngAdvance(step, state.rngState, state.normalCounters, input.counterAuthority, now)
  // The tracked weapon was not operated on: the working state is untouched.
  const mutable = createMutableExecutionState(state)
  const nextPlan = nextPlanAfterStep(plan, step, now)
  if (nextPlan.status !== 'active') {
    inconsistent(`PlanStep '${step.id}' ends ProductionPlan '${plan.id}', so its result is required.`)
  }
  const changes = collectEntityChanges(state, mutable)
  assertStepResultValid(changes, nextPlan)

  const actualResult: ActualResult = {
    restorationBonuses: null,
    restorationBonusScope: null,
    seriesSkillId: weapon.seriesSkillId,
    groupSkillId: weapon.groupSkillId,
    securedOwnedWeaponId: null,
    note: null,
  }
  const metadata: ExecutionRecordMetadata = {
    id: input.executionHistoryId,
    planId: plan.id,
    planStepId: step.id,
    action: 'executed_on_alternate_weapon',
    actualResult,
    wasExpected: true,
    recalculationReason: null,
    createdAt: now,
  }
  const actualAfter = createActualExecutionState(
    plan,
    {
      rngState: counters.rngState,
      normalCounters: counters.normalCounters,
      ownedWeapons: changes.nextWeapons,
      targetWeapons: changes.nextTargets,
      buildListEntries: state.buildListEntries,
    },
    {
      observations: bindings.observations,
      // The record being written opens the binding on the tracked weapon.
      skillRetentions: collectPlanSkillRetentionBindings(nextPlan, [
        ...state.planExecutionHistory,
        { ...metadata, addedOwnedWeaponIds: [] },
      ]),
    },
  )
  if (!executionStateMatches(actualAfter, step.expectedStateAfter)) {
    executionFailure(
      'expected_state_after_mismatch',
      `The state after performing PlanStep '${step.id}' on an alternate weapon differs from its expectedStateAfter.`,
    )
  }

  const record = createExecutionRecord({
    metadata,
    planBefore: plan,
    planAfter: nextPlan,
    state,
    changes,
    deletesExecutionSavePoint: false,
  })
  return {
    rngState: changedEntity(state.rngState, counters.rngState) ? counters.rngState : null,
    normalCounters: changedNormalCounters(state.normalCounters, counters.normalCounters),
    ownedWeapons: changes.changedWeapons,
    targetWeapons: changes.changedTargets,
    plan: nextPlan,
    history: record.history,
    undoSnapshot: record.undoSnapshot,
    deletesExecutionSavePoint: false,
  }
}
