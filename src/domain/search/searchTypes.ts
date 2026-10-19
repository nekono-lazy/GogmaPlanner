import type {
  BuildCandidate,
  CalculationContext,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  RngState,
  RouteKind,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { recommendedCandidateSearchDefaults } from '../models/common'
import type {
  ArtianBonusTypeMapping,
  BonusTypeMaster,
  BonusRankMaster,
  ElementMaster,
  MaterialCostMaster,
  WeaponBonusDefinition,
  WeaponTypeMaster,
} from '../master/masterTypes'

export type CandidateRouteFilter = 'all' | 'normal_artian' | 'existing_gogma'

/**
 * The three stream extents of one Candidate Search.
 *
 * There is no result filter, no output cap, and no similarity threshold: a
 * Search produces at most one canonical Ideal Candidate, so nothing needs to
 * bound a retained Practical set or rank results by closeness
 * (`docs/SEARCH_SPEC.md` 4.2).
 */
export interface CandidateSearchSettings {
  maxNormalAdvance: number
  maxGogmaAdvance: number
  maxSkillAdvance: number
}

/**
 * The recommended initial bounds (`docs/SEARCH_SPEC.md` 3.1), taken from the
 * one authority `recommendedCandidateSearchDefaults` (Issue #125). The Search
 * screen starts from the user's saved AppSettings defaults instead; this value
 * is only the recommendation those defaults start from. Candidate Search itself
 * never reads AppSettings or any default: it runs the `CandidateSearchSettings`
 * its caller passes. These are defaults, not caps; the Search UI can raise
 * every bound.
 */
export const defaultCandidateSearchSettings: CandidateSearchSettings = {
  ...recommendedCandidateSearchDefaults,
}

/**
 * The Master a Candidate Search reads. It carries no `LotteryMaster`: the
 * Production RNG never reads one, so a disabled Lottery Master can neither skip
 * a Route nor make a Search unavailable (`docs/SEARCH_SPEC.md` 4.1).
 *
 * `materialCosts` only prices the Route's item materials. With no usable enabled
 * cost, `requiredMaterials` stays empty and means "unknown", never "zero", and
 * the material tie-breaks compare nothing.
 */
export interface SearchMasterSubset {
  weaponBonusDefinitions: WeaponBonusDefinition[]
  weaponTypes: WeaponTypeMaster[]
  elements: ElementMaster[]
  bonusTypes: BonusTypeMaster[]
  bonusRanks: BonusRankMaster[]
  /** Keep family resolution authority for Normal-side bonus types (`docs/RNG_SPEC.md` 6.1). */
  artianBonusTypeMappings: ArtianBonusTypeMapping[]
  materialCosts: MaterialCostMaster[]
}

/**
 * One Candidate Search request, for exactly one TargetWeapon.
 *
 * Multi-Target search was removed with the canonical Ideal Route model: the
 * Search decides one Target's Ideal Route and the checkpoints on it, while
 * reconciling several Targets is the Production Planner's job
 * (`docs/SEARCH_SPEC.md` 4.1).
 */
export interface CandidateSearchInput {
  searchRunId: string
  targetWeaponId: TargetWeaponId
  routeFilter: CandidateRouteFilter
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
  settings: CandidateSearchSettings
  master: SearchMasterSubset
  calculationContext: CalculationContext
  /**
   * The owned weapons this request never uses as a Route source
   * (`docs/SEARCH_SPEC.md` 3.3). Absent and `[]` mean the same thing: nothing
   * is excluded and the Search behaves exactly as before. The order carries no
   * meaning. Each ID is non-empty, unique, and names a weapon of `ownedWeapons`;
   * anything else fails closed as `invalid_input`.
   *
   * The Search knows only this set, never why a weapon is in it or whether the
   * screen's exclusion option was on. Only the ordinary Candidate Search reads
   * it: constrained enumeration, Planner Alternative Search, the
   * shape-constrained Route search and the Build List optimization's Stage D
   * never set it. It is runtime request data only and enters no Candidate
   * identity, hash or persisted record.
   */
  excludedSourceOwnedWeaponIds?: OwnedWeaponId[]
}

export type SkippedRouteReason =
  | 'normal_counter_unconfirmed'
  | 'no_owned_weapon_available'
  | 'no_unprotected_source_weapon'
  | 'gogma_capability_missing'
  | 'skill_capability_missing'
  | 'keep_prediction_unsupported'
  | 'master_data_unavailable'
  | 'rng_state_unconfirmed'
  | 'normal_prediction_unsupported'
  | 'skill_prediction_unsupported'
  | 'gogma_prediction_unsupported'
  | 'calculation_context_incompatible'
  | 'disabled_by_filter'
  /**
   * `docs/SEARCH_SPEC.md` 3.3: the RouteKind had at least one owned source
   * under the existing source rules, and the request's source exclusion removed
   * every one of them. A RouteKind that had no source even without the
   * exclusion keeps its ordinary reason.
   */
  | 'source_excluded_for_other_targets'

export interface SkippedRoute {
  route: RouteKind
  reason: SkippedRouteReason
  detail: string
}

/**
 * How a Candidate Search notice should be presented.
 *
 * `info` is a search that succeeded under a narrower method than usual, which
 * is neither an error nor a degraded result. `warning` is a genuine capability
 * gap or an exclusion the user should weigh when reading the result.
 */
export type CandidateSearchNoticeSeverity = 'info' | 'warning'

export interface CandidateSearchWarning {
  targetWeaponId: TargetWeaponId | null
  severity: CandidateSearchNoticeSeverity
  message: string
}

/**
 * The searched Target's result: at most one canonical Ideal Candidate.
 *
 * `candidate === null` means no Ideal was found inside the configured search
 * extent. It never means an Ideal does not exist, and compromise states found
 * on the way are deliberately not returned: only an intermediate state on a
 * lane of an actual Ideal Route can be offered (`docs/SEARCH_SPEC.md` 5.7).
 */
export interface TargetCandidateSearchResult {
  targetWeaponId: TargetWeaponId
  candidate: BuildCandidate | null
  searchedRoutes: RouteKind[]
  skippedRoutes: SkippedRoute[]
  /**
   * `docs/SEARCH_SPEC.md` 3.3: the owned weapons this search did not register
   * as a Route base because the request excluded them, in code unit order with
   * no duplicate. Only a weapon the searched RouteKinds of `routeFilter` would
   * have taken as a source under the existing source rules is listed (weapon
   * type and element, rarity 8 and unprotected for an owned Normal's
   * conversion, any compatible owned Gogma); an excluded weapon that could
   * never have been a source here is not. Empty when nothing was excluded.
   *
   * Runtime observation only: never part of a BuildCandidate, a Candidate
   * identity, a hash or any persisted record.
   */
  excludedSourceOwnedWeaponIds: OwnedWeaponId[]
}

export interface CandidateSearchResult {
  searchRunId: string
  calculationContext: CalculationContext
  targetResult: TargetCandidateSearchResult
  warnings: CandidateSearchWarning[]
  elapsedMs: number
}

/**
 * `preparing` is emitted when the search starts, `searching` while the
 * scheduler settles work, and `finalizing` once the Target is done.
 */
export type CandidateSearchProgressPhase = 'preparing' | 'searching' | 'finalizing'

export interface CandidateSearchProgress {
  targetWeaponId: TargetWeaponId
  phase: CandidateSearchProgressPhase
  /**
   * Scheduler work items settled so far. Total work is discovered while
   * searching, so this is an activity signal only and must never be presented
   * as a completion percent.
   */
  processedWorkItems: number
}

export type SearchWorkerRequest =
  | { type: 'candidate_search'; requestId: string; input: CandidateSearchInput }
  | { type: 'cancel'; requestId: string }

export type SearchWorkerResponse =
  | {
      type: 'candidate_search_result'
      requestId: string
      result: CandidateSearchResult
    }
  | ({ type: 'progress'; requestId: string } & CandidateSearchProgress)
  | { type: 'error'; requestId: string; message: string }

export type CandidateSearchErrorCode =
  | 'invalid_input'
  | 'invalid_candidate'
  | 'calculation_context_incompatible'
  | 'cancelled'

export class CandidateSearchError extends Error {
  readonly code: CandidateSearchErrorCode

  constructor(code: CandidateSearchErrorCode, message: string) {
    super(message)
    this.name = 'CandidateSearchError'
    this.code = code
  }
}
