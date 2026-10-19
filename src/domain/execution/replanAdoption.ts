import type {
  BuildListEntry,
  CalculationContext,
  ISODateTimeString,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
  TargetWeapon,
} from '../models/publicTypes'
import { collectReferencedOwnedWeaponIds } from '../models/hashing'
import {
  isCalculationContextCompatible,
  validateOwnedWeapon,
  validateProductionPlan,
} from '../models/publicTypes'
import type { PlannerInput, PlannerResult } from '../planner/plannerTypes'
import {
  checkPersistableOrdinaryPlannerResultShape,
  checkProductionPlanBuildListEntryReferences,
  checkRejectedBuildListEntryTargets,
  type PlannerResultPersistenceIssue,
} from '../planner/plannerResultPersistenceValidation'
import {
  collectProductionPlanDependentTargetWeaponIds,
  createDependentBuildListEntriesHash,
  createDependentTargetDefinitionsHash,
} from '../planner/productionPlanGeneration'
import { validateTargetPreferredOwnedWeapons } from '../target/preferredOwnedWeapon'
import { executionFailure } from './executionRuntimeError'
import {
  prepareExecutionSavePointRestore,
  type ExecutionSavePointRestoreWrite,
} from './executionSavePoint'
import {
  assertRunningPlanSavePointDecision,
  deriveRunningPlanSavePointChoiceRequirement,
  type PlanAbandonSavePointDecision,
  type RunningProductionPlanStatus,
} from './planAbandonment'
import {
  createActualExecutionState,
  executionStateMatches,
  type ExecutionPersistedState,
} from './planExecutionState'
import { prepareProductionPlanStart } from './productionPlanStart'
import { inconsistent } from './stepExecution'

/**
 * The running Plan as it was when the replan Preview started
 * (`docs/PLANNER_SPEC.md` 16.8). Adoption re-checks exactly these three values:
 * the Plan, its status and its current Step. `updatedAt` is deliberately not
 * part of it, so a change the specification does not name never refuses the
 * adoption.
 */
export interface ReplanRunningPlanToken {
  planId: ProductionPlanId
  status: RunningProductionPlanStatus
  currentStepId: PlanStepId | null
}

/**
 * What the Application hands to the existing Planner Worker for a replan
 * Preview: the token of the running Plan and a PlannerInput built from the
 * current confirmed persisted state by the ordinary `createPlannerInput()`.
 * The running Plan itself - its `baseSnapshot`, past PlannerInput, Conflict
 * resolutions and repair lineage - is never part of the PlannerInput, so the
 * input carries no conflict resolution and the Preview is one ordinary
 * current-state Planner run (`PlannerWorkerClient.createPlan()`, Phase 6-A).
 */
export interface ProductionPlanReplanPreviewRequest {
  runningPlanToken: ReplanRunningPlanToken
  plannerInput: PlannerInput
  calculationContext: CalculationContext
}

/**
 * A transient replan Preview: the running Plan token, the ordinary Planner
 * result and the CalculationContext the Preview was calculated under. It is
 * plain structured-clone data that lives only in memory; it is never
 * persisted, exported, or stored in Dexie. An ordinary run generates no
 * BuildListEntry and replaces none, so adopting the Preview never changes the
 * Build List.
 */
export interface ProductionPlanReplanPreview {
  runningPlanToken: ReplanRunningPlanToken
  result: PlannerResult
  calculationContext: CalculationContext
}

/** Why a replan Preview can never be adopted, whatever the persisted state is. */
export type ProductionPlanReplanPreviewAdoptability =
  | { adoptable: true; plan: ProductionPlan }
  | { adoptable: false; reason: 'no_plan' | 'incomplete_search' | 'invalid_result'; message: string }

/**
 * The running-Plan token of a replan Preview. Only an `active` or `stale` Plan
 * can be replanned; starting a Preview changes nothing.
 */
