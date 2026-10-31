import type {
  BuildListEntry,
  BuildListEntryId,
  PlanConflict,
} from '../models/publicTypes'
import {
  detectPlannerConflicts,
  isUnitBlockedByConflictResolution,
  plannerEntriesExcludedByWeaponDecision,
} from './plannerConflictDetection'
import type { PlannerRouteUnit } from './plannerRouteProgress'
import {
  comparePlannerSearchStates,
  createPlannerSearchStateSemanticKey,
  evaluatePlannerSearchState,
} from './plannerScoring'
import {
  entryIsRelevantForState,
  isPlannerSearchStateComplete,
} from './plannerEntryRelevance'
import {
  initialPlannerLaneProgress,
  isPlannerLaneRouteComplete,
  nextPlannerLaneUnits,
} from './plannerRouteLanes'
import { collectPreferredSourceEntryIds } from './plannerPreferredSource'
import { preparePlannerInitialContext } from './plannerInitialContext'
import {
  createPlannerTermination,
  type PlannerTerminationStateInput,
} from './plannerTermination'
import {
  addPlannerWarning,
  appendUniquePlannerRejection as appendUniqueRejection,
  applyPlannerZeroOperationConfirms,
  createPlannerInitialFailureResult,
  detectCurrentPlannerConflicts,
  isPlannerZeroOperationEntry,
  pendingPlannerReserveEntries,
  plannerConflictCountByEntryId,
  plannerConflictResolutionWarnings,
  plannerEntriesSharingCompletionWeapon,
  plannerRejectionKey,
  sortPlannerRejections,
} from './plannerSearchShared'
import {
  applyPlannerReserveAction,
  applyPlannerRouteAction,
  createPlannerSearchRejection,
  executablePlannerRequiredUnitsByCounterPosition,
  isSkippablePlannerUnitDominatedByRequiredUnit,
  type PlannerAppliedActionResult,
  type PlannerReserveActionContext,
  type PlannerRouteActionContext,
} from './plannerStateTransitions'
import type {
  PlannerDependencies,
  PlannerRunBuildListContext,
  PlannerSearchState,
} from './plannerTypes'
import {
  plannerBeamSearchLimits,
  validatePlannerBeamSearchOptions,
  type PlannerBeamSearchExecutionOptions,
  type PlannerBeamSearchInput,
  type PlannerBeamSearchLimitKind,
  type PlannerBeamSearchOptions,
  type PlannerBeamSearchResult,
  type PlannerBeamSearchTermination,
} from './plannerBeamSearchTypes'
import { PERSISTED_PLANNER_BUILD_LIST_CONTEXT } from './plannerTypes'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Whether an Entry may still act in `state`: its Target is not completed in
 * the run, and no applied explicit decision of a weapon conflict excluded it
 * (`plannerEntriesExcludedByWeaponDecision()`, Route-level and for the whole
 * run).
 */
function targetCanUseEntry(
  state: PlannerSearchState,
  entry: BuildListEntry,
  excludedByWeaponDecision: ReadonlySet<BuildListEntryId>,
): boolean {
  return !excludedByWeaponDecision.has(entry.id) && entryIsRelevantForState(state, entry)
}

/** The oracle's termination: the shared derivation over its two bounds. */
function createBeamSearchTermination({
  reachedStepLimit,
  reachedExpandedLimit,
  ...input
}: PlannerTerminationStateInput & {
  limits: PlannerBeamSearchOptions
  reachedStepLimit: boolean
  reachedExpandedLimit: boolean
}): PlannerBeamSearchTermination {
  const reachedLimits: PlannerBeamSearchLimitKind[] = [
    ...(reachedExpandedLimit ? (['max_expanded_states'] as const) : []),
    ...(reachedStepLimit ? (['max_plan_steps'] as const) : []),
  ]
  return createPlannerTermination({ ...input, reachedLimits })
}

function betterState(
  current: PlannerSearchState | null,
  candidate: PlannerSearchState,
): PlannerSearchState {
  if (current === null) return candidate
  return comparePlannerSearchStates(candidate, current) < 0
    ? candidate
    : current
}

