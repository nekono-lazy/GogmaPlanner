import { validateBuildListCardinality } from '../buildList/buildListCardinality'
import type { BuildListEntryAddition, BuildListEntryReplacement } from '../buildList/buildListEntryReplacement'
import { validateBuildListEntryReplacementMetadata } from '../buildList/buildListEntryReplacement'
import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  ISODateTimeString,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { isCalculationContextCompatible, isTargetWeaponPlanningEligible, validateBuildListEntry } from '../models/publicTypes'
import { checkBuildListOptimizationPhysicalIdentity } from '../planner/buildListOptimization/buildListOptimizationAdoption'
import {
  checkGeneratedBuildListEntriesFresh,
  checkPersistableOrdinaryPlannerResultShape,
  checkPlannerRunTerminationPersistable,
  checkProductionPlanBuildListEntryReferences,
  checkRejectedBuildListEntryTargets,
  type PlannerResultPersistenceIssue,
} from '../planner/plannerResultPersistenceValidation'
import { inspectProductionPlanCompletionAssignmentSafety } from '../planner/productionPlanCompletionAssignmentSafety'
import { collectProductionPlanTargetCompletionTargetWeaponIds } from '../planner/productionPlanCompletionSummary'
import {
  collectProductionPlanDependentTargetWeaponIds,
  createDependentBuildListEntriesHash,
  createDependentTargetDefinitionsHash,
  createPlanningBuildListEntriesHash,
} from '../planner/productionPlanGeneration'
import { executionFailure } from './executionRuntimeError'
import { prepareExecutionSavePointRestore, type ExecutionSavePointRestoreWrite } from './executionSavePoint'
import {
  assertRunningPlanSavePointDecision,
  deriveRunningPlanSavePointChoiceRequirement,
  runningPlanSavePointChoiceOptions,
  type PlanAbandonSavePointDecision,
  type RunningPlanSavePointChoiceOptions,
  type RunningProductionPlanStatus,
} from './planAbandonment'
import { createActualExecutionState, executionStateMatches, type ExecutionPersistedState } from './planExecutionState'
import { prepareProductionPlanStart } from './productionPlanStart'
import {
  assertReplanAdoptedStateValid,
  assertReplanRunningPlanTokenHolds,
  replanAdoptedRunningPlan,
  throwReplanAdoptionIssue,
  transferReplanInProgressWeapons,
  type ReplanRunningPlanToken,
} from './replanAdoption'
import type { RunningPlanReplanOptimizationArtifact } from './runningPlanReplanOptimization'
import {
  deriveRunningPlanReplanBuildListAfterAdoption,
  deriveRunningPlanReplanStartTargetLinkChanges,
  type RunningPlanReplanStartTargetLinkChange,
} from './runningPlanReplanPreview'
import {
  deriveRunningPlanReplanAvailability,
  replanTargetWeaponIdsOf,
  type ReplanTargetClassification,
} from './runningPlanReplanTargets'
import { inconsistent } from './stepExecution'

/**
 * The adoption of a running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.8, Issue #276 PR-5): the pure decision of
 * 「この再計画を採用」 over the runtime-only Preview of PR-4, against the persisted state the Application read inside its one read-write
 * transaction.
 *
 *   [P1] the Preview's own persistability, read from its typed fields only (`checkPersistableRunningPlanReplanPreview()`)
 *   [T]  the current state re-read and re-verified: the old Plan's token and the one-running-Plan invariant, the 18.5 per-old-Plan
 *        availability (PR-2's authority), the 16.10 save point choice, the CalculationContext, the replan Targets and their planning
 *        definitions, the scope Entries, the Build List after the adoption over the whole current Build List (PR-4's authority),
 *        the new Plan ID, the new Plan's references, dependent hashes and initial execution state, the generated Entries' freshness
 *        recomputed from the current state, and the Plan start effect's preference changes re-derived and compared with the ones the
 *        Preview showed
 *   [W]  everything one adoption writes, decided and validated before a single write happens
 *
 * Nothing is written here and nothing is predicted, planned or searched. Every refusal throws an `ExecutionRuntimeError` with an
 * existing code (R8 decided at PR-5: no replan-specific code is added) - `replan_result_invalid` for a Preview that can never be
 * adopted, `replan_state_changed` for a state that moved after the calculation started (the token, the availability, the Targets,
 * the scope Entries, an ID collision with an Entry outside the scope, the execution state, the CalculationContext, a stale generated
 * Entry, a different start effect), `replan_plan_id_collision`, `running_plan_invariant_violated`, the 16.10 decision codes and the
 * save point restore's own codes, and `entity_validation_failed` / `collection_validation_failed` / `execution_effect_inconsistent`
 * for an adopted state that fails validation. The caller drops the Preview and asks for a new calculation; nothing re-calculates or
 * re-adopts by itself, and nothing falls back to the ordinary Planner.
 *
 * It is a separate adoption beside the 16.8 one (`prepareProductionPlanReplanAdoption()`), whose meaning is unchanged: the two share
 * the token check, the old Plan's ending, the in-progress transfer and the adopted-state validation (`replanAdoption.ts`), never a
 * mode flag. It does not go through `PlanBreakingChangeGuard`: the old Plan's ending (`replan_adopted`) and the Entry replacement are
 * written by the same transaction, so no `breaking_change_approved` is asked (18.8).
 *
 * Not re-exported by `src/domain/execution/index.ts`, like the calculation and Preview modules whose Entry change authority it reads:
 * its caller (the Execution runtime service) imports this module path.
 */

