import type {
  BuildListEntry,
  BuildListEntryId,
  PlanConflict,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import type { PlannerCheckpointRequirements } from './plannerCheckpoints'
import {
  detectPlannerConflicts,
  isUnitBlockedByConflictResolution,
  plannerRouteUnitKey,
  type PlannerConflictDetectionResult,
} from './plannerConflictDetection'
import { entryIsRelevantForState } from './plannerEntryRelevance'
import { comparePlannerEntryPriority } from './plannerEntryPriority'
import {
  initialPlannerLaneProgress,
  isPlannerLaneUnitHolding,
  remainingPlannerLaneUnits,
  type PlannerEntryLanes,
} from './plannerRouteLanes'
import {
  currentPlannerCounterValue,
  type PlannerRouteUnit,
} from './plannerRouteProgress'
import {
  createPlannerSearchRejection,
  plannerRouteUnitSourceRejection,
} from './plannerStateTransitions'
import type {
  PlannerConflictProvisionalOutcome,
  PlannerSearchRejection,
  PlannerSearchState,
} from './plannerTypes'

/**
 * Route commitment of the deterministic scheduler (Issue #103 Phase A,
 * `docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 6).
 *
 * It decides, for each planning Target, whether this run executes that
 * Target's Route - never which Route, and never in what order. A Route is
 * never rewritten or replaced: an Entry that is not committed simply leaves its
 * Target incomplete in this run. Conflicts are judged by the one conflict
 * authority `detectPlannerConflicts()` only.
 *
 * Every record here is runtime-only scheduler information: it never enters
 * `PlannerSearchState`, `PlannerInput`, `BuildListEntry`, `ProductionPlan`, a
 * Worker message, Export or the database.
 */

/**
 * - `committed`   the scheduler executes this Entry's Route
 * - `secured`     the Entry's Candidate was reserved (completed)
 * - `not_needed`  the Entry is not relevant at the start: its Target is
 *   already complete, or another Entry is the Target's required Entry
 * - `released`    the Entry's Target was satisfied by another Entry while it
 *   was committed (cross satisfaction, 6.8)
 * - `dropped`     the Entry is not executed in this run: an explicit
 *   resolution selected another Entry, a provisional conflict outcome, a
 *   broken execution precondition, or a deadlock / stall. Never recommitted
 */
export type PlannerRouteCommitmentStatus =
  | 'committed'
  | 'secured'
  | 'not_needed'
  | 'released'
  | 'dropped'

export interface PlannerRouteCommitmentRecord {
  readonly buildListEntryId: BuildListEntryId
  readonly status: PlannerRouteCommitmentStatus
  /** Why a `dropped` Entry is not executed; `null` for every other status. */
  readonly rejection: PlannerSearchRejection | null
}

/** Everything commitment reads besides the state it judges. */
export interface PlannerRouteCommitmentContext {
  readonly allSearchEntries: readonly BuildListEntry[]
  readonly allLanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>
  readonly entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>
  readonly planningTargets: readonly TargetWeapon[]
  readonly planningTargetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>
  readonly checkpointRequirements: PlannerCheckpointRequirements
  /** The initial conflicts, whose explicit resolutions commitment applies. */
  readonly initialConflictDetection: PlannerConflictDetectionResult
  /** The Entry set the ranking's next-Candidate distance is measured over. */
  readonly initialRelevantEntries: readonly BuildListEntry[]
}

/**
 * The read-only callback of the scheduler's parity observer
 * (`plannerSchedulerInstrumentation.ts`). It is told what commitment already
 * decided and never influences it; `undefined` does no extra work.
 */
export interface PlannerRouteCommitmentObserver {
  /** The decided winner of one iteration and the Entries it pushed out. */
  provisionalOutcome(
    winner: BuildListEntry,
    losers: readonly { entry: BuildListEntry; conflict: PlanConflict }[],
  ): void
}

export type PlannerRouteCommitmentResult =
  | {
      status: 'ready'
      records: Map<BuildListEntryId, PlannerRouteCommitmentRecord>
      rejections: PlannerSearchRejection[]
      /**
       * The provisional outcomes this commitment decided, in decision order,
       * one per (winner, collision conflict). Runtime-only evidence
       * (`PlannerRouteCommitmentEvidence`).
       */
      provisionalOutcomes: PlannerConflictProvisionalOutcome[]
    }
  | {
      /**
       * The applied explicit resolutions select two different Entries of one
       * Target (6.3). The collection invariant already forbids it for an
       * ordinary input; it is a defence that never picks one of them.
       */
      status: 'invalid'
      message: string
    }

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The Entries the applied explicit resolutions of this run prefer: the selected
 * Entry of every initial conflict an explicit `PlannerConflictResolution` was
 * applied to (`docs/PLANNER_SPEC.md` 9.6.4). Empty for an input without
 * resolutions, so nothing below changes for it.
 */
export function explicitlyPreferredBuildListEntryIds(
  detection: PlannerConflictDetectionResult,
): ReadonlySet<BuildListEntryId> {
  return new Set(
    detection.conflicts.flatMap(({ selectedBuildListEntryId }) =>
      selectedBuildListEntryId === null ? [] : [selectedBuildListEntryId],
    ),
  )
}

/**
 * The ranking route commitment's provisional outcomes and the scheduler's
 * deadlock / stall drop use (`docs/PLANNER_SPEC.md` 9.6.4): an Entry an applied
 * explicit resolution prefers ranks before every Entry none prefers, and inside
 * each group the unchanged `R` (`comparePlannerEntryPriority()`) decides. With
 * no applied resolution every Entry is in the same group, so this is exactly
 * `R`. It never changes `recommendedBuildListEntryId`, which `R` alone derives.
 */
export function comparePlannerCommitmentPriority(
  left: BuildListEntry,
  right: BuildListEntry,
  preferred: ReadonlySet<BuildListEntryId>,
  planningTargetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>,
  initialRelevantEntries: readonly BuildListEntry[],
): number {
  const leftPreferred = preferred.has(left.id)
  if (leftPreferred !== preferred.has(right.id)) return leftPreferred ? -1 : 1
  return comparePlannerEntryPriority(left, right, planningTargetsById, initialRelevantEntries)
}

function remainingUnits(
  state: PlannerSearchState,
  entry: BuildListEntry,
  lanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>,
): PlannerRouteUnit[] {
  const lanes = lanePlans.get(entry.id)
  if (!lanes) return []
  return remainingPlannerLaneUnits(
    lanes,
    state.routeProgressByEntryId[entry.id] ?? initialPlannerLaneProgress(),
  )
}

/**
 * The remaining units that hold their Counter position, judged by the one
 * holding predicate: the units that are never `canSkipWhenCounterPassed`. A
 * skippable unit its checkpoint pin blocks now is not among them - its position
 * may be consumed by another Entry and it is fast-forwarded once the pin is
 * released (design 5, `docs/PLANNER_SPEC.md` 7.5.2).
 */
function remainingHoldingUnits(
  state: PlannerSearchState,
  entry: BuildListEntry,
  lanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>,
): PlannerRouteUnit[] {
  return remainingUnits(state, entry, lanePlans).filter(isPlannerLaneUnitHolding)
}

/**
 * Why an Entry cannot be committed in `state`, or `null`.
 *
 * Judged over its remaining holding units (`isPlannerLaneUnitHolding()`) - the
 * units no other Entry may pass: never skippable units, every selected
 * checkpoint endpoint among them. A skippable unit is never a reason on its
 * own, pin-blocked or not: the Counter having passed it, or a resolution
 * selecting another participant of a conflict it is part of, only means its
 * position is consumed and it is fast-forwarded when its progress may move
 * (`detectPlannerConflicts()` never lists it as a Counter conflict
 * participant either). Every Route's last unit is holding and operates the
 * same source weapon, so the source check still covers the whole Route:
 *
 * - an applied explicit resolution blocks one of them
 *   (`isUnitBlockedByConflictResolution()`, the existing semantics), or the
 *   Entry is a non-selected participant of a conflict an applied explicit
 *   resolution decided: a decision is Route-level, so a participant the
 *   resolution did not select runs no unit of its Route even where one of its
 *   units is the selected Entry's shareable action (`docs/PLANNER_SPEC.md`
 *   9.6.2)
 * - the Counter already passed one of them
 * - its source weapon is gone, protected, or superseded
 *   (`plannerRouteUnitSourceRejection()`, the precondition the unit meets
 *   when it actually runs)
 */
export function plannerRouteCommitmentRejection(
  state: PlannerSearchState,
  entry: BuildListEntry,
  context: PlannerRouteCommitmentContext,
): PlannerSearchRejection | null {
  const detection = context.initialConflictDetection
  const conflictsById = new Map(detection.conflicts.map((conflict) => [conflict.id, conflict]))
  const holdingUnits = remainingHoldingUnits(state, entry, context.allLanePlans)
  const isSelectedEntryStillRelevant = (entryId: BuildListEntryId) => {
    const selected = context.entriesById.get(entryId)
    return (
      selected !== undefined &&
      entryIsRelevantForState(state, selected, context.checkpointRequirements)
    )
  }
  for (const unit of holdingUnits) {
    if (
      isUnitBlockedByConflictResolution(
        unit,
        conflictsById,
        detection.conflictIdsByUnitKey,
        detection.selectedPhysicalActionKeysByConflictId,
        isSelectedEntryStillRelevant,
      )
    ) {
      return createPlannerSearchRejection(
        entry.id,
        unit.operation.type,
        'conflict_resolution_not_selected',
        'A valid local conflict resolution selected another BuildListEntry.',
      )
    }
  }
  const excludingConflict = detection.conflicts.find(
    ({ buildListEntryIds, selectedBuildListEntryId }) =>
      selectedBuildListEntryId !== null &&
      selectedBuildListEntryId !== entry.id &&
      buildListEntryIds.includes(entry.id) &&
      isSelectedEntryStillRelevant(selectedBuildListEntryId),
  )
  if (excludingConflict !== undefined) {
    const unitInConflict = holdingUnits.find((unit) =>
      (detection.conflictIdsByUnitKey.get(plannerRouteUnitKey(unit)) ?? []).includes(excludingConflict.id),
    )
    const actionType =
      unitInConflict?.operation.type ??
      remainingUnits(state, entry, context.allLanePlans)[0]?.operation.type ??
      'reserve_weapon'
    return createPlannerSearchRejection(
      entry.id,
      actionType,
      'conflict_resolution_not_selected',
      'A valid local conflict resolution selected another BuildListEntry.',
    )
  }
  for (const unit of holdingUnits) {
    if (unit.counterStream === null || unit.counterBefore === null) continue
    const current = currentPlannerCounterValue(state, unit)
    if (current !== null && current > unit.counterBefore) {
      return createPlannerSearchRejection(
        entry.id,
        unit.operation.type,
        'counter_before_current',
        `The current counter ${current} has already passed required position ${unit.counterBefore}, and this operation cannot be skipped.`,
      )
    }
  }
  for (const unit of holdingUnits) {
    const sourceIssue = plannerRouteUnitSourceRejection(state, entry, unit)
    if (sourceIssue !== null) return sourceIssue
  }
  return null
}

/**
 * The physical actions each Entry performs inside each detected conflict.
 */
function conflictActionKeysByEntry(
  detection: PlannerConflictDetectionResult,
  unitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>,
): Map<string, Map<BuildListEntryId, { keys: Set<string>; units: PlannerRouteUnit[] }>> {
  const byConflict = new Map<
    string,
    Map<BuildListEntryId, { keys: Set<string>; units: PlannerRouteUnit[] }>
  >()
  unitPlans.forEach((units) => {
    units.forEach((unit) => {
      ;(detection.conflictIdsByUnitKey.get(plannerRouteUnitKey(unit)) ?? []).forEach(
        (conflictId) => {
          const byEntry = byConflict.get(conflictId) ?? new Map()
          const current = byEntry.get(unit.entryId) ?? { keys: new Set<string>(), units: [] }
          current.keys.add(unit.physicalActionKey)
          current.units.push(unit)
          byEntry.set(unit.entryId, current)
          byConflict.set(conflictId, byEntry)
        },
      )
    })
  })
  return byConflict
}

interface PlannerCollision {
  readonly conflict: PlanConflict
  readonly unit: PlannerRouteUnit
}

/**
 * Whether two Routes cannot both run: some conflict both take part in has a
 * unit of one of them that is not one of the other's physical actions in it.
 * That is exactly what an explicit resolution selecting one of them blocks on
 * the other (`isUnitBlockedByConflictResolution()`), so units that are the
 * same shareable physical action are never a collision. `unit` is the unit of
 * `other` that is lost, or - when only `winner` loses one - that unit.
 */
function findCollision(
  winner: BuildListEntryId,
  other: BuildListEntryId,
  detection: PlannerConflictDetectionResult,
  actionKeys: ReturnType<typeof conflictActionKeysByEntry>,
): PlannerCollision | null {
  for (const conflict of detection.conflicts) {
    if (
      !conflict.buildListEntryIds.includes(winner) ||
      !conflict.buildListEntryIds.includes(other)
    ) continue
    const byEntry = actionKeys.get(conflict.id)
    const winnerUnits = byEntry?.get(winner) ?? { keys: new Set<string>(), units: [] }
    const otherUnits = byEntry?.get(other) ?? { keys: new Set<string>(), units: [] }
    const lost =
      otherUnits.units.find((unit) => !winnerUnits.keys.has(unit.physicalActionKey)) ??
      winnerUnits.units.find((unit) => !otherUnits.keys.has(unit.physicalActionKey))
    if (lost) return { conflict, unit: lost }
  }
  return null
}

function detectCollisions(
  state: PlannerSearchState,
  entries: readonly BuildListEntry[],
  context: PlannerRouteCommitmentContext,
) {
  const unitPlans = new Map(
    entries.map((entry) => [entry.id, remainingUnits(state, entry, context.allLanePlans)] as const),
  )
  // No resolution is passed: the explicit resolutions were already applied as
  // exclusions, and every conflict left here is one the run has to settle.
  const detection = detectPlannerConflicts(
    entries,
    unitPlans,
    context.planningTargets,
    [],
    false,
  )
  return { detection, actionKeys: conflictActionKeysByEntry(detection, unitPlans) }
}

function notCommittedRejection(
  loser: BuildListEntryId,
  winner: BuildListEntryId,
  collision: PlannerCollision,
): PlannerSearchRejection {
  return createPlannerSearchRejection(
    loser,
    collision.unit.operation.type,
    'conflict_not_committed',
    `BuildListEntry '${loser}' was not committed: it conflicts with BuildListEntry '${winner}' (${collision.conflict.kind}) and no explicit conflict resolution chose between them.`,
  )
}

/**
 * The initial Route commitment of one run (6.2 - 6.6).
 *
 * `state` is the start state after the zero-operation confirmations. Each
 * planning Target contributes its relevant Entries (0..1 in an ordinary or
 * replacement input); an Entry an applied explicit resolution blocks, whose
 * holding unit the Counter already passed, or whose source weapon cannot be
 * used is dropped. Among the rest, every conflict without an explicit
 * resolution is settled by the provisional outcome (6.5): repeatedly the best
 * undecided participant by the ranking `R` is kept, and every undecided Entry
 * that collides with it is dropped. The provisional outcome creates no
 * `PlannerConflictResolution` and never replaces a dropped Route.
 */
export function createPlannerRouteCommitment(
  state: PlannerSearchState,
  context: PlannerRouteCommitmentContext,
  observer?: PlannerRouteCommitmentObserver,
): PlannerRouteCommitmentResult {
  const selectedByTarget = new Map<TargetWeaponId, Set<BuildListEntryId>>()
  context.initialConflictDetection.conflicts.forEach((conflict) => {
    const selected = conflict.selectedBuildListEntryId
    if (selected === null) return
    const entry = context.entriesById.get(selected)
    if (!entry) return
    const set = selectedByTarget.get(entry.targetWeaponId) ?? new Set()
    set.add(selected)
    selectedByTarget.set(entry.targetWeaponId, set)
  })
  const contradictory = [...selectedByTarget]
    .filter(([, selected]) => selected.size > 1)
    .sort(([left], [right]) => compareStableStrings(left, right))[0]
  if (contradictory) {
    return {
      status: 'invalid',
      message: `Conflict resolutions select different BuildListEntries (${[...contradictory[1]].sort(compareStableStrings).join(', ')}) of TargetWeapon '${contradictory[0]}'.`,
    }
  }
  // An Entry one applied resolution prefers while another applied resolution
  // excludes it makes the whole set inconsistent (`docs/PLANNER_SPEC.md` 9.6.3
  // rule 5 / 9.6.4): the run never picks one of the two decisions.
  const preferred = explicitlyPreferredBuildListEntryIds(context.initialConflictDetection)
  const inconsistent = context.initialConflictDetection.conflicts
    .filter(({ selectedBuildListEntryId }) => selectedBuildListEntryId !== null)
    .flatMap(({ id, buildListEntryIds, selectedBuildListEntryId }) =>
      buildListEntryIds
        .filter((entryId) => entryId !== selectedBuildListEntryId && preferred.has(entryId))
        .map((entryId) => ({ entryId, conflictId: id })),
    )
    .sort((left, right) => compareStableStrings(left.entryId, right.entryId))[0]
  if (inconsistent) {
    return {
      status: 'invalid',
      message: `Conflict resolutions are inconsistent: BuildListEntry '${inconsistent.entryId}' is preferred by one resolution and not selected by the resolution of conflict '${inconsistent.conflictId}'.`,
    }
  }

  const records = new Map<BuildListEntryId, PlannerRouteCommitmentRecord>()
  const rejections: PlannerSearchRejection[] = []
  const drop = (entryId: BuildListEntryId, rejection: PlannerSearchRejection) => {
    records.set(entryId, { buildListEntryId: entryId, status: 'dropped', rejection })
    rejections.push(rejection)
  }
  const candidates: BuildListEntry[] = []
  for (const entry of context.allSearchEntries) {
    if (state.selectedBuildListEntryIds.includes(entry.id)) {
      records.set(entry.id, { buildListEntryId: entry.id, status: 'secured', rejection: null })
      continue
    }
    if (!entryIsRelevantForState(state, entry, context.checkpointRequirements)) {
      records.set(entry.id, { buildListEntryId: entry.id, status: 'not_needed', rejection: null })
      continue
    }
    const rejection = plannerRouteCommitmentRejection(state, entry, context)
    if (rejection !== null) {
      drop(entry.id, rejection)
      continue
    }
    candidates.push(entry)
  }

  // An explicitly preferred Entry is kept before every Entry no resolution
  // prefers, so preferring A never lets an undecided conflict drop A while B
  // is dropped too (`docs/PLANNER_SPEC.md` 9.6.4). Without resolutions this is R.
  const rank = (left: BuildListEntry, right: BuildListEntry) =>
    comparePlannerCommitmentPriority(
      left,
      right,
      preferred,
      context.planningTargetsById,
      context.initialRelevantEntries,
    )
  const decided = new Set<BuildListEntryId>()
  const provisionalOutcomes: PlannerConflictProvisionalOutcome[] = []
  let remaining = [...candidates]
  for (;;) {
    const { detection, actionKeys } = detectCollisions(state, remaining, context)
    if (detection.conflicts.length === 0) break
    const undecided = [...new Set(detection.conflicts.flatMap(({ buildListEntryIds }) => buildListEntryIds))]
      .filter((entryId) => !decided.has(entryId))
      .flatMap((entryId) => {
        const entry = context.entriesById.get(entryId)
        return entry ? [entry] : []
      })
      .sort(rank)
    const winner = undecided[0]
    if (winner === undefined) break
    decided.add(winner.id)
    const losers = remaining
      .filter((entry) => !decided.has(entry.id))
      .flatMap((entry) => {
        const collision = findCollision(winner.id, entry.id, detection, actionKeys)
        return collision === null ? [] : [{ entry, collision }]
      })
    losers.forEach(({ entry, collision }) => {
      drop(entry.id, notCommittedRejection(entry.id, winner.id, collision))
      // The decision itself, recorded where it is taken: winner and loser of
      // this collision's unresolved conflict.
      const outcome = provisionalOutcomes.find(({ conflictId, selectedBuildListEntryId }) =>
        conflictId === collision.conflict.id && selectedBuildListEntryId === winner.id)
      if (outcome) outcome.rejectedBuildListEntryIds.push(entry.id)
      else {
        provisionalOutcomes.push({
          conflictId: collision.conflict.id,
          selectedBuildListEntryId: winner.id,
          rejectedBuildListEntryIds: [entry.id],
        })
      }
    })
    observer?.provisionalOutcome(
      winner,
      losers.map(({ entry, collision }) => ({ entry, conflict: collision.conflict })),
    )
    const loserIds = new Set(losers.map(({ entry }) => entry.id))
    remaining = remaining.filter((entry) => !loserIds.has(entry.id))
  }
  remaining.forEach((entry) =>
    records.set(entry.id, { buildListEntryId: entry.id, status: 'committed', rejection: null }),
  )
  return { status: 'ready', records, rejections, provisionalOutcomes }
}

/**
 * Whether an Entry that is not committed can join the committed set now
 * (6.8, a Target whose Ideal was lost in flight): it is executable in `state`
 * and collides with no committed Entry. It never pushes a committed Entry out.
 */
export function canCommitPlannerRoute(
  state: PlannerSearchState,
  entry: BuildListEntry,
  committed: readonly BuildListEntry[],
  context: PlannerRouteCommitmentContext,
): boolean {
  if (plannerRouteCommitmentRejection(state, entry, context) !== null) return false
  const { detection, actionKeys } = detectCollisions(state, [...committed, entry], context)
  return committed.every(
    (other) => findCollision(other.id, entry.id, detection, actionKeys) === null,
  )
}
