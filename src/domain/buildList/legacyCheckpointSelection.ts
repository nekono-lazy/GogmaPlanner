import type { BuildListEntry } from '../models/publicTypes'

/**
 * The calculation schema 10 checkpoint selection a BuildListEntry may still
 * carry (Issue #336 PR-2, `docs/DATA_MODEL.md` 9.4, `docs/PLANNER_SPEC.md` 18.5).
 *
 * Calculation schema 10 (PR #15, the strict-prefix compromise checkpoints of one
 * fixed operation order) stored the user's selection as
 * `BuildListEntry.selectedCheckpointOpportunityIds`, each id naming an
 * opportunity of `candidateSnapshot.checkpointGroups[].opportunities[]`.
 * Schema 11 replaced both with `intermediateStateGroups` /
 * `intermediateStateSelection`, and Issue #100 abolished the selection; the
 * current types carry neither schema 10 field. A schema 10 Entry is therefore
 * untyped persisted data: `calculation_context_changed` on every current path,
 * kept exactly as persisted by Dexie, Export and Import, and never rewritten.
 *
 * The one reader is the running Plan replan's Stage 0R
 * (`prepareRunningPlanReplanOptimization()`): a replan Target's current Entry -
 * stale or not - is replaced by the adoption, so a schema 10 selection left
 * undetected would be dropped silently (18.5 refuses exactly that for the
 * schema 11..18 selection). This classification applies the schema 10 contract
 * (`b5fe156^`: `validateBuildListEntryCheckpointSelection()` and its Planner
 * fail-closed) to the untyped field, by content alone - never by the Entry's
 * `calculationContext.appSchemaVersion`, which proves nothing about the field.
 *
 * ```text
 * field absent / undefined            none            (schema 1..9 and 11+ Entries write no field)
 * []                                  none            (schema 10 wrote "nothing selected" as [])
 * non-empty, every id a string that   selected        (the shape the schema 10 validation accepted)
 *   exists in the snapshot's
 *   checkpointGroups, no repeat, at
 *   most one per group
 * anything else                       uninterpretable (never read as "none": the schema 10 Planner
 *                                                      failed its whole input closed on it)
 * ```
 *
 * A checkpoint group is identified by its persisted `id`, exactly as the schema
 * 10 selection validation identified it (its `groupIdByOpportunityId` map),
 * never by its position in the array. That validation ran over snapshots the
 * schema 10 Candidate validation had accepted, which required every group id and
 * every opportunity id to be a non-empty string and unique within the Candidate.
 * A snapshot breaking one of those cannot be read safely: a group without a
 * readable id has no identity for the "one per group" rule, a repeated group id
 * merges or splits that rule depending on how it is read, and a repeated
 * opportunity id resolves to no one group. Such a snapshot is therefore
 * uninterpretable whatever a non-empty selection names; a `[]` beside it is
 * still no selection, because schema 10 never read the groups for one.
 *
 * Pure and read-only: it changes no Entry, clears nothing, and reads no
 * `intermediateStateSelection` (the schema 11..18 field keeps its own rule).
 * Nothing else - `validatePlannerInput()`, the Entry validation, the Planner
 * fail-closed, the Plan hash normalization, Import / Export - reads it.
 */

/** The schema 10 field names, kept as literals: the current types declare neither. */
export const LEGACY_CHECKPOINT_SELECTION_FIELD = 'selectedCheckpointOpportunityIds' as const
export const LEGACY_CHECKPOINT_GROUPS_FIELD = 'checkpointGroups' as const

export type LegacyCheckpointSelectionIssueCode =
  /** The field holds a value that is not an array (`null`, an object, a string, ...). */
  | 'selection_not_array'
  /** An element of the array is not a string id. */
  | 'selection_element_not_string'
  /** `candidateSnapshot.checkpointGroups` is missing, not an array, or holds a group / opportunity of no readable shape. */
  | 'groups_unreadable'
  /** A checkpoint group carries no non-empty string `id`, so it has no identity for the "one per group" rule. */
  | 'group_id_invalid'
  /** Two checkpoint groups of the snapshot share one `id`; the schema 10 Candidate validation refused that. */
  | 'group_id_duplicated'
  /** One opportunity id is defined twice in the snapshot (in one group or across groups); the schema 10 Candidate validation refused that. */
  | 'opportunity_id_duplicated'
  /** A selected id names no opportunity of the snapshot's checkpoint groups. */
  | 'unknown_opportunity'
  /** The same opportunity is selected twice. */
  | 'duplicate_opportunity'
  /** Two opportunities of one checkpoint group are selected. */
  | 'group_selected_twice'

export interface LegacyCheckpointSelectionIssue {
  /** Relative to the Entry: `selectedCheckpointOpportunityIds[...]` or `candidateSnapshot.checkpointGroups[...]`. */
  path: string
  code: LegacyCheckpointSelectionIssueCode
  message: string
}

