import type {
  ActualResult,
  CalculationContext,
  ExecutionHistory,
  ExecutionHistoryId,
  ISODateTimeString,
  OwnedWeapon,
  PlanStep,
  PlanStepId,
  ProductionPlan,
} from '../models/publicTypes'
import {
  areRestorationBonusSlotsEqual,
  compareExecutionHistoryOrder,
  validateRestorationBonusSet,
} from '../models/publicTypes'
import { executionFailure } from './executionRuntimeError'
import {
  applyExpectedStepTransition,
  clearPlanInProgress,
} from './expectedStepConfirmation'
import {
  assertExecutableProductionPlan,
  assertPlanDependenciesUnchanged,
  collectPlanObservationBindings,
  createActualExecutionState,
  executionStateMatches,
  requireCurrentPlanStep,
  type ExecutableProductionPlanStep,
  type ExecutionPersistedState,
} from './planExecutionState'
import {
  assertExecutionHistoryValid,
  assertStepResultValid,
  changedEntity,
  changedNormalCounters,
  collectEntityChanges,
  createExecutionUndoSnapshot,
  createMutableExecutionState,
  stepsWithCompleted,
  type ExecutionCounterAuthority,
  type ExecutionResultingWeaponValidator,
  type ExecutionStepWrite,
} from './stepExecution'
import type { ExecutionActualResultObservation } from './unexpectedStepResult'

/**
 * Current Position Recovery after `operation_uncertain`
 * (`docs/PLANNER_SPEC.md` 16.15).
 *
 * When the user knows which operation they ran on which weapon but not how
 * many times, the current game result is matched against the results the Plan
 * already recorded for the consecutive Steps of that same physical operation
 * (the Recovery Window). Only a unique position is followed, by replaying the
 * Plan's own Steps up to it. No RNG prediction, Candidate Search or Planner
 * run takes part, nothing outside the Window is searched, and nothing before
 * the current Step is searched: a game that went back is the save point's job.
 */

/** What the user reads off the game screen for the Window's operation. */
export type OperationCountRecoveryObservation = ExecutionActualResultObservation

/** The result contract of the Window's operation (`docs/DATA_MODEL.md` 11.4). */
export type OperationCountRecoveryResultKind =
  | { kind: 'restoration_bonuses'; scope: 'normal_artian' | 'gogma_artian' }
  | { kind: 'skills' }

export interface OperationCountRecoveryWindow {
  planId: ProductionPlan['id']
  /** The `operation_uncertain` record the recovery answers: the Plan's latest ExecutionHistory. */
  uncertainExecutionHistoryId: ExecutionHistoryId
  /** The Plan's current Step, the Step the `operation_uncertain` record named. */
  currentStepId: PlanStepId
  /** `w1 .. wn`: the current Step and the incomplete Steps of the same physical operation after it. */
  steps: ExecutableProductionPlanStep[]
  resultKind: OperationCountRecoveryResultKind
  /**
   * The result at position 0 (nothing ran beyond the persisted state), or
   * `null` when it cannot be derived safely. Never a fabricated value.
   */
  baseline: OperationCountRecoveryObservation | null
}

export type OperationCountRecoveryUnavailableReason =
  /** The Plan is not `stale` with `execution_operation_uncertain`. */
  | 'not_operation_uncertain'
  /** Another recalculation reason stays, so the Plan can never become `active` again. */
  | 'other_recalculation_reason'
  /** The Plan's latest ExecutionHistory is not the `operation_uncertain` record of its current Step. */
  | 'latest_record_not_uncertain'
  /** The current Step has no comparable predicted result (a blind Normal, a legacy Step, ...). */
  | 'no_comparable_result'

export type OperationCountRecoveryAvailability =
  | { kind: 'available'; window: OperationCountRecoveryWindow }
  | { kind: 'unavailable'; reason: OperationCountRecoveryUnavailableReason }

/**
 * The outcome of matching the observations against the Window.
 *
 * `candidates` are the positions `k` at the first observation; a candidate's
 * current position is `k + observations - 1`.
 */
