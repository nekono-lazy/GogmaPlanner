import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  DomainValidationIssue,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  PlanConflict,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
  RngState,
  RouteOperation,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import type {
  ArtianBonusTypeMapping,
  BonusRankMaster,
  BonusTypeMaster,
  ElementMaster,
  MaterialCostMaster,
  WeaponBonusDefinition,
  WeaponTypeMaster,
} from '../master/masterTypes'
import type { RngEngine } from '../rng/rngEngine'
import type { BuildListEntryReplacement } from '../buildList/buildListEntryReplacement'
import type { PlannerLaneProgress } from './plannerRouteLanes'
import type { PlannerConflictResolutionOutcome } from './plannerConflictPreferenceOutcome'

/**
 * The Production Planner bounds (Issue #103 Phase D-2a, PLANNER_SPEC 7.2).
 *
 * The Production deterministic scheduler reads `maxPlanSteps` and nothing
 * else, so this is the whole Production shape. The Beam Search oracle's
 * `beamWidth` / `maxExpandedStates` live in its own `PlannerBeamSearchOptions`
 * (`plannerBeamSearchTypes.ts`) and never enter a Production `PlannerInput`,
 * Worker request or UI. It is runtime input only: `PlanningInputSnapshot`
 * has never persisted it.
 */
export interface PlannerOptions {
  /**
   * The one Production bound: the safety limit of the trace length the
   * deterministic scheduler may build, and the only Planner bound the Build
   * List detail settings expose.
   */
  maxPlanSteps: number
}

/**
 * The initial value of the Production Planner bound (PLANNER_SPEC 7.2).
 *
 * It is the *default* the Application caller starts from, not a floor or a
 * ceiling: the Build List detail settings let the user raise `maxPlanSteps`
 * for one calculation. `PlannerInput.options` remains the single Planner bound
 * authority, and no Worker or Domain module substitutes this value for a
 * caller-supplied one. `maxPlanSteps` is 1000 because the Phase B
 * representative fixtures need 330 / 398 actions
 * (`docs/ISSUE_103_SCHEDULER_PARITY_BENCHMARK.md`).
 */
export const defaultPlannerOptions: Readonly<PlannerOptions> = {
  maxPlanSteps: 1000,
}

/**
 * Which Production bound a full Planner run touched: `max_plan_steps` only
 * (Issue #103 Phase D-2a). The Beam Search oracle's own limit kind, which adds
 * `max_expanded_states`, is `PlannerBeamSearchLimitKind`.
 */
export type PlannerRunLimitKind = 'max_plan_steps'

export const plannerRunLimitKinds: readonly PlannerRunLimitKind[] = ['max_plan_steps']

/**
 * - `completed`  every planning Target reached Ideal
 * - `incomplete` a bound truncated the run first
 * - `exhausted`  the run ended on its own without completing every Target
 * - `cancelled`  the user stopped the run
 */
export type PlannerRunTerminationStatus =
  | 'completed'
  | 'incomplete'
  | 'exhausted'
  | 'cancelled'

/**
 * Typed full Planner run termination (PLANNER_SPEC 7.2.1), parameterised by
 * the limit kinds and the bounds of the run that produced it. The Production
 * shape (`PlannerRunTermination`) and the Beam Search oracle shape
 * (`PlannerBeamSearchTermination`) share one meaning, while a Production value
 * can never name a Beam-only bound.
 *
 * It is the UI, Application and Persistence control authority for whether a
 * calculation produced a usable Plan. `PlannerWarning` stays diagnostics: no
 * consumer may parse a warning message, and `reachedLimits` is not a copy of
 * the warning list either - a `completed` run can carry a reached bound, and a
 * run that never started carries none.
 *
 * Every field is plain structured-clone data, so it crosses the Worker boundary
 * unchanged and is never rebuilt on the other side. It is runtime result
 * metadata only: it is never persisted in `ProductionPlan`, `PlanStep`,
 * `BuildListEntry`, or the DB schema.
 */
