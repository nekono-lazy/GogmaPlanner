import { validateBuildListCardinality } from '../buildList/buildListCardinality'
import type { BuildListEntryAddition, BuildListEntryReplacement } from '../buildList/buildListEntryReplacement'
import {
  classifyLegacyCheckpointSelection,
  LEGACY_CHECKPOINT_SELECTION_FIELD,
  type LegacyCheckpointSelectionIssue,
} from '../buildList/legacyCheckpointSelection'
import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  ExpectedPlanState,
  ProductionPlan,
  ProductionPlanId,
  TargetWeaponId,
} from '../models/publicTypes'
import { isTargetWeaponPlanningEligible } from '../models/publicTypes'
import {
  assertBuildListOptimizationBounds,
  buildListOptimizationPlanSummaryOf,
  BuildListOptimizationInvariantError,
  createBuildListOptimizationStageTracker,
  deriveBuildListOptimizationUnsupportedReasons,
  runBuildListOptimizationStages,
  type BuildListOptimizationBounds,
  type BuildListOptimizationContext,
  type BuildListOptimizationDiagnostics,
  type BuildListOptimizationExecution,
  type BuildListOptimizationPlanSummary,
  type BuildListOptimizationResult,
  type BuildListOptimizationScope,
  type BuildListOptimizationUnsupportedReason,
} from '../planner/buildListOptimization'
import { derivePlannerPlanningTargets } from '../planner/plannerPlanningTargets'
import { defaultPlannerOptions, PERSISTED_PLANNER_BUILD_LIST_CONTEXT, type PlannerDependencies, type PlannerInput, type PlannerResult } from '../planner/plannerTypes'
import { validatePlannerInput, validatePlannerOptions } from '../planner/plannerValidation'
import {
  createDependentTargetDefinitionsHash,
  createPlanningBuildListEntriesHash,
  createPlanningTargetWeaponsHash,
} from '../planner/productionPlanGeneration'
import { replanTargetWeaponIdsOf, type ReplanTargetClassification } from './runningPlanReplanTargets'

/**
 * The running Plan replan re-optimization of Issue #276 (`docs/PLANNER_SPEC.md` 18.6): from the current point, rebuild the Routes of
 * the replan target set (18.2) together and verify them with the ordinary Planner, as one calculation with a typed result.
 *
 *   Stage 0R  the replan target set as given (PR-2's `deriveReplanTargetSet()`), the input scoped to its Targets' current Entries, the
 *             18.5 input conditions (`no_replan_target`, `invalid_planner_input`, `checkpoint_selection`, `unconfirmed_rng_state`,
 *             `target_without_source`, `blind_route_required`)
 *   Stage A - D'  the Build List global optimization's own calculation core (`runBuildListOptimizationStages()`, 17.6 - 17.13) over that
 *             scope: the ReachTable, the structural candidate search, the route generation and the final verification by the ordinary
 *             Planner, under the caller's bounds, with every replan Target's current Entry replaced, reused or - for a Target without an
 *             Entry - added (`replace_or_add`)
 *
 * It is a separate entry beside `runBuildListOptimization()`, whose Stage 0 (planning Targets from the valid Entries, 17.3) it never
 * runs: the replan target set is never re-derived from the Entries, so an unfinished Target whose Entry is stale, excluded by the input
 * validation or missing stays a planning Target, and a Target outside the set is never one. Entries outside the set are not part of the
 * input at all, so their staleness, selections and duplicates neither refuse nor change the calculation; `targetWeapons` stays the
 * whole collection.
 *
 * An OwnedWeapon the old Plan is producing is an ordinary current source here (18.4, R3 decided at PR-3: the initial version neither
 * fixes nor prefers continuing it for the same Target; the ordinary rules of the calculation - fewest physical operations - decide, and
 * a protected weapon keeps its protection's limits). `preferredOwnedWeaponId` is no fixed constraint (17.14).
 *
 * Pure apart from the Engine and the Planner's Production ID factory and Clock, exactly like the Build List optimization: it reads no
 * persisted state - the old Plan, its `baseSnapshot`, its Routes and its conflict resolutions are never an input -, writes nothing,
 * holds no default bound and reads no saved setting; the input's own `options` (the 「最大計画ステップ数」 setting) is never read. The
 * per-old-Plan availability (18.5: `running_plan_targets_unknown`, `operation_uncertain_unresolved`, `reidentification_required`) is
 * PR-2's `deriveRunningPlanReplanAvailability()`, which the Application applies before a calculation starts; it is not judged again
 * here. Nothing here persists, adopts or falls back to the ordinary Planner.
 *
 * Not re-exported by `src/domain/execution/index.ts` (like the optimization module itself): its callers - the dedicated Worker of
 * Issue #276 PR-4 - import this module path, so no screen pulls the calculation in through the Execution barrel.
 */

