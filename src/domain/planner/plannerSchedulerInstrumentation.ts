import type {
  BuildListEntry,
  BuildListEntryId,
  ConflictKind,
  PlanConflict,
  TargetWeaponId,
} from '../models/publicTypes'
import type {
  PlannerRouteCommitmentObserver,
  PlannerRouteCommitmentRecord,
} from './plannerRouteCommitment'
import type {
  PlannerRunResult,
  PlannerRunTerminationStatus,
  PlannerSearchRejection,
  PlannerSearchRejectionReason,
} from './plannerTypes'

/**
 * The parity / test observer of one deterministic scheduler run (Issue #103).
 *
 * It is not performance instrumentation and not a benchmark authority. The
 * Beam / scheduler parity harness (`src/benchmarks/plannerSchedulerParity.ts`)
 * reads it to explain a completion difference against the Beam Search oracle:
 * which Entries left the committed set, why (`drops`), and which provisional
 * outcome of an unresolved collision pushed them out (`provisionalOutcomes`).
 * Issue #103 Phase D-2b removed the Phase B performance part - the phase
 * timings, the detailed counters and the live progress - together with the
 * Browser benchmark harness that displayed them.
 *
 * - `undefined` is exactly the ordinary scheduler: no collector is created.
 * - When present, the collector only *reads* what the scheduler already
 *   decided. It never mutates the state, never reorders or filters an action,
 *   never calls the RNG Engine, and never changes `expandedStates` or a stop
 *   condition. The result with and without it is identical.
 * - Like `PlannerDependencies`, it carries functions and is never part of
 *   `PlannerInput`, a Worker DTO, a `PlannerResult`, a `ProductionPlan` or
 *   persistence. Its record is plain structured-clone data.
 *
 * A throw from the callback propagates unchanged.
 */
export interface PlannerSchedulerInstrumentation {
  /** Called once when the schedule ends, including the early-return paths. */
  readonly onScheduleEnd?: (metrics: PlannerSchedulerRunMetrics) => void
}

/**
 * Why an Entry left the committed set (design 6.5 / 6.8 / 7.8).
 *
 * - `initial_resolution`   an explicit resolution selected another Entry
 * - `initial_precondition` its holding unit was already passed, or its source
 *   cannot be used, when the run started
 * - `provisional_outcome`  the provisional outcome of an unresolved collision
 * - `deadlock` / `stall`   no safe action was left (7.8)
 * - `precondition`         a committed lane head broke while scheduling (6.8)
 * - `action_rejected`      the chosen route action was rejected when applied
 * - `reserve_rejected`     the immediate reserve was rejected
 */
export type PlannerSchedulerDropCause =
  | 'initial_resolution'
  | 'initial_precondition'
  | 'provisional_outcome'
  | 'deadlock'
  | 'stall'
  | 'precondition'
  | 'action_rejected'
  | 'reserve_rejected'

export interface PlannerSchedulerDropRecord {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId | null
  cause: PlannerSchedulerDropCause
  reason: PlannerSearchRejectionReason
  actionType: PlannerSearchRejection['actionType']
  /** 0 for the initial commitment, otherwise the 1-based scheduler iteration. */
  iteration: number
  /** The provisional winner the Entry collided with, for `provisional_outcome`. */
  winnerBuildListEntryId: BuildListEntryId | null
  conflictKind: ConflictKind | null
  conflictId: string | null
}

/** One decided Entry of the provisional outcome loop (6.5) and whom it pushed out. */
export interface PlannerSchedulerProvisionalOutcome {
  winnerBuildListEntryId: BuildListEntryId
  winnerTargetWeaponId: TargetWeaponId
  loserBuildListEntryIds: BuildListEntryId[]
}

/** What the parity harness reads of one scheduler run. */
export interface PlannerSchedulerRunMetrics {
  /** `false` for an input that was finished before any scheduling. */
  reachedScheduler: boolean
  expandedStates: number
  traceLength: number
  terminationStatus: PlannerRunTerminationStatus
  completedTargetCount: number
  totalTargetCount: number
  provisionalOutcomes: PlannerSchedulerProvisionalOutcome[]
  drops: PlannerSchedulerDropRecord[]
}

export interface PlannerSchedulerMetricsContext {
  instrumentation: PlannerSchedulerInstrumentation
  entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>
}

function runSummary(result: PlannerRunResult) {
  return {
    expandedStates: result.expandedStates,
    traceLength: result.bestState?.trace.length ?? 0,
    terminationStatus: result.termination.status,
    completedTargetCount: result.termination.completedTargetCount,
    totalTargetCount: result.termination.totalTargetCount,
  }
}

/**
 * The scheduler side of `PlannerSchedulerInstrumentation`. The scheduler holds
 * `null` instead of one when no instrumentation was supplied, so every hook is
 * a single optional call that does nothing.
 */
