import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeaponId,
} from '../../models/publicTypes'
import {
  resolveBuildListEntryReplacement,
  type BuildListEntryReplacement,
} from '../../buildList'
import {
  candidateStableKey,
  CandidateSearchError,
  normalizePlannerAlternativeExcludedRouteKeys,
  PlannerAlternativeSearchError,
  validatePlannerAlternativeSearchExtent,
  visitPlannerAlternativeCandidates,
} from '../../search'
import type {
  PlannerAlternativeCandidate,
  PlannerAlternativeReservation,
  PlannerAlternativeSearchExtent,
  PlannerAlternativeSearchInstrumentation,
  PlannerAlternativeSearchSummary,
} from '../../search'
import type {
  PlannerConflictResolution,
  PlannerDependencies,
  PlannerExecutionOptions,
  PlannerInput,
  PlannerResult,
  PlannerRouteCommitmentEvidence,
  PlannerRunBuildListContext,
} from '../plannerTypes'
import type { GeneratedBuildListEntryResult } from '../replacement/plannerDeterministicMaterializer'
import { preparePlannerReplacementConflictPreflight } from '../replacement/plannerAugmentedPreflight'
import type { PlannerConflictWork } from '../replacement/plannerConflictWork'
import {
  preparePlannerConflictScenario,
  type PlannerConflictScenarioFailureResult,
  type PreparedPlannerConflictScenario,
} from '../replacement/plannerConflictScenario'
import {
  createPlannerAlternativeMaterializer,
  type PlannerAlternativeMaterializer,
} from './plannerAlternativeMaterializer'
import {
  createPlannerAlternativeFullRunner,
  PlannerAlternativeCancelledError,
} from './plannerAlternativeFullRun'
import { derivePlannerAlternativeReservation } from './plannerAlternativeReservation'
import {
  assertPlannerAlternativeTrialBounds,
  createPlannerAlternativeFullRunBudget,
  judgePlannerAlternativeTrial,
  type PlannerAlternativeFullRunBudget,
  type PlannerAlternativeTrialBounds,
  type PlannerAlternativeTrialRejectionReason,
} from './plannerAlternativeTrial'

/**
 * The Phase 2 Planner Alternative kernel (`docs/PLANNER_SPEC.md` 9.2.19.2 -
 * 9.2.19.6 / 9.2.19.10 / 9.2.19.12): one Route-level decision, then for every
 * non-fixed direct participant Target of its conflict, independently and from
 * the same baseline,
 *
 * ```text
 * fixed Route set  -> resource reservation      (Planner authority only)
 *   -> Planner Alternative Search               (Search Domain, neutral input)
 *   -> deterministic materializer -> temporary Entry G
 *   -> O + G augmented preflight, -O + G replacement preflight
 *   -> full Production Plan run + Trace Replay  (createProductionPlanWithObserver)
 *   -> found (9.2.19.6), or the next Candidate
 * ```
 *
 * The Phase 4 what-if and the Phase 5 actual repair stood on it until Issue
 * #278 removed them (the scenario composition of 9.2.19.8.1 went with them in
 * PR-7); it now serves the research benchmarks and tests only. It composes no
 * scenario Plan, persists nothing, and has no Production routing, Worker
 * message or default of its own. A caller that runs further full Planner runs
 * of its own shares one rerun budget with this kernel through
 * `PlannerAlternativeKernelOptions`.
 */

/** Earlier decisions' Route exclusions of one Target (the repair lineage, Phase 5). */
export interface PlannerAlternativeRouteExclusion {
  targetWeaponId: TargetWeaponId
  /** `candidateStableKey()` values of Routes an earlier decision invalidated. */
  routeKeys: readonly string[]
}

export interface PlannerAlternativeKernelRequest {
  /**
   * The fresh baseline input with the existing explicit resolutions already
   * restored. The decision is merged into it (9.2.4.5); it is never mutated.
   */
  plannerInput: PlannerInput
  /** This decision: its conflict and the Entry the user fixed. */
  decision: PlannerConflictResolution
  /**
   * Fixed Entries of earlier decisions that are still valid (repair lineage,
   * 9.2.19.11), filtered by the caller. Each must be a valid Entry of the
   * current input; none is inferred or substituted. This list is also the
   * only authority on which restored resolutions a later decision supersedes:
   * an Entry here that this decision itself invalidates loses to it (the
   * latest decision wins) and is left out of every fixed Route set, and every
   * restored resolution of `plannerInput` selecting it is left out of this
   * request (`PreparedPlannerAlternativeKernel.supersededConflictResolutions`).
   */
  priorFixedBuildListEntryIds: readonly BuildListEntryId[]
  /** Routes earlier decisions invalidated, per Target (9.2.19.10). */
  priorExcludedRoutes: readonly PlannerAlternativeRouteExclusion[]
  extent: PlannerAlternativeSearchExtent
  bounds: PlannerAlternativeTrialBounds
}

