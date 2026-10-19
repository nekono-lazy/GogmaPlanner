import {
  applyBuildListEntryReplacements,
  buildListEntriesForTarget,
  evaluateBuildListEntryStaleness,
  validateBuildListEntryReplacements,
  validateGeneratedBuildListEntryReplacements,
  validateReplacedBuildListCardinality,
  type BuildListEntryReplacement,
} from '../buildList'
import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  NormalArtianCounter,
  OwnedWeapon,
  ProductionPlan,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  validateBuildListEntry,
  validateProductionPlan,
} from '../models/publicTypes'
import type { DomainValidationResult } from '../models/validation'
import {
  plannerPlanCompletionRecord,
  plannerPreferredBuildListEntryIds,
} from './plannerConflictPreferenceOutcome'
import type {
  PlannerConflictResolution,
  PlannerResult,
  PlannerRunTermination,
} from './plannerTypes'

/**
 * The pure save-time checks a Planner result must pass before it is persisted
 * (`docs/PLANNER_SPEC.md` 9.2.15), shared by the ordinary Planner result save,
 * the conflict preference save (9.6.6), the Build List optimization adoption
 * (17.11) and the replan adoption (16.8).
 *
 * Each check returns the first issue it finds, or `null`. It never throws, so
 * each caller maps an issue onto its own error boundary: the ordinary save onto
 * `RepositoryError`, the replan adoption onto `ExecutionRuntimeError`.
 */
export type PlannerResultPersistenceIssue =
  /** The result itself violates an invariant it must satisfy to be persisted. */
  | { kind: 'result_invalid'; message: string }
  /** Domain validation rejected the Plan or a generated Entry. */
  | {
      kind: 'entity_invalid'
      entityName: 'ProductionPlan' | 'BuildListEntry'
      validation: DomainValidationResult
    }
  /** Current persisted state moved under the calculation. */
  | { kind: 'state_changed'; message: string }

function resultInvalid(message: string): PlannerResultPersistenceIssue {
  return { kind: 'result_invalid', message }
}

/**
 * PLANNER_SPEC 7.2.1: a full Planner run that its `maxPlanSteps` bound
 * truncated is a partial run artifact, not a finished production plan, so
 * nothing of it - a partial Plan included - is ever persisted. The typed
 * termination decides this - never a `PlannerWarning` message, and never the
 * presence of `max_steps_reached`, which a completed run can carry too.
 */
export function checkPlannerRunTerminationPersistable(
  termination: PlannerRunTermination,
): PlannerResultPersistenceIssue | null {
  return termination.status === 'incomplete'
    ? resultInvalid(
        `The Planner run did not complete: it reached ${termination.reachedLimits.join(', ')} with ${termination.completedTargetCount} of ${termination.totalTargetCount} target weapons completed. A truncated Planner run result must not be saved as an executable ProductionPlan.`,
      )
    : null
}

/**
 * The result-shape invariants of a replacement-bearing Planner result - the
 * Build List global optimization adoption (`docs/PLANNER_SPEC.md` 17.11), whose
 * artifact checks call this first - that do not depend on current persisted
 * state:
 * a completed / exhausted search, a draft Plan, unique generated Entry IDs,
 * exactly one replacement per generated Entry naming its own Target
 * (`docs/PLANNER_SPEC.md` 9.2.18), and Domain-valid Plan and Entries. A
 * malformed Worker result - replacement metadata missing, extra, duplicated or
 * for another Target - is never persisted.
 */
export function checkPersistablePlannerResultShape(
  plan: ProductionPlan,
  generatedEntries: readonly BuildListEntry[],
  termination: PlannerRunTermination,
  replacements: readonly BuildListEntryReplacement[] | undefined,
): PlannerResultPersistenceIssue | null {
  const truncated = checkPlannerRunTerminationPersistable(termination)
  if (truncated !== null) return truncated
  if (plan.status !== 'draft') {
    return resultInvalid(
      `A replacement-bearing Planner result must be saved as a draft ProductionPlan, but its status is '${plan.status}'.`,
    )
  }
  const duplicated = generatedEntries
    .map(({ id }) => id)
    .filter((id, index, all) => all.indexOf(id) !== index)
  if (duplicated.length > 0) {
    return resultInvalid(
      `Generated BuildListEntry IDs must be unique: '${duplicated[0]}' appears more than once.`,
    )
  }
  const pairing = validateGeneratedBuildListEntryReplacements(generatedEntries, replacements)
  if (!pairing.isValid) {
    return resultInvalid(
      `The generated BuildListEntry replacements are malformed: ${pairing.issues.map(({ message }) => message).join(' ')}`,
    )
  }
  const planValidation = validateProductionPlan(plan)
  if (!planValidation.isValid) {
    return { kind: 'entity_invalid', entityName: 'ProductionPlan', validation: planValidation }
  }
  for (const entry of generatedEntries) {
    const entryValidation = validateBuildListEntry(entry)
    if (!entryValidation.isValid) {
      return { kind: 'entity_invalid', entityName: 'BuildListEntry', validation: entryValidation }
    }
  }
  return null
}

