import { hashStableValue, stableStringify } from '../models/hashing'
import { canonicalBonusMultiset, compareStableKeys } from './semanticKeys'
import type {
  BuildCandidate,
  BuildRoute,
  GroupSkillId,
  OwnedWeaponId,
  RestorationBonusScope,
  RestorationBonusSet,
  SeriesSkillId,
} from '../models/publicTypes'

/**
 * The run-independent semantic content of one composed Search result.
 *
 * `BuildCandidate` satisfies it, and so does the transient
 * `ConstrainedCandidate` of SEARCH_SPEC 5.6.7, which keeps one stable-key
 * authority across both boundaries.
 */
export interface CandidateStableKeyInput {
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  route: BuildRoute
}


export function candidateDeduplicationKey(candidate: BuildCandidate): string {
  return hashStableValue({
    finalBonuses: canonicalBonusMultiset(candidate.finalBonuses),
    seriesSkillId: candidate.seriesSkillId,
    groupSkillId: candidate.groupSkillId,
    routeKind: candidate.route.kind,
    sourceOwnedWeaponId: candidate.route.sourceOwnedWeaponId,
    operationHash: hashStableValue(candidate.route.operations),
  })
}

function materialQuantity(candidate: BuildCandidate): number {
  return candidate.requiredMaterials.reduce(
    (total, requirement) => total + requirement.quantity,
    0,
  )
}

function totalCounterAdvance(candidate: BuildCandidate): number {
  return (
    candidate.estimatedGogmaAdvance +
    candidate.estimatedSkillAdvance +
    (candidate.estimatedNormalAdvance ?? 0)
  )
}

/**
 * SEARCH_SPEC 5.6.3 / 8: the final tie-break is the run-independent
 * `candidateStableKey`, never `BuildCandidate.id`, whose `semanticHash` folds
 * in `searchRunId`. Two candidates that also tie on the stable key carry no
 * run-independent semantic difference left to order by, so they compare equal
 * and the caller's deterministic encounter order decides.
 */
export function compareDuplicateCandidates(
  left: BuildCandidate,
  right: BuildCandidate,
): number {
  return (
    left.estimatedOperationCount - right.estimatedOperationCount ||
    materialQuantity(left) - materialQuantity(right) ||
    totalCounterAdvance(left) - totalCounterAdvance(right) ||
    compareStableKeys(candidateStableKey(left), candidateStableKey(right))
  )
}

export function deduplicateCandidates(
  candidates: readonly BuildCandidate[],
): BuildCandidate[] {
  const selected = new Map<string, BuildCandidate>()
  candidates.forEach((candidate) => {
    const key = candidateDeduplicationKey(candidate)
    const current = selected.get(key)
    if (!current || compareDuplicateCandidates(candidate, current) < 0) {
      selected.set(key, candidate)
    }
  })
  return [...selected.values()]
}

function nullableAscending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return left - right
}

/**
 * 0 when this Candidate's Route starts from the Target's preferred owned
 * weapon, 1 otherwise, so a plain ascending comparison puts preferred first.
 *
 * `route.sourceOwnedWeaponId` is the whole test, so a new-Normal route - whose
 * source is `null` - is never preferred (`docs/SEARCH_SPEC.md` 8.1).
 */
function preferredSourceRank(
  candidate: CandidateStableKeyInput,
  preferredOwnedWeaponId: OwnedWeaponId | null,
): number {
  if (preferredOwnedWeaponId === null) return 0
  return candidate.route.sourceOwnedWeaponId === preferredOwnedWeaponId ? 0 : 1
}

/**
 * The Target's preferred owned weapon as an ordering preference.
 *
 * Placed immediately before the final stable tie-break in every Candidate
 * comparison, and nowhere else: every existing correctness, cost and closeness
 * priority is decided first, so a preferred Route can never overtake a cheaper
 * or better one. It never enters `candidateStableKey()`, the Candidate ID, the
 * deduplication key, or the meaning fingerprint, because the preference belongs
 * to the Target, not to the Candidate's own meaning
 * (`docs/SEARCH_SPEC.md` 8.1).
 */
function comparePreferredSource(
  left: CandidateStableKeyInput,
  right: CandidateStableKeyInput,
  preferredOwnedWeaponId: OwnedWeaponId | null,
): number {
  return (
    preferredSourceRank(left, preferredOwnedWeaponId) -
    preferredSourceRank(right, preferredOwnedWeaponId)
  )
}

/** Run-independent semantic identity; never change persisted Candidate IDs. */
export function candidateStableKey(candidate: CandidateStableKeyInput): string {
  return stableStringify({
    finalBonuses: canonicalBonusMultiset(candidate.finalBonuses),
    restorationBonusScope: candidate.restorationBonusScope,
    seriesSkillId: candidate.seriesSkillId,
    groupSkillId: candidate.groupSkillId,
    routeKind: candidate.route.kind,
    sourceOwnedWeaponId: candidate.route.sourceOwnedWeaponId,
    operations: candidate.route.operations,
  })
}

/**
 * SEARCH_SPEC 5.6.3 canonical Ideal ordering.
 *
 * Every composed Candidate is an Ideal Candidate now, so this is the only
 * Candidate ordering the Search needs: cheapest first, then the smallest
 * advance on each stream, then the Target's preferred source, then the
 * run-independent stable key.
 *
 * Checkpoint availability, checkpoint earliness and checkpoint quality are
 * deliberately absent. They are derived from the chosen Route, so letting them
 * choose the Route would make the canonical Ideal depend on its own output
 * (`docs/SEARCH_SPEC.md` 5.8.6).
 */
export function compareCanonicalIdeals(
  left: BuildCandidate,
  right: BuildCandidate,
  preferredOwnedWeaponId: OwnedWeaponId | null = null,
): number {
  return left.estimatedOperationCount - right.estimatedOperationCount ||
    left.estimatedGogmaAdvance - right.estimatedGogmaAdvance ||
    left.estimatedSkillAdvance - right.estimatedSkillAdvance ||
    nullableAscending(left.estimatedNormalAdvance, right.estimatedNormalAdvance) ||
    comparePreferredSource(left, right, preferredOwnedWeaponId) ||
    compareStableKeys(candidateStableKey(left), candidateStableKey(right))
}