export type OperationCountRecoveryMatch =
  | { kind: 'unique'; candidates: number[]; position: number }
  /** Every candidate's next operation is inside the Window: one more observation is safe. */
  | { kind: 'needs_next_observation'; candidates: number[] }
  /** No position matches, or several do and one more operation could leave the Window. */
  | { kind: 'unrecoverable'; candidates: number[]; reason: 'no_match' | 'ambiguous' }

const RECOVERED_REASON = 'execution_operation_uncertain'

function isExecutable(step: PlanStep): step is ExecutableProductionPlanStep {
  return step.executionEffects !== undefined
}

function resultKindOf(step: ExecutableProductionPlanStep): OperationCountRecoveryResultKind | null {
  switch (step.operationType) {
    case 'create_normal_artian':
      return { kind: 'restoration_bonuses', scope: 'normal_artian' }
    case 'reset_bonuses':
    case 'keep_bonuses':
      return { kind: 'restoration_bonuses', scope: 'gogma_artian' }
    case 'convert_normal_to_gogma':
    case 'reset_skills':
      return { kind: 'skills' }
    case 'confirm_owned_ideal':
    case 'reserve_weapon':
    case 'confirm_result':
      return null
  }
}

/**
 * The comparable result a Step recorded, per its operation's result contract,
 * or `null` when the Step recorded none (a blind Normal records no slots).
 */
export function recordedStepResult(step: PlanStep): OperationCountRecoveryObservation | null {
  if (!isExecutable(step) || step.executionEffects.observationBinding !== null) return null
  const kind = resultKindOf(step)
  const expected = step.expectedResult
  if (kind === null || expected === null) return null
  if (kind.kind === 'skills') {
    return { kind: 'skills', seriesSkillId: expected.seriesSkillId, groupSkillId: expected.groupSkillId }
  }
  if (expected.restorationBonuses === null || expected.restorationBonusScope !== kind.scope) return null
  return {
    kind: 'restoration_bonuses',
    restorationBonuses: expected.restorationBonuses,
    restorationBonusScope: kind.scope,
  }
}

/**
 * The physical operation identity (16.15): operation type, tracked weapon,
 * Counter stream and, for Normal creation, its role. `null` when the Step
 * cannot take part in a Recovery Window.
 */
export function recoveryOperationIdentity(step: PlanStep): string | null {
  if (!isExecutable(step) || recordedStepResult(step) === null) return null
  const effects = step.executionEffects
  const subject = effects.trackedOwnedWeaponId ?? '-'
  switch (step.operationType) {
    case 'create_normal_artian': {
      const counterId = step.rngAdvance.affectedNormalCounterId
      if (counterId === null || effects.normalCreationRole === null) return null
      return JSON.stringify(['create_normal_artian', subject, `normal:${counterId}`, effects.normalCreationRole])
    }
    case 'reset_bonuses':
    case 'keep_bonuses':
      return JSON.stringify([step.operationType, subject, 'gogma'])
    case 'convert_normal_to_gogma':
    case 'reset_skills':
      return JSON.stringify([step.operationType, subject, 'skill'])
    default:
      return null
  }
}

/** Exact semantic equality: the ordered five slots and scope, or both Skills. */
export function recoveryResultsEqual(
  left: OperationCountRecoveryObservation,
  right: OperationCountRecoveryObservation,
): boolean {
  if (left.kind === 'restoration_bonuses' && right.kind === 'restoration_bonuses') {
    return (
      left.restorationBonusScope === right.restorationBonusScope &&
      areRestorationBonusSlotsEqual(left.restorationBonuses, right.restorationBonuses)
    )
  }
  if (left.kind === 'skills' && right.kind === 'skills') {
    return left.seriesSkillId === right.seriesSkillId && left.groupSkillId === right.groupSkillId
  }
  return false
}

/** A persisted weapon's current result in the Window's result contract, or `null`. */
function weaponResult(
  weapon: OwnedWeapon | undefined,
  kind: OperationCountRecoveryResultKind,
): OperationCountRecoveryObservation | null {
  if (weapon === undefined) return null
  if (kind.kind === 'skills') {
    return weapon.kind === 'gogma'
      ? { kind: 'skills', seriesSkillId: weapon.seriesSkillId, groupSkillId: weapon.groupSkillId }
      : null
  }
  if (weapon.restorationBonusScope !== kind.scope) return null
  return { kind: 'restoration_bonuses', restorationBonuses: weapon.restorationBonuses, restorationBonusScope: kind.scope }
}