/**
 * The result-shape invariants of an **ordinary** Planner result
 * (`createPlan()`, `docs/PLANNER_SPEC.md` 9.2.15 / 16.8, Phase 6-A) that do not
 * depend on current persisted state: a completed / exhausted run, a draft Plan,
 * no repair lineage, a Domain-valid Plan, and the rejected Build List record a
 * newly calculated Plan carries (`checkRejectedBuildListEntryRecordsComplete()`).
 * An ordinary run carries no
 * generated BuildListEntry and no replacement, so none of the replacement
 * checks applies; its Plan is saved over - or, for a replan, started against -
 * the current Build List exactly as it is.
 *
 * No current save writes a lineage: only the Planner Alternative actual repair
 * save ever stored one, and it was removed in Issue #278 PR-5 (a lineage stored
 * earlier stays readable, `docs/DATA_MODEL.md` 11.1.1). An ordinary Plan
 * carrying one is refused rather than stored or cleared.
 */
export function checkPersistableOrdinaryPlannerResultShape(
  plan: ProductionPlan,
  termination: PlannerRunTermination,
): PlannerResultPersistenceIssue | null {
  const truncated = checkPlannerRunTerminationPersistable(termination)
  if (truncated !== null) return truncated
  if (plan.status !== 'draft') {
    return resultInvalid(
      `An ordinary Planner result must be saved as a draft ProductionPlan, but its status is '${plan.status}'.`,
    )
  }
  if (plan.conflictRepairLineage !== null) {
    return resultInvalid(
      'An ordinary Planner result must not carry a conflict repair lineage; no current save records one.',
    )
  }
  const planValidation = validateProductionPlan(plan)
  if (!planValidation.isValid) {
    return { kind: 'entity_invalid', entityName: 'ProductionPlan', validation: planValidation }
  }
  return checkRejectedBuildListEntryRecordsComplete(plan)
}

/**
 * A newly calculated Plan records the Issue #121 fields of its rejected
 * Build List (`docs/PLANNER_SPEC.md` 9.6.9.1, `docs/DATA_MODEL.md` 11.9): every
 * record its `targetWeaponId`, every `resource_conflict` record its
 * `resourceConflictCause`. A record without them is accepted only as one an
 * earlier build saved; a Plan about to be saved now is refused, never
 * completed. Shared by every save through
 * `checkPersistableOrdinaryPlannerResultShape()`: the ordinary and conflict
 * preference saves, the replan adoption and the Build List optimization
 * adoption (whose Plan rejects nothing).
 */
export function checkRejectedBuildListEntryRecordsComplete(
  plan: ProductionPlan,
): PlannerResultPersistenceIssue | null {
  for (const [index, rejected] of plan.rejectedBuildListEntries.entries()) {
    if (rejected.targetWeaponId === undefined) {
      return resultInvalid(
        `rejectedBuildListEntries[${index}] (BuildListEntry '${rejected.buildListEntryId}') does not record its targetWeaponId; a newly calculated Plan records it for every rejected Entry.`,
      )
    }
    if (rejected.reason === 'resource_conflict' && rejected.resourceConflictCause === undefined) {
      return resultInvalid(
        `rejectedBuildListEntries[${index}] (BuildListEntry '${rejected.buildListEntryId}') is a resource_conflict without a resourceConflictCause; a newly calculated Plan records the cause of every resource_conflict.`,
      )
    }
  }
  return null
}

/**
 * Every rejected record's `targetWeaponId` is the `targetWeaponId` of its
 * Entry in `entries` - the Build List the Plan is saved over, which the save
 * has already matched against the Plan's own input (`buildListEntriesHash`;
 * the replan adoption against the dependent Entries and the references) - so
 * the record is the copy Plan generation made, never another Target
 * (`docs/DATA_MODEL.md` 11.9). A record without the field, or whose Entry is
 * not there, is refused too. This reads the Entry's Target only through the
 * Entry: the Target itself need not exist.
 */