/**
 * Why the replan re-optimization does not run for this replan target set (`docs/PLANNER_SPEC.md` 18.5 「入力条件」). None of them says a
 * plan or an Ideal does not exist, and none clears or rereads a selection. The last four share the Build List optimization's shapes
 * and rule (17.4), over the replan Targets.
 */
export type RunningPlanReplanOptimizationUnsupportedReason =
  /** The replan target set is empty: nothing would be made. */
  | { kind: 'no_replan_target' }
  | Extract<BuildListOptimizationUnsupportedReason, {
      kind: 'invalid_planner_input' | 'checkpoint_selection' | 'unconfirmed_rng_state' | 'target_without_source' | 'blind_route_required'
    }>

/**
 * The items of the calculation's input a later adoption re-checks against the current state (`docs/PLANNER_SPEC.md` 18.8 [T]; the
 * final form of the adoption token is R8, PR-5's). Each is the semantic value of the input the calculation read, never a whole-input
 * hash of the Targets or the Build List outside the replan target set (16.8: they are no adoption authority).
 */
export interface RunningPlanReplanOptimizationInputToken {
  /** The final Plan's `baseSnapshot.initialExecutionState` (the input's RNG state, Normal Counters, OwnedWeapons, Plan-dependent Targets). */
  initialExecutionState: ExpectedPlanState
  /** `createDependentTargetDefinitionsHash()` of the replan Targets: their performance definition, priority and enablement. */
  replanTargetDefinitionsHash: string
  /** `createPlanningBuildListEntriesHash()` of the replan Targets' current Entries (an Entry-less Target holds none). */
  scopeBuildListEntriesHash: string
  calculationContext: CalculationContext
}

/** The runtime-only result of a successful replan re-optimization (`docs/PLANNER_SPEC.md` 18.6 / 18.7 / 18.8). Never persisted. */
export interface RunningPlanReplanOptimizationArtifact {
  /** The old Plan the replan target set was derived from (`ReplanTargetClassification.planId`). */
  planId: ProductionPlanId
  /** The replan target set fixed at Stage 0R, in the classification's order (`continuing` in Step order, then `added`). */
  replanTargetWeaponIds: TargetWeaponId[]
  /** The final Planner result: `plan !== null`, `status` draft, `conflictRepairLineage === null`, `termination` completed. */
  plannerResult: PlannerResult
  /** Every generated Entry, replacing or added, in materialization order (a reused Entry is not one). */
  generatedBuildListEntries: BuildListEntry[]
  /** `O -> G` for each replan Target whose current Entry (stale or not) the generated Entry replaces, in materialization order. */
  replacements: BuildListEntryReplacement[]
  /** `G` for each replan Target that held no Entry, in materialization order; never written as a replacement. */
  additions: BuildListEntryAddition[]
  /** Replan Targets whose current Entry is reused as it is (same semantic content, valid now: settings kept). */
  unchangedTargetWeaponIds: TargetWeaponId[]
  inputToken: RunningPlanReplanOptimizationInputToken
  summary: BuildListOptimizationPlanSummary
  diagnostics: BuildListOptimizationDiagnostics
}

export type RunningPlanReplanOptimizationResult =
  | { status: 'optimized'; artifact: RunningPlanReplanOptimizationArtifact }
  /**
   * The whole replan target set's result (18.5): never attributed to one Target. Shapes and meanings are the Build List
   * optimization's (17.8).
   */
  | Extract<BuildListOptimizationResult, { status: 'not_found' | 'search_bound_reached' }>
  | { status: 'unsupported'; reasons: RunningPlanReplanOptimizationUnsupportedReason[] }

