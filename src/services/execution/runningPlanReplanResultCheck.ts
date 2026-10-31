import type { BuildListEntryAddition, BuildListEntryReplacement } from '../../domain/buildList/buildListEntryReplacement'
import type { RunningPlanReplanOptimizationInput } from '../../domain/execution/runningPlanReplanOptimization'
import type { ReplanTargetClassification } from '../../domain/execution/runningPlanReplanTargets'
import { deriveRunningPlanReplanBuildListAfterAdoption } from '../../domain/execution/runningPlanReplanPreview'
import type { BuildListEntry, BuildListEntryId, ProductionPlan, TargetWeaponId } from '../../domain/models/publicTypes'
import { stableStringify } from '../../domain/models/publicTypes'
import { inspectProductionPlanCompletionAssignmentSafety } from '../../domain/planner/productionPlanCompletionAssignmentSafety'
import { collectProductionPlanTargetCompletionTargetWeaponIds } from '../../domain/planner/productionPlanCompletionSummary'
import {
  calculationContextIssues,
  diagnosticsIssues,
  expectedPlanStateIssues,
  generatedBuildListEntryIssues,
  notFoundResultIssues,
  optimizedPlannerResultIssues,
  optimizedPlanSummaryIssues,
  searchBoundReachedResultIssues,
} from '../planner/buildListOptimizationResultCheck'

/**
 * The main thread's structural check of a Worker `blo_replan_result` body (`docs/PLANNER_SPEC.md` 18.6 / 18.7, Issue #276 PR-4),
 * against the request the run was started with.
 *
 * A structured-cloned result is untrusted data until it passes this check; a result that fails it is a failed run, never a Preview.
 * It shares the Build List optimization's checks of the final Planner result, the summary, the generated Entries, the input token's
 * execution state and the diagnostics, and adds the replan's own: no Planner warning at all (the replan excludes no Entry, 18.6), the
 * old Plan and the replan target set the request named, a new Plan completing exactly that set, and Entry changes that fit the
 * request's whole Build List (`deriveRunningPlanReplanBuildListAfterAdoption()`: every replan Target replaced, added or unchanged
 * exactly once, and no generated Entry ID held by any other Entry, outside the replan target set included). It re-implements no Stage
 * and re-derives no token item: the values the calculation reported are compared with each other and with the request.
 *
 * Passing it is not adoptability: the adoption re-validates the artifact against the current persisted state in its own transaction
 * (`docs/PLANNER_SPEC.md` 18.8, Issue #276 PR-5).
 */

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

/** Every reason Stage 0R decides (18.5); none of the Build List optimization's Application or planning-Target reasons. */
const REPLAN_UNSUPPORTED_REASON_KINDS = ['no_replan_target', 'invalid_planner_input', 'checkpoint_selection', 'unconfirmed_rng_state', 'target_without_source', 'blind_route_required']

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const sorted = (values: readonly string[]) => [...values].sort()
  return left.length === right.length && stableStringify(sorted(left)) === stableStringify(sorted(right))
}

function entryChangeIssues(artifact: UnknownRecord, plan: UnknownRecord | null, replanTargets: ReplanTargetClassification, request: RunningPlanReplanOptimizationInput | null): string[] {
  const { generatedBuildListEntries: generated, replacements, additions, unchangedTargetWeaponIds: unchanged } = artifact
  const issues: string[] = [...generatedBuildListEntryIssues(generated)]
  const replacementsShaped = Array.isArray(replacements) && replacements.every(value => isRecord(value) && isNonEmptyString(value.targetWeaponId)
    && isNonEmptyString(value.replacedBuildListEntryId) && isNonEmptyString(value.generatedBuildListEntryId))
  if (!replacementsShaped) issues.push('result.artifact.replacements must name a Target, the replaced Entry and the generated Entry.')
  const additionsShaped = Array.isArray(additions) && additions.every(value => isRecord(value) && isNonEmptyString(value.targetWeaponId)
    && isNonEmptyString(value.generatedBuildListEntryId))
  if (!additionsShaped) issues.push('result.artifact.additions must name a Target and the added generated Entry.')
  if (!isStringArray(unchanged)) issues.push('result.artifact.unchangedTargetWeaponIds must be a string array.')
  // Without the request (a Preview checked for its adoption), the Build List the adoption would leave is judged by the adoption itself,
  // against the then current Build List.
  if (issues.length > 0 || plan === null || !isStringArray(plan.selectedBuildListEntryIds) || request === null) return issues

  // The one Domain authority of the Build List the adoption would leave, over the request's whole Build List (not the calculation's
  // scope only): an ID collision with an Entry outside the replan target set is caught here, before any Preview exists.
  const changes = {
    replanTargetWeaponIds: [...replanTargets.replanTargetWeaponIds],
    plannerResult: { plan: { selectedBuildListEntryIds: plan.selectedBuildListEntryIds as BuildListEntryId[] } },
    generatedBuildListEntries: generated as BuildListEntry[],
    replacements: replacements as BuildListEntryReplacement[],
    additions: additions as BuildListEntryAddition[],
    unchangedTargetWeaponIds: unchanged as TargetWeaponId[],
  }
  try {
    const after = deriveRunningPlanReplanBuildListAfterAdoption(request.plannerInput.buildListEntries, changes)
    if (after.kind === 'invalid') issues.push(...after.issues.map(issue => `result.artifact: ${issue}`))
  } catch (error: unknown) {
    issues.push(`result.artifact Entry changes could not be checked (${error instanceof Error ? error.message : String(error)}).`)
  }
  return issues
}

