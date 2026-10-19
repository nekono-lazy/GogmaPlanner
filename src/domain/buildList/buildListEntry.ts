import type {
  BuildCandidate,
  BuildListEntry,
  BuildListEntryId,
  BuildRoute,
  GroupSkillId,
  IntermediateStateSelection,
  RestorationBonus,
  RestorationBonusScope,
  RestorationBonusSet,
  SeriesSkillId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { hashStableValue, stableStringify } from '../models/hashing'
import { isBuildResultCalculationContextCompatible } from '../models/domainRules'

function compareStable(left: unknown, right: unknown): number {
  const leftValue = stableStringify(left)
  const rightValue = stableStringify(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function normalizeBonuses(bonuses: readonly RestorationBonus[]) {
  return bonuses
    .map(({ bonusTypeId, bonusRankId }) => ({ bonusTypeId, bonusRankId }))
    .sort(compareStable)
}

/**
 * The Target performance definition that decides whether a Candidate exists and
 * what it means (`docs/PLANNER_SPEC.md` 16.11).
 *
 * `priority`, `isEnabled`, `preferredOwnedWeaponId`, the lifecycle
 * (`lifecycleStatus`, `completedAt`, `completedByProductionPlanId`), `name`,
 * `memo` and timestamps are deliberately excluded: they are planning input or
 * execution state, not what a Candidate satisfies, so changing them never stales
 * a BuildListEntry with `target_definition_changed`. The planning-input hashes of
 * a ProductionPlan carry them separately.
 */
export function createTargetDefinitionHash(target: TargetWeapon): string {
  return hashStableValue({
    weaponTypeId: target.weaponTypeId,
    elementId: target.elementId,
    idealBonuses: normalizeBonuses(target.idealBonuses),
    practicalBonusConditions: target.practicalBonusConditions
      .map((condition) => ({ ...condition }))
      .sort(compareStable),
    alternativeBonusRules: target.alternativeBonusRules
      .map((group) => ({
        id: group.id,
        sourceBonusTypeId: group.sourceBonusTypeId,
        maxReplacementCount: group.maxReplacementCount,
        options: group.options.map((option) => ({ ...option })).sort(compareStable),
      }))
      .sort(compareStable),
    idealSkillCondition: { ...target.idealSkillCondition },
    practicalSkillCondition: { ...target.practicalSkillCondition },
  })
}

/**
 * The run-independent semantic meaning of one Candidate.
 *
 * `restorationBonusScope` is part of that meaning (PLANNER_SPEC 9.2.12): five
 * slots carrying identical Bonus Type / Rank labels mean a different result in
 * `normal_artian` scope than in `gogma_artian` scope, and B5-F1 already made
 * scope explicit everywhere else that compares completed results. Bonus slots
 * stay an unordered multiset with duplicate counts preserved, while
 * `route.operations` keeps its semantic order.
 *
 * Nothing derived, presentational, or run-scoped participates: no Candidate ID,
 * `searchRunId`, `createdAt`, category, similarity metadata, ideal-difference
 * summary, estimate field, or material requirement.
 */
export interface BuildCandidateMeaning {
  targetWeaponId: TargetWeaponId
  route: BuildRoute
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

export function createBuildCandidateMeaningFingerprint(
  candidate: BuildCandidateMeaning,
): string {
  return hashStableValue({
    targetWeaponId: candidate.targetWeaponId,
    route: candidate.route,
    finalBonuses: normalizeBonuses(candidate.finalBonuses),
    restorationBonusScope: candidate.restorationBonusScope,
    seriesSkillId: candidate.seriesSkillId,
    groupSkillId: candidate.groupSkillId,
  })
}

export function isSameBuildListCandidate(
  entry: BuildListEntry,
  candidate: BuildCandidate,
): boolean {
  return (
    entry.targetWeaponId === candidate.targetWeaponId &&
    isBuildResultCalculationContextCompatible(entry.calculationContext, candidate.calculationContext) &&
    isBuildResultCalculationContextCompatible(entry.candidateSnapshot.calculationContext, candidate.calculationContext) &&
    createBuildCandidateMeaningFingerprint(entry.candidateSnapshot) ===
      createBuildCandidateMeaningFingerprint(candidate)
  )
}

export interface CreateBuildListEntryOptions {
  id?: BuildListEntryId
  createdAt?: string
  /**
   * The intermediate states and improvement preference the user chose on the
   * Search screen.
   *
   * They are the Entry's own Planner input, so they never take part in
   * `createEntryId()` or `createBuildCandidateMeaningFingerprint()`: two Entries
   * differing only in their selection would otherwise be two different
   * Candidates, which they are not (`docs/DATA_MODEL.md` 9.4).
   */
  intermediateStateSelection?: IntermediateStateSelection
}

/** Nothing selected on either lane, and the improvement order left to the Planner. */
export function defaultIntermediateStateSelection(): IntermediateStateSelection {
  return { skillOpportunityId: null, bonusOpportunityId: null, improvementPreference: 'planner' }
}

/**
 * Replaces one Entry's intermediate state selection and improvement preference.
 *
 * It is an ordinary Build List edit, not a recalculation: the Candidate
 * Snapshot, both hashes and the `CalculationContext` are untouched, so the
 * Entry does not become stale. What it does change is the Plan's build-list
 * semantic hash, which is what makes an existing Plan a recalculation target
 * (`docs/PLANNER_SPEC.md` 7.5.5).
 */
export function withIntermediateStateSelection(
  entry: BuildListEntry,
  selection: IntermediateStateSelection,
): BuildListEntry {
  return {
    ...entry,
    intermediateStateSelection: { ...selection },
  }
}

function createEntryId(candidate: BuildCandidate, createdAt: string): BuildListEntryId {
  const suffix = hashStableValue({
    candidate: createBuildCandidateMeaningFingerprint(candidate),
    createdAt,
  }).replace(':', '-')
  return `build-list.${suffix}` as BuildListEntryId
}

export function createBuildListEntry(
  candidate: BuildCandidate,
  target: TargetWeapon,
  options: CreateBuildListEntryOptions = {},
): BuildListEntry {
  if (candidate.targetWeaponId !== target.id) {
    throw new Error('Candidate and TargetWeapon IDs must match.')
  }
  const createdAt = options.createdAt ?? new Date().toISOString()
  return {
    id: options.id ?? createEntryId(candidate, createdAt),
    candidateId: candidate.id,
    targetWeaponId: target.id,
    candidateSnapshot: structuredClone(candidate),
    intermediateStateSelection: {
      ...(options.intermediateStateSelection ?? defaultIntermediateStateSelection()),
    },
    targetDefinitionHash: createTargetDefinitionHash(target),
    searchStateHash: candidate.searchStateHash,
    referencedOwnedWeaponsHash: candidate.referencedOwnedWeaponsHash,
    calculationContext: { ...candidate.calculationContext },
    isStale: false,
    staleReasons: [],
    createdAt,
  }
}
