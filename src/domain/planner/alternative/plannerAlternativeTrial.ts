import type {
  BuildListEntryId,
  DomainValidationIssue,
  DomainValidationResult,
} from '../../models/publicTypes'
import type {
  PlannerResult,
  PlannerRouteCommitmentEvidence,
  ProductionPlanGenerationObserver,
} from '../plannerTypes'

/**
 * The caller-supplied trial bounds of one Planner Alternative kernel request
 * (`docs/PLANNER_SPEC.md` 9.2.19.12): the trial and rerun meanings of the
 * former B9 what-if bounds (removed in Phase 6-B2b). The Domain never
 * substitutes, clamps or completes a value;
 * `defaultPlannerAlternativeTrialBounds` is the value Phase 3-C decided for the
 * what-if and the actual repair. No Production caller passes it since Issue
 * #278 removed both (PR-4 / PR-7); Issue #154 research reads it as a
 * calculation condition, so its name and value stay.
 */
export interface PlannerAlternativeTrialBounds {
  /** Candidate trials per non-fixed Target before that Target stops. */
  maxCandidateTrialsPerTarget: number
  /**
   * Full Planner runs one request may start - every Candidate trial's run and
   * every runtime-unsupported retry inside Production Plan generation. Search,
   * reservation derivation, materialization, preflight and validation are
   * never counted.
   */
  maxPlannerReruns: number
}

/**
 * The Production default trial bounds, decided in Phase 3-C
 * (`docs/PLANNER_SPEC.md` 9.2.19.12,
 * `docs/PLANNER_ALTERNATIVE_BROWSER_WORKER_BENCHMARK.md` 12 / 13).
 *
 * - Candidate trials 2: Phase 3-B found no Production workload whose first
 *   Candidate is rejected and whose second is found, so 2 is not a measured
 *   semantic threshold; neither is 1 proven sufficient. 2 keeps one fallback
 *   trial as a safety bound (one Issue #101 trial took about 0.36 s).
 * - Planner reruns 8: in the Phase 3-B `kernel_multi_target` fixture 1 rerun
 *   stops the second Target and 2 or more complete both; an unused cap costs
 *   nothing because only the runs needed start. 8 is a Production safety bound
 *   with headroom for several non-fixed Targets, second trials and
 *   runtime-unsupported retries sharing the request-global budget; the fixture
 *   itself needed 2. It was decided independently of the former B9 what-if
 *   default (removed in Phase 6-B2b).
 *
 * Callers explicitly pass it (for example as a spread copy); it is never an
 * implicit Domain fallback, a field-completion target or a clamp.
 */
export const defaultPlannerAlternativeTrialBounds: PlannerAlternativeTrialBounds = {
  maxCandidateTrialsPerTarget: 2,
  maxPlannerReruns: 8,
}

function positiveIntegerIssue(value: number, path: string): DomainValidationIssue | null {
  return Number.isInteger(value) && value >= 1
    ? null
    : { path, code: 'invalid_integer', message: `${path} must be an integer greater than or equal to 1.` }
}

export function validatePlannerAlternativeTrialBounds(
  bounds: PlannerAlternativeTrialBounds,
): DomainValidationResult {
  const issues = [
    positiveIntegerIssue(bounds.maxCandidateTrialsPerTarget, 'maxCandidateTrialsPerTarget'),
    positiveIntegerIssue(bounds.maxPlannerReruns, 'maxPlannerReruns'),
  ].filter((issue): issue is DomainValidationIssue => issue !== null)
  return { isValid: issues.length === 0, issues }
}

/** An invalid `PlannerAlternativeTrialBounds`: a caller contract violation, never an outcome. */
export class PlannerAlternativeTrialBoundsError extends Error {
  readonly issues: DomainValidationIssue[]

  constructor(issues: DomainValidationIssue[]) {
    super(`Invalid PlannerAlternativeTrialBounds: ${issues.map(({ path, message }) => `${path}: ${message}`).join(' ')}`)
    this.name = 'PlannerAlternativeTrialBoundsError'
    this.issues = issues
  }
}

export function assertPlannerAlternativeTrialBounds(bounds: PlannerAlternativeTrialBounds): void {
  const validation = validatePlannerAlternativeTrialBounds(bounds)
  if (!validation.isValid) throw new PlannerAlternativeTrialBoundsError(validation.issues)
}

/** The rerun budget refused a full Planner run: a typed stop, never a rejection. */
export class PlannerAlternativeRerunLimitError extends Error {
  readonly limit: number
  readonly used: number

  constructor(limit: number, used: number) {
    super(`Planner Alternative bound 'maxPlannerReruns' blocked a full Planner run (limit ${limit}, used ${used}).`)
    this.name = 'PlannerAlternativeRerunLimitError'
    this.limit = limit
    this.used = used
  }
}

/**
 * The shared `maxPlannerReruns` budget of one request, shaped as the
 * `ProductionPlanGenerationObserver` that `createProductionPlanWithObserver()`
 * calls before every full Planner run it starts - and only then.
 */
export interface PlannerAlternativeFullRunBudget extends ProductionPlanGenerationObserver {
  readonly limit: number
  readonly used: number
  /** Every affordable full run has been started. On its own this is no truncation. */
  readonly exhausted: boolean
}

