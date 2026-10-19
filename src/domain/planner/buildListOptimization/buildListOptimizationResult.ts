/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.7 - 17.10 / 17.12 / 17.13): the result types of one calculation,
 * Stage 0 through Stage D'.
 *
 * Everything here is runtime-only, structured-clone data: an artifact is never persisted, exported, put into AppSettings or a URL,
 * and its diagnostics decide nothing (Debug Mode display only). A cancellation and a calculation failure are the caller's states,
 * never a result: `runBuildListOptimization()` reports a cancellation as `{ kind: 'cancelled' }` beside its result, and every
 * fail-closed contract violation throws instead of becoming `unsupported` / `not_found` / `search_bound_reached`.
 */
import type { BuildListEntryReplacement } from '../../buildList/buildListEntryReplacement'
import type { BuildListEntry, BuildListEntryId, CalculationContext, ExpectedPlanState, TargetWeaponId } from '../../models/publicTypes'
import type { PlannerResult, PlannerWarning, PlannerWarningKind } from '../plannerTypes'
import type { ReachWindow } from './buildListOptimizationTypes'
import type { CoverageSearchDiagnostics, NoStructuralCandidateReason } from './coverageSearchTypes'
import type { RouteGenerationMethod, RouteGenerationSettings, RouteGenerationStageOutcome, ShapeSearchBudgetComponent, ShapeSearchScaleComponent } from './routeGenerationTypes'

/**
 * Why the optimization does not run for this input (`docs/PLANNER_SPEC.md` 17.4). None of them says a plan or an Ideal does not
 * exist. `running_plan_exists` is decided by the Application before a calculation starts (the Domain has no running Plan to read);
 * the others are the Domain's Stage 0, which reports every reason that holds, not only the first one.
 */
export type BuildListOptimizationUnsupportedReason =
  | { kind: 'running_plan_exists' }
  /** `validatePlannerInput()` fails the whole input closed (legacy duplicate, broken selection, preference violation, ...). */
  | { kind: 'invalid_planner_input'; issues: { path: string; code: string; message: string }[] }
  /** No valid Entry gives a planning Target. */
  | { kind: 'no_planning_target' }
  /** A planning Target's valid Entry holds an explicitly selected intermediate state (never cleared or reread). */
  | { kind: 'checkpoint_selection'; entries: { buildListEntryId: BuildListEntryId; targetWeaponId: TargetWeaponId }[] }
  /** Base Seed, Skill Counter or Gogma Counter is not a confirmed value. */
  | { kind: 'unconfirmed_rng_state'; missing: ('base_seed' | 'skill_counter' | 'gogma_counter')[] }
  /** A planning Target has no usable owned source and its weapon type has no confirmed rarity-8 Normal Counter. */
  | { kind: 'target_without_source'; targetWeaponIds: TargetWeaponId[] }
  /** A planning Target has no usable owned source and its Normal prediction is unsupported: only a blind Route could reach it. */
  | { kind: 'blind_route_required'; targetWeaponIds: TargetWeaponId[] }

/** A search bound the calculation reached: candidates may remain unexamined (never "no candidate"). */
export type BuildListOptimizationBound =
  | { kind: 'structural_search_node_budget'; nodeBudget: number }
  | { kind: 'structural_candidate_limit'; maxStructuralCandidates: number }
  | { kind: 'planner_verification_budget'; maxPlannerVerifications: number }
  | { kind: 'shape_search_scale_gate'; targetWeaponId: TargetWeaponId; exceeded: ShapeSearchScaleComponent[] }
  | { kind: 'shape_search_budget'; targetWeaponId: TargetWeaponId; exceeded: ShapeSearchBudgetComponent[] }

/**
 * One Entry the Stage 0 input validation excluded, with the warning its exclusion added (`docs/PLANNER_SPEC.md` 17.7 item 3): the
 * Entry and its Target, and the warning's kind and message exactly as `validatePlannerInput().excludedBuildListEntryWarnings` recorded
 * them. The exclusion set is compared by Entry, Target and kind; the adoption matches the final warnings against the kind and message
 * pairs. Neither reads the message for an Entry or a Target.
 */
export interface BuildListOptimizationInputExclusion {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
  warningKind: PlannerWarningKind
  warningMessage: string
}

