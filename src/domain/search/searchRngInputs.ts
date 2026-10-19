import type { RngState } from '../models/publicTypes'

/**
 * The confirmed RNG inputs are a property of `RngState` alone, so both the
 * ordinary `CandidateSearchInput` and the constrained `ConstrainedSearchOrigin`
 * (SEARCH_SPEC 5.6.7) satisfy this structural parameter.
 */
export interface SearchRngStateInput {
  rngState: RngState
}

export function hasConfirmedSkillInputs(input: SearchRngStateInput): boolean {
  return input.rngState.baseSeed.isConfirmed && input.rngState.baseSeed.value !== null
    && input.rngState.skillCounter.isConfirmed && input.rngState.skillCounter.value !== null
}

export function hasConfirmedGogmaInputs(input: SearchRngStateInput): boolean {
  return input.rngState.baseSeed.isConfirmed && input.rngState.baseSeed.value !== null
    && input.rngState.gogmaCounter.isConfirmed && input.rngState.gogmaCounter.value !== null
}
