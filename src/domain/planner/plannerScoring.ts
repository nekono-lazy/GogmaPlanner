import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { stableStringify } from '../models/publicTypes'
import type { PlannerCheckpointRequirements } from './plannerCheckpoints'
import { entryIsRelevantForState } from './plannerEntryRelevance'
import { totalPlannerLaneProgress } from './plannerRouteLanes'
import type {
  CandidateScore,
  PlannerSearchState,
} from './plannerTypes'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function scoreCandidate(
  state: PlannerSearchState,
  target: TargetWeapon,
  entry: BuildListEntry,
  conflictCount = 0,
): CandidateScore {
  const satisfaction = state.targetSatisfaction[target.id] ?? {
    hasPractical: false,
    hasIdeal: false,
  }
  const candidate = entry.candidateSnapshot
  const targetPriorityScore = target.priority * 10_000
  // The only satisfaction the Planner pursues is the Ideal: a Target that lacks
  // its Ideal is urgent, one that holds it is not. `hasPractical` is never read
  // here - whether the Target already holds a compromise weapon changes no
  // Planner priority (`docs/PLANNER_SPEC.md` 7), and a selected checkpoint is a
  // hard constraint outside the score (7.5).
  const satisfactionScore = satisfaction.hasIdeal ? 0 : 50_000
  const distancePenalty = candidate.estimatedOperationCount * 100
  const conflictPenalty = conflictCount * 5_000
  return {
    targetPriorityScore,
    satisfactionScore,
    distancePenalty,
    conflictPenalty,
    total:
      targetPriorityScore +
      satisfactionScore -
      distancePenalty -
      conflictPenalty,
  }
}

/**
 * The achieved-goal term of a state: one weight per Target that holds its
 * Ideal, scaled by Target priority. There is no Practical tier - a Target that
 * only holds a compromise weapon scores exactly like one that holds nothing,
 * because the Planner's goal is the Ideal alone (`docs/PLANNER_SPEC.md` 7).
 */
function achievedSatisfactionScore(
  state: PlannerSearchState,
  targets: readonly TargetWeapon[],
): number {
  return targets.reduce((total, target) => {
    const satisfaction = state.targetSatisfaction[target.id]
    if (!satisfaction?.hasIdeal) return total
    return total + 1_200_000 + target.priority * 120_000
  }, 0)
}

function progressPotentialScore(
  state: PlannerSearchState,
  entries: readonly BuildListEntry[],
  targetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>,
  routeUnitCountByEntryId: ReadonlyMap<BuildListEntryId, number>,
  conflictCountByEntryId: ReadonlyMap<BuildListEntryId, number>,
  checkpointRequirements: PlannerCheckpointRequirements,
): number {
  const bestByTarget = new Map<TargetWeaponId, number>()
  entries.forEach((entry) => {
    if (state.selectedBuildListEntryIds.includes(entry.id)) return
    const target = targetsById.get(entry.targetWeaponId)
    if (!target) return
    // Relevance, not `hasIdeal`: a required checkpoint Entry keeps its
    // progress potential after another weapon made its Target Ideal, and an
    // Entry the requirement excludes never had any.
    if (!entryIsRelevantForState(state, entry, checkpointRequirements)) return
    const unitCount = routeUnitCountByEntryId.get(entry.id) ?? 0
    const laneProgress = state.routeProgressByEntryId[entry.id]
    const progress = laneProgress === undefined ? 0 : totalPlannerLaneProgress(laneProgress)
    if (unitCount <= 0 || progress <= 0) return
    const candidateScore = scoreCandidate(
      state,
      target,
      entry,
      conflictCountByEntryId.get(entry.id) ?? 0,
    ).total
    const progressBonus = Math.trunc((progress * 1_000) / (unitCount + 1))
    const value = candidateScore + progressBonus
    const current = bestByTarget.get(target.id)
    if (current === undefined || value > current) {
      bestByTarget.set(target.id, value)
    }
  })
  return [...bestByTarget.values()].reduce((total, value) => total + value, 0)
}

export interface StateScoreContext {
  entries: readonly BuildListEntry[]
  /**
   * The run's planning Targets (`PlannerInitialContext.planningTargetsById`),
   * so a Target with no valid BuildListEntry never adds to the achieved term.
   */
  targetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>
  routeUnitCountByEntryId: ReadonlyMap<BuildListEntryId, number>
  conflictCountByEntryId: ReadonlyMap<BuildListEntryId, number>
  checkpointRequirements: PlannerCheckpointRequirements
}

export function evaluatePlannerSearchState(
  state: PlannerSearchState,
  context: StateScoreContext,
): number {
  const targets = [...context.targetsById.values()].filter(
    isTargetWeaponPlanningEligible,
  )
  const achieved = achievedSatisfactionScore(state, targets)
  const progress = progressPotentialScore(
    state,
    context.entries,
    context.targetsById,
    context.routeUnitCountByEntryId,
    context.conflictCountByEntryId,
    context.checkpointRequirements,
  )
  const actionPenalty = state.trace.length * 100
  return achieved + progress - actionPenalty
}

