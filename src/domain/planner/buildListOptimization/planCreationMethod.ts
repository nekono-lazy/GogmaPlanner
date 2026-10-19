/**
 * The plan creation method of the Build List screen (`docs/PLANNER_SPEC.md` 17.2 U1 / 17.4, Issue #260 PR-6B1): the one shared Domain
 * judgement that decides, over a fresh PlannerInput, whether 「生産計画を作成」 runs the ordinary Planner (7章) or the Build List global
 * optimization (17章), or neither, and - when it chooses the optimization - every unsupported reason Stage 0 of the optimization
 * returns for that input, before any calculation.
 *
 * `validatePlannerInput()` is the only authority. A whole-input fail closed (`isValid === false`: a legacy duplicate, a broken
 * intermediate state selection, two selections of one Target, a preferred weapon reference violation, ...) is judged before the
 * count, and the count is `validBuildListEntries.length` - never the raw Entries, the Target groups, the stale Entries or a display
 * filter. The judgement reads no option: it validates with `defaultPlannerOptions` whatever `input.options` holds, so neither the
 * user's 「最大計画ステップ数」 nor an invalid value of it decides the method (U7). It adds no fail-closed rule of its own: a condition
 * `validatePlannerInput()` does not report (for example `selected_checkpoint_target_already_ideal`, 7.5.8) stays the ordinary
 * Planner's own result when it runs.
 *
 * The optimization's unsupported reasons are Stage 0's own (`createBuildListOptimizationContextFromValidation()` and
 * `deriveBuildListOptimizationUnsupportedReasons()`, which `runBuildListOptimization()` applies too), derived from this very
 * validation. None of them clears or rereads a selection, and none says a plan or an Ideal does not exist.
 *
 * Pure apart from the Engine's support queries: it predicts nothing, reads no persisted state, writes nothing and holds no screen
 * text. Which persisted state the input comes from, and whether a running Plan exists, is the Application's.
 */
import { defaultPlannerOptions, PERSISTED_PLANNER_BUILD_LIST_CONTEXT, type PlannerDependencies, type PlannerInput } from '../plannerTypes'
import { validatePlannerInput, validatePlannerOptions, type PlannerInputValidationResult } from '../plannerValidation'
import type { BuildListOptimizationResult, BuildListOptimizationUnsupportedReason } from './buildListOptimizationResult'
import { BuildListOptimizationInvariantError } from './buildListOptimizationTypes'
import { createBuildListOptimizationContextFromValidation } from './planningContext'
import { deriveBuildListOptimizationUnsupportedReasons } from './reachTable'

/** The two calculations 「生産計画を作成」 can run (`docs/PLANNER_SPEC.md` 17.2). */
export type PlanCreationMethod = 'ordinary_planner' | 'build_list_optimization'

/**
 * What the judgement decided (`docs/PLANNER_SPEC.md` 17.2, judgements 3 - 6). Every kind keeps the whole validation result, so the
 * typed issues, the excluded Entries and their warnings stay available for showing why nothing starts.
 */
export type PlanCreationMethodSelection =
  /** Judgement 3: the whole input fails closed. Neither method starts, whatever the count. */
  | { kind: 'invalid_planner_input'; validation: PlannerInputValidationResult }
  /** Judgement 4: no valid Entry. Nothing can be created. */
  | { kind: 'no_valid_build_list_entry'; validation: PlannerInputValidationResult }
  /** Judgement 5: one valid Entry. The ordinary Planner, on the Build List's own Routes, selections and improvement preferences. */
  | { kind: 'ordinary_planner'; validation: PlannerInputValidationResult }
  /** Judgement 6: two or more valid Entries, and Stage 0 of the optimization holds no unsupported reason. */
  | { kind: 'build_list_optimization'; validation: PlannerInputValidationResult }
  /**
   * Judgement 6, but Stage 0 of the optimization refuses this input (17.4): every reason, never only the first. The optimization
   * does not start. `ordinaryPlannerAuxiliary` says whether the ordinary Planner auxiliary operation is offered beside these reasons.
   */
  | {
      kind: 'build_list_optimization_unsupported'
      validation: PlannerInputValidationResult
      reasons: BuildListOptimizationUnsupportedReason[]
      ordinaryPlannerAuxiliary: boolean
    }

