/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B / C (moved from the Global Assignment Research
 * Phase C-2, Issue #154).
 *
 * Plain-data types of the coverage-gated assignment search (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md`
 * 4.6 / 6.3 / 6.4 / 8.1 / 10.3 / 12): the Phase B-1 resource assignment search with the Phase C-1 static
 * coverage pre-check applied at every complete assignment, the design 6.3 coverage-driven value ordering
 * as an explicit opt-in, and the design 4.6 classification of the outcome.
 *
 * A coverage-feasible assignment, and the `StructuralCandidate` built from it, is a necessary-condition
 * result: neither is materialized, Planner-verified or a Plan, and no objective here is ever an upper
 * bound. No status here says `verified` or "no feasible Plan exists".
 */
import type { TargetWeaponId } from '../../models/publicTypes'
import type {
  CreateResourceAssignmentSearchResult, ExpandedNodeInfo, PriorityOrderingDiagnostics, ResourceAssignmentCandidate, ResourceAssignmentSearchCompleteness,
  ResourceAssignmentSearchDiagnostics, VerifiedUpperBound,
} from './assignmentTypes'
import type { CoverageInputIssue, StreamCoverage, StructuralCandidate, UncoveredGap } from './coverageTypes'
import type { ReachTable, ReachWindow } from './buildListOptimizationTypes'

export interface CoverageSearchRequest {
  /** Expanded node limit of the underlying resource assignment search (positive integer). */
  nodeBudget: number
  /** MRV lookahead of the underlying search (positive integer). */
  mrvLookahead: number
  /**
   * Explicit choice, no default (design 6.3): `true` makes every node try first, after each coverage
   * rejection, the not-yet-delivered options converting at the lowest uncovered Skill position `x`;
   * `false` keeps the Phase B-1 value order. Both deliver every option exactly once, so an exhausted
   * search yields the same set of coverage-feasible assignments either way; only their order differs.
   */
  coverageDrivenOrdering: boolean
  /** The only branch-and-bound upper bound (a Production-verified Plan); never a coverage-feasible assignment's objective. */
  readVerifiedUpperBound?: () => VerifiedUpperBound | null
  shouldCancel?: () => boolean
  onNodeExpanded?: (node: ExpandedNodeInfo) => void
  /** Diagnostics observer, called once per complete resource assignment in generation order. */
  onAssignmentInspected?: (inspection: AssignmentCoverageInspection) => void
}

/** One complete resource assignment and its coverage verdict. */
export interface AssignmentCoverageInspection {
  /** The resource assignment's generation index (`ResourceAssignmentCandidate.ordinal`). */
  ordinal: number
  objective: number
  verdict: 'coverage_feasible' | 'coverage_infeasible'
  /** The lowest uncovered gap of a rejection (always a Skill gap); null when feasible. */
  firstUncovered: UncoveredGap | null
  /** The priority conversion position in force while this assignment was generated (null: none yet, or the ordering is disabled). */
  priorityConversionPosition: number | null
  assignment: ResourceAssignmentCandidate
}

/** A complete resource assignment that passed the static coverage pre-check (design 8.1), with its coverage. Not verified. */
export interface CoverageFeasibleAssignment {
  kind: 'coverage_feasible_assignment'
  assignment: ResourceAssignmentCandidate
  /** The pre-check's per-stream partition (Skill, Gogma, then every Normal Counter in ID order). */
  coverage: StreamCoverage[]
}

export interface CoverageDrivenOrderingDiagnostics extends PriorityOrderingDiagnostics {
  /** The conversion position the nodes currently prioritize (the lowest uncovered Skill position of the latest rejection). */
  currentPriorityConversionPosition: number | null
  /** How many rejections changed that position. */
  priorityChanges: number
}

export interface CoverageSearchDiagnostics {
  /**
   * The underlying Phase B-1 diagnostics. Its `candidates` counts every complete resource assignment
   * generated and its `bestAssignment` ranges over all of them, coverage-rejected ones included; it is
   * not the best coverage-feasible objective.
   */
  resource: ResourceAssignmentSearchDiagnostics
  /** Complete resource assignments whose coverage was checked (`= resource.candidates`). */
  completeAssignmentsInspected: number
  coverageRejections: number
  coverageFeasible: number
  /** The smallest objective among the coverage-feasible assignments (diagnostics only: never an upper bound, never verified). */
  bestCoverageFeasible: { ordinal: number; objective: number } | null
  /** The first rejection and its lowest uncovered gap (a representative uncovered position). */
  firstRejection: { ordinal: number; objective: number; firstUncovered: UncoveredGap } | null
  /** The lowest `firstUncoveredPosition` over every rejection so far. */
  lowestUncoveredPosition: number | null
  /** Rejections per lowest uncovered Skill position, ascending position. */
  rejectionsByFirstUncoveredPosition: { position: number; count: number }[]
  /** Complete resource assignments generated up to and including the first coverage-feasible one; null while none was found. */
  assignmentsUntilFirstCoverageFeasible: number | null
  coverageDrivenOrdering: CoverageDrivenOrderingDiagnostics
  completeness: 'running' | ResourceAssignmentSearchCompleteness
}

export type CoverageSearchEvent<TCandidate> =
  | { kind: 'candidate'; candidate: TCandidate }
  /** `next(maxNodes)` expanded `maxNodes` nodes without reaching a coverage-feasible assignment or an end; the search resumes where it stopped. */
  | { kind: 'paused'; nodesThisCall: number }
  | { kind: 'finished'; completeness: ResourceAssignmentSearchCompleteness }

/**
 * The resumable coverage-gated generator. Each `next()` continues the same depth-first tree; a
 * coverage-rejected complete assignment is recorded and passed over without returning, so every
 * delivered candidate passed the pre-check and every complete assignment is inspected at most once.
 */
export interface CoverageSearch<TCandidate, TDiagnostics extends CoverageSearchDiagnostics = CoverageSearchDiagnostics> {
  next(maxNodes?: number): CoverageSearchEvent<TCandidate>
  readonly diagnostics: TDiagnostics
  readonly targetsWithoutOption: readonly TargetWeaponId[]
}

export type CreateCoverageSearchResult<TCandidate, TDiagnostics extends CoverageSearchDiagnostics = CoverageSearchDiagnostics> =
  | { kind: 'search'; search: CoverageSearch<TCandidate, TDiagnostics> }
  | { kind: 'invalid_input'; reason: Extract<CreateResourceAssignmentSearchResult, { kind: 'invalid_input' }>['reason'] | CoverageInputIssue; detail: string }

/**
 * Why an exhausted search delivered nothing (design 4.6 / 10.3):
 * - `target_without_option`: a planning Target has no reach option in the window
 * - `resource_exclusivity`: every Target has options, but C1 / C2 leave no complete resource assignment
 * - `coverage_infeasible`: complete resource assignments exist and every one of them fails the static
 *   Counter coverage pre-check
 * - `upper_bound_pruning`: a caller-supplied Production-verified upper bound cut part of the tree, so the
 *   statements above do not hold for the cut part (never produced without one)
 * None of them says a feasible Plan does not exist: only this window and these constraints held none.
 */
export type NoStructuralCandidateReason = 'target_without_option' | 'resource_exclusivity' | 'coverage_infeasible' | 'upper_bound_pruning'

/**
 * The typed outcome of collecting from one coverage-gated search. `no_structural_candidate` is returned
 * only for an exhausted tree; a node budget or a cancel is `search_incomplete` and concludes nothing about
 * the window, and a candidate limit stop is `candidate_limit_reached` (the rest of the tree unconfirmed).
 */
export type CoverageSearchResult<TCandidate, TDiagnostics extends CoverageSearchDiagnostics = CoverageSearchDiagnostics> =
  | { status: 'candidates_found'; completeness: 'exhausted' | 'candidate_limit_reached'; candidates: TCandidate[]
      diagnostics: TDiagnostics; window: ReachWindow; scanned: ReachTable['scanned'] }
  | { status: 'no_structural_candidate'; completeness: 'exhausted'; reason: NoStructuralCandidateReason; targetsWithoutOption: TargetWeaponId[]
      diagnostics: TDiagnostics; window: ReachWindow; scanned: ReachTable['scanned'] }
  | { status: 'search_incomplete'; completeness: 'node_budget_reached' | 'cancelled'; candidates: TCandidate[]
      diagnostics: TDiagnostics; window: ReachWindow; scanned: ReachTable['scanned'] }
  | { status: 'invalid_input'; reason: Extract<CreateCoverageSearchResult<TCandidate, TDiagnostics>, { kind: 'invalid_input' }>['reason'] | 'invalid_candidate_limit'; detail: string }

/** The structural layer's diagnostics: the coverage-gated search plus what building the structural candidates added. */
export interface StructuralSearchDiagnostics extends CoverageSearchDiagnostics {
  /** Structural candidates built (one per coverage-feasible assignment). */
  structuralCandidates: number
  /** The smallest objective among the structural candidates (diagnostics only: never an upper bound, never verified; distinct from `resource.bestAssignment`). */
  bestStructural: { ordinal: number; objective: number } | null
  /** Engine predictions the required-only replays of the built candidates made. */
  replayPredictions: StructuralCandidate['replayPredictions']
}

export type StructuralSearchResult = CoverageSearchResult<StructuralCandidate, StructuralSearchDiagnostics>