export type LegacyCheckpointSelectionState =
  | { kind: 'none' }
  | { kind: 'selected'; opportunityIds: string[] }
  | { kind: 'uninterpretable'; issues: LegacyCheckpointSelectionIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The schema 10 `validateId()` rule: a string that is not empty once trimmed. */
function isReadableId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The opportunity id -> group id map of a schema 10 `checkpointGroups` value,
 * or the first issue that makes it unreadable. Only what the selection rule
 * reads is required - the groups, each group's `id` and `opportunities`, each
 * opportunity's `id` - plus the uniqueness the schema 10 Candidate validation
 * guaranteed for those ids, without which the map is not well defined. Nothing
 * else of a group is judged.
 */
function readCheckpointGroups(value: unknown): { groupIdByOpportunityId: Map<string, string> } | LegacyCheckpointSelectionIssue {
  const path = `candidateSnapshot.${LEGACY_CHECKPOINT_GROUPS_FIELD}`
  if (!Array.isArray(value)) {
    return { path, code: 'groups_unreadable', message: 'The candidate snapshot holds no readable checkpointGroups array for the selection to resolve against.' }
  }
  const groupIds = new Set<string>()
  const groupIdByOpportunityId = new Map<string, string>()
  for (const [groupIndex, group] of value.entries()) {
    const groupPath = `${path}[${groupIndex}]`
    if (!isRecord(group) || !Array.isArray(group.opportunities)) {
      return { path: groupPath, code: 'groups_unreadable', message: 'A checkpoint group is not an object with an opportunities array.' }
    }
    if (!isReadableId(group.id)) {
      return { path: `${groupPath}.id`, code: 'group_id_invalid', message: 'A checkpoint group must carry a non-empty string id; the selection rule identifies groups by id.' }
    }
    if (groupIds.has(group.id)) {
      return { path: `${groupPath}.id`, code: 'group_id_duplicated', message: 'Checkpoint group ids must be unique; a repeated id leaves the one-per-group rule undecidable.' }
    }
    groupIds.add(group.id)
    for (const [opportunityIndex, opportunity] of group.opportunities.entries()) {
      const opportunityPath = `${groupPath}.opportunities[${opportunityIndex}]`
      if (!isRecord(opportunity) || !isReadableId(opportunity.id)) {
        return { path: opportunityPath, code: 'groups_unreadable', message: 'A checkpoint opportunity is not an object with a non-empty string id.' }
      }
      if (groupIdByOpportunityId.has(opportunity.id)) {
        return { path: `${opportunityPath}.id`, code: 'opportunity_id_duplicated', message: 'Checkpoint opportunity ids must be unique; a repeated id resolves to no one group.' }
      }
      groupIdByOpportunityId.set(opportunity.id, group.id)
    }
  }
  return { groupIdByOpportunityId }
}

/**
 * Classifies the schema 10 checkpoint selection of one Entry by the field's
 * content (see the module comment). Never throws, never mutates.
 */
export function classifyLegacyCheckpointSelection(entry: BuildListEntry): LegacyCheckpointSelectionState {
  const selection = (entry as unknown as Record<string, unknown>)[LEGACY_CHECKPOINT_SELECTION_FIELD]
  if (selection === undefined) return { kind: 'none' }
  const path = LEGACY_CHECKPOINT_SELECTION_FIELD
  if (!Array.isArray(selection)) {
    return { kind: 'uninterpretable', issues: [{ path, code: 'selection_not_array', message: 'The schema 10 checkpoint selection is not an array.' }] }
  }
  if (selection.length === 0) return { kind: 'none' }

  const issues: LegacyCheckpointSelectionIssue[] = []
  selection.forEach((id, index) => {
    if (typeof id !== 'string') {
      issues.push({ path: `${path}[${index}]`, code: 'selection_element_not_string', message: 'A selected checkpoint opportunity id is not a string.' })
    }
  })
  if (issues.length > 0) return { kind: 'uninterpretable', issues }

  const groups = readCheckpointGroups((entry.candidateSnapshot as unknown as Record<string, unknown>)[LEGACY_CHECKPOINT_GROUPS_FIELD])
  if (!('groupIdByOpportunityId' in groups)) return { kind: 'uninterpretable', issues: [groups] }

  const seen = new Set<string>()
  const selectedGroupIds = new Set<string>()
  ;(selection as string[]).forEach((id, index) => {
    const elementPath = `${path}[${index}]`
    const groupId = groups.groupIdByOpportunityId.get(id)
    if (groupId === undefined) {
      issues.push({ path: elementPath, code: 'unknown_opportunity', message: 'A selected checkpoint opportunity must exist in the candidate snapshot.' })
      return
    }
    if (seen.has(id)) {
      issues.push({ path: elementPath, code: 'duplicate_opportunity', message: 'A checkpoint opportunity must not be selected twice.' })
      return
    }
    seen.add(id)
    if (selectedGroupIds.has(groupId)) {
      issues.push({ path: elementPath, code: 'group_selected_twice', message: 'At most one opportunity may be selected per checkpoint group.' })
      return
    }
    selectedGroupIds.add(groupId)
  })
  if (issues.length > 0) return { kind: 'uninterpretable', issues }
  return { kind: 'selected', opportunityIds: [...(selection as string[])] }
}
