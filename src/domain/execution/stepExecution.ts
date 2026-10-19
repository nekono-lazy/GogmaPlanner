import type {
  CalculationContext,
  ExecutionHistory,
  ExecutionUndoSnapshot,
  ISODateTimeString,
  NormalArtianCounter,
  ObservedRestorationBonusBinding,
  OwnedNormalArtianWeapon,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStepId,
  ProductionPlan,
  RecalculationReason,
  RestorationBonusSet,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import {
  stableStringify,
  V1_NORMAL_ARTIAN_RARITY,
  validateExecutionHistory,
  validateOwnedWeapon,
  validateProductionPlan,
  validateTargetWeapon,
} from '../models/publicTypes'
import type { RngEngine } from '../rng/rngEngine'
import { validateTargetPreferredOwnedWeapons } from '../target/preferredOwnedWeapon'
import { executionFailure } from './executionRuntimeError'
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

/**
 * The Domain Counter advance authority (`docs/RNG_SPEC.md`): the same RngEngine
 * methods the Planner advanced its simulated Counters with. Execution applies a
 * Step's recorded `rngAdvance` through it and never writes `counter + 1`.
 */
export type ExecutionCounterAuthority = Pick<
  RngEngine,
  'advanceGogmaCounter' | 'advanceSkillCounter' | 'advanceNormalCounter'
>

/**
 * Entity validation of an OwnedWeapon whose contents come from the game (an
 * observed or actual result) beyond its structure: the Master / Production
 * availability authority an Owned Weapon save uses. Returns human-readable
 * issues; empty means valid.
 */
export type ExecutionResultingWeaponValidator = (weapon: OwnedWeapon) => readonly string[]

/**
 * Everything one Execution Step transaction writes, decided and validated
 * before a single write happens (`docs/DATA_MODEL.md` 14.4).
 */
export interface ExecutionStepWrite {
  rngState: RngState | null
  normalCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
  plan: ProductionPlan
  history: ExecutionHistory
  /** Whether the Plan's game save point is deleted (the Plan completed). */
  deletesExecutionSavePoint: boolean
}

/** The Plan and clock of the Step being executed. */
export interface StepExecutionContext {
  plan: ProductionPlan
  now: ISODateTimeString
}

export interface CurrentStepExecutionInput {
  plan: ProductionPlan
  planStepId: PlanStepId
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
}

export interface ExecutableCurrentStep {
  step: ExecutableProductionPlanStep
  /** The observation bindings the Plan's confirmed Steps recorded. */
  bindings: ObservedRestorationBonusBinding[]
}

export function changedEntity(before: unknown, after: unknown): boolean {
  if (before === undefined || after === undefined) return before !== after
  return stableStringify(before) !== stableStringify(after)
}

export function inconsistent(message: string): never {
  executionFailure('execution_effect_inconsistent', message)
}

/**
 * The premises every Step transaction re-checks inside the transaction before
 * it decides anything (`docs/PLANNER_SPEC.md` 16.1 / 16.5 / 16.6): an active
 * executable current Plan, the requested Step being its current incomplete
 * Step, unchanged Plan-dependent Targets and Entries, and the persisted state
 * equal to that Step's `expectedStateBefore`.
 */
export function requireExecutableCurrentStep(input: CurrentStepExecutionInput): ExecutableCurrentStep {
  const { plan, state } = input
  if (plan.status !== 'active') {
    executionFailure('plan_not_active', `ProductionPlan '${plan.id}' is '${plan.status}'; only an active Plan accepts Step confirmation.`)
  }
  assertExecutableProductionPlan(plan, input.currentCalculationContext)
  const step = requireCurrentPlanStep(plan, input.planStepId)
  assertPlanDependenciesUnchanged(plan, state.targetWeapons, state.buildListEntries)
  const bindings = collectPlanObservationBindings(plan, state.planExecutionHistory)
  if (!executionStateMatches(createActualExecutionState(plan, state, bindings), step.expectedStateBefore)) {
    executionFailure(
      'execution_state_mismatch',
      `The current RNG, Normal Counter, OwnedWeapon or Plan-dependent Target state differs from the expected state before PlanStep '${step.id}'.`,
    )
  }
  return { step, bindings }
}

function assertNoCounterAdvance(step: ExecutableProductionPlanStep, streams: readonly ('gogma' | 'skill' | 'normal')[]) {
  const advance = step.rngAdvance
  if (streams.includes('gogma') && advance.gogmaCounterDelta !== 0) {
    inconsistent(`PlanStep '${step.id}' (${step.operationType}) cannot advance the Gogma Counter.`)
  }
  if (streams.includes('skill') && advance.skillCounterDelta !== 0) {
    inconsistent(`PlanStep '${step.id}' (${step.operationType}) cannot advance the Skill Counter.`)
  }
  if (streams.includes('normal') && (advance.normalCounterDelta !== null || advance.affectedNormalCounterId !== null)) {
    inconsistent(`PlanStep '${step.id}' (${step.operationType}) cannot advance a Normal Artian Counter.`)
  }
}

function advanceKnownCounter(
  step: ExecutableProductionPlanStep,
  label: string,
  current: number | null,
  delta: number,
  advance: (value: number) => number,
): number {
  if (current === null) {
    inconsistent(`PlanStep '${step.id}' advances the ${label}, but its current value is unknown.`)
  }
  const next = advance(current)
  if (next - current !== delta) {
    inconsistent(`PlanStep '${step.id}' records a ${label} advance of ${delta}, but the Counter authority advances it by ${next - current}.`)
  }
  return next
}

/**
 * Applies the Step's `rngAdvance` immediately (`docs/PLANNER_SPEC.md` 16.1),
 * through the Counter authority and only for the stream its operation moves.
 * `normalCounterDelta = null` means the Step represents no Normal Counter
 * advance; it is never read as 0 and never creates a Counter record.
 */
export function applyRngAdvance(
  step: ExecutableProductionPlanStep,
  rngState: RngState,
  normalCounters: readonly NormalArtianCounter[],
  authority: ExecutionCounterAuthority,
  now: ISODateTimeString,
): { rngState: RngState; normalCounters: NormalArtianCounter[] } {
  const advance = step.rngAdvance
  let nextRng = rngState
  let nextCounters = [...normalCounters]
  switch (step.operationType) {
    case 'create_normal_artian': {
      assertNoCounterAdvance(step, ['gogma', 'skill'])
      if (advance.normalCounterDelta === null) {
        if (advance.affectedNormalCounterId !== null) {
          inconsistent(`PlanStep '${step.id}' names a Normal Counter without an advance.`)
        }
        break
      }
      const counterId = advance.affectedNormalCounterId
      const record = counterId === null ? undefined : normalCounters.find(({ id }) => id === counterId)
      if (record === undefined || !record.isConfirmed) {
        inconsistent(`PlanStep '${step.id}' advances Normal Counter '${counterId}', which is not a confirmed Counter.`)
      }
      const counter = advanceKnownCounter(step, 'Normal Artian Counter', record.counter, advance.normalCounterDelta, (value) =>
        authority.advanceNormalCounter(value, { type: 'create_normal_artian', count: 1 }))
      nextCounters = normalCounters.map((existing) =>
        existing.id === record.id ? { ...existing, counter, updatedAt: now } : existing)
      break
    }
    case 'convert_normal_to_gogma':
    case 'reset_skills': {
      assertNoCounterAdvance(step, ['gogma', 'normal'])
      const operation = { type: step.operationType }
      const value = advanceKnownCounter(step, 'Skill Counter', rngState.skillCounter.value, advance.skillCounterDelta, (current) =>
        authority.advanceSkillCounter(current, operation))
      nextRng = { ...rngState, skillCounter: { ...rngState.skillCounter, value }, updatedAt: now }
      break
    }
    case 'reset_bonuses':
    case 'keep_bonuses': {
      assertNoCounterAdvance(step, ['skill', 'normal'])
      const operation = { type: step.operationType }
      const value = advanceKnownCounter(step, 'Gogma Counter', rngState.gogmaCounter.value, advance.gogmaCounterDelta, (current) =>
        authority.advanceGogmaCounter(current, operation))
      nextRng = { ...rngState, gogmaCounter: { ...rngState.gogmaCounter, value }, updatedAt: now }
      break
    }
    case 'confirm_owned_ideal':
      assertNoCounterAdvance(step, ['gogma', 'skill', 'normal'])
      break
    case 'reserve_weapon':
    case 'confirm_result':
      executionFailure('plan_not_executable', `PlanStep '${step.id}' is a legacy '${step.operationType}' Step.`)
  }
  return { rngState: nextRng, normalCounters: nextCounters }
}

export interface MutableExecutionState {
  weapons: Map<OwnedWeaponId, OwnedWeapon>
  targets: Map<TargetWeaponId, TargetWeapon>
}

export function createMutableExecutionState(
  state: Pick<ExecutionPersistedState, 'ownedWeapons' | 'targetWeapons'>,
): MutableExecutionState {
  return {
    weapons: new Map(state.ownedWeapons.map((weapon) => [weapon.id, structuredClone(weapon)])),
    targets: new Map(state.targetWeapons.map((target) => [target.id, structuredClone(target)])),
  }
}

export function requireTarget(state: MutableExecutionState, id: TargetWeaponId | null, stepId: PlanStepId): TargetWeapon {
  const target = id === null ? undefined : state.targets.get(id)
  if (!target) inconsistent(`PlanStep '${stepId}' references TargetWeapon '${id}', which does not exist.`)
  return target
}

export function requireWeapon(state: MutableExecutionState, id: OwnedWeaponId | null, stepId: PlanStepId): OwnedWeapon {
  const weapon = id === null ? undefined : state.weapons.get(id)
  if (!weapon) inconsistent(`PlanStep '${stepId}' operates on OwnedWeapon '${id}', which does not exist.`)
  return weapon
}

function inProgressFor(plan: ProductionPlan, now: ISODateTimeString) {
  return { productionPlanId: plan.id, startedAt: now }
}

/**
 * The Planner-reserved ID and the weapon type / element the production-target
 * Normal of a `create_normal_artian` Step is registered with
 * (`docs/PLANNER_SPEC.md` 16.3). The predicted variant carries them in its
 * recorded inventory change; the blind variant takes them from its Target.
 */
export function productionTargetNormalIdentity(
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
): { weaponId: OwnedWeaponId; target: TargetWeapon; weaponTypeId: string; elementId: string; predictedBonuses: RestorationBonusSet | null } {
  const effects = step.executionEffects
  const weaponId = effects.trackedOwnedWeaponId
  if (weaponId === null || !effects.registersTrackedWeapon) {
    inconsistent(`PlanStep '${step.id}' is a production-target Normal without a registered tracked weapon.`)
  }
  if (state.weapons.has(weaponId)) {
    inconsistent(`The production-target OwnedWeapon ID '${weaponId}' already exists.`)
  }
  const target = requireTarget(state, step.targetWeaponId, step.id)
  if (effects.observationBinding !== null) {
    return { weaponId, target, weaponTypeId: target.weaponTypeId, elementId: target.elementId, predictedBonuses: null }
  }
  const predicted = step.inventoryChange?.addOwnedWeapon ?? null
  if (predicted === null || predicted.id !== weaponId || predicted.kind !== 'normal') {
    inconsistent(`PlanStep '${step.id}' has no predicted production-target Normal to register.`)
  }
  return {
    weaponId,
    target,
    weaponTypeId: predicted.weaponTypeId,
    elementId: predicted.elementId,
    predictedBonuses: predicted.restorationBonuses,
  }
}

/**
 * Registers the production-target Normal under its Planner-reserved ID with the
 * given five slots, already in progress for the Plan (16.3 / 16.10.1). The
 * slots are never fabricated: the caller passes the predicted, observed or
 * actual slots.
 */
export function registerProductionTargetNormal(
  context: StepExecutionContext,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
  restorationBonuses: RestorationBonusSet,
): OwnedNormalArtianWeapon {
  const { plan, now } = context
  const identity = productionTargetNormalIdentity(step, state)
  const registered: OwnedNormalArtianWeapon = {
    id: identity.weaponId,
    kind: 'normal',
    name: identity.target.name,
    weaponTypeId: identity.weaponTypeId,
    elementId: identity.elementId,
    rarity: V1_NORMAL_ARTIAN_RARITY,
    restorationBonuses: structuredClone(restorationBonuses),
    restorationBonusScope: 'normal_artian',
    seriesSkillId: null,
    groupSkillId: null,
    status: null,
    isProtected: false,
    executionInProgress: inProgressFor(plan, now),
    memo: null,
    createdAt: now,
    updatedAt: now,
  }
  state.weapons.set(identity.weaponId, registered)
  return registered
}

/**
 * Structural plus Master / Production availability validation of a weapon
 * whose contents come from the game. Returns every issue as text; empty means
 * valid. The Master validation runs only on a structurally valid weapon.
 */
export function resultingWeaponIssues(
  weapon: OwnedWeapon,
  validateResultingWeapon: ExecutionResultingWeaponValidator,
): { messages: string[]; structural: ReturnType<typeof validateOwnedWeapon> } {
  const structural = validateOwnedWeapon(weapon)
  const entity = structural.isValid ? validateResultingWeapon(weapon) : []
  return {
    structural,
    messages: [
      ...structural.issues.map(({ path, message }) => `${path}: ${message}`),
      ...entity,
    ],
  }
}

/**
 * Marks the tracked weapon of a real game operation as being produced by this
 * Plan (`docs/PLANNER_SPEC.md` 16.10.1). A weapon already in progress for this
 * Plan keeps its original start time; one in progress for another Plan fails
 * closed.
 */
export function markTrackedWeaponInProgress(
  context: StepExecutionContext,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
): void {
  const weapon = requireWeapon(state, step.executionEffects.trackedOwnedWeaponId, step.id)
  const current = weapon.executionInProgress
  if (current === null) {
    state.weapons.set(weapon.id, { ...weapon, executionInProgress: inProgressFor(context.plan, context.now), updatedAt: context.now })
  } else if (current.productionPlanId !== context.plan.id) {
    inconsistent(`OwnedWeapon '${weapon.id}' is in progress for another ProductionPlan '${current.productionPlanId}'.`)
  }
}

export function withPreference(target: TargetWeapon, preferredOwnedWeaponId: OwnedWeaponId | null, now: ISODateTimeString): TargetWeapon {
  return target.preferredOwnedWeaponId === preferredOwnedWeaponId
    ? target
    : { ...target, preferredOwnedWeaponId, updatedAt: now }
}

/** Target links (16.11): the linked Target takes the weapon from any other Target. */
export function applyTargetLinks(
  context: StepExecutionContext,
  step: ExecutableProductionPlanStep,
  state: MutableExecutionState,
): void {
  const weaponId = step.executionEffects.trackedOwnedWeaponId
  step.executionEffects.targetLinks.forEach((link) => {
    if (weaponId === null) inconsistent(`PlanStep '${step.id}' links a Target without a tracked weapon.`)
    requireWeapon(state, weaponId, step.id)
    const linked = requireTarget(state, link.targetWeaponId, step.id)
    state.targets.forEach((target) => {
      if (target.id !== linked.id && target.preferredOwnedWeaponId === weaponId) {
        state.targets.set(target.id, withPreference(target, null, context.now))
      }
    })
    state.targets.set(linked.id, withPreference(linked, weaponId, context.now))
    const holders = [...state.targets.values()].filter(({ preferredOwnedWeaponId }) => preferredOwnedWeaponId === weaponId)
    if (holders.length !== 1 || holders[0].id !== linked.id) {
      executionFailure('collection_validation_failed', `After linking, OwnedWeapon '${weaponId}' must be preferred by Target '${linked.id}' only.`)
    }
  })
}

/** The Plan's Steps with `step` completed at `now`; every other field is untouched. */
export function stepsWithCompleted(
  plan: ProductionPlan,
  step: ExecutableProductionPlanStep,
  now: ISODateTimeString,
): ProductionPlan['steps'] {
  return plan.steps.map((candidate) =>
    candidate.id === step.id
      ? { ...structuredClone(candidate), isCompleted: true, completedAt: now }
      : structuredClone(candidate))
}

/** Adds a recalculation reason once, keeping every existing reason and its order. */
export function withRecalculationReason(
  reasons: readonly RecalculationReason[],
  reason: RecalculationReason,
): RecalculationReason[] {
  return reasons.includes(reason) ? [...reasons] : [...reasons, reason]
}

export interface ExecutionEntityChanges {
  nextWeapons: OwnedWeapon[]
  nextTargets: TargetWeapon[]
  changedWeapons: OwnedWeapon[]
  changedTargets: TargetWeapon[]
}

export function collectEntityChanges(
  state: Pick<ExecutionPersistedState, 'ownedWeapons' | 'targetWeapons'>,
  mutable: MutableExecutionState,
): ExecutionEntityChanges {
  const weaponsBefore = new Map(state.ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const targetsBefore = new Map(state.targetWeapons.map((target) => [target.id, target]))
  const nextWeapons = [...mutable.weapons.values()]
  const nextTargets = [...mutable.targets.values()]
  return {
    nextWeapons,
    nextTargets,
    changedWeapons: nextWeapons.filter((weapon) => changedEntity(weaponsBefore.get(weapon.id), weapon)),
    changedTargets: nextTargets.filter((target) => changedEntity(targetsBefore.get(target.id), target)),
  }
}

/**
 * Domain validation of every changed entity and the resulting Plan, plus the
 * Target preferred owned weapon collection over the whole resulting state.
 */
export function assertStepResultValid(changes: ExecutionEntityChanges, plan: ProductionPlan): void {
  for (const weapon of changes.changedWeapons) {
    const validation = validateOwnedWeapon(weapon)
    if (!validation.isValid) {
      executionFailure('entity_validation_failed', `OwnedWeapon '${weapon.id}' fails Domain validation after the Step.`, validation.issues)
    }
  }
  for (const target of changes.changedTargets) {
    const validation = validateTargetWeapon(target)
    if (!validation.isValid) {
      executionFailure('entity_validation_failed', `TargetWeapon '${target.id}' fails Domain validation after the Step.`, validation.issues)
    }
  }
  const planValidation = validateProductionPlan(plan)
  if (!planValidation.isValid) {
    executionFailure('entity_validation_failed', `ProductionPlan '${plan.id}' fails Domain validation after the Step.`, planValidation.issues)
  }
  const preferences = validateTargetPreferredOwnedWeapons(changes.nextTargets, changes.nextWeapons)
  if (!preferences.isValid) {
    executionFailure('collection_validation_failed', 'The Target preferred owned weapon collection is invalid after the Step.', preferences.issues)
  }
}

/**
 * The Undo snapshot of one Step (`docs/DATA_MODEL.md` 12), taken from the
 * untouched persisted state: the whole RngState, every Normal Counter, the
 * Plan and its save point before the Step, and exactly the OwnedWeapons and
 * TargetWeapons the Step changed, split into updated and added weapons.
 */
export function createExecutionUndoSnapshot(
  plan: ProductionPlan,
  state: ExecutionPersistedState,
  changes: Pick<ExecutionEntityChanges, 'changedWeapons' | 'changedTargets'>,
): ExecutionUndoSnapshot {
  const weaponsBefore = new Map(state.ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const targetsBefore = new Map(state.targetWeapons.map((target) => [target.id, target]))
  return {
    rngStateBefore: structuredClone(state.rngState),
    normalCountersBefore: structuredClone([...state.normalCounters]),
    affectedOwnedWeaponsBefore: changes.changedWeapons
      .filter(({ id }) => weaponsBefore.has(id))
      .map(({ id }) => structuredClone(weaponsBefore.get(id) as OwnedWeapon)),
    addedOwnedWeaponIds: changes.changedWeapons.filter(({ id }) => !weaponsBefore.has(id)).map(({ id }) => id),
    removedOwnedWeaponsBefore: [],
    affectedTargetWeaponsBefore: changes.changedTargets.map(({ id }) => structuredClone(targetsBefore.get(id) as TargetWeapon)),
    productionPlanBefore: structuredClone(plan),
    executionSavePointBefore: structuredClone(state.executionSavePoint),
  }
}

export function assertExecutionHistoryValid(history: ExecutionHistory): void {
  const validation = validateExecutionHistory(history)
  if (!validation.isValid) {
    executionFailure('entity_validation_failed', 'The ExecutionHistory of the Step fails Domain validation.', validation.issues)
  }
}

/** The Counter records whose persisted contents the Step changed. */
export function changedNormalCounters(
  before: readonly NormalArtianCounter[],
  after: readonly NormalArtianCounter[],
): NormalArtianCounter[] {
  return after.filter((counter) => changedEntity(before.find(({ id }) => id === counter.id), counter))
}
