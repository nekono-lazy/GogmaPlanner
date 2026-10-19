import {
  applyBuildListEntryReplacements,
  createBuildCandidateMeaningFingerprint,
  type BuildListEntryReplacement,
} from '../../buildList'
import type {
  BuildListEntry,
  BuildListEntryId,
  DomainValidationIssue,
  TargetWeaponId,
} from '../../models/publicTypes'
import {
  preparePlannerInitialContext,
  type PlannerInitialContext,
} from '../plannerInitialContext'
import type {
  ExcludedBuildListEntry,
  PlannerBuildListContext,
  PlannerConflictResolution,
  PlannerDependencies,
  PlannerInput,
  PlannerWarning,
} from '../plannerTypes'
import {
  createPlannerConflictContexts,
  plannerConflictResourceKey,
  samePlannerConflictResource,
  type PlannerConflictResourceIdentity,
  type PlannerConflictContext,
  type PlannerFixedConflictConstraint,
} from './plannerConflictContext'

/**
 * The initial conflict preflight (PLANNER_SPEC 9.2.3.1; introduced by B8-C3b,
 * a shared Planner Domain primitive since Phase 6-B2a, PLANNER_SPEC 9.2.19.16).
 * The Planner Alternative trial runs it; the legacy B8 constrained re-search
 * that also ran it was removed in Phase 6-B2b.
 *
 * It runs the ordinary Planner's own validation / initial state / Route unit
 * plan / conflict detection path over an augmented `PlannerInput`, then re-maps
 * every transient `PlannerFixedConflictConstraint` onto the conflicts detected
 * right now, rebuilding a complete `PlannerConflictResolution[]` whose
 * `conflictKey` is the *current* `PlanConflict.id`.
 *
 * It deliberately runs no full Planner run, no Trace Replay, and no Candidate trial
 * loop: coexistence and Candidate adoption stay with the full rerun (9.2.11),
 * and this preflight never counts against `maxPlannerReruns` (9.2.16).
 */

/** Why one fixed constraint could not be re-associated; never a message string. */
export type PlannerConstraintReassociationFailureReason =
  /** The fixed Entry is not in the augmented `validBuildListEntries`. */
  | 'fixed_entry_not_valid'
  /** Several currently valid Entries carry the fixed BuildListEntry ID. */
  | 'fixed_entry_ambiguous'
  /** The current fixed Entry belongs to a different TargetWeapon. */
  | 'fixed_target_mismatch'
  /** The current fixed Entry carries a different Candidate semantic meaning. */
  | 'fixed_candidate_fingerprint_mismatch'
  /** No currently detected conflict matches the resource plus the fixed Entry. */
  | 'current_conflict_not_found'
  /** Several currently detected conflicts match; the mapping is unknown. */
  | 'current_conflict_ambiguous'
  /** The matched conflict carries inconsistent semantics for the fixed Entry. */
  | 'participant_context_mismatch'
  /** Two rebuilt resolutions would share one current `conflictKey`. */
  | 'resolution_key_collision'
  /**
   * The current conflict now involves a selected compromise checkpoint, so the
   * re-mapped resolution would drop a hard constraint (`docs/PLANNER_SPEC.md`
   * 9.5). Nothing is guessed: the trial fails closed.
   */
  | 'checkpoint_conflict'

export interface PlannerConstraintReassociationFailure {
  /** Diagnostic only; it is never reused as the current `conflictKey`. */
  originalConflictId: string
  resourceIdentity: PlannerConflictResourceIdentity
  fixedBuildListEntryId: BuildListEntryId
  fixedTargetWeaponId: TargetWeaponId
  reason: PlannerConstraintReassociationFailureReason
  detail: string
}

/**
 * The re-association step alone, without the preflight that produced the
 * conflicts. All-or-nothing by contract, exactly like the whole preflight.
 */
