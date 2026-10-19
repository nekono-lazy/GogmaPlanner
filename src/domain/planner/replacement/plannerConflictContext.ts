import { createBuildCandidateMeaningFingerprint } from '../../buildList'
import { stableStringify } from '../../models/publicTypes'
import type {
  BuildListEntry,
  BuildListEntryId,
  ConflictKind,
  OwnedWeaponId,
  PlanConflict,
  RouteOperation,
  TargetWeaponId,
} from '../../models/publicTypes'
import { hasIntermediateStateSelection } from '../plannerCheckpoints'
import {
  conflictInvolvesSelectedCheckpoint,
  plannerRouteUnitKey,
} from '../plannerConflictDetection'
import type { PlannerInitialContext } from '../plannerInitialContext'
import {
  routeUnitOwnedWeaponId,
  type PlannerCounterStream,
  type PlannerRouteUnit,
} from '../plannerRouteProgress'

/**
 * The transient view of one detected `PlanConflict` (PLANNER_SPEC 9.2.3): the
 * current Planner conflict projected onto its resource identity plus its
 * participant contexts, and every explicit resolution held as a fixed Entry
 * constraint that a later preflight re-associates.
 *
 * It is a shared Planner Domain primitive (Phase 6-B2a, PLANNER_SPEC
 * 9.2.19.16): the Planner Alternative preflight / scenario preparation stands
 * on it (the legacy B8 / B9 path that also did was removed in Phase 6-B2b).
 *
 * Everything in this module is Planner-Domain, transient, and non-persisted. It
 * is never embedded in a `ProductionPlan` and never handed to the Search Domain
 * (9.2.9), and it neither extends nor replaces `PlanConflict`,
 * `PlannerConflictResolution`, the `PlanConflict.id` generation rule,
 * `detectPlannerConflicts()` semantics, `physicalActionKey` semantics,
 * shareability semantics, or the full Planner run resolution application rule.
 */

/**
 * The physical resource a conflict is about, deliberately without the
 * participant BuildListEntry set (PLANNER_SPEC 9.2.3, 競合資源identity).
 *
 * Adding a generated Entry changes `PlanConflict.id` for the very same physical
 * conflict, so 9.2.3.1 re-maps a user's fixed choice by this identity instead.
 * Including the participants would guarantee a mismatch and make every
 * re-mapping fail.
 */
export type PlannerConflictResourceIdentity =
  | { kind: 'same_gogma_counter'; counterStream: 'gogma'; counterBefore: number }
  | { kind: 'same_skill_counter'; counterStream: 'skill'; counterBefore: number }
  | {
      kind: 'same_normal_counter'
      counterStream: 'normal'
      normalCounterId: string
      counterBefore: number
    }
  | {
      kind: 'same_owned_weapon_consumed'
      counterStream: null
      consumedOwnedWeaponId: OwnedWeaponId
    }

/**
 * One conflict participant, at `PlannerRouteUnit` granularity.
 *
 * `counterAfter`, the operation type, `sourceOwnedWeaponId`, and
 * `physicalActionKey` differ per participant, so PLANNER_SPEC 9.2.3 keeps them
 * here rather than on the conflict.
 */
export interface PlannerConflictParticipantContext {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
  /** The 9.2.12 Candidate semantic identity; no Candidate ID, run ID, or timestamp. */
  candidateFingerprint: string
  operationType: RouteOperation['type']
  counterAfter: number | null
  sourceOwnedWeaponId: OwnedWeaponId | null
  exclusiveConsumedOwnedWeaponId: OwnedWeaponId | null
  physicalActionKey: string
  /**
   * Whether this participant's BuildListEntry carries a selected compromise
   * checkpoint. No Route replacement search (the Planner Alternative) ever
   * replaces such an Entry's Route:
   * any alternate Route would drop the checkpoint the user selected
   * (`docs/PLANNER_SPEC.md` 9.5.2).
   */
  hasSelectedCheckpoints: boolean
}

