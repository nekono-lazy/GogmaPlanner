import type {
  BuildListEntry,
  BuildListEntryId,
  PlanConflict,
  TargetWeaponId,
  TargetWeapon,
} from '../models/publicTypes'
import { isBlindCreateNormalArtianOperation } from '../models/publicTypes'
import {
  isUnitBlockedByConflictResolution,
  plannerConflictResolutionRefusalWarnings,
  plannerRouteUnitKey,
} from './plannerConflictDetection'
import {
  entryIsRelevantForState,
  isPlannerSearchStateComplete,
} from './plannerEntryRelevance'
import {
  preparePlannerInitialContext,
  type PlannerInitialContext,
} from './plannerInitialContext'
import {
  canCommitPlannerRoute,
  comparePlannerCommitmentPriority,
  createPlannerRouteCommitment,
  explicitlyPreferredBuildListEntryIds,
  type PlannerRouteCommitmentContext,
  type PlannerRouteCommitmentRecord,
  type PlannerRouteCommitmentStatus,
} from './plannerRouteCommitment'
import {
  initialPlannerLaneProgress,
  isPlannerLaneUnitHolding,
  nextPlannerLaneUnits,
  remainingPlannerLaneUnits,
  type PlannerEntryLanes,
  type PlannerLaneProgress,
  type PlannerRouteLane,
} from './plannerRouteLanes'
import {
  currentPlannerCounterValue,
  plannerWeaponOperationSubjectKey,
  type PlannerRouteUnit,
} from './plannerRouteProgress'
import { evaluatePlannerSearchState } from './plannerScoring'
import {
  createPlannerSchedulerMetricsCollector,
  reportUnscheduledPlannerRun,
  type PlannerSchedulerMetricsCollector,
} from './plannerSchedulerInstrumentation'
import {
  comparePlannerScheduleActions,
  plannerScheduleStreamKey,
  plannerScheduleStreamRank,
  type PlannerScheduleAction,
  type PlannerScheduleActionKind,
} from './plannerSchedulerOrdering'
import {
  addPlannerWarning,
  appendUniquePlannerRejection,
  applyPlannerZeroOperationConfirms,
  createPlannerInitialFailureResult,
  detectCurrentPlannerConflicts,
  pendingPlannerReserveEntries,
  plannerConflictCountByEntryId,
  plannerRejectionKey,
  sortPlannerRejections,
} from './plannerSearchShared'
import {
  applyPlannerReserveAction,
  applyPlannerRouteAction,
  createPlannerSearchRejection,
  isPlannerImprovementPreferenceViolation,
  mergedPlannerProgressedEntries,
  plannerRouteUnitPreconditionRejection,
  plannerRouteUnitSourceRejection,
  type PlannerReserveActionContext,
  type PlannerRouteActionContext,
} from './plannerStateTransitions'
import { createPlannerRunTermination, plannerRunLimits } from './plannerTermination'
import type { PlannerSchedulerInstrumentation } from './plannerSchedulerInstrumentation'
import type {
  PlannerDependencies,
  PlannerExecutionOptions,
  PlannerInput,
  PlannerRunResult,
  PlannerConflictProvisionalOutcome,
  PlannerRouteCommitmentEvidence,
  PlannerRunBuildListContext,
  PlannerSearchRejection,
  PlannerSearchState,
} from './plannerTypes'
import { PERSISTED_PLANNER_BUILD_LIST_CONTEXT } from './plannerTypes'

/**
 * The deterministic Planner scheduler (Issue #103 Phase A,
 * `docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 4 / 6 / 7).
 *
 * Route commitment decides which Targets' Routes this run executes; the
 * scheduler then drives **one** `PlannerSearchState` forward: at every step it
 * lists the safe actions of the stream frontiers, picks exactly one by the
 * canonical order, applies it in place, and immediately reserves every
 * committed Entry that action completed. It builds no successor array, keeps
 * no beam, deduplicates nothing, and reads neither `evaluationScore` nor the
 * preferred source to decide anything.
 *
 * Every state transition goes through the shared authority
 * (`plannerStateTransitions.ts`), so its trace is an ordinary Planner trace
 * that `replayPlannerSearchTrace()` verifies unchanged.
 *
 * Since Issue #103 Phase C this is the Production full Planner run:
 * `createProductionPlanWithObserver()` runs it for the ordinary Planner, the
 * Planner Worker, the Planner Alternative trials and the replan Preview. The
 * Beam Search stays a test / parity regression oracle only.
 */

/**
 * The scheduler's test hook on top of the Production `PlannerExecutionOptions`
 * (Issue #103 Phase D-2a / D-2b). The Production Worker and Plan generation
 * pass only `shouldCancel` / `yieldControl`; the observer is semantics-neutral
 * and reaches no Worker protocol, `PlannerResult`, or persistence.
 */
export interface PlannerScheduleExecutionOptions extends PlannerExecutionOptions {
  /**
   * The parity / test observer of each deterministic scheduler run: the drops
   * and provisional outcomes that explain a completion difference against the
   * Beam Search oracle. `undefined` runs exactly the ordinary scheduler
   * (`plannerSchedulerInstrumentation.ts`).
   */
  schedulerInstrumentation?: PlannerSchedulerInstrumentation
}

/** How many applied actions pass between two `yieldControl()` calls. */
export const PLANNER_SCHEDULER_YIELD_INTERVAL = 64

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** One Counter stream frontier unit (7.2) and its classification. */
interface FrontierUnit {
  readonly entry: BuildListEntry
  readonly unit: PlannerRouteUnit
  /**
   * `isPlannerLaneUnitHolding()`: never skippable, so another Entry may not
   * consume this position (5). A pin-blocked skippable unit is not holding.
   */
  readonly holding: boolean
  /** Runnable now: next lane unit, preconditions met, not resolution-blocked. */
  readonly ready: boolean
}