export function checkRejectedBuildListEntryTargets(
  plan: ProductionPlan,
  entries: readonly BuildListEntry[],
): PlannerResultPersistenceIssue | null {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  for (const [index, rejected] of plan.rejectedBuildListEntries.entries()) {
    const entry = entryById.get(rejected.buildListEntryId)
    if (entry === undefined) {
      return resultInvalid(
        `rejectedBuildListEntries[${index}] references BuildListEntry '${rejected.buildListEntryId}', which is not part of the Build List the Plan is saved over.`,
      )
    }
    if (rejected.targetWeaponId !== entry.targetWeaponId) {
      return resultInvalid(
        `rejectedBuildListEntries[${index}] records TargetWeapon '${String(rejected.targetWeaponId)}' for BuildListEntry '${entry.id}', whose TargetWeapon is '${entry.targetWeaponId}'.`,
      )
    }
  }
  return null
}

/**
 * The result-shape invariants of an ordinary Planner result calculated for
 * 「この候補を優先」 (`docs/PLANNER_SPEC.md` 9.6.6) that do not depend on
 * current persisted state, beside the ordinary ones
 * (`checkPersistableOrdinaryPlannerResultShape()`): the run honoured every
 * explicit decision (no `invalid_conflict_resolution`), `conflicts` and
 * `plan.conflicts` are the same list PlanConflict by PlanConflict, and the
 * Plan's Conflicts record exactly the decisions the run was given as their
 * selections - every one of them, and no other selection. Whether each
 * preferred Entry is completed reads its Target from the current Build List,
 * so the save checks it inside its transaction
 * (`checkPreferredBuildListEntriesCompleted()`).
 *
 * `plan` is the result's non-null Plan; a result without one is `no_plan` and
 * never reaches this check.
 */
export function checkPersistableConflictPreferenceResultShape(
  plan: ProductionPlan,
  result: Pick<PlannerResult, 'conflicts' | 'warnings' | 'termination'>,
  conflictResolutions: readonly PlannerConflictResolution[],
): PlannerResultPersistenceIssue | null {
  if (conflictResolutions.length === 0) {
    return resultInvalid('A conflict preference result is saved with the explicit decisions it was calculated from; an ordinary result without any is saved as an ordinary result.')
  }
  const ordinary = checkPersistableOrdinaryPlannerResultShape(plan, result.termination)
  if (ordinary !== null) return ordinary
  if (result.warnings.some(({ kind }) => kind === 'invalid_conflict_resolution')) {
    return resultInvalid(
      'The Planner could not honour an explicit conflict resolution (invalid_conflict_resolution); a Plan that ignored a decision must not be saved.',
    )
  }
  if (!sameStructure(plan.conflicts, result.conflicts)) {
    return resultInvalid('The Planner result reports different Conflicts for its result and its Plan.')
  }
  const expected = conflictResolutions
    .map(({ conflictKey, selectedBuildListEntryId }) => JSON.stringify([conflictKey, selectedBuildListEntryId]))
    .sort()
  const recorded = plan.conflicts
    .filter(({ selectedBuildListEntryId }) => selectedBuildListEntryId !== null)
    .map(({ id, selectedBuildListEntryId }) => JSON.stringify([id, selectedBuildListEntryId]))
    .sort()
  if (expected.join('\n') !== recorded.join('\n')) {
    return resultInvalid(
      'The Plan does not record exactly the explicit conflict decisions it was calculated from as its selected Conflicts.',
    )
  }
  return null
}

/**
 * Every Entry the decisions prefer must be completed by the Plan
 * (`docs/PLANNER_SPEC.md` 9.6.6): the Plan's `selectedBuildListEntryIds` holds
 * it and a `targetCompletions` record names its Target, read from `entries`
 * (the Build List the Plan is saved over). One record without the other is an
 * inconsistent Plan and is refused the same way.
 */
export function checkPreferredBuildListEntriesCompleted(
  plan: ProductionPlan,
  conflictResolutions: readonly PlannerConflictResolution[],
  entries: readonly BuildListEntry[],
): PlannerResultPersistenceIssue | null {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entryId of plannerPreferredBuildListEntryIds(conflictResolutions)) {
    const entry = entriesById.get(entryId)
    if (entry === undefined) {
      return { kind: 'state_changed', message: `The preferred BuildListEntry '${entryId}' is no longer in the Build List.` }
    }
    const record = plannerPlanCompletionRecord(plan, entryId, entry.targetWeaponId)
    if (record !== 'completed') {
      return resultInvalid(
        record === 'inconsistent'
          ? `The Plan records the preferred BuildListEntry '${entryId}' as secured or as completing its Target, but not both.`
          : `The Plan does not complete the preferred BuildListEntry '${entryId}'; a preference that is not completed is never saved.`,
      )
    }
  }
  return null
}