/**
 * The Worker-side items of the input token (`docs/PLANNER_SPEC.md` 17.10): the adoption re-checks the current state against them.
 * The observed Draft ID and the absence of a running Plan are the Application's and are not part of this value.
 */
export interface BuildListOptimizationInputToken {
  /** The final Plan's `baseSnapshot.initialExecutionState` (the input's RNG state, Normal Counters, OwnedWeapons and Plan-dependent Targets). */
  initialExecutionState: ExpectedPlanState
  /** `createPlanningTargetWeaponsHash()` of the input (the final Plan's value: Stage D' never edits a Target). */
  targetWeaponsHash: string
  /** `createPlanningBuildListEntriesHash()` of the input Build List (the final Plan's hash is the replaced Build List's). */
  inputBuildListEntriesHash: string
  calculationContext: CalculationContext
}

/** The registered Targets outside the planning Targets, each in exactly one class (never added to the planning denominator). */
export interface BuildListOptimizationOutOfScopeTargetCounts {
  /** No Entry in the Build List. */
  noEntry: number
  /** Entries in the Build List, every one excluded by the input validation (stale and the like). */
  excludedEntryOnly: number
  /** The Target is not enabled for search. */
  disabled: number
  /** The Target is completed. */
  completed: number
}

export interface BuildListOptimizationSummary {
  /** `planStepCount − nonPhysicalStepCount`: the in-game operations (`REQUIREMENTS.md` 22.1). */
  physicalOperationCount: number
  /** `plan.steps.length` (the `confirm_owned_ideal` Steps included). */
  planStepCount: number
  /** The `confirm_owned_ideal` Steps (no Counter advance, no in-game operation). */
  nonPhysicalStepCount: number
  /** The structural candidate's objective, equal to the physical operation count by the verified identity. */
  structuralObjective: number
  /** `termination.completedTargetCount`. */
  completedTargetCount: number
  /** `termination.totalTargetCount`: this run's planning Targets (the display denominator; never the registered Target count). */
  totalTargetCount: number
  /** The final verification bound the Domain derived (`docs/PLANNER_SPEC.md` 17.13); read for display, never recomputed. */
  maxPlanSteps: number
  outOfScopeTargetCounts: BuildListOptimizationOutOfScopeTargetCounts
}

/** Why one Planner verification did not make a candidate `optimized` (`docs/PLANNER_SPEC.md` 17.7); never a conflict to resolve. */
export type BuildListOptimizationVerificationRejection =
  | { code: 'final_input_invalid'; issues: { path: string; code: string }[] }
  | { code: 'planning_target_set_changed'; added: TargetWeaponId[]; removed: TargetWeaponId[] }
  | { code: 'generated_entry_excluded'; buildListEntryIds: BuildListEntryId[] }
  | { code: 'input_exclusions_changed'; missing: BuildListOptimizationInputExclusion[]; unexpected: BuildListOptimizationInputExclusion[] }
  | { code: 'plan_missing' }
  | { code: 'termination_not_completed'; status: string; reachedLimits: string[] }
  | { code: 'completed_target_count_mismatch'; completed: number; planning: number }
  | { code: 'total_target_count_mismatch'; total: number; planning: number }
  | { code: 'selected_entries_mismatch'; missing: BuildListEntryId[]; unexpected: BuildListEntryId[] }
  | { code: 'conflicts'; count: number }
  | { code: 'rejected_entries'; count: number }
  | { code: 'unexpected_warnings'; warnings: PlannerWarning[] }

/** One structural candidate the calculation examined (diagnostics only). */
export interface BuildListOptimizationCandidateDiagnostics {
  /** The structural candidate's generation ordinal (never an identity). */
  ordinal: number
  objective: number
  routeGeneration: {
    outcome: RouteGenerationStageOutcome['kind']
    generatedTargetCount: number
    /** The method that generated each Route, counted. */
    methods: Record<RouteGenerationMethod, number>
  }
  /** Null when Stage D' did not run for the candidate. */
  verification: null | {
    outcome: 'optimized' | 'rejected'
    maxPlanSteps: number
    /** Full Planner runs (the first run plus every runtime-unsupported retry); recorded, never a condition. */
    fullPlannerRuns: number
    rejections: BuildListOptimizationVerificationRejection[]
  }
}

