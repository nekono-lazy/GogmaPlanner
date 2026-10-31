import type {
  BuildListEntry,
  BuildListEntryId,
  OwnedWeaponId,
  PlanConflict,
  TargetWeapon,
} from '../models/publicTypes'
import { createPlanConflictId } from './conflictKey'
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

/** The fields one explicit decision is judged against: identity and participants. */
export type PlannerResolvableConflict = Pick<PlanConflict, 'id' | 'buildListEntryIds'>

/** One resolution that could not be applied, and why. */
export interface PlannerConflictResolutionRefusal {
  readonly resolution: PlannerConflictResolution
  readonly reason: string
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
 * Calculation schema 11..18 also refused a conflict a selected compromise
 * checkpoint took part in (`docs/PLANNER_SPEC.md` 9.5.1 / 9.6.2). Issue #100
 * removed the selection, so no detected conflict carries a checkpoint
 * participant any more (20.7 / 20.10).
 */
export function conflictResolutionRefusalReason(
  resolution: PlannerConflictResolution,
  conflict: PlannerResolvableConflict | undefined,
): string | null {
  if (!conflict) {
    return `Conflict resolution '${resolution.conflictKey}' does not match a currently detected conflict.`
  }
  if (!conflict.buildListEntryIds.includes(resolution.selectedBuildListEntryId)) {
    return `BuildListEntry '${resolution.selectedBuildListEntryId}' is not a participant in conflict '${resolution.conflictKey}'.`
  }
  return null
}

/** How a set of explicit resolutions applies to a set of conflicts. */
export interface PlannerConflictResolutionApplication {
  /** Conflict ID -> the Entry its applied resolution selects. */
  readonly appliedSelections: ReadonlyMap<string, BuildListEntryId>
  /** Every non-selected participant of an applied resolution (the excluded Entries). */
  readonly excludedBuildListEntryIds: ReadonlySet<BuildListEntryId>
  /** The resolutions not applied, in input order. */
  readonly refusals: readonly PlannerConflictResolutionRefusal[]
}

/**
 * Applies explicit resolutions to `conflicts` (`docs/PLANNER_SPEC.md` 9.6.4): a
 * resolution is applied when `conflictResolutionRefusalReason()` accepts it and
 * no earlier resolution of the input already decided its conflict, and its own
 * non-selected participants join the excluded set.
 *
 * Calculation schema 11..18 repeated this to a monotone fixpoint, because a
 * checkpoint refusal depended on the excluded set; no refusal does now, so one
 * pass in input order reaches the same fixpoint.
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
  for (const resolution of resolutions) {
    if (appliedSelections.has(resolution.conflictKey)) continue
    const conflict = conflictsById.get(resolution.conflictKey)
    if (conflict === undefined || conflictResolutionRefusalReason(resolution, conflict) !== null) continue
    appliedSelections.set(resolution.conflictKey, resolution.selectedBuildListEntryId)
    conflict.buildListEntryIds.forEach((entryId) => {
      if (entryId !== resolution.selectedBuildListEntryId) excluded.add(entryId)
    })
  }
  const refusals = resolutions.flatMap((resolution) => {
    if (appliedSelections.get(resolution.conflictKey) === resolution.selectedBuildListEntryId) return []
    const reason =
      conflictResolutionRefusalReason(resolution, conflictsById.get(resolution.conflictKey)) ??
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
  /** The participants: the Entries of `units`, plus the Entries a weapon group names directly. */
  entryIds: Set<BuildListEntryId>
  units: PlannerRouteUnit[]
  /** The weapon of a `same_owned_weapon_consumed` group; `null` for a Counter group. */
  ownedWeaponId: OwnedWeaponId | null
}

/**
 * The owned weapon an Entry's Route completes its Target with, or `null` for a
 * Route that forges a new weapon (Issue #334 PR-3, `docs/PLANNER_SPEC.md` 16.3 /
 * 21.5): an existing Gogma Route - the zero-operation `existing_gogma_current`
 * included - completes its source, and an owned Normal Route completes the
 * weapon it converts (the same OwnedWeapon ID, `docs/PLANNER_SPEC.md` 16.3).
 * Read from the saved Route alone; never from the Planner state.
 */
export function plannerEntryCompletionWeaponId(entry: BuildListEntry): OwnedWeaponId | null {
  const route = entry.candidateSnapshot.route
  if (route.kind.startsWith('existing_gogma') || route.kind === 'owned_normal_artian_to_gogma') {
    return route.sourceOwnedWeaponId
  }
  return null
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
      const group = groups.get(key) ?? { key, kind, entryIds: new Set<BuildListEntryId>(), units: [], ownedWeaponId: null }
      group.entryIds.add(unit.entryId)
      group.units.push(unit)
      groups.set(key, group)
    })
  })
  return [...groups.values()].filter(
    ({ entryIds, units }) =>
      entryIds.size > 1 &&
      !allOneShareablePhysicalAction(units),
  )
}