/** What one scheduler step did. */
export type PlannerScheduleStepOutcome =
  /** One route action was applied, plus the reserves it made due. */
  | 'applied'
  /** No action was applied; the commitment changed (a deadlock / stall drop). */
  | 'dropped'
  /** Nothing is left to schedule: every committed Route finished or was dropped. */
  | 'finished'
  /** A `PlannerOptions` bound stopped the schedule before the next action. */
  | 'bounded'

/**
 * One scheduler run over one prepared Planner input.
 *
 * `runPlannerDeterministicSchedule()` drives it to the end; tests may drive it
 * step by step. It owns its single state and mutates it in place.
 */
export class PlannerDeterministicScheduleRun {
  readonly input: PlannerInput
  readonly context: PlannerInitialContext
  /** The one schedule state; every action is applied to it in place. */
  readonly state: PlannerSearchState
  expandedStates = 0
  reachedStepLimit = false
  /**
   * Planning Targets whose `confirm_owned_ideal` `maxPlanSteps` withheld: they
   * hold their Ideal, but their Step is missing, so they are never complete.
   */
  readonly unconfirmedTargetIds = new Set<TargetWeaponId>()

  private readonly records = new Map<BuildListEntryId, PlannerRouteCommitmentRecord>()
  /** The provisional outcomes of the initial route commitment (runtime evidence). */
  private provisionalOutcomes: PlannerConflictProvisionalOutcome[] = []
  /** The very drop record each provisional outcome gave its losers. */
  private readonly provisionalDrops = new Map<
    BuildListEntryId,
    { rejection: PlannerSearchRejection; conflictId: string; selectedBuildListEntryId: BuildListEntryId }
  >()
  /**
   * The very drop record each deadlock / stall drop gave its Entry, with
   * whether its `pending` held another committed Entry with remaining units
   * (runtime evidence only, Issue #121).
   */
  private readonly stuckDrops = new Map<
    BuildListEntryId,
    { rejection: PlannerSearchRejection; otherPendingRoutes: boolean }
  >()
  private readonly rejections: PlannerSearchRejection[]
  private readonly rejectionKeys: Set<string>
  private readonly conflictsById = new Map<string, PlanConflict>()
  /** The Entries the applied explicit resolutions prefer (`explicitlyPreferredBuildListEntryIds()`). */
  private readonly preferredEntryIds: ReadonlySet<BuildListEntryId>
  private readonly commitmentContext: PlannerRouteCommitmentContext
  private readonly routeActionContext: PlannerRouteActionContext
  private readonly reserveActionContext: PlannerReserveActionContext
  /** `null` unless `executionOptions.schedulerInstrumentation` was given. */
  private readonly metrics: PlannerSchedulerMetricsCollector | null

  constructor(
    input: PlannerInput,
    dependencies: PlannerDependencies,
    context: PlannerInitialContext,
    executionOptions: PlannerScheduleExecutionOptions,
  ) {
    this.input = input
    this.context = context
    this.state = context.initialState
    this.metrics = createPlannerSchedulerMetricsCollector(
      executionOptions.schedulerInstrumentation,
      () => ({ entriesById: context.entriesById }),
    )
    this.rejections = [...context.routePlanRejections]
    this.rejectionKeys = new Set(this.rejections.map(plannerRejectionKey))
    context.initialConflictDetection.conflicts.forEach((conflict) =>
      this.conflictsById.set(conflict.id, conflict),
    )
    this.preferredEntryIds = explicitlyPreferredBuildListEntryIds(context.initialConflictDetection)
    // The preferred source is not a scheduler input (6.7): no Entry counts as
    // preferred, so `preferredSourceProgressCount` never moves.
    const preferredSourceEntryIds = new Set<BuildListEntryId>()
    this.reserveActionContext = {
      dependencies,
      targets: context.planningTargets,
      master: input.master,
      preferredSourceEntryIds,
      requirements: context.checkpointRequirements,
    }
    const detection = context.initialConflictDetection
    this.routeActionContext = {
      entriesById: context.entriesById,
      lanePlans: context.allLanePlans,
      conflictsById: new Map(detection.conflicts.map((conflict) => [conflict.id, conflict])),
      conflictIdsByUnitKey: detection.conflictIdsByUnitKey,
      selectedPhysicalActionKeysByConflictId: detection.selectedPhysicalActionKeysByConflictId,
      targets: context.planningTargets,
      master: input.master,
      engine: dependencies.rngEngine,
      preferredSourceEntryIds,
      requirements: context.checkpointRequirements,
      // Only committed Routes are executed, so only they share an action (7.5).
      canShareWithEntry: (entryId) => this.statusOf(entryId) === 'committed',
    }
    this.commitmentContext = {
      allSearchEntries: context.allSearchEntries,
      allLanePlans: context.allLanePlans,
      entriesById: context.entriesById,
      planningTargets: context.planningTargets,
      planningTargetsById: context.planningTargetsById,
      checkpointRequirements: context.checkpointRequirements,
      initialConflictDetection: context.initialConflictDetection,
      initialRelevantEntries: context.initialRelevantEntries,
    }
  }