export function createReplanRunningPlanToken(plan: ProductionPlan): ReplanRunningPlanToken {
  if (plan.status !== 'active' && plan.status !== 'stale') {
    executionFailure(
      'replan_preview_not_allowed',
      `ProductionPlan '${plan.id}' is '${plan.status}'; only an active or stale Plan can be replanned from the current state.`,
    )
  }
  return { planId: plan.id, status: plan.status, currentStepId: plan.currentStepId }
}

/** Bundles the Planner Worker result with its Preview request, as plain data. */
export function createProductionPlanReplanPreview(
  request: ProductionPlanReplanPreviewRequest,
  result: PlannerResult,
): ProductionPlanReplanPreview {
  return structuredClone({
    runningPlanToken: request.runningPlanToken,
    result,
    calculationContext: request.calculationContext,
  })
}

function issueMessage(issue: PlannerResultPersistenceIssue): string {
  return issue.kind === 'entity_invalid' ? `${issue.entityName} failed Domain validation.` : issue.message
}

/**
 * Whether the Preview's Planner result could ever become the running Plan: the
 * search was not truncated, a Plan exists, and the result passes the same
 * shape checks the ordinary Planner result save applies
 * (`checkPersistableOrdinaryPlannerResultShape()`: a draft, no repair lineage,
 * a Domain-valid Plan).
 *
 * The typed termination is judged first (`docs/PLANNER_SPEC.md` 7.2.1,
 * `docs/UI_FLOW.md` 10.1): an `incomplete` search is a partial Planner run
 * artifact whether or not it carries a partial Plan, never a finished no-Plan
 * result. Only a search that ended on its own with no Plan is the ordinary
 * `no_plan`. A no-Plan Preview is a valid Preview to show, never one to adopt.
 */
export function describeReplanPreviewAdoptability(
  preview: ProductionPlanReplanPreview,
): ProductionPlanReplanPreviewAdoptability {
  const { plan, termination } = preview.result
  if (termination.status === 'incomplete') {
    return {
      adoptable: false,
      reason: 'incomplete_search',
      message: 'The replan Preview search was truncated by a Planner bound and holds no finished ProductionPlan.',
    }
  }
  if (plan === null) {
    return { adoptable: false, reason: 'no_plan', message: 'The replan Preview has no ProductionPlan to adopt.' }
  }
  // `incomplete` was classified above, so every remaining shape or Domain
  // validation issue is an invalid result.
  const issue = checkPersistableOrdinaryPlannerResultShape(plan, termination)
  if (issue !== null) {
    return { adoptable: false, reason: 'invalid_result', message: issueMessage(issue) }
  }
  return { adoptable: true, plan }
}

function requireAdoptablePlan(preview: ProductionPlanReplanPreview): ProductionPlan {
  const adoptability = describeReplanPreviewAdoptability(preview)
  if (adoptability.adoptable) return adoptability.plan
  const { plan, termination } = preview.result
  const issue = plan === null ? null : checkPersistableOrdinaryPlannerResultShape(plan, termination)
  executionFailure(
    'replan_result_invalid',
    adoptability.message,
    issue?.kind === 'entity_invalid' ? issue.validation.issues : [],
  )
}

/**
 * The running Plan must still be exactly the one the Preview started from
 * (16.8): same Plan, same status, same current Step.
 */
function assertRunningPlanTokenHolds(plan: ProductionPlan, token: ReplanRunningPlanToken): void {
  if (
    plan.id !== token.planId ||
    plan.status !== token.status ||
    plan.currentStepId !== token.currentStepId
  ) {
    executionFailure(
      'replan_state_changed',
      `ProductionPlan '${plan.id}' is now '${plan.status}' at Step '${plan.currentStepId}', not '${token.status}' at Step '${token.currentStepId}' as when the replan Preview started; preview again from the current state.`,
    )
  }
}