export function createPlannerAlternativeFullRunBudget(
  bounds: PlannerAlternativeTrialBounds,
): PlannerAlternativeFullRunBudget {
  assertPlannerAlternativeTrialBounds(bounds)
  const limit = bounds.maxPlannerReruns
  let used = 0
  return {
    get limit() { return limit },
    get used() { return used },
    get exhausted() { return used >= limit },
    beforePlannerRun() {
      if (used >= limit) throw new PlannerAlternativeRerunLimitError(limit, used)
      used += 1
    },
  }
}

export interface PlannerAlternativeTrialJudgeContext {
  /** The temporary Entry `G` of the trial. */
  generatedBuildListEntryId: BuildListEntryId
  /**
   * The explicit decision Entries: this decision's fixed Entry and every Entry
   * a valid explicit resolution of the merged input selects. Each must stay
   * selected.
   */
  explicitDecisionBuildListEntryIds: readonly BuildListEntryId[]
  /**
   * The fixed Route set of this Target's search: the explicit decision
   * Entries plus the still valid repair-lineage fixed Entries, without the
   * invalidated Entry. `G` must not conflict with any of them.
   */
  fixedRouteBuildListEntryIds: readonly BuildListEntryId[]
  /**
   * The route commitment evidence of the very full run the Plan was built
   * from (`PlannerRunResult.routeCommitment`, the last run of Production Plan
   * generation), or `null` when that run made no route commitment.
   */
  routeCommitment: PlannerRouteCommitmentEvidence | null
}

export type PlannerAlternativeTrialRejectionReason =
  /** The trial run produced no Plan. */
  | 'no_plan'
  /** A trial Plan leaves an explicit decision Entry unselected. */
  | 'explicit_decision_not_selected'
  /** A trial conflict has `G` and a fixed Route Entry as participants. */
  | 'conflicts_with_fixed_route'
  /**
   * `G` is not selected, and its only drop was not a provisional outcome of an
   * unresolved conflict with an Entry outside the fixed Route set: a stall /
   * deadlock drop, a precondition, validation, source, protection or
   * checkpoint failure, a rejected action or reserve, or no commitment at all.
   */
  | 'not_selected'

export type PlannerAlternativeTrialVerdict =
  | { status: 'found'; generatedSelected: boolean }
  | { status: 'rejected'; reason: PlannerAlternativeTrialRejectionReason }

/**
 * The formal found judgement of `docs/PLANNER_SPEC.md` 9.2.19.6 over one trial
 * run's `PlannerResult` from the Production path (`createProductionPlanWithObserver()`,
 * whose Plan exists only after its Trace Replay passed; a replay failure
 * throws instead of returning a Plan). `G` is found when all of these hold:
 *
 * 1. `plan !== null`
 * 2. every explicit decision Entry is selected
 * 3. no trial conflict has `G` and a fixed Route Entry as participants
 * 4. `G` is selected, or the only reason `G` is not is that it was the
 *    non-adopted side of an unresolved conflict's provisional outcome against
 *    an Entry outside the fixed Route set
 *
 * Condition 4's second branch reads the route commitment evidence of that run,
 * recorded where commitment took the decision: `G`'s final commitment state is
 * the very drop a provisional outcome made (`provisionalOutcome !== null`),
 * whose adopted side is outside the fixed Route set, and every rejection the
 * run recorded for `G` is that `conflict_not_committed` drop. Whether the
 * adopted side itself survives to the Plan is deliberately not asked: a winner
 * that later stalls does not change why `G` was left out. An Entry that won
 * and then stalled, or was dropped for any other reason, carries no
 * provisional outcome and is not found.
 *
 * Nothing else is consulted: no Counter comparison, no `usedCounters`
 * shortcut, no Candidate score, no priority, no `recommendedBuildListEntryId`,
 * and `completed === true` is not required.
 */
export function judgePlannerAlternativeTrial(
  result: PlannerResult,
  context: PlannerAlternativeTrialJudgeContext,
): PlannerAlternativeTrialVerdict {
  const plan = result.plan
  if (plan === null) return { status: 'rejected', reason: 'no_plan' }
  const generated = context.generatedBuildListEntryId
  const selected = new Set(plan.selectedBuildListEntryIds)
  if (!context.explicitDecisionBuildListEntryIds.every((id) => selected.has(id))) {
    return { status: 'rejected', reason: 'explicit_decision_not_selected' }
  }
  const fixed = new Set(context.fixedRouteBuildListEntryIds)
  if (result.conflicts.some(({ buildListEntryIds }) =>
    buildListEntryIds.includes(generated) && buildListEntryIds.some((id) => fixed.has(id)))) {
    return { status: 'rejected', reason: 'conflicts_with_fixed_route' }
  }
  if (selected.has(generated)) return { status: 'found', generatedSelected: true }
  const commitment = context.routeCommitment?.entries.find(
    ({ buildListEntryId }) => buildListEntryId === generated,
  )
  const provisionalLoss =
    commitment !== undefined &&
    commitment.status === 'dropped' &&
    commitment.provisionalOutcome !== null &&
    !fixed.has(commitment.provisionalOutcome.selectedBuildListEntryId) &&
    commitment.rejectionReasons.length > 0 &&
    commitment.rejectionReasons.every((reason) => reason === 'conflict_not_committed')
  return provisionalLoss
    ? { status: 'found', generatedSelected: false }
    : { status: 'rejected', reason: 'not_selected' }
}