export interface PlannerTerminationOf<TLimitKind extends string, TLimits> {
  status: PlannerRunTerminationStatus
  /** Empty unless a bound was touched; non-empty whenever `incomplete`. */
  reachedLimits: TLimitKind[]
  /** The bounds this run actually ran with. */
  limits: TLimits
  /**
   * A diagnostic count of the states the run constructed. For the Production
   * scheduler it is the number of applied actions (the start confirmations
   * excluded). It is never a Production bound and never a progress
   * denominator.
   */
  expandedStates: number
  completedTargetCount: number
  totalTargetCount: number
}

/**
 * The Production full Planner run termination: `reachedLimits` can only name
 * `max_plan_steps`, and `limits` is exactly the Production `PlannerOptions`.
 */
export type PlannerRunTermination = PlannerTerminationOf<PlannerRunLimitKind, PlannerOptions>

/** Carries no `LotteryMaster`: Planner calculation and Trace Replay never read one. */
export interface PlannerMasterSubset {
  /** Matches RngMasterSubset so trace replay can repeat Search predictions. */
  weaponBonusDefinitions: WeaponBonusDefinition[]
  materialCosts: MaterialCostMaster[]
  bonusRanks: BonusRankMaster[]
  /** Keep family resolution authority for Normal-side bonus types (`docs/RNG_SPEC.md` 6.1). */
  artianBonusTypeMappings: ArtianBonusTypeMapping[]
  /** Caller-supplied Production Gogma Reset availability inputs. */
  elements: ElementMaster[]
  /** Caller-supplied Production Gogma Reset availability inputs. */
  bonusTypes: BonusTypeMaster[]
  /** Caller-supplied Production Gogma Reset availability inputs. */
  weaponTypes: WeaponTypeMaster[]
}

/** A local choice for one stable conflict key, not a manual Plan order. */
export interface PlannerConflictResolution {
  conflictKey: string
  selectedBuildListEntryId: BuildListEntryId
}

/** Structured-clone input. Engine instances and runtime dependencies are excluded. */
export interface PlannerInput {
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  targetWeapons: TargetWeapon[]
  buildListEntries: BuildListEntry[]
  calculationContext: CalculationContext
  options: PlannerOptions
  master: PlannerMasterSubset
  conflictResolutions: PlannerConflictResolution[]
}

/** Current-state eligibility; the referenced input snapshot is never mutated. */
export interface ValidatedBuildListEntry {
  entry: BuildListEntry
  missingRngRequirements: string[]
}

export interface ExcludedBuildListEntry {
  entry: BuildListEntry
  reason: string
}

export interface TargetSatisfaction {
  targetWeaponId: TargetWeaponId
  hasPractical: boolean
  hasIdeal: boolean
  practicalOwnedWeaponIds: OwnedWeaponId[]
  idealOwnedWeaponIds: OwnedWeaponId[]
}

/** Planner-state form of Target satisfaction, indexed for direct lookup. */
export interface PlannerTargetSatisfaction {
  hasPractical: boolean
  hasIdeal: boolean
}

/** Immutable, branch-safe inventory used only by Planner calculations. */
export interface SimulatedInventory {
  ownedWeapons: OwnedWeapon[]
  consumedWeaponIds: OwnedWeaponId[]
  reservedWeaponIds: OwnedWeaponId[]
  createdWeaponIds: OwnedWeaponId[]
}

/**
 * How valuable selecting one BuildListEntry is in one state.
 *
 * There is no category term any more: every Candidate is a canonical Ideal
 * Candidate, so a per-Candidate category score would be a constant. Selected
 * compromise checkpoints are a hard constraint, never a score
 * (`docs/PLANNER_SPEC.md` 7.5.3).
 */
export interface CandidateScore {
  targetPriorityScore: number
  satisfactionScore: number
  distancePenalty: number
  conflictPenalty: number
  total: number
}

