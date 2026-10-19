import type {
  BuildListEntry,
  BuildListEntryId,
  DomainValidationIssue,
  DomainValidationResult,
  TargetWeaponId,
} from '../models/publicTypes'
import { validateBuildListCardinality } from './buildListCardinality'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * One Target-scoped replacement of the Build List cardinality contract
 * (`docs/DATA_MODEL.md` 9.4.1, `docs/PLANNER_SPEC.md` 9.2.18): the persisted
 * BuildListEntry `O` of `targetWeaponId` is replaced by the Planner-generated
 * BuildListEntry `G`.
 *
 * It is runtime metadata only - never a `BuildListEntry` field, never a
 * `PlannerInput` field, never persisted. In the Build List global optimization
 * it carries each `O -> G` replacement of the adopted result from its Worker
 * to the save-time transaction, which must see that very `O` - and nothing
 * else - still persisted for the Target before it deletes it. Inside a
 * research Planner Alternative trial it names which Entry of an augmented
 * input is temporary and which persisted Entry it stands in for. Plain
 * serializable data, so it survives the Worker boundary. (The legacy B8
 * orchestration result and the Planner Alternative repair artifact carried it
 * the same way until Phase 6-B2b and Issue #278 PR-7 removed those paths.)
 */
export interface BuildListEntryReplacement {
  targetWeaponId: TargetWeaponId
  /** `O`: the persisted Entry the replacement removes. */
  replacedBuildListEntryId: BuildListEntryId
  /** `G`: the Planner-generated Entry that takes its place. */
  generatedBuildListEntryId: BuildListEntryId
}

/** Why one generated Entry names no unique persisted Entry to replace; never a message. */
export type BuildListEntryReplacementFailureReason =
  /** The Target holds no persisted Entry, so there is nothing to replace. */
  | 'replaced_entry_missing'
  /** The Target holds two or more persisted Entries: which one is replaced is unknown. */
  | 'replaced_entry_ambiguous'
  /** The generated Entry's ID is already held by a persisted Entry. */
  | 'generated_entry_id_in_use'

export type BuildListEntryReplacementResolution =
  | { status: 'ready'; replacement: BuildListEntryReplacement }
  | { status: 'invalid'; reason: BuildListEntryReplacementFailureReason; detail: string }

/**
 * Names the persisted Entry `O` one generated Entry `G` replaces: the one and
 * only persisted Entry of `G`'s Target (`docs/PLANNER_SPEC.md` 9.2.18). Zero
 * or several persisted Entries never pick one - by Route length, `createdAt`,
 * staleness or ID - they fail closed. `persistedEntries` must hold persisted
 * Entries only, never another temporary Entry.
 */
export function resolveBuildListEntryReplacement(
  persistedEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[],
  generatedEntry: Pick<BuildListEntry, 'id' | 'targetWeaponId'>,
): BuildListEntryReplacementResolution {
  if (persistedEntries.some(({ id }) => id === generatedEntry.id)) {
    return {
      status: 'invalid',
      reason: 'generated_entry_id_in_use',
      detail: `Generated BuildListEntry '${generatedEntry.id}' carries the ID of a persisted Entry.`,
    }
  }
  const targetEntries = persistedEntries
    .filter(({ targetWeaponId }) => targetWeaponId === generatedEntry.targetWeaponId)
    .map(({ id }) => id)
    .sort(compareStableStrings)
  if (targetEntries.length === 0) {
    return {
      status: 'invalid',
      reason: 'replaced_entry_missing',
      detail: `TargetWeapon '${generatedEntry.targetWeaponId}' holds no persisted BuildListEntry for generated BuildListEntry '${generatedEntry.id}' to replace.`,
    }
  }
  if (targetEntries.length > 1) {
    return {
      status: 'invalid',
      reason: 'replaced_entry_ambiguous',
      detail: `TargetWeapon '${generatedEntry.targetWeaponId}' holds ${targetEntries.length} persisted BuildListEntries (${targetEntries.join(', ')}); which one generated BuildListEntry '${generatedEntry.id}' replaces is unknown.`,
    }
  }
  return {
    status: 'ready',
    replacement: {
      targetWeaponId: generatedEntry.targetWeaponId,
      replacedBuildListEntryId: targetEntries[0],
      generatedBuildListEntryId: generatedEntry.id,
    },
  }
}

/** Replacements in a run-independent order: by Target, then by the Entries. */
export function sortBuildListEntryReplacements(
  replacements: readonly BuildListEntryReplacement[],
): BuildListEntryReplacement[] {
  return replacements
    .map((replacement) => ({ ...replacement }))
    .sort(
      (left, right) =>
        compareStableStrings(left.targetWeaponId, right.targetWeaponId) ||
        compareStableStrings(left.replacedBuildListEntryId, right.replacedBuildListEntryId) ||
        compareStableStrings(left.generatedBuildListEntryId, right.generatedBuildListEntryId),
    )
}

/**
 * The **replacement set** (`docs/PLANNER_SPEC.md` 9.2.18): `entries` with
 * every replaced Entry `O` removed and every generated Entry `G` present.
 *
 * `entries` is either a persisted collection (the generated Entries are then
 * added) or an augmented collection already holding them (they are then kept
 * where they are, never duplicated). It decides nothing and validates nothing
 * on its own: its callers - the Build List global optimization and its
 * adoption save, and the research Planner Alternative trial - call
 * `validateBuildListEntryReplacements()` on the side of it they hold.
 */
export function applyBuildListEntryReplacements<T extends Pick<BuildListEntry, 'id'>>(
  entries: readonly T[],
  replacements: readonly BuildListEntryReplacement[],
  generatedEntries: readonly T[],
): T[] {
  const replacedIds = new Set(replacements.map(({ replacedBuildListEntryId }) => replacedBuildListEntryId))
  const kept = entries.filter(({ id }) => !replacedIds.has(id))
  const keptIds = new Set(kept.map(({ id }) => id))
  return [...kept, ...generatedEntries.filter(({ id }) => !keptIds.has(id))]
}

/**
 * Which side of a replacement an Entry collection holds.
 *
 * - `augmented`: the temporary augmented input of a trial preflight - each
 *   Target of a replacement holds exactly its persisted `O` plus its temporary
 *   `G` (persisted 0..1 + temporary 0..1, with the persisted side exactly 1)
 * - `replaced`: the replacement set - each Target of a replacement holds
 *   exactly its `G`, and no `O` is left anywhere
 */
export type BuildListEntryReplacementPlacement = 'augmented' | 'replaced'

function issue(message: string): DomainValidationIssue {
  return { path: 'buildListEntries', code: 'invalid_structure', message }
}

/**
 * The replacement metadata itself: each replacement names one Target, one
 * replaced Entry and one generated Entry, and no Target, replaced Entry or
 * generated Entry appears in two replacements (one Target holds at most one
 * temporary Entry, `docs/PLANNER_SPEC.md` 9.2.18). An Entry is never replaced
 * by itself, and a generated Entry is never also a replaced one.
 */
export function validateBuildListEntryReplacementMetadata(
  replacements: readonly BuildListEntryReplacement[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const repeated = (values: readonly string[]) =>
    [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort(compareStableStrings)
  repeated(replacements.map(({ targetWeaponId }) => targetWeaponId)).forEach((targetWeaponId) => {
    issues.push(issue(`TargetWeapon '${targetWeaponId}' has more than one temporary BuildListEntry replacement; a Target holds at most one temporary Entry.`))
  })
  repeated(replacements.map(({ replacedBuildListEntryId }) => replacedBuildListEntryId)).forEach((id) => {
    issues.push(issue(`BuildListEntry '${id}' is replaced by more than one temporary BuildListEntry.`))
  })
  repeated(replacements.map(({ generatedBuildListEntryId }) => generatedBuildListEntryId)).forEach((id) => {
    issues.push(issue(`Temporary BuildListEntry '${id}' replaces more than one BuildListEntry.`))
  })
  const generatedIds = new Set(replacements.map(({ generatedBuildListEntryId }) => generatedBuildListEntryId))
  replacements.forEach(({ replacedBuildListEntryId, generatedBuildListEntryId }) => {
    if (replacedBuildListEntryId === generatedBuildListEntryId || generatedIds.has(replacedBuildListEntryId)) {
      issues.push(issue(`BuildListEntry '${replacedBuildListEntryId}' is both a replaced and a temporary BuildListEntry.`))
    }
  })
  return { isValid: issues.length === 0, issues }
}

/**
 * The temporary Build List cardinality contract of one Entry collection
 * (`docs/PLANNER_SPEC.md` 9.2.18): the replacement metadata, and each Target
 * of a replacement holding exactly what `placement` requires. It never looks
 * at a Target without a replacement: that is the ordinary persisted contract
 * (`findBuildListTargetDuplicates()`), which the caller applies to the
 * persisted side as it always does.
 */
export function validateBuildListEntryReplacements(
  entries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[],
  replacements: readonly BuildListEntryReplacement[],
  placement: BuildListEntryReplacementPlacement,
): DomainValidationResult {
  const issues = [...validateBuildListEntryReplacementMetadata(replacements).issues]
  const ordered = sortBuildListEntryReplacements(replacements)
  ordered.forEach(({ targetWeaponId, replacedBuildListEntryId, generatedBuildListEntryId }) => {
    const targetIds = entries
      .filter((entry) => entry.targetWeaponId === targetWeaponId)
      .map(({ id }) => id)
      .sort(compareStableStrings)
    const expected = placement === 'augmented'
      ? [replacedBuildListEntryId, generatedBuildListEntryId].sort(compareStableStrings)
      : [generatedBuildListEntryId]
    const matches =
      targetIds.length === expected.length && targetIds.every((id, index) => id === expected[index])
    if (!matches) {
      issues.push(issue(
        placement === 'augmented'
          ? `TargetWeapon '${targetWeaponId}' must hold exactly its persisted BuildListEntry '${replacedBuildListEntryId}' and its temporary BuildListEntry '${generatedBuildListEntryId}', but holds [${targetIds.join(', ')}].`
          : `TargetWeapon '${targetWeaponId}' must hold exactly its replacing BuildListEntry '${generatedBuildListEntryId}', but holds [${targetIds.join(', ')}].`,
      ))
    }
    // An Entry ID names one Entry: a replaced ID left under another Target, or
    // a temporary ID held twice, is never read past.
    const otherHolders = entries.filter(
      (entry) =>
        entry.targetWeaponId !== targetWeaponId &&
        (entry.id === generatedBuildListEntryId || entry.id === replacedBuildListEntryId),
    )
    if (otherHolders.length > 0) {
      issues.push(issue(`BuildListEntry IDs of the replacement of TargetWeapon '${targetWeaponId}' are held by another Target.`))
    }
  })
  return { isValid: issues.length === 0, issues }
}

/**
 * The pairing a Planner orchestration result must carry to be persisted
 * (`docs/PLANNER_SPEC.md` 9.2.14 / 9.2.18): exactly one replacement per
 * generated Entry, naming that Entry and its own Target. A result whose
 * metadata is missing, extra, or for another Target is malformed and never
 * persisted.
 */
export function validateGeneratedBuildListEntryReplacements(
  generatedEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[],
  replacements: readonly BuildListEntryReplacement[] | undefined,
): DomainValidationResult {
  if (!Array.isArray(replacements)) {
    return {
      isValid: false,
      issues: [issue('The generated BuildListEntry replacement metadata is missing.')],
    }
  }
  const issues = [...validateBuildListEntryReplacementMetadata(replacements).issues]
  const generatedById = new Map(generatedEntries.map((entry) => [entry.id, entry]))
  replacements.forEach(({ targetWeaponId, generatedBuildListEntryId }) => {
    const generated = generatedById.get(generatedBuildListEntryId)
    if (generated === undefined) {
      issues.push(issue(`The replacement of TargetWeapon '${targetWeaponId}' names BuildListEntry '${generatedBuildListEntryId}', which is not a generated Entry of this result.`))
    } else if (generated.targetWeaponId !== targetWeaponId) {
      issues.push(issue(`Generated BuildListEntry '${generatedBuildListEntryId}' targets '${generated.targetWeaponId}', not the replaced Target '${targetWeaponId}'.`))
    }
  })
  const paired = new Set(replacements.map(({ generatedBuildListEntryId }) => generatedBuildListEntryId))
  generatedEntries.forEach(({ id }) => {
    if (!paired.has(id)) {
      issues.push(issue(`Generated BuildListEntry '${id}' names no persisted BuildListEntry it replaces.`))
    }
  })
  return { isValid: issues.length === 0, issues }
}

/**
 * The persisted Build List after a save applies `replacements`
 * (`docs/DATA_MODEL.md` 9.4.1): each Target of a replacement must end with
 * exactly its generated Entry. Legacy duplicates of other Targets are left to
 * the Build List exactly as before; the save never creates a new one.
 */
export function validateReplacedBuildListCardinality(
  finalEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[],
  replacements: readonly BuildListEntryReplacement[],
): DomainValidationResult {
  const replacedTargetIds = new Set(replacements.map(({ targetWeaponId }) => targetWeaponId))
  return validateBuildListCardinality(
    finalEntries.filter(({ targetWeaponId }) => replacedTargetIds.has(targetWeaponId)),
  )
}
