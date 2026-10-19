/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.7 / 17.11, Issue #260 PR-6A): the pure, state-independent half of the
 * adoption save - the artifact checks of [P1] and the final selection check run once the replaced Build List is known.
 *
 * The existing shared save-time helpers come first with their contracts unchanged (`checkPersistablePlannerResultShape()`: the
 * termination, a draft Plan, unique generated Entry IDs, one replacement per generated Entry naming its own Target, Domain-valid Plan
 * and Entries; `checkPersistableOrdinaryPlannerResultShape()`: a draft Plan of a new chain, Domain-valid). The optimization's own
 * conditions follow, read from the typed artifact only: a warning is compared with Stage 0's recorded exclusion warnings as a whole
 * kind and message value, never parsed for an Entry or a Target; never the diagnostics, never a Planner run, a prediction or the
 * persisted state. Each check returns the first issue it finds, mapped onto the caller's error boundary.
 */
import type { BuildListEntryReplacement } from '../../buildList/buildListEntryReplacement'
import type { BuildListEntry, BuildListEntryId, ExpectedPlanState, ProductionPlan, TargetWeaponId } from '../../models/publicTypes'
import { isCalculationContextCompatible } from '../../models/publicTypes'
import {
  checkPersistableOrdinaryPlannerResultShape, checkPersistablePlannerResultShape, type PlannerResultPersistenceIssue,
} from '../plannerResultPersistenceValidation'
import type { BuildListOptimizationArtifact } from './buildListOptimizationResult'
import { BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE, unexplainedBuildListOptimizationWarnings } from './finalVerification'

/** One optimization artifact whose shape the adoption may persist: the final Plan, its generated Entries and their replacements. */
export interface PersistableBuildListOptimizationAdoption {
  plan: ProductionPlan
  generatedEntries: readonly BuildListEntry[]
  replacements: readonly BuildListEntryReplacement[]
}

export type BuildListOptimizationAdoptionShapeResult =
  | { issue: null; adoption: PersistableBuildListOptimizationAdoption }
  | { issue: PlannerResultPersistenceIssue; adoption: null }

function resultInvalid(message: string): PlannerResultPersistenceIssue {
  return { kind: 'result_invalid', message }
}