export type PlannerConstraintReassociationResult =
  | {
      status: 'ready'
      conflictResolutions: PlannerConflictResolution[]
      /**
       * The fixed constraints a temporary replacement already fulfilled
       * (`docs/PLANNER_SPEC.md` 9.2.18): each rebuilds no resolution. Always
       * empty without a `PlannerReplacementSatisfaction`.
       */
      replacementSatisfiedConstraints: PlannerFixedConflictConstraint[]
    }
  | {
      status: 'unresolved'
      conflictResolutions: []
      failures: PlannerConstraintReassociationFailure[]
    }

export type PlannerAugmentedConflictPreflightResult =
  | {
      status: 'ready'
      preflightContext: PlannerInitialContext
      conflictContexts: PlannerConflictContext[]
      /** Complete, and rebuilt against the current `PlanConflict.id`s. */
      conflictResolutions: PlannerConflictResolution[]
      /** Fixed constraints a replacement fulfilled; empty outside a replacement set. */
      replacementSatisfiedConstraints: PlannerFixedConflictConstraint[]
      /** A clone of the augmented input carrying those resolutions. */
      resolvedInput: PlannerInput
    }
  | {
      status: 'invalid'
      warnings: PlannerWarning[]
      issues: DomainValidationIssue[]
      excludedBuildListEntries: ExcludedBuildListEntry[]
    }
  | {
      status: 'unresolved'
      conflictResolutions: []
      failures: PlannerConstraintReassociationFailure[]
    }

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A run-independent processing order; the caller's array order is irrelevant. */
function constraintOrderKey(constraint: PlannerFixedConflictConstraint): string {
  return [
    plannerConflictResourceKey(constraint.resourceIdentity),
    constraint.fixedBuildListEntryId,
    constraint.fixedTargetWeaponId,
    constraint.originalConflictId,
  ].join('\u0000')
}

function failure(
  constraint: PlannerFixedConflictConstraint,
  reason: PlannerConstraintReassociationFailureReason,
  detail: string,
): PlannerConstraintReassociationFailure {
  return {
    originalConflictId: constraint.originalConflictId,
    resourceIdentity: constraint.resourceIdentity,
    fixedBuildListEntryId: constraint.fixedBuildListEntryId,
    fixedTargetWeaponId: constraint.fixedTargetWeaponId,
    reason,
    detail,
  }
}

function failureOrderKey(entry: PlannerConstraintReassociationFailure): string {
  return [
    plannerConflictResourceKey(entry.resourceIdentity),
    entry.fixedBuildListEntryId,
    entry.fixedTargetWeaponId,
    entry.originalConflictId,
    entry.reason,
  ].join('\u0000')
}

interface ResolvedConstraint {
  constraint: PlannerFixedConflictConstraint
  resolution: PlannerConflictResolution
}

interface ReplacementSatisfiedConstraint {
  constraint: PlannerFixedConflictConstraint
  satisfiedByReplacement: true
}

/**
 * What re-association over a **replacement set** needs to recognise a fixed
 * constraint the replacement itself fulfilled (`docs/PLANNER_SPEC.md` 9.2.18):
 * the persisted Entries the trial replaced, and the conflicts of the original
 * validated Planner input the constraints were built from.
 */
export interface PlannerReplacementSatisfaction {
  replacedBuildListEntryIds: readonly BuildListEntryId[]
  originalConflictContexts: readonly PlannerConflictContext[]
}

/**
 * The one exception PLANNER_SPEC 9.2.18 adds to the 9.2.3.1 re-association: a
 * fixed constraint with no current match is fulfilled - not failed - when
 * every participant of its *original* conflict other than the fixed Entry is
 * an Entry this augmentation replaced. The user's choice is then realised by
 * the losing side's alternate Route. Anything else - an unknown original
 * conflict, a participant that was not replaced, no other participant at all -
 * stays a failure, never a guess.
 */
