/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B (moved from the Global Assignment Research
 * Phase B-1, Issue #154).
 *
 * Plain-data types of the resource assignment solver (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.3 /
 * 6.1 / 6.3 / 6.4 / 10.1 / 12, Phase B-1 of 14). Everything is structured-clone data (Map / Set with a
 * deterministic insertion order, no class instance, no function) except the request callbacks.
 *
 * Phase B-1 stops at the **resource assignment**: one ReachOption per planning Target satisfying C1
 * (source exclusivity) and C2 (required Counter position exclusivity). It is neither the design's
 * `StructuralCandidate` (Phase C adds the Counter coverage pre-check, the materialization order and the
 * `ExpectedRouteShape`s) nor a `VerifiedPlanRecord` (Phase D'); its `objective` is the physical
 * operation count the assignment would need if every option came true, never a Production result.
 */
import type { TargetWeapon, TargetWeaponId } from '../../models/publicTypes'
import type { NormalArtianCounterId, ReachOption, ReachTable, ReachWindow, StreamEnd } from './buildListOptimizationTypes'

/** The one resource condition an option violated against a partial assignment (design 6.1 C1 / C2). */
export type ResourceViolationKind = 'source' | 'skill_position' | 'gogma_position' | 'normal_position'

/**
 * The required Counter positions one option occupies (design 6.1 C2). Skill: `reset_skills` its final
 * position; `conversion` its conversion and final positions, one position when they coincide (the
 * conversion Skill is Ideal), never a double consumption. Gogma: `reset` / `keep_from_source` the final
 * position; `reset_then_keep` the Reset and the final position. Normal: the production-target forge of a
 * `new_normal` source. Skippable chain units are not required positions and never appear here.
 */
export interface RequiredPositions {
  skill: number[]
  gogma: number[]
  normal: { counterId: NormalArtianCounterId; position: number } | null
}

/** A partial assignment: the chosen options (assignment order) and the resources they occupy. */
export interface PartialResourceAssignment {
  chosen: Map<TargetWeaponId, ReachOption>
  /** `sourceResourceKey()` of every chosen option's source. */
  usedSources: Set<string>
  usedSkillPositions: Set<number>
  usedGogmaPositions: Set<number>
  /** One position set per Normal Counter of the table (every Counter present, possibly empty). */
  usedNormalPositions: Map<NormalArtianCounterId, Set<number>>
  /** Per stream the maximum `streamEnd` of the chosen options; a stream nobody advanced stays at its origin. */
  streamEnd: StreamEnd
}

/**
 * A complete assignment satisfying C1 / C2 (design 4.3 `Assignment`, Phase B-1 output). `ordinal` is the
 * deterministic generation index (0-based) of one search; it is diagnostics, never an identity.
 */
export interface ResourceAssignmentCandidate {
  kind: 'resource_assignment'
  ordinal: number
  /** Planning Target order (the ReachTable's `targets` order). */
  chosen: Map<TargetWeaponId, ReachOption>
  /** The order in which the search assigned the Targets (the MRV order of that branch). */
  assignmentOrder: TargetWeaponId[]
  /** Sorted `sourceResourceKey()`s. */
  usedSources: string[]
  /** Sorted required positions per stream; Normal per Counter ID (every Counter of the table, possibly empty). */
  requiredPositions: { skill: number[]; gogma: number[]; normal: Record<NormalArtianCounterId, number[]> }
  streamEnd: StreamEnd
  /** Σ_streams (streamEnd − origin) over the Skill stream, the Gogma stream and every Normal Counter of the table (design 6.1). */
  objective: number
}

/**
 * The only branch-and-bound upper bound (design 6.3 / 10.1): the physical operation count of a
 * Production-verified Plan (`bestVerified.physicalOperations`, Phase D'). Phase B-1 produces no such
 * value and a caller may never derive one from a resource assignment's objective or from
 * `bestAssignment`; the literal provenance exists so that no other number can be passed by accident.
 * The §10.2 applicability (no cross satisfaction pair among the planning Targets) is the caller's
 * responsibility when it supplies one.
 */
export interface VerifiedUpperBound {
  physicalOperations: number
  provenance: 'production_verified_plan'
}

export interface ExpandedNodeInfo {
  /** The node count after this expansion (1-based). */
  nodes: number
  depth: number
  /** The MRV-selected Target of this node, or null for a complete assignment (a leaf). */
  selectedTarget: TargetWeaponId | null
  /** The selected Target's resource-feasible option count, saturated at `mrvLookahead`; null for a leaf. */
  feasibleOptionsUpToLookahead: number | null
}

export interface ResourceAssignmentSearchRequest {
  /** Expanded node limit (design 10.4 node budget; positive integer). Reaching it is `node_budget_reached`, never "no assignment". */
  nodeBudget: number
  /**
   * `countUpTo(k)` lookahead for the MRV option count (design 6.4; positive integer). It bounds only how
   * far the count looks for the Target selection order; every option stays enumerable.
   */
  mrvLookahead: number
  /** Read before every child expansion; `null` (the Phase B-1 default) means no pruning at all. */
  readVerifiedUpperBound?: () => VerifiedUpperBound | null
  /** The cancel seam, checked once per node. */
  shouldCancel?: () => boolean
  /** Diagnostics observer, called once per expanded node in expansion order. */
  onNodeExpanded?: (node: ExpandedNodeInfo) => void
  /**
   * Phase C-2 opt-in (design 6.3 coverage-driven value ordering). When present, every node reads it before
   * each value it delivers, and a non-null conversion position `x` makes the not-yet-delivered options of
   * that node's Target converting at `x` come first. It reorders values only: every option is still
   * delivered exactly once, so the set of complete assignments of an exhausted tree is unchanged. Absent
   * (the Phase B-1 / B-2 default), the value order is exactly the Phase B-1 one.
   */
  readPriorityConversionPosition?: () => number | null
}

/** The coverage-driven value ordering counters of one search (Phase C-2; all 0 when it is not enabled). */
export interface PriorityOrderingDiagnostics {
  enabled: boolean
  phaseActivations: number
  priorityDeliveries: number
  prioritySkips: number
  baseSkips: number
}

export type ResourceAssignmentSearchCompleteness = 'exhausted' | 'node_budget_reached' | 'cancelled'

export interface ResourceAssignmentSearchDiagnostics {
  expandedNodes: number
  maxDepth: number
  /** Complete assignments generated so far. */
  candidates: number
  /**
   * What the resource conditions excluded: `source` counts used sources skipped whole (a used source's
   * whole option family fails C1 at once), the three position kinds count options (C2). Counted where a
   * node walks its selected Target's value order, and at a dead end, whose MRV count walked every option
   * of the stranded Target; the MRV lookahead of the other Targets counts nothing.
   */
  rejections: Record<ResourceViolationKind, number>
  /** Child nodes cut by `LB(child) >= UB`; always 0 without a `VerifiedUpperBound`. */
  pruned: number
  /** Nodes whose MRV Target had no resource-feasible option under the partial assignment. */
  deadEnds: number
  /** Dead ends per Target ID. */
  deadEndsByTarget: Record<TargetWeaponId, number>
  /** The generated assignment with the smallest objective (diagnostics only; never an upper bound). */
  bestAssignment: { ordinal: number; objective: number } | null
  completeness: 'running' | ResourceAssignmentSearchCompleteness
}

export type ResourceAssignmentSearchEvent =
  | { kind: 'candidate'; candidate: ResourceAssignmentCandidate }
  /** `next(maxNodes)` expanded `maxNodes` nodes without reaching a candidate or an end; the search resumes where it stopped. */
  | { kind: 'paused'; nodesThisCall: number }
  | { kind: 'finished'; completeness: ResourceAssignmentSearchCompleteness }

/**
 * The resumable generator (design 6.3 / 6.4 `structuralCandidates`, without the Phase C coverage
 * check). Every call to `next()` continues the same depth-first tree from the value after the one that
 * produced the previous event, so each complete assignment is generated at most once and the candidate
 * sequence of one input is the same whether or not the caller paused between candidates.
 */
export interface ResourceAssignmentSearch {
  next(maxNodes?: number): ResourceAssignmentSearchEvent
  readonly diagnostics: ResourceAssignmentSearchDiagnostics
  /** Kept apart from `diagnostics` so the Phase B-1 / B-2 diagnostics record is unchanged. */
  readonly priorityOrdering: PriorityOrderingDiagnostics
  /** Planning Targets with no reach option at all in the table's window (never "unreachable"). */
  readonly targetsWithoutOption: readonly TargetWeaponId[]
}

/** The planning Target facts the solver reads (`BuildListOptimizationContext.planningTargets` satisfies it). */
export type PlanningTargetPriority = Pick<TargetWeapon, 'id' | 'priority'>

export type CreateResourceAssignmentSearchResult =
  | { kind: 'search'; search: ResourceAssignmentSearch }
  /**
   * `invalid_request`: a budget or lookahead is not a positive integer. `invalid_reach_table`: the table
   * is inconsistent (no Target, duplicate Target, unknown Normal Counter, non-integer origin).
   * `planning_target_mismatch`: the planning Targets and the table's rows differ in membership or order.
   */
  | { kind: 'invalid_input'; reason: 'invalid_request' | 'invalid_reach_table' | 'planning_target_mismatch'; detail: string }

/**
 * The typed outcome of collecting assignments from one search (Phase B-1's slice of design 4.6).
 * No status says `verified`, `coverage_infeasible` or "no feasible Plan exists": `no_resource_assignment`
 * means the exhausted tree of this window and these exclusivity constraints held none, `window` /
 * `scanned` say which positions that statement covers, and `search_incomplete` concludes nothing about
 * the window.
 */
export type ResourceAssignmentSearchResult =
  | { status: 'assignments_found'; completeness: 'exhausted' | 'candidate_limit_reached'; candidates: ResourceAssignmentCandidate[]
      diagnostics: ResourceAssignmentSearchDiagnostics; window: ReachWindow; scanned: ReachTable['scanned'] }
  /**
   * `target_without_option`: a Target has no option in the window. `resource_exclusivity`: every Target has
   * options but C1 / C2 leave no complete assignment. `upper_bound_pruning`: a caller-supplied
   * `VerifiedUpperBound` cut every complete assignment (each has `objective >= UB`); never produced without one.
   */
  | { status: 'no_resource_assignment'; completeness: 'exhausted'; reason: 'target_without_option' | 'resource_exclusivity' | 'upper_bound_pruning'
      targetsWithoutOption: TargetWeaponId[]; diagnostics: ResourceAssignmentSearchDiagnostics; window: ReachWindow; scanned: ReachTable['scanned'] }
  | { status: 'search_incomplete'; completeness: 'node_budget_reached' | 'cancelled'; candidates: ResourceAssignmentCandidate[]
      diagnostics: ResourceAssignmentSearchDiagnostics; window: ReachWindow; scanned: ReachTable['scanned'] }
  | { status: 'invalid_input'; reason: Extract<CreateResourceAssignmentSearchResult, { kind: 'invalid_input' }>['reason'] | 'invalid_candidate_limit'; detail: string }
