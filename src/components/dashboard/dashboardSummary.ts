import { evaluateBuildListEntryStaleness } from '../../domain/buildList'
import { getEnabledWeaponTypes } from '../../domain/master/masterSelectors'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { createInitialRngState } from '../../domain/models/factories'
import {
  V1_NORMAL_ARTIAN_RARITY,
  type BuildListEntry,
  type CalculationContext,
  type NormalArtianCounter,
  type OwnedWeapon,
  type ProductionPlan,
  type ProductionPlanId,
  type RngState,
  type TargetWeapon,
} from '../../domain/models/publicTypes'
import {
  deriveRngCapabilities,
  type RngCapabilityMissingRequirement,
} from '../../domain/rng/capabilities'
import type { RngEngineCapabilities } from '../../domain/rng/rngEngine'
import { evaluateProductionPlanCalculationCompatibility } from '../../services/planner/prepareProductionPlanInteraction'

/**
 * Read-only Dashboard summary (`docs/UI_FLOW.md` 4).
 *
 * Every judgement here is delegated to an existing authority: RNG capabilities
 * to `deriveRngCapabilities`, Build List staleness to
 * `evaluateBuildListEntryStaleness`, and Active Plan compatibility to
 * `evaluateProductionPlanCalculationCompatibility`. Nothing is persisted, and
 * no internal RNG value leaves this module - only statuses and counts do.
 */

/** Everything the Dashboard reads, exactly as Persistence returns it. */
export interface DashboardSnapshot {
  /** `null` when no RngState has been stored yet. */
  rngState: RngState | null
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly BuildListEntry[]
  /** The unique `status = 'active'` Plan, or `null`. Never the latest Plan. */
  activePlan: ProductionPlan | null
}

export interface DashboardSummaryContext {
  master: MasterDataRoot
  engineCapabilities: RngEngineCapabilities
  buildListCalculationContext: CalculationContext
  planCalculationContext: CalculationContext
}

/**
 * The state of one `KnownValue`: 未設定 / 確定 / 要確認.
 *
 * `confirmed` is the same "value present and confirmed" definition
 * `deriveRngCapabilities` uses; a value that is present but not confirmed is
 * never used by search or prediction, so it needs the user's review.
 */
export type KnownValueStatus = 'unset' | 'confirmed' | 'needs_confirmation'

export function getKnownValueStatus(known: {
  value: unknown
  isConfirmed: boolean
}): KnownValueStatus {
  if (known.value === null) return 'unset'
  return known.isConfirmed ? 'confirmed' : 'needs_confirmation'
}

/**
 * Counter Gate is deliberately absent: it is a legacy / diagnostic value and
 * never a Production prediction requirement (`docs/UI_FLOW.md` 5).
 */
export type DashboardRngItemKey = 'baseSeed' | 'gogmaCounter' | 'skillCounter'

export interface DashboardRngItem {
  key: DashboardRngItemKey
  status: KnownValueStatus
}

export interface DashboardCapability {
  available: boolean
  missingRequirements: RngCapabilityMissingRequirement[]
}

export type DashboardNextAction =
  | { kind: 'resume_execution'; planId: ProductionPlanId }
  | { kind: 'review_incompatible_plan'; planId: ProductionPlanId }
  | { kind: 'setup_rng' }
  | { kind: 'register_target' }
  | { kind: 'start_search' }
  /**
   * Every Entry is stale by `evaluateBuildListEntryStaleness`, so none of them
   * is usable until the Target is searched again.
   */
  | { kind: 'search_again_for_stale_build_list' }
  /**
   * The Build List has Entries, not all of them stale. This is deliberately
   * not "a Plan can be created": Planner eligibility is decided per Entry by
   * `validatePlannerInput` and is never re-derived on the Dashboard.
   */
  | { kind: 'review_build_list' }

export interface DashboardSummary {
  rngItems: DashboardRngItem[]
  gogmaPrediction: DashboardCapability
  skillPrediction: DashboardCapability
  normalArtianSearch: DashboardCapability & { hasConfirmedNormalCounter: boolean }
  normalCounters: { confirmed: number; total: number }
  ownedWeapons: { normal: number; gogma: number }
  targetWeapons: { enabled: number; total: number }
  buildList: { total: number; stale: number }
  activePlan: { id: ProductionPlanId; isCalculationCompatible: boolean } | null
  nextAction: DashboardNextAction
}

