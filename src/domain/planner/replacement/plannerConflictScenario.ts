import type {
  BuildListEntryId,
  DomainValidationIssue,
} from '../../models/publicTypes'
import type { ConstrainedSearchOrigin } from '../../search'
import {
  preparePlannerInitialContext,
  type PlannerInitialContext,
} from '../plannerInitialContext'
import type {
  ExcludedBuildListEntry,
  PlannerConflictResolution,
  PlannerDependencies,
  PlannerInput,
  PlannerWarning,
} from '../plannerTypes'
import {
  createPlannerConflictContexts,
  preparePlannerFixedConflictConstraints,
  type PlannerConflictContext,
  type PlannerFixedConflictConstraint,
} from './plannerConflictContext'
import {
  createPlannerConflictWorks,
  type PlannerConflictWork,
} from './plannerConflictWork'
import { createPlannerStartSearchOrigin } from './plannerSearchOrigin'

/**
 * The scenario preparation of one fixed conflict choice: everything a Route
 * replacement comparison needs before the first Candidate is searched
 * (PLANNER_SPEC 9.2.4.5, 9.2.4.4, 9.2.3, 9.2.3.1, 9.2.7).
 *
 * Introduced by B9-B1a as the what-if preparation, and a shared Planner Domain
 * primitive since Phase 6-B2a (PLANNER_SPEC 9.2.19.16): the Planner
 * Alternative kernel prepares every request with it. The legacy B9 what-if
 * wrapper that also used it was removed in Phase 6-B2b, and the Planner
 * Alternative what-if and actual repair above the kernel in Issue #278 PR-7.
 *
 * It reuses the existing Planner authority end to end -
 * `preparePlannerInitialContext()`, `createPlannerConflictContexts()`,
 * `preparePlannerFixedConflictConstraints()`,
 * `createPlannerStartSearchOrigin()` and `createPlannerConflictWorks()` - and
 * reimplements none of validation, initial state, entry relevance, Route unit
 * plans, or conflict detection.
 *
 * It searches no Candidate, materializes nothing, starts no full Planner run,
 * checks no bounds, and computes no distance.
 */

/** One scenario: a Planner input and the single virtual fixed authority. */
export interface PlannerConflictScenarioRequest {
  plannerInput: PlannerInput
  /**
   * A plain `PlannerConflictResolution`, so a caller never assembles a
   * transient DTO such as `PlannerConflictContext` or
   * `PlannerFixedConflictConstraint`.
   */
  scenarioResolution: PlannerConflictResolution
}

/** The ready context a Route replacement calculation consumes. */
export interface PreparedPlannerConflictScenario {
  /**
   * `request.plannerInput` with the scenario resolution merged in. The request
   * input itself is never mutated.
   */
  mergedInput: PlannerInput
  /**
   * The Planner-start Search / RNG snapshot, built from the merged input.
   * Merging a resolution changes no `ConstrainedSearchOrigin` field, so this is
   * the same origin a search over the request input would use.
   */
  origin: ConstrainedSearchOrigin
  initialContext: PlannerInitialContext
  conflictContexts: PlannerConflictContext[]
  /**
   * Every valid explicit resolution as a fixed constraint, the scenario's own
   * included. The others stay feasibility constraints for preflight
   * re-mapping and the full rerun; they are not scenario subjects.
   */
  fixedConstraints: PlannerFixedConflictConstraint[]
  /** The single scenario subject, i.e. the scenario resolution's own constraint. */
  scenarioConstraint: PlannerFixedConflictConstraint
  /**
   * One work item per unique non-fixed participant Target of the scenario
   * conflict only.
   *
   * Built from `[scenarioConstraint]` alone. Passing every fixed constraint
   * would make the other explicit resolutions scenario subjects too, which
   * 9.2.4 does not ask for.
   */
  works: PlannerConflictWork[]
}

/**
 * Why the scenario fixed constraint could not be built safely
 * (PLANNER_SPEC 9.2.4.11).
 *
 * These are control authority. A caller branches on `status` and `reason`, and
 * never on message text. The literals are unchanged from the (removed) B9
 * what-if contract that introduced them.
 */
