import type { BuildCandidate, BuildRoute, OwnedWeaponId } from '../models/publicTypes'
import { compareCanonicalIdeals, deduplicateCandidates } from './candidateProcessing'

/**
 * DATA_MODEL 7 / 9.2 and validateProtectedRouteUse / validateBuildRoute:
 * Bonus amendments and material consumption are destructive operations.
 * Conversion consumes an owned Normal source; a newly forged source is not
 * existing inventory. Reset Skills mutates performance but not this function's
 * narrower bonus/material destruction axis. Protection eligibility is validated
 * separately for every performance mutation.
 */
export function isDestructiveCandidateRoute(route: BuildRoute): boolean {
  return route.operations.some((operation) =>
    operation.type === 'reset_bonuses' ||
    operation.type === 'keep_bonuses' ||
    (operation.type === 'convert_normal_to_gogma' && route.kind === 'owned_normal_artian_to_gogma'),
  )
}

/**
 * Selects the single canonical Ideal Candidate of one Target
 * (`docs/SEARCH_SPEC.md` 5.6.3).
 *
 * Independent compromise Candidates do not exist, so there is nothing to keep
 * plural, rank, or cap: the only thing a Search retains is the one canonical
 * Ideal, or nothing at all when the configured extent contained no Ideal.
 *
 * `preferredOwnedWeaponId` reaches only the ordering, never the search extent:
 * the Target's preference decides which of two equally rated Ideal Routes is
 * chosen, and never how far the search looks (`docs/SEARCH_SPEC.md` 8.1).
 */
export function selectCanonicalIdealCandidate(
  candidates: readonly BuildCandidate[],
  preferredOwnedWeaponId: OwnedWeaponId | null = null,
): BuildCandidate | null {
  return (
    deduplicateCandidates(candidates)
      .sort((left, right) => compareCanonicalIdeals(left, right, preferredOwnedWeaponId))[0] ?? null
  )
}