/**
 * One OwnedWeapon completes at most one Target (Issue #334 PR-3,
 * `docs/PLANNER_SPEC.md` 21.5): two Entries whose completed weapon is the same
 * owned weapon (`plannerEntryCompletionWeaponId()`) always collide - the
 * degenerate pair whose every unit is one shareable physical action, two
 * zero-operation Candidates on one weapon, and a zero-operation Candidate
 * beside a Route on its weapon included. A Route that exclusively consumes a
 * weapon (`exclusiveConsumedOwnedWeaponId`) joins the same group. Every
 * remaining unit of a participant is registered on the conflict, so a
 * resolution selecting one participant blocks every unit of the others that is
 * not the selected Entry's own shareable action, and route commitment excludes
 * them Route-level (`docs/PLANNER_SPEC.md` 9.6.2). Calculation schema 11..19
 * excluded the degenerate pair and knew no zero-operation participant.
 */
function consumedWeaponGroups(
  entries: readonly BuildListEntry[],
  unitPlans: ReadonlyMap<BuildListEntryId, readonly PlannerRouteUnit[]>,
): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>()
  const groupOf = (id: OwnedWeaponId): ConflictGroup => {
    const key = `same_owned_weapon_consumed\u0000${id}`
    const group = groups.get(key) ?? {
      key,
      kind: 'same_owned_weapon_consumed' as const,
      entryIds: new Set<BuildListEntryId>(),
      units: [],
      ownedWeaponId: id,
    }
    groups.set(key, group)
    return group
  }
  entries.forEach((entry) => {
    const completionWeaponId = plannerEntryCompletionWeaponId(entry)
    if (completionWeaponId === null) return
    const group = groupOf(completionWeaponId)
    group.entryIds.add(entry.id)
    group.units.push(...(unitPlans.get(entry.id) ?? []))
  })
  unitPlans.forEach((units) => {
    units.forEach((unit) => {
      const id = unit.exclusiveConsumedOwnedWeaponId
      if (id === null) return
      const group = groupOf(id)
      if (group.units.includes(unit)) return
      group.entryIds.add(unit.entryId)
      group.units.push(unit)
    })
  })
  return [...groups.values()].filter(({ entryIds }) => entryIds.size > 1)
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
        ownedWeaponId: group.ownedWeaponId as never,
        buildListEntryIds: entryIds,
      })
  }
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
      return `BuildListEntries complete their Targets with, or exclusively consume, the same OwnedWeapon '${group.ownedWeaponId}'.`
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
  const detected = [...counterGroups(unitPlans), ...consumedWeaponGroups(entries, unitPlans)]
    .map((group) => {
      const buildListEntryIds = [...group.entryIds].sort(compareStableStrings)
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
        // The schema 19 persisted shape keeps the legacy field, always empty:
        // no selected intermediate state takes part in a conflict any more
        // (`docs/DATA_MODEL.md` 11.8, `docs/PLANNER_SPEC.md` 20.7).
        checkpointParticipants: [],
      }
      return { group, conflict }
    })
    .sort((left, right) => compareStableStrings(left.conflict.id, right.conflict.id))

  // A resolution is applied only when the shared refusal authority accepts it:
  // a non-participant selection leaves the conflict unresolved, never
  // half-applied.
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

/**
 * The Entries an applied explicit resolution of a `same_owned_weapon_consumed`
 * conflict excludes: every participant the resolution did not select
 * (`docs/PLANNER_SPEC.md` 9.6.2 / 21.5, Issue #334 PR-3; the PR #341 review).
 *
 * A decision on a weapon conflict is Route-level: the non-selected
 * participants would complete their Targets with the very weapon the selected
 * Entry completes its Target with, so none of them runs a unit, is progressed
 * by a shared physical action, or reserves in the run - whether or not it has
 * a unit at all (a zero-operation Candidate) and whether or not its units are
 * the selected Entry's own shareable actions. It is derived from the applied
 * selections the detection recorded (`applyPlannerConflictResolutions()`), so
 * a refused resolution excludes nobody, and it is read from the initial
 * detection once: a conflict that later leaves the per-state detection (its
 * selected Entry completed) never revives a loser. The deterministic
 * scheduler excludes the same Entries at its Route commitment
 * (`plannerRouteCommitmentRejection()`); the Beam Search oracle reads this
 * set. Counter conflicts keep their unit-level blocking
 * (`isUnitBlockedByConflictResolution()`), where the selected Entry's own
 * shareable physical action may still be shared.
 */
export function plannerEntriesExcludedByWeaponDecision(
  conflicts: readonly PlanConflict[],
): ReadonlySet<BuildListEntryId> {
  const excluded = new Set<BuildListEntryId>()
  conflicts.forEach(({ kind, buildListEntryIds, selectedBuildListEntryId }) => {
    if (kind !== 'same_owned_weapon_consumed' || selectedBuildListEntryId === null) return
    buildListEntryIds.forEach((entryId) => {
      if (entryId !== selectedBuildListEntryId) excluded.add(entryId)
    })
  })
  return excluded
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