/**
 * The issues of one `optimized` artifact against the replan target set it must belong to. With the run's `request`, it is also checked
 * against the request's whole Build List and CalculationContext; without one (a Preview checked before its adoption), those are left to
 * the adoption, which re-derives them from the then current state.
 */
function optimizedReplanArtifactIssues(artifact: unknown, replanTargets: ReplanTargetClassification, request: RunningPlanReplanOptimizationInput | null): string[] {
  if (!isRecord(artifact)) return ['result.artifact must be an object.']
  const replanIds = replanTargets.replanTargetWeaponIds

  // The final Planner result: a completed draft Plan of a new chain with no Conflict, no rejected Entry and no warning.
  const { issues, plan, termination } = optimizedPlannerResultIssues(artifact.plannerResult)
  const plannerResult = artifact.plannerResult
  if (isRecord(plannerResult) && Array.isArray(plannerResult.warnings) && plannerResult.warnings.length !== 0) {
    issues.push('result.artifact.plannerResult.warnings must be empty: the replan excludes no Entry.')
  }

  // The run it belongs to: the old Plan and the replan target set of the request, in the classification's order.
  if (artifact.planId !== replanTargets.planId) issues.push('result.artifact.planId must be the request\'s old Plan.')
  if (!isStringArray(artifact.replanTargetWeaponIds) || stableStringify(artifact.replanTargetWeaponIds) !== stableStringify(replanIds)) {
    issues.push('result.artifact.replanTargetWeaponIds must be the request\'s replan target set, in its order.')
  }

  // The summary the Preview reads, and the new Plan completing exactly the replan target set (the 9.6.9.1 authority).
  const summary = artifact.summary
  issues.push(...optimizedPlanSummaryIssues(summary, plan, termination))
  if (isRecord(summary) && summary.totalTargetCount !== replanIds.length) {
    issues.push('result.artifact.summary.totalTargetCount must be the replan target set\'s size.')
  }
  if (plan !== null) {
    let completed: readonly string[] | null = null
    try {
      completed = collectProductionPlanTargetCompletionTargetWeaponIds(plan as unknown as Pick<ProductionPlan, 'steps'>)
    } catch {
      // A Plan the Domain validation already reported as malformed.
    }
    if (completed === null || !sameIdSet(completed, replanIds)) {
      issues.push('result.artifact.plannerResult.plan must complete exactly the replan target set.')
    }
    // One weapon is the completion of one Target only (Issue #334, `docs/PLANNER_SPEC.md` 21.4.1): a new Plan planning otherwise is
    // never a Preview. A weapon assigned elsewhere since the run is the adoption's and the start's to refuse.
    let safe = false
    try {
      safe = inspectProductionPlanCompletionAssignmentSafety(plan as unknown as Pick<ProductionPlan, 'steps'>, []).safe
    } catch {
      // A Plan the Domain validation already reported as malformed.
    }
    if (!safe) issues.push('result.artifact.plannerResult.plan must not make one owned weapon the completion of two Targets.')
  }

  // Each replan Target replaced, added or unchanged once against the request's scope, and the new Plan selecting the final Entries.
  issues.push(...entryChangeIssues(artifact, plan, replanTargets, request))

  // The input token items the adoption re-checks (their derivation is the Domain's; only their shape and the reported values here).
  const token = artifact.inputToken
  if (!isRecord(token)) {
    issues.push('result.artifact.inputToken must be an object.')
  } else {
    issues.push(...expectedPlanStateIssues(token.initialExecutionState, 'result.artifact.inputToken.initialExecutionState'))
    if (!isNonEmptyString(token.replanTargetDefinitionsHash)) issues.push('result.artifact.inputToken.replanTargetDefinitionsHash must be a non-empty string.')
    if (!isNonEmptyString(token.scopeBuildListEntriesHash)) issues.push('result.artifact.inputToken.scopeBuildListEntriesHash must be a non-empty string.')
    issues.push(...calculationContextIssues(token.calculationContext, 'result.artifact.inputToken.calculationContext'))
    if (request !== null && stableStringify(token.calculationContext) !== stableStringify(request.plannerInput.calculationContext)) {
      issues.push('result.artifact.inputToken.calculationContext must be the request input\'s.')
    }
    const baseSnapshot = plan === null ? null : plan.baseSnapshot
    if (isRecord(baseSnapshot) && stableStringify(token.initialExecutionState) !== stableStringify(baseSnapshot.initialExecutionState)) {
      issues.push('result.artifact.inputToken.initialExecutionState must be the new Plan\'s initialExecutionState.')
    }
  }
  issues.push(...diagnosticsIssues(artifact.diagnostics, 'result.artifact.diagnostics'))
  return issues
}

