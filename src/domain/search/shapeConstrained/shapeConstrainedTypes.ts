import type { NormalArtianCounter, OwnedWeaponId, TargetWeaponId } from '../../models/publicTypes'
import type { RngPredictionUnsupportedReason } from '../../rng/rngEngine'
import type { PlannerAlternativeReservation, PlannerAlternativeSearchExtent } from '../alternative/plannerAlternativeTypes'
import type { UnsupportedAmendmentPrediction } from '../bonusStream'
import type { ConstrainedSearchOrigin } from '../constrained/constrainedTypes'

/*
 * The shape-constrained Route search (`docs/SEARCH_SPEC.md` 5.6.9): a Production Search Domain API, exported by
 * `src/domain/search/index.ts`. Its one Production caller is the Build List global optimization
 * (`docs/PLANNER_SPEC.md` 17); the Global Assignment Research (Issue #154) reuses it through its own adapter
 * (`src/domain/search/research/`), which keeps the Research route policy token. Callers that pass no shape - Candidate
 * Search, Planner Alternative Search - are unchanged by it.
 */

/**
 * The version of the seam semantics (`docs/SEARCH_SPEC.md` 5.6.9): the early Route base restriction, the base
 * admission, the lane opening whatever the lane start state is, the Bonus operation kind policy and the final
 * position restriction. A caller folds it into its own search identity; the Search Domain builds no identity of its
 * own. It is the Production token; the Research adapter keeps its own, distinct token so that the Research records
 * keep their meaning.
 */
export const SHAPE_CONSTRAINED_ROUTE_POLICY_VERSION = 'shape-constrained-route-policy:v1'

/** The one Route base of the shape: its kind, its source and, for a conversion base, its conversion Skill position. */
export type ShapeConstrainedRouteBase =
  | { kind: 'owned_gogma'; ownedWeaponId: OwnedWeaponId }
  | { kind: 'owned_normal'; ownedWeaponId: OwnedWeaponId; conversionSkillPosition: number }
  | {
      kind: 'new_normal'
      counterId: NormalArtianCounter['id']
      productionTargetPosition: number
      conversionSkillPosition: number
    }

/**
 * `zero`: the zero-operation Skill (an owned Gogma's current Skills, or the Skills the conversion at `c` assigns).
 * `reset_skills`: the Reset Skills stream, its last Reset Skills at `finalPosition` - opened even when the lane
 * start Skills are already Ideal.
 */
export type ShapeConstrainedSkillLane = { kind: 'zero' } | { kind: 'reset_skills'; finalPosition: number }

/**
 * `zero`: an owned Gogma's current (`gogma_artian`) five slots. Otherwise the Bonus stream restricted to the given
 * operation kinds, its last own Bonus operation at `finalPosition` - opened even when the lane start slots are
 * already Ideal. `reset_then_keep` resets at or before `resetPosition` and keeps only after the Reset at it.
 */
export type ShapeConstrainedBonusLane =
  | { kind: 'zero' }
  | { kind: 'reset'; finalPosition: number }
  | { kind: 'keep'; finalPosition: number }
  | { kind: 'reset_then_keep'; resetPosition: number; finalPosition: number }

export interface RouteShapeConstraint {
  base: ShapeConstrainedRouteBase
  skill: ShapeConstrainedSkillLane
  bonus: ShapeConstrainedBonusLane
}

/**
 * The origin, Target, extent and reservation mean exactly what they mean for Planner Alternative Search and are
 * validated and normalized the same way; the reservation is the formal one and is never edited. The shape is a
 * separate input.
 */
export interface ShapeConstrainedSearchInput {
  origin: ConstrainedSearchOrigin
  targetWeaponId: TargetWeaponId
  extent: PlannerAlternativeSearchExtent
  reservation: PlannerAlternativeReservation
  shape: RouteShapeConstraint
}

/**
 * Why the shape's Route base cannot be reached, found before any Route search primitive runs and before any
 * prediction (only support queries and the conversion position walk). The source / Counter / position reasons are
 * premise violations of the shape; `capability_unavailable` and `prediction_unsupported` are about the Engine and
 * the RNG inputs, and only for operations the shape uses.
 */
export type ShapeBaseUnavailableReason =
  | { kind: 'source_not_found' | 'source_incompatible' | 'source_exclusive' | 'source_protected' | 'source_not_convertible' }
  /** The shape's Counter is not a confirmed rarity-8 Normal Artian Counter of the Target's weapon type. */
  | { kind: 'normal_counter_unavailable' }
  | { kind: 'production_target_blocked' | 'production_target_outside_extent' }
  /** `conversionSkillPositions()`'s formal legal positions do not hold the shape's conversion position. */
  | { kind: 'conversion_position_not_legal'; legalPositions: number[] }
  | {
      kind: 'capability_unavailable'
      capability: 'normal_artian' | 'skill' | 'gogma' | 'keep_bonuses'
      /** An unconfirmed RNG input the operation needs, or an Engine capability flag. */
      cause: 'rng_input_unconfirmed' | 'engine_capability_unavailable'
    }
  | {
      kind: 'prediction_unsupported'
      prediction: 'normal_artian' | 'skill' | 'gogma_reset' | 'gogma_keep'
      reason: RngPredictionUnsupportedReason
    }

/**
 * The completion report of one shape-constrained search.
 *
 * `base.unavailable` is the first base diagnosis reason, in which case no Route search primitive ran and the
 * summary is all zero / false. Otherwise the base was admitted: a diagnosis that passed while no base got
 * registered is a seam contract violation and rejects instead. As for Planner Alternative Search, a consumer stop
 * sets neither `exhausted` nor `stoppedByExtent`, and cancellation rejects with `CandidateSearchError('cancelled')`.
 * The shape's Bonus lane ends at its own final position without an extent stop; the Skill stream has no natural
 * end, so `stoppedByExtent` may still be set by it.
 */
export interface ShapeConstrainedSearchExecution {
  targetWeaponId: TargetWeaponId
  summary: { deliveredCandidates: number; exhausted: boolean; stoppedByExtent: boolean }
  stoppedByConsumer: boolean
  base: { admitted: boolean; unavailable: ShapeBaseUnavailableReason | null }
  /** Unsupported predictions of the Bonus operations the shape uses, as the admitted base's Bonus stream reported them. */
  requiredUnsupportedPredictions: UnsupportedAmendmentPrediction[]
  /**
   * Unsupported notices of an operation the shape forbids. The shape-constrained stream never evaluates the support
   * of a forbidden operation, so this is always 0 by contract; it is reported, never used to classify anything.
   */
  forbiddenOperationNotices: number
}

export type ShapeConstrainedSearchErrorCode =
  | 'invalid_input'
  | 'invalid_reservation'
  | 'invalid_shape'
  | 'calculation_context_incompatible'
  /**
   * The seam broke its own contract: the base diagnosis passed but no Route base was registered, a registered base
   * differs from the shape, a second base was offered, or a delivered Candidate does not end at the shape's final
   * positions. Never a statement about whether the shape exists.
   */
  | 'shape_search_contract_violation'

export class ShapeConstrainedSearchError extends Error {
  readonly code: ShapeConstrainedSearchErrorCode

  constructor(code: ShapeConstrainedSearchErrorCode, message: string) {
    super(message)
    this.name = 'ShapeConstrainedSearchError'
    this.code = code
  }
}