  /**
   * The zero-operation confirmations and the initial Route commitment.
   * Returns the refusal message of a malformed resolution set, or `null`.
   *
   * A `confirm_owned_ideal` is a PlanStep like any other action, so it goes
   * through the same `maxPlanSteps` authority (Issue #103 Phase D-1): no
   * confirmation is applied once the trace holds `maxPlanSteps` actions, and
   * one that fills the trace exactly reports the bound as a diagnostic.
   */
  initialize(): string | null {
    const context = this.context
    applyPlannerZeroOperationConfirms(
      this.state,
      {
        allSearchEntries: context.allSearchEntries,
        allLanePlans: context.allLanePlans,
        planningTargetsById: context.planningTargetsById,
        checkpointRequirements: context.checkpointRequirements,
        reserveContext: this.reserveActionContext,
      },
      'in_place',
      (rejection) => this.recordRejection(rejection),
      {
        canApply: () => this.canApplyAction(),
        onWithheld: (targetId) => this.unconfirmedTargetIds.add(targetId),
      },
    )
    // Exact bound, as `actionApplied()` records it for an ordinary action.
    if (this.state.trace.length >= this.input.options.maxPlanSteps) {
      this.reachedStepLimit = true
    }
    const commitment = createPlannerRouteCommitment(
      this.state,
      this.commitmentContext,
      this.metrics ?? undefined,
    )
    if (commitment.status === 'invalid') return commitment.message
    commitment.records.forEach((record, entryId) => this.records.set(entryId, record))
    this.provisionalOutcomes = commitment.provisionalOutcomes.map((outcome) => ({
      ...outcome,
      rejectedBuildListEntryIds: [...outcome.rejectedBuildListEntryIds],
    }))
    commitment.provisionalOutcomes.forEach(({ conflictId, selectedBuildListEntryId, rejectedBuildListEntryIds }) =>
      rejectedBuildListEntryIds.forEach((entryId) => {
        const rejection = commitment.records.get(entryId)?.rejection
        if (rejection) this.provisionalDrops.set(entryId, { rejection, conflictId, selectedBuildListEntryId })
      }))
    commitment.rejections.forEach((rejection) => this.recordRejection(rejection))
    this.metrics?.initialCommitment([...commitment.records.values()])
    return null
  }

  /** The runtime commitment of every searchable Entry, in stable ID order. */
  commitmentRecords(): PlannerRouteCommitmentRecord[] {
    return [...this.records.values()].sort((left, right) =>
      compareStableStrings(left.buildListEntryId, right.buildListEntryId),
    )
  }

  statusOf(entryId: BuildListEntryId): PlannerRouteCommitmentStatus | null {
    return this.records.get(entryId)?.status ?? null
  }

  isComplete(): boolean {
    if (this.unconfirmedTargetIds.size > 0) return false
    return isPlannerSearchStateComplete(
      this.state,
      this.context.planningTargetIds,
      this.context.checkpointRequirements,
    )
  }

  private recordRejection(rejection: PlannerSearchRejection) {
    appendUniquePlannerRejection(this.rejections, this.rejectionKeys, rejection)
  }

  private setStatus(
    entryId: BuildListEntryId,
    status: PlannerRouteCommitmentStatus,
    rejection: PlannerSearchRejection | null = null,
  ) {
    this.metrics?.statusChange(entryId, this.statusOf(entryId), status, rejection)
    this.records.set(entryId, { buildListEntryId: entryId, status, rejection })
    if (rejection !== null) this.recordRejection(rejection)
  }

  private committedEntries(): BuildListEntry[] {
    return this.context.allSearchEntries.filter(
      ({ id }) => this.statusOf(id) === 'committed',
    )
  }

  private lanesOf(entry: BuildListEntry): PlannerEntryLanes | undefined {
    return this.context.allLanePlans.get(entry.id)
  }

  private progressOf(entry: BuildListEntry) {
    return this.state.routeProgressByEntryId[entry.id] ?? initialPlannerLaneProgress()
  }

  private remainingUnitsOf(entry: BuildListEntry): PlannerRouteUnit[] {
    const lanes = this.lanesOf(entry)
    return lanes === undefined ? [] : remainingPlannerLaneUnits(lanes, this.progressOf(entry))
  }

  /**
   * The dynamic conflicts of this state, deduplicated by conflict ID (8.5).
   *
   * An explicit resolution applies only to the initial conflicts route
   * commitment acted on (`docs/PLANNER_SPEC.md` 9.6.4), so a dynamic conflict
   * is detected without any: it is never reported as decided when nothing
   * enforced that decision.
   */
  private collectDynamicConflicts() {
    detectCurrentPlannerConflicts(
      this.state,
      this.context.allSearchEntries,
      this.context.allLanePlans,
      this.context.planningTargets,
      [],
      this.context.checkpointRequirements,
    ).conflicts.forEach((conflict) => {
      if (!this.conflictsById.has(conflict.id)) this.conflictsById.set(conflict.id, conflict)
    })
  }

  /**
   * The dynamic commitment events of 6.8, judged in the current state.
   *
   * - a committed Entry that was reserved becomes `secured`
   * - a committed Entry whose Target another Entry satisfied is released and
   *   holds no position any more
   * - a committed Entry whose lane head cannot run any more - its source is
   *   gone, protected or superseded, or its holding position was passed - is
   *   dropped with that rejection
   * - an Entry that was not needed (or released) whose Target lost its Ideal
   *   in flight is committed again when it is executable and collides with
   *   no committed Entry; a committed Entry is never pushed out
   */
  refreshCommitment(): void {
    let changed = false
    for (const entry of this.committedEntries()) {
      if (this.state.selectedBuildListEntryIds.includes(entry.id)) {
        this.setStatus(entry.id, 'secured')
        continue
      }
      if (!entryIsRelevantForState(this.state, entry, this.context.checkpointRequirements)) {
        this.setStatus(entry.id, 'released')
        changed = true
        continue
      }
      const broken = this.laneHeadRejection(entry)
      if (broken !== null) {
        this.setStatus(entry.id, 'dropped', broken)
        changed = true
      }
    }
    for (const entry of this.context.allSearchEntries) {
      const status = this.statusOf(entry.id)
      if (status !== 'not_needed' && status !== 'released') continue
      if (!entryIsRelevantForState(this.state, entry, this.context.checkpointRequirements)) continue
      const committed = this.committedEntries()
      if (committed.some(({ targetWeaponId }) => targetWeaponId === entry.targetWeaponId)) continue
      if (
        canCommitPlannerRoute(
          this.state,
          entry,
          committed,
          this.commitmentContext,
        )
      ) {
        this.setStatus(entry.id, 'committed')
        changed = true
      }
    }
    if (changed) this.collectDynamicConflicts()
  }

