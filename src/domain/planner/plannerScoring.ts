import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import type {
  BuildListEntry,
  BuildListEntryId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { stableStringify } from '../models/publicTypes'
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
  const satisfaction = state.targetSatisfaction[target.id] ?? { completedInRun: false }
  const candidate = entry.candidateSnapshot
  const targetPriorityScore = target.priority * 10_000
  // The only satisfaction the Planner pursues is the run's own completion of
  // the Target (Issue #334 PR-3, `docs/PLANNER_SPEC.md` 21.5): a Target whose
  // Entry has not secured its weapon is urgent, one that has is not.
  const satisfactionScore = satisfaction.completedInRun ? 0 : 50_000
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
 * The achieved-goal term of a state: one weight per Target its own Entry
 * completed in the run, scaled by Target priority. There is no Practical tier:
 * the Planner's goal is the Ideal alone (`docs/PLANNER_SPEC.md` 7), and an
 * owned weapon's performance counts for nothing (21.5).
 */
function achievedSatisfactionScore(
  state: PlannerSearchState,
  targets: readonly TargetWeapon[],
): number {
  return targets.reduce((total, target) => {
    const satisfaction = state.targetSatisfaction[target.id]
    if (!satisfaction?.completedInRun) return total
    return total + 1_200_000 + target.priority * 120_000
  }, 0)
}

function progressPotentialScore(
  state: PlannerSearchState,
  entries: readonly BuildListEntry[],
  targetsById: ReadonlyMap<TargetWeaponId, TargetWeapon>,
  routeUnitCountByEntryId: ReadonlyMap<BuildListEntryId, number>,
  conflictCountByEntryId: ReadonlyMap<BuildListEntryId, number>,
): number {
  const bestByTarget = new Map<TargetWeaponId, number>()
  entries.forEach((entry) => {
    if (state.selectedBuildListEntryIds.includes(entry.id)) return
    const target = targetsById.get(entry.targetWeaponId)
    if (!target) return
    if (!entryIsRelevantForState(state, entry)) return
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
 * `weaponSwitchCount`, `lastWeaponOperationSubjectKey` and
 * `preferredSourceProgressCount` are deliberately excluded too, and their
 * exclusion loses nothing. All three are pure functions of the trace
 * projection already keyed below: each action's `primaryBuildListEntryId` and
 * `progressedBuildListEntryIds` plus its `progressedRoutePositions` pin the
 * exact saved `RouteOperation`, and therefore its weapon subject and which
 * Entries it progressed. Two states sharing this key therefore always share all
 * three values, so deduplication identity, future switch accounting, the
 * preferred-source preference, and the deterministic tie-break stay consistent
 * without restating them (`docs/PLANNER_SPEC.md` 7.3 / 7.4).
 *
 * Issue #100 stage 2 (`docs/PLANNER_SPEC.md` 20.10) removed
 * `reachedCheckpointByEntryId` (always empty without a selection) and the
 * `hasPractical` of `targetSatisfaction` (always equal to `hasIdeal`) from this
 * key. Both were the same value in every pair of compared keys, so the key
 * equality and the order between any two keys are unchanged. Issue #334 PR-3
 * (`docs/PLANNER_SPEC.md` 21.5) replaced `hasIdeal` with the run's own
 * completion `completedInRun` and removed `inFlightExistingSourceByOwnedWeaponId`
 * (a pure function of the trace projection keyed below) with the
 * inventory-derived satisfaction.
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
  // The improvement preference term of calculation schema 11..18 sat here; it
  // was 0 for every branch without a selection and was removed with it (Issue
  // #100, docs/PLANNER_SPEC.md 7.6 / 20.10).
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