/**
 * The runtime-only Preview fields the adoption reads (`RunningPlanReplanPreview` of the Application is one): the old Plan's token taken
 * when the calculation's start was read, PR-2's classification of that start, the calculation's `optimized` artifact and the Plan start
 * effect's preference changes the Preview showed (18.7).
 */
export interface RunningPlanReplanAdoptionPreview {
  runningPlanToken: ReplanRunningPlanToken
  replanTargets: ReplanTargetClassification
  artifact: RunningPlanReplanOptimizationArtifact
  startTargetLinkChanges: readonly RunningPlanReplanStartTargetLinkChange[]
}

/** The persisted state one adoption reads inside its transaction. */
export type RunningPlanReplanAdoptionReadState = ExecutionPersistedState & {
  /** Every persisted Plan whose status is `active` or `stale`. */
  runningPlans: readonly ProductionPlan[]
  /** Whether a ProductionPlan with the Preview's new Plan ID is already persisted. */
  newPlanIdPersisted: boolean
}

export interface RunningPlanReplanAdoptionInput {
  preview: RunningPlanReplanAdoptionPreview
  /** The current persisted Plan the Preview token names. */
  runningPlan: ProductionPlan
  /** `null` when no save point choice was offered; otherwise the user's 16.10 choice naming the save point they saw. */
  savePointDecision: PlanAbandonSavePointDecision
  state: RunningPlanReplanAdoptionReadState
  currentCalculationContext: CalculationContext
  now: ISODateTimeString
}

/** [P1]: the artifact parts the adoption persists, once its shape passed. */
export interface PersistableRunningPlanReplanAdoption {
  plan: ProductionPlan
  generatedEntries: readonly BuildListEntry[]
  replacements: readonly BuildListEntryReplacement[]
  additions: readonly BuildListEntryAddition[]
}

export type RunningPlanReplanAdoptionShapeResult =
  | { issue: null; adoption: PersistableRunningPlanReplanAdoption }
  | { issue: PlannerResultPersistenceIssue; adoption: null }

function resultInvalid(message: string): PlannerResultPersistenceIssue {
  return { kind: 'result_invalid', message }
}

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function duplicatesOf(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort(compareIds)
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort(compareIds)
  const sortedRight = [...right].sort(compareIds)
  return sortedLeft.length === sortedRight.length && sortedLeft.every((id, index) => id === sortedRight[index])
}

/** The issue of the Preview's replan target set against its own classification and token (state-independent), or null. */
function replanTargetSetIssue(preview: RunningPlanReplanAdoptionPreview): PlannerResultPersistenceIssue | null {
  const { artifact, replanTargets, runningPlanToken } = preview
  if (artifact.planId !== runningPlanToken.planId || replanTargets.planId !== runningPlanToken.planId) {
    return resultInvalid(`The replan artifact (Plan '${artifact.planId}') and its classification (Plan '${replanTargets.planId}') are not of the old Plan '${runningPlanToken.planId}' the Preview's token names.`)
  }
  const ids = artifact.replanTargetWeaponIds as string[]
  const classified = [...replanTargetWeaponIdsOf(replanTargets, 'continuing'), ...replanTargetWeaponIdsOf(replanTargets, 'added')] as string[]
  const declared = replanTargets.replanTargetWeaponIds as readonly string[]
  if (ids.length === 0 || duplicatesOf(ids).length > 0) {
    return resultInvalid('The replan artifact must name each replan Target exactly once, and at least one.')
  }
  if (ids.length !== classified.length || ids.some((id, index) => id !== classified[index] || id !== declared[index]) || declared.length !== ids.length) {
    return resultInvalid(`The replan artifact's target set [${ids.join(', ')}] is not its classification's continuing then added Targets [${classified.join(', ')}].`)
  }
  return null
}