  /**
   * The unit of `lane` that stands at or ahead of the lane's current Counter
   * position: the lane head, or - past the skippable units whose position
   * another Entry already consumed - the first unit the Counter has not
   * passed yet (or a passed holding unit, which is lost).
   *
   * They differ only while the checkpoint pin blocks a skippable head: its
   * position may be consumed (5 "holding"), but its progress waits at the pin
   * and `fastForwardPlannerRouteProgress()` passes it only once the pin is
   * released (`docs/PLANNER_SPEC.md` 7.5.2). Every other passed skippable head
   * was already fast-forwarded. The units behind such a head keep their own
   * holding: a holding unit here still makes its position wait, and a passed
   * one still fails the Route closed.
   */
  private laneFrontierUnit(
    lanes: PlannerEntryLanes,
    progress: PlannerLaneProgress,
    lane: PlannerRouteLane,
  ): PlannerRouteUnit | undefined {
    for (let index = progress[lane]; index < lanes[lane].length; index += 1) {
      const unit = lanes[lane][index]
      if (isPlannerLaneUnitHolding(unit) || unit.counterBefore === null) return unit
      const current = currentPlannerCounterValue(this.state, unit)
      if (current === null || current <= unit.counterBefore) return unit
    }
    return undefined
  }

  /**
   * Why a committed Entry's Route can no longer run (6.8), judged at its lane
   * frontier units (`laneFrontierUnit()`) - a lane is sequential, so a holding
   * unit behind the current Counter is always one of them, and every unit of
   * one Route operates the same source weapon: a holding unit whose position
   * the Counter already passed, or a lane head whose source weapon is gone,
   * protected, or superseded (`plannerRouteUnitSourceRejection()`, the
   * precondition the unit meets when it actually runs). A passed skippable
   * unit is never a reason, pin-blocked or not: it is fast-forwarded once its
   * progress may move.
   */
  private laneHeadRejection(entry: BuildListEntry): PlannerSearchRejection | null {
    const lanes = this.lanesOf(entry)
    if (lanes === undefined) return null
    const progress = this.progressOf(entry)
    const heads = (['base', 'bonus', 'skill'] as const).flatMap((lane) => {
      const head = lanes[lane][progress[lane]]
      return head === undefined ? [] : [head]
    })
    const frontierUnits = (['base', 'bonus', 'skill'] as const).flatMap((lane) => {
      const unit = this.laneFrontierUnit(lanes, progress, lane)
      return unit === undefined ? [] : [unit]
    })
    for (const unit of frontierUnits) {
      if (!isPlannerLaneUnitHolding(unit)) continue
      if (unit.counterStream === null || unit.counterBefore === null) continue
      const current = currentPlannerCounterValue(this.state, unit)
      if (current !== null && current > unit.counterBefore) {
        return createPlannerSearchRejection(
          entry.id,
          unit.operation.type,
          'counter_before_current',
          `The current counter ${current} has already passed required position ${unit.counterBefore}, and this operation cannot be skipped.`,
        )
      }
    }
    for (const unit of heads) {
      const sourceIssue = plannerRouteUnitSourceRejection(this.state, entry, unit)
      if (sourceIssue !== null) return sourceIssue
    }
    return null
  }

  private isBlockedByResolution(unit: PlannerRouteUnit): boolean {
    const context = this.routeActionContext
    return isUnitBlockedByConflictResolution(
      unit,
      context.conflictsById,
      context.conflictIdsByUnitKey,
      context.selectedPhysicalActionKeysByConflictId,
      (entryId) => {
        const selected = this.context.entriesById.get(entryId)
        return (
          selected !== undefined &&
          entryIsRelevantForState(this.state, selected, this.context.checkpointRequirements)
        )
      },
    )
  }

  private isReady(entry: BuildListEntry, unit: PlannerRouteUnit, next: readonly PlannerRouteUnit[]) {
    return (
      next.includes(unit) &&
      plannerRouteUnitPreconditionRejection(this.state, entry, unit) === null &&
      !this.isBlockedByResolution(unit)
    )
  }