export interface PlannerSearchRngSnapshot {
  gogmaCounter: number | null
  skillCounter: number | null
  normalCounters: Array<{ id: string; counter: number | null }>
}

export interface PlannerSearchInventoryEffect {
  addedOwnedWeaponIds: OwnedWeaponId[]
  removedOwnedWeaponIds: OwnedWeaponId[]
  updatedOwnedWeaponIds: OwnedWeaponId[]
  reservedOwnedWeaponIds: OwnedWeaponId[]
  routeOutputChangedForEntryIds: BuildListEntryId[]
}

export interface PlannerSearchSatisfactionChange {
  targetWeaponId: TargetWeaponId
  before: PlannerTargetSatisfaction
  after: PlannerTargetSatisfaction
}

export interface PlannerSearchRoutePosition {
  operationIndex: number
  unitIndex: number
  unitCount: number
}

export interface PlannerSearchRouteAction {
  kind: 'route_operation'
  actionType: RouteOperation['type']
  primaryBuildListEntryId: BuildListEntryId
  progressedBuildListEntryIds: BuildListEntryId[]
  progressedRoutePositions: Record<string, PlannerSearchRoutePosition>
  routeOperation: RouteOperation
  ownedWeaponId: OwnedWeaponId | null
  plannerOnly: false
  rngBefore: PlannerSearchRngSnapshot
  rngAfter: PlannerSearchRngSnapshot
  inventoryEffect: PlannerSearchInventoryEffect
  satisfactionChanges: PlannerSearchSatisfactionChange[]
}

export interface PlannerSearchReserveAction {
  kind: 'reserve_candidate'
  actionType: 'reserve_weapon'
  primaryBuildListEntryId: BuildListEntryId
  progressedBuildListEntryIds: BuildListEntryId[]
  progressedRoutePositions: Record<string, PlannerSearchRoutePosition>
  routeOperation: null
  ownedWeaponId: OwnedWeaponId
  plannerOnly: true
  rngBefore: PlannerSearchRngSnapshot
  rngAfter: PlannerSearchRngSnapshot
  inventoryEffect: PlannerSearchInventoryEffect
  satisfactionChanges: PlannerSearchSatisfactionChange[]
}

export type PlannerSearchAction =
  | PlannerSearchRouteAction
  | PlannerSearchReserveAction

export interface PlannerRouteRuntimeState {
  hasUnregisteredGogmaOutput: boolean
  transientRestorationBonusScope: 'normal_artian' | 'gogma_artian' | null
}

/**
 * The Planner search state a full Planner run drives (the scheduler updates
 * one in place; the Beam Search oracle keeps immutable copies). Trace actions
 * are not RouteOperations or PlanSteps.
 */