function duplicatesOf(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

function sameExpectedPlanState(left: ExpectedPlanState, right: ExpectedPlanState): boolean {
  return left.rngStateHash === right.rngStateHash && left.normalCountersHash === right.normalCountersHash
    && left.ownedWeaponsHash === right.ownedWeaponsHash && left.targetExecutionStateHash === right.targetExecutionStateHash
}

/** The optimization's own conditions over an artifact that already passed the shared shape helpers; the first issue, or null. */
function optimizationIssue(artifact: BuildListOptimizationArtifact, plan: ProductionPlan): PlannerResultPersistenceIssue | null {
  const { plannerResult, summary, inputToken } = artifact
  const { termination } = plannerResult
  const planning = artifact.planningTargetWeaponIds as string[]
  const planningSet = new Set(planning)

  // 17.7 item 1: a completed run that completed and counted exactly the Stage 0 planning Targets.
  if (termination.status !== 'completed') {
    return resultInvalid(`An optimized Plan must come from a completed Planner run, but the run ended '${termination.status}'.`)
  }
  if (planning.length === 0 || duplicatesOf(planning).length > 0) {
    return resultInvalid('The artifact must name each planning Target exactly once.')
  }
  if (termination.completedTargetCount !== planning.length || termination.totalTargetCount !== planning.length) {
    return resultInvalid(
      `The Planner run completed ${termination.completedTargetCount} of ${termination.totalTargetCount} Targets, but the optimization planned ${planning.length}.`,
    )
  }

  // 17.7 item 2: every planning Target's Entry selected, no Conflict, no rejected Entry.
  if (plannerResult.conflicts.length > 0 || plan.conflicts.length > 0) {
    return resultInvalid(`An optimized Plan holds no Conflict, but ${Math.max(plannerResult.conflicts.length, plan.conflicts.length)} are recorded.`)
  }
  if (plan.rejectedBuildListEntries.length > 0) {
    return resultInvalid(`An optimized Plan rejects no BuildListEntry, but ${plan.rejectedBuildListEntries.length} are recorded.`)
  }
  const selected = plan.selectedBuildListEntryIds as string[]
  if (duplicatesOf(selected).length > 0 || selected.length !== planning.length) {
    return resultInvalid(`An optimized Plan selects one Entry per planning Target (${planning.length}), but it selects [${selected.join(', ')}].`)
  }
  const selectedSet = new Set(selected)
  const unselectedGenerated = artifact.generatedBuildListEntries.filter(({ id }) => !selectedSet.has(id)).map(({ id }) => id)
  if (unselectedGenerated.length > 0) {
    return resultInvalid(`The generated BuildListEntries [${unselectedGenerated.join(', ')}] are not selected by the optimized Plan.`)
  }

  // The replaced and the unchanged Targets partition the planning Targets; a replaced Entry is never selected.
  const replacedTargets = artifact.replacements.map(({ targetWeaponId }) => targetWeaponId as string)
  const unchanged = artifact.unchangedTargetWeaponIds as string[]
  const partition = [...replacedTargets, ...unchanged]
  const outside = partition.filter((id) => !planningSet.has(id))
  if (duplicatesOf(partition).length > 0 || outside.length > 0 || new Set(partition).size !== planningSet.size) {
    return resultInvalid('Every planning Target must be either replaced or unchanged exactly once, and no other Target may be named.')
  }
  const selectedReplaced = artifact.replacements.filter(({ replacedBuildListEntryId }) => selectedSet.has(replacedBuildListEntryId))
  if (selectedReplaced.length > 0) {
    return resultInvalid(`The optimized Plan selects the replaced BuildListEntry '${selectedReplaced[0]!.replacedBuildListEntryId}'.`)
  }

  // Stage 0's exclusion record: one warning per excluded Entry (`validatePlannerInput()` records one per Entry), with its kind and its
  // message as the validation produced them.
  const recordedIds = artifact.inputExclusions.map(({ buildListEntryId }) => buildListEntryId as string)
  const repeatedExclusion = duplicatesOf(recordedIds)
  if (repeatedExclusion.length > 0) {
    return resultInvalid(`The excluded BuildListEntry '${repeatedExclusion[0]}' is recorded with more than one exclusion warning.`)
  }
  const unrecordedMessage = artifact.inputExclusions.find(({ warningMessage }) => typeof warningMessage !== 'string' || warningMessage.length === 0)
  if (unrecordedMessage !== undefined) {
    return resultInvalid(`The excluded BuildListEntry '${unrecordedMessage.buildListEntryId}' is recorded without the message of its exclusion warning.`)
  }

  // Stage 0's excluded Entries stay outside the plan (17.3 / 17.7 item 4): no planning Target, no Route, no replacement, no selection.
  const excludedIds = new Set<string>(recordedIds)
  const excludedPlanningTarget = artifact.inputExclusions.find(({ targetWeaponId }) => planningSet.has(targetWeaponId))
  if (excludedPlanningTarget !== undefined) {
    return resultInvalid(`The excluded BuildListEntry '${excludedPlanningTarget.buildListEntryId}' belongs to the planning Target '${excludedPlanningTarget.targetWeaponId}'.`)
  }
  const touchedExcluded = [
    ...artifact.generatedBuildListEntries.map(({ id }) => id as string),
    ...artifact.replacements.map(({ replacedBuildListEntryId }) => replacedBuildListEntryId as string),
    ...selected,
  ].find((id) => excludedIds.has(id))
  if (touchedExcluded !== undefined) {
    return resultInvalid(`The excluded BuildListEntry '${touchedExcluded}' is generated, replaced or selected by the optimization.`)
  }

  // 17.7 item 3: every warning is one of Stage 0's exclusion warnings - the same kind and the same message, multiplicity counted - by
  // the rule Stage D' applies. The allowed values are Stage 0's record, never the result's own warnings; no message is parsed.
  const unexpectedWarnings = unexplainedBuildListOptimizationWarnings(
    plannerResult.warnings,
    artifact.inputExclusions.map(({ warningKind, warningMessage }) => ({ kind: warningKind, message: warningMessage })),
  )
  if (unexpectedWarnings.length > 0) {
    return resultInvalid(
      `The optimized Planner result carries warnings that no Stage 0 exclusion explains: [${unexpectedWarnings.map(({ kind }) => kind).sort(compareCodeUnits).join(', ')}].`,
    )
  }

  // 17.7 item 6: physical operations (steps − confirm_owned_ideal Steps) = Σ stream advances = the structural objective, as reported.
  const nonPhysicalStepCount = plan.steps.filter(({ operationType }) => operationType === BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE).length
  const physicalOperationCount = plan.steps.length - nonPhysicalStepCount
  const streamAdvanceSum = plan.steps.reduce(
    (sum, { rngAdvance }) => sum + rngAdvance.skillCounterDelta + rngAdvance.gogmaCounterDelta + (rngAdvance.normalCounterDelta ?? 0), 0)
  if (physicalOperationCount !== streamAdvanceSum || physicalOperationCount !== summary.structuralObjective
    || physicalOperationCount !== summary.physicalOperationCount || nonPhysicalStepCount !== summary.nonPhysicalStepCount
    || plan.steps.length !== summary.planStepCount) {
    return resultInvalid(`The physical identity does not hold: ${JSON.stringify({
      planSteps: plan.steps.length, nonPhysicalStepCount, physicalOperationCount, streamAdvanceSum,
      structuralObjective: summary.structuralObjective, summary: { planStepCount: summary.planStepCount, nonPhysicalStepCount: summary.nonPhysicalStepCount, physicalOperationCount: summary.physicalOperationCount },
    })}.`)
  }

  // The Worker-side input token is the final Plan's own (17.10): its initial execution state, Target hash and CalculationContext.
  if (!sameExpectedPlanState(inputToken.initialExecutionState, plan.baseSnapshot.initialExecutionState)) {
    return resultInvalid('The input token\'s initialExecutionState is not the final Plan\'s PlanningInputSnapshot.initialExecutionState.')
  }
  if (inputToken.targetWeaponsHash !== plan.baseSnapshot.targetWeaponsHash) {
    return resultInvalid('The input token\'s targetWeaponsHash is not the final Plan\'s PlanningInputSnapshot.targetWeaponsHash.')
  }
  if (!isCalculationContextCompatible(inputToken.calculationContext, plan.calculationContext)
    || !isCalculationContextCompatible(inputToken.calculationContext, plan.baseSnapshot.calculationContext)) {
    return resultInvalid('The input token\'s CalculationContext is not the final Plan\'s.')
  }
  return null
}

/**
 * [P1] of the adoption (`docs/PLANNER_SPEC.md` 17.11): whether one `optimized` artifact may be persisted at all, before any current
 * state is read. The shared helpers run first, then the optimization's own conditions (17.7 items 1 - 4 and 6, the replaced /
 * unchanged / planning Target partition, and the input token items the final Plan carries itself). The artifact must already have
 * passed the main thread's structural check of a Worker result; this check reads its typed fields only.
 */
export function checkPersistableBuildListOptimizationArtifact(artifact: BuildListOptimizationArtifact): BuildListOptimizationAdoptionShapeResult {
  const fail = (issue: PlannerResultPersistenceIssue): BuildListOptimizationAdoptionShapeResult => ({ issue, adoption: null })
  const { plannerResult } = artifact
  const plan = plannerResult.plan as ProductionPlan | null
  if (plan === null || plan === undefined) return fail(resultInvalid('An optimized artifact must carry the final Plan.'))
  const generatedEntries = artifact.generatedBuildListEntries
  const replacements = artifact.replacements
  const shape = checkPersistablePlannerResultShape(plan, generatedEntries, plannerResult.termination, replacements)
  if (shape !== null) return fail(shape)
  const ordinary = checkPersistableOrdinaryPlannerResultShape(plan, plannerResult.termination)
  if (ordinary !== null) return fail(ordinary)
  const issue = optimizationIssue(artifact, plan)
  if (issue !== null) return fail(issue)
  return { issue: null, adoption: { plan, generatedEntries, replacements } }
}

/**
 * The final half of 17.7 item 2 once the replaced Build List is known (inside the adoption transaction, after the replacement set and
 * the Plan's references were checked): the Plan's selected Entries are exactly one Entry of each planning Target, so an unchanged
 * Target's current Entry is selected and no out-of-scope Entry is.
 */
export function checkBuildListOptimizationFinalSelection(
  plan: Pick<ProductionPlan, 'selectedBuildListEntryIds'>,
  finalEntries: readonly BuildListEntry[],
  planningTargetWeaponIds: readonly TargetWeaponId[],
): PlannerResultPersistenceIssue | null {
  const entryById = new Map<string, BuildListEntry>(finalEntries.map((entry) => [entry.id, entry]))
  const selectedTargets: string[] = []
  for (const id of plan.selectedBuildListEntryIds as BuildListEntryId[]) {
    const entry = entryById.get(id)
    if (entry === undefined) return resultInvalid(`The optimized Plan selects '${id}', which is not part of the final Build List.`)
    selectedTargets.push(entry.targetWeaponId)
  }
  const planning: string[] = [...planningTargetWeaponIds].sort(compareCodeUnits)
  const actual = [...selectedTargets].sort(compareCodeUnits)
  if (actual.length !== planning.length || actual.some((id, index) => id !== planning[index])) {
    return resultInvalid(`The optimized Plan selects the Entries of [${actual.join(', ')}], not exactly one Entry of each planning Target [${planning.join(', ')}].`)
  }
  return null
}

/**
 * Stage 0's exclusion record against the Build List it was taken from (inside the adoption transaction, once the current Build List
 * is the input's by the input token and the replaced Build List is built): every recorded Entry is in it, untouched by the
 * replacements, and belongs to the recorded Target. The record's Entry and Target IDs are its typed fields; no message is read.
 */
export function checkBuildListOptimizationExclusionsInBuildList(
  inputExclusions: readonly Pick<BuildListOptimizationArtifact['inputExclusions'][number], 'buildListEntryId' | 'targetWeaponId'>[],
  finalEntries: readonly BuildListEntry[],
): PlannerResultPersistenceIssue | null {
  const entryById = new Map<string, BuildListEntry>(finalEntries.map((entry) => [entry.id, entry]))
  for (const { buildListEntryId, targetWeaponId } of inputExclusions) {
    const entry = entryById.get(buildListEntryId)
    if (entry === undefined || entry.targetWeaponId !== targetWeaponId) {
      return resultInvalid(
        `The excluded BuildListEntry '${buildListEntryId}' of TargetWeapon '${targetWeaponId}' is not an Entry of that Target in the Build List the optimization was calculated over.`,
      )
    }
  }
  return null
}