export interface PlannerAlternativeKernelOptions {
  executionOptions?: PlannerExecutionOptions
  /**
   * The request-global `maxPlannerReruns` budget (`docs/PLANNER_SPEC.md`
   * 9.2.19.12), when a calculation above the kernel shares one budget between
   * the kernel's individual trials and its own full Planner runs. Its limit
   * must be `request.bounds.maxPlannerReruns`. Absent, the kernel creates its
   * own budget from `request.bounds`, exactly as a kernel-only request.
   */
  fullRunBudget?: PlannerAlternativeFullRunBudget
  /**
   * Optional observational instrumentation (benchmark / Research only). Every
   * Production caller leaves it undefined; see
   * `PlannerAlternativeKernelInstrumentation`.
   */
  instrumentation?: PlannerAlternativeKernelInstrumentation
}

/** The shared rerun budget as one lifecycle event saw it. */
export interface PlannerAlternativeKernelBudgetSnapshot {
  /** Full Planner runs started on the (possibly shared) budget so far. */
  used: number
  limit: number
}

export interface PlannerAlternativeKernelTargetEventBase {
  targetWeaponId: TargetWeaponId
  /** 0-based position of the Target in the stable `createPlannerConflictWorks()` order. */
  targetOrdinal: number
  targetCount: number
  budget: PlannerAlternativeKernelBudgetSnapshot
}

export interface PlannerAlternativeKernelTrialEventBase extends PlannerAlternativeKernelTargetEventBase {
  /** 0-based trial ordinal of this Target (the index its trial record gets). */
  trialIndex: number
  /** `candidateStableKey()` of the trialled Candidate. */
  candidateKey: string
}

export type PlannerAlternativeKernelTrialEventResult =
  | { status: 'found'; generatedSelected: boolean }
  | { status: 'rejected'; reason: PlannerAlternativeTrialRejectionReason | 'reused_existing_entry' | 'preflight_refused' }
  | { status: 'rerun_bound' }

/**
 * One kernel lifecycle boundary. Events carry identifiers, ordinals and counts
 * only - never a Candidate, a Route, an Entry or a PlannerResult - and no
 * timestamp: the kernel reads no clock for them.
 */
export type PlannerAlternativeKernelInstrumentationEvent =
  | ({ type: 'target_started' } & PlannerAlternativeKernelTargetEventBase)
  | ({ type: 'target_skipped_checkpoint' } & PlannerAlternativeKernelTargetEventBase)
  | ({ type: 'target_stopped_rerun_bound' } & PlannerAlternativeKernelTargetEventBase)
  | ({ type: 'search_started' } & PlannerAlternativeKernelTargetEventBase)
  | ({
      type: 'candidate_delivered'
      /** 0-based delivery ordinal of this Target's Search. */
      deliveryIndex: number
      candidateKey: string
    } & PlannerAlternativeKernelTargetEventBase)
  | ({ type: 'trial_started' } & PlannerAlternativeKernelTrialEventBase)
  | ({ type: 'preflight_started' } & PlannerAlternativeKernelTrialEventBase)
  | ({ type: 'preflight_completed'; status: 'ready' | 'refused' } & PlannerAlternativeKernelTrialEventBase)
  | ({ type: 'full_planner_run_started' } & PlannerAlternativeKernelTrialEventBase)
  | ({ type: 'full_planner_run_completed'; status: 'completed' | 'rerun_budget_reached' } & PlannerAlternativeKernelTrialEventBase)
  | ({ type: 'trial_completed'; result: PlannerAlternativeKernelTrialEventResult } & PlannerAlternativeKernelTrialEventBase)
  | ({
      type: 'search_completed'
      deliveredCandidates: number
      exhausted: boolean
      stoppedByExtent: boolean
      stoppedByConsumer: boolean
    } & PlannerAlternativeKernelTargetEventBase)
  | ({ type: 'target_completed'; outcome: PlannerAlternativeKernelOutcome['status'] } & PlannerAlternativeKernelTargetEventBase)
  | { type: 'kernel_completed'; targetCount: number; plannerRerunsUsed: number; budget: PlannerAlternativeKernelBudgetSnapshot }

/**
 * Observational kernel instrumentation (benchmark / Research only). It changes
 * no input, ordering, bound, budget or result: `onEvent` is called
 * synchronously at each lifecycle boundary, is never awaited, and its return
 * value is never read; `searchInstrumentationForTarget` only hands the existing
 * `PlannerAlternativeSearchInstrumentation` to that Target's Search, which
 * already guarantees identical Candidates, summary and prediction calls with
 * and without it. Every Production caller leaves the whole object undefined.
 */
