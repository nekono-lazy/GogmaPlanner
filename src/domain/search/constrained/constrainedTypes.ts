import type {
  CalculationContext,
  GroupSkillId,
  IdealDifference,
  MaterialRequirement,
  NormalArtianCounter,
  OwnedWeapon,
  RestorationBonusScope,
  RestorationBonusSet,
  RngState,
  BuildRoute,
  SeriesSkillId,
  TargetWeapon,
  TargetWeaponId,
} from '../../models/publicTypes'
import type { SearchMasterSubset } from '../searchTypes'

/**
 * Planner-driven constrained candidate enumeration types (SEARCH_SPEC 5.6.7,
 * PLANNER_SPEC 9.2.9).
 *
 * This is a separate Search Domain boundary from `searchCandidates()`. It never
 * receives a Planner conflict DTO, never receives the Planner orchestration
 * bounds, and never applies the ordinary Search's UI filters.
 */

/**
 * The only authority for how far constrained enumeration searches.
 *
 * `CandidateSearchSettings` is neither the filter authority nor the extent
 * authority here. The first three bounds keep their SEARCH_SPEC 3.1 meanings;
 * `maxOffAxisPairEvaluations` is new in B8 and caps how many off-axis Cross
 * pairs (`i > 0` and `j > 0`) may be evaluated. Every bound stays caller-
 * supplied, as it was in B8-B1; B8-B2 added
 * `defaultConstrainedEnumerationBounds` below as the value a Production caller
 * passes explicitly, never as a fallback this type applies on its own.
 */
export interface ConstrainedEnumerationBounds {
  /** Maximum `create_normal_artian` forge count, never the maximum offset. */
  maxNormalForgeCount: number
  /** Gogma Counter positions covered, never the Engine call count. */
  maxGogmaAdvance: number
  /** Maximum Reset Skills count. */
  maxSkillResetCount: number
  /** Off-axis Cross pair evaluation cap; `0` disables off-axis evaluation. */
  maxOffAxisPairEvaluations: number
}

/**
 * The Production enumeration bounds, decided by the B8-B2 real Browser Worker
 * benchmark and by nothing else.
 *
 * `docs/B8_CONSTRAINED_ENUMERATION_BROWSER_WORKER_BENCHMARK.md` holds the raw
 * measurements. The tuple was measured as a whole on the combined workload -
 * every currently legal Route base with both streams active and no Ideal
 * nearby - not assembled by adding single-axis numbers together. Every figure
 * below is a direct Worker wall-clock reading, taken in the benchmark's
 * `timing` mode - a minimal recorder that does no parity instrumentation - with
 * nothing subtracted:
 *
 * ```text
 * full bounded enumeration   median 1782.0 ms   (5 measurements)
 * time to first Candidate    median  331.6 ms
 * consumer stop after 50     median  354.6 ms
 * ```
 *
 * The axes are priced very differently in that shape, which is why the tuple is
 * not balanced. The off-axis budget is nearly free, so it is set high, and
 * Gogma - the most expensive axis - was raised from 25 to 30 by spending Normal
 * forge count. Raising Gogma further to 35 also fits, but measured worse on
 * this fixture, which is why it was not taken:
 *
 * ```text
 * 40/30/100/500   1782.0 ms   ~218 ms of headroom   20,306 candidates
 * 30/35/100/500   1899.0 ms   ~101 ms of headroom   20,178 candidates
 * ```
 *
 * The chosen tuple is faster, holds slightly more candidates, and leaves more
 * headroom for session and machine variability. As an auxiliary reason, the
 * Gogma Counter is a shared resource Planner conflicts are fought over while a
 * Normal Counter is per weapon type - but B8-B2 measured no search-quality
 * threshold, so no bound value here is a claim about what is practically
 * sufficient.
 *
 * This is a default, not a capability. Every bound stays caller-supplied: B8-C
 * and B8-D pass this constant explicitly, and `ConstrainedCandidateSearchInput`
 * keeps `bounds` required so no caller can silently inherit it. The three
 * Planner orchestration bounds are deliberately absent - they are decided in
 * B8-E, from a separate benchmark.
 */
export const defaultConstrainedEnumerationBounds: ConstrainedEnumerationBounds = {
  maxNormalForgeCount: 40,
  maxGogmaAdvance: 30,
  maxSkillResetCount: 100,
  maxOffAxisPairEvaluations: 500,
}

/**
 * The Planner-start current validated Search / RNG snapshot.
 *
 * It is deliberately NOT a `CandidateSearchInput`: no `searchRunId`, no
 * `routeFilter`, and no `settings`. A historical UI
 * Candidate Search request is not persisted and must never be required here.
 */
export interface ConstrainedSearchOrigin {
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  /** The validated Target set, which must contain the enumerated Target. */
  targetWeapons: TargetWeapon[]
  master: SearchMasterSubset
  calculationContext: CalculationContext
}

