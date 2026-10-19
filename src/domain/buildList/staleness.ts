import type {
  BuildListEntry,
  BuildListEntryStaleReason,
  CalculationContext,
  NormalArtianCounter,
  OwnedWeapon,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  createReferencedOwnedWeaponsHash,
  createSearchStateHash,
} from '../models/hashing'
import { isBuildResultCalculationContextCompatible } from '../models/domainRules'
import { createTargetDefinitionHash } from './buildListEntry'

export interface BuildListStalenessContext {
  target: TargetWeapon | null
  rngState: RngState
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  calculationContext: CalculationContext
}

export interface BuildListEntryStalenessResult {
  isStale: boolean
  staleReasons: BuildListEntryStaleReason[]
}

export function evaluateBuildListEntryStaleness(
  entry: BuildListEntry,
  current: BuildListStalenessContext,
): BuildListEntryStalenessResult {
  const reasons: BuildListEntryStaleReason[] = []
  if (
    current.target === null ||
    createTargetDefinitionHash(current.target) !== entry.targetDefinitionHash
  ) {
    reasons.push('target_definition_changed')
  }
  if (
    createSearchStateHash(
      entry.candidateSnapshot.route,
      current.rngState,
      current.normalCounters,
    ) !== entry.searchStateHash
  ) {
    reasons.push('rng_state_changed')
  }
  if (
    createReferencedOwnedWeaponsHash(
      entry.candidateSnapshot.route,
      current.ownedWeapons,
    ) !== entry.referencedOwnedWeaponsHash
  ) {
    reasons.push('owned_weapon_changed')
  }
  if (
    !isBuildResultCalculationContextCompatible(
      entry.calculationContext,
      current.calculationContext,
    )
  ) {
    reasons.push('calculation_context_changed')
  }
  return { isStale: reasons.length > 0, staleReasons: reasons }
}

export function applyBuildListEntryStaleness(
  entry: BuildListEntry,
  result: BuildListEntryStalenessResult,
): BuildListEntry {
  return {
    ...entry,
    isStale: result.isStale,
    staleReasons: [...result.staleReasons],
  }
}
