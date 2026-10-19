import { validateBuildListEntryReplacementMetadata } from '../../domain/buildList/buildListEntryReplacement'
import type { BuildListEntry, ProductionPlan } from '../../domain/models/publicTypes'
import { validateBuildListEntry, validateProductionPlan } from '../../domain/models/validation'

/**
 * The main thread's structural check of a Worker `blo_result` body (`docs/PLANNER_SPEC.md` 17.8 / 17.9, Issue #260 PR-4).
 *
 * A structured-cloned result is untrusted data until it passes this check; a result that fails it is a failed run, never a Preview.
 * It checks the shape and the internal consistency of the fields the Preview and the later adoption read, reusing the Domain
 * validation of the Plan and of each generated Entry. It re-implements no Stage: no scheduler run, no Target satisfaction, no
 * physical operation count of its own and no step bound - it only compares the values the calculation reported with each other.
 *
 * Passing it is not adoptability: the adoption re-validates the artifact against the current persisted state in its own
 * transaction (`docs/PLANNER_SPEC.md` 17.11, Issue #260 PR-6).
 */

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isNonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isPositiveInteger = (value: unknown): value is number => isNonNegativeInteger(value) && value >= 1

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

/** Runs a Domain validator over untrusted data: a malformed value that makes it throw is an issue, not a crash. */
function domainIssues(path: string, validate: () => { isValid: boolean; issues: readonly { path: string; message: string }[] }): string[] {
  try {
    const result = validate()
    return result.isValid ? [] : result.issues.map(issue => `${path}${issue.path ? `.${issue.path}` : ''}: ${issue.message}`)
  } catch (error: unknown) {
    return [`${path} could not be validated (${error instanceof Error ? error.message : String(error)}).`]
  }
}

const UNSUPPORTED_REASON_KINDS = ['invalid_planner_input', 'no_planning_target', 'checkpoint_selection', 'unconfirmed_rng_state', 'target_without_source', 'blind_route_required']
const BOUND_KINDS = ['structural_search_node_budget', 'structural_candidate_limit', 'planner_verification_budget', 'shape_search_scale_gate', 'shape_search_budget']
const NOT_FOUND_REASONS = ['no_structural_candidate', 'candidates_rejected']

function diagnosticsIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object.`]
  const issues: string[] = []
  if (!Array.isArray(value.candidates)) issues.push(`${path}.candidates must be an array.`)
  if (!isNonNegativeInteger(value.plannerVerifications)) issues.push(`${path}.plannerVerifications must be a non-negative integer.`)
  if (!(value.elapsedMs === null || isRecord(value.elapsedMs))) issues.push(`${path}.elapsedMs must be an object or null.`)
  return issues
}

function expectedPlanStateIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object.`]
  return ['rngStateHash', 'normalCountersHash', 'ownedWeaponsHash', 'targetExecutionStateHash']
    .filter(key => !isNonEmptyString(value[key])).map(key => `${path}.${key} must be a non-empty string.`)
}

function calculationContextIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object.`]
  const issues: string[] = []
  if (!isNonEmptyString(value.gameVersion)) issues.push(`${path}.gameVersion must be a non-empty string.`)
  if (!isNonEmptyString(value.rngEngineVersion)) issues.push(`${path}.rngEngineVersion must be a non-empty string.`)
  if (!isPositiveInteger(value.masterDataVersion)) issues.push(`${path}.masterDataVersion must be a positive integer.`)
  if (!isPositiveInteger(value.appSchemaVersion)) issues.push(`${path}.appSchemaVersion must be a positive integer.`)
  return issues
}

function optimizedArtifactIssues(artifact: unknown): string[] {
  if (!isRecord(artifact)) return ['result.artifact must be an object.']
  const issues: string[] = []
  const summary = artifact.summary
  const plannerResult = artifact.plannerResult
  const planningTargets = artifact.planningTargetWeaponIds
  const unchanged = artifact.unchangedTargetWeaponIds
  const generated = artifact.generatedBuildListEntries
  const replacements = artifact.replacements

  // The final Planner result: a completed draft Plan of a new chain.
  let plan: UnknownRecord | null = null
  let termination: UnknownRecord | null = null
  if (!isRecord(plannerResult)) {
    issues.push('result.artifact.plannerResult must be an object.')
  } else {
    if (!isRecord(plannerResult.plan)) issues.push('result.artifact.plannerResult.plan must be a Plan.')
    else plan = plannerResult.plan
    if (!isRecord(plannerResult.termination)) issues.push('result.artifact.plannerResult.termination must be an object.')
    else termination = plannerResult.termination
    // An optimized result holds no Conflict (`docs/PLANNER_SPEC.md` 17.7 item 2): an empty list, read as reported.
    if (!Array.isArray(plannerResult.conflicts)) issues.push('result.artifact.plannerResult.conflicts must be an array.')
    else if (plannerResult.conflicts.length !== 0) issues.push('result.artifact.plannerResult.conflicts must be empty.')
    if (!Array.isArray(plannerResult.warnings)) issues.push('result.artifact.plannerResult.warnings must be an array.')
  }
  if (plan !== null) {
    issues.push(...domainIssues('result.artifact.plannerResult.plan', () => validateProductionPlan(plan as unknown as ProductionPlan)))
    if (plan.status !== 'draft') issues.push('result.artifact.plannerResult.plan.status must be draft.')
    if (plan.conflictRepairLineage !== null) issues.push('result.artifact.plannerResult.plan.conflictRepairLineage must be null.')
    // Neither a Conflict nor a rejected Entry is recorded on the Plan itself either (17.7 item 2).
    if (!Array.isArray(plan.conflicts)) issues.push('result.artifact.plannerResult.plan.conflicts must be an array.')
    else if (plan.conflicts.length !== 0) issues.push('result.artifact.plannerResult.plan.conflicts must be empty.')
    if (!Array.isArray(plan.rejectedBuildListEntries)) issues.push('result.artifact.plannerResult.plan.rejectedBuildListEntries must be an array.')
    else if (plan.rejectedBuildListEntries.length !== 0) issues.push('result.artifact.plannerResult.plan.rejectedBuildListEntries must be empty.')
  }
  if (termination !== null && termination.status !== 'completed') issues.push('result.artifact.plannerResult.termination.status must be completed.')

  // The summary the Preview reads, consistent with the Plan and the termination it was read from.
  if (!isRecord(summary)) {
    issues.push('result.artifact.summary must be an object.')
  } else {
    for (const key of ['physicalOperationCount', 'planStepCount', 'nonPhysicalStepCount', 'structuralObjective', 'completedTargetCount', 'totalTargetCount']) {
      if (!isNonNegativeInteger(summary[key])) issues.push(`result.artifact.summary.${key} must be a non-negative integer.`)
    }
    if (!isPositiveInteger(summary.maxPlanSteps)) issues.push('result.artifact.summary.maxPlanSteps must be a positive integer.')
    const outOfScope = summary.outOfScopeTargetCounts
    if (!isRecord(outOfScope) || !['noEntry', 'excludedEntryOnly', 'disabled', 'completed'].every(key => isNonNegativeInteger(outOfScope[key]))) {
      issues.push('result.artifact.summary.outOfScopeTargetCounts needs noEntry, excludedEntryOnly, disabled and completed counts.')
    }
    if (isNonNegativeInteger(summary.physicalOperationCount) && isNonNegativeInteger(summary.nonPhysicalStepCount)
      && summary.physicalOperationCount + summary.nonPhysicalStepCount !== summary.planStepCount) {
      issues.push('result.artifact.summary: physicalOperationCount + nonPhysicalStepCount must equal planStepCount.')
    }
    // The physical identity the calculation verified (17.7 item 6), compared as reported: nothing is re-derived from the Steps.
    if (isNonNegativeInteger(summary.structuralObjective) && isNonNegativeInteger(summary.physicalOperationCount)
      && summary.structuralObjective !== summary.physicalOperationCount) {
      issues.push('result.artifact.summary.structuralObjective must equal physicalOperationCount.')
    }
    if (summary.completedTargetCount !== summary.totalTargetCount) issues.push('result.artifact.summary: every planning Target must be completed.')
    if (plan !== null && Array.isArray(plan.steps) && plan.steps.length !== summary.planStepCount) {
      issues.push('result.artifact.summary.planStepCount must equal the Plan Step count.')
    }
    if (termination !== null) {
      if (termination.completedTargetCount !== summary.completedTargetCount || termination.totalTargetCount !== summary.totalTargetCount) {
        issues.push('result.artifact.summary Target counts must equal the termination\'s.')
      }
      const limits = termination.limits
      if (!isRecord(limits) || limits.maxPlanSteps !== summary.maxPlanSteps) {
        issues.push('result.artifact.summary.maxPlanSteps must be the bound the final verification ran with.')
      }
    }
    if (isStringArray(planningTargets) && planningTargets.length !== summary.totalTargetCount) {
      issues.push('result.artifact.planningTargetWeaponIds must hold totalTargetCount Targets.')
    }
  }

  // The planning Targets, partitioned into the unchanged ones and the replaced ones.
  if (!isStringArray(planningTargets) || planningTargets.length === 0) issues.push('result.artifact.planningTargetWeaponIds must be a non-empty string array.')
  if (!isStringArray(unchanged)) issues.push('result.artifact.unchangedTargetWeaponIds must be a string array.')
  if (!Array.isArray(generated)) issues.push('result.artifact.generatedBuildListEntries must be an array.')
  if (!Array.isArray(replacements)) issues.push('result.artifact.replacements must be an array.')
  if (Array.isArray(generated)) {
    generated.forEach((entry, index) => {
      if (!isRecord(entry)) issues.push(`result.artifact.generatedBuildListEntries[${index}] must be an object.`)
      else issues.push(...domainIssues(`result.artifact.generatedBuildListEntries[${index}]`, () => validateBuildListEntry(entry as unknown as BuildListEntry)))
    })
  }
  if (Array.isArray(replacements)) {
    const shaped = replacements.every(value => isRecord(value) && isNonEmptyString(value.targetWeaponId)
      && isNonEmptyString(value.replacedBuildListEntryId) && isNonEmptyString(value.generatedBuildListEntryId))
    if (!shaped) {
      issues.push('result.artifact.replacements must name a Target, the replaced Entry and the generated Entry.')
    } else {
      const typed = replacements as { targetWeaponId: string; replacedBuildListEntryId: string; generatedBuildListEntryId: string }[]
      issues.push(...domainIssues('result.artifact.replacements', () => validateBuildListEntryReplacementMetadata(
        typed as unknown as Parameters<typeof validateBuildListEntryReplacementMetadata>[0])))
      if (Array.isArray(generated)) {
        if (generated.length !== typed.length) issues.push('result.artifact: one replacement per generated Entry is required.')
        typed.forEach((replacement, index) => {
          const entry = generated[index]
          if (!isRecord(entry) || entry.id !== replacement.generatedBuildListEntryId || entry.targetWeaponId !== replacement.targetWeaponId) {
            issues.push(`result.artifact.replacements[${index}] must name generatedBuildListEntries[${index}] and its Target.`)
          }
        })
      }
      if (isStringArray(planningTargets) && isStringArray(unchanged)) {
        const replaced = typed.map(({ targetWeaponId }) => targetWeaponId)
        const kept = unchanged
        const planning = new Set(planningTargets)
        for (const id of duplicates(planningTargets)) issues.push(`result.artifact.planningTargetWeaponIds repeats ${id}.`)
        for (const id of duplicates([...replaced, ...kept])) issues.push(`result.artifact: Target ${id} is both replaced and unchanged, or listed twice.`)
        for (const id of [...replaced, ...kept]) if (!planning.has(id)) issues.push(`result.artifact: Target ${id} is not a planning Target.`)
        if (new Set([...replaced, ...kept]).size !== planning.size) issues.push('result.artifact: every planning Target must be either replaced or unchanged.')
      }
    }
  }

  // The excluded Entries of Stage 0 and the Worker-side input token items.
  if (!Array.isArray(artifact.inputExclusions) || !artifact.inputExclusions.every(value => isRecord(value)
    && isNonEmptyString(value.buildListEntryId) && isNonEmptyString(value.targetWeaponId) && isNonEmptyString(value.warningKind)
    && isNonEmptyString(value.warningMessage))) {
    issues.push('result.artifact.inputExclusions must list the excluded Entries with their Target, warning kind and warning message.')
  }
  const token = artifact.inputToken
  if (!isRecord(token)) {
    issues.push('result.artifact.inputToken must be an object.')
  } else {
    issues.push(...expectedPlanStateIssues(token.initialExecutionState, 'result.artifact.inputToken.initialExecutionState'))
    if (!isNonEmptyString(token.targetWeaponsHash)) issues.push('result.artifact.inputToken.targetWeaponsHash must be a non-empty string.')
    if (!isNonEmptyString(token.inputBuildListEntriesHash)) issues.push('result.artifact.inputToken.inputBuildListEntriesHash must be a non-empty string.')
    issues.push(...calculationContextIssues(token.calculationContext, 'result.artifact.inputToken.calculationContext'))
  }
  issues.push(...diagnosticsIssues(artifact.diagnostics, 'result.artifact.diagnostics'))
  return issues
}

/**
 * The issues of one `blo_result` body (empty when it may be shown as the run's result). `running_plan_exists` is never the
 * calculation's: the Application decides it before a run starts, so a Worker result carrying it is malformed.
 */
export function buildListOptimizationResultIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['result must be an object.']
  switch (value.status) {
    case 'optimized':
      return optimizedArtifactIssues(value.artifact)
    case 'not_found': {
      const issues = NOT_FOUND_REASONS.includes(value.reason as string) ? [] : ['result.reason must be no_structural_candidate or candidates_rejected.']
      return [...issues, ...diagnosticsIssues(value.diagnostics, 'result.diagnostics')]
    }
    case 'search_bound_reached': {
      const bounds = value.bounds
      const issues = Array.isArray(bounds) && bounds.length > 0 && bounds.every(bound => isRecord(bound) && BOUND_KINDS.includes(bound.kind as string))
        ? [] : ['result.bounds must name at least one reached search bound.']
      return [...issues, ...diagnosticsIssues(value.diagnostics, 'result.diagnostics')]
    }
    case 'unsupported': {
      const reasons = value.reasons
      return Array.isArray(reasons) && reasons.length > 0 && reasons.every(reason => isRecord(reason) && UNSUPPORTED_REASON_KINDS.includes(reason.kind as string))
        ? [] : ['result.reasons must name at least one unsupported reason the calculation decides.']
    }
    default:
      return ['result.status must be optimized, not_found, search_bound_reached or unsupported.']
  }
}
