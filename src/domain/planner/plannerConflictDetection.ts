import type {
  BuildListEntry,
  BuildListEntryId,
  PlanConflict,
  PlanConflictCheckpointParticipant,
  TargetWeapon,
} from '../models/publicTypes'
import { createPlanConflictId } from './conflictKey'
import { selectedIntermediateStateAtOperationIndex } from './plannerCheckpoints'
import { recommendPlannerEntry } from './plannerEntryPriority'
import type { PlannerRouteUnit } from './plannerRouteProgress'
import type {
  PlannerConflictResolution,
  PlannerWarning,
} from './plannerTypes'

export interface PlannerConflictDetectionResult {
  conflicts: PlanConflict[]
  conflictIdsByUnitKey: ReadonlyMap<string, readonly string[]>
  selectedPhysicalActionKeysByConflictId: ReadonlyMap<string, readonly string[]>
  warnings: PlannerWarning[]
  /**
   * The given resolutions the detection did not apply, with the shared refusal
   * reason (`applyPlannerConflictResolutions()`). Always computed, whether or
   * not `warnings` reports them, so a caller that judged the resolutions
   * against these conflicts can report them later without re-judging.
   */
  resolutionRefusals: readonly PlannerConflictResolutionRefusal[]
}

/** The fields one explicit decision is judged against: identity, participants and checkpoint participants. */
export type PlannerResolvableConflict = Pick<
  PlanConflict,
  'id' | 'buildListEntryIds' | 'checkpointParticipants'
>

/** One resolution that could not be applied, and why. */
export interface PlannerConflictResolutionRefusal {
  readonly resolution: PlannerConflictResolution
  readonly reason: string
}

const NO_EXCLUDED_ENTRIES: ReadonlySet<BuildListEntryId> = new Set()

/**
 * Whether this conflict involves a selected compromise checkpoint.
 *
 * Such a conflict is out of scope for a winner-picking
 * `PlannerConflictResolution` (`docs/PLANNER_SPEC.md` 9.5): applying one would
 * make the losing Entry give up the very Counter position its selected
 * checkpoint needs, which silently drops a hard constraint. The only
 * resolution is a Build List checkpoint change followed by a new Planner run.
 */
export function conflictInvolvesSelectedCheckpoint(
  conflict: Pick<PlanConflict, 'checkpointParticipants'>,
): boolean {
  return (conflict.checkpointParticipants?.length ?? 0) > 0
}

/**
 * The checkpoint participants of `conflict` that still run in this run: those
 * no other explicit decision excludes (`docs/PLANNER_SPEC.md` 9.6.2, effective
 * checkpoint participants). An excluded Entry runs no unit of its Route, so its
 * checkpoint is not imposed on the run at all.
 */
export function effectiveCheckpointParticipants(
  conflict: Pick<PlanConflict, 'checkpointParticipants'>,
  excludedBuildListEntryIds: ReadonlySet<BuildListEntryId> = NO_EXCLUDED_ENTRIES,
): PlanConflictCheckpointParticipant[] {
  return (conflict.checkpointParticipants ?? []).filter(
    ({ buildListEntryId }) => !excludedBuildListEntryIds.has(buildListEntryId),
  )
}

/**
 * Why one explicit `PlannerConflictResolution` cannot be applied to the
 * conflict it names, or `null` when it can.
 *
 * This is the single Domain authority every consumer shares - initial
 * detection, the full run's final warnings, the Application's decision set
 * (`derivePlannerConflictDecisionSet()`) and the Planner Alternative
 * fixed-constraint preparation - so a refused resolution is refused the same
 * way everywhere and can never reach a Planner run through another door.
 *
 * `excludedBuildListEntryIds` are the Entries the other applied decisions of
 * the same input exclude (`docs/PLANNER_SPEC.md` 9.5.1 / 9.6.4). A conflict
 * whose checkpoint participants are all excluded is an ordinary conflict among
 * the rest; one with an effective checkpoint participant, and a decision that
 * selects a checkpoint participant itself, stay refused. Without the set every
 * conflict a selected checkpoint takes part in is refused, as before.
 */