export interface PlannerSearchState {
  currentRngState: RngState
  currentNormalCounters: NormalArtianCounter[]
  simulatedInventory: SimulatedInventory
  targetSatisfaction: Record<TargetWeaponId, PlannerTargetSatisfaction>
  selectedBuildListEntryIds: BuildListEntryId[]
  /**
   * Units executed or silently passed per lane of each Entry's Route
   * (`docs/PLANNER_SPEC.md` 7.0.4). The base lane runs first; the Bonus and
   * Skill lanes advance independently, so the same Route can be executed in
   * many interleavings.
   */
  routeProgressByEntryId: Record<string, PlannerLaneProgress>
  routeRuntimeByEntryId: Record<string, PlannerRouteRuntimeState>
  /** Incremented whenever an existing Gogma's physical state is changed in-flight. */
  sourceMutationVersionByOwnedWeaponId: Record<string, number>
  /** Existing-source Candidate snapshots are reservable only at this recorded version. */
  candidateReadySourceVersionByEntryId: Record<string, number>
  /** The existing-source version each Route is currently allowed to continue from. */
  routeSourceVersionByEntryId: Record<string, number>
  /** Existing sources are excluded from satisfaction until a Candidate result is reserved. */
  inFlightExistingSourceByOwnedWeaponId: Record<string, true>
  securedOwnedWeaponIdByEntryId: Record<string, OwnedWeaponId>
  /**
   * Which Entries' compromise checkpoints this branch has actually reached:
   * the moment both lanes held their pinned state at once.
   *
   * A hard constraint's progress record, not a score: a branch may only secure
   * an Entry's Candidate once the checkpoint the user selected for it has
   * really been reached (`docs/PLANNER_SPEC.md` 7.5.3).
   */
  reachedCheckpointByEntryId: Record<string, true>
  trace: PlannerSearchAction[]
  /**
   * How many times the player has to put one weapon down and pick another one
   * up while executing this branch's operations so far.
   *
   * Plan quality only, never correctness: a branch with more switches is still
   * a fully executable Plan, so this must not prune, block, or reject an
   * expansion (`docs/PLANNER_SPEC.md` 7.3).
   */
  weaponSwitchCount: number
  /**
   * How much of this branch's progress has been made on Routes that start from
   * their Target's preferred owned weapon.
   *
   * Plan preference only, never correctness or feasibility: it sits below every
   * existing evaluation term and above `weaponSwitchCount` in
   * `comparePlannerSearchStates()`, so it decides nothing except which of two
   * otherwise equally rated branches survives (`docs/PLANNER_SPEC.md` 7.4).
   */
  preferredSourceProgressCount: number
  /**
   * How many stream-lane operations this branch executed against an Entry's
   * improvement preference: a Bonus amendment while a `skill_first` Entry
   * still had Skill lane units left, or the mirror image, counted only once
   * that Entry's compromise checkpoint was reached (or from the start when it
   * selected none).
   *
   * Plan preference only, never correctness or feasibility: it sits below the
   * preferred-source preference and above `weaponSwitchCount` in
   * `comparePlannerSearchStates()` (`docs/PLANNER_SPEC.md` 7.6).
   */
  improvementPreferenceViolationCount: number
  /**
   * The weapon subject of the most recent switch-counted operation, or `null`
   * before the branch has run one. Operations with no continuously operated
   * subject - `reserve_weapon` above all - leave it untouched, so they never
   * split one weapon's run of operations in two.
   */
  lastWeaponOperationSubjectKey: string | null
  totalCost: number
  evaluationScore: number
}

export type PlannerSearchRejectionReason =
  | 'counter_before_current'
  | 'counter_after_mismatch'
  | 'counter_unavailable'
  | 'inventory_precondition_failed'
  | 'protected_destructive_use'
  | 'conflict_resolution_not_selected'
  | 'candidate_already_satisfied'
  | 'rng_contract_unavailable'
  /**
   * The compromise checkpoint the user selected for this BuildListEntry was
   * not reached: its Candidate may not be secured yet, and a lane may not run
   * past its pinned state before the other lane arrived (PLANNER_SPEC 7.5.3).
   */
  | 'selected_checkpoint_not_reached'
  /**
   * The deterministic scheduler did not commit this BuildListEntry, or dropped
   * it from its commitment, because of a resource conflict it had to settle
   * without an explicit `PlannerConflictResolution`: the provisional outcome of
   * an unresolved conflict, or a deadlock / stall
   * (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 6.5 / 7.8 / 8.4).
   * Runtime-only; the Beam Search never produces it, and the persisted
   * `RejectedBuildListEntry` reports it as `resource_conflict`.
   */
  | 'conflict_not_committed'

export interface PlannerSearchRejection {
  buildListEntryId: BuildListEntryId
  actionType: RouteOperation['type'] | 'reserve_weapon'
  reason: PlannerSearchRejectionReason
  detail: string
}

/**
 * The result of one full Planner run, parameterised by its termination shape.
 *
 * `PlannerRunResult` is the Production (deterministic scheduler) result;
 * `PlannerBeamSearchResult` (`plannerBeamSearchTypes.ts`) is the Beam Search
 * oracle's. Both carry the same fields, so the shared helpers need no copy.
 */