  /**
   * Every safe action of the current state, in canonical order (7.3 / 7.7).
   * Evaluating them builds no state: only the one returned first is applied.
   */
  safeActions(): PlannerScheduleAction[] {
    const committed = this.committedEntries()
    const frontiers = new Map<string, FrontierUnit[]>()
    const blindUnits: FrontierUnit[] = []
    const pendingNormalCounterIds = new Set<string>()
    for (const entry of committed) {
      const lanes = this.lanesOf(entry)
      if (lanes === undefined) continue
      const progress = this.progressOf(entry)
      const next = nextPlannerLaneUnits(lanes, progress)
      remainingPlannerLaneUnits(lanes, progress).forEach((unit) => {
        if (unit.counterStream === 'normal' && unit.counterId !== null) {
          pendingNormalCounterIds.add(unit.counterId)
        }
      })
      // Each lane's unit at or ahead of the current Counter: a pin-blocked
      // skippable head the Counter passed does not hide the holding unit
      // behind it (`laneFrontierUnit()`).
      const heads = (['base', 'bonus', 'skill'] as const).flatMap((lane) => {
        const unit = this.laneFrontierUnit(lanes, progress, lane)
        return unit === undefined ? [] : [unit]
      })
      for (const unit of heads) {
        const streamKey = plannerScheduleStreamKey(unit)
        if (streamKey === null) {
          if (unit.lane !== 'base' || !next.includes(unit)) continue
          blindUnits.push({ entry, unit, holding: true, ready: this.isReady(entry, unit, next) })
          continue
        }
        if (currentPlannerCounterValue(this.state, unit) !== unit.counterBefore) continue
        // A pin-blocked skippable unit is neither holding nor ready: another
        // Entry's ready unit may consume this position, and the Entry's own
        // progress waits at the pin (5, 7.3).
        const holding = isPlannerLaneUnitHolding(unit)
        const frontier = frontiers.get(streamKey) ?? []
        frontier.push({ entry, unit, holding, ready: this.isReady(entry, unit, next) })
        frontiers.set(streamKey, frontier)
      }
    }

    const actions: PlannerScheduleAction[] = []
    for (const [streamKey, frontier] of frontiers) {
      const holdings = frontier.filter(({ holding }) => holding)
      if (holdings.length > 0) {
        // Only the one physical action that runs every holding unit here is
        // safe; a holding unit that is not ready makes the position wait.
        const primary = holdings.find(({ ready }) => ready)
        if (!primary) continue
        const progressed = mergedPlannerProgressedEntries(
          this.state,
          primary.unit,
          this.routeActionContext,
        )
        const progressedKeys = new Set(progressed.map(plannerRouteUnitKey))
        if (holdings.every(({ unit }) => progressedKeys.has(plannerRouteUnitKey(unit)))) {
          actions.push(this.createAction('holding', streamKey, primary, progressed))
        }
        continue
      }
      for (const executor of frontier) {
        if (!executor.ready) continue
        actions.push(
          this.createAction(
            'executor',
            streamKey,
            executor,
            mergedPlannerProgressedEntries(this.state, executor.unit, this.routeActionContext),
          ),
        )
      }
    }
    for (const blind of blindUnits) {
      if (!blind.ready) continue
      const operation = blind.unit.operation
      if (
        operation.type !== 'create_normal_artian' ||
        !isBlindCreateNormalArtianOperation(operation)
      ) continue
      // A blind forge advances a confirmed Normal Counter, so it waits while a
      // committed predicted forge still needs a position on that stream (7.3).
      const counterId = `${operation.weaponTypeId}:${operation.rarity}`
      const counter = this.state.currentNormalCounters.find(({ id }) => id === counterId)
      const confirmed = counter !== undefined && counter.isConfirmed && counter.counter !== null
      if (confirmed && pendingNormalCounterIds.has(counterId)) continue
      actions.push(this.createAction('blind_forge', null, blind, [blind.unit]))
    }
    return actions.sort(comparePlannerScheduleActions)
  }

  private createAction(
    kind: PlannerScheduleActionKind,
    streamKey: string | null,
    primary: FrontierUnit,
    progressedUnits: readonly PlannerRouteUnit[],
  ): PlannerScheduleAction {
    const targetsById = this.context.planningTargetsById
    const entriesById = this.context.entriesById
    const progressedEntries = progressedUnits.flatMap((unit) => {
      const entry = entriesById.get(unit.entryId)
      return entry ? [{ entry, unit }] : []
    })
    const maxTargetPriority = Math.max(
      ...progressedEntries.map(({ entry }) => targetsById.get(entry.targetWeaponId)?.priority ?? 0),
    )
    const addsImprovementPreferenceViolation = progressedEntries.some(({ entry, unit }) => {
      const lanes = this.lanesOf(entry)
      return (
        lanes !== undefined &&
        isPlannerImprovementPreferenceViolation(
          this.state,
          entry,
          lanes,
          this.progressOf(entry),
          unit,
        )
      )
    })
    const subject = plannerWeaponOperationSubjectKey(primary.unit.entryId, primary.unit.operation)
    const last = this.state.lastWeaponOperationSubjectKey
    const addsWeaponSwitch = subject !== null && last !== null && last !== subject
    const current = currentPlannerCounterValue(this.state, primary.unit)
    // The executor Entry's next holding unit on this stream; whether a pin
    // blocks it now is not part of the distance (7.7 key 4).
    const nextHolding =
      kind === 'executor'
        ? this.remainingUnitsOf(primary.entry).find(
            (unit) =>
              unit !== primary.unit &&
              unit.counterStream === primary.unit.counterStream &&
              unit.counterId === primary.unit.counterId &&
              isPlannerLaneUnitHolding(unit),
          )
        : undefined
    const executorHoldingDistance =
      kind !== 'executor'
        ? 0
        : nextHolding?.counterBefore === undefined ||
            nextHolding.counterBefore === null ||
            current === null
          ? Number.POSITIVE_INFINITY
          : nextHolding.counterBefore - current
    return {
      kind,
      streamKey,
      primary: primary.unit,
      progressedUnits,
      orderKey: {
        maxTargetPriority,
        addsImprovementPreferenceViolation,
        addsWeaponSwitch,
        executorHoldingDistance,
        minRemainingPendingUnits: Math.min(
          ...progressedEntries.map(({ entry }) => this.remainingUnitsOf(entry).length),
        ),
        streamRank: plannerScheduleStreamRank(streamKey),
        streamKey: streamKey ?? `blind:${primary.entry.id}`,
        counterBefore: primary.unit.counterBefore ?? -1,
        primaryBuildListEntryId: primary.entry.id,
        unitKey: plannerRouteUnitKey(primary.unit),
      },
    }
  }

