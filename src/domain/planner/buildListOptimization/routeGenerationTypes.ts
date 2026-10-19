/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.12 / 17.13), Stage D (moved from the Global Assignment
 * Research Phases D-0A / D-0A-2b, Issue #154).
 *
 * Plain-data types of the route generation of one structural candidate: for each planning Target, in the candidate's
 * materialization order, a Route whose required positions, source and final weapon match the Target's expected Route shape is
 * generated through the Production Search APIs - the projected Candidate Search for a continuous shape, otherwise (and when that
 * one does not match) the shape-constrained Route search (`docs/SEARCH_SPEC.md` 5.6.9), whose delivery is accepted only after the
 * independent Route checks. This is the method rule the Research accepted at D-1C; the Research keeps its own name for it and
 * its other rule (Planner Alternative Search), which Production does not carry.
 *
 * Nothing here is a Plan, a Planner verification or a persisted value. A generated Entry is a runtime-only Entry of the
 * optimization's Preview: only Stage D' (the ordinary Planner over the replaced Build List) decides whether it is used, and only
 * an explicit adoption persists it.
 */
import type { BuildListEntry, BuildListEntryId, OwnedWeaponId, RouteKind, TargetWeaponId } from '../../models/publicTypes'
import type { PlannerAlternativeReservation, PlannerAlternativeSearchExtent } from '../../search/alternative'
import type { UnsupportedAmendmentPrediction } from '../../search/bonusStream'
import type { CandidateRouteFilter, CandidateSearchSettings } from '../../search/searchTypes'
import type {
  RouteShapeConstraint, ShapeBaseUnavailableReason, ShapeConstrainedRouteBase, ShapeConstrainedSearchExecution,
} from '../../search/shapeConstrained'
import type { PlannerClock } from '../plannerTypes'
import type { RequiredPositions } from './assignmentTypes'
import type { InclusiveRange, LayoutKey, NormalArtianCounterId } from './buildListOptimizationTypes'
import type { ExpectedRouteShape } from './coverageTypes'
import type { PredictionCallCounts } from './countingRngEngine'

/** The two route generation methods of one Target. */
export type RouteGenerationMethod = 'candidate_search_projected' | 'shape_constrained'

// ------------------------------------------------------------------------------------------------ identity

/**
 * The deterministic identities a caller folds into the Searches and the Candidates it generates (`docs/PLANNER_SPEC.md` 17.12):
 * the algorithm and route policy tokens, the identity / Candidate ID prefixes and the Clock of the display-only `createdAt`.
 * No random value, request ID, Clock value or enumeration ordinal enters an identity. The Build List global optimization passes
 * `BUILD_LIST_OPTIMIZATION_ROUTE_IDENTITY` plus its Production Clock; the Global Assignment Research passes its own tokens,
 * which keep its records' meaning.
 */
export interface RouteGenerationIdentityTokens {
  /** The algorithm token of the projected Candidate Search's run identity and of the Planner-start origin rebuild identity. */
  projectedAlgorithm: string
  /** The algorithm token of the shape-constrained search identity. */
  shapeAlgorithm: string
  /** The shape-constrained route policy version folded into the shape-constrained search identity. */
  routePolicy: string
  /** The prefix of one projected Candidate Search's `searchRunId`. */
  projectedSearchRunIdPrefix: string
  /** The prefix of the identity (also `searchRunId`) a projected Candidate is rebuilt under at the Planner-start origin. */
  originSearchIdentityPrefix: string
  /** The `BuildCandidate.id` prefix of a projected Candidate rebuilt at the Planner-start origin. */
  originCandidateIdPrefix: string
  /** The prefix of the shape-constrained search identity (also its Candidates' `searchRunId`). */
  shapeSearchIdentityPrefix: string
  /** The `BuildCandidate.id` prefix of a shape-constrained Candidate. */
  shapeCandidateIdPrefix: string
}

export interface RouteGenerationIdentity extends RouteGenerationIdentityTokens {
  /** The Clock of the display-only `createdAt` of the Candidates and Entries (never an identity input). */
  clock: PlannerClock
}

// ------------------------------------------------------------------------------------------------ the projected Candidate Search

/**
 * The Search scale of one projected Candidate Search, computed from its extent before it runs, with the very Production primitives
 * the Search walks with. The gate's input only, never a formal Search work unit.
 */
export interface PredictedSearchScale {
  /** Legal conversion Skill positions (`nextOperationPositions()` from the Skill origin); 0 for an owned Gogma. */
  conversionPositions: number
  /** Non-blocked positions of the Gogma extent window. */
  gogmaLegalWidth: number
  /** Non-blocked positions of the Skill extent window (a conversion Route's window is one position longer). */
  skillLegalWidth: number
  /** Own forges of the canonical held-prefix Normal creation up to the production target; 0 for an owned source. */
  normalForgeCount: number
}

/** The caller's explicit upper bound per scale component (non-negative safe integers; no default anywhere). */
export interface SearchScaleGate {
  maxConversionPositions: number
  maxGogmaLegalWidth: number
  maxSkillLegalWidth: number
  maxNormalForgeCount: number
}

/** The windows and positions one scale prediction counted (diagnostics). */
export interface SearchScaleDetail {
  origins: { skill: number; gogma: number; normal: { counterId: NormalArtianCounterId; position: number } | null }
  /** The legal conversion Skill positions in ascending order (empty for an owned Gogma). */
  conversionSkillPositions: number[]
  /** `nextOperationPositions().beyondLimit` of the conversion walk: a legal position still lay at or beyond the extent. */
  conversionBeyondExtent: boolean
  /** Inclusive Skill window of the extent (`origin .. origin + M - 1`, a conversion `origin .. origin + M`). */
  skillWindow: InclusiveRange
  /** Inclusive Gogma window of the extent. */
  gogmaWindow: InclusiveRange
  /** The canonical held-prefix creation (PLANNER_SPEC 9.2.19.4) of a new Normal source, otherwise null. */
  normalCreation: { normalCounterBefore: number; normalCounterAfter: number; count: number } | null
}

/** The projected start of each stream and the restricted inventory of a projected Candidate Search. */
export interface ProjectedSearchOrigin {
  /** The first own Skill position of the shape, or the Planner-start Skill Counter when the shape has none. */
  skillCounter: number
  /** The first own Gogma position of the shape, or the Planner-start Gogma Counter when the shape has none. */
  gogmaCounter: number
  /** A new Normal source's Counter and its first own forge position; null for an owned source (Counters unchanged). */
  normal: { counterId: NormalArtianCounterId; counter: number } | null
  /** The source's Route family: `existing_gogma` for an owned Gogma, `normal_artian` for a Normal source. */
  routeFilter: Extract<CandidateRouteFilter, 'existing_gogma' | 'normal_artian'>
  /** The restricted inventory: the source weapon alone, or none for a new Normal. */
  ownedWeaponIds: OwnedWeaponId[]
  /**
   * The Target's own preference when it names the source weapon, otherwise null: the restricted inventory holds no other
   * weapon, and the Production validation refuses a preference outside it. Never set to a weapon the Target does not already
   * prefer.
   */
  preferredOwnedWeaponId: OwnedWeaponId | null
}

/** One ordinary Candidate Search from the projected start of a continuous shape. */
export interface ProjectedRouteRequest {
  method: 'candidate_search_projected'
  targetWeaponId: TargetWeaponId
  shape: ExpectedRouteShape
  reservation: null
  projection: ProjectedSearchOrigin
  /** The minimal extent from the projected start (the shape's last required positions, counted from the projected origins). */
  extent: CandidateSearchSettings
  /** The projected Search's deterministic `searchRunId` (the projected Candidate is rebuilt at the origin afterwards). */
  searchRunId: string
  predictedSearchScale: PredictedSearchScale
  scaleDetail: SearchScaleDetail
}

// ------------------------------------------------------------------------------------------------ the shape match

/** Why one generated Entry does not have the expected Route shape. */
export type ShapeMismatchReason =
  | 'target'
  /** `createPlannerRouteUnitPlans()` rejected the Route, so no required position exists to compare. */
  | 'unit_plan_rejected'
  | 'source'
  /** A required unit without a Counter position (a blind creation); no expected shape has one. */
  | 'unpositioned_required_unit'
  | 'skill_required'
  | 'gogma_required'
  | 'normal_required'
  | 'final_bonuses'
  | 'restoration_bonus_scope'
  | 'series_skill'
  | 'group_skill'

export interface ShapeMismatch {
  /** 1-based delivery index of the Candidate (always 1 for a projected canonical Ideal). */
  deliveredIndex: number
  reasons: ShapeMismatchReason[]
  /** The Route's required positions per stream, or null when no unit plan exists. */
  plannerRequired: RequiredPositions | null
  sourceOwnedWeaponId: OwnedWeaponId | null
}

export type ShapeMatchResult =
  | { matches: true; plannerRequired: RequiredPositions }
  | { matches: false; reasons: ShapeMismatchReason[]; plannerRequired: RequiredPositions | null }

// ------------------------------------------------------------------------------------------------ continuation shapes

/**
 * The lane-start Ideal Skill continuation of a conversion: a `conversion (c, s*)` with `c < s*` whose conversion Skill at `c` is
 * already Ideal for the Target. The ordinary Production Search attaches no Reset Skills channel to a Route base whose lane-start
 * Skill is Ideal (SEARCH_SPEC 5.6.1 / 5.6.8), so only the shape-constrained Route search can deliver it. The Route is legal in the
 * game and representable in the Domain.
 */
export interface ConversionSkillContinuationShape {
  policy: 'lane_start_ideal_skill_continuation'
  stream: 'skill'
  /** `c`: the conversion position, whose conversion Skill is already Ideal. */
  conversionPosition: number
  /** `s*`: the last Reset Skills position of the shape (`c < s*`). */
  finalPosition: number
}

/** The amendment an owned Gogma's current-Ideal `gogma_artian` Bonus lane continues with. */
export interface OwnedGogmaBonusContinuation {
  requirement: 'reset' | 'keep_from_source' | 'reset_then_keep'
  /** `g1` of a `reset_then_keep`, otherwise null. */
  resetPosition: number | null
  /** `g*`: the last Bonus operation. */
  finalPosition: number
}

/**
 * An owned Gogma whose current state - the lane start of its Route base - is already Ideal on a lane, and whose option still
 * operates that lane (a `reset_skills` on current Ideal Skills and / or an amendment on current Ideal `gogma_artian` bonuses). Only
 * an option set that continues current-Ideal lanes lists it, and the ordinary Production Search opens no channel on an Ideal lane
 * start, so only the shape-constrained Route search delivers it. Each continued lane is recorded on its own (the other one is null).
 */
export interface OwnedGogmaContinuationShape {
  policy: 'lane_start_ideal_owned_gogma_continuation'
  ownedWeaponId: OwnedWeaponId
  /** The last Reset Skills position when the current Skills are Ideal and the option resets them, otherwise null. */
  skill: { finalPosition: number } | null
  /** The amendment when the current Bonuses are Ideal and the option amends them, otherwise null. */
  bonus: OwnedGogmaBonusContinuation | null
}

/** A shape whose lane continues past an already Ideal lane start: generated by the shape-constrained method alone. */
export type RouteContinuationShape = ConversionSkillContinuationShape | OwnedGogmaContinuationShape

// ------------------------------------------------------------------------------------------------ the shape-constrained Route search

/**
 * The scale of one shape-constrained Search, computed before the Search from positions alone (no prediction, no Search). Upper
 * bounds and counts of the work the early constraints leave, never a measurement and never a formal Search work unit. The pre-base
 * part and the stream part are kept apart.
 */
export interface ShapeSearchScale {
  /** What still runs before the Route base exists. */
  preBase: {
    /** The one Route search primitive the shape-constrained Search starts. */
    primitive: ShapeConstrainedRouteBase['kind']
    /** Positions the formal `conversionSkillPositions()` walk inspects (a conversion base only; no prediction). */
    conversionWalkPositions: number
    /** The predictions before the base: the new Normal at `p` and the conversion Skill at `c`. */
    requiredPredictions: { normalArtian: 0 | 1; skill: 0 | 1 }
    /** The base registration work item (an owned Gogma registers synchronously: 0). */
    baseWorkItems: 0 | 1
    /** The prediction supports the lanes use (the only ones the Search asks). */
    supportQueries: ('normal_artian' | 'skill' | 'gogma_reset' | 'gogma_keep')[]
  }
  /** Own forges of the canonical held-prefix Normal creation up to `p`; 0 for an owned source. */
  normalForgeCount: number
  /** Whether `c` is one of the formal legal conversion positions (always true for an owned Gogma). */
  conversionLegal: boolean
  /** The formal legal conversion positions of the walk (empty for an owned Gogma). */
  conversionLegalPositions: number[]
  skill: ShapeStreamScale
  gogma: ShapeStreamScale & {
    policy: RouteShapeConstraint['bonus']['kind']
    /** Non-blocked positions of the window: the shape policy keeps one family layout per position. */
    frontierUpperBound: number
    /** `depthUpperBound × non-blocked positions × (maxHeldRun + 2)`: Resets one per position, Keeps one per frontier state and window position. */
    generatedStateUpperBound: number
  }
  /** The depth a stream can be read to before the first matching composition: the sum of both lanes' `minOwnOperations`. */
  depthUpperBound: number
}

export interface ShapeStreamScale {
  /** The lane's own-operation window (inclusive), or null for a zero lane. */
  window: InclusiveRange | null
  /** Non-held positions of the window plus the held required positions of the window. */
  minOwnOperations: number
  /** Non-blocked positions of the window. */
  maxOwnOperations: number
  /** The longest run of held positions inside the window. */
  maxHeldRun: number
}

/** The caller's explicit upper bound per component (non-negative safe integers; no default anywhere). */
export interface ShapeSearchScaleGate {
  maxDepthUpperBound: number
  maxGogmaGeneratedStateUpperBound: number
  maxNormalForgeCount: number
  maxConversionWalkPositions: number
}

export type ShapeSearchScaleComponent = 'depthUpperBound' | 'gogmaGeneratedStateUpperBound' | 'normalForgeCount' | 'conversionWalkPositions'

/** The caller's explicit runtime budget of one Search (non-negative safe integers; reaching it stops the Search). */
export interface ShapeSearchBudget {
  maxGogmaGeneratedStates: number
  maxSkillStates: number
  /** Settled work items (the base registration work included). */
  maxSettledWork: number
  /** Production RNG prediction calls of the Search itself, per kind (the independent Route checks are not counted). */
  maxPredictions: { normalArtian: number; skill: number; gogmaReset: number; gogmaKeep: number }
}

export type ShapeSearchBudgetComponent =
  | 'gogmaGeneratedStates' | 'skillStates' | 'settledWork' | 'normalArtianPredictions' | 'skillPredictions' | 'gogmaResetPredictions' | 'gogmaKeepPredictions'

/** The caller's gates and budget of one route generation run (every value explicit; no default anywhere). */
export interface RouteGenerationSettings {
  /** The gate of the projected Candidate Search. */
  projectedSearchScaleGate: SearchScaleGate
  shapeSearchScaleGate: ShapeSearchScaleGate
  shapeSearchBudget: ShapeSearchBudget
}

/**
 * A position premise of the minimal Route the shape-constrained Search must deliver, found before the Search from positions and
 * the PlannerInput alone. Any one of them is a fail-closed `shape_base_unavailable`: a structural candidate or an earlier
 * generated Route broke a premise, never "no Route".
 */
export type MinimalRoutePremiseViolation =
  | { kind: 'source_not_found' | 'source_exclusive' | 'source_protected'; ownedWeaponId: string }
  | { kind: 'conversion_position_not_legal'; position: number; legalPositions: number[] }
  | { kind: 'normal_counter_origin_missing'; counterId: NormalArtianCounterId }
  | { kind: 'production_target_blocked' | 'production_target_outside_extent'; counterId: NormalArtianCounterId; position: number }
  | { kind: 'required_position_blocked'; stream: 'skill' | 'gogma'; position: number }
  | { kind: 'required_position_outside_extent'; stream: 'skill' | 'gogma'; position: number; window: InclusiveRange }

/** One shape-constrained request, fully re-derivable from the shape and the Entries generated before it. */
export interface ShapeConstrainedRouteRequest {
  method: 'shape_constrained'
  targetWeaponId: TargetWeaponId
  shape: ExpectedRouteShape
  /** The shape as the shape-constrained Search reads it, converted from `shape.option` alone. */
  routeShape: RouteShapeConstraint
  /** `emptyPlannerAlternativeReservation` with no earlier Entry, otherwise `derivePlannerAlternativeReservation()` of them. Never edited. */
  reservation: PlannerAlternativeReservation
  reservationSourceEntryIds: BuildListEntryId[]
  /** The Planner-start origins of the shape's streams. */
  origins: { skill: number; gogma: number; normal: { counterId: NormalArtianCounterId; position: number } | null }
  /** The extent from the Planner-start origins to the shape's last required positions. */
  extent: PlannerAlternativeSearchExtent
  /** Deterministic: from the tokens, the route policy, the Target, the origin, the context, the extent, the reservation and the shape. */
  searchIdentity: string
  predictedScale: ShapeSearchScale
  /** The violated position premises (empty when they all hold). */
  premiseViolations: MinimalRoutePremiseViolation[]
}

/** One prediction-support question in the reach-table sense: per weapon type / element, Keep per family layout. */
export type SupportQuestion =
  | { prediction: 'normal_artian' | 'skill' | 'gogma_reset'; weaponTypeId: string; elementId: string }
  | { prediction: 'gogma_keep'; weaponTypeId: string; elementId: string; layout: LayoutKey }

/** Whether the ReachTable (Stage A) answered the same question, and how. */
export type ReachTableSupportJudgement = 'supported' | 'unsupported' | 'not_judged'

export interface SupportQuestionRecord {
  question: SupportQuestion
  /** The ReachTable's (Stage A) judgement of the same question. */
  phaseA: ReachTableSupportJudgement
}

/** Why a needed prediction or capability was not available (the ReachTable did not judge it as supported). */
export interface ShapeUnsupportedDetail {
  /** `base_diagnosis`: the Search's base diagnosis; `bonus_stream`: the admitted base's Bonus stream reported it. */
  origin: 'base_diagnosis' | 'bonus_stream'
  unavailable: ShapeBaseUnavailableReason | null
  predictions: UnsupportedAmendmentPrediction[]
  /** The ReachTable question of each unsupported prediction (absent for an Engine capability flag, which the ReachTable never reads). */
  questions: SupportQuestionRecord[]
}

/**
 * What decided a stop of the Search. A `budget` / `cancel` stop is recorded when `shouldCancel` first answered true, never re-read
 * from the counters afterwards (a cancel that coincides with the budget is a cancel, the budget recorded beside it). A `consumer`
 * (the accepted delivery) / `search_end` stop records the usage at the end: a component may be over its limit when the Search
 * delivered before its next checkpoint read the budget - the generated Route still stands, and the excess is shown, never hidden.
 */
export interface ShapeSearchStop {
  by: 'consumer' | 'search_end' | 'budget' | 'cancel'
  budgetExceeded: ShapeSearchBudgetComponent[]
}

/** The execution-only counters of one Planner Alternative frontier (shared by the shape-constrained Search). */
export interface RouteSearchInstrumentation {
  workSettled: number
  skillStreams: number
  skillDepths: number
  skillStates: number
  maxSkillStatesPerDepth: number
  skillTransitions: number
  gogmaStreams: number
  gogmaDepths: number
  gogmaGeneratedStates: number
  maxGogmaFrontierStates: number
}

/** What one executed shape-constrained Search reported and used (execution-only observation, never an identity). */
export interface ShapeSearchObserved {
  /** Candidates the Search delivered (0, or 1: the first delivery is accepted or fails closed). */
  deliveredCandidates: number
  /** Null when the Search was stopped by the budget or a cancel (it rejected, so it reported no summary). */
  execution: Omit<ShapeConstrainedSearchExecution, 'targetWeaponId'> | null
  instrumentation: RouteSearchInstrumentation
  /** Prediction calls of the Search itself (the independent Route checks are counted apart). */
  searchPredictions: PredictionCallCounts
  stop: ShapeSearchStop
}

export type RouteCheckIssueCode =
  | 'reservation_mismatch'
  | 'candidate_invalid'
  | 'entry_invalid'
  | 'target_mismatch'
  | 'route_kind_mismatch'
  | 'source_mismatch'
  | 'operation_sequence'
  | 'counter_discontinuity'
  | 'counter_advance_mismatch'
  | 'conversion_position_mismatch'
  | 'production_target_mismatch'
  | 'normal_creation_not_canonical'
  | 'coverage_gap'
  | 'blocked_position'
  | 'exclusive_source'
  | 'protected_source'
  | 'prediction_unavailable'
  | 'trace_mismatch'
  | 'keep_input_layout_mismatch'
  | 'final_state_mismatch'
  | 'not_ideal'
  | 'hash_mismatch'
  | 'calculation_context_mismatch'
  | 'estimate_mismatch'
  | 'unit_plan_rejected'
  | 'required_positions_mismatch'

export interface RouteCheckIssue {
  code: RouteCheckIssueCode
  /** The Route operation the issue is about, or null for a whole-Route check. */
  operationIndex: number | null
  detail: string
}

/**
 * The independent Route checks of one shape-constrained Entry. `passed` says only that every check held; it is never "verified":
 * the ordinary Planner and its Trace Replay (Stage D') are the authority.
 */
export interface RouteCheckReport {
  passed: boolean
  issues: RouteCheckIssue[]
  checkedOperations: number
  /** The re-predictions of the checks alone (never added to the Search's counts or budget). */
  predictions: PredictionCallCounts
}

/** A generated Route of one Target: the Entry passed `validateBuildListEntry()` and matched its shape. */
export interface GeneratedRoute {
  kind: 'materialized'
  method: RouteGenerationMethod
  entry: BuildListEntry
  /** The Route's required positions, re-derived from the Entry by the Planner's unit plans. */
  plannerRequired: RequiredPositions
  /** Candidates delivered before the matching one (always 0 for both methods). */
  deliveredBeforeMatch: number
}

/** How one shape-constrained attempt ended (fail-closed ends throw instead). */
export type ShapeConstrainedOutcome =
  | { kind: 'materialized'; method: 'shape_constrained'; entry: BuildListEntry; plannerRequired: RequiredPositions; deliveredBeforeMatch: 0 }
  /**
   * The runtime budget stopped the Search: the shape was not reached, never "absent". A delivery is always accepted or fails
   * closed, so a budget stop delivered nothing (`delivered: 0`, no mismatch to report).
   */
  | { kind: 'unconfirmed'; reason: 'shape_search_budget_reached'; budgetExceeded: ShapeSearchBudgetComponent[]; delivered: 0; closestMismatch: null }
  /** The predicted scale exceeded the gate; no Search API was called. */
  | { kind: 'not_executed'; reason: 'search_scale_gate'; method: 'shape_constrained'; predicted: ShapeSearchScale; exceeded: ShapeSearchScaleComponent[] }
  /** A needed prediction or capability is not available and the ReachTable did not judge the same question supported. */
  | { kind: 'unsupported'; reason: 'required_prediction_unsupported' | 'capability_unavailable'; detail: ShapeUnsupportedDetail }
  | { kind: 'unmeasured'; reason: 'cancelled' }

export interface ShapeConstrainedAttempt {
  method: 'shape_constrained'
  request: ShapeConstrainedRouteRequest
  outcome: ShapeConstrainedOutcome
  /** Null when the Search did not run (gate). */
  observed: ShapeSearchObserved | null
  /** The independent Route checks of the delivered Candidate, null when nothing was delivered. */
  routeChecks: RouteCheckReport | null
}

/**
 * One projected Candidate Search. It never decides the Target outcome on its own: a non-match is this method's limit, not evidence
 * about the shape, so the shape-constrained method runs next.
 */
export type ProjectedAttemptResult =
  | { kind: 'matched'; outcome: GeneratedRoute }
  /** The canonical Ideal from the projected start is a different shape. */
  | { kind: 'canonical_mismatch'; mismatch: ShapeMismatch }
  /** No canonical Ideal inside the projected extent. */
  | { kind: 'no_candidate' }
  | { kind: 'not_executed'; reason: 'search_scale_gate'; predictedSearchScale: PredictedSearchScale; exceeded: (keyof PredictedSearchScale)[] }
  | { kind: 'unmeasured'; reason: 'cancelled' }

export interface ProjectedAttempt {
  method: 'candidate_search_projected'
  request: ProjectedRouteRequest
  result: ProjectedAttemptResult
  /** Null when the Search did not run (gate) or did not finish (cancel). */
  observed: { searchedRoutes: RouteKind[]; skippedRoutes: { route: RouteKind; reason: string }[]; candidateFound: boolean } | null
}

export type RouteGenerationAttempt = ProjectedAttempt | ShapeConstrainedAttempt

/** The deterministic rule that ordered the methods of one Target. */
export type RouteGenerationMethodRule =
  /** A continuation shape: `shape_constrained` only. */
  | 'continuation_shape_constrained_only'
  /** Continuous: the projected Candidate Search first, then `shape_constrained` once when it does not match. */
  | 'continuous_projected_then_shape_constrained'
  /** Non-continuous: `shape_constrained` only. */
  | 'non_continuous_shape_constrained_only'

/** The deterministic method order of one Target, from the ReachTable and the shape alone. */
export interface RouteGenerationMethodSelection {
  continuous: boolean
  continuation: RouteContinuationShape | null
  predictedSearchScale: { shapeConstrained: ShapeSearchScale; projected: PredictedSearchScale | null }
  rule: RouteGenerationMethodRule
  order: RouteGenerationMethod[]
}

/** One Candidate a Search returned to the route generation and its match verdict (diagnostics). */
export interface RouteGenerationInspection {
  targetWeaponId: TargetWeaponId
  method: RouteGenerationMethod
  /** Always 1: the projected canonical Ideal, or the first shape-constrained delivery. */
  deliveredIndex: number
  match: ShapeMatchResult
}

/**
 * How one Target's route generation ended. Only `materialized` produced a Route; every other value is "not confirmed", "not
 * executed", "not supported" or "not measured" and never evidence that no such Route exists.
 */
export type RouteGenerationOutcome = GeneratedRoute | Exclude<ShapeConstrainedOutcome, { kind: 'materialized' }>

/** One Target's route generation: the method selection, every attempt in execution order, and the Target outcome. */
export interface TargetRouteGenerationRecord {
  targetWeaponId: TargetWeaponId
  /** 0-based position in the structural candidate's materialization order. */
  orderIndex: number
  /** Null when no request was built (the run was cancelled before this Target). */
  selection: RouteGenerationMethodSelection | null
  attempts: RouteGenerationAttempt[]
  outcome: RouteGenerationOutcome
}

/** The route generation stage of one structural candidate. */
export type RouteGenerationStageOutcome =
  /** Every planning Target has a generated Route. Not verified: Stage D' has not run. */
  | { kind: 'all_generated' }
  /** The first unresolved Target was not confirmed, not executed or not measured: never "no Route". */
  | { kind: 'generation_unconfirmed'; targetWeaponId: TargetWeaponId; outcome: Extract<RouteGenerationOutcome, { kind: 'unconfirmed' | 'not_executed' | 'unmeasured' }> }
  /** The first unresolved Target needs a prediction or capability the Engine does not offer (never "no Route"). */
  | { kind: 'generation_unsupported'; targetWeaponId: TargetWeaponId; outcome: Extract<RouteGenerationOutcome, { kind: 'unsupported' }> }

export interface StructuralCandidateRouteGeneration {
  /** The structural candidate's ordinal (diagnostics only, never an identity). */
  candidateOrdinal: number
  objective: number
  materializationOrder: TargetWeaponId[]
  /** One record per attempted Target, in materialization order, up to and including the first unresolved one. */
  targets: TargetRouteGenerationRecord[]
  /** The generated Entries in materialization order: the only reservation source of every later Target. */
  generatedEntries: BuildListEntry[]
  outcome: RouteGenerationStageOutcome
  /** Targets after the first unresolved one, never attempted (not "failed"). */
  notAttemptedTargetWeaponIds: TargetWeaponId[]
}

// ------------------------------------------------------------------------------------------------ fail closed

export type BuildListOptimizationMaterializationErrorCode =
  /** A gate or budget value is invalid (a lower-level API called without the run's settings check). */
  | 'invalid_settings'
  /** The shape's own positions are not a valid partition (an internal inconsistency of the shape). */
  | 'invalid_shape'
  /** `derivePlannerAlternativeReservation()` refused the generated Entries. */
  | 'reservation_derivation_failed'
  /** The Production Search rejected a derived input (not a cancellation). */
  | 'search_refused'
  /** The deterministic materializer or the projected origin rebuild refused (ID collision, invalid Candidate, projection). */
  | 'entry_materialization_refused'
  /** The generated Entry no longer matched after its probe matched, or the shape-constrained delivery did not match its shape. */
  | 'match_inconsistent'
  /** A position / source / Counter premise of the minimal Route is broken (the pre-Search premise check or the Search's base diagnosis). */
  | 'shape_base_unavailable'
  /** The ReachTable judged the same support question supported, the Search answers unsupported. */
  | 'prediction_support_inconsistent'
  /** The base was admitted, no needed prediction was unsupported, and the Search ended without delivering: a premise broke. */
  | 'shape_constrained_unreachable'
  /** The shape-constrained Search broke its own contract (or ended without exhausted / stoppedByExtent / a consumer stop). */
  | 'shape_search_contract_violation'
  /** The independent Route checks of the delivered Entry failed. */
  | 'route_verification_failed'

/**
 * A fail-closed stop of the route generation: never classified as an outcome, never read as "no Route", never `unsupported` /
 * `not_found` / `search_bound_reached`. `detail` is optional plain data (the broken premise, the contradicting support question,
 * the failed Route checks). The class is generic in its code so that the Global Assignment Research reuses the one constructor
 * with its own additional codes.
 */
export class BuildListOptimizationMaterializationError<TCode extends string = BuildListOptimizationMaterializationErrorCode> extends Error {
  readonly code: TCode
  readonly targetWeaponId: TargetWeaponId | null
  readonly detail: unknown

  constructor(code: TCode, targetWeaponId: TargetWeaponId | null, message: string, detail?: unknown) {
    super(message)
    this.name = 'BuildListOptimizationMaterializationError'
    this.code = code
    this.targetWeaponId = targetWeaponId
    this.detail = detail
  }
}