/**
 * A generated Entry that is already persisted was not the `reusedExisting`
 * case - a reused Entry is never returned as generated - so the same ID
 * appearing now is a save-time race, never a silent reuse or overwrite.
 */
export function findPersistedGeneratedBuildListEntryCollision(
  generatedEntries: readonly BuildListEntry[],
  persistedEntries: readonly BuildListEntry[],
): PlannerResultPersistenceIssue | null {
  const persistedIds = new Set(persistedEntries.map(({ id }) => id))
  const collided = generatedEntries.find(({ id }) => persistedIds.has(id))
  return collided
    ? {
        kind: 'state_changed',
        message: `Generated BuildListEntry '${collided.id}' already exists in persistence; current state changed after the Planner ran.`,
      }
    : null
}

/**
 * The save-time half of the replacement contract (`docs/PLANNER_SPEC.md`
 * 9.2.18): for every replacement, the Target's persisted Entries are *still*
 * exactly the `O` the calculation replaced. A Target that meanwhile lost `O`,
 * holds another Entry instead or beside it, or now holds two Entries is a state
 * change: nothing is deleted on a guess, so a `B3` that replaced `B1` after the
 * Planner ran is never removed by an older result.
 */
export function checkBuildListEntryReplacementsCurrent(
  replacements: readonly BuildListEntryReplacement[],
  persistedEntries: readonly BuildListEntry[],
): PlannerResultPersistenceIssue | null {
  for (const { targetWeaponId, replacedBuildListEntryId } of replacements) {
    const current = buildListEntriesForTarget(persistedEntries, targetWeaponId).map(({ id }) => id)
    if (current.length !== 1 || current[0] !== replacedBuildListEntryId) {
      return {
        kind: 'state_changed',
        message: `TargetWeapon '${targetWeaponId}' now holds [${current.join(', ')}] instead of the BuildListEntry '${replacedBuildListEntryId}' the Planner result replaces; current state changed after the Planner ran.`,
      }
    }
  }
  return null
}

export type FinalReplacementBuildListResult =
  | { issue: null; finalEntries: BuildListEntry[] }
  | { issue: PlannerResultPersistenceIssue; finalEntries: null }

/**
 * The **final replacement set** a Planner result is persisted into
 * (`docs/PLANNER_SPEC.md` 9.2.15 / 9.2.18): the current persisted Entries,
 * minus each replaced `O`, plus each generated `G`. Used by the shared Draft
 * save boundary (the ordinary and conflict preference results, with no
 * replacement, and the Build List optimization adoption), it refuses - before
 * any write - a
 * generated ID that is already persisted (never overwritten), a Target whose
 * persisted Entry is no longer exactly the expected `O`, and a final set in
 * which a replaced Target does not hold exactly its `G`
 * (`validateBuildListCardinality()`).
 */
export function prepareFinalReplacementBuildList(
  persistedEntries: readonly BuildListEntry[],
  generatedEntries: readonly BuildListEntry[],
  replacements: readonly BuildListEntryReplacement[],
): FinalReplacementBuildListResult {
  const collision = findPersistedGeneratedBuildListEntryCollision(generatedEntries, persistedEntries)
  if (collision !== null) return { issue: collision, finalEntries: null }
  const current = checkBuildListEntryReplacementsCurrent(replacements, persistedEntries)
  if (current !== null) return { issue: current, finalEntries: null }
  const finalEntries = applyBuildListEntryReplacements(persistedEntries, replacements, generatedEntries)
  const structure = validateBuildListEntryReplacements(finalEntries, replacements, 'replaced')
  const cardinality = validateReplacedBuildListCardinality(finalEntries, replacements)
  const issues = [...structure.issues, ...cardinality.issues]
  if (issues.length > 0) {
    return {
      issue: resultInvalid(
        `The final Build List after the replacements violates the Build List cardinality contract: ${issues.map(({ message }) => message).join(' ')}`,
      ),
      finalEntries: null,
    }
  }
  return { issue: null, finalEntries }
}

export interface GeneratedBuildListEntryStalenessState {
  rngState: RngState
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  targetWeapons: readonly TargetWeapon[]
}

