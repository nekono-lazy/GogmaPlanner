/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B / C (moved from the Global Assignment Research
 * Phase C-2, Issue #154).
 *
 * The coverage-gated assignment search (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 6.3 / 6.4 / 8.1 /
 * 4.6 / 10.3 / 12): the Phase B-1 resource assignment generator (`assignmentSolver.ts`) with the Phase C-1
 * static coverage pre-check (`checkStreamCoverage()`) applied to every complete assignment it generates.
 *
 * - A complete assignment that fails the pre-check is recorded (its lowest uncovered Skill position and
 *   the related gap) and passed over: it is never delivered, and the search continues from the next value
 *   of the same node, so no node or complete assignment is revisited.
 * - With `coverageDrivenOrdering`, the lowest uncovered Skill position `x` of the latest rejection becomes
 *   the priority conversion position every node reads before each value it delivers (design 6.3): the
 *   not-yet-delivered options of the node's Target converting at `x` (`c = s*` and `c < s*`) come first.
 *   It is a reordering only (`createPrioritizedOptionEnumerator()`), never a filter: C1 / C2, MRV and the
 *   branch-and-bound are unchanged, every option is still delivered exactly once, and the exhausted set of
 *   coverage-feasible assignments equals the one without the ordering.
 * - Without it the underlying search is exactly the Phase B-1 one.
 *
 * Only a Production-verified upper bound may prune (design 6.3 / 10.1); the best coverage-feasible
 * objective is a diagnostic and is never fed back. A pre-check verdict of `invalid_input` on an assignment
 * the solver generated is an internal inconsistency and is thrown as `BuildListOptimizationInvariantError`,
 * never read as a coverage failure. The module reads the ReachTable and the planning Targets only: no
 * Engine, PlannerInput, Search or Planner (`structuralSearch.ts` adds the required-only replay and shapes).
 */
import { createResourceAssignmentSearch } from './assignmentSolver'
import type { PlanningTargetPriority, ResourceAssignmentCandidate, ResourceAssignmentSearch } from './assignmentTypes'
import { checkStreamCoverage } from './coverage'
import type {
  AssignmentCoverageInspection, CoverageFeasibleAssignment, CoverageSearch, CoverageSearchDiagnostics, CoverageSearchEvent, CoverageSearchRequest,
  CoverageSearchResult, CreateCoverageSearchResult, NoStructuralCandidateReason,
} from './coverageSearchTypes'
import type { UncoveredGap } from './coverageTypes'
import { BuildListOptimizationInvariantError, type ReachTable } from './buildListOptimizationTypes'

class CoverageGatedSearch implements CoverageSearch<CoverageFeasibleAssignment> {
  private priority: number | null = null
  private priorityChanges = 0
  private inspected = 0
  private rejections = 0
  private feasible = 0
  private bestFeasible: { ordinal: number; objective: number } | null = null
  private firstRejection: { ordinal: number; objective: number; firstUncovered: UncoveredGap } | null = null
  private lowestUncovered: number | null = null
  private readonly rejectionsByPosition = new Map<number, number>()
  private untilFirstFeasible: number | null = null
  private readonly inner: ResourceAssignmentSearch
  private readonly table: ReachTable
  private readonly request: CoverageSearchRequest

  constructor(table: ReachTable, inner: ResourceAssignmentSearch, request: CoverageSearchRequest) {
    this.table = table
    this.inner = inner
    this.request = request
  }

  /** The priority provider the underlying search reads (only wired when the ordering is enabled). */
  readonly readPriority = (): number | null => this.priority

  get targetsWithoutOption() {
    return this.inner.targetsWithoutOption
  }

  get diagnostics(): CoverageSearchDiagnostics {
    const resource = this.inner.diagnostics
    return {
      resource,
      completeAssignmentsInspected: this.inspected,
      coverageRejections: this.rejections,
      coverageFeasible: this.feasible,
      bestCoverageFeasible: this.bestFeasible === null ? null : { ...this.bestFeasible },
      firstRejection: this.firstRejection === null ? null : { ...this.firstRejection },
      lowestUncoveredPosition: this.lowestUncovered,
      rejectionsByFirstUncoveredPosition: [...this.rejectionsByPosition].sort(([left], [right]) => left - right).map(([position, count]) => ({ position, count })),
      assignmentsUntilFirstCoverageFeasible: this.untilFirstFeasible,
      coverageDrivenOrdering: { ...this.inner.priorityOrdering, currentPriorityConversionPosition: this.priority, priorityChanges: this.priorityChanges },
      completeness: resource.completeness,
    }
  }

  next(maxNodes?: number): CoverageSearchEvent<CoverageFeasibleAssignment> {
    if (maxNodes !== undefined && (!Number.isSafeInteger(maxNodes) || maxNodes < 1)) throw new RangeError(`maxNodes must be a positive integer (got ${String(maxNodes)}).`)
    let used = 0
    while (true) {
      if (maxNodes !== undefined && used >= maxNodes) return { kind: 'paused', nodesThisCall: used }
      const before = this.inner.diagnostics.expandedNodes
      const event = this.inner.next(maxNodes === undefined ? undefined : maxNodes - used)
      used += this.inner.diagnostics.expandedNodes - before
      if (event.kind === 'finished') return event
      if (event.kind === 'paused') return { kind: 'paused', nodesThisCall: used }
      const delivered = this.inspect(event.candidate)
      if (delivered) return { kind: 'candidate', candidate: delivered }
    }
  }

  /** The coverage verdict of one complete assignment; records a rejection and moves the priority, or returns the feasible assignment. */
  private inspect(assignment: ResourceAssignmentCandidate): CoverageFeasibleAssignment | null {
    const result = checkStreamCoverage(assignment, this.table)
    if (result.kind === 'invalid_input') {
      throw new BuildListOptimizationInvariantError('coverage_invariant', `The solver generated resource assignment ${assignment.ordinal} that the coverage pre-check refuses as ${result.reason}: ${result.detail}`)
    }
    this.inspected += 1
    const priorityInForce = this.priority
    if (result.kind === 'coverage_infeasible') {
      const gap = result.firstUncovered
      if (gap.stream.kind !== 'skill') throw new BuildListOptimizationInvariantError('coverage_invariant', `Resource assignment ${assignment.ordinal}: an uncovered ${gap.stream.kind} gap, which the design rules exclude.`)
      const position = gap.firstUncoveredPosition
      this.rejections += 1
      if (this.firstRejection === null) this.firstRejection = { ordinal: assignment.ordinal, objective: assignment.objective, firstUncovered: gap }
      if (this.lowestUncovered === null || position < this.lowestUncovered) this.lowestUncovered = position
      this.rejectionsByPosition.set(position, (this.rejectionsByPosition.get(position) ?? 0) + 1)
      if (this.request.coverageDrivenOrdering && this.priority !== position) {
        this.priority = position
        this.priorityChanges += 1
      }
      this.request.onAssignmentInspected?.({ ordinal: assignment.ordinal, objective: assignment.objective, verdict: 'coverage_infeasible', firstUncovered: gap, priorityConversionPosition: priorityInForce, assignment })
      return null
    }
    this.feasible += 1
    if (this.untilFirstFeasible === null) this.untilFirstFeasible = this.inspected
    if (this.bestFeasible === null || assignment.objective < this.bestFeasible.objective) this.bestFeasible = { ordinal: assignment.ordinal, objective: assignment.objective }
    const inspection: AssignmentCoverageInspection = { ordinal: assignment.ordinal, objective: assignment.objective, verdict: 'coverage_feasible', firstUncovered: null, priorityConversionPosition: priorityInForce, assignment }
    this.request.onAssignmentInspected?.(inspection)
    return { kind: 'coverage_feasible_assignment', assignment, coverage: result.coverage }
  }
}

/**
 * Creates the coverage-gated search over `table` for the given planning Targets (the context's
 * `planningTargets`; only `id` and `priority` are read). Nothing is searched until `next()` is called.
 */
export function createCoverageSearch(table: ReachTable, planningTargets: readonly PlanningTargetPriority[], request: CoverageSearchRequest): CreateCoverageSearchResult<CoverageFeasibleAssignment> {
  if (typeof request.coverageDrivenOrdering !== 'boolean') {
    return { kind: 'invalid_input', reason: 'invalid_request', detail: `coverageDrivenOrdering must be an explicit boolean (got ${String(request.coverageDrivenOrdering)}).` }
  }
  let gated: CoverageGatedSearch | null = null
  const created = createResourceAssignmentSearch(table, planningTargets, {
    nodeBudget: request.nodeBudget,
    mrvLookahead: request.mrvLookahead,
    ...(request.readVerifiedUpperBound ? { readVerifiedUpperBound: request.readVerifiedUpperBound } : {}),
    ...(request.shouldCancel ? { shouldCancel: request.shouldCancel } : {}),
    ...(request.onNodeExpanded ? { onNodeExpanded: request.onNodeExpanded } : {}),
    // The priority provider is wired only on the explicit opt-in; otherwise the solver runs the Phase B-1 value order.
    ...(request.coverageDrivenOrdering ? { readPriorityConversionPosition: () => gated!.readPriority() } : {}),
  })
  if (created.kind === 'invalid_input') return created
  gated = new CoverageGatedSearch(table, created.search, request)
  return { kind: 'search', search: gated }
}

/** Why an exhausted search delivered nothing (design 4.6). A pruned tree never claims coverage infeasibility for its cut part. */
export function noCandidateReason(search: CoverageSearch<unknown, CoverageSearchDiagnostics>): NoStructuralCandidateReason {
  const diagnostics = search.diagnostics
  if (search.targetsWithoutOption.length > 0) return 'target_without_option'
  if (diagnostics.resource.pruned > 0) return 'upper_bound_pruning'
  return diagnostics.completeAssignmentsInspected > 0 ? 'coverage_infeasible' : 'resource_exclusivity'
}

/**
 * Runs a coverage-gated search until `candidateLimit` candidates were delivered or the search ended, and
 * classifies the outcome (design 4.6). `no_structural_candidate` only for an exhausted tree; a node
 * budget or cancel is `search_incomplete` even when every assignment inspected so far was rejected.
 */
export function collectFromCoverageSearch<TCandidate, TDiagnostics extends CoverageSearchDiagnostics>(
  created: CreateCoverageSearchResult<TCandidate, TDiagnostics>, table: ReachTable, candidateLimit: number,
): CoverageSearchResult<TCandidate, TDiagnostics> {
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1) {
    return { status: 'invalid_input', reason: 'invalid_candidate_limit', detail: `candidateLimit must be a positive integer (got ${String(candidateLimit)}).` }
  }
  if (created.kind === 'invalid_input') return { status: 'invalid_input', reason: created.reason, detail: created.detail }
  const { search } = created
  const candidates: TCandidate[] = []
  const common = { window: { ...table.window }, scanned: table.scanned }
  while (true) {
    const event = search.next()
    if (event.kind === 'candidate') {
      candidates.push(event.candidate)
      if (candidates.length >= candidateLimit) return { status: 'candidates_found', completeness: 'candidate_limit_reached', candidates, diagnostics: search.diagnostics, ...common }
      continue
    }
    if (event.kind === 'paused') continue
    const diagnostics = search.diagnostics
    if (event.completeness !== 'exhausted') return { status: 'search_incomplete', completeness: event.completeness, candidates, diagnostics, ...common }
    if (candidates.length > 0) return { status: 'candidates_found', completeness: 'exhausted', candidates, diagnostics, ...common }
    return { status: 'no_structural_candidate', completeness: 'exhausted', reason: noCandidateReason(search), targetsWithoutOption: [...search.targetsWithoutOption], diagnostics, ...common }
  }
}

/** `collectFromCoverageSearch()` over a new coverage-gated search (no Engine; the coverage-feasible assignments only). */
export function collectCoverageFeasibleAssignments(table: ReachTable, planningTargets: readonly PlanningTargetPriority[], request: CoverageSearchRequest,
  candidateLimit: number): CoverageSearchResult<CoverageFeasibleAssignment> {
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1) {
    return { status: 'invalid_input', reason: 'invalid_candidate_limit', detail: `candidateLimit must be a positive integer (got ${String(candidateLimit)}).` }
  }
  return collectFromCoverageSearch(createCoverageSearch(table, planningTargets, request), table, candidateLimit)
}