/** One calculation: its result, or the caller's own cancellation (nothing is adopted from a cancelled calculation). */
export type RunningPlanReplanOptimizationRun =
  | { kind: 'result'; result: RunningPlanReplanOptimizationResult }
  | { kind: 'cancelled' }

export interface RunningPlanReplanOptimizationInput {
  /**
   * A fresh `createPlannerInput()` value of the current persisted state with `conflictResolutions = []`: every Target and every Entry,
   * read in the same transaction the replan target set was derived from. The calculation scopes the Entries itself.
   */
  plannerInput: PlannerInput
  /** PR-2's `deriveReplanTargetSet()` over that same state, with the user's runtime-only selection applied. */
  replanTargets: ReplanTargetClassification
}

export type RunningPlanReplanOptimizationInputErrorCode =
  /** `replanTargetWeaponIds` repeats a Target or is not exactly the classification's `continuing` then `added` rows. */
  | 'replan_target_set_inconsistent'
  /** A replan Target is missing from the input, repeated in it, or no longer usable (18.2: existing, `active`, enabled). */
  | 'replan_target_not_usable'

/**
 * The caller's contract is broken: the replan target set is not PR-2's derivation over the very input it is calculated with. Never
 * corrected, guessed or turned into a result.
 */
export class RunningPlanReplanOptimizationInputError extends Error {
  readonly code: RunningPlanReplanOptimizationInputErrorCode

  constructor(code: RunningPlanReplanOptimizationInputErrorCode, message: string) {
    super(message)
    this.name = 'RunningPlanReplanOptimizationInputError'
    this.code = code
  }
}

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

type InvalidPlannerInputIssue = { path: string; code: string; message: string }
type CheckpointSelectionEntry = { buildListEntryId: BuildListEntryId; targetWeaponId: TargetWeaponId }

/**
 * The calculation schema 10 checkpoint selections of the scope Entries (Issue #336 PR-2, 18.5), by the schema 10 contract
 * (`classifyLegacyCheckpointSelection()`): a selection kept as it was accepted at schema 10 refuses the set exactly like a schema
 * 11..18 `intermediateStateSelection` (`checkpoint_selection`), and a field the schema 10 contract cannot read is the whole set's
 * `invalid_planner_input` (the schema 10 Planner failed its input closed on it, as the current one does on a broken
 * `intermediateStateSelection`); neither is ever read as "nothing selected". Entries in stable ID order; the Entry is never changed.
 */
function classifyLegacyCheckpointSelections(entries: readonly BuildListEntry[]): { selected: CheckpointSelectionEntry[]; issues: InvalidPlannerInputIssue[] } {
  const selected: CheckpointSelectionEntry[] = []
  const issues: InvalidPlannerInputIssue[] = []
  const codeOf = (issue: LegacyCheckpointSelectionIssue): string =>
    issue.code === 'unknown_opportunity' ? 'invalid_reference'
      : issue.code === 'group_selected_twice' ? 'invalid_state'
        : issue.code === 'group_id_invalid' ? 'invalid_id'
          : 'invalid_structure'
  for (const entry of [...entries].sort((left, right) => compareIds(left.id, right.id))) {
    const state = classifyLegacyCheckpointSelection(entry)
    if (state.kind === 'selected') selected.push({ buildListEntryId: entry.id, targetWeaponId: entry.targetWeaponId })
    else if (state.kind === 'uninterpretable') {
      for (const issue of state.issues) {
        issues.push({
          path: `buildListEntries.${entry.id}.${issue.path}`,
          code: codeOf(issue),
          message: `BuildListEntry '${entry.id}' carries a calculation schema 10 checkpoint selection (${LEGACY_CHECKPOINT_SELECTION_FIELD}) that cannot be read as one (${issue.path}: ${issue.message}). It is never read as no selection; search its Target again and replace the BuildListEntry.`,
        })
      }
    }
  }
  return { selected, issues }
}

/**
 * The 17.4 reasons with the schema 10 selections merged into the one `checkpoint_selection` reason (Entries by stable ID, each
 * once), inserted where the 17.4 order places it (after `unconfirmed_rng_state`) when no schema 11..18 selection raised it.
 */
