/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage C (moved from the Global Assignment Research
 * Phase C-1, Issue #154).
 *
 * Plain-data types of the Counter coverage pre-check, the coverer prediction, the materialization order
 * and the `ExpectedRouteShape` (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.3 / 4.4 / 8.1 - 8.3). Every
 * value is structured-clone data. The names follow the design's proposals; where this file departs
 * from the proposal's spelling (a discriminated `CoverageStream`, a sorted `required` array instead of
 * the `requiredAt` Map, a `kind` on `CoverageSegment`, a Counter ID on the Normal required position) the
 * meaning of design 4.4 is unchanged.
 *
 * A `StructuralCandidate` is a resource assignment that passed the static coverage pre-check, with the
 * predicted Route shapes attached. It is not materialized, not Planner-verified and not a Plan: its
 * objective is never an upper bound and nothing here says a Production Plan exists (design 3.1 / 6.3).
 */
import type { GroupSkillId, OwnedWeaponId, RestorationBonusScope, RestorationBonusSet, SeriesSkillId, TargetWeaponId } from '../../models/publicTypes'
import type { RequiredPositions, ResourceAssignmentCandidate } from './assignmentTypes'
import type { NormalArtianCounterId, ReachOption } from './buildListOptimizationTypes'

/** One Counter stream: the Skill Counter, the Gogma Counter, or one weapon type's rarity-8 Normal Counter. */
export type CoverageStream =
  | { kind: 'skill' }
  | { kind: 'gogma' }
  | { kind: 'normal'; counterId: NormalArtianCounterId }

/** A required Counter position and the one Target that owns it (C2 makes the owner unique). */
export interface CoverageRequiredPosition {
  position: number
  targetWeaponId: TargetWeaponId
}

/**
 * One run of consecutive Counter positions attributed to one Target.
 *
 * Endpoint rule (the one rule every producer and test uses): `from` and `to` are both **inclusive**
 * Counter positions and `from <= to`. The segments of one stream are sorted, the first starts at the
 * stream origin, each next one starts at the previous `to + 1`, and the last ends at `end - 1`; a stream
 * without a required position has `end = origin` and no segment. So the segments partition
 * `origin .. end - 1` exactly once each, with no gap and no overlap.
 *
 * `required`: one required position of `covererTargetWeaponId` (always `from = to`).
 * `chain`: a maximal run of positions between two required positions (or between the origin and the first
 * one), which `covererTargetWeaponId` is predicted to fill with its own skippable units. A chain segment
 * never contains a required position of any Target, so predicting it never duplicates a required unit.
 */
export interface CoverageSegment {
  kind: 'required' | 'chain'
  from: number
  to: number
  covererTargetWeaponId: TargetWeaponId
}

export interface StreamCoverage {
  stream: CoverageStream
  origin: number
  /** The assignment's stream end (last required position + 1, or the origin). */
  end: number
  /** Ascending by position. */
  required: CoverageRequiredPosition[]
  /** `origin .. end - 1` partitioned as described on `CoverageSegment`. */
  segments: CoverageSegment[]
}

/**
 * A gap no Target can fill under the static coverage condition (design 8.1). Only the Skill stream can
 * produce one: a converted weapon does not exist in the Skill stream before its conversion position, so
 * a gap before every reaching conversion needs an existing Gogma's Reset Skills chain.
 *
 * It says this resource assignment fails the static necessary condition. It never says that no
 * executable Plan exists for the PlannerInput.
 */
export interface UncoveredGap {
  stream: CoverageStream
  /** The gap positions, inclusive on both ends (the `CoverageSegment` rule). */
  from: number
  to: number
  /** The lowest uncovered position of the gap (`= from`). */
  firstUncoveredPosition: number
  /** The required position before the gap, or null when the gap starts at the stream origin. */
  previousRequired: CoverageRequiredPosition | null
  nextRequired: CoverageRequiredPosition
  reason: 'no_skill_holder_across_gap'
  /**
   * Diagnostics: the Targets whose Skill chain would reach the gap end but which enter the Skill stream
   * (convert) only after the gap starts (ascending conversion position, then Target ID). Never empty: the
   * owner of `nextRequired` always reaches it.
   */
  reachingTargetsEnteringLater: { targetWeaponId: TargetWeaponId; conversionPosition: number }[]
}