export interface PlannerConflictContext {
  /** The `PlanConflict.id` detected right now; diagnostic only for re-mapping. */
  conflictId: string
  kind: ConflictKind
  /**
   * Whether a selected compromise checkpoint takes part in this conflict. Such
   * a conflict is never fixed by a winner-picking resolution
   * (`docs/PLANNER_SPEC.md` 9.5).
   */
  involvesSelectedCheckpoint: boolean
  resourceIdentity: PlannerConflictResourceIdentity
  counterStream: PlannerCounterStream
  normalCounterId: string | null
  counterBefore: number | null
  /**
   * The exclusively consumed OwnedWeapon of a `same_owned_weapon_consumed`
   * conflict, as its own field. PLANNER_SPEC 9.2.3 forbids substituting a
   * participant's `sourceOwnedWeaponId`: a consumed material weapon is not
   * necessarily the Route source, and it differs per participant.
   */
  consumedOwnedWeaponId: OwnedWeaponId | null
  participants: PlannerConflictParticipantContext[]
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A stable comparison key for one resource identity; not a persisted value. */
export function plannerConflictResourceKey(
  identity: PlannerConflictResourceIdentity,
): string {
  return stableStringify(identity)
}

export function samePlannerConflictResource(
  left: PlannerConflictResourceIdentity,
  right: PlannerConflictResourceIdentity,
): boolean {
  return plannerConflictResourceKey(left) === plannerConflictResourceKey(right)
}

function invariant(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Planner conflict context invariant violated: ${message}`)
  }
}

/**
 * The participant `sourceOwnedWeaponId`, derived from Route / operation
 * semantics through the existing `routeUnitOwnedWeaponId()` authority.
 *
 * It stays separate from `exclusiveConsumedOwnedWeaponId`, which a
 * `same_owned_weapon_consumed` conflict carries in its own field: the exclusively
 * consumed weapon is never squeezed into the source field (PLANNER_SPEC 9.2.3).
 */
function participantSourceOwnedWeaponId(
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): OwnedWeaponId | null {
  return routeUnitOwnedWeaponId(entry, unit)
}

function unitResourceIdentity(
  conflict: PlanConflict,
  unit: PlannerRouteUnit,
): PlannerConflictResourceIdentity {
  switch (conflict.kind) {
    case 'same_gogma_counter':
      invariant(
        unit.counterStream === 'gogma' && unit.counterBefore !== null,
        `conflict '${conflict.id}' has a participant without a Gogma Counter position.`,
      )
      return {
        kind: 'same_gogma_counter',
        counterStream: 'gogma',
        counterBefore: unit.counterBefore as number,
      }
    case 'same_skill_counter':
      invariant(
        unit.counterStream === 'skill' && unit.counterBefore !== null,
        `conflict '${conflict.id}' has a participant without a Skill Counter position.`,
      )
      return {
        kind: 'same_skill_counter',
        counterStream: 'skill',
        counterBefore: unit.counterBefore as number,
      }
    case 'same_normal_counter':
      invariant(
        unit.counterStream === 'normal' &&
          unit.counterId !== null &&
          unit.counterBefore !== null,
        `conflict '${conflict.id}' has a participant without a Normal Counter position.`,
      )
      return {
        kind: 'same_normal_counter',
        counterStream: 'normal',
        normalCounterId: unit.counterId as string,
        counterBefore: unit.counterBefore as number,
      }
    case 'same_owned_weapon_consumed':
      invariant(
        unit.exclusiveConsumedOwnedWeaponId !== null,
        `conflict '${conflict.id}' has a participant that exclusively consumes no OwnedWeapon.`,
      )
      return {
        kind: 'same_owned_weapon_consumed',
        counterStream: null,
        consumedOwnedWeaponId:
          unit.exclusiveConsumedOwnedWeaponId as OwnedWeaponId,
      }
  }
}

function resourceIdentity(
  conflict: PlanConflict,
  units: readonly PlannerRouteUnit[],
): PlannerConflictResourceIdentity {
  invariant(
    units.length > 0,
    `conflict '${conflict.id}' has no participating Route unit.`,
  )
  const identities = units.map((unit) => unitResourceIdentity(conflict, unit))
  invariant(
    new Set(identities.map(plannerConflictResourceKey)).size === 1,
    `conflict '${conflict.id}' mixes several physical resources.`,
  )
  return identities[0]
}

function participantContext(
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
  fingerprint: string,
): PlannerConflictParticipantContext {
  return {
    buildListEntryId: entry.id,
    targetWeaponId: entry.targetWeaponId,
    candidateFingerprint: fingerprint,
    operationType: unit.operation.type,
    counterAfter: unit.counterAfter,
    sourceOwnedWeaponId: participantSourceOwnedWeaponId(entry, unit),
    exclusiveConsumedOwnedWeaponId: unit.exclusiveConsumedOwnedWeaponId,
    physicalActionKey: unit.physicalActionKey,
    hasSelectedCheckpoints: hasIntermediateStateSelection(entry),
  }
}

/**
 * Rebuilds, for every conflict the ordinary Planner already detected, the
 * `PlannerRouteUnit`s that took part in it.
 *
 * The authority is the existing `PlannerConflictDetectionResult`: its
 * `conflictIdsByUnitKey` is inverted with the existing `plannerRouteUnitKey()`.
 * No grouping of its own, no `usedCounters` shortcut, and no copy of the
 * `detectPlannerConflicts()` internals (PLANNER_SPEC 9.2.11).
 */
function participatingUnitsByConflictId(
  context: PlannerInitialContext,
): ReadonlyMap<string, readonly PlannerRouteUnit[]> {
  const unitsByConflictId = new Map<string, PlannerRouteUnit[]>()
  const seenUnitKeysByConflictId = new Map<string, Set<string>>()
  context.initialRelevantUnitPlans.forEach((units) => {
    units.forEach((unit) => {
      const unitKey = plannerRouteUnitKey(unit)
      const conflictIds =
        context.initialConflictDetection.conflictIdsByUnitKey.get(unitKey) ?? []
      conflictIds.forEach((conflictId) => {
        const seen = seenUnitKeysByConflictId.get(conflictId) ?? new Set<string>()
        if (seen.has(unitKey)) return
        seen.add(unitKey)
        seenUnitKeysByConflictId.set(conflictId, seen)
        unitsByConflictId.set(conflictId, [
          ...(unitsByConflictId.get(conflictId) ?? []),
          unit,
        ])
      })
    })
  })
  return unitsByConflictId
}

/**
 * Builds the transient conflict contexts for the conflicts the ordinary Planner
 * detected in `preparePlannerInitialContext()`.
 *
 * It creates no conflict of its own: a same-Counter position the existing
 * shareability rules accept produces no `PlanConflict`, and therefore no
 * context either.
 */
export function createPlannerConflictContexts(
  context: PlannerInitialContext,
): PlannerConflictContext[] {
  const unitsByConflictId = participatingUnitsByConflictId(context)
  const fingerprintByEntryId = new Map<BuildListEntryId, string>()
  const fingerprintOf = (entry: BuildListEntry): string => {
    const cached = fingerprintByEntryId.get(entry.id)
    if (cached !== undefined) return cached
    const fingerprint = createBuildCandidateMeaningFingerprint(
      entry.candidateSnapshot,
    )
    fingerprintByEntryId.set(entry.id, fingerprint)
    return fingerprint
  }
  return [...context.initialConflictDetection.conflicts]
    .sort((left, right) => compareStableStrings(left.id, right.id))
    .map((conflict) => {
      const units = [...(unitsByConflictId.get(conflict.id) ?? [])].sort(
        (left, right) =>
          compareStableStrings(left.entryId, right.entryId) ||
          left.position.operationIndex - right.position.operationIndex ||
          left.position.unitIndex - right.position.unitIndex ||
          compareStableStrings(left.physicalActionKey, right.physicalActionKey),
      )
      const identity = resourceIdentity(conflict, units)
      const participants = units.map((unit) => {
        const entry = context.entriesById.get(unit.entryId)
        invariant(
          entry !== undefined,
          `conflict '${conflict.id}' names unknown BuildListEntry '${unit.entryId}'.`,
        )
        const known = entry as BuildListEntry
        return participantContext(known, unit, fingerprintOf(known))
      })
      return {
        conflictId: conflict.id,
        kind: conflict.kind,
        involvesSelectedCheckpoint: conflictInvolvesSelectedCheckpoint(conflict),
        resourceIdentity: identity,
        counterStream: identity.counterStream,
        normalCounterId:
          identity.kind === 'same_normal_counter'
            ? identity.normalCounterId
            : null,
        counterBefore:
          identity.kind === 'same_owned_weapon_consumed'
            ? null
            : identity.counterBefore,
        consumedOwnedWeaponId:
          identity.kind === 'same_owned_weapon_consumed'
            ? identity.consumedOwnedWeaponId
            : null,
        participants,
      }
    })
}

/**
 * One user-fixed Candidate, held as a transient constraint instead of as the
 * `conflictKey` it was selected under (PLANNER_SPEC 9.2.3.1 / 9.2.7).
 *
 * The augmented / replacement preflight (`plannerAugmentedPreflight`, B8-C3b
 * originally) re-maps it onto the conflicts it detects, using
 * `resourceIdentity` plus `fixedBuildListEntryId` participation. It carries no
 * provenance field and nothing that marks a generated Entry, because a
 * generated Entry is never promoted to the fixed side.
 */
export interface PlannerFixedConflictConstraint {
  /**
   * The `PlanConflict.id` the user selected under, kept for diagnostics only.
   * The preflight must NOT reuse it as the current `conflictKey`: adding a generated
   * Entry changes the id of the same physical conflict, so `resourceIdentity`
   * is the re-mapping authority.
   */
  originalConflictId: string
  resourceIdentity: PlannerConflictResourceIdentity
  fixedBuildListEntryId: BuildListEntryId
  fixedTargetWeaponId: TargetWeaponId
  fixedCandidateFingerprint: string
}

export type PlannerFixedConstraintFailureReason =
  /** No currently valid BuildListEntry carries the selected id. */
  | 'selected_entry_not_valid'
  /** Several currently valid BuildListEntries carry the selected id. */
  | 'selected_entry_ambiguous'
  /** `conflictKey` matches no currently detected `PlanConflict`. */
  | 'conflict_not_found'
  /** The selected Entry is not a participant of that conflict. */
  | 'selected_entry_not_participant'
  /** No unique participant context carries the selected Entry's semantics. */
  | 'participant_context_ambiguous'
  /**
   * The conflict involves a selected compromise checkpoint, which no
   * winner-picking resolution may settle (`docs/PLANNER_SPEC.md` 9.5).
   */
  | 'checkpoint_conflict'

export interface PlannerFixedConstraintFailure {
  conflictKey: string
  selectedBuildListEntryId: BuildListEntryId
  reason: PlannerFixedConstraintFailureReason
  detail: string
}

/**
 * All-or-nothing by contract (PLANNER_SPEC 9.2.3.1): a partially rebuilt
 * resolution array must never reach a full Planner run, so a single failure yields no
 * constraints at all instead of a usable subset. The caller branches on
 * `status` and `failures[].reason`, never on message text.
 */
export type PlannerFixedConstraintPreparationResult =
  | { status: 'ready'; constraints: PlannerFixedConflictConstraint[] }
  | {
      status: 'unresolved'
      constraints: []
      failures: PlannerFixedConstraintFailure[]
    }

function constraintFailure(
  conflictKey: string,
  selectedBuildListEntryId: BuildListEntryId,
  reason: PlannerFixedConstraintFailureReason,
  detail: string,
): PlannerFixedConstraintFailure {
  return { conflictKey, selectedBuildListEntryId, reason, detail }
}

/**
 * Turns every valid explicit `PlannerConflictResolution` into a transient fixed
 * constraint.
 *
 * The only fixed authority is `PlannerConflictResolution.selectedBuildListEntryId`
 * (PLANNER_SPEC 9.2.7). `recommendedBuildListEntryId`, a full Planner run bestState
 * participant, Target priority, and Candidate score are never consulted, so a
 * conflict without an explicit resolution simply produces no constraint.
 *
 * The source is `PlannerInitialContext.validConflictResolutions`, taken from the
 * validated original Planner input (9.2.3.1). Resolutions validation already
 * dropped are not revived, and no constraint is ever built from a generated
 * Entry of an augmented input: the preflight re-maps these constraints, it does not
 * create new ones from generated Entries.
 *
 * The selected BuildListEntry ID must name exactly one entry of
 * `context.validBuildListEntries`, and that entry alone supplies the fixed
 * Target and Candidate fingerprint. `validatePlannerInput()` does not reject a
 * duplicated BuildListEntry ID, so a malformed input could otherwise fix a
 * Target and fingerprint chosen by Map insertion order. Its own semantics are
 * unchanged here: this is a C3 fixed-constraint boundary check, not a new
 * Planner input rule.
 *
 * `conflictContexts` must be the result of
 * `createPlannerConflictContexts(context)` for the same context.
 */
export function preparePlannerFixedConflictConstraints(
  context: PlannerInitialContext,
  conflictContexts: readonly PlannerConflictContext[],
): PlannerFixedConstraintPreparationResult {
  const conflictById = new Map(
    context.initialConflictDetection.conflicts.map((conflict) => [
      conflict.id,
      conflict,
    ]),
  )
  const contextById = new Map(
    conflictContexts.map((entry) => [entry.conflictId, entry]),
  )
  const constraints: PlannerFixedConflictConstraint[] = []
  const failures: PlannerFixedConstraintFailure[] = []
  const orderedResolutions = [...context.validConflictResolutions].sort(
    (left, right) => compareStableStrings(left.conflictKey, right.conflictKey),
  )
  orderedResolutions.forEach((resolution) => {
    // The original fixed semantics come from `validBuildListEntries`, never
    // from `entriesById` or a participant context: both are Maps built from the
    // same Entry array, so a malformed input carrying one BuildListEntry ID
    // twice would silently resolve to whichever entry was inserted last, making
    // the fixed Target and fingerprint depend on input order. Identity of the
    // user-selected Entry has to be unique before anything is fixed on it.
    const selectedEntries = context.validBuildListEntries.filter(
      ({ entry }) => entry.id === resolution.selectedBuildListEntryId,
    )
    if (selectedEntries.length === 0) {
      failures.push(constraintFailure(
        resolution.conflictKey,
        resolution.selectedBuildListEntryId,
        'selected_entry_not_valid',
        `BuildListEntry '${resolution.selectedBuildListEntryId}' is not among the currently valid Planner entries.`,
      ))
      return
    }
    if (selectedEntries.length > 1) {
      failures.push(constraintFailure(
        resolution.conflictKey,
        resolution.selectedBuildListEntryId,
        'selected_entry_ambiguous',
        `${selectedEntries.length} currently valid BuildListEntries carry the id '${resolution.selectedBuildListEntryId}'.`,
      ))
      return
    }
    const selected = selectedEntries[0].entry
    const fixedTargetWeaponId = selected.targetWeaponId
    const fixedCandidateFingerprint = createBuildCandidateMeaningFingerprint(
      selected.candidateSnapshot,
    )
    const conflict = conflictById.get(resolution.conflictKey)
    if (conflict === undefined) {
      failures.push(constraintFailure(
        resolution.conflictKey,
        resolution.selectedBuildListEntryId,
        'conflict_not_found',
        `Conflict resolution '${resolution.conflictKey}' does not match a currently detected conflict.`,
      ))
      return
    }
    if (!conflict.buildListEntryIds.includes(resolution.selectedBuildListEntryId)) {
      failures.push(constraintFailure(
        resolution.conflictKey,
        resolution.selectedBuildListEntryId,
        'selected_entry_not_participant',
        `BuildListEntry '${resolution.selectedBuildListEntryId}' is not a participant in conflict '${resolution.conflictKey}'.`,
      ))
      return
    }
    if (conflictInvolvesSelectedCheckpoint(conflict)) {
      // Fixing either side would make the other give up the Counter position
      // its selected checkpoint needs. The Build List, not a resolution, is
      // where this conflict is settled.
      failures.push(constraintFailure(
        resolution.conflictKey,
        resolution.selectedBuildListEntryId,
        'checkpoint_conflict',
        `Conflict '${resolution.conflictKey}' involves a selected compromise checkpoint and cannot be fixed by preferring BuildListEntry '${resolution.selectedBuildListEntryId}'.`,
      ))
      return
    }
    const conflictContext = contextById.get(resolution.conflictKey)
    const matching = (conflictContext?.participants ?? []).filter(
      ({ buildListEntryId }) =>
        buildListEntryId === resolution.selectedBuildListEntryId,
    )
    // Every participating unit must agree with the unique selected Entry's own
    // semantics; the participant context confirms them, it never supplies them.
    const inconsistent = matching.some(
      ({ targetWeaponId, candidateFingerprint }) =>
        targetWeaponId !== fixedTargetWeaponId ||
        candidateFingerprint !== fixedCandidateFingerprint,
    )
    if (conflictContext === undefined || matching.length === 0 || inconsistent) {
      failures.push(constraintFailure(
        resolution.conflictKey,
        resolution.selectedBuildListEntryId,
        'participant_context_ambiguous',
        `Conflict '${resolution.conflictKey}' carries no unique participant context for BuildListEntry '${resolution.selectedBuildListEntryId}'.`,
      ))
      return
    }
    constraints.push({
      originalConflictId: conflict.id,
      resourceIdentity: conflictContext.resourceIdentity,
      fixedBuildListEntryId: resolution.selectedBuildListEntryId,
      fixedTargetWeaponId,
      fixedCandidateFingerprint,
    })
  })
  if (failures.length > 0) {
    return { status: 'unresolved', constraints: [], failures }
  }
  return { status: 'ready', constraints }
}