  /**
   * Checks the one scheduler bound before an action is applied (14.1).
   * `false` means the schedule stops here.
   *
   * `maxPlanSteps` alone bounds the schedule (Issue #103 Phase D-1 / D-2a):
   * it is the whole Production `PlannerOptions`, so no hidden bound can stop a
   * Production run that the user allowed more Plan steps.
   */
  private canApplyAction(): boolean {
    if (this.state.trace.length >= this.input.options.maxPlanSteps) {
      this.reachedStepLimit = true
      return false
    }
    return true
  }

  /**
   * One applied route action or reserve (the start confirmations are not
   * counted). Besides the count, it records that a bound was reached: a
   * schedule that completes on exactly its last affordable action still
   * reports the bound in `reachedLimits`, and `createPlannerRunTermination()`
   * alone decides the status (`docs/PLANNER_SPEC.md` 7.2.1).
   */
  private actionApplied() {
    // One constructed state per applied action (14.2): the state itself,
    // updated in place. The count stays a diagnostic; it is never a bound.
    this.expandedStates += 1
    if (this.state.trace.length >= this.input.options.maxPlanSteps) {
      this.reachedStepLimit = true
    }
  }

  private targetOf(entry: BuildListEntry): TargetWeapon | undefined {
    return this.context.planningTargetsById.get(entry.targetWeaponId)
  }

  /**
   * Reserves, right away and in Entry ID order, every committed Entry the last
   * physical action completed (7.6). A non-committed Entry is never reserved.
   * `false` means a bound stopped the schedule.
   */
  private reserveCompletedEntries(): boolean {
    for (;;) {
      const entry = pendingPlannerReserveEntries(
        this.state,
        this.context.entriesById,
        this.context.allLanePlans,
        this.context.checkpointRequirements,
      ).find(({ id }) => this.statusOf(id) === 'committed')
      if (entry === undefined) return true
      if (!this.reserve(entry)) return false
    }
  }

  /** A committed Route without any unit is reserved as soon as it is committed. */
  private reserveUnitlessEntries(): boolean {
    for (const entry of this.committedEntries()) {
      const lanes = this.lanesOf(entry)
      if (lanes === undefined || lanes.unitCount !== 0) continue
      if (!entryIsRelevantForState(this.state, entry, this.context.checkpointRequirements)) continue
      if (!this.reserve(entry)) return false
    }
    return true
  }

  private reserve(entry: BuildListEntry): boolean {
    const target = this.targetOf(entry)
    if (target === undefined) {
      this.metrics?.expectDrop('reserve_rejected')
      this.setStatus(entry.id, 'dropped', createPlannerSearchRejection(
        entry.id,
        'reserve_weapon',
        'inventory_precondition_failed',
        'The BuildListEntry Target is not a planning Target of this run.',
      ))
      return true
    }
    if (!this.canApplyAction()) return false
    const applied = applyPlannerReserveAction(
      this.state,
      entry,
      target,
      this.reserveActionContext,
      { mode: 'in_place' },
    )
    if (applied.rejection !== null) {
      this.metrics?.expectDrop('reserve_rejected')
      this.setStatus(entry.id, 'dropped', applied.rejection)
      return true
    }
    this.setStatus(entry.id, 'secured')
    this.actionApplied()
    return true
  }

  /**
   * Drops the committed Entry ranked last when no safe action remains while
   * committed Routes are pending: a deadlock or a stall (7.8). The ranking is
   * `R` with every explicitly preferred Entry before the rest
   * (`docs/PLANNER_SPEC.md` 9.6.4), which is exactly `R` without resolutions.
   *
   * Beside the drop it records, as runtime evidence only, whether `pending`
   * held another Entry than the one dropped (`stuckDrops`, Issue #121); which
   * Entry is dropped, and when, does not read it.
   */
  private dropStuckEntry(pending: readonly BuildListEntry[]) {
    const rank = (left: BuildListEntry, right: BuildListEntry) =>
      comparePlannerCommitmentPriority(
        left,
        right,
        this.preferredEntryIds,
        this.context.planningTargetsById,
        this.context.initialRelevantEntries,
      )
    const loser = [...pending].sort(rank).at(-1)
    if (loser === undefined) return
    const stalled = this.hasStalledStream(pending)
    const unit = this.remainingUnitsOf(loser)[0]
    this.metrics?.expectDrop(stalled ? 'stall' : 'deadlock')
    const rejection = createPlannerSearchRejection(
      loser.id,
      unit?.operation.type ?? 'reserve_weapon',
      'conflict_not_committed',
      stalled
        ? `BuildListEntry '${loser.id}' was dropped: a Counter stream stalled with no committed operation at its current position.`
        : `BuildListEntry '${loser.id}' was dropped: the committed Routes wait on each other (deadlock).`,
    )
    this.stuckDrops.set(loser.id, {
      rejection,
      otherPendingRoutes: pending.some(({ id }) => id !== loser.id),
    })
    this.setStatus(loser.id, 'dropped', rejection)
    this.collectDynamicConflicts()
  }

  /** Whether some stream has pending units, none of them at its current position. */
  private hasStalledStream(pending: readonly BuildListEntry[]): boolean {
    const byStream = new Map<string, boolean>()
    pending.forEach((entry) => {
      this.remainingUnitsOf(entry).forEach((unit) => {
        const streamKey = plannerScheduleStreamKey(unit)
        if (streamKey === null) return
        const atCurrent = currentPlannerCounterValue(this.state, unit) === unit.counterBefore
        byStream.set(streamKey, (byStream.get(streamKey) ?? false) || atCurrent)
      })
    })
    return [...byStream.values()].some((atCurrent) => !atCurrent)
  }