function orderedPlanHistory(plan: ProductionPlan, history: readonly ExecutionHistory[]): ExecutionHistory[] {
  return history.filter(({ planId }) => planId === plan.id).sort(compareExecutionHistoryOrder)
}

/**
 * The result at position 0, only where it is safe (16.15):
 * - Reset / Keep Bonuses: the tracked Gogma's current `gogma_artian` slots
 * - Reset Skills: the tracked Gogma's current Skills
 * - conversion: none (the tracked weapon is still a Normal and shows no Skill)
 * - Normal creation: the previous Step's predicted slots, only when it is the
 *   immediately preceding completed predicted creation on the same Normal
 *   Counter and the record right before `operation_uncertain` confirmed it as
 *   expected
 */
function deriveBaseline(
  plan: ProductionPlan,
  current: ExecutableProductionPlanStep,
  kind: OperationCountRecoveryResultKind,
  ownedWeapons: readonly OwnedWeapon[],
  history: readonly ExecutionHistory[],
): OperationCountRecoveryObservation | null {
  const tracked = current.executionEffects.trackedOwnedWeaponId
  switch (current.operationType) {
    case 'reset_bonuses':
    case 'keep_bonuses':
      return weaponResult(ownedWeapons.find(({ id }) => id === tracked), kind)
    case 'reset_skills':
      return weaponResult(ownedWeapons.find(({ id }) => id === tracked), kind)
    case 'convert_normal_to_gogma':
      return null
    case 'create_normal_artian': {
      const index = plan.steps.findIndex(({ id }) => id === current.id)
      const previous = index > 0 ? plan.steps[index - 1] : undefined
      if (
        previous === undefined ||
        !previous.isCompleted ||
        previous.operationType !== 'create_normal_artian' ||
        previous.rngAdvance.affectedNormalCounterId !== current.rngAdvance.affectedNormalCounterId
      ) {
        return null
      }
      const recordBefore = history.at(-2)
      if (
        recordBefore === undefined ||
        recordBefore.action !== 'confirmed_expected' ||
        recordBefore.planStepId !== previous.id ||
        recordBefore.actualResult !== null
      ) {
        return null
      }
      return recordedStepResult(previous)
    }
    default:
      return null
  }
}

/**
 * Whether Current Position Recovery applies to the Plan, and its Recovery
 * Window when it does. Pure and read-only: the recovery transaction derives it
 * again from the state it reads and never trusts a Window it was shown.
 */
export function deriveOperationCountRecovery(
  plan: ProductionPlan,
  state: Pick<ExecutionPersistedState, 'ownedWeapons' | 'planExecutionHistory'>,
): OperationCountRecoveryAvailability {
  if (plan.status !== 'stale' || !plan.recalculationReasons.includes(RECOVERED_REASON)) {
    return { kind: 'unavailable', reason: 'not_operation_uncertain' }
  }
  if (plan.recalculationReasons.some((reason) => reason !== RECOVERED_REASON)) {
    return { kind: 'unavailable', reason: 'other_recalculation_reason' }
  }
  const history = orderedPlanHistory(plan, state.planExecutionHistory)
  const latest = history.at(-1)
  if (
    latest === undefined ||
    latest.action !== 'operation_uncertain' ||
    plan.currentStepId === null ||
    latest.planStepId !== plan.currentStepId
  ) {
    return { kind: 'unavailable', reason: 'latest_record_not_uncertain' }
  }
  const startIndex = plan.steps.findIndex(({ id }) => id === plan.currentStepId)
  const current = startIndex < 0 ? undefined : plan.steps[startIndex]
  if (current === undefined || current.isCompleted || !isExecutable(current)) {
    return { kind: 'unavailable', reason: 'latest_record_not_uncertain' }
  }
  const identity = recoveryOperationIdentity(current)
  const resultKind = resultKindOf(current)
  if (identity === null || resultKind === null) {
    return { kind: 'unavailable', reason: 'no_comparable_result' }
  }
  const steps: ExecutableProductionPlanStep[] = []
  for (const step of plan.steps.slice(startIndex)) {
    if (step.isCompleted || !isExecutable(step) || recoveryOperationIdentity(step) !== identity) break
    steps.push(step)
    // A completed Target protects its weapon: the same operation cannot follow.
    if (step.executionEffects.targetCompletions.length > 0) break
  }
  return {
    kind: 'available',
    window: {
      planId: plan.id,
      uncertainExecutionHistoryId: latest.id,
      currentStepId: current.id,
      steps,
      resultKind,
      baseline: deriveBaseline(plan, current, resultKind, state.ownedWeapons, history),
    },
  }
}

