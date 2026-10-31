import type {
  BuildCandidate,
  BuildListEntry,
  BuildListEntryId,
  BuildRoute,
  CompletionSkillVariant,
  GroupSkillId,
  RestorationBonus,
  RestorationBonusScope,
  RestorationBonusSet,
  SeriesSkillId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { hashStableValue, stableStringify } from '../models/hashing'
import { isBuildResultCalculationContextCompatible } from '../models/domainRules'
import { normalizeCompletionBonusVariants } from '../target/completionCondition'
import { normalizeCompletionSkillVariants } from '../target/completionSkillVariants'

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
 * what it means (`docs/PLANNER_SPEC.md` 16.11, `docs/DATA_MODEL.md` 9.4).
 *
 * Only the weapon type, element, the normalized completion Variants and the
 * completion Skill configurations enter (see `completionSkillDefinition()`). The Variants are normalized as a multiset
 * per Variant (slot order ignored, duplicate counts kept) and sorted, and the
 * Variant `id` is dropped, so reordering Variants or slots or renaming an `id`
 * changes nothing, while adding, removing or lowering a Variant does.
 *
 * `priority`, `isEnabled`, `preferredOwnedWeaponId`, the lifecycle
 * (`lifecycleStatus`, `completedAt`, `completedByProductionPlanId`),
 * `completionConditionReview`, `name`, `memo` and timestamps are deliberately
 * excluded: they are planning input or execution state, not what a Candidate
 * satisfies, so changing them never stales a BuildListEntry with
 * `target_definition_changed`. The planning-input hashes of a ProductionPlan
 * carry them separately.
 */
export function createTargetDefinitionHash(target: TargetWeapon): string {
  return hashStableValue({
    weaponTypeId: target.weaponTypeId,
    elementId: target.elementId,
    completionBonusVariants: normalizeCompletionBonusVariants(target.completionBonusVariants),
    ...completionSkillDefinition(target.completionSkillVariants),
  })
}

/**
 * The completion Skill part of the Target definition hash (`docs/DATA_MODEL.md`
 * 9.4, Issue #367). One configuration hashes with exactly the calculation
 * schema 20 input, `completionSkillCondition: { seriesSkillId, groupSkillId,
 * matchMode: "all" }` - a deliberate compatibility normalization, so every
 * migrated Target keeps its hash, no BuildListEntry turns
 * `target_definition_changed` and no running Plan goes stale without a
 * calculation version change. Two or more hash as the normalized configuration
 * set under another key, so the shapes never collide. Reordering configurations
 * or renaming their `id` changes nothing; adding, removing or changing a
 * configuration's Series / Group Skill changes the hash.
 */
function completionSkillDefinition(variants: readonly CompletionSkillVariant[]) {
  if (variants.length === 1) {
    const [variant] = variants
    return {
      completionSkillCondition: {
        seriesSkillId: variant!.seriesSkillId,
        groupSkillId: variant!.groupSkillId,
        matchMode: 'all',
      },
    }
  }
  return { completionSkillVariants: normalizeCompletionSkillVariants(variants) }
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

/**
 * A new Entry carries no `intermediateStateSelection` (Issue #100,
 * `docs/PLANNER_SPEC.md` 20.7 / 20.10): the lane selection and the improvement
 * preference were abolished, so there is no option to set one. A legacy Entry
 * that holds one keeps it exactly as persisted; nothing here writes or clears it.
 */
export interface CreateBuildListEntryOptions {
  id?: BuildListEntryId
  createdAt?: string
}

/**
 * Whether a legacy Entry selected an intermediate state on at least one lane
 * (calculation schema 11..18, `docs/PLANNER_SPEC.md` 7.5, abolished by Issue
 * #100). Schema 19 Entries carry no selection; the Planner fails an input with
 * such a valid Entry closed instead of reading the selection as empty
 * (`docs/PLANNER_SPEC.md` 20.7 / 20.10).
 */
export function hasIntermediateStateSelection(entry: BuildListEntry): boolean {
  const selection = entry.intermediateStateSelection
  return (
    selection !== undefined &&
    (selection.skillOpportunityId !== null || selection.bonusOpportunityId !== null)
  )
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
    // Issue #100: no `intermediateStateSelection`. An absent field normalizes
    // to the same Plan hash as the legacy empty selection
    // (`docs/PLANNER_SPEC.md` 20.3).
    targetDefinitionHash: createTargetDefinitionHash(target),
    searchStateHash: candidate.searchStateHash,
    referencedOwnedWeaponsHash: candidate.referencedOwnedWeaponsHash,
    calculationContext: { ...candidate.calculationContext },
    isStale: false,
    staleReasons: [],
    createdAt,
  }
}