export function conflictResolutionRefusalReason(
  resolution: PlannerConflictResolution,
  conflict: PlannerResolvableConflict | undefined,
  excludedBuildListEntryIds: ReadonlySet<BuildListEntryId> = NO_EXCLUDED_ENTRIES,
): string | null {
  if (!conflict) {
    return `Conflict resolution '${resolution.conflictKey}' does not match a currently detected conflict.`
  }
  if (!conflict.buildListEntryIds.includes(resolution.selectedBuildListEntryId)) {
    return `BuildListEntry '${resolution.selectedBuildListEntryId}' is not a participant in conflict '${resolution.conflictKey}'.`
  }
  if (
    (conflict.checkpointParticipants ?? []).some(
      ({ buildListEntryId }) => buildListEntryId === resolution.selectedBuildListEntryId,
    ) ||
    effectiveCheckpointParticipants(conflict, excludedBuildListEntryIds).length > 0
  ) {
    return `Conflict '${resolution.conflictKey}' involves a selected intermediate state, so it cannot be resolved by preferring BuildListEntry '${resolution.selectedBuildListEntryId}'; change or clear the selection in the Build List instead.`
  }
  return null
}

/** How a set of explicit resolutions applies to a set of conflicts. */
export interface PlannerConflictResolutionApplication {
  /** Conflict ID -> the Entry its applied resolution selects. */
  readonly appliedSelections: ReadonlyMap<string, BuildListEntryId>
  /** Every non-selected participant of an applied resolution (the excluded Entries). */
  readonly excludedBuildListEntryIds: ReadonlySet<BuildListEntryId>
  /** The resolutions not applied, in input order, judged against the final excluded set. */
  readonly refusals: readonly PlannerConflictResolutionRefusal[]
}

/**
 * Applies explicit resolutions to `conflicts` as one monotone fixpoint
 * (`docs/PLANNER_SPEC.md` 9.6.4): a resolution is applied once
 * `conflictResolutionRefusalReason()` accepts it against the Entries the
 * resolutions applied so far exclude, and its own non-selected participants
 * then join the excluded set. It repeats until nothing more applies. The
 * excluded set only grows and each check is monotone in it, so the result does
 * not depend on the resolution order.
 *
 * It decides applicability only. Whether the applied set is consistent - no
 * Entry both selected and excluded - is the caller's fail-closed check.
 */
export function applyPlannerConflictResolutions(
  conflicts: readonly PlannerResolvableConflict[],
  resolutions: readonly PlannerConflictResolution[],
): PlannerConflictResolutionApplication {
  const conflictsById = new Map(conflicts.map((conflict) => [conflict.id, conflict]))
  const appliedSelections = new Map<string, BuildListEntryId>()
  const excluded = new Set<BuildListEntryId>()
  for (let changed = true; changed;) {
    changed = false
    for (const resolution of resolutions) {
      if (appliedSelections.has(resolution.conflictKey)) continue
      const conflict = conflictsById.get(resolution.conflictKey)
      if (conflictResolutionRefusalReason(resolution, conflict, excluded) !== null) continue
      appliedSelections.set(resolution.conflictKey, resolution.selectedBuildListEntryId)
      ;(conflict as PlannerResolvableConflict).buildListEntryIds.forEach((entryId) => {
        if (entryId !== resolution.selectedBuildListEntryId) excluded.add(entryId)
      })
      changed = true
    }
  }
  const refusals = resolutions.flatMap((resolution) => {
    if (appliedSelections.get(resolution.conflictKey) === resolution.selectedBuildListEntryId) return []
    const reason =
      conflictResolutionRefusalReason(resolution, conflictsById.get(resolution.conflictKey), excluded) ??
      `Conflict resolution '${resolution.conflictKey}' repeats a conflict another resolution already decided.`
    return [{ resolution, reason }]
  })
  return { appliedSelections, excludedBuildListEntryIds: excluded, refusals }
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function plannerRouteUnitKey(unit: PlannerRouteUnit): string {
  return `${unit.entryId}\u0000${unit.position.operationIndex}\u0000${unit.position.unitIndex}`
}

function sortedEntryIds(units: readonly PlannerRouteUnit[]): BuildListEntryId[] {
  return [...new Set(units.map(({ entryId }) => entryId))].sort(
    compareStableStrings,
  )
}

function allOneShareablePhysicalAction(
  units: readonly PlannerRouteUnit[],
): boolean {
  return (
    units.every(({ shareable }) => shareable) &&
    new Set(units.map(({ physicalActionKey }) => physicalActionKey)).size === 1
  )
}

function appendUnitConflict(
  conflictIdsByUnitKey: Map<string, string[]>,
  conflict: PlanConflict,
  units: readonly PlannerRouteUnit[],
) {
  units.forEach((unit) => {
    const key = plannerRouteUnitKey(unit)
    conflictIdsByUnitKey.set(key, [
      ...(conflictIdsByUnitKey.get(key) ?? []),
      conflict.id,
    ])
  })
}

interface ConflictGroup {
  key: string
  kind: PlanConflict['kind']
  units: PlannerRouteUnit[]
}

/**
 * Counter positions are a shared stream, not an exclusive resource.
 *
 * A unit that another Entry's real operation can pass without breaking its own
 * Route (`canSkipWhenCounterPassed`) never competes for its Counter position
 * (`docs/PLANNER_SPEC.md` 7.0.2 / 9). Only units that must physically run at
 * that exact position can conflict, so a skippable unit is neither a conflict
 * participant nor blocked by a conflict resolution. Exclusive OwnedWeapon
 * consumption keeps its existing semantics and is detected separately.
 *
 * Not being a conflict does not make the order free: a required unit at the
 * same position must run first, and the Beam Search enforces that as execution
 * eligibility (`isSkippableUnitDominatedByRequiredUnit`), never as a conflict
 * the user has to resolve.
 */
function counterGroups(
  unitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>,
): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>()
  unitPlans.forEach((units) => {
    units.forEach((unit) => {
      if (unit.canSkipWhenCounterPassed) return
      if (unit.counterStream === null || unit.counterBefore === null) return
      const kind =
        unit.counterStream === 'gogma'
          ? 'same_gogma_counter'
          : unit.counterStream === 'skill'
            ? 'same_skill_counter'
            : 'same_normal_counter'
      const key =
        unit.counterStream === 'normal'
          ? `${kind}\u0000${unit.counterId}\u0000${unit.counterBefore}`
          : `${kind}\u0000${unit.counterBefore}`
      const group = groups.get(key) ?? { key, kind, units: [] }
      group.units.push(unit)
      groups.set(key, group)
    })
  })
  return [...groups.values()].filter(
    ({ units }) =>
      sortedEntryIds(units).length > 1 &&
      !allOneShareablePhysicalAction(units),
  )
}