/** The result at Window position `p` (`p = 0` is the baseline). */
function resultAtPosition(window: OperationCountRecoveryWindow, position: number): OperationCountRecoveryObservation | null {
  if (position === 0) return window.baseline
  const step = window.steps[position - 1]
  return step === undefined ? null : recordedStepResult(step)
}

/** Refuses an observation that does not fit the Window's result contract. */
export function assertOperationCountRecoveryObservations(
  window: Pick<OperationCountRecoveryWindow, 'resultKind'>,
  observations: readonly OperationCountRecoveryObservation[],
): void {
  if (observations.length === 0) {
    executionFailure('operation_count_recovery_observation_invalid', 'At least one observation of the current game result is needed.')
  }
  const kind = window.resultKind
  observations.forEach((observation, index) => {
    if (observation.kind !== kind.kind) {
      executionFailure('operation_count_recovery_observation_invalid', `Observation ${index + 1} is not a '${kind.kind}' result.`)
    }
    if (observation.kind === 'restoration_bonuses') {
      const structure = validateRestorationBonusSet(observation.restorationBonuses)
      if (!structure.isValid) {
        executionFailure('operation_count_recovery_observation_invalid', `Observation ${index + 1} has invalid five slots.`, structure.issues)
      }
      if (kind.kind === 'restoration_bonuses' && observation.restorationBonusScope !== kind.scope) {
        executionFailure('operation_count_recovery_observation_invalid', `Observation ${index + 1} must have '${kind.scope}' scope.`)
      }
      return
    }
    const validSkill = (value: unknown) => value === null || (typeof value === 'string' && value.trim().length > 0)
    if (!validSkill(observation.seriesSkillId) || !validSkill(observation.groupSkillId)) {
      executionFailure('operation_count_recovery_observation_invalid', `Observation ${index + 1} has an invalid Skill ID.`)
    }
  })
}

/**
 * Matches the observation sequence `o1 .. om` against the Window (16.15):
 * candidate `k` survives when every `oj` equals the result at position
 * `k + j - 1` inside the Window. The whole Window is always examined, and
 * nothing outside it is.
 */
export function matchOperationCountRecovery(
  window: OperationCountRecoveryWindow,
  observations: readonly OperationCountRecoveryObservation[],
): OperationCountRecoveryMatch {
  assertOperationCountRecoveryObservations(window, observations)
  const n = window.steps.length
  const m = observations.length
  const candidates: number[] = []
  for (let k = 0; k + m - 1 <= n; k += 1) {
    const matches = observations.every((observation, j) => {
      const result = resultAtPosition(window, k + j)
      return result !== null && recoveryResultsEqual(result, observation)
    })
    if (matches) candidates.push(k)
  }
  if (candidates.length === 1) {
    return { kind: 'unique', candidates, position: candidates[0] + m - 1 }
  }
  if (candidates.length === 0) return { kind: 'unrecoverable', candidates, reason: 'no_match' }
  // The next operation of every candidate must still be a Window Step: if the
  // true position were one whose next Step leaves the Window, one more
  // operation would be an operation outside the Plan.
  const safe = candidates.every((k) => k + m <= n)
  return safe
    ? { kind: 'needs_next_observation', candidates }
    : { kind: 'unrecoverable', candidates, reason: 'ambiguous' }
}

