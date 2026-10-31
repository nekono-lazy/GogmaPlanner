import type {
  BuildListEntry,
  BuildListEntryStaleReason,
  CalculationContext,
  NormalArtianCounter,
  OwnedWeapon,
  ProductionPlan,
  ProductionPlanId,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import {
  targetWeaponPlanningIneligibilityCause,
  type TargetWeaponPlanningIneligibilityCause,
} from '../models/domainRules'
import { buildListEntriesForTarget } from './buildListCardinality'
import { evaluateBuildListEntryStaleness } from './staleness'

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Why a Target whose Build List Entry needs a new search is not re-searched by
 * 「再検索が必要な候補を一括再検索・置換」 (`docs/UI_FLOW.md` 9.3, Issue #347).
 *
 * - `target_not_found`: the Entry's Target no longer exists, so nothing can be
 *   searched for it; the Entry is tidied in the Build List
 * - `target_not_searchable`: the Target exists but the ordinary single search
 *   could not search it either - it is `completed`, its search is disabled, or
 *   its completion condition still waits for the user's review
 *   (`targetWeaponPlanningIneligibilityCause()`, the one authority of
 *   `isTargetWeaponPlanningEligible()`)
 * - `legacy_duplicate`: the Target holds two or more Entries, so which one is
 *   its current Entry is unknown and none is picked (`docs/DATA_MODEL.md` 9.4.1)
 * - `active_plan_dependent`: the Entry is one the `active` Plan depends on
 *   (`selectedBuildListEntryIds`); replacing it needs the breaking-change
 *   approval (`docs/PLANNER_SPEC.md` 16.6), which a batch never gives
 */
export type BuildListResearchExclusionReason =
  | { kind: 'target_not_found' }
  | { kind: 'target_not_searchable'; cause: TargetWeaponPlanningIneligibilityCause }
  | { kind: 'legacy_duplicate' }
  | { kind: 'active_plan_dependent'; productionPlanId: ProductionPlanId }

/** One Target the batch re-searches: its one stale Entry and why it is stale now. */
export interface BuildListResearchTarget {
  target: TargetWeapon
  entry: BuildListEntry
  /** The current stale reasons, recomputed from the state given (never the persisted flags). */
  staleReasons: BuildListEntryStaleReason[]
}

/** One Target with at least one stale Entry that the batch leaves alone, with the reason. */
export interface BuildListResearchExclusion {
  targetWeaponId: TargetWeaponId
  /** `null` when the Target no longer exists. */
  target: TargetWeapon | null
  /** The Target's stale Entries, in stable ID order. */
  entries: BuildListEntry[]
  reason: BuildListResearchExclusionReason
}

export interface BuildListResearchSelection {
  /** The Targets to re-search, in the order of `targetWeapons`. */
  targets: BuildListResearchTarget[]
  /** The Targets left alone, in the order of `targetWeapons`; Entries of a missing Target come last, by Target ID. */
  excluded: BuildListResearchExclusion[]
}

export interface BuildListResearchSelectionInput {
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly BuildListEntry[]
  rngState: RngState
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  /** The current CalculationContext the staleness is judged against. */
  calculationContext: CalculationContext
  /**
   * The one running (`active` / `stale`) Plan as persisted, or `null`. Only an
   * `active` Plan excludes its dependent Entries: a `stale` Plan is never
   * judged by the breaking-change guard (`docs/PLANNER_SPEC.md` 16.6), so its
   * Entries are replaced like any other.
   */
  runningPlan: Pick<ProductionPlan, 'id' | 'status' | 'selectedBuildListEntryIds'> | null
}

/**
 * The one authority deciding which Build List Entries 「再検索が必要な候補を
 * 一括再検索・置換」 re-searches (`docs/UI_FLOW.md` 9.3, Issue #347). Pure: it
 * reads only its input and writes nothing.
 *
 * A Target is re-searched when it exists, the ordinary single search could
 * search it (`isTargetWeaponPlanningEligible()`), it holds exactly one Entry,
 * that Entry is stale by `evaluateBuildListEntryStaleness()` recomputed from
 * this state (the persisted `isStale` / `staleReasons` are never trusted), and
 * the Entry is not one the `active` Plan depends on. A Target with no Entry is
 * neither re-searched nor excluded: it belongs to 「未登録を一括検索・追加」
 * (9.1). A Target whose Entries are all up to date is listed nowhere.
 *
 * Every reason not to re-search a stale Entry is returned as an exclusion
 * with its reason, so the screen can say why - a `completed` Target's stale
 * Entry included: its staleness is judged exactly as any other Entry's
 * (`docs/REQUIREMENTS.md` 18 excludes it from the Planner input as a completed
 * Target, not as a stale Entry), and it is never re-searched.
 */
export function selectBuildListResearchTargets(
  input: BuildListResearchSelectionInput,
): BuildListResearchSelection {
  const targets: BuildListResearchTarget[] = []
  const excluded: BuildListResearchExclusion[] = []
  const activeEntryIds = new Set<string>(
    input.runningPlan !== null && input.runningPlan.status === 'active' ? input.runningPlan.selectedBuildListEntryIds : [],
  )
  const knownTargetIds = new Set<TargetWeaponId>(input.targetWeapons.map(({ id }) => id))
  const stalenessOf = (entry: BuildListEntry, target: TargetWeapon | null) =>
    evaluateBuildListEntryStaleness(entry, {
      target,
      rngState: input.rngState,
      normalCounters: input.normalCounters,
      ownedWeapons: input.ownedWeapons,
      calculationContext: input.calculationContext,
    })

  input.targetWeapons.forEach((target) => {
    const entries = buildListEntriesForTarget(input.buildListEntries, target.id)
    if (entries.length === 0) return
    const stale = entries
      .map((entry) => ({ entry, staleness: stalenessOf(entry, target) }))
      .filter(({ staleness }) => staleness.isStale)
    if (stale.length === 0) return
    const exclusion = (reason: BuildListResearchExclusionReason): BuildListResearchExclusion => ({
      targetWeaponId: target.id,
      target,
      entries: stale.map(({ entry }) => entry),
      reason,
    })
    if (entries.length >= 2) {
      excluded.push(exclusion({ kind: 'legacy_duplicate' }))
      return
    }
    const ineligibility = targetWeaponPlanningIneligibilityCause(target)
    if (ineligibility !== null) {
      excluded.push(exclusion({ kind: 'target_not_searchable', cause: ineligibility }))
      return
    }
    const [{ entry, staleness }] = stale
    if (activeEntryIds.has(entry.id) && input.runningPlan !== null) {
      excluded.push(exclusion({ kind: 'active_plan_dependent', productionPlanId: input.runningPlan.id }))
      return
    }
    targets.push({ target, entry, staleReasons: staleness.staleReasons })
  })

  // An Entry whose Target is gone is always stale (`target_definition_changed`)
  // and can never be searched: it is reported, never guessed a Target for.
  const orphanIds = [...new Set(
    input.buildListEntries
      .filter(({ targetWeaponId }) => !knownTargetIds.has(targetWeaponId))
      .map(({ targetWeaponId }) => targetWeaponId),
  )].sort(compareCodeUnits)
  orphanIds.forEach((targetWeaponId) => {
    excluded.push({
      targetWeaponId,
      target: null,
      entries: buildListEntriesForTarget(input.buildListEntries, targetWeaponId),
      reason: { kind: 'target_not_found' },
    })
  })

  return { targets, excluded }
}