/**
 * Every generated Entry is fresh against current state, recomputed from that
 * state and never read off the persisted flags.
 */
export function checkGeneratedBuildListEntriesFresh(
  generatedEntries: readonly BuildListEntry[],
  current: GeneratedBuildListEntryStalenessState,
  currentCalculationContext: CalculationContext,
): PlannerResultPersistenceIssue | null {
  const targetById = new Map(current.targetWeapons.map((target) => [target.id, target]))
  for (const entry of generatedEntries) {
    const staleness = evaluateBuildListEntryStaleness(entry, {
      target: targetById.get(entry.targetWeaponId) ?? null,
      rngState: current.rngState,
      normalCounters: [...current.normalCounters],
      ownedWeapons: [...current.ownedWeapons],
      calculationContext: currentCalculationContext,
    })
    if (staleness.isStale) {
      return {
        kind: 'state_changed',
        message: `Generated BuildListEntry '${entry.id}' is stale against current state (${staleness.staleReasons.join(', ')}).`,
      }
    }
  }
  return null
}

/**
 * Every BuildListEntry the Plan references - a selected Entry, a Step, a
 * conflict participant, recommendation or selection, a rejection - exists in
 * the final replacement set, and each Candidate-derived Step carries its Entry
 * Snapshot's Candidate ID. A replaced Entry `O` is not part of that set, so a
 * Plan still naming it anywhere is refused. This check does not require a
 * generated Entry to be selected: the Build List global optimization adoption
 * checks its own final selection separately (`docs/PLANNER_SPEC.md` 17.11).
 * (The Planner Alternative repair save, removed in Issue #278 PR-5, relied on
 * this to save an accepted but unselected `G`, 9.2.19.6; the legacy B8 save
 * additionally required every generated Entry to be selected, a check removed
 * with it in Phase 6-B2b.)
 */
export function checkProductionPlanBuildListEntryReferences(
  plan: ProductionPlan,
  finalEntries: readonly BuildListEntry[],
): PlannerResultPersistenceIssue | null {
  const entryById = new Map(finalEntries.map((entry) => [entry.id, entry]))
  const missing = (id: BuildListEntryId, path: string) =>
    entryById.has(id)
      ? null
      : resultInvalid(
          `${path} references BuildListEntry '${id}', which is not part of the final replacement Build List.`,
        )

  for (const [index, id] of plan.selectedBuildListEntryIds.entries()) {
    const issue = missing(id, `selectedBuildListEntryIds[${index}]`)
    if (issue) return issue
  }
  for (const [index, conflict] of plan.conflicts.entries()) {
    for (const [participant, id] of conflict.buildListEntryIds.entries()) {
      const issue = missing(id, `conflicts[${index}].buildListEntryIds[${participant}]`)
      if (issue) return issue
    }
    if (conflict.recommendedBuildListEntryId !== null) {
      const issue = missing(
        conflict.recommendedBuildListEntryId,
        `conflicts[${index}].recommendedBuildListEntryId`,
      )
      if (issue) return issue
    }
    if (conflict.selectedBuildListEntryId !== null) {
      const issue = missing(
        conflict.selectedBuildListEntryId,
        `conflicts[${index}].selectedBuildListEntryId`,
      )
      if (issue) return issue
    }
  }
  for (const [index, rejected] of plan.rejectedBuildListEntries.entries()) {
    const issue = missing(
      rejected.buildListEntryId,
      `rejectedBuildListEntries[${index}].buildListEntryId`,
    )
    if (issue) return issue
  }
  for (const [index, step] of plan.steps.entries()) {
    if (step.buildListEntryId === null) continue
    const issue = missing(step.buildListEntryId, `steps[${index}].buildListEntryId`)
    if (issue) return issue
    const entry = entryById.get(step.buildListEntryId) as BuildListEntry
    // A Candidate-derived Step carries that Entry Snapshot's Candidate ID.
    if (step.candidateId !== entry.candidateSnapshot.id) {
      return resultInvalid(
        `steps[${index}].candidateId '${step.candidateId}' does not match the candidate Snapshot '${entry.candidateSnapshot.id}' of BuildListEntry '${entry.id}'.`,
      )
    }
  }
  return null
}

/**
 * Exact structural equality of two untrusted values: primitives by identity,
 * arrays element by element in order, plain objects field by field whatever
 * their key order (a field holding `undefined` equals an absent one). Nothing
 * is sorted or canonicalized.
 */
function sameStructure(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameStructure(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])
  return [...keys].every((key) => sameStructure(leftRecord[key], rightRecord[key]))
}