/** What the calculation did (Debug Mode display only; never a judgement input). */
export interface BuildListOptimizationDiagnostics {
  reachTable: null | {
    window: ReachWindow
    predictions: { skill: number; gogmaReset: number; gogmaKeep: number; normal: number }
    memoHits: { skill: number; gogmaReset: number; gogmaKeep: number; normal: number }
    supportQueries: number
  }
  structuralSearch: null | {
    completeness: CoverageSearchDiagnostics['completeness']
    expandedNodes: number
    coverageRejections: number
    structuralCandidates: number
    /** Set only when the exhausted search delivered no structural candidate. */
    noStructuralCandidateReason: NoStructuralCandidateReason | null
  }
  candidates: BuildListOptimizationCandidateDiagnostics[]
  plannerVerifications: number
  /** Milliseconds per stage from the caller's monotonic clock; null when the caller passed none. */
  elapsedMs: Partial<Record<BuildListOptimizationStage, number>> | null
}

/** The runtime-only result of a successful optimization (`docs/PLANNER_SPEC.md` 17.8 / 17.9 / 17.11). */
export interface BuildListOptimizationArtifact {
  /** The final Planner result: `plan !== null`, `status` draft, `conflictRepairLineage === null`, `termination` completed. */
  plannerResult: PlannerResult
  /** The replacing Entries of the Targets whose Route changed, in materialization order (a reused Entry is not one). */
  generatedBuildListEntries: BuildListEntry[]
  /** One `BuildListEntryReplacement` per generated Entry, in the same order. */
  replacements: BuildListEntryReplacement[]
  /** Planning Targets whose generated Entry is their current Entry (same semantic content: unchanged, settings kept). */
  unchangedTargetWeaponIds: TargetWeaponId[]
  /** Stage 0's planning Targets, in Target ID order. */
  planningTargetWeaponIds: TargetWeaponId[]
  /** Stage 0's excluded Entries with their warnings (kind and message); the final input excluded exactly these Entries for these kinds. */
  inputExclusions: BuildListOptimizationInputExclusion[]
  inputToken: BuildListOptimizationInputToken
  summary: BuildListOptimizationSummary
  diagnostics: BuildListOptimizationDiagnostics
}

export type BuildListOptimizationResult =
  | { status: 'optimized'; artifact: BuildListOptimizationArtifact }
  /** The search ended inside its bounds and no candidate made it: "not found in this search range", never "none exists". */
  | { status: 'not_found'; reason: 'no_structural_candidate' | 'candidates_rejected'; diagnostics: BuildListOptimizationDiagnostics }
  /** A bound stopped the search or left a candidate unconfirmed: candidates may remain, nothing is concluded. */
  | { status: 'search_bound_reached'; bounds: BuildListOptimizationBound[]; diagnostics: BuildListOptimizationDiagnostics }
  | { status: 'unsupported'; reasons: BuildListOptimizationUnsupportedReason[] }

/** One calculation: its result, or the caller's own cancellation (no result is adopted from a cancelled calculation). */
export type BuildListOptimizationRun =
  | { kind: 'result'; result: BuildListOptimizationResult }
  | { kind: 'cancelled' }

/** The stage names a progress display shows (`docs/PLANNER_SPEC.md` 17.16): never a completion rate. */
export type BuildListOptimizationStage = 'input_check' | 'reach_table' | 'assignment_search' | 'route_generation' | 'plan_verification'

/**
 * The caller's explicit search bounds (`docs/PLANNER_SPEC.md` 17.13): every value is a positive (gates and budgets: non-negative)
 * safe integer, with no default, fallback, completion or clamp in the Domain. The Production values are decided by measurement and
 * passed by the Production adapter; nothing here reads the Candidate Search defaults or a saved setting.
 */
export interface BuildListOptimizationBounds {
  /** Stage A: the Counter positions per stream the ReachTable scans. */
  window: ReachWindow
  /** Stage B / C: expanded nodes of the coverage-gated structural search. */
  nodeBudget: number
  /** Stage B / C: the MRV lookahead of the structural search. */
  mrvLookahead: number
  /** Stage D: structural candidates whose Routes are generated. */
  maxStructuralCandidates: number
  /** Stage D': Planner verifications (the verification budget). */
  maxPlannerVerifications: number
  /** Stage D: the Searches' gates and the shape-constrained runtime budget. */
  routeGeneration: RouteGenerationSettings
}