function isFulfilledByReplacement(
  constraint: PlannerFixedConflictConstraint,
  satisfaction: PlannerReplacementSatisfaction,
): boolean {
  const original = satisfaction.originalConflictContexts.filter(
    ({ conflictId }) => conflictId === constraint.originalConflictId,
  )
  if (original.length !== 1) return false
  const others = original[0].participants.filter(
    ({ buildListEntryId }) => buildListEntryId !== constraint.fixedBuildListEntryId,
  )
  const replaced = new Set(satisfaction.replacedBuildListEntryIds)
  return others.length > 0 && others.every(({ buildListEntryId }) => replaced.has(buildListEntryId))
}

type FixedEntryLookup =
  | { entry: BuildListEntry }
  | { reason: 'fixed_entry_not_valid' | 'fixed_entry_ambiguous' }

/**
 * The current fixed Entry, taken from the preflight's own
 * `validBuildListEntries`.
 *
 * PLANNER_SPEC 9.2.3.1 forbids resolving it from the raw
 * `PlannerInput.buildListEntries`: an Entry that validation excluded for
 * staleness, capability, prediction support, protection, or CalculationContext
 * incompatibility must not be revived on the fixed side.
 */
function currentFixedEntry(
  context: PlannerInitialContext,
  constraint: PlannerFixedConflictConstraint,
): FixedEntryLookup {
  const matching = context.validBuildListEntries.filter(
    ({ entry }) => entry.id === constraint.fixedBuildListEntryId,
  )
  if (matching.length === 0) return { reason: 'fixed_entry_not_valid' }
  if (matching.length > 1) return { reason: 'fixed_entry_ambiguous' }
  return { entry: matching[0].entry }
}

/**
 * Re-maps one fixed constraint onto the conflicts detected right now.
 *
 * The match condition is exactly the two of PLANNER_SPEC 9.2.3.1: the conflict
 * resource identity is equal, and the current participant set contains the
 * fixed BuildListEntry ID. The original `PlanConflict.id` is never part of it,
 * because adding a generated Entry changes the id of the same physical
 * conflict.
 */
function reassociateConstraint(
  context: PlannerInitialContext,
  conflictContexts: readonly PlannerConflictContext[],
  constraint: PlannerFixedConflictConstraint,
  satisfaction: PlannerReplacementSatisfaction | null,
): ResolvedConstraint | ReplacementSatisfiedConstraint | PlannerConstraintReassociationFailure {
  const found = currentFixedEntry(context, constraint)
  if (!('entry' in found)) {
    return failure(
      constraint,
      found.reason,
      found.reason === 'fixed_entry_ambiguous'
        ? `Several currently valid BuildListEntries carry the fixed id '${constraint.fixedBuildListEntryId}'.`
        : `Fixed BuildListEntry '${constraint.fixedBuildListEntryId}' is not valid in the augmented Planner input.`,
    )
  }
  const entry = found.entry
  if (entry.targetWeaponId !== constraint.fixedTargetWeaponId) {
    return failure(
      constraint,
      'fixed_target_mismatch',
      `Fixed BuildListEntry '${constraint.fixedBuildListEntryId}' now targets '${entry.targetWeaponId}' instead of '${constraint.fixedTargetWeaponId}'.`,
    )
  }
  const fingerprint = createBuildCandidateMeaningFingerprint(
    entry.candidateSnapshot,
  )
  if (fingerprint !== constraint.fixedCandidateFingerprint) {
    return failure(
      constraint,
      'fixed_candidate_fingerprint_mismatch',
      `Fixed BuildListEntry '${constraint.fixedBuildListEntryId}' now carries a different Candidate semantic meaning.`,
    )
  }
  const matching = conflictContexts.filter(
    (conflictContext) =>
      samePlannerConflictResource(
        conflictContext.resourceIdentity,
        constraint.resourceIdentity,
      ) &&
      conflictContext.participants.some(
        ({ buildListEntryId }) =>
          buildListEntryId === constraint.fixedBuildListEntryId,
      ),
  )
  if (matching.length === 0) {
    if (satisfaction !== null && isFulfilledByReplacement(constraint, satisfaction)) {
      return { constraint, satisfiedByReplacement: true }
    }
    return failure(
      constraint,
      'current_conflict_not_found',
      `No currently detected conflict carries this resource together with BuildListEntry '${constraint.fixedBuildListEntryId}'.`,
    )
  }
  if (matching.length > 1) {
    return failure(
      constraint,
      'current_conflict_ambiguous',
      `${matching.length} currently detected conflicts carry this resource together with BuildListEntry '${constraint.fixedBuildListEntryId}'.`,
    )
  }
  const current = matching[0]
  if (current.involvesSelectedCheckpoint) {
    return failure(
      constraint,
      'checkpoint_conflict',
      `Conflict '${current.conflictId}' involves a selected compromise checkpoint, so BuildListEntry '${constraint.fixedBuildListEntryId}' cannot be fixed over it.`,
    )
  }
  // One Entry may legitimately participate through several Route units, so unit
  // count is never the authority. Only a mixed semantic participant context is
  // a mismatch (PLANNER_SPEC 9.2.3.1).
  const inconsistent = current.participants.some(
    ({ buildListEntryId, targetWeaponId, candidateFingerprint }) =>
      buildListEntryId === constraint.fixedBuildListEntryId &&
      (targetWeaponId !== constraint.fixedTargetWeaponId ||
        candidateFingerprint !== constraint.fixedCandidateFingerprint),
  )
  if (inconsistent) {
    return failure(
      constraint,
      'participant_context_mismatch',
      `Conflict '${current.conflictId}' carries inconsistent participant semantics for BuildListEntry '${constraint.fixedBuildListEntryId}'.`,
    )
  }
  return {
    constraint,
    resolution: {
      conflictKey: current.conflictId,
      selectedBuildListEntryId: constraint.fixedBuildListEntryId,
    },
  }
}

