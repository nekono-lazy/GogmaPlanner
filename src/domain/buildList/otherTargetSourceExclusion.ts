import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import { collectReferencedOwnedWeaponIds } from '../models/hashing'
import { evaluateBuildListEntryStaleness } from './staleness'

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Why another Target uses one OwnedWeapon (`docs/SEARCH_SPEC.md` 3.3「除外集合の導出」).
 *
 * - `preferred_owned_weapon`: the weapon is the `preferredOwnedWeaponId` of that Target
 * - `build_list_entry_source`: a non-stale Build List Entry of that Target references the weapon in its Route
 */
export type OtherTargetSourceUsageReason =
  | { kind: 'preferred_owned_weapon'; targetWeaponId: TargetWeaponId }
  | {
      kind: 'build_list_entry_source'
      targetWeaponId: TargetWeaponId
      buildListEntryId: BuildListEntryId
    }

/** One excluded OwnedWeapon with every reason it is used by another Target (one or more). */
export interface OtherTargetSourceUsage {
  ownedWeaponId: OwnedWeaponId
  reasons: OtherTargetSourceUsageReason[]
}

/**
 * The OwnedWeapons a Candidate Search for `targetWeaponId` does not use as a Route base when
 * 「他の目標武器で使用する所持武器を除外する」 is on (`docs/SEARCH_SPEC.md` 3.3).
 *
 * `excludedOwnedWeaponIds` is the IDs of `usages`, without duplicates, in code unit order; `usages` is in
 * the same order. Runtime-only: never persisted, and never part of a Candidate, an Entry or a hash.
 */
export interface OtherTargetSourceExclusion {
  targetWeaponId: TargetWeaponId
  excludedOwnedWeaponIds: OwnedWeaponId[]
  usages: OtherTargetSourceUsage[]
}

/**
 * One read of the persisted state the derivation runs over. It must be the same read the search input is
 * built from (`docs/SEARCH_SPEC.md` 3.3「検索中・追加時の状態変化」), so the derivation returns only IDs present in
 * `ownedWeapons`.
 */
export interface OtherTargetSourceExclusionInput {
  /** The Target T being searched. */
  targetWeaponId: TargetWeaponId
  targetWeapons: readonly TargetWeapon[]
  ownedWeapons: readonly OwnedWeapon[]
  buildListEntries: readonly BuildListEntry[]
  rngState: RngState
  normalCounters: readonly NormalArtianCounter[]
  /** The CalculationContext of that search; the Entry staleness is recomputed against it. */
  calculationContext: CalculationContext
}

/** Reasons of one weapon in a stable order: Target ID, then the preference before an Entry, then Entry ID. */
function compareReasons(left: OtherTargetSourceUsageReason, right: OtherTargetSourceUsageReason): number {
  const byTarget = compareCodeUnits(left.targetWeaponId, right.targetWeaponId)
  if (byTarget !== 0) return byTarget
  if (left.kind !== right.kind) return left.kind === 'preferred_owned_weapon' ? -1 : 1
  if (left.kind === 'build_list_entry_source' && right.kind === 'build_list_entry_source') {
    return compareCodeUnits(left.buildListEntryId, right.buildListEntryId)
  }
  return 0
}

/**
 * The one authority deriving which OwnedWeapons other Targets use (`docs/SEARCH_SPEC.md` 3.3「除外集合の導出」),
 * shared by the single Candidate Search and the batch search / addition. Pure: it reads only its input.
 *
 * For every Target U other than T that `isTargetWeaponPlanningEligible()` accepts:
 *
 * 1. U's non-null `preferredOwnedWeaponId` (`preferred_owned_weapon`)
 * 2. every OwnedWeapon `collectReferencedOwnedWeaponIds()` finds in the Route of each Build List Entry of U that
 *    is non-stale by `evaluateBuildListEntryStaleness()` recomputed from this state - the persisted `isStale` /
 *    `staleReasons` are never trusted (`build_list_entry_source`). A legacy duplicate counts every non-stale Entry.
 *
 * T's own preference and T's own Entries are never counted, so T's preferred weapon is excluded only when another
 * Target's non-stale Entry uses it. A disabled or completed Target, and an Entry of a Target that no longer exists,
 * are not counted. A preference and an Entry that disagree are both counted (a union). Nothing else is judged here:
 * not `executionInProgress`, not the intermediate state selection, not RNG capability or prediction support, and
 * not weapon type / element / protection compatibility with T, which the Search Domain's Route eligibility keeps
 * deciding. A weapon referenced by no record of `ownedWeapons` is not returned.
 */
export function deriveOtherTargetSourceExclusion(
  input: OtherTargetSourceExclusionInput,
): OtherTargetSourceExclusion {
  const ownedWeaponIds = new Set<OwnedWeaponId>(input.ownedWeapons.map(({ id }) => id))
  const otherTargetsById = new Map<TargetWeaponId, TargetWeapon>()
  input.targetWeapons.forEach((target) => {
    if (target.id !== input.targetWeaponId && isTargetWeaponPlanningEligible(target)) {
      otherTargetsById.set(target.id, target)
    }
  })

  const reasonsByWeapon = new Map<OwnedWeaponId, OtherTargetSourceUsageReason[]>()
  const addReason = (ownedWeaponId: OwnedWeaponId, reason: OtherTargetSourceUsageReason) => {
    if (!ownedWeaponIds.has(ownedWeaponId)) return
    const reasons = reasonsByWeapon.get(ownedWeaponId)
    if (reasons) reasons.push(reason)
    else reasonsByWeapon.set(ownedWeaponId, [reason])
  }

  otherTargetsById.forEach((target) => {
    if (target.preferredOwnedWeaponId !== null) {
      addReason(target.preferredOwnedWeaponId, { kind: 'preferred_owned_weapon', targetWeaponId: target.id })
    }
  })

  input.buildListEntries.forEach((entry) => {
    const target = otherTargetsById.get(entry.targetWeaponId)
    if (target === undefined) return
    const staleness = evaluateBuildListEntryStaleness(entry, {
      target,
      rngState: input.rngState,
      normalCounters: input.normalCounters,
      ownedWeapons: input.ownedWeapons,
      calculationContext: input.calculationContext,
    })
    if (staleness.isStale) return
    collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route).forEach((ownedWeaponId) => {
      addReason(ownedWeaponId, {
        kind: 'build_list_entry_source',
        targetWeaponId: target.id,
        buildListEntryId: entry.id,
      })
    })
  })

  const usages: OtherTargetSourceUsage[] = [...reasonsByWeapon]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([ownedWeaponId, reasons]) => ({ ownedWeaponId, reasons: [...reasons].sort(compareReasons) }))
  return {
    targetWeaponId: input.targetWeaponId,
    excludedOwnedWeaponIds: usages.map(({ ownedWeaponId }) => ownedWeaponId),
    usages,
  }
}