function mergeLegacyCheckpointSelections(reasons: BuildListOptimizationUnsupportedReason[], legacy: readonly CheckpointSelectionEntry[]): BuildListOptimizationUnsupportedReason[] {
  if (legacy.length === 0) return reasons
  const existing = reasons.find((reason): reason is Extract<BuildListOptimizationUnsupportedReason, { kind: 'checkpoint_selection' }> => reason.kind === 'checkpoint_selection')
  const byId = new Map<string, CheckpointSelectionEntry>()
  for (const entry of [...(existing?.entries ?? []), ...legacy]) byId.set(entry.buildListEntryId, entry)
  const entries = [...byId.values()].sort((left, right) => compareIds(left.buildListEntryId, right.buildListEntryId))
  const merged: Extract<BuildListOptimizationUnsupportedReason, { kind: 'checkpoint_selection' }> = { kind: 'checkpoint_selection', entries }
  if (existing !== undefined) return reasons.map(reason => (reason === existing ? merged : reason))
  const after = reasons.findIndex(reason => reason.kind === 'unconfirmed_rng_state')
  return [...reasons.slice(0, after + 1), merged, ...reasons.slice(after + 1)]
}

/**
 * The caller contracts of one replan re-optimization input: no conflict resolution (a fresh input), a replan target set that is the
 * classification's own (`continuing` then `added`, no repeat), and every replan Target present once in the input and usable. Throws
 * a `RangeError` / `RunningPlanReplanOptimizationInputError`; never corrects the set.
 */
export function assertRunningPlanReplanOptimizationInput(input: RunningPlanReplanOptimizationInput): void {
  const { plannerInput, replanTargets } = input
  if (plannerInput.conflictResolutions.length > 0) {
    throw new RangeError('The running Plan replan re-optimization reads no conflict resolution: its input carries conflictResolutions = [].')
  }
  const ids = replanTargets.replanTargetWeaponIds
  const expected = [...replanTargetWeaponIdsOf(replanTargets, 'continuing'), ...replanTargetWeaponIdsOf(replanTargets, 'added')]
  if (new Set(ids).size !== ids.length || ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    throw new RunningPlanReplanOptimizationInputError('replan_target_set_inconsistent',
      `The replan target set [${ids.join(', ')}] is not the classification's continuing then added Targets [${expected.join(', ')}].`)
  }
  for (const id of ids) {
    const matches = plannerInput.targetWeapons.filter(target => target.id === id)
    if (matches.length !== 1 || !isTargetWeaponPlanningEligible(matches[0]!)) {
      throw new RunningPlanReplanOptimizationInputError('replan_target_not_usable',
        `Replan Target ${id} is ${matches.length === 0 ? 'missing from' : matches.length > 1 ? 'repeated in' : 'not usable (completed or disabled) in'} the input.`)
    }
  }
}

/** Stage 0R: the scope Stage A - D' run over, or every input condition that does not hold. */
export type RunningPlanReplanOptimizationPreparation =
  | { kind: 'unsupported'; reasons: RunningPlanReplanOptimizationUnsupportedReason[] }
  | {
      kind: 'ready'
      /** The replan Targets as planning Targets (Target ID order), over the input scoped to their current Entries. */
      scope: BuildListOptimizationScope
      /** The scoped input (`buildListEntries` = the replan Targets' current Entries, in input order; every Target kept). */
      scopedInput: PlannerInput
    }

/**
 * Stage 0R of the replan re-optimization (`docs/PLANNER_SPEC.md` 18.5 / 18.6): the 18.5 input conditions over the replan target set,
 * and the scope of the calculation. Pure apart from the Engine's support queries (nothing is predicted); usable before a calculation
 * starts (a pre-start display) as well as by the calculation itself. Throws for a broken caller contract
 * (`assertRunningPlanReplanOptimizationInput()`).
 *
 * - an empty set is `no_replan_target`, alone
 * - the input validation of the scoped input (with the default Planner options, so the 「最大計画ステップ数」 setting never decides) and
 *   the Build List cardinality of every replan Target - two or more current Entries, stale ones included - fail the whole set closed
 *   as `invalid_planner_input`, alone
 * - otherwise every Build List optimization reason (17.4) that holds over the replan Targets, by the same rule
 *   (`deriveBuildListOptimizationUnsupportedReasons()`): a selected intermediate state on a replan Target's current Entry - stale or
 *   not, never cleared - is `checkpoint_selection`
 * - the calculation schema 10 checkpoint selection (`selectedCheckpointOpportunityIds`, an untyped field the shared rule never
 *   reads; Issue #336 PR-2) of a replan Target's current Entry, by the schema 10 contract: a selection kept as schema 10 accepted
 *   it joins `checkpoint_selection`, a field schema 10 could not read is `invalid_planner_input` (alone, with the broken selection's
 *   path), and an absent field or `[]` is no selection. Judged here only: the Build List optimization (17.4), the ordinary Planner
 *   and the Plan hash normalization never read it
 *
 * A replan Target whose Entry is stale, excluded for another reason or missing stays a planning Target: Entries decide nothing about
 * the set.
 */