export type PlannerConflictScenarioInvalidFixedResolutionReason =
  /**
   * `validatePlannerInput()` did not keep the scenario resolution's exact
   * (conflictKey, selectedBuildListEntryId) pair among its valid resolutions,
   * e.g. because the selected Entry is missing, stale, or otherwise excluded.
   */
  | 'scenario_resolution_not_valid'
  /**
   * At least one valid explicit resolution - the scenario's own included -
   * could not be turned into a fixed constraint. All-or-nothing: a partial
   * fixed set is never used.
   */
  | 'fixed_constraints_unresolved'
  /**
   * The prepared constraints carry no unique constraint matching the scenario
   * resolution, so the scenario subject is unknown. No substitute is chosen.
   */
  | 'scenario_constraint_missing'

/** The Planner input itself is not usable, before any scenario work starts. */
export interface PlannerConflictScenarioInputNotReadyResult {
  status: 'planner_input_not_ready'
  issues: DomainValidationIssue[]
  warnings: PlannerWarning[]
  excludedBuildListEntries: ExcludedBuildListEntry[]
}

/**
 * The scenario fixed constraint is unknown, so no comparison is started.
 *
 * No alternative fixed Entry is ever inferred from
 * `PlanConflict.recommendedBuildListEntryId`, a full Planner run bestState
 * participant, Target priority, Candidate score, Candidate category, or
 * Candidate similarity (PLANNER_SPEC 9.2.7).
 *
 * `conflictKey` and `selectedBuildListEntryId` identify the resolution that
 * failed; for `fixed_constraints_unresolved` they name the first failure in the
 * stable conflictKey order the fixed-constraint preparation reports. `detail`
 * is human-readable diagnostics only and is never a control authority.
 */
export interface PlannerConflictScenarioInvalidFixedResolutionResult {
  status: 'invalid_fixed_resolution'
  reason: PlannerConflictScenarioInvalidFixedResolutionReason
  conflictKey: string
  selectedBuildListEntryId: BuildListEntryId
  detail: string
}

/** A typed preparation failure; never a thrown error and never a parsed message. */
export type PlannerConflictScenarioFailureResult =
  | PlannerConflictScenarioInputNotReadyResult
  | PlannerConflictScenarioInvalidFixedResolutionResult

export type PlannerConflictScenarioPreparationResult =
  | { status: 'ready'; scenario: PreparedPlannerConflictScenario }
  | PlannerConflictScenarioFailureResult

/**
 * Merges the scenario resolution into a `PlannerInput` (PLANNER_SPEC 9.2.4.5).
 *
 * ```text
 * same conflictKey   -> replaced by scenarioResolution
 * other conflictKeys -> kept unchanged, in place
 * key absent         -> scenarioResolution appended
 * ```
 *
 * It repairs nothing. A malformed input carrying the same `conflictKey` twice
 * keeps two entries afterwards, so `validatePlannerInput()` still reports the
 * duplicate and the whole request fails closed. Merging never bypasses
 * validation, never de-duplicates, and never drops a resolution validation
 * would have rejected.
 *
 * The input object and its arrays are not mutated.
 */
export function mergePlannerConflictScenarioResolution(
  input: PlannerInput,
  scenarioResolution: PlannerConflictResolution,
): PlannerInput {
  const matched = input.conflictResolutions.some(
    ({ conflictKey }) => conflictKey === scenarioResolution.conflictKey,
  )
  const conflictResolutions = input.conflictResolutions.map((resolution) =>
    resolution.conflictKey === scenarioResolution.conflictKey
      ? { ...scenarioResolution }
      : resolution,
  )
  if (!matched) conflictResolutions.push({ ...scenarioResolution })
  return { ...input, conflictResolutions }
}

function invalidFixedResolution(
  reason: PlannerConflictScenarioInvalidFixedResolutionReason,
  resolution: PlannerConflictResolution,
  detail: string,
): PlannerConflictScenarioPreparationResult {
  return {
    status: 'invalid_fixed_resolution',
    reason,
    conflictKey: resolution.conflictKey,
    selectedBuildListEntryId: resolution.selectedBuildListEntryId,
    detail,
  }
}