function consumedWeaponGroups(
  unitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>,
): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>()
  unitPlans.forEach((units) => {
    units.forEach((unit) => {
      const id = unit.exclusiveConsumedOwnedWeaponId
      if (id === null) return
      const key = `same_owned_weapon_consumed\u0000${id}`
      const group = groups.get(key) ?? {
        key,
        kind: 'same_owned_weapon_consumed' as const,
        units: [],
      }
      group.units.push(unit)
      groups.set(key, group)
    })
  })
  return [...groups.values()].filter(
    ({ units }) =>
      sortedEntryIds(units).length > 1 &&
      !allOneShareablePhysicalAction(units),
  )
}

function conflictId(group: ConflictGroup, entryIds: BuildListEntryId[]): string {
  const first = group.units[0]
  switch (group.kind) {
    case 'same_gogma_counter':
      return createPlanConflictId({
        kind: group.kind,
        gogmaCounter: first.counterBefore as number,
        buildListEntryIds: entryIds,
      })
    case 'same_skill_counter':
      return createPlanConflictId({
        kind: group.kind,
        skillCounter: first.counterBefore as number,
        buildListEntryIds: entryIds,
      })
    case 'same_normal_counter':
      return createPlanConflictId({
        kind: group.kind,
        normalCounterId: first.counterId as string,
        normalCounter: first.counterBefore as number,
        buildListEntryIds: entryIds,
      })
    case 'same_owned_weapon_consumed':
      return createPlanConflictId({
        kind: group.kind,
        ownedWeaponId: first.exclusiveConsumedOwnedWeaponId as never,
        buildListEntryIds: entryIds,
      })
  }
}

/**
 * Which participants of this conflict are competing for a unit that ends one of
 * their own selected compromise checkpoints (`docs/PLANNER_SPEC.md` 9.5).
 *
 * Typed metadata so the UI can tell the user that this conflict can only be
 * resolved by changing a checkpoint selection in the Build List, rather than by
 * picking a winning Entry. It deliberately does not enter `PlanConflict.id`,
 * whose generation rule is unchanged.
 */
function checkpointParticipants(
  group: ConflictGroup,
  entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>,
): PlanConflictCheckpointParticipant[] {
  const participants = new Map<string, PlanConflictCheckpointParticipant>()
  group.units.forEach((unit) => {
    if (unit.position.unitIndex !== unit.position.unitCount - 1) return
    const entry = entriesById.get(unit.entryId)
    if (!entry) return
    const selected = selectedIntermediateStateAtOperationIndex(
      entry,
      unit.position.operationIndex,
    )
    if (!selected) return
    participants.set(selected.opportunityId, {
      buildListEntryId: entry.id,
      axis: selected.axis,
      opportunityId: selected.opportunityId,
    })
  })
  return [...participants.values()].sort((left, right) =>
    compareStableStrings(left.opportunityId, right.opportunityId),
  )
}