type ReplanAdoptionReadState = Pick<
  ExecutionPersistedState,
  'ownedWeapons' | 'targetWeapons' | 'buildListEntries' | 'planExecutionHistory' | 'executionSavePoint'
>

/**
 * What the replan adoption confirmation must show (`docs/UI_FLOW.md` 16.4):
 * the running Plan the Preview replaces, the new Plan, and whether the 16.10
 * save point choice is asked. It is advisory only: the adoption re-derives
 * everything inside its own transaction.
 */
export type ProductionPlanReplanAdoptionOptions = {
  runningPlanId: ProductionPlanId
  runningPlanStatus: RunningProductionPlanStatus
  runningPlanCurrentStepId: PlanStepId | null
  newPlanId: ProductionPlanId
} & (
  | { savePointChoiceRequired: false }
  | {
      savePointChoiceRequired: true
      savePointRecordedAt: ISODateTimeString
      savePointLastExecutionHistoryId: ExecutionSavePointRestoreWrite['savePoint']['lastExecutionHistoryId']
      /** The running Plan's current Step when the save point was recorded. */
      savePointCurrentStepId: PlanStepId | null
    }
)

/**
 * Reads what adopting the Preview would ask. It refuses a Preview that can
 * never be adopted or whose running Plan already moved on, and changes nothing.
 */
export function inspectProductionPlanReplanAdoption(
  preview: ProductionPlanReplanPreview,
  runningPlan: ProductionPlan,
  state: Pick<ReplanAdoptionReadState, 'planExecutionHistory' | 'executionSavePoint'>,
): ProductionPlanReplanAdoptionOptions {
  assertRunningPlanTokenHolds(runningPlan, preview.runningPlanToken)
  const newPlan = requireAdoptablePlan(preview)
  const base = {
    runningPlanId: runningPlan.id,
    runningPlanStatus: preview.runningPlanToken.status,
    runningPlanCurrentStepId: runningPlan.currentStepId,
    newPlanId: newPlan.id,
  }
  const choice = deriveRunningPlanSavePointChoiceRequirement(
    runningPlan,
    state.executionSavePoint,
    state.planExecutionHistory,
  )
  if (!choice.required) return { ...base, savePointChoiceRequired: false }
  return {
    ...base,
    savePointChoiceRequired: true,
    savePointRecordedAt: choice.savePoint.recordedAt,
    savePointLastExecutionHistoryId: choice.savePoint.lastExecutionHistoryId,
    savePointCurrentStepId: choice.savePoint.productionPlan.currentStepId,
  }
}

export interface ProductionPlanReplanAdoptionInput {
  preview: ProductionPlanReplanPreview
  /** The current persisted Plan named by the Preview token. */
  runningPlan: ProductionPlan
  savePointDecision: PlanAbandonSavePointDecision
  state: ReplanAdoptionReadState &
    Pick<ExecutionPersistedState, 'rngState' | 'normalCounters'> & {
      /** Every persisted Plan whose status is `active` or `stale`. */
      runningPlans: readonly ProductionPlan[]
      /** Whether a ProductionPlan with the Preview's new Plan ID is already persisted. */
      newPlanIdPersisted: boolean
    }
  currentCalculationContext: CalculationContext
  now: ISODateTimeString
}

/**
 * Everything one replan adoption writes (`docs/DATA_MODEL.md` 14.4), decided
 * and validated before a single write happens.
 *
 * - `save_point_restored`: the user chose 「最後のゲーム内セーブ地点へ戻す」.
 *   Only the save point restore is written; the Preview is not adopted, the
 *   running Plan is not abandoned, nothing of the Preview is persisted, and a
 *   new Preview from the restored state is required (16.8 / 16.10).
 * - `adopted`: the running Plan becomes `abandoned` (`replan_adopted`), the new
 *   Plan becomes `active`, in-progress marks are moved or cleared, and the
 *   running Plan's save point is deleted. The Build List is not written: the
 *   ordinary replan run generates and replaces no Entry, so the current Build
 *   List is the new Plan's Build List as it is (Phase 6-A).
 */