export function prepareRunningPlanReplanOptimization(input: RunningPlanReplanOptimizationInput, dependencies: PlannerDependencies): RunningPlanReplanOptimizationPreparation {
  assertRunningPlanReplanOptimizationInput(input)
  const { plannerInput, replanTargets } = input
  const replanIds = new Set<string>(replanTargets.replanTargetWeaponIds)
  if (replanIds.size === 0) return { kind: 'unsupported', reasons: [{ kind: 'no_replan_target' }] }

  const scopedInput: PlannerInput = { ...plannerInput, buildListEntries: plannerInput.buildListEntries.filter(entry => replanIds.has(entry.targetWeaponId)) }
  const validation = validatePlannerInput(scopedInput, dependencies, PERSISTED_PLANNER_BUILD_LIST_CONTEXT, validatePlannerOptions(defaultPlannerOptions))
  // The input validation fails only a duplicate of a Target with a valid Entry closed; a replan Target's duplicate counts with stale
  // Entries too (18.6: a replan Target holds 0 or 1 current Entry), through the Build List cardinality authority.
  const validationPlanning = new Set<string>(derivePlannerPlanningTargets(scopedInput.targetWeapons, validation.validBuildListEntries).map(({ id }) => id))
  const cardinality = validateBuildListCardinality(scopedInput.buildListEntries.filter(entry => !validationPlanning.has(entry.targetWeaponId)))
  // The calculation schema 10 selections of the scope Entries (Issue #336 PR-2): the current input validation reads only the
  // schema 11..18 `intermediateStateSelection`, so the schema 10 field is judged here, in Stage 0R alone.
  const legacy = classifyLegacyCheckpointSelections(scopedInput.buildListEntries)
  if (!validation.isValid || !cardinality.isValid || legacy.issues.length > 0) {
    return {
      kind: 'unsupported',
      reasons: [{ kind: 'invalid_planner_input', issues: [...validation.issues, ...cardinality.issues, ...legacy.issues].map(({ path, code, message }) => ({ path, code, message })) }],
    }
  }

  const planningTargets = plannerInput.targetWeapons.filter(target => replanIds.has(target.id)).sort((left, right) => compareIds(left.id, right.id))
  const context: BuildListOptimizationContext = {
    plannerInput: scopedInput,
    validation,
    planningTargets: Object.freeze([...planningTargets]),
    planningTargetIds: new Set(planningTargets.map(target => target.id)),
  }
  const reasons = mergeLegacyCheckpointSelections(deriveBuildListOptimizationUnsupportedReasons(context, dependencies.rngEngine), legacy.selected)
  const unsupported = reasons.filter((reason): reason is Extract<BuildListOptimizationUnsupportedReason, RunningPlanReplanOptimizationUnsupportedReason> =>
    reason.kind !== 'running_plan_exists' && reason.kind !== 'no_planning_target')
  if (unsupported.length !== reasons.length) {
    throw new BuildListOptimizationInvariantError('stage_contract_violation', 'The precondition rule returned a reason that is no ReachTable precondition.')
  }
  if (unsupported.length > 0) return { kind: 'unsupported', reasons: unsupported }
  return { kind: 'ready', scope: { context, inputExclusions: [], entryChanges: 'replace_or_add' }, scopedInput }
}

/**
 * The input token of a replan re-optimization over `scopedInput` whose final Plan is `plan`. The Plan must have been calculated over
 * the input's Targets (its `targetWeaponsHash` is checked as an internal invariant, never an adoption authority).
 */