/**
 * Prepares one scenario.
 *
 * Order (PLANNER_SPEC 9.2.4.5, 9.2.3.1):
 *
 * ```text
 * merge scenarioResolution
 *   -> preparePlannerInitialContext
 *   -> scenario resolution survived validation?
 *   -> conflict contexts
 *   -> fixed constraints for every valid explicit resolution
 *   -> the scenario's own constraint, uniquely
 *   -> Planner-start Search origin
 *   -> scenario-only conflict works
 * ```
 *
 * Every failure is a typed result. Nothing is inferred when the fixed side is
 * unknown. Bounds are the caller's own: each caller validates its own bounds
 * before it prepares a scenario.
 */
export function preparePlannerConflictScenario(
  request: PlannerConflictScenarioRequest,
  dependencies: PlannerDependencies,
): PlannerConflictScenarioPreparationResult {
  const { scenarioResolution } = request
  const mergedInput = mergePlannerConflictScenarioResolution(
    request.plannerInput,
    scenarioResolution,
  )
  const prepared = preparePlannerInitialContext(mergedInput, dependencies)
  if (prepared.status !== 'ready') {
    return {
      status: 'planner_input_not_ready',
      issues: prepared.issues,
      warnings: prepared.warnings,
      excludedBuildListEntries: prepared.excludedBuildListEntries,
    }
  }
  const context = prepared.context
  // A ready initial context does not imply the scenario survived.
  // `validatePlannerInput()` drops a resolution whose selected Entry is
  // missing, stale, or otherwise excluded with a warning only, leaving the
  // input valid. The exact pair must still be there, and no other Entry of the
  // same conflict is accepted in its place (PLANNER_SPEC 9.2.7).
  const scenarioSurvived = context.validConflictResolutions.some(
    ({ conflictKey, selectedBuildListEntryId }) =>
      conflictKey === scenarioResolution.conflictKey &&
      selectedBuildListEntryId === scenarioResolution.selectedBuildListEntryId,
  )
  if (!scenarioSurvived) {
    return invalidFixedResolution(
      'scenario_resolution_not_valid',
      scenarioResolution,
      `The scenario resolution for conflict '${scenarioResolution.conflictKey}' selecting BuildListEntry '${scenarioResolution.selectedBuildListEntryId}' is not among the currently valid Planner conflict resolutions.`,
    )
  }
  const conflictContexts = createPlannerConflictContexts(context)
  // Every valid explicit resolution, not only the scenario's: scenario work
  // must not silently drop another fixed choice, and the all-or-nothing rule
  // applies unchanged (PLANNER_SPEC 9.2.3.1).
  const fixedPreparation = preparePlannerFixedConflictConstraints(
    context,
    conflictContexts,
  )
  if (fixedPreparation.status !== 'ready') {
    const [first] = fixedPreparation.failures
    return {
      status: 'invalid_fixed_resolution',
      reason: 'fixed_constraints_unresolved',
      conflictKey: first.conflictKey,
      selectedBuildListEntryId: first.selectedBuildListEntryId,
      detail: fixedPreparation.failures
        .map(({ conflictKey, reason, detail }) => `${conflictKey}: ${reason}: ${detail}`)
        .join(' '),
    }
  }
  const fixedConstraints = fixedPreparation.constraints
  const scenarioConstraints = fixedConstraints.filter(
    ({ originalConflictId, fixedBuildListEntryId }) =>
      originalConflictId === scenarioResolution.conflictKey &&
      fixedBuildListEntryId === scenarioResolution.selectedBuildListEntryId,
  )
  if (scenarioConstraints.length !== 1) {
    return invalidFixedResolution(
      'scenario_constraint_missing',
      scenarioResolution,
      `${scenarioConstraints.length} fixed constraints match the scenario resolution for conflict '${scenarioResolution.conflictKey}'; exactly one is required.`,
    )
  }
  const scenarioConstraint = scenarioConstraints[0]
  return {
    status: 'ready',
    scenario: {
      mergedInput,
      origin: createPlannerStartSearchOrigin(mergedInput),
      initialContext: context,
      conflictContexts,
      fixedConstraints,
      scenarioConstraint,
      // Scenario-only: `createPlannerConflictWorks(fixedConstraints, ...)`
      // would turn every other explicit resolution into a scenario subject.
      works: createPlannerConflictWorks(
        [scenarioConstraint],
        conflictContexts,
        context.checkpointRequirements,
      ),
    },
  }
}