function selectNextAction(
  summary: Omit<DashboardSummary, 'nextAction'>,
): DashboardNextAction {
  // An Active Plan takes precedence over every preparation step: execution
  // follows the finalized Plan (`docs/UI_FLOW.md` 4 / 16).
  if (summary.activePlan) {
    return summary.activePlan.isCalculationCompatible
      ? { kind: 'resume_execution', planId: summary.activePlan.id }
      : { kind: 'review_incompatible_plan', planId: summary.activePlan.id }
  }
  if (!summary.gogmaPrediction.available && !summary.skillPrediction.available) {
    return { kind: 'setup_rng' }
  }
  if (summary.targetWeapons.enabled === 0) return { kind: 'register_target' }
  if (summary.buildList.total === 0) return { kind: 'start_search' }
  if (summary.buildList.stale === summary.buildList.total) {
    return { kind: 'search_again_for_stale_build_list' }
  }
  return { kind: 'review_build_list' }
}

export function createDashboardSummary(
  snapshot: DashboardSnapshot,
  context: DashboardSummaryContext,
): DashboardSummary {
  // An absent RngState is exactly the initial state `ensureInitialRngState`
  // would store; it is only built in memory so the Dashboard writes nothing.
  const rngState = snapshot.rngState ?? createInitialRngState()
  const { normalCounters } = snapshot
  const { engineCapabilities } = context

  const base = deriveRngCapabilities(rngState, normalCounters, [], engineCapabilities)
  const gogma = deriveRngCapabilities(
    rngState,
    normalCounters,
    [{ type: 'reset_bonuses', sourceOwnedWeaponId: null, gogmaCounterBefore: 0, gogmaCounterAfter: 0 }],
    engineCapabilities,
  )
  const skills = deriveRngCapabilities(
    rngState,
    normalCounters,
    [{ type: 'reset_skills', sourceOwnedWeaponId: null, skillCounterBefore: 0, skillCounterAfter: 0 }],
    engineCapabilities,
  )

  const enabledWeaponTypeIds = new Set(
    getEnabledWeaponTypes(context.master).map(({ id }) => id),
  )
  const confirmedNormalCounters = normalCounters.filter(
    (counter) =>
      enabledWeaponTypeIds.has(counter.weaponTypeId) &&
      counter.rarity === V1_NORMAL_ARTIAN_RARITY &&
      counter.isConfirmed &&
      counter.counter !== null,
  ).length

  const normalArtianMissing: RngCapabilityMissingRequirement[] = []
  if (!base.canSearchNormalArtian) {
    if (getKnownValueStatus(rngState.baseSeed) !== 'confirmed') {
      normalArtianMissing.push('base_seed')
    }
    if (!engineCapabilities.supportsNormalArtianPrediction) {
      normalArtianMissing.push('engine:normal_artian_prediction')
    }
  }

  const targetById = new Map(snapshot.targetWeapons.map((target) => [target.id, target]))
  const staleEntries = snapshot.buildListEntries.filter(
    (entry) =>
      evaluateBuildListEntryStaleness(entry, {
        target: targetById.get(entry.targetWeaponId) ?? null,
        rngState,
        normalCounters,
        ownedWeapons: snapshot.ownedWeapons,
        calculationContext: context.buildListCalculationContext,
      }).isStale,
  ).length

  const summary: Omit<DashboardSummary, 'nextAction'> = {
    rngItems: [
      { key: 'baseSeed', status: getKnownValueStatus(rngState.baseSeed) },
      { key: 'gogmaCounter', status: getKnownValueStatus(rngState.gogmaCounter) },
      { key: 'skillCounter', status: getKnownValueStatus(rngState.skillCounter) },
    ],
    gogmaPrediction: {
      available: base.canPredictGogma,
      missingRequirements: gogma.missingRequirements as RngCapabilityMissingRequirement[],
    },
    skillPrediction: {
      available: base.canPredictSkills,
      missingRequirements: skills.missingRequirements as RngCapabilityMissingRequirement[],
    },
    normalArtianSearch: {
      available: base.canSearchNormalArtian,
      missingRequirements: normalArtianMissing,
      hasConfirmedNormalCounter: confirmedNormalCounters > 0,
    },
    normalCounters: {
      confirmed: confirmedNormalCounters,
      total: enabledWeaponTypeIds.size,
    },
    ownedWeapons: {
      normal: snapshot.ownedWeapons.filter(({ kind }) => kind === 'normal').length,
      gogma: snapshot.ownedWeapons.filter(({ kind }) => kind === 'gogma').length,
    },
    targetWeapons: {
      enabled: snapshot.targetWeapons.filter(({ isEnabled }) => isEnabled).length,
      total: snapshot.targetWeapons.length,
    },
    buildList: { total: snapshot.buildListEntries.length, stale: staleEntries },
    activePlan: snapshot.activePlan
      ? {
          id: snapshot.activePlan.id,
          isCalculationCompatible: evaluateProductionPlanCalculationCompatibility(
            snapshot.activePlan,
            context.planCalculationContext,
          ).isCompatible,
        }
      : null,
  }
  return { ...summary, nextAction: selectNextAction(summary) }
}