/** The Step the Plan resumes at after following position `position`, or `null` when none is left. */
export function recoveryResumeStep(
  plan: ProductionPlan,
  window: OperationCountRecoveryWindow,
  position: number,
): PlanStep | null {
  const replayed = new Set(window.steps.slice(0, position).map(({ id }) => id))
  return plan.steps.find((step) => !step.isCompleted && !replayed.has(step.id)) ?? null
}

export interface OperationCountRecoveryInput {
  /** The current persisted Plan. */
  plan: ProductionPlan
  /** The current Step the user saw. */
  planStepId: PlanStepId
  /** The `operation_uncertain` record the user saw as the latest. */
  uncertainExecutionHistoryId: ExecutionHistoryId
  observations: readonly OperationCountRecoveryObservation[]
  /** The position the user confirmed; only a token, the transaction derives it again. */
  recoveredPosition: number
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  counterAuthority: ExecutionCounterAuthority
  validateResultingWeapon: ExecutionResultingWeaponValidator
  executionHistoryId: ExecutionHistoryId
  now: ISODateTimeString
}

function notApplicable(message: string): never {
  executionFailure('operation_count_recovery_not_applicable', message)
}

function toActualResult(observation: OperationCountRecoveryObservation): ActualResult {
  return observation.kind === 'restoration_bonuses'
    ? {
        restorationBonuses: structuredClone(observation.restorationBonuses),
        restorationBonusScope: observation.restorationBonusScope,
        seriesSkillId: null,
        groupSkillId: null,
        securedOwnedWeaponId: null,
        note: null,
      }
    : {
        restorationBonuses: null,
        restorationBonusScope: null,
        seriesSkillId: observation.seriesSkillId,
        groupSkillId: observation.groupSkillId,
        securedOwnedWeaponId: null,
        note: null,
      }
}

/**
 * Decides one Current Position Recovery (`operation_count_recovered`,
 * `docs/PLANNER_SPEC.md` 16.15) purely from the persisted state.
 *
 * It re-checks every premise, derives the Recovery Window and the unique
 * position again, then replays `w1 .. wp` through the same state transition
 * authority `confirmed_expected` uses, verifying each Step's
 * `expectedStateAfter` and finally the tracked weapon against the last
 * observation. The Plan drops `execution_operation_uncertain` and becomes
 * `active` at the next incomplete Step, or `completed`. One ExecutionHistory
 * is recorded with the Undo snapshot of the `stale` state before it.
 */
