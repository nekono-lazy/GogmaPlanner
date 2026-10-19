import type {
  BuildListEntry,
  BuildListEntryId,
  CompromiseConditionMatch,
  ImprovementPreference,
  IntermediateBonusOpportunity,
  IntermediateBonusStateGroup,
  IntermediateSkillOpportunity,
  IntermediateSkillStateGroup,
  IntermediateStateAxis,
  IntermediateStateOpportunityId,
  RouteOperation,
  TargetWeaponId,
} from '../models/publicTypes'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The intermediate states one BuildListEntry selected, resolved against its
 * own Candidate Snapshot, plus the improvement preference.
 *
 * A selected state is a hard Planner constraint (`docs/PLANNER_SPEC.md` 7.5):
 * the Planner may never ignore it, treat it as unselected, or silently move
 * the selection to another opportunity of the same group. All it may do is
 * fail to produce a Plan that satisfies it.
 *
 * A selected id that no longer exists in the snapshot is deliberately not
 * silently dropped here: `validateBuildListEntry()` fails closed on it, and the
 * Planner validation excludes such an Entry before the Beam Search sees it.
 */
export interface EntryIntermediateSelection {
  skill: { group: IntermediateSkillStateGroup; opportunity: IntermediateSkillOpportunity } | null
  bonus: { group: IntermediateBonusStateGroup; opportunity: IntermediateBonusOpportunity } | null
  improvementPreference: ImprovementPreference
}

export function entryIntermediateSelection(entry: BuildListEntry): EntryIntermediateSelection {
  const selection = entry.intermediateStateSelection
  const groups = entry.candidateSnapshot.intermediateStateGroups ?? []
  const find = <Axis extends IntermediateStateAxis>(
    axis: Axis,
    id: IntermediateStateOpportunityId | null,
  ) => {
    if (id === null) return null
    for (const group of groups) {
      if (group.axis !== axis) continue
      const opportunity = group.opportunities.find((candidate) => candidate.id === id)
      if (opportunity) return { group, opportunity }
    }
    return null
  }
  const skill = find('skill', selection?.skillOpportunityId ?? null) as EntryIntermediateSelection['skill']
  const bonus = find('bonus', selection?.bonusOpportunityId ?? null) as EntryIntermediateSelection['bonus']
  return {
    skill,
    bonus,
    improvementPreference: selection?.improvementPreference ?? 'planner',
  }
}

/** Whether the Entry selected an intermediate state on at least one lane. */
export function hasIntermediateStateSelection(entry: BuildListEntry): boolean {
  const selection = entry.intermediateStateSelection
  return (
    selection !== undefined &&
    (selection.skillOpportunityId !== null || selection.bonusOpportunityId !== null)
  )
}

export function entryImprovementPreference(entry: BuildListEntry): ImprovementPreference {
  return entry.intermediateStateSelection?.improvementPreference ?? 'planner'
}

/** The Route operation count of each stream lane. */
export function routeLaneLengths(operations: readonly RouteOperation[]): {
  skill: number
  bonus: number
} {
  let skill = 0
  let bonus = 0
  operations.forEach((operation) => {
    if (operation.type === 'reset_skills') skill += 1
    else if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') bonus += 1
  })
  return { skill, bonus }
}

/**
 * The lane positions the Entry's weapon must hold at its compromise checkpoint
 * (`docs/PLANNER_SPEC.md` 7.5.2): the selected position of a selected lane,
 * and the Ideal lane end of an unselected lane.
 *
 * `null` means the Entry selected nothing, so it has no checkpoint at all and
 * simply runs to its Ideal.
 */
export interface IntermediatePin {
  skill: number
  bonus: number
}

export function intermediatePinFor(entry: BuildListEntry): IntermediatePin | null {
  if (!hasIntermediateStateSelection(entry)) return null
  const selection = entryIntermediateSelection(entry)
  const lengths = routeLaneLengths(entry.candidateSnapshot.route.operations)
  return {
    skill: selection.skill?.opportunity.lanePosition ?? lengths.skill,
    bonus: selection.bonus?.opportunity.lanePosition ?? lengths.bonus,
  }
}

/**
 * Whether the Entry's pinned lane pair is the weapon the user holds right now
 * (`docs/PLANNER_SPEC.md` 7.5.2): an existing Gogma Route whose selected lane
 * states are both lane starts - a selected position 0 whose other lane is
 * unselected and already at its Ideal end (no operation on that lane), or
 * both lanes selected at position 0. Such a compromise checkpoint is held at
 * Planner start; no Route operation produces it. A conversion Route never
 * qualifies: its lane starts describe the converted weapon, which the base
 * lane still has to create.
 */
export function isIntermediatePinHeldAtRouteStart(entry: BuildListEntry): boolean {
  const pin = intermediatePinFor(entry)
  if (pin === null || pin.skill !== 0 || pin.bonus !== 0) return false
  return entry.candidateSnapshot.route.operations.every(
    ({ type }) => type !== 'create_normal_artian' && type !== 'convert_normal_to_gogma',
  )
}

/**
 * The Route operation index that ends the pinned state of one lane, or `null`
 * when the pinned state is the lane's own start and no operation has to run
 * for it.
 */
