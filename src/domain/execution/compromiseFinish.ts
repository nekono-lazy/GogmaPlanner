import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  ExecutionHistory,
  ExecutionHistoryId,
  ISODateTimeString,
  OwnedWeaponId,
  PlanStep,
  PlanStepId,
  ProductionPlan,
  TargetWeaponId,
} from '../models/publicTypes'
import {
  hasIntermediateStateSelection,
  isIntermediatePinHeldAtRouteStart,
} from '../planner/plannerCheckpoints'
import { executionFailure } from './executionRuntimeError'
import type { ExecutionPersistedState } from './planExecutionState'
import {
  assertExecutionHistoryValid,
  assertStepResultValid,
  collectEntityChanges,
  createExecutionUndoSnapshot,
  createMutableExecutionState,
  inconsistent,
  requireExecutableCurrentStep,
  requireTarget,
  requireWeapon,
  type ExecutionStepWrite,
} from './stepExecution'

export interface CompromiseFinishInput {
  plan: ProductionPlan
  /**
   * The Plan's current Step the user saw the offer on. It guards against
   * finishing a state the user never saw: a Step confirmed elsewhere in the
   * meantime moves the Plan on and refuses this request.
   */
  planStepId: PlanStepId
  /** The BuildListEntry whose selected compromise checkpoint is being finished. */
  buildListEntryId: BuildListEntryId
  /** The Entry's Target, as the user saw it. */
  targetWeaponId: TargetWeaponId
  /** The weapon the user saw as the compromise result. */
  ownedWeaponId: OwnedWeaponId
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  executionHistoryId: ExecutionHistoryId
  now: ISODateTimeString
}

/** Everything one `finished_as_compromise` transaction writes. */
export type CompromiseFinish = ExecutionStepWrite

function notApplicable(message: string): never {
  executionFailure('compromise_finish_not_applicable', message)
}

/**
 * The Plan's own compromise label projection for one Entry
 * (`docs/PLANNER_SPEC.md` 16.12): the single Step whose `executionEffects`
 * label the Entry's tracked weapon `practical`, plus that weapon's ID.
 *
 * It is the only authority for which weapon a compromise finish confirms. The
 * weapon is never found by searching for a `practical` status, by reading
 * `TargetWeapon.preferredOwnedWeaponId`, or by re-evaluating any weapon's
 * performance against the Target's compromise conditions.
 */
function requireCompromiseLabelStep(
  plan: ProductionPlan,
  entry: BuildListEntry,
): { step: PlanStep; ownedWeaponId: OwnedWeaponId } {
  const labelled = plan.steps.flatMap((step) =>
    (step.executionEffects?.compromiseLabels ?? [])
      .filter(({ buildListEntryId }) => buildListEntryId === entry.id)
      .map(({ ownedWeaponId }) => ({ step, ownedWeaponId })),
  )
  if (labelled.length === 0) {
    notApplicable(`ProductionPlan '${plan.id}' reaches no compromise checkpoint for BuildListEntry '${entry.id}'.`)
  }
  if (labelled.length > 1) {
    inconsistent(`ProductionPlan '${plan.id}' labels BuildListEntry '${entry.id}' as a compromise more than once.`)
  }
  return labelled[0]
}

/**
 * Whether the Entry's selected compromise checkpoint is held *right now*
 * (`docs/PLANNER_SPEC.md` 7.5.2 / 16.12).
 *
 * Having reached the checkpoint once is not enough. The offer sits beside
 * 「次の操作へ進む」 at the checkpoint, so choosing to continue and running the
 * next operation on that weapon leaves the compromise state behind and the
 * finish is no longer available.
 *
 * The answer comes from the Plan's own Execution projection and its Step
 * completion state, never from re-evaluating the weapon's Bonuses or Skills
 * against the Target's compromise conditions:
 *
 * - a checkpoint held at Plan start (7.5.2) is held until the Entry's first
 *   physical Step - the very Step that labels it - is confirmed
 * - an ordinary checkpoint is held from the confirmation of its labelling Step
 *   until a later Step that operates on the same tracked weapon is confirmed
 *
 * The boundary is the *tracked weapon*, not the Plan's overall progress:
 * confirming another Entry's Step on another weapon leaves this weapon, and so
 * this checkpoint, exactly where it was. Every current Execution operation that
 * names a tracked weapon changes that weapon's persisted state - a
 * production-target Normal registration, a conversion, the three amendments and
 * an owned Ideal confirmation alike - while a Counter-advance Normal creation
 * tracks no weapon at all, so matching on `trackedOwnedWeaponId` needs no
 * operation-type list that a later operation could make stale.
 */