/** The partition of the replan target set into replaced / added / unchanged Targets, and the generated Entries' pairing (state-independent). */
function entryChangeRecordIssue(artifact: RunningPlanReplanOptimizationArtifact, plan: ProductionPlan): PlannerResultPersistenceIssue | null {
  const replanIds = new Set<string>(artifact.replanTargetWeaponIds)
  const partition = [
    ...artifact.replacements.map(({ targetWeaponId }) => targetWeaponId as string),
    ...artifact.additions.map(({ targetWeaponId }) => targetWeaponId as string),
    ...artifact.unchangedTargetWeaponIds.map((id) => id as string),
  ]
  if (duplicatesOf(partition).length > 0 || partition.some((id) => !replanIds.has(id)) || partition.length !== replanIds.size) {
    return resultInvalid('Every replan Target must be exactly one of replaced, added or unchanged, and no other Target may be named.')
  }
  const metadata = validateBuildListEntryReplacementMetadata(artifact.replacements)
  if (!metadata.isValid) {
    return resultInvalid(`The replan's Entry replacements are malformed: ${metadata.issues.map(({ message }) => message).join(' ')}`)
  }
  const generatedById = new Map(artifact.generatedBuildListEntries.map((entry) => [entry.id as string, entry]))
  const paired = [
    ...artifact.replacements.map(({ targetWeaponId, generatedBuildListEntryId }) => ({ targetWeaponId, id: generatedBuildListEntryId as string })),
    ...artifact.additions.map(({ targetWeaponId, generatedBuildListEntryId }) => ({ targetWeaponId, id: generatedBuildListEntryId as string })),
  ]
  const unpaired = paired.find(({ targetWeaponId, id }) => generatedById.get(id)?.targetWeaponId !== targetWeaponId)
  if (unpaired !== undefined) {
    return resultInvalid(`The replaced or added Entry '${unpaired.id}' is no generated Entry of Target '${unpaired.targetWeaponId}'.`)
  }
  if (paired.length !== generatedById.size || duplicatesOf(paired.map(({ id }) => id)).length > 0) {
    return resultInvalid('The generated Entries are not exactly the replacing and added Entries, once each.')
  }
  const selected = new Set<string>(plan.selectedBuildListEntryIds)
  const unselected = paired.find(({ id }) => !selected.has(id))
  if (unselected !== undefined) {
    return resultInvalid(`The generated BuildListEntry '${unselected.id}' is not selected by the new Plan.`)
  }
  const selectedReplaced = artifact.replacements.find(({ replacedBuildListEntryId }) => selected.has(replacedBuildListEntryId))
  if (selectedReplaced !== undefined) {
    return resultInvalid(`The new Plan selects the replaced BuildListEntry '${selectedReplaced.replacedBuildListEntryId}'.`)
  }
  return null
}

/**
 * [P1] of the adoption (`docs/PLANNER_SPEC.md` 18.8): whether one replan Preview could ever be adopted, before any current state is
 * read. The Preview must already have passed the Application's structural check (`runningPlanReplanPreviewIssues()`); this reads its
 * typed fields only. The shared ordinary result checks come first (`checkPlannerRunTerminationPersistable()`,
 * `checkPersistableOrdinaryPlannerResultShape()`: a draft Plan of a new chain - no repair lineage -, Domain-valid, its rejected
 * records complete), then the replan's own: a completed run that completed and counted exactly the replan target set, no Conflict, no
 * rejected Entry, no warning, one selected Entry per replan Target, the physical identity (17.7 item 6, shared with the Build List
 * optimization adoption), the replaced / added / unchanged partition of the replan target set with every generated Entry paired once,
 * selected and Domain-valid, the target set equal to the Preview's own classification and token, and the input token items the new
 * Plan carries itself. The first issue, or the persistable parts.
 */