export interface PlannerRunResultOf<TTermination> {
  bestState: PlannerSearchState | null
  conflicts: PlanConflict[]
  warnings: PlannerWarning[]
  validationIssues: DomainValidationIssue[]
  excludedBuildListEntries: ExcludedBuildListEntry[]
  rejections: PlannerSearchRejection[]
  expandedStates: number
  completed: boolean
  cancelled: boolean
  /**
   * The typed termination of this run (PLANNER_SPEC 7.2.1).
   *
   * `completed`, `cancelled` and `expandedStates` above keep their existing
   * meaning for the Domain consumers that already read them; `termination` is
   * the authority everything outside the Domain reads, because it also carries
   * which bound was touched, the bounds this run used, and how many Targets
   * were completed.
   */
  termination: TTermination
  /**
   * The deterministic scheduler's route commitment decisions of this run
   * (`PlannerRouteCommitmentEvidence`). Runtime-only: never persisted, never in
   * a `PlannerResult`, a `ProductionPlan`, a Worker message or Export. Absent
   * when no route commitment ran (an input finished before scheduling, and
   * every Beam Search oracle result).
   */
  routeCommitment?: PlannerRouteCommitmentEvidence
}

/**
 * One provisional outcome of route commitment (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md`
 * 6.5): at the collision `conflictId` of an unresolved conflict - no explicit
 * `PlannerConflictResolution` chose - commitment kept `selectedBuildListEntryId`
 * and dropped `rejectedBuildListEntryIds`. It is recorded where commitment
 * takes that decision, never reconstructed from a final selection, a priority,
 * a score or `recommendedBuildListEntryId`.
 */
export interface PlannerConflictProvisionalOutcome {
  conflictId: string
  selectedBuildListEntryId: BuildListEntryId
  rejectedBuildListEntryIds: BuildListEntryId[]
}

/** The final route commitment state of one searchable Entry of a scheduler run. */
export interface PlannerRouteCommitmentEntryEvidence {
  buildListEntryId: BuildListEntryId
  status: 'committed' | 'secured' | 'not_needed' | 'released' | 'dropped'
  /**
   * Set only when the Entry's final state is the drop a provisional outcome
   * decided - that decision was its terminal and only drop (a dropped Entry is
   * never committed again) - naming that outcome's conflict and winner.
   * `null` for every other status or drop cause: an explicit resolution, a
   * precondition, a source, a stall / deadlock, a rejected action or reserve.
   */
  provisionalOutcome: { conflictId: string; selectedBuildListEntryId: BuildListEntryId } | null
  /**
   * Set only when the Entry's final state is the deadlock / stall drop of the
   * scheduler (`dropStuckEntry()`, design 7.8) - also a terminal and only drop -
   * recording one fact that drop already had (Issue #121,
   * `docs/PLANNER_SPEC.md` 9.6.9.1): whether the `pending` it dropped from held
   * another committed Entry with remaining units. Recording it changes no
   * decision. `null` for every other status or drop cause, a provisional
   * outcome included. Deadlock and stall are not told apart.
   */
  stuckDrop: { otherPendingRoutes: boolean } | null
  /** The typed rejection reasons the run recorded for this Entry, in order. */
  rejectionReasons: PlannerSearchRejectionReason[]
}

/**
 * Transient evidence of the route commitment decisions of one deterministic
 * scheduler run, for the Planner Alternative found judgement
 * (`docs/PLANNER_SPEC.md` 9.2.19.6), the conflict preference outcome (9.6.6)
 * and the `resourceConflictCause` of the rejected Build List record (9.6.9.1),
 * which must know why an Entry was not selected: the persisted reason alone
 * cannot tell a provisional loser whose winner later stalled from an Entry that
 * won and then stalled itself.
 */
export interface PlannerRouteCommitmentEvidence {
  provisionalOutcomes: PlannerConflictProvisionalOutcome[]
  /** Every searchable Entry, in stable ID order. */
  entries: PlannerRouteCommitmentEntryEvidence[]
}

