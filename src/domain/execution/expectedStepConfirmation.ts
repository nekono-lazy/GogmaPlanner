import type {
  ActualResult,
  BuildListEntry,
  CalculationContext,
  NormalArtianCounter,
  ExecutionHistoryId,
  ISODateTimeString,
  ObservedRestorationBonusBinding,
  OwnedGogmaArtianWeapon,
  PlanStepId,
  ProductionPlan,
  RestorationBonusSet,
  RngState,
} from '../models/publicTypes'
import { areRestorationBonusSlotsEqual } from '../models/publicTypes'
import { executionFailure } from './executionRuntimeError'
import {
  collectPlanSkillRetentionBindings,
  createActualExecutionState,
  executionStateMatches,
  type ExecutableProductionPlanStep,
  type ExecutionPersistedState,
} from './planExecutionState'
import {
  applyRngAdvance,
  applyTargetLinks,
  createExecutionRecord,
  assertStepResultValid,
  changedEntity,
  changedNormalCounters,
  collectEntityChanges,
  createMutableExecutionState,
  inconsistent,
  markTrackedWeaponInProgress,
  productionTargetNormalIdentity,
  registerProductionTargetNormal,
  requireExecutableCurrentStep,
  requireTarget,
  requireWeapon,
  resultingWeaponIssues,
  stepsWithCompleted,
  withPreference,
  type ExecutionCounterAuthority,
  type ExecutionResultingWeaponValidator,
  type ExecutionStepWrite,
  type MutableExecutionState,
  type StepExecutionContext,
} from './stepExecution'

/** The five slots the user observed on a blind production-target Normal (16.4). */
export interface ExecutionNormalRestorationBonusObservation {
  kind: 'normal_restoration_bonuses'
  restorationBonuses: RestorationBonusSet
}

export interface ExpectedStepConfirmationInput {
  plan: ProductionPlan
  planStepId: PlanStepId
  /** Required exactly for a Step with an observation binding. */
  observation: ExecutionNormalRestorationBonusObservation | null
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  counterAuthority: ExecutionCounterAuthority
  /**
   * Entity validation of the OwnedWeapon registered from an observation beyond
   * its structure: the Master / Production availability authority an Owned
   * Weapon save uses.
   */
  validateResultingWeapon: ExecutionResultingWeaponValidator
  executionHistoryId: ExecutionHistoryId
  now: ISODateTimeString
}

/** Everything one `confirmed_expected` Step confirmation writes. */
export type ExpectedStepConfirmation = ExecutionStepWrite

/**
 * What applying one Step's recorded effects needs besides the working state:
 * the Plan and clock, the Counter authority, the resulting weapon validator,
 * and the observation of a blind production-target Normal (`null` otherwise).
 */
export interface ExpectedStepTransitionContext extends StepExecutionContext {
  counterAuthority: ExecutionCounterAuthority
  validateResultingWeapon: ExecutionResultingWeaponValidator
  observation: ExecutionNormalRestorationBonusObservation | null
}

/** The Counters and entities one Step transition reads and advances. */
export interface ExpectedStepWorkingState {
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  mutable: MutableExecutionState
  entryById: ReadonlyMap<string, BuildListEntry>
}

/**
 * Registers the production-target Normal (`docs/PLANNER_SPEC.md` 16.3): the
 * predicted five slots of a predicted Normal, or the user's observed five slots
 * of a blind one - never fabricated slots.
 */
function registerExpectedProductionTargetNormal(
  input: ExpectedStepTransitionContext,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
): void {
  const identity = productionTargetNormalIdentity(step, state)
  if (step.executionEffects.observationBinding === null) {
    registerProductionTargetNormal(input, step, state, identity.predictedBonuses as RestorationBonusSet)
    return
  }
  if (input.observation === null) {
    executionFailure('observation_required', `PlanStep '${step.id}' needs the five restoration bonus slots observed in the game.`)
  }
  const registered = registerProductionTargetNormal(input, step, state, input.observation.restorationBonuses)
  const { structural, messages } = resultingWeaponIssues(registered, input.validateResultingWeapon)
  if (messages.length > 0) {
    executionFailure(
      'observation_invalid',
      `The observed five slots are not a valid Normal Artian for PlanStep '${step.id}': ${messages.join(' / ')}`,
      structural.issues,
    )
  }
}