export function intermediatePinOperationIndex(
  entry: BuildListEntry,
  axis: IntermediateStateAxis,
): number | null {
  const selection = entryIntermediateSelection(entry)
  const selected = axis === 'skill' ? selection.skill : selection.bonus
  if (selected !== null) {
    return selected.opportunity.lanePosition === 0 ? null : selected.opportunity.operationIndex
  }
  const operations = entry.candidateSnapshot.route.operations
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const type = operations[index].type
    if (axis === 'skill' ? type === 'reset_skills' : type === 'reset_bonuses' || type === 'keep_bonuses') {
      return index
    }
  }
  return null
}

/**
 * The selected intermediate state ending at this Route operation, if any.
 *
 * Only a selected lane position of `1` or more has an ending operation; a
 * selected lane start is held from the beginning of the Route.
 */
export function selectedIntermediateStateAtOperationIndex(
  entry: BuildListEntry,
  operationIndex: number,
): { axis: IntermediateStateAxis; opportunityId: IntermediateStateOpportunityId } | null {
  const selection = entryIntermediateSelection(entry)
  for (const axis of ['skill', 'bonus'] as const) {
    const selected = axis === 'skill' ? selection.skill : selection.bonus
    if (
      selected !== null &&
      selected.opportunity.lanePosition > 0 &&
      selected.opportunity.operationIndex === operationIndex
    ) {
      return { axis, opportunityId: selected.opportunity.id }
    }
  }
  return null
}

/**
 * How the pinned lane pair rates on each Target axis: the selected group's
 * own match, or `ideal` for an unselected lane, whose pinned state is the
 * lane end. Explanatory only; it decides nothing in the Planner.
 */
export function checkpointConditionMatchFor(entry: BuildListEntry): CompromiseConditionMatch {
  const selection = entryIntermediateSelection(entry)
  return {
    bonus: selection.bonus?.group.match ?? 'ideal',
    skill: selection.skill?.group.match ?? 'ideal',
  }
}

/**
 * The Target-wide checkpoint requirement of one Planner run
 * (`docs/PLANNER_SPEC.md` 7.5.6).
 *
 * A BuildListEntry that carries a selected intermediate state is that Target's
 * *required* Entry: the Target is not finished until this very Entry reached
 * its checkpoint and secured its Ideal Candidate, and no other Entry of the
 * Target is adopted as an alternative finishing Route. The map is derived from
 * the whole set of valid BuildListEntries of the run - never from a conflict's
 * participants alone - so the Planner Alternative reads the same authority
 * the scheduler and the Beam Search oracle do.
 */
export interface PlannerCheckpointRequirements {
  requiredEntryIdByTargetId: ReadonlyMap<TargetWeaponId, BuildListEntryId>
}

/** A Target with two or more checkpoint-selected Entries: fail closed. */
export interface PlannerCheckpointRequirementViolation {
  targetWeaponId: TargetWeaponId
  buildListEntryIds: BuildListEntryId[]
}

export interface PlannerCheckpointRequirementDerivation {
  requirements: PlannerCheckpointRequirements
  /** Stable order by Target ID; never resolved by picking one Entry. */
  violations: PlannerCheckpointRequirementViolation[]
}

export const EMPTY_PLANNER_CHECKPOINT_REQUIREMENTS: PlannerCheckpointRequirements = {
  requiredEntryIdByTargetId: new Map(),
}

/**
 * Derives the required Entry of every Target from the given Entries.
 *
 * At most one checkpoint-selected Entry per Target is a collection-level
 * invariant of the Planner input (`docs/DATA_MODEL.md` 9.4). Two such Entries
 * mean the user's intent - two mandatory Routes, or alternatives - is unknown,
 * so the Target is reported as a violation and gets no requirement: the caller
 * fails the input closed instead of guessing, scoring, or taking the first one.
 */
export function derivePlannerCheckpointRequirements(
  entries: readonly BuildListEntry[],
): PlannerCheckpointRequirementDerivation {
  const selectedByTarget = new Map<TargetWeaponId, BuildListEntryId[]>()
  entries.forEach((entry) => {
    if (!hasIntermediateStateSelection(entry)) return
    selectedByTarget.set(entry.targetWeaponId, [
      ...(selectedByTarget.get(entry.targetWeaponId) ?? []),
      entry.id,
    ])
  })
  const requiredEntryIdByTargetId = new Map<TargetWeaponId, BuildListEntryId>()
  const violations: PlannerCheckpointRequirementViolation[] = []
  ;[...selectedByTarget]
    .sort(([left], [right]) => compareStableStrings(left, right))
    .forEach(([targetWeaponId, entryIds]) => {
      const buildListEntryIds = [...new Set(entryIds)].sort(compareStableStrings)
      if (buildListEntryIds.length === 1) {
        requiredEntryIdByTargetId.set(targetWeaponId, buildListEntryIds[0])
      } else {
        violations.push({ targetWeaponId, buildListEntryIds })
      }
    })
  return { requirements: { requiredEntryIdByTargetId }, violations }
}

export type { IntermediateStateOpportunityId }