export function deriveRunningPlanReplanOptimizationInputToken(scopedInput: PlannerInput, replanTargetWeaponIds: readonly TargetWeaponId[],
  plan: Pick<ProductionPlan, 'baseSnapshot'>): RunningPlanReplanOptimizationInputToken {
  if (plan.baseSnapshot.targetWeaponsHash !== createPlanningTargetWeaponsHash(scopedInput.targetWeapons)) {
    throw new BuildListOptimizationInvariantError('final_input_invariant', 'The final Plan was calculated over other Targets than the input.')
  }
  return {
    initialExecutionState: structuredClone(plan.baseSnapshot.initialExecutionState),
    replanTargetDefinitionsHash: createDependentTargetDefinitionsHash(scopedInput.targetWeapons, replanTargetWeaponIds),
    scopeBuildListEntriesHash: createPlanningBuildListEntriesHash(scopedInput.buildListEntries),
    calculationContext: structuredClone(scopedInput.calculationContext),
  }
}

/**
 * The Entry changes of a replan re-optimization against its scope (18.6 / 18.8 [P1]): each replan Target is exactly one of replaced
 * (its one current Entry is the replaced `O`), added (it held no Entry) or unchanged (its one current Entry is selected as it is); every
 * generated Entry is the `G` of exactly one replacement or addition, for its own Target; nothing names a Target outside the set; and the
 * final Plan selects exactly the replan Targets' final Entries. An issue is never corrected.
 */
export function runningPlanReplanEntryChangeIssues(
  scopeEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[],
  replanTargetWeaponIds: readonly TargetWeaponId[],
  changes: Pick<RunningPlanReplanOptimizationArtifact, 'generatedBuildListEntries' | 'replacements' | 'additions' | 'unchangedTargetWeaponIds'>,
  selectedBuildListEntryIds: readonly BuildListEntryId[],
): string[] {
  const issues: string[] = []
  const replanIds = new Set<string>(replanTargetWeaponIds)
  const scopeIdsOf = (targetWeaponId: string) => scopeEntries.filter(entry => entry.targetWeaponId === targetWeaponId).map(({ id }) => id as string)
  const classified = new Map<string, string>()
  const classify = (targetWeaponId: string, kind: string) => {
    if (!replanIds.has(targetWeaponId)) issues.push(`${kind} Target ${targetWeaponId} is outside the replan target set.`)
    const earlier = classified.get(targetWeaponId)
    if (earlier !== undefined) issues.push(`Target ${targetWeaponId} is both ${earlier} and ${kind}.`)
    else classified.set(targetWeaponId, kind)
  }
  const generatedById = new Map(changes.generatedBuildListEntries.map(entry => [entry.id as string, entry]))
  const pairedGenerated: string[] = []
  const finalEntryIds: string[] = []
  for (const { targetWeaponId, replacedBuildListEntryId, generatedBuildListEntryId } of changes.replacements) {
    classify(targetWeaponId, 'replaced')
    const current = scopeIdsOf(targetWeaponId)
    if (current.length !== 1 || current[0] !== replacedBuildListEntryId) issues.push(`Replaced Entry ${replacedBuildListEntryId} is not Target ${targetWeaponId}'s one current Entry.`)
    if (generatedById.get(generatedBuildListEntryId)?.targetWeaponId !== targetWeaponId) issues.push(`Replacement Entry ${generatedBuildListEntryId} is no generated Entry of Target ${targetWeaponId}.`)
    pairedGenerated.push(generatedBuildListEntryId)
    finalEntryIds.push(generatedBuildListEntryId)
  }
  for (const { targetWeaponId, generatedBuildListEntryId } of changes.additions) {
    classify(targetWeaponId, 'added')
    if (scopeIdsOf(targetWeaponId).length !== 0) issues.push(`Added Target ${targetWeaponId} holds a current Entry.`)
    if (generatedById.get(generatedBuildListEntryId)?.targetWeaponId !== targetWeaponId) issues.push(`Added Entry ${generatedBuildListEntryId} is no generated Entry of Target ${targetWeaponId}.`)
    pairedGenerated.push(generatedBuildListEntryId)
    finalEntryIds.push(generatedBuildListEntryId)
  }
  for (const targetWeaponId of changes.unchangedTargetWeaponIds) {
    classify(targetWeaponId, 'unchanged')
    const current = scopeIdsOf(targetWeaponId)
    if (current.length !== 1) issues.push(`Unchanged Target ${targetWeaponId} does not hold exactly one current Entry.`)
    else finalEntryIds.push(current[0]!)
  }
  for (const id of replanTargetWeaponIds) if (!classified.has(id)) issues.push(`Replan Target ${id} is neither replaced, added nor unchanged.`)
  if (new Set(pairedGenerated).size !== pairedGenerated.length || pairedGenerated.length !== generatedById.size
    || [...generatedById.keys()].some(id => !pairedGenerated.includes(id))) {
    issues.push('The generated Entries are not exactly the replacing and added Entries, once each.')
  }
  const selected = [...selectedBuildListEntryIds].map(String).sort(compareIds)
  if (selected.length !== finalEntryIds.length || [...finalEntryIds].sort(compareIds).some((id, index) => id !== selected[index])) {
    issues.push('The final Plan does not select exactly the replan Targets\' final Entries.')
  }
  return issues
}