export type ProductionPlanReplanAdoptionWrite =
  | { kind: 'save_point_restored'; restore: ExecutionSavePointRestoreWrite }
  | {
      kind: 'adopted'
      savePointHandling: 'no_choice' | 'keep_current'
      /** The abandoned running Plan. */
      oldPlan: ProductionPlan
      /** The new Plan, started. It is added, never put over an existing Plan. */
      newPlan: ProductionPlan
      /** Weapons whose in-progress mark moved to the new Plan or was cleared. */
      ownedWeapons: OwnedWeapon[]
      /** Targets the new Plan's start effect changed (16.11). */
      targetWeapons: TargetWeapon[]
      deletesExecutionSavePoint: boolean
    }

function replanStateChanged(message: string): never {
  executionFailure('replan_state_changed', `${message} Preview again from the current state.`)
}

function throwAdoptionIssue(issue: PlannerResultPersistenceIssue | null): void {
  if (issue === null) return
  if (issue.kind === 'state_changed') replanStateChanged(issue.message)
  executionFailure(
    'replan_result_invalid',
    issueMessage(issue),
    issue.kind === 'entity_invalid' ? issue.validation.issues : [],
  )
}

/**
 * Decides one 「この再計画を採用」 (`docs/PLANNER_SPEC.md` 16.8 / 16.10).
 *
 * Refused unless the running Plan's status and current Step are still what the
 * Preview started from, the Preview holds an adoptable Plan, and the save point
 * decision answers the 16.10 choice re-derived here. Restoring the save point
 * ends the adoption there. Otherwise the adoption re-verifies, against the
 * current persisted state, what the new Plan was calculated from: the
 * RNG / Normal Counter / OwnedWeapon / Plan-dependent Target execution state
 * (`initialExecutionState`), the new Plan's dependent Target definitions and
 * dependent Entries over the current Build List, and the CalculationContext.
 * Targets and Entries the new Plan does
 * not depend on never refuse it, because the whole-input audit hashes are not
 * adoption authority. The new Plan is then started through the ordinary Plan
 * start authority, with the running Plan already treated as abandoned.
 */