/**
 * The Production full Planner run result: the deterministic scheduler's
 * (Issue #103 Phase C / D-2a). Trace Replay, the execution projection and Plan
 * generation consume it, and it can never carry a Beam-only bound.
 */
export type PlannerRunResult = PlannerRunResultOf<PlannerRunTermination>

export type PlannerWarningKind =
  | 'no_build_list_entries'
  | 'rng_state_missing'
  | 'rng_prediction_unsupported'
  | 'protected_weapon_required'
  | 'build_list_entry_stale'
  | 'calculation_context_incompatible'
  | 'all_targets_already_satisfied'
  | 'invalid_conflict_resolution'
  /**
   * The Production `maxPlanSteps` bound of a full Planner run. The Beam Search
   * oracle's own `maxExpandedStates` bound has no warning kind: its typed
   * `reachedLimits` alone reports it (Issue #103 Phase D-2b). The legacy B8
   * orchestration stop kinds were removed with that path (Phase 6-B2b): the
   * Planner Alternative reports its bound stops and a checkpoint-blocked Target
   * as typed comparison outcomes, never as warnings (PLANNER_SPEC 9.2.19.13).
   */
  | 'max_steps_reached'
  /**
   * Planner input fail-closed reasons for selected checkpoints
   * (PLANNER_SPEC 7.5.6 / 7.5.7 / 7.5.8). The first two accompany a validation
   * issue, so the Build List can say why no Plan was calculated; the third is
   * informational: another Entry of a Target with a required checkpoint Entry
   * was left out of this run's candidate selection.
   */
  | 'multiple_selected_checkpoint_entries'
  | 'selected_checkpoint_target_already_ideal'
  | 'selected_checkpoint_fixes_target_entry'
  /**
   * A BuildListEntry's `intermediateStateSelection` is structurally invalid
   * (unknown id, an id of the other lane, unknown preference). The Planner input
   * fails closed with a validation issue; the selection is never read as
   * empty (PLANNER_SPEC 7.5.9).
   */
  | 'invalid_checkpoint_selection'
  /**
   * A planning Target holds two or more BuildListEntries in an ordinary
   * persisted Planner input - a legacy duplicate of the Build List cardinality
   * contract (`docs/DATA_MODEL.md` 9.4.1, `docs/PLANNER_SPEC.md` 4.1). The whole
   * input fails closed with a validation issue: the Planner never picks one
   * Entry by Route length, `createdAt`, staleness or ID.
   */
  | 'duplicate_build_list_entries_for_target'
  /**
   * A BuildListEntry of a `completed` Target was left out of Planner input.
   * The Entry is not stale and needs no re-search: its Target already has its
   * Ideal weapon (`docs/DATA_MODEL.md` 8.1).
   */
  | 'completed_target_excluded'

export const plannerWarningKinds: readonly PlannerWarningKind[] = [
  'no_build_list_entries',
  'rng_state_missing',
  'rng_prediction_unsupported',
  'protected_weapon_required',
  'build_list_entry_stale',
  'calculation_context_incompatible',
  'all_targets_already_satisfied',
  'invalid_conflict_resolution',
  'max_steps_reached',
  'multiple_selected_checkpoint_entries',
  'selected_checkpoint_target_already_ideal',
  'selected_checkpoint_fixes_target_entry',
  'invalid_checkpoint_selection',
  'duplicate_build_list_entries_for_target',
  'completed_target_excluded',
]

export interface PlannerWarning {
  kind: PlannerWarningKind
  message: string
}