  /**
   * One scheduler step: the dynamic commitment events, then exactly one route
   * action (with the reserves it makes due), or one deadlock / stall drop.
   */
  step(): PlannerScheduleStepOutcome {
    this.metrics?.beginIteration()
    this.refreshCommitment()
    if (!this.reserveUnitlessEntries()) return 'bounded'
    this.refreshCommitment()
    const pending = this.committedEntries().filter(
      (entry) => this.remainingUnitsOf(entry).length > 0,
    )
    if (this.isComplete() || pending.length === 0) return 'finished'
    const action = this.safeActions()[0]
    if (action === undefined) {
      this.dropStuckEntry(pending)
      return 'dropped'
    }
    if (!this.canApplyAction()) return 'bounded'
    const applied = applyPlannerRouteAction(
      this.state,
      action.primary,
      this.routeActionContext,
      { mode: 'in_place' },
    )
    if (applied.rejection !== null) {
      // The state was not written (Phase A0 contract); the Entry is dropped
      // and the schedule continues without it (6.8).
      this.metrics?.expectDrop('action_rejected')
      this.setStatus(action.primary.entryId, 'dropped', applied.rejection)
      this.collectDynamicConflicts()
      return 'dropped'
    }
    this.actionApplied()
    if (!this.reserveCompletedEntries()) return 'bounded'
    return 'applied'
  }

  /**
   * The runtime evidence of this run's route commitment decisions
   * (`PlannerRouteCommitmentEvidence`). An Entry's `provisionalOutcome` is set
   * only when its final record is still the very drop a provisional outcome
   * made, and its `stuckDrop` only when it is the very deadlock / stall drop:
   * a dropped Entry never changes status again, so that drop is its only one.
   * Read-only: it changes no decision and no other result field.
   */
  private routeCommitmentEvidence(rejections: readonly PlannerSearchRejection[]): PlannerRouteCommitmentEvidence {
    return {
      provisionalOutcomes: this.provisionalOutcomes.map((outcome) => ({
        ...outcome,
        rejectedBuildListEntryIds: [...outcome.rejectedBuildListEntryIds],
      })),
      entries: this.commitmentRecords().map(({ buildListEntryId, status, rejection }) => {
        const drop = this.provisionalDrops.get(buildListEntryId)
        const stuck = this.stuckDrops.get(buildListEntryId)
        return {
          buildListEntryId,
          status,
          provisionalOutcome: status === 'dropped' && drop !== undefined && rejection === drop.rejection
            ? { conflictId: drop.conflictId, selectedBuildListEntryId: drop.selectedBuildListEntryId }
            : null,
          stuckDrop: status === 'dropped' && stuck !== undefined && rejection === stuck.rejection
            ? { otherPendingRoutes: stuck.otherPendingRoutes }
            : null,
          rejectionReasons: rejections
            .filter((entry) => entry.buildListEntryId === buildListEntryId)
            .map(({ reason }) => reason),
        }
      }),
    }
  }

  /**
   * The rejections this schedule reports: every recorded one, plus
   * `candidate_already_satisfied` for each Entry that is still `released`
   * now - its Target was satisfied by another Entry (8.4). The released state
   * is projected only here, from the final commitment, so an Entry that was
   * released and later committed again carries no stale rejection.
   */
  private finalRejections(): PlannerSearchRejection[] {
    const rejections = [...this.rejections]
    const keys = new Set(this.rejectionKeys)
    this.commitmentRecords()
      .filter(({ status }) => status === 'released')
      .forEach(({ buildListEntryId }) =>
        appendUniquePlannerRejection(
          rejections,
          keys,
          createPlannerSearchRejection(
            buildListEntryId,
            'reserve_weapon',
            'candidate_already_satisfied',
            'The Target already holds an Ideal weapon.',
          ),
        ),
      )
    return sortPlannerRejections(rejections)
  }

  /**
   * The conflicts this run reports (`docs/PLANNER_SPEC.md` 9.6.5), in stable ID
   * order: every initial and dynamic conflict, except one no explicit
   * resolution decided whose participants that this run did not exclude are one
   * or none. "Excluded" is route commitment's own record - an Entry dropped
   * with `conflict_resolution_not_selected` because an applied resolution
   * selected another participant - never re-derived from participant lists.
   * Such a conflict no longer needs a decision, checkpoint participants or not:
   * an excluded Entry runs no unit, its checkpoint endpoint included. A decided
   * conflict stays as the record of the decision. Without resolutions nothing is
   * excluded and every conflict is reported.
   */
  private reportedConflicts(): PlanConflict[] {
    const excluded = new Set(
      this.commitmentRecords()
        .filter(({ status, rejection }) =>
          status === 'dropped' && rejection?.reason === 'conflict_resolution_not_selected')
        .map(({ buildListEntryId }) => buildListEntryId),
    )
    return [...this.conflictsById.values()]
      .filter(({ buildListEntryIds, selectedBuildListEntryId }) =>
        selectedBuildListEntryId !== null ||
        buildListEntryIds.filter((entryId) => !excluded.has(entryId)).length > 1)
      .sort((left, right) => compareStableStrings(left.id, right.id))
  }

  /** The Production run result of the schedule so far. */
  finish(cancelled: boolean): PlannerRunResult {
    const result = this.buildResult(cancelled)
    this.metrics?.finish(result)
    return result
  }