export function prepareProductionPlanReplanAdoption(
  input: ProductionPlanReplanAdoptionInput,
): ProductionPlanReplanAdoptionWrite {
  const { preview, runningPlan, savePointDecision, state, now } = input
  assertRunningPlanTokenHolds(runningPlan, preview.runningPlanToken)
  const newPlan = requireAdoptablePlan(preview)

  const choice = deriveRunningPlanSavePointChoiceRequirement(
    runningPlan,
    state.executionSavePoint,
    state.planExecutionHistory,
  )
  assertRunningPlanSavePointDecision(runningPlan, choice, savePointDecision)
  if (savePointDecision?.kind === 'restore_save_point') {
    // 16.8: returning to the save point ends the adoption. The restore
    // contract applies as it is, with every refusal before any write, and
    // nothing of the Preview is used afterwards.
    return {
      kind: 'save_point_restored',
      restore: prepareExecutionSavePointRestore({
        plan: runningPlan,
        recordedAt: savePointDecision.recordedAt,
        state,
        currentCalculationContext: input.currentCalculationContext,
      }),
    }
  }

  const buildListEntries = assertPreviewStateHolds(input, newPlan)

  // The ordinary Plan start authority, over the post-state in which the
  // running Plan is already abandoned: any other running Plan still refuses.
  // Its start effect links the new Plan's existing weapons (16.11).
  const start = prepareProductionPlanStart({
    plan: newPlan,
    runningPlans: state.runningPlans.filter(({ id }) => id !== runningPlan.id),
    state: {
      rngState: state.rngState,
      normalCounters: state.normalCounters,
      ownedWeapons: state.ownedWeapons,
      targetWeapons: state.targetWeapons,
      buildListEntries,
      // The new Plan has not executed anything, so no observation binding applies.
      planExecutionHistory: [],
      executionSavePoint: null,
    },
    currentCalculationContext: input.currentCalculationContext,
    now,
  })
  const startedPlan = start.plan

  const oldPlan: ProductionPlan = {
    // `currentStepId`, every Step completion and `recalculationReasons` stay:
    // the Plan records where it stopped, and a stale reason survives (16.2).
    ...structuredClone(runningPlan),
    status: 'abandoned',
    abandonmentReason: 'replan_adopted',
    abandonedAt: now,
    completedAt: null,
    updatedAt: now,
  }

  const trackedByNewPlan = collectNewPlanTrackedOwnedWeaponIds(startedPlan, buildListEntries, state.ownedWeapons)
  const ownedWeapons = state.ownedWeapons.flatMap((weapon): OwnedWeapon[] => {
    const inProgress = weapon.executionInProgress
    if (inProgress?.productionPlanId !== runningPlan.id) return []
    return [{
      ...structuredClone(weapon),
      // The physical production that started under the running Plan goes on
      // under the new Plan, so its start time is kept (16.10.1).
      executionInProgress: trackedByNewPlan.has(weapon.id)
        ? { productionPlanId: startedPlan.id, startedAt: inProgress.startedAt }
        : null,
      updatedAt: now,
    }]
  })

  assertAdoptedStateValid(oldPlan, startedPlan, ownedWeapons, start.targetWeapons, input)
  return {
    kind: 'adopted',
    savePointHandling: savePointDecision === null ? 'no_choice' : 'keep_current',
    oldPlan,
    newPlan: startedPlan,
    ownedWeapons,
    targetWeapons: start.targetWeapons,
    deletesExecutionSavePoint: state.executionSavePoint !== null,
  }
}

/**
 * 16.8 adoption re-verification of what the Preview calculated from. Every
 * difference refuses with `replan_state_changed`, except an ID collision of the
 * new Plan and broken references of the result itself.
 *
 * Every check reads the current persisted Build List as it is - the Build
 * List the new Plan will run against, because the ordinary replan run
 * generates and replaces no Entry. Returns it.
 */
function assertPreviewStateHolds(
  input: ProductionPlanReplanAdoptionInput,
  newPlan: ProductionPlan,
): readonly BuildListEntry[] {
  const { preview, runningPlan, state, currentCalculationContext } = input
  if (
    !isCalculationContextCompatible(currentCalculationContext, preview.calculationContext) ||
    !isCalculationContextCompatible(currentCalculationContext, newPlan.calculationContext) ||
    !isCalculationContextCompatible(currentCalculationContext, newPlan.baseSnapshot.calculationContext)
  ) {
    replanStateChanged('The current CalculationContext is no longer compatible with the replan Preview.')
  }
  if (newPlan.id === runningPlan.id || state.newPlanIdPersisted) {
    executionFailure(
      'replan_plan_id_collision',
      `ProductionPlan '${newPlan.id}' already exists; a replan Preview never overwrites a persisted Plan.`,
    )
  }
  const { buildListEntries } = state
  const missingEntry = newPlan.selectedBuildListEntryIds.find(
    (id) => !buildListEntries.some((entry) => entry.id === id),
  )
  if (missingEntry !== undefined) {
    replanStateChanged(`BuildListEntry '${missingEntry}' the new Plan depends on no longer exists.`)
  }
  if (
    createDependentBuildListEntriesHash(buildListEntries, newPlan.selectedBuildListEntryIds) !==
    newPlan.baseSnapshot.dependentBuildListEntriesHash
  ) {
    replanStateChanged('A BuildListEntry the new Plan depends on changed after the replan Preview.')
  }
  const dependentTargetIds = collectProductionPlanDependentTargetWeaponIds(newPlan, buildListEntries)
  if (
    createDependentTargetDefinitionsHash([...state.targetWeapons], dependentTargetIds) !==
    newPlan.baseSnapshot.dependentTargetDefinitionsHash
  ) {
    replanStateChanged('A Target definition, priority or enablement the new Plan depends on changed after the replan Preview.')
  }
  const actual = createActualExecutionState(newPlan, state, [])
  if (!executionStateMatches(actual, newPlan.baseSnapshot.initialExecutionState)) {
    replanStateChanged(
      'The current RNG, Normal Counter, OwnedWeapon or Plan-dependent Target state differs from the state the replan Preview was calculated from.',
    )
  }
  throwAdoptionIssue(checkProductionPlanBuildListEntryReferences(newPlan, buildListEntries))
  // No save changes the Target of an existing Entry (a replacement adds a new
  // Entry), so each rejected Entry still in the Build List carries the Target
  // the Preview's Plan generation copied (DATA_MODEL 11.9).
  throwAdoptionIssue(checkRejectedBuildListEntryTargets(newPlan, buildListEntries))
  return buildListEntries
}