export type CoverageInputIssue =
  /** The value is not a well-formed resource assignment (kind, ordinal, assignment order). */
  | 'invalid_candidate'
  /** The candidate's Targets, the ReachTable's rows or the context's planning Targets differ in membership or order. */
  | 'planning_target_mismatch'
  /** The ReachTable's origins differ from the context's confirmed RNG state. */
  | 'origin_mismatch'
  /** One option contradicts its Target's ReachTable row (source, requirement kind, window, stream end). */
  | 'invalid_option'
  /** Two options share a source (C1) or a required position of one stream (C2). */
  | 'resource_conflict'
  /** The candidate's aggregate fields (sources, required positions, stream ends, objective) differ from its options. */
  | 'aggregate_mismatch'

export interface CoverageInvalidInput {
  kind: 'invalid_input'
  reason: CoverageInputIssue
  detail: string
}

export type StreamCoverageResult =
  | { kind: 'feasible'; coverage: StreamCoverage[] }
  /** `uncovered` in stream order then position order; `firstUncovered = uncovered[0]`. */
  | { kind: 'coverage_infeasible'; uncovered: UncoveredGap[]; firstUncovered: UncoveredGap }
  | CoverageInvalidInput

/** The operation a predicted chain segment consists of (design 8.3). Every unit of it is skippable. */
export type ChainOperation = 'create_normal_artian' | 'reset_bonuses' | 'keep_bonuses' | 'reset_skills'

export interface PredictedChainSegment {
  stream: CoverageStream
  /** Inclusive, the `CoverageSegment` rule. */
  from: number
  to: number
  operation: ChainOperation
}

/** Why a conversion Target is materialized after other Targets (design 8.2). */
export interface MaterializationDependency {
  targetWeaponId: TargetWeaponId
  conversionPosition: number
  /**
   * The Targets every Skill position below the conversion is attributed to (chain coverers and required
   * owners), in their order of first appearance. Each precedes the conversion Target in the order.
   */
  prerequisiteTargetWeaponIds: TargetWeaponId[]
}

export interface MaterializationPlan {
  /** Every planning Target exactly once. */
  order: TargetWeaponId[]
  /** One entry per conversion Target, in the order they were placed. */
  skillDependencies: MaterializationDependency[]
}

/**
 * The Route shape the assignment expects for one Target (design 4.4 / 8.3). A shape
 * condition, never a resource reservation: nothing here is ever written into held / blocked.
 */
export interface ExpectedRouteShape {
  targetWeaponId: TargetWeaponId
  /** The assignment's option for this Target, `verification: 'rng_replayed'`. */
  option: ReachOption
  /** What a materialized Route is matched on (design 8.3): source, required positions, final weapon. */
  match: {
    sourceOwnedWeaponId: OwnedWeaponId | null
    required: RequiredPositions
    finalBonuses: RestorationBonusSet
    restorationBonusScope: RestorationBonusScope
    seriesSkillId: SeriesSkillId | null
    groupSkillId: GroupSkillId | null
  }
  /**
   * The coverage prediction, never a match condition: a materialized Route whose skippable chain differs
   * still matches when its source, required positions and final weapon match.
   */
  predicted: {
    /** The chain segments this Target covers (stream order, then position order). */
    chainSegments: PredictedChainSegment[]
    /**
     * Positions attributed to this Target per stream (its required positions plus its chain positions).
     * Summed over every Target it equals `end - origin` of each stream. The Route operation count of a
     * materialized Route can differ (a Normal forge's held prefix, the actual chain length), which depends
     * on the materialization order and is Phase D's concern.
     */
    ownPositionCount: { skill: number; gogma: number; normal: number }
  }
}

/**
 * A resource assignment that passed the static coverage pre-check, with its materialization order and
 * expected Route shapes (design 4.3 `StructuralCandidate`). Not verified (design 3.1 / 4.6).
 */
export interface StructuralCandidate {
  kind: 'structural_candidate'
  /** The assignment's own `ordinal` (generation index, diagnostics only). */
  ordinal: number
  /** The original resource assignment, unchanged. */
  assignment: ResourceAssignmentCandidate
  /** Skill, Gogma, then every Normal Counter of the table in ID order. */
  coverage: StreamCoverage[]
  materializationOrder: TargetWeaponId[]
  materializationDependencies: MaterializationDependency[]
  /** Planning Target order. */
  expectedShapes: ExpectedRouteShape[]
  /** Engine predictions the required-only replays made (diagnostics). */
  replayPredictions: { skill: number; gogmaReset: number; gogmaKeep: number; normal: number }
}

export type StructuralCandidateResult =
  | { kind: 'structural_candidate'; candidate: StructuralCandidate }
  /** The static coverage condition fails for this resource assignment; no replay ran. */
  | { kind: 'coverage_infeasible'; assignment: ResourceAssignmentCandidate; uncovered: UncoveredGap[]; firstUncovered: UncoveredGap }
  | CoverageInvalidInput