export function checkPersistableRunningPlanReplanPreview(preview: RunningPlanReplanAdoptionPreview): RunningPlanReplanAdoptionShapeResult {
  const fail = (issue: PlannerResultPersistenceIssue): RunningPlanReplanAdoptionShapeResult => ({ issue, adoption: null })
  const { artifact } = preview
  const { plannerResult, summary, inputToken } = artifact
  const { termination } = plannerResult
  const plan = plannerResult.plan
  const truncated = checkPlannerRunTerminationPersistable(termination)
  if (truncated !== null) return fail(truncated)
  if (plan === null) return fail(resultInvalid('An optimized replan artifact must carry the new Plan.'))
  const ordinary = checkPersistableOrdinaryPlannerResultShape(plan, termination)
  if (ordinary !== null) return fail(ordinary)
  // The new Plan never makes one weapon the completion of two Targets (Issue
  // #334, `docs/PLANNER_SPEC.md` 21.4.1); the re-optimization assigns distinct
  // sources, so this is the shared defence. A weapon assigned elsewhere since
  // the Preview is refused by the new Plan's start.
  const safety = inspectProductionPlanCompletionAssignmentSafety(plan, [])
  if (!safety.safe) {
    return fail(resultInvalid(`The replan's new Plan would make one owned weapon the completion of two Targets (${safety.issues.map(({ reason }) => reason).join(', ')}).`))
  }

  const targetSet = replanTargetSetIssue(preview)
  if (targetSet !== null) return fail(targetSet)
  const replanIds = artifact.replanTargetWeaponIds as string[]

  // 17.7 items 1 - 3 over the replan target set (18.6): a completed run of exactly that set, no Conflict, no rejected Entry, no warning.
  if (termination.status !== 'completed') {
    return fail(resultInvalid(`An optimized replan comes from a completed Planner run, but the run ended '${termination.status}'.`))
  }
  if (termination.completedTargetCount !== replanIds.length || termination.totalTargetCount !== replanIds.length) {
    return fail(resultInvalid(`The Planner run completed ${termination.completedTargetCount} of ${termination.totalTargetCount} Targets, but the replan target set holds ${replanIds.length}.`))
  }
  if (plannerResult.conflicts.length > 0 || plan.conflicts.length > 0) {
    return fail(resultInvalid(`An optimized replan holds no Conflict, but ${Math.max(plannerResult.conflicts.length, plan.conflicts.length)} are recorded.`))
  }
  if (plan.rejectedBuildListEntries.length > 0) {
    return fail(resultInvalid(`An optimized replan rejects no BuildListEntry, but ${plan.rejectedBuildListEntries.length} are recorded.`))
  }
  if (plannerResult.warnings.length > 0) {
    return fail(resultInvalid(`An optimized replan carries no warning (it excludes no Entry), but ${plannerResult.warnings.length} are recorded.`))
  }
  const completed = collectProductionPlanTargetCompletionTargetWeaponIds(plan)
  if (completed === null || !sameIdSet(completed, replanIds)) {
    return fail(resultInvalid('The new Plan does not complete exactly the replan target set.'))
  }
  const selected = plan.selectedBuildListEntryIds as string[]
  if (duplicatesOf(selected).length > 0 || selected.length !== replanIds.length) {
    return fail(resultInvalid(`The new Plan selects one Entry per replan Target (${replanIds.length}), but it selects [${selected.join(', ')}].`))
  }

  const identity = checkBuildListOptimizationPhysicalIdentity(plan, summary)
  if (identity !== null) return fail(identity)
  if (summary.completedTargetCount !== replanIds.length || summary.totalTargetCount !== replanIds.length) {
    return fail(resultInvalid('The replan summary does not count exactly the replan target set.'))
  }

  // The replaced / added / unchanged record and the generated Entries.
  const generatedIds = artifact.generatedBuildListEntries.map(({ id }) => id as string)
  const repeatedGenerated = duplicatesOf(generatedIds)
  if (repeatedGenerated.length > 0) {
    return fail(resultInvalid(`Generated BuildListEntry IDs must be unique: '${repeatedGenerated[0]}' appears more than once.`))
  }
  const record = entryChangeRecordIssue(artifact, plan)
  if (record !== null) return fail(record)
  for (const entry of artifact.generatedBuildListEntries) {
    const validation = validateBuildListEntry(entry)
    if (!validation.isValid) return fail({ kind: 'entity_invalid', entityName: 'BuildListEntry', validation })
  }

  // The input token items the new Plan carries itself (18.6): its initial execution state and its CalculationContext.
  if (!executionStateMatches(inputToken.initialExecutionState, plan.baseSnapshot.initialExecutionState)) {
    return fail(resultInvalid('The input token\'s initialExecutionState is not the new Plan\'s PlanningInputSnapshot.initialExecutionState.'))
  }
  if (!isCalculationContextCompatible(inputToken.calculationContext, plan.calculationContext)
    || !isCalculationContextCompatible(inputToken.calculationContext, plan.baseSnapshot.calculationContext)) {
    return fail(resultInvalid('The input token\'s CalculationContext is not the new Plan\'s.'))
  }
  return {
    issue: null,
    adoption: { plan, generatedEntries: artifact.generatedBuildListEntries, replacements: artifact.replacements, additions: artifact.additions },
  }
}

function requirePersistablePreview(preview: RunningPlanReplanAdoptionPreview): PersistableRunningPlanReplanAdoption {
  const checked = checkPersistableRunningPlanReplanPreview(preview)
  if (checked.issue === null) return checked.adoption
  const { issue } = checked
  executionFailure(
    'replan_result_invalid',
    issue.kind === 'entity_invalid' ? `${issue.entityName} failed Domain validation.` : issue.message,
    issue.kind === 'entity_invalid' ? issue.validation.issues : [],
  )
}

function replanStateChanged(message: string): never {
  executionFailure('replan_state_changed', `${message} Calculate the replan again from the current state.`)
}

/**
 * The old Plan is still the running Plan the Preview was calculated from (16.8 token), it is the only running Plan, and it still
 * allows a replan (18.5 per old Plan, PR-2's `deriveRunningPlanReplanAvailability()`: an `operation_uncertain` or an unresolved
 * `actual_result_different` recorded after the calculation started refuses it).
 */