/** Updates the tracked weapon in place with the Step's recorded expected result. */
function updateTrackedWeapon(
  input: StepExecutionContext,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
): void {
  const { now } = input
  const weapon = requireWeapon(state, step.executionEffects.trackedOwnedWeaponId, step.id)
  const result = step.expectedResult
  if (result === null) inconsistent(`PlanStep '${step.id}' has no expected result.`)
  switch (step.operationType) {
    case 'convert_normal_to_gogma': {
      if (weapon.kind !== 'normal') inconsistent(`Conversion source '${weapon.id}' is not a Normal Artian.`)
      if (
        result.restorationBonuses !== null &&
        !areRestorationBonusSlotsEqual(weapon.restorationBonuses, result.restorationBonuses)
      ) {
        inconsistent(`Conversion of '${weapon.id}' does not preserve its five slots.`)
      }
      const { rarity: _rarity, ...rest } = weapon
      void _rarity
      const converted: OwnedGogmaArtianWeapon = {
        ...rest,
        kind: 'gogma',
        seriesSkillId: result.seriesSkillId,
        groupSkillId: result.groupSkillId,
        status: 'unclassified',
        updatedAt: now,
      }
      state.weapons.set(weapon.id, converted)
      return
    }
    case 'reset_bonuses':
    case 'keep_bonuses':
      if (weapon.kind !== 'gogma' || result.restorationBonuses === null) {
        inconsistent(`The bonus amendment of '${weapon.id}' has no Gogma weapon or no expected result.`)
      }
      state.weapons.set(weapon.id, {
        ...weapon,
        restorationBonuses: structuredClone(result.restorationBonuses),
        restorationBonusScope: 'gogma_artian',
        updatedAt: now,
      })
      return
    case 'reset_skills':
      if (weapon.kind !== 'gogma') inconsistent(`Reset Skills of '${weapon.id}' has no Gogma weapon.`)
      state.weapons.set(weapon.id, {
        ...weapon,
        seriesSkillId: result.seriesSkillId,
        groupSkillId: result.groupSkillId,
        updatedAt: now,
      })
      return
    default:
      inconsistent(`PlanStep '${step.id}' (${step.operationType}) does not update a tracked weapon.`)
  }
}

/**
 * Compromise labels (calculation schema 11..18, 16.12) are no Execution effect
 * any more: Execution never writes `status = practical` (Issue #100,
 * `docs/PLANNER_SPEC.md` 20.4). A schema 19 Step always carries an empty
 * `compromiseLabels`, so this is a no-op; a Step that still carries a label is
 * a legacy Step, never applied as if it carried none.
 */
function refuseCompromiseLabels(step: ExecutableProductionPlanStep): void {
  if (step.executionEffects.compromiseLabels.length > 0) {
    inconsistent(`PlanStep '${step.id}' carries a compromise label, which current Execution no longer applies.`)
  }
}

/**
 * Ideal completion and Target completion (16.13): the weapon holds the Candidate
 * result as a protected Ideal, the completed Target records it as its
 * completion assignment (Issue #334, 21.6), and the completed Target plus every
 * Target that preferred the weapon lose that preference - nothing else about
 * those Targets changes.
 */