export interface ConstrainedCandidateSearchInput {
  origin: ConstrainedSearchOrigin
  targetWeaponId: TargetWeaponId
  bounds: ConstrainedEnumerationBounds
}

/**
 * One transient Search Domain semantic result.
 *
 * It is not a `BuildCandidate`: `id`, `searchRunId` and `createdAt` are run /
 * persistence metadata that only the B8-C deterministic materializer may add.
 * No random ID, Clock value, or enumeration ordinal is folded into anything
 * here.
 *
 * Like every Search result it is an Ideal result: constrained re-search looks
 * for another way to reach the Target's Ideal under the Planner's fixed
 * Candidates, never for an independent compromise Candidate.
 */
export interface ConstrainedCandidate {
  targetWeaponId: TargetWeaponId
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  route: BuildRoute

  estimatedOperationCount: number
  estimatedGogmaAdvance: number
  estimatedSkillAdvance: number
  estimatedNormalAdvance: number | null
  requiredMaterials: MaterialRequirement[]

  idealDifference: IdealDifference

  searchStateHash: string
  referencedOwnedWeaponsHash: string | null
  calculationContext: CalculationContext
}

export interface ConstrainedEnumerationSummary {
  /**
   * Completed Candidate semantic combinations carried through Target condition
   * evaluation, including combinations that did not satisfy the Ideal
   * condition. One actual `(Bonus solution, Skill solution)` pair counts once.
   */
  examinedCandidates: number
  /**
   * Unique actual off-axis Cross pairs (`i > 0` and `j > 0`) carried into
   * Target evaluation, over the whole Target enumeration.
   *
   * The budget is global: it is never reset per Route base. It counts
   * evaluations, not adopted Candidates, so an off-axis pair that did not
   * satisfy the Ideal condition or duplicated an existing Candidate still
   * consumed one. Axis pairs never consume it.
   */
  evaluatedOffAxisPairs: number
  /**
   * True only when nothing reachable was left uncovered: no bound truncated the
   * enumeration and the consumer did not stop it early. Reaching a bound is
   * never reported as exhaustion.
   *
   * The two flags are not complements: a consumer early stop leaves
   * `exhausted = false` with `stoppedByBound = false`, because the caller, not
   * a bound, ended the enumeration.
   */
  exhausted: boolean
  /**
   * True when at least one `ConstrainedEnumerationBounds` value truncated
   * reachable work, including `maxOffAxisPairEvaluations` refusing a reachable,
   * not-yet-evaluated off-axis cell. Covering exactly every reachable off-axis
   * cell with the last unit of budget is not a truncation.
   */
  stoppedByBound: boolean
}

/** Whether the consumer wants the next Candidate or no further work at all. */
export type ConstrainedCandidateDecision = 'continue' | 'stop'

/**
 * The ordered async visitor of the Production sequential boundary.
 *
 * It is called once per delivered Candidate, before the enumeration continues,
 * so the consumer may run its own async work between Candidates and end the
 * enumeration as soon as it has what it needs. The Search Domain knows nothing
 * about what the consumer does: no Planner conflict DTO, Planner orchestration
 * bound, or Planner type reaches this callback.
 */
export type ConstrainedCandidateVisitor = (
  candidate: ConstrainedCandidate,
) => ConstrainedCandidateDecision | Promise<ConstrainedCandidateDecision>

/**
 * The completion report of one sequential enumeration.
 *
 * `stoppedByConsumer` is execution-level, outside `ConstrainedEnumerationSummary`,
 * because a consumer stop says nothing about the search space: it is a normal
 * outcome, and it is not the `shouldCancel()` cancellation, which rejects with
 * a `CandidateSearchError('cancelled')` instead of returning.
 */
export interface ConstrainedEnumerationExecution {
  targetWeaponId: TargetWeaponId
  summary: ConstrainedEnumerationSummary
  stoppedByConsumer: boolean
}

/**
 * The collector shape, kept as a helper over the sequential boundary.
 *
 * `candidates` is fully materialized before the caller sees anything, so this
 * is not the Production entry point: `visitConstrainedCandidates()` is, and it
 * hands each Candidate over as it is discovered. This collector consumes that
 * visitor to the end and applies the existing final ordering, which need not
 * equal the incremental delivery order. See
 * `docs/CANDIDATE_SEARCH_REDESIGN.md` 4.3.
 */
export interface ConstrainedEnumerationResult {
  targetWeaponId: TargetWeaponId
  /**
   * Every yielded Candidate in the deterministic enumeration order. The order
   * depends only on the input, the Engine, and the bounds.
   */
  candidates: ConstrainedCandidate[]
  summary: ConstrainedEnumerationSummary
}

export type ConstrainedSearchErrorCode =
  | 'invalid_input'
  | 'invalid_candidate'
  | 'calculation_context_incompatible'

export class ConstrainedSearchError extends Error {
  readonly code: ConstrainedSearchErrorCode

  constructor(code: ConstrainedSearchErrorCode, message: string) {
    super(message)
    this.name = 'ConstrainedSearchError'
    this.code = code
  }
}