/**
 * Rejects a rebuilt array in which two constraints landed on one current
 * `conflictKey`.
 *
 * `validatePlannerInput()` requires unique conflict keys, so a silent dedupe
 * would either drop a user's explicit choice or make the next full Planner run input
 * invalid. Neither is guessable, so this fails closed like every other
 * re-association failure.
 */
function keyCollisionFailures(
  resolved: readonly ResolvedConstraint[],
): PlannerConstraintReassociationFailure[] {
  const countByKey = new Map<string, number>()
  resolved.forEach(({ resolution }) => {
    countByKey.set(
      resolution.conflictKey,
      (countByKey.get(resolution.conflictKey) ?? 0) + 1,
    )
  })
  return resolved
    .filter(({ resolution }) => (countByKey.get(resolution.conflictKey) ?? 0) > 1)
    .map(({ constraint, resolution }) =>
      failure(
        constraint,
        'resolution_key_collision',
        `Several fixed constraints re-associate to conflict '${resolution.conflictKey}'.`,
      ),
    )
}

/**
 * Re-maps every fixed constraint onto `conflictContexts` and rebuilds the
 * complete `PlannerConflictResolution[]` against the current `PlanConflict.id`s.
 *
 * `context` supplies the current fixed-Entry authority, so it must be the
 * preflight context those `conflictContexts` were built from.
 *
 * `satisfaction` is given only over a replacement set: each constraint is then
 * judged on its own, so a constraint the replacement fulfilled rebuilds no
 * resolution while every other constraint is still re-mapped - or fails - as
 * before. An unrelated explicit resolution is never dropped with it.
 */