export interface PlannerAlternativeKernelInstrumentation {
  onEvent?: (event: PlannerAlternativeKernelInstrumentationEvent) => void
  searchInstrumentationForTarget?: (
    targetWeaponId: TargetWeaponId,
    targetOrdinal: number,
  ) => PlannerAlternativeSearchInstrumentation | undefined
}

export interface PlannerAlternativeFound {
  status: 'found'
  /** The transient Search result, observational traces included. */
  candidate: PlannerAlternativeCandidate
  /** The deterministic temporary Entry `G` and its `BuildCandidate` snapshot. */
  generated: GeneratedBuildListEntryResult
  /** `O -> G` for this Target (9.2.18). */
  replacement: BuildListEntryReplacement
  /** The trial's own full run over the replacement set, Trace Replay included. */
  trialResult: PlannerResult
  /**
   * The route commitment evidence of that run (runtime-only, never persisted):
   * the provisional outcomes and each Entry's final commitment state.
   */
  trialRouteCommitment: PlannerRouteCommitmentEvidence | null
  /** False when `G` lost only a provisional outcome to an Entry outside the fixed Route set. */
  generatedSelected: boolean
}

/**
 * How one non-fixed Target ended (the 9.2.19.13 outcome statuses). Search
 * termination and trial termination stay apart: `not_found_within_search_extent`
 * means the extent was searched completely without a found Candidate,
 * `stopped_by_search_extent_bound` that the extent left reachable work
 * unchecked, and the two trial bounds that a bound stopped the trials first.
 */
export type PlannerAlternativeKernelOutcome =
  | PlannerAlternativeFound
  | { status: 'not_found_within_search_extent' }
  | { status: 'stopped_by_search_extent_bound' }
  | { status: 'stopped_by_candidate_trial_bound' }
  | { status: 'stopped_by_planner_rerun_bound' }
  /** A required checkpoint Entry of this Target: no alternative is searched (9.5.2). */
  | { status: 'blocked_by_selected_checkpoint' }

export interface PlannerAlternativeKernelTrialRecord {
  candidateKey: string
  generatedBuildListEntryId: BuildListEntryId
  result:
    | { status: 'found'; generatedSelected: boolean }
    | { status: 'rejected'; reason: PlannerAlternativeTrialRejectionReason | 'reused_existing_entry' | 'preflight_refused' }
}

export interface PlannerAlternativeKernelTargetResult {
  targetWeaponId: TargetWeaponId
  /** The Target's current Entry `O`, whose Route this decision invalidates. */
  invalidatedBuildListEntryId: BuildListEntryId
  /**
   * `candidateStableKey()` of `O`'s current Route: the key a repair lineage
   * records for this decision (9.2.19.11), never rebuilt from a Route summary.
   */
  invalidatedRouteKey: string
  /** The fixed Route set reserved against: explicit decision and prior fixed Entries, without `O`. */
  fixedRouteBuildListEntryIds: BuildListEntryId[]
  /** `null` when the Target was not searched. */
  reservation: PlannerAlternativeReservation | null
  /** `O`'s Route plus the Target's prior exclusions, as a normalized set. */
  excludedRouteKeys: string[]
  outcome: PlannerAlternativeKernelOutcome
  /** The Search summary; `null` when the Target was not searched. */
  search: (PlannerAlternativeSearchSummary & { stoppedByConsumer: boolean }) | null
  /** Every trial in order; a rejected Candidate is never recorded as a lineage exclusion. */
  trials: PlannerAlternativeKernelTrialRecord[]
  /**
   * The `candidateStableKey`s this Target's search actually reached and skipped
   * because they are in `excludedRouteKeys`, each once
   * (`PlannerAlternativeSearchExecution.skippedExcludedRouteKeys`). Empty when
   * the Target was not searched.
   */
  skippedExcludedRouteKeys: string[]
}

export type PlannerAlternativeKernelCompletedResult = Extract<PlannerAlternativeKernelResult, { status: 'completed' }>

export type PlannerAlternativeKernelResult =
  | {
      status: 'completed'
      conflictKey: string
      fixedBuildListEntryId: BuildListEntryId
      fixedTargetWeaponId: TargetWeaponId
      /** This decision's fixed Entry and every Entry a valid explicit resolution selects. */
      explicitDecisionBuildListEntryIds: BuildListEntryId[]
      /** In the stable `createPlannerConflictWorks()` order. */
      targets: PlannerAlternativeKernelTargetResult[]
      /** Full Planner runs this kernel started (its share of a shared budget). */
      plannerRerunsUsed: number
    }
  | PlannerAlternativeKernelPreparationFailure