/**
 * Runs one running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.6). `dependencies` are the Production Planner's (Engine,
 * Production ID factory, Production Clock); `bounds` are the caller's - the Build List optimization's Production bounds (17.13, R5
 * keeps them shared until PR-7 measures) -, asserted with no default, fallback or clamp. Throws a `RangeError` for invalid bounds or an
 * input carrying conflict resolutions, `RunningPlanReplanOptimizationInputError` for a replan target set that is not the input's,
 * and `BuildListOptimizationInvariantError` / `BuildListOptimizationMaterializationError` / a Planner error for a broken contract
 * (never a result). A cancellation is `{ kind: 'cancelled' }`; no result is ever turned into an ordinary Planner run.
 */
export async function runRunningPlanReplanOptimization(input: RunningPlanReplanOptimizationInput, dependencies: PlannerDependencies,
  bounds: BuildListOptimizationBounds, execution: BuildListOptimizationExecution = {}): Promise<RunningPlanReplanOptimizationRun> {
  assertBuildListOptimizationBounds(bounds)
  assertRunningPlanReplanOptimizationInput(input)
  const tracker = createBuildListOptimizationStageTracker(execution)

  // Stage 0R.
  tracker.enter('input_check')
  const prepared = prepareRunningPlanReplanOptimization(input, dependencies)
  if (prepared.kind === 'unsupported') {
    tracker.close()
    return { kind: 'result', result: { status: 'unsupported', reasons: prepared.reasons } }
  }
  if (execution.shouldCancel?.()) {
    tracker.close()
    return { kind: 'cancelled' }
  }

  // Stage A - D': the Build List optimization's own core over the replan scope.
  const outcome = await runBuildListOptimizationStages(prepared.scope, dependencies, bounds, execution, tracker)
  if (outcome.kind === 'cancelled') return { kind: 'cancelled' }
  if (outcome.kind === 'concluded') return { kind: 'result', result: outcome.result }
  const { verdict } = outcome
  const plan = verdict.plannerResult.plan!
  const replanTargetWeaponIds = [...input.replanTargets.replanTargetWeaponIds]
  const changes = {
    generatedBuildListEntries: verdict.finalInput.generatedBuildListEntries,
    replacements: verdict.finalInput.replacements,
    additions: verdict.finalInput.additions,
    unchangedTargetWeaponIds: verdict.finalInput.unchangedTargetWeaponIds,
  }
  const issues = runningPlanReplanEntryChangeIssues(prepared.scopedInput.buildListEntries, replanTargetWeaponIds, changes, plan.selectedBuildListEntryIds)
  if (issues.length > 0) throw new BuildListOptimizationInvariantError('final_input_invariant', issues.join(' '))
  return {
    kind: 'result',
    result: {
      status: 'optimized',
      artifact: {
        planId: input.replanTargets.planId,
        replanTargetWeaponIds,
        plannerResult: verdict.plannerResult,
        ...changes,
        inputToken: deriveRunningPlanReplanOptimizationInputToken(prepared.scopedInput, replanTargetWeaponIds, plan),
        summary: buildListOptimizationPlanSummaryOf(verdict, outcome.structuralObjective),
        diagnostics: tracker.diagnostics,
      },
    },
  }
}