function applyTargetCompletions(
  context: StepExecutionContext,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
  entryById: ReadonlyMap<string, BuildListEntry>,
): void {
  const { plan, now } = context
  step.executionEffects.targetCompletions.forEach((completion) => {
    const weapon = requireWeapon(state, completion.ownedWeaponId, step.id)
    const entry = entryById.get(completion.buildListEntryId)
    if (!entry || entry.targetWeaponId !== completion.targetWeaponId) {
      inconsistent(`The completion of PlanStep '${step.id}' has no matching BuildListEntry.`)
    }
    if (weapon.kind !== 'gogma') inconsistent(`The completed weapon '${weapon.id}' is not a Gogma weapon.`)
    const candidate = entry.candidateSnapshot
    state.weapons.set(weapon.id, {
      ...weapon,
      restorationBonuses: structuredClone(candidate.finalBonuses),
      restorationBonusScope: candidate.restorationBonusScope,
      seriesSkillId: candidate.seriesSkillId,
      groupSkillId: candidate.groupSkillId,
      status: 'ideal',
      isProtected: true,
      executionInProgress: null,
      updatedAt: now,
    })
    const target = requireTarget(state, completion.targetWeaponId, step.id)
    state.targets.set(target.id, {
      ...target,
      lifecycleStatus: 'completed',
      completedAt: now,
      completedByProductionPlanId: plan.id,
      // The completion assignment (Issue #334, `docs/PLANNER_SPEC.md` 21.6):
      // `targetCompletions[].ownedWeaponId` is its authority, written in this
      // same transaction. The collection validation of the Step refuses a
      // weapon another Target was completed with.
      completedWithOwnedWeaponId: weapon.id,
      preferredOwnedWeaponId: null,
      updatedAt: now,
    })
    state.targets.forEach((other) => {
      if (other.preferredOwnedWeaponId === weapon.id) {
        state.targets.set(other.id, withPreference(other, null, now))
      }
    })
    if ([...state.targets.values()].some(({ preferredOwnedWeaponId }) => preferredOwnedWeaponId === weapon.id)) {
      executionFailure('collection_validation_failed', `A Target still prefers the completed weapon '${weapon.id}'.`)
    }
  })
}

/**
 * The Plan after `step` is completed: the next incomplete Step becomes current,
 * or the Plan is `completed` when none is left.
 */
export function nextPlanAfterStep(
  plan: ProductionPlan,
  step: ExecutableProductionPlanStep,
  now: ISODateTimeString,
): ProductionPlan {
  const steps = stepsWithCompleted(plan, step, now)
  const next = steps.find(({ isCompleted }) => !isCompleted) ?? null
  return {
    ...structuredClone(plan),
    steps,
    status: next === null ? 'completed' : 'active',
    currentStepId: next?.id ?? null,
    completedAt: next === null ? now : null,
    abandonmentReason: null,
    abandonedAt: null,
    updatedAt: now,
  }
}

/**
 * Applies one Step exactly as the Plan recorded it (`docs/PLANNER_SPEC.md`
 * 16.1 / 16.3): its `rngAdvance` through the Counter authority, the tracked
 * weapon registration or same-ID update with the recorded expected result (or
 * a blind observation), the in-progress mark, target links and target
 * completions (a legacy compromise label is refused). It completes no Step,
 * writes no ExecutionHistory and runs no RNG prediction; the working entity
 * state is updated in place and the advanced Counters are returned.
 *
 * This is the one state transition authority `confirmed_expected` and the
 * Current Position Recovery replay (16.15) share.
 */
export function applyExpectedStepTransition(
  context: ExpectedStepTransitionContext,
  step: ExecutableProductionPlanStep,
  working: ExpectedStepWorkingState,
): { rngState: RngState; normalCounters: NormalArtianCounter[] } {
  const effects = step.executionEffects
  const counters = applyRngAdvance(step, working.rngState, working.normalCounters, context.counterAuthority, context.now)
  const { mutable } = working
  if (step.operationType === 'create_normal_artian') {
    if (effects.normalCreationRole === 'production_target') {
      registerExpectedProductionTargetNormal(context, step, mutable)
    } else if (effects.normalCreationRole !== 'counter_advance') {
      inconsistent(`PlanStep '${step.id}' has no Normal creation role.`)
    }
  } else if (step.operationType !== 'confirm_owned_ideal') {
    updateTrackedWeapon(context, step, mutable)
    markTrackedWeaponInProgress(context, step, mutable)
  }
  applyTargetLinks(context, step, mutable)
  refuseCompromiseLabels(step)
  applyTargetCompletions(context, step, mutable, working.entryById)
  return counters
}

/** 16.2 / 16.10.1: a completed Plan leaves no weapon in progress for it. */
export function clearPlanInProgress(
  plan: ProductionPlan,
  mutable: MutableExecutionState,
  now: ISODateTimeString,
): void {
  mutable.weapons.forEach((weapon) => {
    if (weapon.executionInProgress?.productionPlanId === plan.id) {
      mutable.weapons.set(weapon.id, { ...weapon, executionInProgress: null, updatedAt: now })
    }
  })
}