export class PlannerSchedulerMetricsCollector implements PlannerRouteCommitmentObserver {
  private readonly context: PlannerSchedulerMetricsContext
  private readonly provisionalOutcomes: PlannerSchedulerProvisionalOutcome[] = []
  private readonly drops: PlannerSchedulerDropRecord[] = []
  /** 0 while the initial commitment runs. */
  private iteration = 0
  /** The cause the next status change to `dropped` is attributed to. */
  private pendingDropCause: PlannerSchedulerDropCause | null = null
  private readonly provisionalWinnerByLoser = new Map<
    BuildListEntryId,
    { winner: BuildListEntryId; conflict: PlanConflict }
  >()

  constructor(context: PlannerSchedulerMetricsContext) {
    this.context = context
  }

  // --- PlannerRouteCommitmentObserver -----------------------------------

  provisionalOutcome(
    winner: BuildListEntry,
    losers: readonly { entry: BuildListEntry; conflict: PlanConflict }[],
  ): void {
    this.provisionalOutcomes.push({
      winnerBuildListEntryId: winner.id,
      winnerTargetWeaponId: winner.targetWeaponId,
      loserBuildListEntryIds: losers.map(({ entry }) => entry.id),
    })
    losers.forEach(({ entry, conflict }) =>
      this.provisionalWinnerByLoser.set(entry.id, { winner: winner.id, conflict }),
    )
  }

  // --- scheduler hooks --------------------------------------------------

  /** The initial commitment finished; its drops are attributed here. */
  initialCommitment(records: readonly PlannerRouteCommitmentRecord[]): void {
    records.forEach((record) => {
      if (record.status !== 'dropped' || record.rejection === null) return
      const provisional = this.provisionalWinnerByLoser.get(record.buildListEntryId)
      this.recordDrop(
        record.buildListEntryId,
        provisional !== undefined
          ? 'provisional_outcome'
          : record.rejection.reason === 'conflict_resolution_not_selected'
            ? 'initial_resolution'
            : 'initial_precondition',
        record.rejection,
        provisional,
      )
    })
  }

  /** The cause the next `dropped` status change belongs to. */
  expectDrop(cause: PlannerSchedulerDropCause): void {
    this.pendingDropCause = cause
  }

  /** One commitment status change while scheduling (6.8 / 7.8). */
  statusChange(
    entryId: BuildListEntryId,
    before: PlannerRouteCommitmentRecord['status'] | null,
    after: PlannerRouteCommitmentRecord['status'],
    rejection: PlannerSearchRejection | null,
  ): void {
    if (after === 'dropped' && before !== 'dropped' && rejection !== null) {
      this.recordDrop(entryId, this.pendingDropCause ?? 'precondition', rejection, undefined)
    }
    this.pendingDropCause = null
  }

  private recordDrop(
    entryId: BuildListEntryId,
    cause: PlannerSchedulerDropCause,
    rejection: PlannerSearchRejection,
    provisional: { winner: BuildListEntryId; conflict: PlanConflict } | undefined,
  ) {
    this.drops.push({
      buildListEntryId: entryId,
      targetWeaponId: this.context.entriesById.get(entryId)?.targetWeaponId ?? null,
      cause,
      reason: rejection.reason,
      actionType: rejection.actionType,
      iteration: this.iteration,
      winnerBuildListEntryId: provisional?.winner ?? null,
      conflictKind: provisional?.conflict.kind ?? null,
      conflictId: provisional?.conflict.id ?? null,
    })
  }

  beginIteration(): void {
    this.iteration += 1
  }

  finish(result: PlannerRunResult): void {
    this.context.instrumentation.onScheduleEnd?.({
      reachedScheduler: true,
      ...runSummary(result),
      provisionalOutcomes: this.provisionalOutcomes.map((outcome) => ({
        ...outcome,
        loserBuildListEntryIds: [...outcome.loserBuildListEntryIds],
      })),
      drops: this.drops.map((drop) => ({ ...drop })),
    })
  }
}

/**
 * `null` when no instrumentation was supplied; the context is then never
 * built, so an uninstrumented schedule does no extra work at all.
 */
export function createPlannerSchedulerMetricsCollector(
  instrumentation: PlannerSchedulerInstrumentation | undefined,
  context: () => Omit<PlannerSchedulerMetricsContext, 'instrumentation'>,
): PlannerSchedulerMetricsCollector | null {
  if (instrumentation === undefined) return null
  return new PlannerSchedulerMetricsCollector({ ...context(), instrumentation })
}

/**
 * The record of a run the scheduler finished before scheduling anything: a
 * validation failure, no planning Target, or a contradictory resolution set.
 */
export function reportUnscheduledPlannerRun(
  instrumentation: PlannerSchedulerInstrumentation | undefined,
  result: PlannerRunResult,
): void {
  instrumentation?.onScheduleEnd?.({
    reachedScheduler: false,
    ...runSummary(result),
    provisionalOutcomes: [],
    drops: [],
  })
}