/** A prior fixed Entry that is not a valid Entry of the current input: nothing is inferred. */
export interface PlannerAlternativeInvalidPriorFixedEntryResult {
  status: 'invalid_prior_fixed_entry'
  buildListEntryId: BuildListEntryId
  detail: string
}

export type PlannerAlternativeKernelPreparationFailure =
  | PlannerConflictScenarioFailureResult
  | PlannerAlternativeInvalidPriorFixedEntryResult

/**
 * Everything one kernel request needs before its first search: the what-if
 * preparation (9.2.4.5 merge, initial context, every valid explicit resolution
 * as a fixed constraint, the decision's own constraint, the scenario-only
 * conflict works) and the explicit decision Entries. A calculation above the
 * kernel reads the same preparation instead of preparing the input twice.
 */
export interface PreparedPlannerAlternativeKernel {
  /**
   * The what-if preparation of the effective input: the request input minus
   * the superseded prior fixed resolutions, with the decision merged in.
   */
  scenario: PreparedPlannerConflictScenario
  /** This decision's fixed Entry and every Entry an effective valid explicit resolution selects. */
  explicitDecisionBuildListEntryIds: BuildListEntryId[]
  /** Every Entry this decision invalidates: the current Entry of each non-fixed Target, in stable order. */
  invalidatedBuildListEntryIds: BuildListEntryId[]
  /**
   * Active prior fixed Entries this decision invalidates (9.2.19.11: the latest
   * decision wins), in stable order. Empty without repair lineage.
   */
  supersededPriorFixedBuildListEntryIds: BuildListEntryId[]
  /**
   * The restored explicit resolutions left out of this request because they
   * select a superseded prior fixed Entry, in their input order.
   */
  supersededConflictResolutions: PlannerConflictResolution[]
}

export type PlannerAlternativeKernelPreparationResult =
  | { status: 'ready'; prepared: PreparedPlannerAlternativeKernel }
  | PlannerAlternativeKernelPreparationFailure

/**
 * The request-entry extent check (`docs/PLANNER_SPEC.md` 9.2.19.12): the extent
 * is caller-required, so it is refused before any preparation - not only when
 * a Target's search reaches the Search Domain, which a checkpoint-blocked
 * Target or a spent budget never does. The rule itself is the Search Domain's
 * `validatePlannerAlternativeSearchExtent()`; no value is substituted,
 * completed or clamped.
 */