export function reassociatePlannerFixedConstraints(
  context: PlannerInitialContext,
  conflictContexts: readonly PlannerConflictContext[],
  fixedConstraints: readonly PlannerFixedConflictConstraint[],
  satisfaction: PlannerReplacementSatisfaction | null = null,
): PlannerConstraintReassociationResult {
  const ordered = [...fixedConstraints].sort((left, right) =>
    compareStableStrings(constraintOrderKey(left), constraintOrderKey(right)),
  )
  const resolved: ResolvedConstraint[] = []
  const satisfied: PlannerFixedConflictConstraint[] = []
  const failures: PlannerConstraintReassociationFailure[] = []
  ordered.forEach((constraint) => {
    const outcome = reassociateConstraint(context, conflictContexts, constraint, satisfaction)
    if ('reason' in outcome) {
      failures.push(outcome)
      return
    }
    if ('satisfiedByReplacement' in outcome) {
      satisfied.push(outcome.constraint)
      return
    }
    resolved.push(outcome)
  })
  failures.push(...keyCollisionFailures(resolved))
  if (failures.length > 0) {
    return {
      status: 'unresolved',
      conflictResolutions: [],
      failures: failures.sort((left, right) =>
        compareStableStrings(failureOrderKey(left), failureOrderKey(right)),
      ),
    }
  }
  return {
    status: 'ready',
    conflictResolutions: resolved
      .map(({ resolution }) => resolution)
      .sort(
        (left, right) =>
          compareStableStrings(left.conflictKey, right.conflictKey) ||
          compareStableStrings(
            left.selectedBuildListEntryId,
            right.selectedBuildListEntryId,
          ),
      ),
    replacementSatisfiedConstraints: satisfied,
  }
}

/**
 * Runs the augmented initial conflict preflight and rebuilds the complete
 * `PlannerConflictResolution[]` for the caller's next full Planner run.
 *
 * `fixedConstraints` come from `preparePlannerFixedConflictConstraints()` over
 * the *original* validated Planner input (PLANNER_SPEC 9.2.3.1). This function
 * creates no constraint of its own, so a generated Entry that joins a current
 * conflict is never promoted to the fixed side (9.2.7), and a conflict without
 * an explicit resolution is never fixed from `recommendedBuildListEntryId`, a
 * full Planner run's bestState participant, Target priority, or Candidate score.
 *
 * It is all-or-nothing: one failure yields `status: 'unresolved'` with no
 * resolutions at all, so a partially rebuilt array can never reach a full Planner run.
 *
 * `replacements` name the temporary Entries of `augmentedInput` and the
 * persisted Entries they stand in for (`docs/PLANNER_SPEC.md` 9.2.18); the
 * input is then checked under the temporary augmented contract. Without them
 * the input is an ordinary persisted one. This preflight re-maps over the
 * augmented set, `O` included; a trial's full Planner run needs the second,
 * replacement-set step of `preparePlannerReplacementConflictPreflight()`.
 */
export function preparePlannerAugmentedConflictPreflight(
  augmentedInput: PlannerInput,
  fixedConstraints: readonly PlannerFixedConflictConstraint[],
  dependencies: PlannerDependencies,
  replacements: readonly BuildListEntryReplacement[] = [],
): PlannerAugmentedConflictPreflightResult {
  return runConflictPreflight(
    augmentedInput,
    fixedConstraints,
    dependencies,
    replacements.length === 0
      ? { kind: 'persisted' }
      : { kind: 'temporary_augmented', replacements },
    null,
  )
}

function runConflictPreflight(
  input: PlannerInput,
  fixedConstraints: readonly PlannerFixedConflictConstraint[],
  dependencies: PlannerDependencies,
  buildListContext: PlannerBuildListContext,
  satisfaction: PlannerReplacementSatisfaction | null,
): PlannerAugmentedConflictPreflightResult {
  // The original `conflictKey`s no longer match once the participant set
  // changed, so applying them here would raise a false
  // `invalid_conflict_resolution` (PLANNER_SPEC 9.2.3.1).
  const preflightInput: PlannerInput = {
    ...input,
    conflictResolutions: [],
  }
  const prepared = preparePlannerInitialContext(preflightInput, dependencies, buildListContext)
  if (prepared.status !== 'ready') {
    return {
      status: 'invalid',
      warnings: prepared.warnings,
      issues: prepared.issues,
      excludedBuildListEntries: prepared.excludedBuildListEntries,
    }
  }
  const context = prepared.context
  const conflictContexts = createPlannerConflictContexts(context)
  const reassociated = reassociatePlannerFixedConstraints(
    context,
    conflictContexts,
    fixedConstraints,
    satisfaction,
  )
  if (reassociated.status !== 'ready') return reassociated
  const conflictResolutions = reassociated.conflictResolutions
  return {
    status: 'ready',
    preflightContext: context,
    conflictContexts,
    conflictResolutions,
    replacementSatisfiedConstraints: reassociated.replacementSatisfiedConstraints,
    resolvedInput: { ...input, conflictResolutions },
  }
}