  private buildResult(cancelled: boolean): PlannerRunResult {
    const warnings = this.context.warnings
    if (this.reachedStepLimit) {
      addPlannerWarning(
        warnings,
        'max_steps_reached',
        `Planner reached maxPlanSteps (${this.input.options.maxPlanSteps}).`,
      )
    }
    if (this.rejections.some(({ reason }) => reason === 'protected_destructive_use')) {
      addPlannerWarning(
        warnings,
        'protected_weapon_required',
        'One or more destructive branches require a protected weapon and were not generated.',
      )
    }
    // A resolution is judged against the initial conflicts only: one that
    // matches only a dynamic conflict, or none, was never applied and is
    // reported here (`docs/PLANNER_SPEC.md` 9.6.4).
    plannerConflictResolutionRefusalWarnings(
      this.context.initialConflictDetection.resolutionRefusals,
    ).forEach(({ kind, message }) => addPlannerWarning(warnings, kind, message))
    const conflicts = this.reportedConflicts()
    const rejections = this.finalRejections()
    // Diagnostics only (11): computed once, after every decision was taken.
    this.state.evaluationScore = evaluatePlannerSearchState(this.state, {
      entries: this.context.allSearchEntries,
      targetsById: this.context.planningTargetsById,
      routeUnitCountByEntryId: this.context.routeUnitCountByEntryId,
      conflictCountByEntryId: plannerConflictCountByEntryId(conflicts),
      checkpointRequirements: this.context.checkpointRequirements,
    })
    return {
      bestState: this.state,
      conflicts,
      warnings,
      validationIssues: [],
      excludedBuildListEntries: this.context.excludedBuildListEntries,
      rejections,
      routeCommitment: this.routeCommitmentEvidence(rejections),
      expandedStates: this.expandedStates,
      completed: this.isComplete(),
      cancelled,
      termination: createPlannerRunTermination({
        options: this.input.options,
        planningTargetIds: this.context.planningTargetIds,
        checkpointRequirements: this.context.checkpointRequirements,
        bestState: this.state,
        expandedStates: this.expandedStates,
        cancelled,
        reachedStepLimit: this.reachedStepLimit,
        unconfirmedTargetIds: this.unconfirmedTargetIds,
      }),
    }
  }
}

export type PlannerDeterministicScheduleRunResult =
  | { status: 'ready'; run: PlannerDeterministicScheduleRun }
  | { status: 'finished'; result: PlannerRunResult }

/**
 * Prepares one scheduler run: the shared initial context
 * (`preparePlannerInitialContext()`), the zero-operation confirmations and the
 * Route commitment. An input that fails validation, has no planning Target, or
 * carries a contradictory resolution set is finished right here.
 */
export function createPlannerDeterministicScheduleRun(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  executionOptions: PlannerScheduleExecutionOptions = {},
  buildListContext: PlannerRunBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
): PlannerDeterministicScheduleRunResult {
  const prepared = preparePlannerInitialContext(input, dependencies, buildListContext)
  if (prepared.status === 'invalid') {
    return {
      status: 'finished',
      result: createPlannerInitialFailureResult(
        plannerRunLimits(input.options),
        prepared.warnings,
        prepared.issues,
        prepared.excludedBuildListEntries,
        prepared.planningTargetIds,
      ),
    }
  }
  const context = prepared.context
  if (context.planningTargetIds.length === 0) {
    // No valid BuildListEntry, so this run has no goal (`docs/PLANNER_SPEC.md`
    // 4.1); the validation already reported `no_build_list_entries`.
    return {
      status: 'finished',
      result: {
        bestState: context.initialState,
        conflicts: [],
        warnings: context.warnings,
        validationIssues: [],
        excludedBuildListEntries: context.excludedBuildListEntries,
        rejections: [...context.routePlanRejections],
        expandedStates: 0,
        completed: false,
        cancelled: false,
        termination: createPlannerRunTermination({
          options: input.options,
          planningTargetIds: context.planningTargetIds,
          checkpointRequirements: context.checkpointRequirements,
          bestState: context.initialState,
          expandedStates: 0,
          cancelled: false,
          reachedStepLimit: false,
        }),
      },
    }
  }
  const run = new PlannerDeterministicScheduleRun(input, dependencies, context, executionOptions)
  const refusal = run.initialize()
  if (refusal !== null) {
    const warnings = [...context.warnings]
    addPlannerWarning(warnings, 'invalid_conflict_resolution', refusal)
    return {
      status: 'finished',
      result: createPlannerInitialFailureResult(
        plannerRunLimits(input.options),
        warnings,
        [{ path: 'conflictResolutions', code: 'invalid_state', message: refusal }],
        context.excludedBuildListEntries,
        context.planningTargetIds,
      ),
    }
  }
  return { status: 'ready', run }
}

/**
 * Runs the deterministic scheduler to the end (Issue #103 Phase A / C).
 *
 * The result is the Production `PlannerRunResult`, which Trace Replay, the
 * execution projection and Plan generation consume. It is the Production full
 * Planner run: `createProductionPlanWithObserver()` runs it (Phase C).
 * `maxPlanSteps` is its only bound (Phase D-1), and the Production
 * `PlannerOptions` carries nothing else (Phase D-2a).
 *
 * `buildListContext` follows the full-run contract: `persisted`, or
 * `temporary_replacement` for the replacement set of a Planner Alternative trial.
 */
export async function runPlannerDeterministicSchedule(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  executionOptions: PlannerScheduleExecutionOptions = {},
  buildListContext: PlannerRunBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
): Promise<PlannerRunResult> {
  const created = createPlannerDeterministicScheduleRun(
    input,
    dependencies,
    executionOptions,
    buildListContext,
  )
  if (created.status === 'finished') {
    reportUnscheduledPlannerRun(executionOptions.schedulerInstrumentation, created.result)
    return created.result
  }
  const run = created.run
  let cancelled = false
  let appliedSinceYield = 0
  for (;;) {
    if (executionOptions.shouldCancel?.()) {
      cancelled = true
      break
    }
    const outcome = run.step()
    if (outcome === 'finished' || outcome === 'bounded') break
    if (outcome === 'applied') appliedSinceYield += 1
    if (appliedSinceYield >= PLANNER_SCHEDULER_YIELD_INTERVAL) {
      appliedSinceYield = 0
      await executionOptions.yieldControl?.()
    }
  }
  return run.finish(cancelled)
}
