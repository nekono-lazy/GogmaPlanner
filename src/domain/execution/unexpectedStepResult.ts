import type {
  ActualResult,
  CalculationContext,
  ExecutionHistory,
  ExecutionHistoryId,
  GroupSkillId,
  ISODateTimeString,
  OwnedGogmaArtianWeapon,
  OwnedNormalArtianWeapon,
  OwnedWeapon,
  PlanStepId,
  ProductionPlan,
  RestorationBonusScope,
  RestorationBonusSet,
  SeriesSkillId,
} from '../models/publicTypes'
import {
  areRestorationBonusSlotsEqual,
  V1_NORMAL_ARTIAN_RARITY,
  validateProductionPlan,
  validateRestorationBonusSet,
} from '../models/publicTypes'
import { executionFailure } from './executionRuntimeError'
import type { ExecutableProductionPlanStep, ExecutionPersistedState } from './planExecutionState'
import {
  applyRngAdvance,
  applyTargetLinks,
  assertExecutionHistoryValid,
  assertStepResultValid,
  changedEntity,
  changedNormalCounters,
  collectEntityChanges,
  createExecutionUndoSnapshot,
  createMutableExecutionState,
  inconsistent,
  markTrackedWeaponInProgress,
  registerProductionTargetNormal,
  requireExecutableCurrentStep,
  requireTarget,
  requireWeapon,
  resultingWeaponIssues,
  stepsWithCompleted,
  withRecalculationReason,
  type ExecutionCounterAuthority,
  type ExecutionResultingWeaponValidator,
  type ExecutionStepWrite,
  type MutableExecutionState,
} from './stepExecution'

/**
 * What the game actually showed after the operation (`docs/PLANNER_SPEC.md`
 * 16.15). The kind follows the operation: the five slots and their scope for
 * Normal creation, Reset Bonuses and Keep Bonuses; the Series / Group Skill
 * pair for conversion and Reset Skills.
 */
export type ExecutionActualResultObservation =
  | {
      kind: 'restoration_bonuses'
      restorationBonuses: RestorationBonusSet
      restorationBonusScope: RestorationBonusScope
    }
  | {
      kind: 'skills'
      seriesSkillId: SeriesSkillId | null
      groupSkillId: GroupSkillId | null
    }

export interface ActualResultDifferentInput {
  plan: ProductionPlan
  planStepId: PlanStepId
  actualResult: ExecutionActualResultObservation
  /** Free text kept with the record; never read by the runtime. */
  note: string | null
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  counterAuthority: ExecutionCounterAuthority
  /** The Master / Production availability authority an Owned Weapon save uses. */
  validateResultingWeapon: ExecutionResultingWeaponValidator
  executionHistoryId: ExecutionHistoryId
  now: ISODateTimeString
}

export interface OperationUncertainInput {
  plan: ProductionPlan
  planStepId: PlanStepId
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  executionHistoryId: ExecutionHistoryId
  now: ISODateTimeString
}

function actualResultInvalid(message: string): never {
  executionFailure('actual_result_invalid', message)
}

/** The actual result kind and scope the operation's result contract fixes (`docs/DATA_MODEL.md` 11.4). */
function actualResultContract(
  step: ExecutableProductionPlanStep,
): { kind: ExecutionActualResultObservation['kind']; scope: RestorationBonusScope | null } {
  switch (step.operationType) {
    case 'create_normal_artian':
      return { kind: 'restoration_bonuses', scope: 'normal_artian' }
    case 'reset_bonuses':
    case 'keep_bonuses':
      return { kind: 'restoration_bonuses', scope: 'gogma_artian' }
    case 'convert_normal_to_gogma':
    case 'reset_skills':
      return { kind: 'skills', scope: null }
    case 'confirm_owned_ideal':
      return executionFailure(
        'actual_result_not_applicable',
        `PlanStep '${step.id}' confirms an owned Ideal without a game operation, so it has no result that can differ.`,
      )
    case 'reserve_weapon':
    case 'confirm_result':
      return executionFailure('plan_not_executable', `PlanStep '${step.id}' is a legacy '${step.operationType}' Step.`)
  }
}