function isCompromiseCheckpointStillCurrent(
  plan: ProductionPlan,
  entry: BuildListEntry,
  labelStep: PlanStep,
  ownedWeaponId: OwnedWeaponId,
): boolean {
  const heldAtRouteStart = isIntermediatePinHeldAtRouteStart(entry)
  if (!heldAtRouteStart && !labelStep.isCompleted) return false
  // A start-held checkpoint is held before its own labelling Step, so every
  // confirmed Step on the weapon leaves it; an ordinary one is left only by a
  // Step confirmed after the labelling Step.
  const boundary = heldAtRouteStart ? -1 : plan.steps.findIndex(({ id }) => id === labelStep.id)
  return !plan.steps.some(
    (step, index) =>
      index > boundary &&
      step.isCompleted &&
      step.executionEffects?.trackedOwnedWeaponId === ownedWeaponId,
  )
}

/** One selected compromise checkpoint the Plan's tracked weapon holds right now. */
export interface CurrentCompromiseCheckpoint {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
  /** The weapon the Plan's compromise label effect names; the only finish authority. */
  ownedWeaponId: OwnedWeaponId
  /** The Step whose `executionEffects.compromiseLabels` labels the weapon. */
  labelPlanStepId: PlanStepId
  /**
   * The checkpoint is held because the Entry started there (7.5.2) and its
   * labelling Step is not confirmed yet.
   */
  heldBeforeLabelStep: boolean
}

/**
 * Every selected compromise checkpoint that is the current state of its
 * tracked weapon (`docs/PLANNER_SPEC.md` 16.12), in `selectedBuildListEntryIds`
 * order.
 *
 * It reads exactly the authorities `prepareCompromiseFinish()` checks - the
 * Entry's `intermediateStateSelection`, the Plan's own compromise label
 * projection and the Plan Step completion state - through the same
 * still-current rule, so a presentation that offers "finish as compromise"
 * never offers a checkpoint the runtime would refuse as not current. An Entry
 * that no longer exists, selected nothing, or whose label projection is not
 * exactly one Step is simply not listed; the runtime stays the authority that
 * refuses such a request. It never re-evaluates weapon performance and does
 * not look at the Plan status: the caller decides where an offer applies.
 */
export function listCurrentCompromiseCheckpoints(
  plan: ProductionPlan,
  buildListEntries: readonly BuildListEntry[],
): CurrentCompromiseCheckpoint[] {
  const entries = new Map(buildListEntries.map((entry) => [entry.id, entry]))
  return plan.selectedBuildListEntryIds.flatMap((buildListEntryId) => {
    const entry = entries.get(buildListEntryId)
    if (entry === undefined || !hasIntermediateStateSelection(entry)) return []
    const labelled = plan.steps.flatMap((step) =>
      (step.executionEffects?.compromiseLabels ?? [])
        .filter((label) => label.buildListEntryId === entry.id)
        .map(({ ownedWeaponId }) => ({ step, ownedWeaponId })),
    )
    if (labelled.length !== 1) return []
    const [{ step, ownedWeaponId }] = labelled
    if (!isCompromiseCheckpointStillCurrent(plan, entry, step, ownedWeaponId)) return []
    return [{
      buildListEntryId: entry.id,
      targetWeaponId: entry.targetWeaponId,
      ownedWeaponId,
      labelPlanStepId: step.id,
      heldBeforeLabelStep: !step.isCompleted,
    }]
  })
}

/**
 * Decides one "この武器を妥協品として確定して終了" (`docs/PLANNER_SPEC.md` 16.12).
 *
 * It performs no game operation, so no Counter advances and no RNG prediction
 * runs. The tracked weapon becomes `practical` with its protection untouched,
 * every weapon in progress for this Plan stops being in progress (16.10.1),
 * the Target stays `active` and keeps its preferred owned weapon (16.11), the
 * Plan becomes `abandoned` with `finished_as_compromise`, and the Plan's game
 * save point is deleted (16.9). The `finished_as_compromise` ExecutionHistory
 * carries the Undo snapshot taken from the untouched state, and its `createdAt`
 * is the Plan's `abandonedAt`, so Undo recognises this record as the cause of
 * the terminal transition (16.16).
 *
 * It is refused unless the Plan is an executable `active` current Plan whose
 * current Step and persisted state are exactly what the user saw, and the named
 * Entry's *selected* compromise checkpoint is the weapon's current state. A
 * weapon that merely satisfies a compromise condition, an unselected state
 * reached by chance, and a checkpoint the Plan has already moved past all never
 * finish a Plan.
 */