function normalizedOwnedWeapons(state: PlannerSearchState) {
  const generatedOriginById = new Map(
    Object.entries(state.securedOwnedWeaponIdByEntryId).map(
      ([entryId, ownedWeaponId]) => [ownedWeaponId, entryId],
    ),
  )
  return state.simulatedInventory.ownedWeapons
    .map((weapon) => ({
      id: generatedOriginById.get(weapon.id) ?? weapon.id,
      kind: weapon.kind,
      weaponTypeId: weapon.weaponTypeId,
      elementId: weapon.elementId,
      restorationBonusScope: weapon.restorationBonusScope,
      restorationBonuses: weapon.restorationBonuses,
      isProtected: weapon.isProtected,
      // `status` is the one deliberate omission: it is a user-facing
      // organisation label that decides nothing in the Planner, so two branches
      // differing only in it are the same search state
      // (`docs/DATA_MODEL.md` 3.2). Every other field above stays semantic -
      // `restorationBonusScope` above all, because the same five labels under
      // `normal_artian` and `gogma_artian` scope are different results and
      // reach different later Bonus outcomes.
      ...(weapon.kind === 'gogma'
        ? {
            seriesSkillId: weapon.seriesSkillId,
            groupSkillId: weapon.groupSkillId,
          }
        : { rarity: weapon.rarity }),
    }))
    .sort((left, right) => compareStableStrings(left.id, right.id))
}

/**
 * IDs reserved during search and timestamps are deliberately excluded.
 *
 * `weaponSwitchCount`, `lastWeaponOperationSubjectKey`,
 * `preferredSourceProgressCount`, and `improvementPreferenceViolationCount`
 * are deliberately excluded too, and their exclusion loses nothing. All four
 * are pure functions of the trace projection
 * already keyed below: each action's `primaryBuildListEntryId` and
 * `progressedBuildListEntryIds` plus its `progressedRoutePositions` pin the
 * exact saved `RouteOperation`, and therefore its weapon subject and which
 * Entries it progressed. Two states sharing this key therefore always share all
 * four values, so deduplication identity, future switch accounting, the two
 * user preferences, and the deterministic tie-break stay consistent without
 * restating them (`docs/PLANNER_SPEC.md` 7.3 / 7.4 / 7.6).
 */
export function createPlannerSearchStateSemanticKey(
  state: PlannerSearchState,
): string {
  return stableStringify({
    rng: {
      gogmaCounter: state.currentRngState.gogmaCounter.value,
      skillCounter: state.currentRngState.skillCounter.value,
    },
    normalCounters: state.currentNormalCounters
      .map(({ id, counter, isConfirmed }) => ({ id, counter, isConfirmed }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
    inventory: normalizedOwnedWeapons(state),
    consumedInitialWeaponIds: state.simulatedInventory.consumedWeaponIds
      .filter((id) => !state.simulatedInventory.createdWeaponIds.includes(id))
      .sort(compareStableStrings),
    targetSatisfaction: state.targetSatisfaction,
    routeProgressByEntryId: state.routeProgressByEntryId,
    routeRuntimeByEntryId: state.routeRuntimeByEntryId,
    sourceMutationVersionByOwnedWeaponId: state.sourceMutationVersionByOwnedWeaponId,
    candidateReadySourceVersionByEntryId:
      state.candidateReadySourceVersionByEntryId,
    routeSourceVersionByEntryId: state.routeSourceVersionByEntryId,
    inFlightExistingSourceByOwnedWeaponId:
      state.inFlightExistingSourceByOwnedWeaponId,
    reachedCheckpointByEntryId: state.reachedCheckpointByEntryId,
    selectedBuildListEntryIds: [...state.selectedBuildListEntryIds].sort(
      compareStableStrings,
    ),
    trace: state.trace.map((action) => ({
      kind: action.kind,
      actionType: action.actionType,
      primaryBuildListEntryId: action.primaryBuildListEntryId,
      progressedBuildListEntryIds: action.progressedBuildListEntryIds,
      progressedRoutePositions: action.progressedRoutePositions,
    })),
  })
}

function traceTieBreakKey(state: PlannerSearchState): string {
  return stableStringify(
    state.trace.map((action) => ({
      kind: action.kind,
      actionType: action.actionType,
      primaryBuildListEntryId: action.primaryBuildListEntryId,
      progressedBuildListEntryIds: action.progressedBuildListEntryIds,
      progressedRoutePositions: action.progressedRoutePositions,
    })),
  )
}

export function comparePlannerSearchStates(
  left: PlannerSearchState,
  right: PlannerSearchState,
): number {
  if (left.evaluationScore !== right.evaluationScore) {
    return right.evaluationScore - left.evaluationScore
  }
  // Plan preference, below every correctness, satisfaction, and cost decision:
  // among branches the existing evaluation already rates equally, prefer the
  // one that works from the owned weapon its Target named as the preferred
  // starting point. Never a weight inside evaluationScore, so it can never
  // reverse a cheaper Route (docs/PLANNER_SPEC.md 7.4).
  if (left.preferredSourceProgressCount !== right.preferredSourceProgressCount) {
    return right.preferredSourceProgressCount - left.preferredSourceProgressCount
  }
  // The user's improvement preference, below every existing evaluation term
  // and the preferred-source preference, above the automatic weapon-switch
  // heuristic: among equally rated branches, prefer the one that improved the
  // lane the user asked for first. Soft by construction - it can never beat a
  // cheaper or more complete Plan (docs/PLANNER_SPEC.md 7.6).
  if (
    left.improvementPreferenceViolationCount !==
    right.improvementPreferenceViolationCount
  ) {
    return (
      left.improvementPreferenceViolationCount -
      right.improvementPreferenceViolationCount
    )
  }
  // Plan quality, below the preferred-source preference and above the two
  // stable string tie-breaks: among Plans the existing evaluation already rates
  // equally, prefer the one that makes the player swap the weapon in hand fewer
  // times (docs/PLANNER_SPEC.md 7.3).
  if (left.weaponSwitchCount !== right.weaponSwitchCount) {
    return left.weaponSwitchCount - right.weaponSwitchCount
  }
  const semantic = compareStableStrings(
    createPlannerSearchStateSemanticKey(left),
    createPlannerSearchStateSemanticKey(right),
  )
  if (semantic !== 0) return semantic
  return compareStableStrings(traceTieBreakKey(left), traceTieBreakKey(right))
}
