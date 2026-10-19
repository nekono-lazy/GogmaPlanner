import type {
  CandidateBonusAmendmentStep,
  CandidateConversionSkillStep,
  CandidateSkillAmendmentStep,
  NormalArtianCounter,
  OwnedWeaponId,
  TargetWeaponId,
} from '../../models/publicTypes'
import type {
  ConstrainedCandidate,
  ConstrainedSearchOrigin,
} from '../constrained/constrainedTypes'

/**
 * Planner Alternative Search types (`docs/SEARCH_SPEC.md` 5.6.8,
 * `docs/PLANNER_SPEC.md` 9.2.19).
 *
 * A separate Search Domain consumer policy from `searchCandidates()` and from
 * the constrained enumerator of 5.6.7. It never receives a Planner conflict
 * DTO, a `PlannerConflictResolution`, a Planner trial bound, or any Planner
 * shareability / inventory / source-version judgement.
 *
 * Status: complete over the extent (later same-result Counter positions, lazy
 * off-axis Cross pairs, every Normal offset without the #104 reduction,
 * exhausted versus stopped by extent) under a resource reservation: held /
 * blocked positions per Counter stream and exclusive OwnedWeapons (Phase 2).
 */

/**
 * The Counter position window of one Planner Alternative Search
 * (`docs/PLANNER_SPEC.md` 9.2.19.12).
 *
 * The three values carry the SEARCH_SPEC 3.1 meanings of the Candidate Search
 * settings of the same names, but this type and its values are Planner
 * Alternative Search's own authority: they are never read from
 * `CandidateSearchSettings`, `AppSettings.candidateSearchDefaults`,
 * `recommendedCandidateSearchDefaults` or `defaultConstrainedEnumerationBounds`.
 * Every value is caller-supplied: the Domain never substitutes, clamps or
 * completes one. `defaultPlannerAlternativeSearchExtent` is the value a
 * Production caller passes explicitly (Phase 3-C).
 */
export interface PlannerAlternativeSearchExtent {
  /**
   * Production target positions `origin .. origin + N - 1` of the Planner-start
   * Normal Counter, held positions included; with no held position that is
   * the ordinary maximum forge count.
   */
  maxNormalAdvance: number
  /** Gogma Counter positions `origin .. origin + N - 1` covered, never the Engine call count. */
  maxGogmaAdvance: number
  /**
   * The Skill position window, held positions included: an existing Gogma's
   * Reset Skills at `origin .. origin + M - 1`, a conversion Route's conversion
   * and Reset Skills at `origin .. origin + M`. With no held position that is
   * the ordinary maximum Reset Skills count.
   */
  maxSkillAdvance: number
}

/**
 * The Production default extent, decided in Phase 3-C from the Phase 3-B real
 * Browser Worker measurements (`docs/SEARCH_SPEC.md` 5.6.8,
 * `docs/PLANNER_ALTERNATIVE_BROWSER_WORKER_BENCHMARK.md` 12 / 13).
 *
 * - Normal 4: a fixed Route's production target can hold and block the Normal
 *   origin, so an extent of 1 cannot move the losing Target's own production
 *   target to a later position. 4 is the smallest measured value above 1
 *   (Issue #101: about 2.8 s / 1.2 GB) and stays far from the measured
 *   16 (about 11 s / 4 GB) and 40 (V8 out of memory). It is a design choice
 *   for short held / blocked chains, not a guarantee for an arbitrarily long one.
 * - Gogma 235: the measured Issue #101 threshold (220 finds no Candidate; 235
 *   finds the Fire Alternative; 240 / 300 / 350 add no known semantic benefit).
 * - Skill 4: the Skill window is `origin .. origin + M - 1` for an existing
 *   Gogma's Reset Skills and `origin .. origin + M` for a conversion Route, so
 *   even M = 1 lets a conversion move to origin + 1 (Issue #101 converts at 342
 *   past a held and blocked 341). M = 1 is still too narrow for an existing
 *   Gogma's Reset Skills past a blocked origin, and for a conversion Route
 *   crossing a held / blocked chain beyond origin + 1. 4 is small headroom for
 *   short chains; no semantic benefit of a larger value was observed.
 *
 * Callers explicitly pass it (for example as a spread copy); it is never an
 * implicit Domain fallback, a field-completion target or a clamp.
 */
export const defaultPlannerAlternativeSearchExtent: PlannerAlternativeSearchExtent = {
  maxNormalAdvance: 4,
  maxGogmaAdvance: 235,
  maxSkillAdvance: 4,
}

/** The held and blocked positions of one Counter stream (`blocked ⊆ held`). */
export interface PlannerAlternativeStreamReservation {
  held: readonly number[]
  blocked: readonly number[]
}

export interface PlannerAlternativeNormalReservation
  extends PlannerAlternativeStreamReservation {
  counterId: NormalArtianCounter['id']
}

/**
 * The fixed Route set's resource reservation, as the Planner derived it
 * (`docs/PLANNER_SPEC.md` 9.2.19.3). The Search Domain only consumes it and
 * never re-derives required / skippable or shareability.
 *
 * It is a set: array order and duplicates carry no meaning, and the search
 * reads its `normalizePlannerAlternativeReservation()` form. An empty
 * reservation means "no fixed Route".
 */