/**
 * The issues of one `blo_replan_result` body against the run's request (empty when it may be shown as the run's result). The four
 * result classes are the calculation's (18.5 / 18.6); `not_found` and `search_bound_reached` are the whole set's and name no Target.
 */
export function runningPlanReplanResultIssues(value: unknown, request: RunningPlanReplanOptimizationInput): string[] {
  if (!isRecord(value)) return ['result must be an object.']
  switch (value.status) {
    case 'optimized':
      return optimizedReplanArtifactIssues(value.artifact, request.replanTargets, request)
    case 'not_found':
      return notFoundResultIssues(value)
    case 'search_bound_reached':
      return searchBoundReachedResultIssues(value)
    case 'unsupported': {
      const reasons = value.reasons
      return Array.isArray(reasons) && reasons.length > 0 && reasons.every(reason => isRecord(reason) && REPLAN_UNSUPPORTED_REASON_KINDS.includes(reason.kind as string))
        ? [] : ['result.reasons must name at least one unsupported reason the replan calculation decides.']
    }
    default:
      return ['result.status must be optimized, not_found, search_bound_reached or unsupported.']
  }
}

const isNullableNonEmptyString = (value: unknown): value is string | null => value === null || isNonEmptyString(value)

/** The structural issues of PR-2's classification as a Preview carries it (the shape the adoption reads). */
function replanTargetClassificationIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['preview.replanTargets must be an object.']
  const issues: string[] = []
  if (!isNonEmptyString(value.planId)) issues.push('preview.replanTargets.planId must be a non-empty string.')
  for (const key of ['plannedTargetWeaponIds', 'replanTargetWeaponIds', 'additionalCandidateTargetWeaponIds'] as const) {
    if (!isStringArray(value[key])) issues.push(`preview.replanTargets.${key} must be a string array.`)
  }
  const rowsShaped = Array.isArray(value.rows) && value.rows.every(row => isRecord(row) && isNonEmptyString(row.targetWeaponId) && isNonEmptyString(row.category))
  if (!rowsShaped) issues.push('preview.replanTargets.rows must name a Target and its category.')
  return issues
}

/**
 * The structural issues of one runtime-only replan Preview before its adoption (`docs/PLANNER_SPEC.md` 18.8 [P1], Issue #276 PR-5):
 * the old Plan's token, the classification, the start effect's preference changes and the `optimized` artifact - checked by the same
 * artifact check a Worker result passes, against the Preview's own classification. Untrusted until it passes: having passed the Worker
 * result check once is no authority. The Build List the adoption would leave and the CalculationContext are judged by the adoption
 * against the then current state, not here. Empty when the Domain may read the Preview's typed fields.
 */
export function runningPlanReplanPreviewIssues(preview: unknown): string[] {
  if (!isRecord(preview)) return ['preview must be an object.']
  const issues: string[] = []
  const token = preview.runningPlanToken
  const tokenShaped = isRecord(token) && isNonEmptyString(token.planId) && (token.status === 'active' || token.status === 'stale')
    && isNullableNonEmptyString(token.currentStepId)
  if (!tokenShaped) issues.push('preview.runningPlanToken must name the old Plan, its running status and its current Step.')
  const classificationIssues = replanTargetClassificationIssues(preview.replanTargets)
  issues.push(...classificationIssues)
  const changes = preview.startTargetLinkChanges
  const changesShaped = Array.isArray(changes) && changes.every(change => isRecord(change) && isNonEmptyString(change.targetWeaponId)
    && isNonEmptyString(change.ownedWeaponId) && isNullableNonEmptyString(change.fromTargetWeaponId) && isNullableNonEmptyString(change.replacedOwnedWeaponId))
  if (!changesShaped) issues.push('preview.startTargetLinkChanges must name each change\'s Target, weapon, released Target and replaced weapon.')
  if (classificationIssues.length > 0) return issues
  issues.push(...optimizedReplanArtifactIssues(preview.artifact, preview.replanTargets as unknown as ReplanTargetClassification, null))
  return issues
}