function assertRunningPlanStillReplannable(input: Pick<RunningPlanReplanAdoptionInput, 'preview' | 'runningPlan' | 'state'>): void {
  const { preview, runningPlan, state } = input
  assertReplanRunningPlanTokenHolds(runningPlan, preview.runningPlanToken)
  const availability = deriveRunningPlanReplanAvailability({
    productionPlans: state.runningPlans,
    executionHistory: state.planExecutionHistory,
    rngState: state.rngState,
    normalCounters: state.normalCounters,
  })
  if (availability.kind === 'multiple_running_plans') {
    executionFailure(
      'running_plan_invariant_violated',
      `ProductionPlans [${availability.runningPlanIds.join(', ')}] are all running; the one-running-Plan invariant is broken and no Plan is adopted.`,
    )
  }
  if (availability.kind === 'no_running_plan' || availability.plan.id !== runningPlan.id) {
    replanStateChanged(`ProductionPlan '${runningPlan.id}' is no longer the running Plan.`)
  }
  if (availability.kind === 'unavailable') {
    replanStateChanged(
      `ProductionPlan '${runningPlan.id}' no longer allows a replan (${availability.reasons.map(({ kind }) => kind).join(', ')}): recover or re-identify first.`,
    )
  }
}

/** Everything [T] verified for the keep-current path, plus the write it decides. */
interface VerifiedRunningPlanReplanAdoption {
  oldPlan: ProductionPlan
  newPlan: ProductionPlan
  /** The whole Build List after the adoption. */
  buildListEntries: BuildListEntry[]
  replacements: readonly BuildListEntryReplacement[]
  additions: readonly BuildListEntryAddition[]
  generatedEntries: readonly BuildListEntry[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
  startTargetLinkChanges: RunningPlanReplanStartTargetLinkChange[]
}

function linkChangeKey(change: RunningPlanReplanStartTargetLinkChange): string {
  return JSON.stringify([change.targetWeaponId, change.ownedWeaponId, change.fromTargetWeaponId, change.replacedOwnedWeaponId])
}

/** The two change sets compared as sets of their four semantic fields (18.8): no name, timestamp or display order takes part. */
function sameStartTargetLinkChanges(
  left: readonly RunningPlanReplanStartTargetLinkChange[],
  right: readonly RunningPlanReplanStartTargetLinkChange[],
): boolean {
  const leftKeys = left.map(linkChangeKey)
  const rightKeys = right.map(linkChangeKey)
  return new Set(leftKeys).size === leftKeys.length && new Set(rightKeys).size === rightKeys.length && sameIdSet(leftKeys, rightKeys)
}

/**
 * The preferences the started Plan writes must be exactly the re-derived change set (18.8: "書き込む変更は再導出した変更内容と
 * 一致する"): each destination Target prefers its weapon, each released Target that is no destination prefers nothing, and no other
 * Target changes. A difference is a broken invariant and fails closed (`execution_effect_inconsistent`).
 */
function assertStartWritesTheChanges(
  targetWeapons: readonly TargetWeapon[],
  written: readonly TargetWeapon[],
  changes: readonly RunningPlanReplanStartTargetLinkChange[],
): void {
  const expected = new Map<string, OwnedWeaponId | null>()
  for (const change of changes) {
    if (change.fromTargetWeaponId !== null && !expected.has(change.fromTargetWeaponId)) expected.set(change.fromTargetWeaponId, null)
  }
  for (const change of changes) expected.set(change.targetWeaponId, change.ownedWeaponId)
  const currentById = new Map(targetWeapons.map((target) => [target.id as string, target]))
  for (const [id, preferred] of [...expected]) {
    if (currentById.get(id)?.preferredOwnedWeaponId === preferred) expected.delete(id)
  }
  const writtenById = new Map(written.map((target) => [target.id as string, target]))
  const mismatch = writtenById.size !== expected.size
    || [...expected].some(([id, preferred]) => writtenById.get(id)?.preferredOwnedWeaponId !== preferred)
  if (mismatch) {
    inconsistent('The new Plan\'s start would write other Target preferences than the start effect changes re-derived for the adoption.')
  }
}

/**
 * [T] (everything but the 16.10 choice and the token, which the callers check first) and the decided write of the keep-current path.
 * Every check reads the persisted state the caller read inside its transaction; nothing here trusts a value the calculation or the
 * Preview reported about the current state.
 */
function verifyRunningPlanReplanAdoption(
  input: Omit<RunningPlanReplanAdoptionInput, 'savePointDecision'>,
  adoption: PersistableRunningPlanReplanAdoption,
): VerifiedRunningPlanReplanAdoption {
  const { preview, runningPlan, state, currentCalculationContext, now } = input
  const { artifact } = preview
  const { inputToken } = artifact
  const newPlan = adoption.plan
  const replanIds = artifact.replanTargetWeaponIds

  // The CalculationContext the calculation, the token and the new Plan were made under.
  if (
    !isCalculationContextCompatible(currentCalculationContext, inputToken.calculationContext) ||
    !isCalculationContextCompatible(currentCalculationContext, newPlan.calculationContext) ||
    !isCalculationContextCompatible(currentCalculationContext, newPlan.baseSnapshot.calculationContext)
  ) {
    replanStateChanged('The current CalculationContext is no longer compatible with the replan calculation.')
  }

  // Each replan Target still exists and can be replanned (18.2), with the planning definition it was calculated with: its
  // performance definition, priority and enablement (`replanTargetDefinitionsHash`). A Target outside the set never refuses.
  for (const id of replanIds) {
    const target = state.targetWeapons.find((candidate) => candidate.id === id)
    if (target === undefined || !isTargetWeaponPlanningEligible(target)) {
      replanStateChanged(`Replan Target '${id}' ${target === undefined ? 'no longer exists' : 'is no longer usable (completed or disabled)'}.`)
    }
  }
  if (createDependentTargetDefinitionsHash([...state.targetWeapons], replanIds) !== inputToken.replanTargetDefinitionsHash) {
    replanStateChanged('A replan Target\'s performance definition, priority or enablement changed after the calculation started.')
  }

  // The replan Targets' current Entries are the ones the calculation read (`scopeBuildListEntriesHash`): each replaced `O` is still its
  // Target's one Entry, an Entry-less Target still holds none, and no Entry was added, changed or removed. Entries outside never refuse.
  const replanIdSet = new Set<string>(replanIds)
  const scope = state.buildListEntries.filter((entry) => replanIdSet.has(entry.targetWeaponId))
  if (createPlanningBuildListEntriesHash(scope) !== inputToken.scopeBuildListEntriesHash) {
    replanStateChanged('A replan Target\'s BuildListEntry was added, changed or removed after the calculation started.')
  }

  // The Build List after the adoption over the whole current Build List (PR-4's one authority): a generated Entry ID now held by any
  // current Entry - outside the scope included - refuses it; nothing is skipped or overwritten.
  const after = deriveRunningPlanReplanBuildListAfterAdoption(state.buildListEntries, artifact)
  if (after.kind === 'invalid') {
    replanStateChanged(`The replan's Entry changes no longer fit the current Build List: ${after.issues.join(' ')}`)
  }
  const buildListEntries = after.buildListEntries
  const cardinality = validateBuildListCardinality(buildListEntries.filter((entry) => replanIdSet.has(entry.targetWeaponId)))
  if (!cardinality.isValid) {
    replanStateChanged(`A replan Target would hold more than one BuildListEntry: ${cardinality.issues.map(({ message }) => message).join(' ')}`)
  }

  // The generated Entries' freshness, recomputed from the current state (17.11 T5; never the persisted `isStale` or the calculation's).
  throwReplanAdoptionIssue(checkGeneratedBuildListEntriesFresh(adoption.generatedEntries, state, currentCalculationContext))

  // The new Plan ID is never a persisted one, and the Plan's references are the Build List after the adoption.
  if (newPlan.id === runningPlan.id || state.newPlanIdPersisted) {
    executionFailure('replan_plan_id_collision', `ProductionPlan '${newPlan.id}' already exists; a replan never overwrites a persisted Plan.`)
  }
  throwReplanAdoptionIssue(checkProductionPlanBuildListEntryReferences(newPlan, buildListEntries))
  throwReplanAdoptionIssue(checkRejectedBuildListEntryTargets(newPlan, buildListEntries))

  // The new Plan's own snapshot over the Build List after the adoption: its dependent Entries and Targets, and the current RNG /
  // Normal Counter / OwnedWeapon / Plan-dependent Target execution state (16.8's comparison).
  if (createDependentBuildListEntriesHash(buildListEntries, newPlan.selectedBuildListEntryIds) !== newPlan.baseSnapshot.dependentBuildListEntriesHash) {
    replanStateChanged('A BuildListEntry the new Plan depends on differs from the one it was calculated with.')
  }
  const dependentTargetIds = collectProductionPlanDependentTargetWeaponIds(newPlan, buildListEntries)
  if (createDependentTargetDefinitionsHash([...state.targetWeapons], dependentTargetIds) !== newPlan.baseSnapshot.dependentTargetDefinitionsHash) {
    replanStateChanged('A Target definition, priority or enablement the new Plan depends on changed after the calculation started.')
  }
  const actual = createActualExecutionState(newPlan, { ...state, buildListEntries }, [])
  if (!executionStateMatches(actual, newPlan.baseSnapshot.initialExecutionState)) {
    replanStateChanged('The current RNG, Normal Counter, OwnedWeapon or Plan-dependent Target state differs from the state the replan was calculated from.')
  }

  // The Plan start effect's preference changes, re-derived from the latest Targets and the Build List after the adoption by the same
  // authority the Preview used, must be the ones the Preview showed (18.8). A release the Preview did not show refuses the adoption.
  const startTargetLinkChanges = deriveRunningPlanReplanStartTargetLinkChanges(state.targetWeapons, state.buildListEntries, artifact)
  if (!sameStartTargetLinkChanges(startTargetLinkChanges, preview.startTargetLinkChanges)) {
    replanStateChanged('Starting the new Plan would now change other Target preferences than the Preview showed.')
  }

  // The ordinary Plan start authority writes the start effect, over the post-state in which the old Plan is already abandoned.
  const start = prepareProductionPlanStart({
    plan: newPlan,
    runningPlans: state.runningPlans.filter(({ id }) => id !== runningPlan.id),
    state: {
      rngState: state.rngState,
      normalCounters: state.normalCounters,
      ownedWeapons: state.ownedWeapons,
      targetWeapons: state.targetWeapons,
      buildListEntries,
      // The new Plan has executed nothing: no observation binding applies, and the old Plan's save point is not its own.
      planExecutionHistory: [],
      executionSavePoint: null,
    },
    currentCalculationContext,
    now,
  })
  assertStartWritesTheChanges(state.targetWeapons, start.targetWeapons, startTargetLinkChanges)

  const oldPlan = replanAdoptedRunningPlan(runningPlan, now)
  const ownedWeapons = transferReplanInProgressWeapons(runningPlan.id, start.plan, buildListEntries, state.ownedWeapons, now)
  assertReplanAdoptedStateValid(oldPlan, start.plan, ownedWeapons, start.targetWeapons, state)
  return {
    oldPlan,
    newPlan: start.plan,
    buildListEntries,
    replacements: adoption.replacements,
    additions: adoption.additions,
    generatedEntries: adoption.generatedEntries,
    ownedWeapons,
    targetWeapons: start.targetWeapons,
    startTargetLinkChanges,
  }
}

/**
 * One Entry the adoption replaces (`O -> G`, 18.8). Until Issue #336 PR-2 it
 * also carried the replaced Entry's legacy `improvementPreference`
 * (`replacedImprovementPreference`), which no screen read since Issue #100
 * PR-6; the adoption never wrote it and nothing else changes.
 */
export type RunningPlanReplanAdoptionReplacementInspection = BuildListEntryReplacement

/** What the adoption does to one weapon in progress for the old Plan (18.4). */
export interface RunningPlanReplanAdoptionInProgressInspection {
  ownedWeaponId: OwnedWeaponId
  /** `moved_to_new_plan`: the new Plan keeps tracking it (its `startedAt` kept); `cleared`: it stops being in progress (never deleted). */
  handling: 'moved_to_new_plan' | 'cleared'
}

/**
 * Whether the 16.10 save point choice is asked, with the save point the decision must name and whether the restore can run for the old
 * Plan (Issue #335: an old Plan a calculation version boundary made incompatible is adopted from its current state only).
 */
export type RunningPlanReplanAdoptionSavePointOptions = RunningPlanSavePointChoiceOptions

/**
 * What adopting the Preview would write and ask (`docs/PLANNER_SPEC.md` 18.8, the confirmation dialog), read in the same state that
 * validated it. Advisory only: the adoption validates everything again inside its own transaction.
 */
export type RunningPlanReplanAdoptionInspection = {
  runningPlanId: ProductionPlanId
  runningPlanStatus: RunningProductionPlanStatus
  runningPlanCurrentStepId: PlanStepId | null
  newPlanId: ProductionPlanId
  /** In the artifact's order. */
  replacements: RunningPlanReplanAdoptionReplacementInspection[]
  /** The generated Entries added for replan Targets that held none, in the artifact's order. */
  additions: BuildListEntryAddition[]
  /** Replan Targets whose current Entry is kept with its settings. */
  unchangedTargetWeaponIds: TargetWeaponId[]
  /** The Plan start effect's preference changes, re-derived now (equal to the Preview's, or the inspection refuses). */
  startTargetLinkChanges: RunningPlanReplanStartTargetLinkChange[]
  /** The weapons in progress for the old Plan, in OwnedWeapon order. */
  inProgressOwnedWeapons: RunningPlanReplanAdoptionInProgressInspection[]
} & RunningPlanReplanAdoptionSavePointOptions


/**
 * Reads what adopting the Preview would write and whether the 16.10 save point choice is asked, refusing exactly what the adoption
 * would refuse at the current state (the keep-current path; the choice itself is only reported). Writes nothing and is no write
 * authority.
 */
export function inspectRunningPlanReplanAdoption(input: Omit<RunningPlanReplanAdoptionInput, 'savePointDecision'>): RunningPlanReplanAdoptionInspection {
  const adoption = requirePersistablePreview(input.preview)
  assertRunningPlanStillReplannable(input)
  const choice = deriveRunningPlanSavePointChoiceRequirement(input.runningPlan, input.state.executionSavePoint, input.state.planExecutionHistory)
  const verified = verifyRunningPlanReplanAdoption(input, adoption)
  const changedWeapons = new Map(verified.ownedWeapons.map((weapon) => [weapon.id as string, weapon]))
  return {
    runningPlanId: input.runningPlan.id,
    runningPlanStatus: input.preview.runningPlanToken.status,
    runningPlanCurrentStepId: input.runningPlan.currentStepId,
    newPlanId: verified.newPlan.id,
    // Each `O` is its Target's current Entry (the scope hash and the Build List after the adoption checked it).
    replacements: verified.replacements.map((replacement) => ({ ...replacement })),
    additions: verified.additions.map((addition) => ({ ...addition })),
    unchangedTargetWeaponIds: [...input.preview.artifact.unchangedTargetWeaponIds],
    startTargetLinkChanges: verified.startTargetLinkChanges,
    inProgressOwnedWeapons: [...changedWeapons.values()]
      .sort((left, right) => compareIds(left.id, right.id))
      .map((weapon) => ({ ownedWeaponId: weapon.id, handling: weapon.executionInProgress === null ? 'cleared' : 'moved_to_new_plan' })),
    ...runningPlanSavePointChoiceOptions(input.runningPlan, choice, input.currentCalculationContext),
  }
}

/**
 * Everything one adoption writes (`docs/PLANNER_SPEC.md` 18.8 [W], `docs/DATA_MODEL.md` 14.4), decided and validated before a single
 * write happens.
 *
 * - `save_point_restored`: the user chose 「最後のゲーム内セーブ地点へ戻す」. Only the save point restore is written: no Entry is
 *   replaced or added, the old Plan is not ended, no new Plan is started, and a new calculation from the restored state is required.
 * - `adopted`: the old Plan becomes `abandoned` (`replan_adopted`) with its current Step, Step completions and recalculation reasons
 *   kept; each replaced `O` is deleted and each generated `G` added (replacing and added ones alike, never put over a persisted Entry);
 *   the new Plan is added `active` with its start effect's Target preferences; the old Plan's in-progress marks are moved or cleared;
 *   the old Plan's save point is deleted. No ExecutionHistory is added, and no Draft, Target outside the start effect or Entry outside
 *   the replacements and additions is written.
 */
export type RunningPlanReplanAdoptionWrite =
  | { kind: 'save_point_restored'; restore: ExecutionSavePointRestoreWrite }
  | {
      kind: 'adopted'
      savePointHandling: 'no_choice' | 'keep_current'
      /** The abandoned old Plan. */
      oldPlan: ProductionPlan
      /** The new Plan, started. It is added, never put over an existing Plan. */
      newPlan: ProductionPlan
      /** Each replaced `O`. */
      deletedBuildListEntryIds: BuildListEntryId[]
      /** Each generated `G` (replacing and added), in the artifact's materialization order. Added, never put. */
      addedBuildListEntries: BuildListEntry[]
      /** Weapons whose in-progress mark moved to the new Plan or was cleared. */
      ownedWeapons: OwnedWeapon[]
      /** Targets the new Plan's start effect changed (16.11). */
      targetWeapons: TargetWeapon[]
      deletesExecutionSavePoint: boolean
    }

/**
 * Decides one 「この再計画を採用」 of a running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.8 / 16.10): [P1], the old Plan's
 * token, the one running Plan and its 18.5 availability, then the 16.10 save point decision re-derived here. Returning to the save point
 * ends the adoption there through the unchanged `prepareExecutionSavePointRestore()`. Otherwise every [T] check runs against the
 * current state and the write of the adoption is decided.
 */
export function prepareRunningPlanReplanAdoption(input: RunningPlanReplanAdoptionInput): RunningPlanReplanAdoptionWrite {
  const { runningPlan, savePointDecision, state } = input
  const adoption = requirePersistablePreview(input.preview)
  assertRunningPlanStillReplannable(input)

  const choice = deriveRunningPlanSavePointChoiceRequirement(runningPlan, state.executionSavePoint, state.planExecutionHistory)
  assertRunningPlanSavePointDecision(runningPlan, choice, savePointDecision)
  if (savePointDecision?.kind === 'restore_save_point') {
    // 16.8 / 16.10: returning to the save point adopts nothing; the restore contract applies as it is, every refusal before any write.
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

  const verified = verifyRunningPlanReplanAdoption(input, adoption)
  return {
    kind: 'adopted',
    savePointHandling: savePointDecision === null ? 'no_choice' : 'keep_current',
    oldPlan: verified.oldPlan,
    newPlan: verified.newPlan,
    deletedBuildListEntryIds: verified.replacements.map(({ replacedBuildListEntryId }) => replacedBuildListEntryId),
    addedBuildListEntries: verified.generatedEntries.map((entry) => structuredClone(entry)),
    ownedWeapons: verified.ownedWeapons,
    targetWeapons: verified.targetWeapons,
    deletesExecutionSavePoint: state.executionSavePoint !== null,
  }
}