export function prepareCompromiseFinish(input: CompromiseFinishInput): CompromiseFinish {
  const { plan, state, now } = input
  const { step } = requireExecutableCurrentStep(input)

  if (!plan.selectedBuildListEntryIds.includes(input.buildListEntryId)) {
    notApplicable(`BuildListEntry '${input.buildListEntryId}' is not a selected Entry of ProductionPlan '${plan.id}'.`)
  }
  const entry = state.buildListEntries.find(({ id }) => id === input.buildListEntryId)
  if (!entry) {
    notApplicable(`BuildListEntry '${input.buildListEntryId}' no longer exists.`)
  }
  if (entry.targetWeaponId !== input.targetWeaponId) {
    notApplicable(`BuildListEntry '${entry.id}' plans TargetWeapon '${entry.targetWeaponId}', not '${input.targetWeaponId}'.`)
  }
  if (!hasIntermediateStateSelection(entry)) {
    notApplicable(`BuildListEntry '${entry.id}' selected no intermediate state, so it has no compromise checkpoint to finish at.`)
  }
  const label = requireCompromiseLabelStep(plan, entry)
  if (label.ownedWeaponId !== input.ownedWeaponId) {
    notApplicable(
      `The compromise checkpoint of BuildListEntry '${entry.id}' is held by OwnedWeapon '${label.ownedWeaponId}', not '${input.ownedWeaponId}'.`,
    )
  }
  if (!isCompromiseCheckpointStillCurrent(plan, entry, label.step, label.ownedWeaponId)) {
    executionFailure(
      'compromise_checkpoint_not_current',
      `The selected compromise checkpoint of BuildListEntry '${entry.id}' is not the current state: it is either not reached yet or already left behind.`,
    )
  }

  const mutable = createMutableExecutionState(state)
  const target = requireTarget(mutable, entry.targetWeaponId, step.id)
  if (target.lifecycleStatus !== 'active') {
    inconsistent(`TargetWeapon '${target.id}' is '${target.lifecycleStatus}', so it cannot be finished as a compromise.`)
  }
  const weapon = requireWeapon(mutable, label.ownedWeaponId, step.id)
  if (weapon.kind !== 'gogma') {
    inconsistent(`The compromise result '${weapon.id}' is not a Gogma Artian weapon.`)
  }
  // 16.12: only the status label. The five slots, scope, Skills, kind and
  // `isProtected` stay exactly as they are - finishing as a compromise is not
  // a protection.
  if (weapon.status !== 'practical') {
    mutable.weapons.set(weapon.id, { ...weapon, status: 'practical', updatedAt: now })
  }
  // 16.2 / 16.10.1: the Plan ends here, so no weapon stays in progress for it.
  // A weapon in progress for another Plan is never touched.
  mutable.weapons.forEach((inProgress) => {
    if (inProgress.executionInProgress?.productionPlanId !== plan.id) return
    mutable.weapons.set(inProgress.id, { ...inProgress, executionInProgress: null, updatedAt: now })
  })

  // The Target stays `active` and keeps its preference, and the remaining Steps
  // stay incomplete: the Plan records where it stopped.
  const nextPlan: ProductionPlan = {
    ...structuredClone(plan),
    status: 'abandoned',
    abandonmentReason: 'finished_as_compromise',
    abandonedAt: now,
    completedAt: null,
    updatedAt: now,
  }

  const changes = collectEntityChanges(state, mutable)
  assertStepResultValid(changes, nextPlan)
  const stillInProgress = changes.nextWeapons.find(
    ({ executionInProgress }) => executionInProgress?.productionPlanId === plan.id,
  )
  if (stillInProgress !== undefined) {
    inconsistent(`OwnedWeapon '${stillInProgress.id}' is still in progress for the finished ProductionPlan '${plan.id}'.`)
  }
  const finished = changes.nextWeapons.find(({ id }) => id === weapon.id)
  if (finished === undefined || finished.status !== 'practical') {
    inconsistent(`OwnedWeapon '${weapon.id}' is not the Practical compromise result after the finish.`)
  }

  const history: ExecutionHistory = {
    id: input.executionHistoryId,
    planId: plan.id,
    planStepId: step.id,
    action: 'finished_as_compromise',
    actualResult: null,
    // An explicit user decision, not a divergence: the Plan becomes
    // `abandoned`, never `stale`, so it records no recalculation reason.
    wasExpected: true,
    recalculationReason: null,
    undoSnapshot: createExecutionUndoSnapshot(plan, state, changes),
    createdAt: now,
  }
  assertExecutionHistoryValid(history)

  return {
    rngState: null,
    normalCounters: [],
    ownedWeapons: changes.changedWeapons,
    targetWeapons: changes.changedTargets,
    plan: nextPlan,
    history,
    deletesExecutionSavePoint: state.executionSavePoint !== null,
  }
}
