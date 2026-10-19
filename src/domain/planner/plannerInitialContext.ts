import type {
  BuildListEntry,
  BuildListEntryId,
  DomainValidationIssue,
  DomainValidationResult,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import {
  detectPlannerConflicts,
  type PlannerConflictDetectionResult,
} from './plannerConflictDetection'
import {
  derivePlannerCheckpointRequirements,
  intermediatePinFor,
  type PlannerCheckpointRequirements,
} from './plannerCheckpoints'
import {
  remainingPlannerLaneUnits,
  splitPlannerRouteUnitsByLane,
  type PlannerEntryLanes,
} from './plannerRouteLanes'
import { entryIsRelevantForState } from './plannerEntryRelevance'
import { createInitialPlannerSearchState } from './plannerInitialState'
import { derivePlannerPlanningTargets } from './plannerPlanningTargets'
import {
  createPlannerRouteUnitPlans,
  fastForwardPlannerRouteProgress,
  type PlannerRouteUnit,
} from './plannerRouteProgress'
import type {
  ExcludedBuildListEntry,
  PlannerBuildListContext,
  PlannerConflictResolution,
  PlannerDependencies,
  PlannerInput,
  PlannerSearchRejection,
  PlannerSearchState,
  PlannerWarning,
  ValidatedBuildListEntry,
} from './plannerTypes'
import { PERSISTED_PLANNER_BUILD_LIST_CONTEXT } from './plannerTypes'
import { validatePlannerInput, type PlannerExcludedEntryWarning } from './plannerValidation'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Everything a full Planner run (the Production scheduler or the Beam Search
 * oracle) and the augmented / replacement preflight need before the first
 * expansion. It carries no preflight-specific field and applies no
 * preflight-specific conflict shortcut.
 */
export interface PlannerInitialContext {
  validBuildListEntries: readonly ValidatedBuildListEntry[]
  excludedBuildListEntries: ExcludedBuildListEntry[]
  /**
   * The typed exclusion warning of every excluded Entry, exactly as
   * `validatePlannerInput().excludedBuildListEntryWarnings` recorded it. A
   * read-only pass-through for display (the Production Plan screen's
   * interaction preparation, `docs/UI_FLOW.md` 11.6.4): no calculation reads it.
   */
  excludedBuildListEntryWarnings: readonly PlannerExcludedEntryWarning[]
  validConflictResolutions: readonly PlannerConflictResolution[]
  /** Caller-owned; validation and initial-state warnings in discovery order. */
  warnings: PlannerWarning[]
  /** Caller-owned; the createPlannerRouteUnitPlans rejections, unchanged. */
  routePlanRejections: PlannerSearchRejection[]
  /** Caller-owned full Planner run start state, already pruned to searchable Entries. */
  initialState: PlannerSearchState
  allSearchEntries: readonly BuildListEntry[]
  entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>
  allUnitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>
  /**
   * The same units split into their execution lanes, with each Entry's
   * checkpoint pin (`docs/PLANNER_SPEC.md` 7.0.4 / 7.5.2). Action
   * expansion, fast-forward and remaining-unit conflict detection all read
   * this one derivation.
   */
  allLanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>
  routeUnitCountByEntryId: ReadonlyMap<BuildListEntryId, number>
  /**
   * The planning Targets of this run (`derivePlannerPlanningTargets()`): the
   * unique planning-eligible Targets of the valid BuildListEntries, in stable
   * ID order. This is the run's one Target authority - completion, typed
   * termination, scoring, Target satisfaction, conflict detection, checkpoint
   * requirements and the Planner Alternative all read it. It is never
   * every active Target of `PlannerInput.targetWeapons`: a Target with no valid
   * Entry is not a goal of this run (`docs/PLANNER_SPEC.md` 4 / 7.2.1).
   */
  planningTargets: readonly TargetWeapon[]
  planningTargetIds: readonly TargetWeaponId[]
  planningTargetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>
  initialRelevantEntries: readonly BuildListEntry[]
  initialRelevantUnitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>
  initialConflictDetection: PlannerConflictDetectionResult
  /**
   * The Target-wide required checkpoint Entries of this run, derived from every
   * valid BuildListEntry (`docs/PLANNER_SPEC.md` 7.5.6). Relevance, completion,
   * scoring, termination and the Planner Alternative all read this one
   * map; none of them re-derives it from a conflict's participants.
   */
  checkpointRequirements: PlannerCheckpointRequirements
}

export type PlannerInitialContextResult =
  | { status: 'ready'; context: PlannerInitialContext }
  | {
      status: 'invalid'
      warnings: PlannerWarning[]
      issues: DomainValidationIssue[]
      excludedBuildListEntries: ExcludedBuildListEntry[]
      /** The same read-only pass-through as `PlannerInitialContext.excludedBuildListEntryWarnings`. */
      excludedBuildListEntryWarnings: readonly PlannerExcludedEntryWarning[]
      /** The same planning Target authority, for the unsearched termination. */
      planningTargetIds: TargetWeaponId[]
    }

/**
 * Runs the shared Planner input validation, initial state, Route unit plan,
 * initial relevant-entry selection, and initial PlanConflict detection path.
 *
 * `buildListContext` is the Build List cardinality contract of `input`
 * (`PlannerBuildListContext`); only a Planner Alternative trial passes a temporary
 * one - `temporary_augmented` for its conflict preflight, and
 * `temporary_replacement` for the replacement set.
 *
 * It is a pure Domain calculation: no persistence, Worker, React state, Clock,
 * or ID factory access. Only PlannerDependencies.rngEngine is used, because the
 * existing validation and Route unit plan creation require it.
 *
 * `optionsValidation` is the Planner option validation; it defaults to the
 * Production `validatePlannerOptions()`, and only the Beam Search oracle
 * passes its own (`validatePlannerBeamSearchOptions()`).
 */
export function preparePlannerInitialContext(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  buildListContext: PlannerBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
  optionsValidation?: DomainValidationResult,
): PlannerInitialContextResult {
  const validation = validatePlannerInput(input, dependencies, buildListContext, optionsValidation)
  const warnings = [...validation.warnings]
  if (!validation.isValid) {
    return {
      status: 'invalid',
      warnings,
      issues: validation.issues,
      excludedBuildListEntries: validation.excludedBuildListEntries,
      excludedBuildListEntryWarnings: validation.excludedBuildListEntryWarnings,
      planningTargetIds: derivePlannerPlanningTargets(
        input.targetWeapons,
        validation.validBuildListEntries,
      ).map(({ id }) => id),
    }
  }
  const initial = createInitialPlannerSearchState(
    input,
    validation.validBuildListEntries,
  )
  warnings.push(...initial.warnings)
  const planningTargets = initial.planningTargets
  const planningTargetIds = planningTargets.map(({ id }) => id)
  if (!initial.isValid || initial.state === null) {
    return {
      status: 'invalid',
      warnings,
      issues: initial.issues,
      excludedBuildListEntries: validation.excludedBuildListEntries,
      excludedBuildListEntryWarnings: validation.excludedBuildListEntryWarnings,
      planningTargetIds,
    }
  }
  const initialSearchState = initial.state
  const routePlans = createPlannerRouteUnitPlans(
    validation.validBuildListEntries.map(({ entry }) => entry),
    dependencies.rngEngine,
  )
  const allSearchEntries = validation.validBuildListEntries
    .map(({ entry }) => entry)
    .filter((entry) => routePlans.unitPlans.has(entry.id))
    .sort((left, right) => compareStableStrings(left.id, right.id))
  const planningTargetsById = new Map(
    planningTargets.map((target) => [target.id, target]),
  )
  // Violations already failed the input closed in validation, so only the
  // one-Entry-per-Target map remains here.
  const checkpointRequirements = derivePlannerCheckpointRequirements(
    validation.validBuildListEntries.map(({ entry }) => entry),
  ).requirements
  allSearchEntries.forEach((entry) => {
    const required = checkpointRequirements.requiredEntryIdByTargetId.get(
      entry.targetWeaponId,
    )
    if (required === undefined || required === entry.id) return
    warnings.push({
      kind: 'selected_checkpoint_fixes_target_entry',
      message: `BuildListEntry '${entry.id}' is not used in this run: BuildListEntry '${required}' of the same TargetWeapon '${entry.targetWeaponId}' carries a selected intermediate state and is that Target's required Route.`,
    })
  })
  const initialRelevantEntries = allSearchEntries.filter((entry) =>
    entryIsRelevantForState(initialSearchState, entry, checkpointRequirements),
  )
  const entriesById = new Map(
    allSearchEntries.map((entry) => [entry.id, entry]),
  )
  const allUnitPlans = new Map(
    allSearchEntries.flatMap((entry) => {
      const units = routePlans.unitPlans.get(entry.id)
      return units === undefined ? [] : [[entry.id, units] as const]
    }),
  )
  const allLanePlans = new Map(
    [...allUnitPlans].map(([entryId, units]) => {
      const entry = entriesById.get(entryId)
      return [
        entryId,
        splitPlannerRouteUnitsByLane(units, entry ? intermediatePinFor(entry) : null),
      ] as const
    }),
  )
  const routeUnitCountByEntryId = new Map(
    [...allUnitPlans].map(([entryId, units]) => [entryId, units.length]),
  )
  const initialState = structuredClone(initialSearchState)
  Object.keys(initialState.routeProgressByEntryId).forEach((entryId) => {
    if (!entriesById.has(entryId as BuildListEntryId)) {
      delete initialState.routeProgressByEntryId[entryId]
      delete initialState.routeRuntimeByEntryId[entryId]
      delete initialState.routeSourceVersionByEntryId[entryId]
    }
  })
  // Normally a no-op, because a Candidate Route starts at the current Counter.
  // A Route whose skippable prefix already sits behind the current Counter
  // starts at the position a full Planner run would reach, so the initial conflict
  // detection never reports an already passed prefix.
  fastForwardPlannerRouteProgress(initialState, allLanePlans)
  const initialRelevantUnitPlans = new Map(
    initialRelevantEntries.flatMap((entry) => {
      const lanes = allLanePlans.get(entry.id)
      const progress = initialState.routeProgressByEntryId[entry.id]
      return lanes === undefined || progress === undefined
        ? []
        : [[entry.id, remainingPlannerLaneUnits(lanes, progress)] as const]
    }),
  )
  const initialConflictDetection = detectPlannerConflicts(
    initialRelevantEntries,
    initialRelevantUnitPlans,
    planningTargets,
    validation.validConflictResolutions,
    false,
  )
  return {
    status: 'ready',
    context: {
      validBuildListEntries: validation.validBuildListEntries,
      excludedBuildListEntries: validation.excludedBuildListEntries,
      excludedBuildListEntryWarnings: validation.excludedBuildListEntryWarnings,
      validConflictResolutions: validation.validConflictResolutions,
      warnings,
      routePlanRejections: [...routePlans.rejections],
      initialState,
      allSearchEntries,
      entriesById,
      allUnitPlans,
      allLanePlans,
      routeUnitCountByEntryId,
      planningTargets,
      planningTargetIds,
      planningTargetsById,
      initialRelevantEntries,
      initialRelevantUnitPlans,
      initialConflictDetection,
      checkpointRequirements,
    },
  }
}