/**
 * The currently existing OwnedWeapons the new Plan keeps tracking: the weapons
 * the Routes of its selected BuildListEntries reference (16.8 / 16.10.1). A
 * weapon the new Plan would only register later is not an existing weapon and
 * is never tracked here.
 */
function collectNewPlanTrackedOwnedWeaponIds(
  newPlan: ProductionPlan,
  finalEntries: readonly BuildListEntry[],
  ownedWeapons: readonly OwnedWeapon[],
): Set<OwnedWeaponId> {
  const existing = new Set(ownedWeapons.map(({ id }) => id))
  const selected = new Set(newPlan.selectedBuildListEntryIds)
  return new Set(
    finalEntries
      .filter(({ id }) => selected.has(id))
      .flatMap((entry) => collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route))
      .filter((id) => existing.has(id)),
  )
}

/**
 * The adopted state validated before any write: both Plans, every changed
 * weapon, the Target preference collection over the next weapons and the
 * Targets the new Plan's start effect changed, and no weapon left in progress
 * for the abandoned Plan.
 */
function assertAdoptedStateValid(
  oldPlan: ProductionPlan,
  newPlan: ProductionPlan,
  changedWeapons: readonly OwnedWeapon[],
  changedTargets: readonly TargetWeapon[],
  input: ProductionPlanReplanAdoptionInput,
): void {
  for (const plan of [oldPlan, newPlan]) {
    const validation = validateProductionPlan(plan)
    if (!validation.isValid) {
      executionFailure('entity_validation_failed', `ProductionPlan '${plan.id}' fails Domain validation after the replan adoption.`, validation.issues)
    }
  }
  for (const weapon of changedWeapons) {
    const validation = validateOwnedWeapon(weapon)
    if (!validation.isValid) {
      executionFailure('entity_validation_failed', `OwnedWeapon '${weapon.id}' fails Domain validation after the replan adoption.`, validation.issues)
    }
  }
  const changedById = new Map(changedWeapons.map((weapon) => [weapon.id, weapon]))
  const nextWeapons = input.state.ownedWeapons.map((weapon) => changedById.get(weapon.id) ?? weapon)
  const targetById = new Map(changedTargets.map((target) => [target.id, target]))
  const nextTargets = input.state.targetWeapons.map((target) => targetById.get(target.id) ?? target)
  const preferences = validateTargetPreferredOwnedWeapons(nextTargets, nextWeapons)
  if (!preferences.isValid) {
    executionFailure('collection_validation_failed', 'The Target preferred owned weapon collection is invalid after the replan adoption.', preferences.issues)
  }
  const stillInProgress = nextWeapons.find(({ executionInProgress }) => executionInProgress?.productionPlanId === oldPlan.id)
  if (stillInProgress !== undefined) {
    inconsistent(`OwnedWeapon '${stillInProgress.id}' is still in progress for the abandoned ProductionPlan '${oldPlan.id}'.`)
  }
}