function conflictReason(group: ConflictGroup): string {
  const first = group.units[0]
  switch (group.kind) {
    case 'same_gogma_counter':
      return `BuildListEntries require incompatible physical operations at Gogma Counter ${first.counterBefore}.`
    case 'same_skill_counter':
      return `BuildListEntries require incompatible physical operations at Skill Counter ${first.counterBefore}.`
    case 'same_normal_counter':
      return `BuildListEntries require the same Normal Counter '${first.counterId}' position ${first.counterBefore}.`
    case 'same_owned_weapon_consumed':
      return `BuildListEntries exclusively consume OwnedWeapon '${first.exclusiveConsumedOwnedWeaponId}'.`
  }
}

export function detectPlannerConflicts(
  entries: readonly BuildListEntry[],
  unitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>,
  targets: readonly TargetWeapon[],
  resolutions: readonly PlannerConflictResolution[],
  reportInvalidResolutions = true,
): PlannerConflictDetectionResult {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  const targetsById = new Map(targets.map((target) => [target.id, target]))
  const conflictIdsByUnitKey = new Map<string, string[]>()
  const selectedPhysicalActionKeysByConflictId = new Map<string, string[]>()
  const detected = [...counterGroups(unitPlans), ...consumedWeaponGroups(unitPlans)]
    .map((group) => {
      const buildListEntryIds = sortedEntryIds(group.units)
      const conflict: PlanConflict = {
        id: conflictId(group, buildListEntryIds),
        kind: group.kind,
        buildListEntryIds,
        reason: conflictReason(group),
        recommendedBuildListEntryId: recommendPlannerEntry(
          buildListEntryIds,
          entriesById,
          targetsById,
          entries,
        ),
        selectedBuildListEntryId: null,
        resolutionNote: null,
        checkpointParticipants: checkpointParticipants(group, entriesById),
      }
      return { group, conflict }
    })
    .sort((left, right) => compareStableStrings(left.conflict.id, right.conflict.id))

  // A resolution is applied only when the shared refusal authority accepts it
  // against the Entries the other applied resolutions exclude: a
  // non-participant selection and a conflict with an effective checkpoint
  // participant both leave the conflict unresolved, never half-applied.
  const application = applyPlannerConflictResolutions(
    detected.map(({ conflict }) => conflict),
    resolutions,
  )
  const conflicts = detected.map(({ group, conflict }) => {
    const selectedBuildListEntryId = application.appliedSelections.get(conflict.id) ?? null
    const resolved: PlanConflict = selectedBuildListEntryId === null
      ? conflict
      : {
          ...conflict,
          selectedBuildListEntryId,
          resolutionNote: `Applied local resolution for BuildListEntry '${selectedBuildListEntryId}'.`,
        }
    appendUnitConflict(conflictIdsByUnitKey, resolved, group.units)
    if (selectedBuildListEntryId !== null) {
      selectedPhysicalActionKeysByConflictId.set(
        resolved.id,
        [...new Set(
          group.units
            .filter(({ entryId }) => entryId === selectedBuildListEntryId)
            .map(({ physicalActionKey }) => physicalActionKey),
        )].sort(compareStableStrings),
      )
    }
    return resolved
  })

  const warnings = reportInvalidResolutions
    ? plannerConflictResolutionRefusalWarnings(application.refusals)
    : []
  return {
    conflicts,
    conflictIdsByUnitKey,
    selectedPhysicalActionKeysByConflictId,
    warnings,
    resolutionRefusals: application.refusals,
  }
}

/** The `invalid_conflict_resolution` warnings of refused resolutions, in their order. */
export function plannerConflictResolutionRefusalWarnings(
  refusals: readonly PlannerConflictResolutionRefusal[],
): PlannerWarning[] {
  return refusals.map(({ reason }) => ({ kind: 'invalid_conflict_resolution' as const, message: reason }))
}

export function isUnitBlockedByConflictResolution(
  unit: PlannerRouteUnit,
  conflictsById: ReadonlyMap<string, PlanConflict>,
  conflictIdsByUnitKey: ReadonlyMap<string, readonly string[]>,
  selectedPhysicalActionKeysByConflictId: ReadonlyMap<string, readonly string[]>,
  isSelectedEntryStillRelevant: (entryId: BuildListEntryId) => boolean,
): boolean {
  return (conflictIdsByUnitKey.get(plannerRouteUnitKey(unit)) ?? []).some(
    (conflictId) => {
      const conflict = conflictsById.get(conflictId)
      if (
        !conflict ||
        conflict.selectedBuildListEntryId === null ||
        !isSelectedEntryStillRelevant(conflict.selectedBuildListEntryId)
      ) return false
      return !(
        selectedPhysicalActionKeysByConflictId
          .get(conflictId)
          ?.includes(unit.physicalActionKey) ?? false
      )
    },
  )
}