/**
 * Decides one `confirmed_expected` Step confirmation (`docs/PLANNER_SPEC.md`
 * 16.1 / 16.3 / 16.4), purely from the persisted state and the Plan's recorded
 * Step data. It re-runs no RNG prediction.
 *
 * Order: validate the Plan, its current Step, its premises and the
 * `expectedStateBefore`; apply `rngAdvance`; register or update the tracked
 * weapon; target links; refuse a legacy compromise label; target completions;
 * complete the Step (and the Plan on its last Step, clearing every in-progress
 * weapon of the Plan); verify entities, the Target preference collection and
 * `expectedStateAfter`; build the ExecutionHistory and its Undo body from the
 * untouched state. Any failure throws before the caller writes
 * anything.
 */
export function prepareExpectedStepConfirmation(
  input: ExpectedStepConfirmationInput,
): ExpectedStepConfirmation {
  const { plan, state, now } = input
  const { step, bindings } = requireExecutableCurrentStep(input)
  const effects = step.executionEffects
  if (effects.observationBinding === null && input.observation !== null) {
    executionFailure('observation_not_expected', `PlanStep '${step.id}' has no observation binding.`)
  }
  if (effects.observationBinding !== null && input.observation === null) {
    executionFailure('observation_required', `PlanStep '${step.id}' needs the five restoration bonus slots observed in the game.`)
  }

  const mutable = createMutableExecutionState(state)
  const counters = applyExpectedStepTransition(input, step, {
    rngState: state.rngState,
    normalCounters: [...state.normalCounters],
    mutable,
    entryById: new Map(state.buildListEntries.map((entry) => [entry.id, entry])),
  })

  const nextPlan = nextPlanAfterStep(plan, step, now)
  if (nextPlan.status === 'completed') clearPlanInProgress(plan, mutable, now)

  const changes = collectEntityChanges(state, mutable)
  assertStepResultValid(changes, nextPlan)

  const pendingObservations: ObservedRestorationBonusBinding[] = input.observation === null || effects.trackedOwnedWeaponId === null
    ? [...bindings.observations]
    : [
        ...bindings.observations,
        {
          ownedWeaponId: effects.trackedOwnedWeaponId,
          planStepId: step.id,
          observedRestorationBonuses: input.observation.restorationBonuses,
          observedRestorationBonusScope: 'normal_artian',
        },
      ]
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
      observations: pendingObservations,
      // The confirmed Step is completed in `nextPlan`, so a retained Skill
      // binding this ordinary confirmation closes - a Reset Skills, a
      // conversion or a completion on the weapon - is no longer in force
      // (`docs/PLANNER_SPEC.md` 16.20).
      skillRetentions: collectPlanSkillRetentionBindings(nextPlan, state.planExecutionHistory),
    },
  )
  if (!executionStateMatches(actualAfter, step.expectedStateAfter)) {
    executionFailure(
      'expected_state_after_mismatch',
      `The state after confirming PlanStep '${step.id}' differs from its expectedStateAfter.`,
    )
  }

  const actualResult: ActualResult | null = input.observation === null
    ? null
    : {
        restorationBonuses: structuredClone(input.observation.restorationBonuses),
        restorationBonusScope: 'normal_artian',
        seriesSkillId: null,
        groupSkillId: null,
        securedOwnedWeaponId: null,
        note: null,
      }
  const deletesExecutionSavePoint = nextPlan.status === 'completed' && state.executionSavePoint !== null
  const record = createExecutionRecord({
    metadata: {
      id: input.executionHistoryId,
      planId: plan.id,
      planStepId: step.id,
      action: 'confirmed_expected',
      actualResult,
      wasExpected: true,
      recalculationReason: null,
      createdAt: now,
    },
    planBefore: plan,
    planAfter: nextPlan,
    state,
    changes,
    deletesExecutionSavePoint,
  })

  return {
    rngState: changedEntity(state.rngState, counters.rngState) ? counters.rngState : null,
    normalCounters: changedNormalCounters(state.normalCounters, counters.normalCounters),
    ownedWeapons: changes.changedWeapons,
    targetWeapons: changes.changedTargets,
    plan: nextPlan,
    history: record.history,
    undoSnapshot: record.undoSnapshot,
    deletesExecutionSavePoint,
  }
}