export interface PlannerResult {
  plan: ProductionPlan | null
  conflicts: PlanConflict[]
  warnings: PlannerWarning[]
  /**
   * How the full Planner run behind this result ended (PLANNER_SPEC 7.2.1).
   *
   * `plan` alone cannot answer that: a `plan` calculated from a truncated
   * search is a partial Planner artifact, not a finished production plan,
   * and Persistence and UI must be able to tell the two apart without reading
   * a warning message. When several full Planner runs ran - a
   * runtime-unsupported retry, or a Planner Alternative Candidate trial - this
   * is the one whose result was actually used.
   */
  termination: PlannerRunTermination
  /**
   * For an input carrying explicit conflict resolutions only: whether the
   * Plan completes every Entry they prefer, and why not
   * (`docs/PLANNER_SPEC.md` 9.6.6). Runtime-only Worker result data, never
   * persisted. Absent for an input without resolutions - the Build List's
   * ordinary run, the Build List optimization's final verification and the
   * replan Preview - which no completion condition applies to.
   */
  conflictResolutionOutcome?: PlannerConflictResolutionOutcome
}

export interface PlannerIdFactory {
  productionPlanId(): ProductionPlanId
  planStepId(): PlanStepId
  ownedWeaponId(): OwnedWeaponId
}

export interface PlannerClock {
  now(): ISODateTimeString
}

/** Runtime-only dependencies. This type is never part of PlannerInput or persistence. */
export interface PlannerDependencies {
  rngEngine: RngEngine
  idFactory: PlannerIdFactory
  clock: PlannerClock
}

/**
 * Which Build List cardinality contract one Planner input carries
 * (`docs/DATA_MODEL.md` 9.4.1, `docs/PLANNER_SPEC.md` 4.1 / 9.2.18).
 *
 * - `persisted`: an ordinary Planner input built from the persisted Build
 *   List - the Planner run, the replan Preview, the B10 interaction and the
 *   original input of a Planner Alternative request. At most one BuildListEntry per
 *   planning Target; a legacy duplicate fails the whole input closed.
 * - `temporary_augmented`: the preflight input of a Planner Alternative
 *   trial. Each Target of `replacements` holds exactly its persisted
 *   Entry `O` and its temporary Entry `G` (persisted 0..1 + temporary 0..1);
 *   every other Target follows the persisted contract. `O` is there only so
 *   that the user's fixed constraints are re-associated against the conflicts
 *   it takes part in. It is never a full Planner run input: `O` is no execution
 *   candidate of its Target, so the type of every full Planner run excludes it.
 * - `temporary_replacement`: the **replacement set** of that trial - every `O`
 *   removed, every `G` in its place. Every full Planner run of a trial (the
 *   run itself, Trace Replay, PlanConflict, rejections, PlanningInputSnapshot)
 *   runs over it, so a Plan never records an Entry the adoption deletes.
 *
 * Which Entry is temporary is named only by `replacements`, runtime-only
 * metadata the Planner Alternative trial creates. It is a Domain
 * calling-context parameter, never a `PlannerInput` field, never a
 * `BuildListEntry` field, never a Worker request field, and never persisted.
 */
export type PlannerBuildListContext =
  | { kind: 'persisted' }
  | {
      kind: 'temporary_augmented'
      replacements: readonly BuildListEntryReplacement[]
    }
  | {
      kind: 'temporary_replacement'
      replacements: readonly BuildListEntryReplacement[]
    }

/** The contexts a full Planner run (the scheduler or the Beam Search oracle, Production Plan generation) accepts. */
export type PlannerRunBuildListContext = Exclude<
  PlannerBuildListContext,
  { kind: 'temporary_augmented' }
>

/** The ordinary persisted Build List contract, the default of every Planner entry point. */
export const PERSISTED_PLANNER_BUILD_LIST_CONTEXT: { readonly kind: 'persisted' } = Object.freeze({
  kind: 'persisted' as const,
})

/**
 * The runtime hooks of a Production full Planner run: cancellation and
 * cooperative yielding only (Issue #103 Phase D-2a). The Production Worker
 * passes exactly these two and forwards no progress, because the Production
 * UI shows an indeterminate running state; cancellation never depends on a
 * progress message.
 *
 * Test observation lives in `PlannerScheduleExecutionOptions` (the
 * scheduler's parity observer) and never reaches the Production Worker
 * protocol or client; the Beam Search oracle takes exactly these two hooks.
 */