/**
 * Structural check of the actual result against the operation, and refusal of
 * a result the Plan did not predict or that equals the prediction: a blind
 * observation and a matching result are both `confirmed_expected`.
 */
function assertActualResultDiffers(
  step: ExecutableProductionPlanStep,
  actual: ExecutionActualResultObservation,
): void {
  if (step.executionEffects.observationBinding !== null) {
    executionFailure(
      'actual_result_not_applicable',
      `PlanStep '${step.id}' predicts no five slots; record the observed slots with confirmed_expected instead.`,
    )
  }
  const contract = actualResultContract(step)
  if (actual.kind !== contract.kind) {
    actualResultInvalid(`PlanStep '${step.id}' (${step.operationType}) needs a '${contract.kind}' actual result.`)
  }
  const expected = step.expectedResult
  if (actual.kind === 'restoration_bonuses') {
    const structure = validateRestorationBonusSet(actual.restorationBonuses)
    if (!structure.isValid) {
      executionFailure('actual_result_invalid', `The actual five slots of PlanStep '${step.id}' are invalid.`, structure.issues)
    }
    if (actual.restorationBonusScope !== contract.scope) {
      actualResultInvalid(`The ${step.operationType} result of PlanStep '${step.id}' has '${contract.scope}' scope, not '${actual.restorationBonusScope}'.`)
    }
    if (expected === null || expected.restorationBonuses === null || expected.restorationBonusScope === null) {
      executionFailure(
        'actual_result_not_applicable',
        `PlanStep '${step.id}' predicts no five slots, so its result cannot differ from a prediction.`,
      )
    }
    if (
      expected.restorationBonusScope === actual.restorationBonusScope &&
      areRestorationBonusSlotsEqual(expected.restorationBonuses, actual.restorationBonuses)
    ) {
      executionFailure('actual_result_matches_expected', `The actual result of PlanStep '${step.id}' equals its expected result.`)
    }
    return
  }
  if ((actual.seriesSkillId !== null && !isId(actual.seriesSkillId)) || (actual.groupSkillId !== null && !isId(actual.groupSkillId))) {
    actualResultInvalid(`The actual Series or Group Skill of PlanStep '${step.id}' is not a valid ID.`)
  }
  if (expected === null) {
    executionFailure('actual_result_not_applicable', `PlanStep '${step.id}' has no expected result.`)
  }
  if (expected.seriesSkillId === actual.seriesSkillId && expected.groupSkillId === actual.groupSkillId) {
    executionFailure('actual_result_matches_expected', `The actual result of PlanStep '${step.id}' equals its expected result.`)
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertResultingWeaponValid(
  input: ActualResultDifferentInput,
  step: ExecutableProductionPlanStep,
  weapon: OwnedWeapon,
): void {
  const { structural, messages } = resultingWeaponIssues(weapon, input.validateResultingWeapon)
  if (messages.length > 0) {
    executionFailure(
      'actual_result_invalid',
      `The actual result of PlanStep '${step.id}' is not a valid OwnedWeapon: ${messages.join(' / ')}`,
      structural.issues,
    )
  }
}

/**
 * The weapon a Counter-advance Normal forge actually produced is never
 * registered (16.3), but its recorded slots still pass the same Master /
 * Production availability authority, checked on a transient Normal of the
 * Step's Target weapon type and element.
 */
function assertCounterAdvanceResultValid(
  input: ActualResultDifferentInput,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
  restorationBonuses: RestorationBonusSet,
): void {
  const target = requireTarget(state, step.targetWeaponId, step.id)
  const transient: OwnedNormalArtianWeapon = {
    id: `transient.${step.id}` as OwnedWeapon['id'],
    kind: 'normal',
    name: target.name,
    weaponTypeId: target.weaponTypeId,
    elementId: target.elementId,
    rarity: V1_NORMAL_ARTIAN_RARITY,
    restorationBonuses,
    restorationBonusScope: 'normal_artian',
    seriesSkillId: null,
    groupSkillId: null,
    status: null,
    isProtected: false,
    executionInProgress: null,
    memo: null,
    createdAt: input.now,
    updatedAt: input.now,
  }
  assertResultingWeaponValid(input, step, transient)
}

/** Applies the actual result to the tracked weapon under its own ID (16.3 / 16.15). */
function applyActualResultToWeapon(
  input: ActualResultDifferentInput,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
): void {
  const actual = input.actualResult
  const { now } = input
  if (step.operationType === 'create_normal_artian') {
    if (actual.kind !== 'restoration_bonuses') return inconsistent(`PlanStep '${step.id}' needs actual five slots.`)
    const role = step.executionEffects.normalCreationRole
    if (role === 'counter_advance') {
      assertCounterAdvanceResultValid(input, step, state, actual.restorationBonuses)
      return
    }
    if (role !== 'production_target') inconsistent(`PlanStep '${step.id}' has no Normal creation role.`)
    const registered = registerProductionTargetNormal(input, step, state, actual.restorationBonuses)
    assertResultingWeaponValid(input, step, registered)
    return
  }
  const weapon = requireWeapon(state, step.executionEffects.trackedOwnedWeaponId, step.id)
  let updated: OwnedWeapon
  switch (step.operationType) {
    case 'convert_normal_to_gogma': {
      if (actual.kind !== 'skills') return inconsistent(`PlanStep '${step.id}' needs actual Skills.`)
      if (weapon.kind !== 'normal') inconsistent(`Conversion source '${weapon.id}' is not a Normal Artian.`)
      const { rarity: _rarity, ...rest } = weapon
      void _rarity
      const converted: OwnedGogmaArtianWeapon = {
        ...rest,
        kind: 'gogma',
        seriesSkillId: actual.seriesSkillId,
        groupSkillId: actual.groupSkillId,
        status: 'unclassified',
        updatedAt: now,
      }
      updated = converted
      break
    }
    case 'reset_skills':
      if (actual.kind !== 'skills') return inconsistent(`PlanStep '${step.id}' needs actual Skills.`)
      if (weapon.kind !== 'gogma') inconsistent(`Reset Skills of '${weapon.id}' has no Gogma weapon.`)
      updated = { ...weapon, seriesSkillId: actual.seriesSkillId, groupSkillId: actual.groupSkillId, updatedAt: now }
      break
    case 'reset_bonuses':
    case 'keep_bonuses':
      if (actual.kind !== 'restoration_bonuses') return inconsistent(`PlanStep '${step.id}' needs actual five slots.`)
      if (weapon.kind !== 'gogma') inconsistent(`The bonus amendment of '${weapon.id}' has no Gogma weapon.`)
      updated = {
        ...weapon,
        restorationBonuses: structuredClone(actual.restorationBonuses),
        restorationBonusScope: actual.restorationBonusScope,
        updatedAt: now,
      }
      break
    default:
      return inconsistent(`PlanStep '${step.id}' (${step.operationType}) does not update a tracked weapon.`)
  }
  assertResultingWeaponValid(input, step, updated)
  state.weapons.set(weapon.id, updated)
  markTrackedWeaponInProgress(input, step, state)
}

function toPersistedActualResult(actual: ExecutionActualResultObservation, note: string | null): ActualResult {
  return actual.kind === 'restoration_bonuses'
    ? {
        restorationBonuses: structuredClone(actual.restorationBonuses),
        restorationBonusScope: actual.restorationBonusScope,
        seriesSkillId: null,
        groupSkillId: null,
        securedOwnedWeaponId: null,
        note,
      }
    : {
        restorationBonuses: null,
        restorationBonusScope: null,
        seriesSkillId: actual.seriesSkillId,
        groupSkillId: actual.groupSkillId,
        securedOwnedWeaponId: null,
        note,
      }
}

/**
 * Records an operation that was performed exactly as planned but produced a
 * different result (`docs/PLANNER_SPEC.md` 16.15).
 *
 * The operation really consumed its Counter, so `rngAdvance` applies and the
 * Step is completed. The tracked weapon holds the actual result (a
 * production-target Normal is registered with it), the start-of-production
 * effects apply (in progress, target links), and the compromise label and the
 * target completion do not, because the expected state was never reached. The
 * Plan becomes `stale` with `unexpected_result`, stays at the next incomplete
 * Step (or none), and keeps every in-progress weapon and its save point.
 * `expectedStateAfter` is not compared: the result differs by definition.
 */
export function prepareActualResultDifferent(input: ActualResultDifferentInput): ExecutionStepWrite {
  const { plan, state, now } = input
  const { step } = requireExecutableCurrentStep(input)
  assertActualResultDiffers(step, input.actualResult)
  if (input.note !== null && typeof input.note !== 'string') {
    actualResultInvalid('The actual result note must be text or null.')
  }

  const counters = applyRngAdvance(step, state.rngState, state.normalCounters, input.counterAuthority, now)
  const mutable = createMutableExecutionState(state)
  applyActualResultToWeapon(input, step, mutable)
  applyTargetLinks(input, step, mutable)

  const steps = stepsWithCompleted(plan, step, now)
  const next = steps.find(({ isCompleted }) => !isCompleted) ?? null
  const nextPlan: ProductionPlan = {
    ...structuredClone(plan),
    steps,
    status: 'stale',
    currentStepId: next?.id ?? null,
    recalculationReasons: withRecalculationReason(plan.recalculationReasons, 'unexpected_result'),
    completedAt: null,
    abandonmentReason: null,
    abandonedAt: null,
    updatedAt: now,
  }

  const changes = collectEntityChanges(state, mutable)
  assertStepResultValid(changes, nextPlan)

  const history: ExecutionHistory = {
    id: input.executionHistoryId,
    planId: plan.id,
    planStepId: step.id,
    action: 'actual_result_different',
    actualResult: toPersistedActualResult(input.actualResult, input.note),
    wasExpected: false,
    recalculationReason: 'unexpected_result',
    undoSnapshot: createExecutionUndoSnapshot(plan, state, changes),
    createdAt: now,
  }
  assertExecutionHistoryValid(history)

  return {
    rngState: changedEntity(state.rngState, counters.rngState) ? counters.rngState : null,
    normalCounters: changedNormalCounters(state.normalCounters, counters.normalCounters),
    ownedWeapons: changes.changedWeapons,
    targetWeapons: changes.changedTargets,
    plan: nextPlan,
    history,
    deletesExecutionSavePoint: false,
  }
}

/**
 * Records that what or how many operations were performed is unknown
 * (`docs/PLANNER_SPEC.md` 16.15). Nothing is guessed: no Counter, OwnedWeapon,
 * TargetWeapon, in-progress state or save point changes, and the current Step
 * stays incomplete and current. Only the Plan becomes `stale` with
 * `execution_operation_uncertain`, and the record keeps an Undo snapshot of
 * the Plan before it.
 */
export function prepareOperationUncertain(input: OperationUncertainInput): ExecutionStepWrite {
  const { plan, state, now } = input
  const { step } = requireExecutableCurrentStep(input)
  const nextPlan: ProductionPlan = {
    ...structuredClone(plan),
    status: 'stale',
    recalculationReasons: withRecalculationReason(plan.recalculationReasons, 'execution_operation_uncertain'),
    updatedAt: now,
  }
  const planValidation = validateProductionPlan(nextPlan)
  if (!planValidation.isValid) {
    executionFailure('entity_validation_failed', `ProductionPlan '${plan.id}' fails Domain validation after the record.`, planValidation.issues)
  }
  const history: ExecutionHistory = {
    id: input.executionHistoryId,
    planId: plan.id,
    planStepId: step.id,
    action: 'operation_uncertain',
    actualResult: null,
    wasExpected: false,
    recalculationReason: 'execution_operation_uncertain',
    undoSnapshot: createExecutionUndoSnapshot(plan, state, { changedWeapons: [], changedTargets: [] }),
    createdAt: now,
  }
  assertExecutionHistoryValid(history)
  return {
    rngState: null,
    normalCounters: [],
    ownedWeapons: [],
    targetWeapons: [],
    plan: nextPlan,
    history,
    deletesExecutionSavePoint: false,
  }
}
