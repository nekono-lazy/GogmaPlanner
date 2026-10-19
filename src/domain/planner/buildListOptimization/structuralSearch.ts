/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B / C (moved from the Global Assignment Research
 * Phase C-2, Issue #154).
 *
 * The structural candidate generator of `docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 6.3 / 6.4
 * (`structuralCandidates`), without Phase D / D': the coverage-gated assignment search
 * (`coverageSearch.ts`) whose every coverage-feasible assignment - and only those - is passed to the
 * Phase C-1 `buildStructuralCandidate()` (required-only replay, materialization order, expected Route
 * shapes). The search state is kept between candidates, so the next `next()` resumes at the next value
 * of the same node.
 *
 * `buildStructuralCandidate()` re-checks the table against the context and the assignment against the
 * table, and recomputes the coverage. Anything but a structural candidate for an assignment the gate
 * accepted is an internal inconsistency (`BuildListOptimizationInvariantError('coverage_invariant')`), and a
 * replay inconsistency propagates as the existing `BuildListOptimizationInvariantError`: neither becomes a
 * coverage rejection or "no candidate". The best structural objective is a diagnostic distinct from the
 * underlying `bestAssignment`; neither is ever an upper bound or a verified result.
 */
import { collectFromCoverageSearch, createCoverageSearch } from './coverageSearch'
import type {
  CoverageFeasibleAssignment, CoverageSearch, CoverageSearchEvent, CoverageSearchRequest, CreateCoverageSearchResult, StructuralSearchDiagnostics,
  StructuralSearchResult,
} from './coverageSearchTypes'
import type { StructuralCandidate } from './coverageTypes'
import { buildStructuralCandidate, checkTableBelongsToContext, type StructuralCandidateInputs } from './structuralCandidate'
import { BuildListOptimizationInvariantError } from './buildListOptimizationTypes'

class StructuralCandidateSearch implements CoverageSearch<StructuralCandidate, StructuralSearchDiagnostics> {
  private built = 0
  private best: { ordinal: number; objective: number } | null = null
  private readonly replayPredictions = { skill: 0, gogmaReset: 0, gogmaKeep: 0, normal: 0 }
  private readonly gated: CoverageSearch<CoverageFeasibleAssignment>
  private readonly inputs: StructuralCandidateInputs

  constructor(gated: CoverageSearch<CoverageFeasibleAssignment>, inputs: StructuralCandidateInputs) {
    this.gated = gated
    this.inputs = inputs
  }

  get targetsWithoutOption() {
    return this.gated.targetsWithoutOption
  }

  get diagnostics(): StructuralSearchDiagnostics {
    return { ...this.gated.diagnostics, structuralCandidates: this.built, bestStructural: this.best === null ? null : { ...this.best }, replayPredictions: { ...this.replayPredictions } }
  }

  next(maxNodes?: number): CoverageSearchEvent<StructuralCandidate> {
    const event = this.gated.next(maxNodes)
    if (event.kind !== 'candidate') return event
    const result = buildStructuralCandidate(event.candidate.assignment, this.inputs)
    if (result.kind !== 'structural_candidate') {
      throw new BuildListOptimizationInvariantError('coverage_invariant', `Coverage-feasible assignment ${event.candidate.assignment.ordinal} did not build a structural candidate (${result.kind}${result.kind === 'invalid_input' ? `: ${result.reason}, ${result.detail}` : ''}).`)
    }
    const candidate = result.candidate
    this.built += 1
    if (this.best === null || candidate.assignment.objective < this.best.objective) this.best = { ordinal: candidate.ordinal, objective: candidate.assignment.objective }
    for (const key of ['skill', 'gogmaReset', 'gogmaKeep', 'normal'] as const) this.replayPredictions[key] += candidate.replayPredictions[key]
    return { kind: 'candidate', candidate }
  }
}

/**
 * Creates the structural candidate search over `inputs.table` for the context's planning Targets.
 * The table must be the context's (same planning Targets in the same order, the same confirmed origins).
 */
export function createStructuralCandidateSearch(inputs: StructuralCandidateInputs, request: CoverageSearchRequest): CreateCoverageSearchResult<StructuralCandidate, StructuralSearchDiagnostics> {
  const mismatch = checkTableBelongsToContext(inputs.table, inputs.context)
  if (mismatch) return { kind: 'invalid_input', reason: mismatch.reason, detail: mismatch.detail }
  const created = createCoverageSearch(inputs.table, inputs.context.planningTargets, request)
  if (created.kind === 'invalid_input') return created
  return { kind: 'search', search: new StructuralCandidateSearch(created.search, inputs) }
}

/** Collects structural candidates (design 4.6 classification); see `collectFromCoverageSearch()`. */
export function collectStructuralCandidates(inputs: StructuralCandidateInputs, request: CoverageSearchRequest, candidateLimit: number): StructuralSearchResult {
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1) {
    return { status: 'invalid_input', reason: 'invalid_candidate_limit', detail: `candidateLimit must be a positive integer (got ${String(candidateLimit)}).` }
  }
  return collectFromCoverageSearch(createStructuralCandidateSearch(inputs, request), inputs.table, candidateLimit)
}