export interface PlannerExecutionOptions {
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
}

export type CreateProductionPlanCalculation = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
  options?: PlannerExecutionOptions,
) => Promise<PlannerResult>

/**
 * Runtime-only observation of Production Plan generation (PLANNER_SPEC 9.2.16).
 *
 * `beforePlannerRun()` is called exactly once immediately before each full
 * Planner run that actually starts (the Production deterministic scheduler, or
 * the runner a test / benchmark injected), including the first one and every
 * runtime-unsupported retry. The Planner Alternative counts those calls against
 * its request-global `maxPlannerReruns`; the initial conflict preflight is no
 * full Planner run and therefore never reaches this observer.
 *
 * It is semantics-neutral: it must not change Plan generation behaviour. A
 * throw from it propagates unchanged to the caller and is never converted into
 * a `PlannerResult`. Like `PlannerDependencies`, it carries functions and is
 * therefore never part of `PlannerInput`, a Worker DTO, or persistence.
 */
export interface ProductionPlanGenerationObserver {
  beforePlannerRun(): void
  /**
   * Called exactly once immediately after each full Planner run returns,
   * before Trace Replay inspects its result.
   *
   * It is pure observation: nothing in Plan generation branches on it, and it
   * cannot change which full Planner run starts next. The Planner Alternative
   * full-run path (`createPlannerAlternativeFullRunner()`) uses it so that,
   * when a runtime-unsupported retry is refused by the `maxPlannerReruns`
   * budget, it can still read the last completed run instead of assembling a
   * ProductionPlan from a run whose Trace Replay never succeeded.
   */
  afterPlannerRun?(result: PlannerRunResult): void
  /**
   * Optional phase boundary of the shared Plan-generation tail, for performance
   * observation only (Issue #154 Phase 2-B). See `ProductionPlanGenerationPhase`.
   * No Production caller passes it; nothing branches on its presence, and it
   * receives no Plan data.
   */
  onPlanGenerationPhase?(phase: ProductionPlanGenerationPhase): void
}

/**
 * The start of one phase of the shared Plan-generation tail after a full
 * Planner run (`productionPlanGeneration.ts`), reported to the optional
 * `onPlanGenerationPhase()` observer. Each phase lasts until the next one
 * starts; `completed` means the tail is about to return a Plan. A tail that
 * returns `plan: null` or throws reports no `completed`.
 *
 * - `trace_replay`: Trace Replay of one full run (once per full run whose
 *   trace is replayed, so the runtime-unsupported retry check follows it)
 * - `post_processing`: runtime warnings, excluded Entries and the selected
 *   Entry set after the last full run
 * - `execution_projection`: `projectProductionPlanExecution()`
 * - `planning_input_snapshot`: `createPlanningInputSnapshot()`
 * - `checkpoint_defence`: the checkpoint requirement defence
 * - `rejected_build_list_entries`: `createRejectedBuildListEntries()` (and the
 *   Plan field clones evaluated before it)
 * - `required_materials`: `collectRequiredMaterials()`
 * - `plan_assembly`: the Plan object and the result clones
 */
export type ProductionPlanGenerationPhase =
  | 'trace_replay'
  | 'post_processing'
  | 'execution_projection'
  | 'planning_input_snapshot'
  | 'checkpoint_defence'
  | 'rejected_build_list_entries'
  | 'required_materials'
  | 'plan_assembly'
  | 'completed'

export type PlannerWorkerRequest =
  | {
      type: 'create_plan'
      requestId: string
      input: PlannerInput
    }
  | {
      type: 'cancel'
      requestId: string
    }

export type PlannerWorkerResponse =
  | {
      type: 'create_plan_result'
      requestId: string
      result: PlannerResult
    }
  | {
      type: 'error'
      requestId: string
      message: string
    }