export function prepareOperationCountRecovery(input: OperationCountRecoveryInput): ExecutionStepWrite {
  const { plan, state, now } = input
  if (plan.status !== 'stale' || !plan.recalculationReasons.includes(RECOVERED_REASON)) {
    notApplicable(`ProductionPlan '${plan.id}' is not stale after an uncertain operation.`)
  }
  if (plan.recalculationReasons.some((reason) => reason !== RECOVERED_REASON)) {
    notApplicable(`ProductionPlan '${plan.id}' has another recalculation reason, so it cannot become active again.`)
  }
  assertExecutableProductionPlan(plan, input.currentCalculationContext)
  const history = orderedPlanHistory(plan, state.planExecutionHistory)
  const latest = history.at(-1)
  if (
    latest === undefined ||
    latest.id !== input.uncertainExecutionHistoryId ||
    latest.action !== 'operation_uncertain' ||
    latest.planStepId !== input.planStepId ||
    plan.currentStepId !== input.planStepId
  ) {
    executionFailure(
      'operation_count_recovery_changed',
      `The latest ExecutionHistory of ProductionPlan '${plan.id}' is no longer the operation_uncertain record the user saw.`,
    )
  }
  const current = requireCurrentPlanStep(plan, input.planStepId)
  assertPlanDependenciesUnchanged(plan, state.targetWeapons, state.buildListEntries)
  const bindings = collectPlanObservationBindings(plan, state.planExecutionHistory)
  const actualState = (working: Parameters<typeof createActualExecutionState>[1]) =>
    createActualExecutionState(plan, working, bindings)
  if (!executionStateMatches(actualState(state), current.expectedStateBefore)) {
    executionFailure(
      'execution_state_mismatch',
      `The persisted state differs from the state the operation_uncertain record left before PlanStep '${current.id}'.`,
    )
  }

  const availability = deriveOperationCountRecovery(plan, state)
  if (availability.kind !== 'available') {
    notApplicable(`PlanStep '${current.id}' has no same-operation Recovery Window (${availability.reason}).`)
  }
  const { window } = availability
  const match = matchOperationCountRecovery(window, input.observations)
  if (match.kind !== 'unique') {
    executionFailure(
      'operation_count_recovery_not_unique',
      `The observations match ${match.candidates.length} positions of the Recovery Window, not exactly one.`,
    )
  }
  if (match.position !== input.recoveredPosition) {
    executionFailure(
      'operation_count_recovery_changed',
      `The observations now match position ${match.position}, not the confirmed position ${input.recoveredPosition}.`,
    )
  }

  // Replay w1 .. wp exactly as the Plan recorded them.
  const mutable = createMutableExecutionState(state)
  const entryById = new Map(state.buildListEntries.map((entry) => [entry.id, entry]))
  let rngState = state.rngState
  let normalCounters = [...state.normalCounters]
  let steps = plan.steps
  const context = {
    plan,
    now,
    counterAuthority: input.counterAuthority,
    validateResultingWeapon: input.validateResultingWeapon,
    observation: null,
  }
  for (const step of window.steps.slice(0, match.position)) {
    const counters = applyExpectedStepTransition(context, step, { rngState, normalCounters, mutable, entryById })
    rngState = counters.rngState
    normalCounters = counters.normalCounters
    steps = stepsWithCompleted({ ...plan, steps }, step, now)
    const after = actualState({
      rngState,
      normalCounters,
      ownedWeapons: [...mutable.weapons.values()],
      targetWeapons: [...mutable.targets.values()],
      buildListEntries: state.buildListEntries,
    })
    if (!executionStateMatches(after, step.expectedStateAfter)) {
      executionFailure(
        'expected_state_after_mismatch',
        `The state after replaying PlanStep '${step.id}' differs from its expectedStateAfter.`,
      )
    }
  }

  // The followed state must show exactly what the user last saw in the game.
  const lastObservation = input.observations[input.observations.length - 1]
  const tracked = current.executionEffects.trackedOwnedWeaponId
  if (match.position > 0 && tracked !== null) {
    const result = weaponResult(mutable.weapons.get(tracked), window.resultKind)
    if (result === null || !recoveryResultsEqual(result, lastObservation)) {
      executionFailure(
        'operation_count_recovery_not_unique',
        `The replayed weapon '${tracked}' does not show the observed game result.`,
      )
    }
  }

  const next = steps.find(({ isCompleted }) => !isCompleted) ?? null
  const nextPlan: ProductionPlan = {
    ...structuredClone(plan),
    steps: structuredClone(steps),
    status: next === null ? 'completed' : 'active',
    currentStepId: next?.id ?? null,
    recalculationReasons: [],
    completedAt: next === null ? now : null,
    abandonmentReason: null,
    abandonedAt: null,
    updatedAt: now,
  }
  if (nextPlan.status === 'completed') clearPlanInProgress(plan, mutable, now)

  const changes = collectEntityChanges(state, mutable)
  assertStepResultValid(changes, nextPlan)

  const record: ExecutionHistory = {
    id: input.executionHistoryId,
    planId: plan.id,
    planStepId: match.position > 0 ? window.steps[match.position - 1].id : current.id,
    action: 'operation_count_recovered',
    actualResult: toActualResult(lastObservation),
    wasExpected: true,
    recalculationReason: null,
    undoSnapshot: createExecutionUndoSnapshot(plan, state, changes),
    createdAt: now,
  }
  assertExecutionHistoryValid(record)

  return {
    rngState: changedEntity(state.rngState, rngState) ? rngState : null,
    normalCounters: changedNormalCounters(state.normalCounters, normalCounters),
    ownedWeapons: changes.changedWeapons,
    targetWeapons: changes.changedTargets,
    plan: nextPlan,
    history: record,
    deletesExecutionSavePoint: nextPlan.status === 'completed' && state.executionSavePoint !== null,
  }
}