function assertPlannerAlternativeRequestExtent(extent: PlannerAlternativeSearchExtent): void {
  if (typeof extent !== 'object' || extent === null) {
    throw new PlannerAlternativeSearchError('invalid_input', 'extent: a PlannerAlternativeSearchExtent is required.')
  }
  const issues = validatePlannerAlternativeSearchExtent(extent)
  if (issues.length > 0) {
    throw new PlannerAlternativeSearchError(
      'invalid_input',
      issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableStrings)
}

/**
 * The current Entry `O` of one non-fixed Target of the decision: the one Entry
 * whose Route the decision invalidates. Exactly one searchable Entry per
 * Target, or the preparation broke an invariant.
 */
function invalidatedEntryOf(scenario: PreparedPlannerConflictScenario, targetWeaponId: TargetWeaponId): BuildListEntry {
  const entries = scenario.initialContext.allSearchEntries.filter(
    (entry) => entry.targetWeaponId === targetWeaponId,
  )
  if (entries.length !== 1) {
    throw new Error(
      `Planner Alternative invariant violated: TargetWeapon '${targetWeaponId}' holds ${entries.length} searchable BuildListEntries; exactly one is its current Route.`,
    )
  }
  return entries[0]
}

type TrialOutcome =
  | { status: 'found'; found: PlannerAlternativeFound }
  | {
      status: 'rejected'
      generatedBuildListEntryId: BuildListEntryId
      record: PlannerAlternativeKernelTrialRecord['result']
    }
  | { status: 'rerun_bound' }

/**
 * Prepares one kernel request.
 *
 * Preparation reuses the shared scenario preparation unchanged (`preparePlannerConflictScenario()`:
 * the 9.2.4.5 merge, `preparePlannerInitialContext()`, every valid explicit
 * resolution as a fixed constraint, the decision's own constraint, and the
 * scenario-only `createPlannerConflictWorks()`), so the fixed side is only ever
 * an explicit choice - never a recommendation, a priority or a score.
 *
 * Invalid bounds or extent throw at this entry, whether or not any Target is
 * later searched; every other failure is typed.
 */
export function preparePlannerAlternativeKernel(
  request: PlannerAlternativeKernelRequest,
  dependencies: PlannerDependencies,
): PlannerAlternativeKernelPreparationResult {
  assertPlannerAlternativeTrialBounds(request.bounds)
  assertPlannerAlternativeRequestExtent(request.extent)
  // The trial bounds were asserted above with their positive-integer rule, so
  // the shared preparation checks none.
  const prepareScenario = (plannerInput: PlannerInput) => preparePlannerConflictScenario(
    { plannerInput, scenarioResolution: request.decision },
    dependencies,
  )
  const prepared = prepareScenario(request.plannerInput)
  if (prepared.status !== 'ready') return prepared
  let scenario: PreparedPlannerConflictScenario = prepared.scenario
  const { entriesById } = scenario.initialContext

  // A prior fixed Entry is used only as it is: it must be a valid Entry of the
  // current input, never inferred, re-targeted or completed.
  for (const id of sortedUnique(request.priorFixedBuildListEntryIds)) {
    if (!entriesById.has(id)) {
      return {
        status: 'invalid_prior_fixed_entry',
        buildListEntryId: id,
        detail: `Prior fixed BuildListEntry '${id}' is not a valid Entry of the current Planner input.`,
      }
    }
  }

  // 9.2.19.11, the latest decision wins: an active prior fixed Entry this
  // decision invalidates is no longer fixed, and neither is any restored
  // explicit resolution that selects it. Those resolutions are left out of this
  // request's effective input - before the merge, so the decision itself keeps
  // its ordinary merge semantics - and the scenario is prepared again from it.
  // Nothing else is dropped: a resolution selecting any other Entry, an Entry
  // this decision leaves alone, or an Entry no active lineage fixed stays.
  const invalidatedBuildListEntryIds = invalidatedBuildListEntryIdsOf(scenario)
  const priorFixed = new Set(request.priorFixedBuildListEntryIds)
  const supersededPriorFixedBuildListEntryIds = invalidatedBuildListEntryIds.filter((id) => priorFixed.has(id))
  const superseded = new Set(supersededPriorFixedBuildListEntryIds)
  const supersededConflictResolutions = request.plannerInput.conflictResolutions.filter((resolution) =>
    resolution.conflictKey !== request.decision.conflictKey && superseded.has(resolution.selectedBuildListEntryId))
  if (supersededConflictResolutions.length > 0) {
    const effective = prepareScenario({
      ...request.plannerInput,
      conflictResolutions: request.plannerInput.conflictResolutions
        .filter((resolution) => !supersededConflictResolutions.includes(resolution)),
    })
    if (effective.status !== 'ready') return effective
    if (invalidatedBuildListEntryIdsOf(effective.scenario).join(',') !== invalidatedBuildListEntryIds.join(',')) {
      throw new Error(
        'Planner Alternative invariant violated: superseding prior fixed resolutions changed the Entries the decision invalidates.',
      )
    }
    scenario = effective.scenario
  }

  return {
    status: 'ready',
    prepared: {
      scenario,
      explicitDecisionBuildListEntryIds: sortedUnique(
        scenario.fixedConstraints.map(({ fixedBuildListEntryId }) => fixedBuildListEntryId),
      ),
      invalidatedBuildListEntryIds,
      supersededPriorFixedBuildListEntryIds,
      supersededConflictResolutions: supersededConflictResolutions.map((resolution) => ({ ...resolution })),
    },
  }
}

function invalidatedBuildListEntryIdsOf(scenario: PreparedPlannerConflictScenario): BuildListEntryId[] {
  return sortedUnique(scenario.works.map(({ targetWeaponId }) => invalidatedEntryOf(scenario, targetWeaponId).id))
}

/**
 * Runs the kernel for one decision: `preparePlannerAlternativeKernel()`, then
 * `runPreparedPlannerAlternativeKernel()`.
 *
 * Invalid bounds or extent throw; every other failure is typed. Cancellation
 * throws `PlannerAlternativeCancelledError` and returns no partial result.
 */
export async function runPlannerAlternativeKernel(
  request: PlannerAlternativeKernelRequest,
  dependencies: PlannerDependencies,
  options: PlannerAlternativeKernelOptions = {},
): Promise<PlannerAlternativeKernelResult> {
  const preparation = preparePlannerAlternativeKernel(request, dependencies)
  if (preparation.status !== 'ready') return preparation
  return runPreparedPlannerAlternativeKernel(preparation.prepared, request, dependencies, options)
}

/**
 * Searches and trials every non-fixed Target of a prepared request, each
 * independently from the same baseline (9.2.19.7). `preparedKernel` must come
 * from `preparePlannerAlternativeKernel()` over the same `request`.
 */
export async function runPreparedPlannerAlternativeKernel(
  preparedKernel: PreparedPlannerAlternativeKernel,
  request: PlannerAlternativeKernelRequest,
  dependencies: PlannerDependencies,
  options: PlannerAlternativeKernelOptions = {},
): Promise<PlannerAlternativeKernelCompletedResult> {
  assertPlannerAlternativeTrialBounds(request.bounds)
  assertPlannerAlternativeRequestExtent(request.extent)
  const { scenario, explicitDecisionBuildListEntryIds } = preparedKernel
  const { entriesById } = scenario.initialContext
  const budget = options.fullRunBudget ?? createPlannerAlternativeFullRunBudget(request.bounds)
  if (budget.limit !== request.bounds.maxPlannerReruns) {
    throw new Error(
      `Planner Alternative invariant violated: the shared rerun budget limit ${budget.limit} is not the request's maxPlannerReruns ${request.bounds.maxPlannerReruns}.`,
    )
  }
  const usedAtStart = budget.used
  const executionOptions = options.executionOptions
  const runner = createPlannerAlternativeFullRunner(budget, dependencies, executionOptions)
  const instrumentation = options.instrumentation
  const onEvent = instrumentation?.onEvent
  const budgetSnapshot = (): PlannerAlternativeKernelBudgetSnapshot => ({ used: budget.used, limit: budget.limit })
  const targetCount = scenario.works.length
  // 9.2.19.11: a prior fixed Entry this very decision invalidates is no longer
  // fixed - the latest decision wins - so no Target's search reserves its Route.
  // (Its restored resolutions were already superseded at preparation.)
  const invalidatedByDecision = new Set(preparedKernel.invalidatedBuildListEntryIds)
  const priorFixedBuildListEntryIds = request.priorFixedBuildListEntryIds
    .filter((id) => !invalidatedByDecision.has(id))

  const targets: PlannerAlternativeKernelTargetResult[] = []
  for (const [targetOrdinal, work] of scenario.works.entries()) {
    const result = await runTarget(work, targetOrdinal)
    onEvent?.({ type: 'target_completed', outcome: result.outcome.status, ...targetEventBase(work, targetOrdinal) })
    targets.push(result)
  }
  onEvent?.({ type: 'kernel_completed', targetCount, plannerRerunsUsed: budget.used - usedAtStart, budget: budgetSnapshot() })
  return {
    status: 'completed',
    conflictKey: scenario.scenarioConstraint.originalConflictId,
    fixedBuildListEntryId: scenario.scenarioConstraint.fixedBuildListEntryId,
    fixedTargetWeaponId: scenario.scenarioConstraint.fixedTargetWeaponId,
    explicitDecisionBuildListEntryIds,
    targets,
    plannerRerunsUsed: budget.used - usedAtStart,
  }

  function targetEventBase(work: PlannerConflictWork, targetOrdinal: number): PlannerAlternativeKernelTargetEventBase {
    return { targetWeaponId: work.targetWeaponId, targetOrdinal, targetCount, budget: budgetSnapshot() }
  }

  async function runTarget(work: PlannerConflictWork, targetOrdinal: number): Promise<PlannerAlternativeKernelTargetResult> {
    onEvent?.({ type: 'target_started', ...targetEventBase(work, targetOrdinal) })
    const invalidated = invalidatedEntryOf(scenario, work.targetWeaponId)
    const fixedRouteBuildListEntryIds = sortedUnique([
      ...explicitDecisionBuildListEntryIds,
      ...priorFixedBuildListEntryIds,
    ]).filter((id) => id !== invalidated.id)
    const invalidatedRouteKey = candidateStableKey(invalidated.candidateSnapshot)
    const excludedRouteKeys = normalizePlannerAlternativeExcludedRouteKeys([
      invalidatedRouteKey,
      ...request.priorExcludedRoutes
        .filter(({ targetWeaponId }) => targetWeaponId === work.targetWeaponId)
        .flatMap(({ routeKeys }) => routeKeys),
    ])
    const base = {
      targetWeaponId: work.targetWeaponId,
      invalidatedBuildListEntryId: invalidated.id,
      invalidatedRouteKey,
      fixedRouteBuildListEntryIds,
      excludedRouteKeys,
    }
    if (work.blockedBySelectedCheckpoint) {
      // A selected checkpoint is a hard constraint on this Target's Route: no
      // alternative is searched, materialized or trialled (9.5.2).
      onEvent?.({ type: 'target_skipped_checkpoint', ...targetEventBase(work, targetOrdinal) })
      return { ...base, reservation: null, outcome: { status: 'blocked_by_selected_checkpoint' }, search: null, trials: [], skippedExcludedRouteKeys: [] }
    }
    if (budget.exhausted) {
      // No full Planner run is left to judge anything for this Target.
      onEvent?.({ type: 'target_stopped_rerun_bound', ...targetEventBase(work, targetOrdinal) })
      return { ...base, reservation: null, outcome: { status: 'stopped_by_planner_rerun_bound' }, search: null, trials: [], skippedExcludedRouteKeys: [] }
    }
    const reservation = derivePlannerAlternativeReservation(
      fixedRouteBuildListEntryIds.map((id) => entriesById.get(id) as BuildListEntry),
      dependencies.rngEngine,
    )
    const materializer = createPlannerAlternativeMaterializer({
      origin: scenario.origin,
      targetWeaponId: work.targetWeaponId,
      extent: request.extent,
      reservation,
      excludedRouteKeys,
      clock: dependencies.clock,
    })
    const trials: PlannerAlternativeKernelTrialRecord[] = []
    let outcome: PlannerAlternativeKernelOutcome | null = null
    let execution
    let deliveryIndex = 0
    const targetSearchObserver = instrumentation?.searchInstrumentationForTarget?.(work.targetWeaponId, targetOrdinal)
    onEvent?.({ type: 'search_started', ...targetEventBase(work, targetOrdinal) })
    try {
      execution = await visitPlannerAlternativeCandidates(
        {
          origin: scenario.origin,
          targetWeaponId: work.targetWeaponId,
          extent: request.extent,
          reservation,
          excludedRouteKeys,
        },
        dependencies.rngEngine,
        async (candidate) => {
          if (onEvent) {
            onEvent({ type: 'candidate_delivered', deliveryIndex, candidateKey: candidateStableKey(candidate), ...targetEventBase(work, targetOrdinal) })
          }
          deliveryIndex += 1
          // Only a further Candidate proves the trial cap truncated something.
          if (trials.length >= request.bounds.maxCandidateTrialsPerTarget) {
            outcome = { status: 'stopped_by_candidate_trial_bound' }
            return 'stop'
          }
          // Nothing is materialized or preflighted without a run to judge it.
          if (budget.exhausted) {
            outcome = { status: 'stopped_by_planner_rerun_bound' }
            return 'stop'
          }
          const trialEvent = onEvent
            ? { ...targetEventBase(work, targetOrdinal), trialIndex: trials.length, candidateKey: candidateStableKey(candidate) }
            : null
          if (trialEvent) onEvent?.({ type: 'trial_started', ...trialEvent })
          const trial = await tryCandidate(candidate, invalidated, materializer, fixedRouteBuildListEntryIds, trialEvent)
          if (trialEvent) onEvent?.({ type: 'trial_completed', ...trialEvent, budget: budgetSnapshot(), result: trialEventResult(trial) })
          if (trial.status === 'rerun_bound') {
            outcome = { status: 'stopped_by_planner_rerun_bound' }
            return 'stop'
          }
          if (trial.status === 'found') {
            trials.push({
              candidateKey: candidateStableKey(candidate),
              generatedBuildListEntryId: trial.found.generated.entry.id,
              result: { status: 'found', generatedSelected: trial.found.generatedSelected },
            })
            outcome = trial.found
            return 'stop'
          }
          // A rejected trial is a judgement against this fixed Route set, not
          // a decision: it never becomes a lineage exclusion (9.2.19.10).
          trials.push({
            candidateKey: candidateStableKey(candidate),
            generatedBuildListEntryId: trial.generatedBuildListEntryId,
            result: trial.record,
          })
          return 'continue'
        },
        {
          shouldCancel: executionOptions?.shouldCancel,
          yieldControl: executionOptions?.yieldControl,
          instrumentation: targetSearchObserver,
        },
      )
    } catch (error) {
      if (error instanceof CandidateSearchError && error.code === 'cancelled') {
        throw new PlannerAlternativeCancelledError()
      }
      throw error
    }
    onEvent?.({
      type: 'search_completed',
      deliveredCandidates: execution.summary.deliveredCandidates,
      exhausted: execution.summary.exhausted,
      stoppedByExtent: execution.summary.stoppedByExtent,
      stoppedByConsumer: execution.stoppedByConsumer,
      ...targetEventBase(work, targetOrdinal),
    })
    const settled: PlannerAlternativeKernelOutcome = outcome ?? (
      execution.summary.stoppedByExtent
        ? { status: 'stopped_by_search_extent_bound' }
        : { status: 'not_found_within_search_extent' }
    )
    return {
      ...base,
      reservation,
      outcome: settled,
      search: { ...execution.summary, stoppedByConsumer: execution.stoppedByConsumer },
      trials,
      skippedExcludedRouteKeys: [...execution.skippedExcludedRouteKeys],
    }
  }

  /**
   * One Candidate's trial (9.2.19.6): `G` replaces `O` (9.2.18), every
   * explicit resolution is re-mapped over `O + G` and again over `-O + G`
   * (9.2.3.1), and the full Production Plan run over the replacement set -
   * Trace Replay included - is the only coexistence authority. A refused
   * preflight rejects this Candidate only.
   */
  async function tryCandidate(
    candidate: PlannerAlternativeCandidate,
    invalidated: BuildListEntry,
    materializer: PlannerAlternativeMaterializer,
    fixedRouteBuildListEntryIds: readonly BuildListEntryId[],
    trialEvent: PlannerAlternativeKernelTrialEventBase | null,
  ): Promise<TrialOutcome> {
    // Observation only: the same trial identity with the budget as it is now.
    const observed = (): PlannerAlternativeKernelTrialEventBase | null =>
      (trialEvent ? { ...trialEvent, budget: budgetSnapshot() } : null)
    const generated = materializer.materializeBuildListEntry(candidate, scenario.mergedInput.buildListEntries)
    // A current Entry with this exact semantic content is already in the
    // input: for this Target that is its own Entry `O`, which the decision
    // invalidates, so it is no alternative.
    if (generated.reusedExisting) {
      return { status: 'rejected', generatedBuildListEntryId: generated.entry.id, record: { status: 'rejected', reason: 'reused_existing_entry' } }
    }
    const resolved = resolveBuildListEntryReplacement(scenario.mergedInput.buildListEntries, generated.entry)
    if (resolved.status !== 'ready' || resolved.replacement.replacedBuildListEntryId !== invalidated.id) {
      throw new Error(
        `Planner Alternative invariant violated: the temporary Entry of TargetWeapon '${invalidated.targetWeaponId}' does not replace its current Entry '${invalidated.id}'.`,
      )
    }
    const replacements = [resolved.replacement]
    const preflightStarted = observed()
    if (preflightStarted) onEvent?.({ type: 'preflight_started', ...preflightStarted })
    const preflight = preparePlannerReplacementConflictPreflight(
      {
        ...scenario.mergedInput,
        buildListEntries: [...scenario.mergedInput.buildListEntries, generated.entry],
      },
      replacements,
      scenario.fixedConstraints,
      scenario.conflictContexts,
      dependencies,
    )
    const preflightCompleted = observed()
    if (preflightCompleted) {
      onEvent?.({ type: 'preflight_completed', status: preflight.status === 'ready' ? 'ready' : 'refused', ...preflightCompleted })
    }
    if (preflight.status !== 'ready') {
      return { status: 'rejected', generatedBuildListEntryId: generated.entry.id, record: { status: 'rejected', reason: 'preflight_refused' } }
    }
    const runContext: PlannerRunBuildListContext = { kind: 'temporary_replacement', replacements }
    // A blocked full run is a typed stop. Every other failure - Plan generation
    // (a Trace Replay failure included), prediction, Planner or Search
    // invariant - propagates unchanged, never becoming a rejection.
    const runStarted = observed()
    if (runStarted) onEvent?.({ type: 'full_planner_run_started', ...runStarted })
    const run = await runner.run(preflight.resolvedInput, runContext)
    const runCompleted = observed()
    if (runCompleted) {
      onEvent?.({ type: 'full_planner_run_completed', status: run === 'rerun_budget_reached' ? 'rerun_budget_reached' : 'completed', ...runCompleted })
    }
    if (run === 'rerun_budget_reached') return { status: 'rerun_bound' }
    const verdict = judgePlannerAlternativeTrial(run.result, {
      generatedBuildListEntryId: generated.entry.id,
      explicitDecisionBuildListEntryIds,
      fixedRouteBuildListEntryIds,
      routeCommitment: run.routeCommitment,
    })
    if (verdict.status === 'rejected') {
      return { status: 'rejected', generatedBuildListEntryId: generated.entry.id, record: verdict }
    }
    return {
      status: 'found',
      found: {
        status: 'found',
        candidate,
        generated,
        replacement: resolved.replacement,
        trialResult: run.result,
        trialRouteCommitment: run.routeCommitment,
        generatedSelected: verdict.generatedSelected,
      },
    }
  }
}

/** The observational form of one trial outcome (no Candidate, Entry or PlannerResult). */
function trialEventResult(trial: TrialOutcome): PlannerAlternativeKernelTrialEventResult {
  if (trial.status === 'found') return { status: 'found', generatedSelected: trial.found.generatedSelected }
  if (trial.status === 'rerun_bound') return { status: 'rerun_bound' }
  return trial.record.status === 'rejected'
    ? { status: 'rejected', reason: trial.record.reason }
    : { status: 'found', generatedSelected: trial.record.generatedSelected }
}