export interface PlannerAlternativeReservation {
  normal: readonly PlannerAlternativeNormalReservation[]
  skill: PlannerAlternativeStreamReservation
  gogma: PlannerAlternativeStreamReservation
  exclusiveOwnedWeaponIds: readonly OwnedWeaponId[]
}

export const emptyPlannerAlternativeReservation: PlannerAlternativeReservation = {
  normal: [],
  skill: { held: [], blocked: [] },
  gogma: { held: [], blocked: [] },
  exclusiveOwnedWeaponIds: [],
}

export interface PlannerAlternativeSearchInput {
  /** The Planner-start current validated snapshot (same meaning as 5.6.7). */
  origin: ConstrainedSearchOrigin
  targetWeaponId: TargetWeaponId
  extent: PlannerAlternativeSearchExtent
  reservation: PlannerAlternativeReservation
  /** `candidateStableKey()` values of Routes that must not be returned. */
  excludedRouteKeys: readonly string[]
}

/**
 * One transient Planner Alternative Search result.
 *
 * The same semantic result as `ConstrainedCandidate` - no `BuildCandidate.id`,
 * `searchRunId`, `createdAt`, random ID, Clock value or enumeration ordinal -
 * plus the ordinary Candidate Search observational traces
 * (`docs/SEARCH_SPEC.md` 5.5.3.1 / 5.5.2.1 / 5.5.2.2). The traces record
 * predictions the streams already made; they add no prediction call and take
 * no part in identity, hashes, ordering or classification.
 *
 * `conversionSkillTrace` is present exactly when the Route has its one
 * `convert_normal_to_gogma`, as on a Search-generated `BuildCandidate`.
 * Intermediate state groups are not part of it: the deterministic materializer
 * derives them (`docs/PLANNER_SPEC.md` 9.2.13).
 */
export interface PlannerAlternativeCandidate extends ConstrainedCandidate {
  bonusAmendmentTrace: CandidateBonusAmendmentStep[]
  skillAmendmentTrace: CandidateSkillAmendmentStep[]
  conversionSkillTrace?: CandidateConversionSkillStep
}

/** Whether the consumer wants the next Candidate or no further work at all. */
export type PlannerAlternativeCandidateDecision = 'continue' | 'stop'

/**
 * Called once per delivered Candidate, before the search continues. The Search
 * Domain never learns why the consumer stopped.
 */
export type PlannerAlternativeCandidateVisitor = (
  candidate: PlannerAlternativeCandidate,
) => PlannerAlternativeCandidateDecision | Promise<PlannerAlternativeCandidateDecision>

export interface PlannerAlternativeSearchSummary {
  /** Candidates handed to the visitor. */
  deliveredCandidates: number
  /**
   * Ideal Candidates skipped because their `candidateStableKey` is in
   * `excludedRouteKeys`. Exclusion happens after the Candidate is built, by its
   * semantic Route identity; it prunes no search work.
   */
  excludedCandidates: number
  /**
   * The search ended because no reachable work was left at all, inside or
   * beyond the extent, for the current input, capability and Route scope.
   *
   * `exhausted` and `stoppedByExtent` are never both true, and a consumer stop
   * leaves both false: the caller, not the search space, ended the search
   * (the 5.6.7 `exhausted` / `stoppedByBound` principle).
   */
  exhausted: boolean
  /**
   * The frontier ran out inside the extent while an extent value (Normal forge
   * count, Gogma positions, Reset Skills count) left reachable work unread.
   */
  stoppedByExtent: boolean
}

/**
 * The completion report of one sequential search.
 *
 * `stoppedByConsumer` is execution-level, outside the summary, as in 5.6.7:
 * it is a normal outcome that says nothing about the search space, and it is
 * not cancellation, which rejects with `CandidateSearchError('cancelled')`
 * instead. When it is false, exactly one of `summary.exhausted` and
 * `summary.stoppedByExtent` is true.
 */
export interface PlannerAlternativeSearchExecution {
  targetWeaponId: TargetWeaponId
  summary: PlannerAlternativeSearchSummary
  stoppedByConsumer: boolean
  /**
   * The `candidateStableKey`s of the Candidates this search actually reached
   * and skipped because they are in `excludedRouteKeys`, in skip order and each
   * once (its length is `summary.excludedCandidates`). A key of
   * `excludedRouteKeys` the search never reached is absent. Neutral execution
   * data: the Search Domain gives no key a meaning of its own, and a caller
   * that tells its exclusions apart (the Planner's repair lineage,
   * `docs/PLANNER_SPEC.md` 9.2.19.13) does so on its side.
   */
  skippedExcludedRouteKeys: string[]
}

export type PlannerAlternativeSearchErrorCode =
  | 'invalid_input'
  | 'calculation_context_incompatible'
  /** A reservation that is not a valid semantic set (positions, `blocked ⊆ held`, Counter IDs). */
  | 'invalid_reservation'

export class PlannerAlternativeSearchError extends Error {
  readonly code: PlannerAlternativeSearchErrorCode

  constructor(code: PlannerAlternativeSearchErrorCode, message: string) {
    super(message)
    this.name = 'PlannerAlternativeSearchError'
    this.code = code
  }
}
