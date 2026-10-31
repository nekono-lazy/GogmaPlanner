import type {
  BuildListEntry,
  BuildListEntryId,
  BuildListEntryStaleReason,
  ExecutionHistory,
  NormalArtianCounter,
  ProductionPlan,
  ProductionPlanId,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { isTargetWeaponPlanningEligible } from '../models/publicTypes'
import { collectProductionPlanTargetCompletionTargetWeaponIds } from '../planner/productionPlanCompletionSummary'
import { deriveExecutionReidentificationReminder, type UnresolvedActualResultDivergence } from './reidentificationReminder'

/**
 * The running Plan replan derivations of Issue #276 (`docs/PLANNER_SPEC.md` 18.2 / 18.3 / 18.5): which Targets a replan from the
 * current point covers, whether the running Plan allows one at all, and whether a Build List change just saved should propose one.
 *
 * Pure and read-only: every input is passed in - the Application reads the persisted state - and nothing here reads or writes
 * IndexedDB, predicts RNG, runs a Planner or holds screen text. The replan target selection (exclusions and inclusions) is
 * runtime-only input; no derivation persists it, and none changes a TargetWeapon, a BuildListEntry or an OwnedWeapon.
 *
 * The old Plan's planned Targets come only from `steps[].executionEffects.targetCompletions`
 * (`collectProductionPlanTargetCompletionTargetWeaponIds()`, the 9.6.9.1 authority), and whether the old Plan completed one only from
 * the current TargetWeapon's `lifecycleStatus` / `completedByProductionPlanId`. A Step's `isCompleted`, the Plan's
 * `selectedBuildListEntryIds` / `rejectedBuildListEntries`, the Plan-dependent Targets, an Entry's staleness or count and every
 * timestamp are never read for them. Counts are distinct Targets, never Entries.
 *
 * The input conditions of the replan target set (18.5: `no_replan_target`, `invalid_planner_input`, `checkpoint_selection`, ...) are
 * Stage 0R of the calculation (18.6) and are not judged here.
 */

/** The Plan fields the replan derivations read. */
export type ReplanSourcePlan = Pick<ProductionPlan, 'id' | 'status' | 'steps' | 'recalculationReasons'>

type ReplanRngProvenance = Pick<RngState, 'baseSeed' | 'gogmaCounter' | 'skillCounter' | 'lastIdentifiedAt'>
type ReplanNormalCounterProvenance = Pick<NormalArtianCounter, 'id' | 'counter' | 'isConfirmed' | 'lastIdentifiedAt'>
type ReplanTargetWeapon = Pick<
  TargetWeapon,
  'id' | 'isEnabled' | 'lifecycleStatus' | 'completedByProductionPlanId' | 'completionConditionReview'
>

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function isRunningPlan(plan: Pick<ProductionPlan, 'status'>): boolean {
  return plan.status === 'active' || plan.status === 'stale'
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Availability (18.5, per old Plan)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Why the running Plan allows no replan (`docs/PLANNER_SPEC.md` 18.5 「利用条件（旧Plan単位）」). None depends on the replan target set.
 * While any holds, the replan screen confirms no Target and no proposal is made (18.3); the ordinary Planner auxiliary is not offered.
 */
export type RunningPlanReplanUnavailableReason =
  /** The old Plan's planned Targets cannot be told: some Step has no `executionEffects` (a legacy Plan). Never read as "no Target". */
  | { kind: 'running_plan_targets_unknown' }
  /** The old Plan is `stale` with `execution_operation_uncertain`: the 16.15 recovery comes first. */
  | { kind: 'operation_uncertain_unresolved' }
  /**
   * `deriveExecutionReidentificationReminder()` reports an unresolved `actual_result_different` of the old Plan: the formal
   * re-identification of each listed stream comes first (16.15). A record already re-identified never refuses a replan.
   */
  | { kind: 'reidentification_required'; unresolved: UnresolvedActualResultDivergence[] }

export type RunningPlanReplanAvailability<P extends ReplanSourcePlan = ReplanSourcePlan> =
  /** No `active` / `stale` Plan exists: there is nothing to replan from. */
  | { kind: 'no_running_plan' }
  /** Two or more Plans are `active` / `stale` (the 16.2 invariant is broken); no Plan is picked by guessing. IDs in ID order. */
  | { kind: 'multiple_running_plans'; runningPlanIds: ProductionPlanId[] }
  /** Every reason that holds, in the order of the 18.5 table. */
  | { kind: 'unavailable'; plan: P; reasons: RunningPlanReplanUnavailableReason[] }
  | { kind: 'available'; plan: P }

export interface RunningPlanReplanAvailabilityInput<P extends ReplanSourcePlan> {
  /** Every persisted ProductionPlan; the running one is found by status here, never trusted from the caller. */
  productionPlans: readonly P[]
  /** The persisted ExecutionHistory (every Plan's or the running Plan's; other Plans' records are ignored). */
  executionHistory: readonly ExecutionHistory[]
  rngState: ReplanRngProvenance | null
  normalCounters: readonly ReplanNormalCounterProvenance[]
}

/**
 * Whether the one running Plan allows a replan from the current point (`docs/PLANNER_SPEC.md` 18.5, per old Plan). Only the three
 * reasons of 18.5 refuse it: any other stale reason (`calculation_context_changed`, `rng_state_changed`, `owned_weapon_changed`,
 * `target_changed`, `build_list_changed`, ...), the ordinary Counter progress of confirmed Steps and the staleness of Build List
 * Entries it causes never do, because the replan calculates again from the current state.
 */
export function deriveRunningPlanReplanAvailability<P extends ReplanSourcePlan>(
  input: RunningPlanReplanAvailabilityInput<P>,
): RunningPlanReplanAvailability<P> {
  const running = input.productionPlans.filter(isRunningPlan)
  if (running.length === 0) return { kind: 'no_running_plan' }
  if (running.length > 1) {
    return { kind: 'multiple_running_plans', runningPlanIds: running.map(({ id }) => id).sort(compareIds) }
  }
  const plan = running[0]
  const reasons: RunningPlanReplanUnavailableReason[] = []
  if (collectProductionPlanTargetCompletionTargetWeaponIds(plan) === null) {
    reasons.push({ kind: 'running_plan_targets_unknown' })
  }
  if (plan.status === 'stale' && plan.recalculationReasons.includes('execution_operation_uncertain')) {
    reasons.push({ kind: 'operation_uncertain_unresolved' })
  }
  const reminder = deriveExecutionReidentificationReminder({
    plan,
    planExecutionHistory: input.executionHistory,
    rngState: input.rngState,
    normalCounters: input.normalCounters,
  })
  if (reminder.kind === 'actual_result_different') {
    reasons.push({ kind: 'reidentification_required', unresolved: reminder.unresolved })
  }
  return reasons.length === 0 ? { kind: 'available', plan } : { kind: 'unavailable', plan, reasons }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Replan target set (18.2)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Why an unfinished planned Target cannot be replanned (18.2 「対象外」). */
export type ReplanTargetNotEligibleReason =
  /** No TargetWeapon has the ID any more. */
  | 'deleted'
  /** Completed, but not by the old Plan (with an owned weapon, or by another Plan). */
  | 'completed_elsewhere'
  /** 検索対象OFF (`isEnabled = false`). */
  | 'disabled'
  /** The completion condition awaits the user's review and explicit save (`docs/DATA_MODEL.md` 8.6, Issue #100). */
  | 'completion_condition_review_required'

/**
 * The 18.2 categories. Every classified Target has exactly one.
 *
 * - `continuing` / `excluded`: an unfinished planned Target that can be replanned, kept by default / explicitly excluded
 * - `added` / `additional_candidate`: a Target that can be replanned, is not an unfinished planned Target and has at least one current
 *   Entry (stale or not), explicitly included / not included
 * - `completed`: a planned Target the old Plan completed
 * - `not_eligible`: an unfinished planned Target that cannot be replanned, with its reason
 */
export type ReplanTargetCategory = 'continuing' | 'excluded' | 'added' | 'additional_candidate' | 'completed' | 'not_eligible'

export type ReplanTargetRow =
  | { targetWeaponId: TargetWeaponId; category: Exclude<ReplanTargetCategory, 'not_eligible'> }
  | { targetWeaponId: TargetWeaponId; category: 'not_eligible'; reason: ReplanTargetNotEligibleReason }

/**
 * The user's runtime-only choice for one replan (18.2): which `continuing` Targets to leave out and which additional candidates to
 * take in. A set: order and repeated IDs change nothing. Never persisted.
 */
export interface ReplanTargetSelection {
  excludedTargetWeaponIds: readonly TargetWeaponId[]
  includedTargetWeaponIds: readonly TargetWeaponId[]
}

export const emptyReplanTargetSelection: ReplanTargetSelection = { excludedTargetWeaponIds: [], includedTargetWeaponIds: [] }

/** A selected ID the selection cannot apply to. Never ignored: the whole selection is refused. */
export interface ReplanTargetSelectionIssue {
  selection: 'exclude' | 'include'
  targetWeaponId: TargetWeaponId
  /**
   * What the Target is without any selection: its default category, `not_listed` for an existing Target that is neither a planned
   * Target nor an additional candidate, `unknown_target` for no such TargetWeapon. Only `continuing` can be excluded and only
   * `additional_candidate` included.
   */
  actual: 'continuing' | 'additional_candidate' | 'completed' | 'not_eligible' | 'not_listed' | 'unknown_target'
}

export interface ReplanTargetClassification {
  planId: ProductionPlanId
  /** The old Plan's planned Targets, in Step order (the 9.6.9.1 authority). */
  plannedTargetWeaponIds: readonly TargetWeaponId[]
  /** Planned Targets in Step order, then additional candidates (included or not) in ID order. */
  rows: readonly ReplanTargetRow[]
  /** The replan target set = `continuing` (Step order) followed by `added` (ID order). Empty when the user left nothing in it. */
  replanTargetWeaponIds: readonly TargetWeaponId[]
  /** Every additional candidate, included or not (`added` ∪ `additional_candidate`), in ID order: the 18.3 count is its length. */
  additionalCandidateTargetWeaponIds: readonly TargetWeaponId[]
}

export type ReplanTargetSetDerivation =
  /** The old Plan's planned Targets cannot be told (18.2): never an empty set. */
  | { kind: 'running_plan_targets_unknown' }
  /** Every selected ID the selection cannot apply to: excluded IDs then included IDs, each in ID order. */
  | { kind: 'invalid_selection'; issues: ReplanTargetSelectionIssue[] }
  | { kind: 'derived'; classification: ReplanTargetClassification }

export interface ReplanTargetSetInput {
  /** The old Plan, which must be `active` / `stale` (a caller contract). */
  plan: Pick<ProductionPlan, 'id' | 'status' | 'steps'>
  /** Every current TargetWeapon. */
  targetWeapons: readonly ReplanTargetWeapon[]
  /** Every current BuildListEntry, whatever its staleness. */
  buildListEntries: readonly Pick<BuildListEntry, 'targetWeaponId'>[]
  /** The user's selection; none means the default (every `continuing` kept, no additional candidate taken in). */
  selection?: ReplanTargetSelection
}

type ReplanTargetBaseRow =
  | { targetWeaponId: TargetWeaponId; category: 'continuing' | 'additional_candidate' | 'completed' }
  | { targetWeaponId: TargetWeaponId; category: 'not_eligible'; reason: ReplanTargetNotEligibleReason }

function indexTargets(targetWeapons: readonly ReplanTargetWeapon[]): Map<TargetWeaponId, ReplanTargetWeapon> {
  const byId = new Map<TargetWeaponId, ReplanTargetWeapon>()
  for (const target of targetWeapons) {
    if (byId.has(target.id)) throw new RangeError(`TargetWeapon ${target.id} appears more than once in the replan input.`)
    byId.set(target.id, target)
  }
  return byId
}

function notEligibleReasonOf(target: ReplanTargetWeapon | undefined): ReplanTargetNotEligibleReason | null {
  if (target === undefined) return 'deleted'
  if (target.lifecycleStatus === 'completed') return 'completed_elsewhere'
  if (!target.isEnabled) return 'disabled'
  if (target.completionConditionReview.length > 0) return 'completion_condition_review_required'
  return null
}

function plannedTargetRow(
  targetWeaponId: TargetWeaponId,
  target: ReplanTargetWeapon | undefined,
  planId: ProductionPlanId,
): ReplanTargetBaseRow {
  if (target?.lifecycleStatus === 'completed' && target.completedByProductionPlanId === planId) {
    return { targetWeaponId, category: 'completed' }
  }
  const reason = notEligibleReasonOf(target)
  return reason === null ? { targetWeaponId, category: 'continuing' } : { targetWeaponId, category: 'not_eligible', reason }
}

function uniqueSortedIds(ids: readonly TargetWeaponId[]): TargetWeaponId[] {
  return [...new Set(ids)].sort(compareIds)
}

/**
 * Classifies the Targets of a replan from the old Plan's records and the current Targets and Build List (`docs/PLANNER_SPEC.md`
 * 18.2), and applies the user's selection.
 *
 * - An unfinished planned Target stays `continuing` with no Entry, a stale Entry or an Entry the Planner input validation would
 *   exclude: an Entry decides nothing about it
 * - A planned Target the old Plan completed is `completed`; one reopened afterwards (`active` again) is unfinished
 * - A Target outside the planned Targets - the old Plan's rejected Entries' Targets included - is never taken in by itself: with a
 *   current Entry and usable it is an `additional_candidate` the user may include
 * - A selected ID that is unknown, or whose Target the selection cannot apply to, refuses the whole selection
 *
 * Deterministic: the order of `targetWeapons`, `buildListEntries` and the selection, and repeated IDs in them, change nothing.
 * Throws a `RangeError` when the Plan is not running or a TargetWeapon ID is repeated (caller contracts).
 */
export function deriveReplanTargetSet(input: ReplanTargetSetInput): ReplanTargetSetDerivation {
  const { plan } = input
  if (!isRunningPlan(plan)) {
    throw new RangeError(`The replan target set is derived from a running Plan, but ${plan.id} is ${plan.status}.`)
  }
  const planned = collectProductionPlanTargetCompletionTargetWeaponIds(plan)
  if (planned === null) return { kind: 'running_plan_targets_unknown' }
  const targetsById = indexTargets(input.targetWeapons)
  const plannedIds = new Set(planned)
  const baseRows: ReplanTargetBaseRow[] = planned.map((id) => plannedTargetRow(id, targetsById.get(id), plan.id))
  const candidateIds = uniqueSortedIds(input.buildListEntries.map(({ targetWeaponId }) => targetWeaponId)).filter((id) => {
    const target = targetsById.get(id)
    return !plannedIds.has(id) && target !== undefined && isTargetWeaponPlanningEligible(target)
  })
  for (const targetWeaponId of candidateIds) baseRows.push({ targetWeaponId, category: 'additional_candidate' })

  const baseCategoryById = new Map(baseRows.map((row) => [row.targetWeaponId, row.category]))
  const actualOf = (id: TargetWeaponId): ReplanTargetSelectionIssue['actual'] =>
    baseCategoryById.get(id) ?? (targetsById.has(id) ? 'not_listed' : 'unknown_target')
  const selection = input.selection ?? emptyReplanTargetSelection
  const excluded = uniqueSortedIds(selection.excludedTargetWeaponIds)
  const included = uniqueSortedIds(selection.includedTargetWeaponIds)
  const issues: ReplanTargetSelectionIssue[] = [
    ...excluded
      .filter((id) => actualOf(id) !== 'continuing')
      .map((targetWeaponId): ReplanTargetSelectionIssue => ({ selection: 'exclude', targetWeaponId, actual: actualOf(targetWeaponId) })),
    ...included
      .filter((id) => actualOf(id) !== 'additional_candidate')
      .map((targetWeaponId): ReplanTargetSelectionIssue => ({ selection: 'include', targetWeaponId, actual: actualOf(targetWeaponId) })),
  ]
  if (issues.length > 0) return { kind: 'invalid_selection', issues }

  const excludedIds = new Set(excluded)
  const includedIds = new Set(included)
  const rows: ReplanTargetRow[] = baseRows.map((row): ReplanTargetRow => {
    if (row.category === 'continuing' && excludedIds.has(row.targetWeaponId)) return { ...row, category: 'excluded' }
    if (row.category === 'additional_candidate' && includedIds.has(row.targetWeaponId)) return { ...row, category: 'added' }
    return row
  })
  return {
    kind: 'derived',
    classification: {
      planId: plan.id,
      plannedTargetWeaponIds: planned,
      rows,
      replanTargetWeaponIds: [
        ...rows.filter(({ category }) => category === 'continuing'),
        ...rows.filter(({ category }) => category === 'added'),
      ].map(({ targetWeaponId }) => targetWeaponId),
      additionalCandidateTargetWeaponIds: candidateIds,
    },
  }
}

/** The Targets of one category, in row order. */
export function replanTargetWeaponIdsOf(
  classification: Pick<ReplanTargetClassification, 'rows'>,
  category: ReplanTargetCategory,
): TargetWeaponId[] {
  return classification.rows.filter((row) => row.category === category).map(({ targetWeaponId }) => targetWeaponId)
}

/**
 * The additional candidates of the running Plan (`docs/PLANNER_SPEC.md` 18.3, the Build List's passive count): the distinct Targets
 * that can be replanned, are not unfinished planned Targets and hold a current Entry (stale or not), in ID order. The count is the
 * length. An unfinished planned Target is never counted again because of its stale Entry, and a Target the old Plan completed or that
 * was left out of an earlier replan is judged from the latest Plan's records and the current Build List like any other.
 */
export function deriveReplanAdditionalCandidates(
  input: Omit<ReplanTargetSetInput, 'selection'>,
): { kind: 'running_plan_targets_unknown' } | { kind: 'derived'; targetWeaponIds: readonly TargetWeaponId[] } {
  const derivation = deriveReplanTargetSet({ ...input, selection: emptyReplanTargetSelection })
  switch (derivation.kind) {
    case 'running_plan_targets_unknown': return derivation
    case 'derived': return { kind: 'derived', targetWeaponIds: derivation.classification.additionalCandidateTargetWeaponIds }
    case 'invalid_selection':
      throw new Error('An empty replan target selection cannot be invalid.')
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Proposal right after a Build List change (18.3)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The Build List operations whose save may propose a replan (18.3): a candidate added from Candidate Search, a confirmed replacement
 * of a Target's Entry, a batch search and addition, and a batch re-search and replacement of stale Entries (Issue #347).
 */
export type ReplanProposalBuildListOperation = 'candidate_addition' | 'candidate_replacement' | 'batch_addition' | 'batch_replacement'

/** One saved Build List operation, exactly as its save reported it. */
export interface ReplanProposalBuildListChange {
  operation: ReplanProposalBuildListOperation
  /**
   * The Entries the operation persisted (the added Entry, the replacing Entry, every Entry a batch added or replaced). Empty when the save failed
   * or wrote nothing (a duplicate, a replacement still to confirm, a legacy duplicate, a cancellation).
   */
  persistedBuildListEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[]
}

export interface ReplanProposalInput<P extends ReplanSourcePlan> {
  change: ReplanProposalBuildListChange
  /** The Build List as it was right before the operation. */
  buildListEntriesBefore: readonly Pick<BuildListEntry, 'id'>[]
  /** The persisted state right after the operation. */
  after: RunningPlanReplanAvailabilityInput<P> & {
    targetWeapons: readonly ReplanTargetWeapon[]
    buildListEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[]
  }
}

/** Why a saved operation proposes no replan. */
export type ReplanProposalSkipReason =
  /** The operation persisted no Entry that is new and still held: a failure, nothing written, or not an operation at all. */
  | 'nothing_persisted'
  | 'no_running_plan'
  | 'multiple_running_plans'
  /** The running Plan allows no replan (18.5, per old Plan). */
  | 'replan_unavailable'
  /** No Target the operation persisted is an additional candidate (an unfinished planned Target, a completed one, ...). */
  | 'no_new_additional_candidate'

/**
 * The outcome of one saved operation. Transient: it belongs to that operation's result display, is never persisted, and a closed
 * or unseen proposal is never shown again.
 */
export type ReplanProposal =
  | { kind: 'none'; reason: ReplanProposalSkipReason }
  /** The Targets the operation made available to take in, in ID order; the replan screen may start with them included. */
  | { kind: 'propose'; planId: ProductionPlanId; targetWeaponIds: TargetWeaponId[] }

/**
 * Whether a Build List operation just saved proposes a replan (`docs/PLANNER_SPEC.md` 18.3 「提案する（変更の直後）」).
 *
 * Only the operation's own persisted Entries can propose: each must be absent from the Build List before the operation and held
 * for the same Target after it, so a page display, a reload, a staleness re-evaluation, an Execution Step confirmation or a Target
 * that was already an additional candidate is never mistaken for a new addition. Its Target must be an additional candidate in the
 * state after the save, and the running Plan must allow a replan then (18.5, per old Plan). The replan target set's input
 * conditions are judged later, on the replan screen, and are no condition of the proposal.
 *
 * Throws a `RangeError` when a single-Target operation reports more than one persisted Entry (a caller contract).
 */
export function deriveReplanProposalAfterBuildListChange<P extends ReplanSourcePlan>(input: ReplanProposalInput<P>): ReplanProposal {
  const { change, after } = input
  if (change.operation !== 'batch_addition' && change.operation !== 'batch_replacement' && change.persistedBuildListEntries.length > 1) {
    throw new RangeError(`A ${change.operation} persists at most one BuildListEntry.`)
  }
  const before = new Set(input.buildListEntriesBefore.map(({ id }) => id))
  const afterTargetByEntryId = new Map(after.buildListEntries.map(({ id, targetWeaponId }) => [id, targetWeaponId]))
  const persistedTargetIds = new Set(
    change.persistedBuildListEntries
      .filter(({ id, targetWeaponId }) => !before.has(id) && afterTargetByEntryId.get(id) === targetWeaponId)
      .map(({ targetWeaponId }) => targetWeaponId),
  )
  if (persistedTargetIds.size === 0) return { kind: 'none', reason: 'nothing_persisted' }

  const availability = deriveRunningPlanReplanAvailability(after)
  switch (availability.kind) {
    case 'no_running_plan': return { kind: 'none', reason: 'no_running_plan' }
    case 'multiple_running_plans': return { kind: 'none', reason: 'multiple_running_plans' }
    case 'unavailable': return { kind: 'none', reason: 'replan_unavailable' }
    case 'available': break
  }
  const candidates = deriveReplanAdditionalCandidates({
    plan: availability.plan,
    targetWeapons: after.targetWeapons,
    buildListEntries: after.buildListEntries,
  })
  if (candidates.kind !== 'derived') return { kind: 'none', reason: 'replan_unavailable' }
  const targetWeaponIds = candidates.targetWeaponIds.filter((id) => persistedTargetIds.has(id))
  return targetWeaponIds.length === 0
    ? { kind: 'none', reason: 'no_new_additional_candidate' }
    : { kind: 'propose', planId: availability.plan.id, targetWeaponIds }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// In-use stale Entries (18.3 「作成リスト上の状態表示」)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The stale reasons the `active` Plan's ordinary Step confirmations cause by themselves (18.1 背景): a confirmed Step advances the
 * Counters every Route of that stream reads (`rng_state_changed`) and updates the weapon in progress in place (`owned_weapon_changed`).
 */
const RUNNING_PLAN_PROGRESS_STALE_REASONS: ReadonlySet<BuildListEntryStaleReason> = new Set<BuildListEntryStaleReason>([
  'rng_state_changed',
  'owned_weapon_changed',
])

export interface RunningPlanInUseStaleEntriesInput {
  /** The running Plan as persisted. Only an `active` one has in-use stale Entries; any other status has none. */
  plan: Pick<ProductionPlan, 'id' | 'status' | 'steps' | 'selectedBuildListEntryIds'>
  /** Every current TargetWeapon. */
  targetWeapons: readonly ReplanTargetWeapon[]
  /** The Build List with the staleness evaluated from the current state (never the persisted flag alone). */
  buildListEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId' | 'isStale' | 'staleReasons'>[]
}

/**
 * The Build List Entries the `active` running Plan keeps using whose staleness is only what its own planned progress caused
 * (`docs/PLANNER_SPEC.md` 18.3, `docs/UI_FLOW.md` 10 / 16.5): the Build List says the Plan simply continues instead of asking for a
 * new search. An Entry qualifies when all of the following hold:
 *
 * - the Plan is `active` (a `stale` Plan cannot continue, so its Entries keep the ordinary stale guidance)
 * - the Plan uses the Entry: it is one of the Plan's `selectedBuildListEntryIds` (the Plan-dependent Entries); a Target ID match alone
 *   is never "in use"
 * - the Entry's Target is an unfinished planned Target of the Plan (18.2: a `targetCompletions` Target the Plan has not completed,
 *   judged from the current TargetWeapon's lifecycle). A Plan without that authority (a legacy Plan) has none
 * - the Entry is stale and every stale reason is `rng_state_changed` / `owned_weapon_changed`; any other reason
 *   (`target_definition_changed`, `calculation_context_changed`) keeps the ordinary guidance
 *
 * Display only: it changes no Entry, no staleness and no Planner input, and it never proposes a replan. IDs in Build List order.
 */
export function deriveRunningPlanInUseStaleBuildListEntryIds(input: RunningPlanInUseStaleEntriesInput): BuildListEntryId[] {
  const { plan } = input
  if (plan.status !== 'active') return []
  const planned = collectProductionPlanTargetCompletionTargetWeaponIds(plan)
  if (planned === null) return []
  const targetsById = indexTargets(input.targetWeapons)
  const unfinished = new Set(planned.filter((id) => plannedTargetRow(id, targetsById.get(id), plan.id).category !== 'completed'))
  const selected = new Set<BuildListEntryId>(plan.selectedBuildListEntryIds)
  return input.buildListEntries
    .filter((entry) => entry.isStale
      && entry.staleReasons.length > 0
      && entry.staleReasons.every((reason) => RUNNING_PLAN_PROGRESS_STALE_REASONS.has(reason))
      && selected.has(entry.id)
      && unfinished.has(entry.targetWeaponId))
    .map(({ id }) => id)
}