/**
 * The bounded Beam Search (the Production Planner up to Issue #103 Phase B).
 *
 * Since Phase C it is a regression oracle only: Production
 * (`createProductionPlanWithObserver()`) runs the deterministic scheduler, and
 * this search is reached only by calling it directly from a test or the
 * Beam / scheduler parity harness (Issue #103 Phase D-2b removed its Browser
 * benchmark and its PR #107 instrumentation). Its input, bounds, termination
 * and result are its own (`plannerBeamSearchTypes.ts`, Issue #103 Phase D-2a): it takes
 * `beamWidth` / `maxExpandedStates` from `PlannerBeamSearchOptions` and
 * validates them with `validatePlannerBeamSearchOptions()`.
 */
export async function runPlannerBeamSearch(
  input: PlannerBeamSearchInput,
  dependencies: PlannerDependencies,
  executionOptions: PlannerBeamSearchExecutionOptions = {},
  buildListContext: PlannerRunBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
): Promise<PlannerBeamSearchResult> {
  const limits = plannerBeamSearchLimits(input.options)
  const prepared = preparePlannerInitialContext(
    input,
    dependencies,
    buildListContext,
    validatePlannerBeamSearchOptions(input.options),
  )
  if (prepared.status === 'invalid') {
    const failure: PlannerBeamSearchResult = createPlannerInitialFailureResult(
      limits,
      prepared.warnings,
      prepared.issues,
      prepared.excludedBuildListEntries,
      prepared.planningTargetIds,
    )
    return failure
  }
  const {
    allSearchEntries,
    allLanePlans,
    entriesById,
    excludedBuildListEntries,
    initialConflictDetection,
    initialState: preparedInitialState,
    routeUnitCountByEntryId,
    planningTargets,
    planningTargetIds,
    planningTargetsById,
    validConflictResolutions,
    warnings,
  } = prepared.context
  // Completion is one authority: every planning Target (a Target with a valid
  // BuildListEntry, never every active Target) Ideal (PLANNER_SPEC 7.2.1).
  const isComplete = (state: PlannerSearchState) =>
    isPlannerSearchStateComplete(state, planningTargetIds)
  if (planningTargetIds.length === 0) {
    // No valid BuildListEntry, so this run has no goal: the Build List is the
    // Planner input (REQUIREMENTS 18 / 19), and no active Target outside it is
    // ever substituted. Nothing can be expanded, so no Beam Search starts. The
    // validation already reported `no_build_list_entries` and each excluded
    // Entry; the termination is an ordinary `exhausted` over zero Targets.
    return {
      bestState: preparedInitialState,
      conflicts: [],
      warnings,
      validationIssues: [],
      excludedBuildListEntries,
      rejections: [...prepared.context.routePlanRejections],
      expandedStates: 0,
      completed: false,
      cancelled: false,
      termination: createBeamSearchTermination({
        limits,
        planningTargetIds,
        bestState: preparedInitialState,
        expandedStates: 0,
        cancelled: false,
        reachedStepLimit: false,
        reachedExpandedLimit: false,
      }),
    }
  }
  const rejections = [...prepared.context.routePlanRejections]
  const rejectionKeys = new Set(rejections.map(plannerRejectionKey))
  // Static Planner input, so it is derived once instead of per expansion.
  const preferredSourceEntryIds = collectPreferredSourceEntryIds(
    allSearchEntries,
    planningTargetsById,
  )
  // Every Beam successor is built on a clone of its source state; the shared
  // transition authority never decides which actions are tried.
  const reserveActionContext: PlannerReserveActionContext = {
    dependencies,
    master: input.master,
    completionAssignments: prepared.context.completionAssignments,
    preferredSourceEntryIds,
  }
  // An applied explicit decision of a weapon conflict excludes the other
  // participants for the whole run, Route-level (`docs/PLANNER_SPEC.md` 9.6.2 /
  // 21.5; the PR #341 review): they are confirmed neither at the start nor
  // later, run no unit, are progressed by no shared action and reserve nothing,
  // even when the selected Entry completes or cannot be confirmed - the loser
  // is never adopted instead. Each is reported once, as the scheduler's Route
  // commitment reports it. Counter conflicts keep their unit-level blocking.
  const excludedByWeaponDecision = plannerEntriesExcludedByWeaponDecision(initialConflictDetection.conflicts)
  excludedByWeaponDecision.forEach((entryId) => {
    const lanes = allLanePlans.get(entryId)
    const firstUnit = lanes === undefined ? undefined : nextPlannerLaneUnits(lanes, initialPlannerLaneProgress())[0]
    appendUniqueRejection(
      rejections,
      rejectionKeys,
      createPlannerSearchRejection(
        entryId,
        firstUnit?.operation.type ?? 'reserve_weapon',
        'conflict_resolution_not_selected',
        'A valid local conflict resolution selected another BuildListEntry.',
      ),
    )
  })
  // The zero-operation Entries that collide with another Entry on their weapon
  // (Issue #334 PR-3, `docs/PLANNER_SPEC.md` 21.5): the scheduler decides such
  // a pair by its Route commitment, so the oracle confirms them not at the
  // start but as ordinary expansions, and lets the scoring choose the branch.
  // A pair an explicit decision already decided is no such pair: the selected
  // Entry is confirmed at the start, like the scheduler confirms it after the
  // commitment.
  const collidingEntryIds = plannerEntriesSharingCompletionWeapon(
    allSearchEntries.filter(({ id }) => !excludedByWeaponDecision.has(id)),
  )
  const scoreContext = {
    entries: allSearchEntries,
    targetsById: planningTargetsById,
    routeUnitCountByEntryId,
    conflictCountByEntryId: new Map<BuildListEntryId, number>(),
  }
  const discoveredConflictsById = new Map<string, PlanConflict>()
  const recordDetectedConflicts = (
    detection: ReturnType<typeof detectPlannerConflicts>,
  ) => {
    detection.conflicts.forEach((conflict) => {
      if (!discoveredConflictsById.has(conflict.id)) {
        discoveredConflictsById.set(conflict.id, conflict)
      }
    })
  }
  recordDetectedConflicts(initialConflictDetection)
  // Zero-operation `confirm_owned_ideal` confirmations change no RNG state, so
  // they are applied before any expansion (`docs/PLANNER_SPEC.md` 16.3) - the
  // colliding ones excepted (above).
  const initialState = applyPlannerZeroOperationConfirms(
    preparedInitialState,
    {
      allSearchEntries,
      allLanePlans,
      planningTargetsById,
      reserveContext: reserveActionContext,
      canConfirm: (entry) => !excludedByWeaponDecision.has(entry.id) && !collidingEntryIds.has(entry.id),
    },
    'clone',
    (rejection) => appendUniqueRejection(rejections, rejectionKeys, rejection),
  )
  initialState.evaluationScore = evaluatePlannerSearchState(
    initialState,
    {
      ...scoreContext,
      conflictCountByEntryId: plannerConflictCountByEntryId(
        initialConflictDetection.conflicts,
      ),
    },
  )
  if (isComplete(initialState)) {
    plannerConflictResolutionWarnings(
      validConflictResolutions,
      discoveredConflictsById,
    ).forEach(({ kind, message }) => addPlannerWarning(warnings, kind, message))
    return {
      bestState: initialState,
      conflicts: [...discoveredConflictsById.values()].sort((left, right) =>
        compareStableStrings(left.id, right.id),
      ),
      warnings,
      validationIssues: [],
      excludedBuildListEntries,
      rejections,
      expandedStates: 0,
      completed: true,
      cancelled: false,
      termination: createBeamSearchTermination({
        limits,
        planningTargetIds,
        bestState: initialState,
        expandedStates: 0,
        cancelled: false,
        reachedStepLimit: false,
        reachedExpandedLimit: false,
      }),
    }
  }

  let beam: PlannerSearchState[] = [initialState]
  let bestPartial: PlannerSearchState | null = initialState
  let bestComplete: PlannerSearchState | null = null
  let expandedStates = 0
  let reachedExpandedLimit = false
  let reachedStepLimit = false
  let cancelled = false
  let stop = false

  while (beam.length > 0 && !stop) {
    const successors: PlannerSearchState[] = []
    for (const state of beam.sort(comparePlannerSearchStates)) {
      if (executionOptions.shouldCancel?.()) {
        cancelled = true
        stop = true
        break
      }
      if (isComplete(state)) {
        bestComplete = betterState(bestComplete, state)
        continue
      }
      if (state.trace.length >= input.options.maxPlanSteps) {
        reachedStepLimit = true
        continue
      }
      const stateConflictDetection = detectCurrentPlannerConflicts(
        state,
        allSearchEntries,
        allLanePlans,
        planningTargets,
        validConflictResolutions,
      )
      recordDetectedConflicts(stateConflictDetection)
      const conflictsById = new Map(
        stateConflictDetection.conflicts.map((conflict) => [conflict.id, conflict]),
      )
      const routeActionContext: PlannerRouteActionContext = {
        entriesById,
        lanePlans: allLanePlans,
        conflictsById,
        conflictIdsByUnitKey: stateConflictDetection.conflictIdsByUnitKey,
        selectedPhysicalActionKeysByConflictId:
          stateConflictDetection.selectedPhysicalActionKeysByConflictId,
        engine: dependencies.rngEngine,
        preferredSourceEntryIds,
        // An Entry a weapon decision excluded is never progressed by another
        // Entry's shared physical action (Route-level, above).
        canShareWithEntry: (entryId) => !excludedByWeaponDecision.has(entryId),
      }
      const isBlockedByConflictResolution = (unit: PlannerRouteUnit) =>
        isUnitBlockedByConflictResolution(
          unit,
          conflictsById,
          stateConflictDetection.conflictIdsByUnitKey,
          stateConflictDetection.selectedPhysicalActionKeysByConflictId,
          (entryId) => {
            const selected = entriesById.get(entryId)
            return selected !== undefined && entryIsRelevantForState(state, selected)
          },
        )
      const requiredUnitsByCounterPosition =
        executablePlannerRequiredUnitsByCounterPosition(
          state,
          allSearchEntries,
          allLanePlans,
          isBlockedByConflictResolution,
        )
      // A just-finished Route can be secured only now, before any other action
      // (docs/PLANNER_SPEC.md 16.3). Not securing it is a branch of its own: the
      // ordinary successors below leave that Entry unsecured for good, which is
      // how a shared physical action serves another Entry that keeps operating
      // on the same weapon.
      const pendingReserveAttempts = pendingPlannerReserveEntries(
        state,
        entriesById,
        allLanePlans,
      ).filter((entry) => !excludedByWeaponDecision.has(entry.id)).flatMap((entry) => {
        const target = planningTargetsById.get(entry.targetWeaponId)
        return target
          ? [{
              entry,
              applied: applyPlannerReserveAction(
                state,
                entry,
                target,
                reserveActionContext,
                { mode: 'clone' },
              ),
            }]
          : []
      })
      const expansionSources: { entry: BuildListEntry; reserveAttempt: PlannerAppliedActionResult | null }[] = [
        ...pendingReserveAttempts.map(({ entry, applied }) => ({ entry, reserveAttempt: applied })),
        ...allSearchEntries.map((entry) => ({ entry, reserveAttempt: null })),
      ]
      for (const { entry, reserveAttempt } of expansionSources) {
        const attempts: PlannerAppliedActionResult[] = []
        const lanes = allLanePlans.get(entry.id)
        const progress = state.routeProgressByEntryId[entry.id] ?? initialPlannerLaneProgress()
        if (reserveAttempt !== null) {
          attempts.push(reserveAttempt)
        } else if (
          state.selectedBuildListEntryIds.includes(entry.id) ||
          !lanes ||
          !targetCanUseEntry(state, entry, excludedByWeaponDecision)
        ) {
          continue
        } else if (!isPlannerLaneRouteComplete(lanes, progress)) {
          // After the base prefix, the Bonus lane and the Skill lane are both
          // candidates: the Planner, not the Route, decides their interleaving
          // (docs/PLANNER_SPEC.md 7.0.4). Every lane that can run here
          // becomes a successor, so a Skill-first and a Bonus-first branch both
          // survive.
          for (const unit of nextPlannerLaneUnits(lanes, progress)) {
            if (isBlockedByConflictResolution(unit)) {
              appendUniqueRejection(
                rejections,
                rejectionKeys,
                createPlannerSearchRejection(
                  entry.id,
                  unit.operation.type,
                  'conflict_resolution_not_selected',
                  'A valid local conflict resolution selected another BuildListEntry.',
                ),
              )
              continue
            }
            // Execution eligibility, not a conflict and not a score: another
            // Entry must physically run at this Counter position, and this unit
            // can fast-forward once it has (docs/PLANNER_SPEC.md 7.0.2). Running
            // this one first would only push the Counter past a required unit,
            // so the branch is never generated and no rejection is recorded.
            if (
              isSkippablePlannerUnitDominatedByRequiredUnit(
                unit,
                requiredUnitsByCounterPosition,
              )
            ) {
              continue
            }
            attempts.push(applyPlannerRouteAction(
              state,
              unit,
              routeActionContext,
              { mode: 'clone' },
            ))
          }
        } else if (lanes.unitCount === 0) {
          // A Route with physical units is secured only right after its last
          // unit (pendingReserveEntries); only a Route without any unit reaches
          // its reserve here: a zero-operation Candidate whose confirmation was
          // not applied at the start because it collides with another Entry on
          // its weapon (Issue #334 PR-3). Confirming it now, or running the
          // other Entry first, are the two branches the scoring chooses between.
          const target = planningTargetsById.get(entry.targetWeaponId)
          if (!target) continue
          attempts.push(applyPlannerReserveAction(
            state,
            entry,
            target,
            reserveActionContext,
            { mode: 'clone', zeroOperationConfirm: isPlannerZeroOperationEntry(entry, lanes) },
          ))
        }
        for (const applied of attempts) {
          if (applied.rejection) {
            appendUniqueRejection(
              rejections,
              rejectionKeys,
              applied.rejection,
            )
            continue
          }
          if (applied.state === null) continue
          if (expandedStates >= input.options.maxExpandedStates) {
            reachedExpandedLimit = true
            stop = true
            break
          }
          const successorConflictDetection = detectCurrentPlannerConflicts(
            applied.state,
            allSearchEntries,
            allLanePlans,
            planningTargets,
            validConflictResolutions,
          )
          recordDetectedConflicts(successorConflictDetection)
          applied.state.evaluationScore = evaluatePlannerSearchState(applied.state, {
            ...scoreContext,
            conflictCountByEntryId: plannerConflictCountByEntryId(
              successorConflictDetection.conflicts,
            ),
          })
          if (applied.state.trace.length >= input.options.maxPlanSteps) {
            reachedStepLimit = true
          }
          successors.push(applied.state)
          expandedStates += 1
          bestPartial = betterState(bestPartial, applied.state)
          if (isComplete(applied.state)) {
            bestComplete = betterState(bestComplete, applied.state)
          }
          if (expandedStates >= input.options.maxExpandedStates) {
            reachedExpandedLimit = true
            stop = true
            break
          }
          if (executionOptions.shouldCancel?.()) {
            cancelled = true
            stop = true
            break
          }
        }
        if (stop) break
      }
      if (stop) break
    }
    const deduplicated = new Map<string, PlannerSearchState>()
    successors.forEach((state) => {
      const key = createPlannerSearchStateSemanticKey(state)
      const current = deduplicated.get(key)
      if (!current || comparePlannerSearchStates(state, current) < 0) {
        deduplicated.set(key, state)
      }
    })
    const ranked = [...deduplicated.values()].sort(comparePlannerSearchStates)
    beam = ranked.slice(0, input.options.beamWidth)
    if (beam.length === 0) break
    await executionOptions.yieldControl?.()
    if (executionOptions.shouldCancel?.()) {
      cancelled = true
      break
    }
  }

  if (reachedStepLimit) {
    addPlannerWarning(
      warnings,
      'max_steps_reached',
      `Planner reached maxPlanSteps (${input.options.maxPlanSteps}).`,
    )
  }
  if (
    rejections.some(({ reason }) => reason === 'protected_destructive_use')
  ) {
    addPlannerWarning(
      warnings,
      'protected_weapon_required',
      'One or more destructive branches require a protected weapon and were not generated.',
    )
  }
  const bestState = bestComplete ?? bestPartial
  plannerConflictResolutionWarnings(
    validConflictResolutions,
    discoveredConflictsById,
  ).forEach(({ kind, message }) => addPlannerWarning(warnings, kind, message))
  const termination = createBeamSearchTermination({
    limits,
    planningTargetIds,
    bestState,
    expandedStates,
    cancelled,
    reachedStepLimit,
    reachedExpandedLimit,
  })
  return {
    bestState,
    conflicts: [...discoveredConflictsById.values()].sort((left, right) =>
      compareStableStrings(left.id, right.id),
    ),
    warnings,
    validationIssues: [],
    excludedBuildListEntries,
    rejections: sortPlannerRejections(rejections),
    expandedStates,
    completed: bestState !== null && isComplete(bestState),
    cancelled,
    termination,
  }
}