export type PlannerReplacementConflictPreflightResult =
  | {
      status: 'ready'
      /** The augmented step (`O` + `G`), kept for diagnostics and tests. */
      augmentedPreflight: Extract<PlannerAugmentedConflictPreflightResult, { status: 'ready' }>
      /** The replacement-set step every full Planner run of the trial uses. */
      replacementPreflight: Extract<PlannerAugmentedConflictPreflightResult, { status: 'ready' }>
      replacements: BuildListEntryReplacement[]
      /**
       * The replacement set (every `O` removed, every `G` in its place)
       * carrying the resolutions rebuilt against its own `PlanConflict.id`s.
       * It is the only input a trial's full Planner run may receive.
       */
      resolvedInput: PlannerInput
    }
  | Exclude<PlannerAugmentedConflictPreflightResult, { status: 'ready' }>

/**
 * The whole trial preflight of `docs/PLANNER_SPEC.md` 9.2.18, in its two fixed
 * steps:
 *
 * 1. **augmented**: `augmentedInput` still holds every replaced Entry `O` next
 *    to its temporary Entry `G`, under the temporary augmented contract
 *    (persisted 0..1 + temporary 0..1 per Target). Every fixed constraint is
 *    re-mapped exactly as 9.2.3.1 requires, which also proves the fixed
 *    Entries and the temporary Entries survive the ordinary validation.
 * 2. **replacement set**: every `O` is removed and the same fixed constraints
 *    are re-mapped again against the conflicts detected there - the only
 *    `conflictKey`s a full Planner run over the replacement set can match. A
 *    constraint with no match there is fulfilled by the replacement only when
 *    every other participant of its original conflict was replaced; every
 *    other failure fails the trial closed.
 *
 * Neither step runs a full Planner run or counts against `maxPlannerReruns`, and
 * both are all-or-nothing. `originalConflictContexts` are the conflicts of the
 * original validated Planner input the fixed constraints were built from.
 */
export function preparePlannerReplacementConflictPreflight(
  augmentedInput: PlannerInput,
  replacements: readonly BuildListEntryReplacement[],
  fixedConstraints: readonly PlannerFixedConflictConstraint[],
  originalConflictContexts: readonly PlannerConflictContext[],
  dependencies: PlannerDependencies,
): PlannerReplacementConflictPreflightResult {
  const augmentedPreflight = preparePlannerAugmentedConflictPreflight(
    augmentedInput,
    fixedConstraints,
    dependencies,
    replacements,
  )
  if (augmentedPreflight.status !== 'ready') return augmentedPreflight
  const replacementInput: PlannerInput = {
    ...augmentedInput,
    buildListEntries: applyBuildListEntryReplacements(
      augmentedInput.buildListEntries,
      replacements,
      [],
    ),
  }
  const replacementPreflight = runConflictPreflight(
    replacementInput,
    fixedConstraints,
    dependencies,
    { kind: 'temporary_replacement', replacements },
    {
      replacedBuildListEntryIds: replacements.map(({ replacedBuildListEntryId }) => replacedBuildListEntryId),
      originalConflictContexts,
    },
  )
  if (replacementPreflight.status !== 'ready') return replacementPreflight
  return {
    status: 'ready',
    augmentedPreflight,
    replacementPreflight,
    replacements: replacements.map((replacement) => ({ ...replacement })),
    resolvedInput: replacementPreflight.resolvedInput,
  }
}