/** The method a selection runs, or null when it runs none (a refused optimization runs none until the user picks the auxiliary). */
export function planCreationMethodOf(selection: PlanCreationMethodSelection): PlanCreationMethod | null {
  switch (selection.kind) {
    case 'ordinary_planner': return 'ordinary_planner'
    case 'build_list_optimization': return 'build_list_optimization'
    case 'invalid_planner_input':
    case 'no_valid_build_list_entry':
    case 'build_list_optimization_unsupported': return null
  }
}

/**
 * The unsupported reasons of 17.4 the ordinary Planner itself can run despite (17.2 「通常Plannerの補助導線」). A running Plan, an
 * invalid input and no planning Target stop the ordinary Planner too, so they never offer it.
 */
const ORDINARY_PLANNER_RUNNABLE_UNSUPPORTED_REASON_KINDS: ReadonlySet<BuildListOptimizationUnsupportedReason['kind']> = new Set([
  'checkpoint_selection', 'unconfirmed_rng_state', 'target_without_source', 'blind_route_required',
])

/** Whether these unsupported reasons offer the ordinary Planner auxiliary operation: some reason, and every one of the four above. */
export function isOrdinaryPlannerAuxiliaryOfferedForUnsupported(reasons: readonly BuildListOptimizationUnsupportedReason[]): boolean {
  return reasons.length > 0 && reasons.every(({ kind }) => ORDINARY_PLANNER_RUNNABLE_UNSUPPORTED_REASON_KINDS.has(kind))
}

/**
 * Whether an optimization result offers the ordinary Planner auxiliary operation (`docs/PLANNER_SPEC.md` 17.2 / 17.8): `not_found`
 * and `search_bound_reached` do, `unsupported` does when its reasons do, `optimized` never does. A cancellation, a calculation
 * failure and an error are no result and never offer it; the offer never starts the ordinary Planner by itself.
 */
export function isOrdinaryPlannerAuxiliaryOfferedForResult(result: BuildListOptimizationResult): boolean {
  switch (result.status) {
    case 'optimized': return false
    case 'not_found':
    case 'search_bound_reached': return true
    case 'unsupported': return isOrdinaryPlannerAuxiliaryOfferedForUnsupported(result.reasons)
  }
}

/**
 * Judges the plan creation method of one fresh PlannerInput (`createPlannerInput()` with `conflictResolutions = []`). `dependencies`
 * are a Planner's; only the Engine is read (support queries). Throws a `RangeError` for an input carrying conflict resolutions (the
 * caller's contract), and `BuildListOptimizationInvariantError` when the optimization's Stage 0 contradicts the validation it was
 * given (never read as unsupported).
 */
export function selectPlanCreationMethod(input: PlannerInput, dependencies: PlannerDependencies): PlanCreationMethodSelection {
  if (input.conflictResolutions.length > 0) {
    throw new RangeError('The plan creation method is judged over a fresh input: it carries conflictResolutions = [].')
  }
  const validation = validatePlannerInput(input, dependencies, PERSISTED_PLANNER_BUILD_LIST_CONTEXT, validatePlannerOptions(defaultPlannerOptions))
  if (!validation.isValid) return { kind: 'invalid_planner_input', validation }
  const validCount = validation.validBuildListEntries.length
  if (validCount === 0) return { kind: 'no_valid_build_list_entry', validation }
  if (validCount === 1) return { kind: 'ordinary_planner', validation }
  const created = createBuildListOptimizationContextFromValidation(input, validation)
  if (created.kind !== 'context') {
    throw new BuildListOptimizationInvariantError('stage_contract_violation',
      `Stage 0 refused a valid input with ${validCount} valid Entries (${created.reason}: ${created.detail}).`)
  }
  const reasons = deriveBuildListOptimizationUnsupportedReasons(created.context, dependencies.rngEngine)
  if (reasons.length === 0) return { kind: 'build_list_optimization', validation }
  return { kind: 'build_list_optimization_unsupported', validation, reasons, ordinaryPlannerAuxiliary: isOrdinaryPlannerAuxiliaryOfferedForUnsupported(reasons) }
}
