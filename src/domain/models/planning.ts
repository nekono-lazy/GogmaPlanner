import type {
  BuildCandidateId,
  BuildListEntryId,
  CalculationContext,
  IntermediateStateOpportunityId,
  ConflictKind,
  ExecutionAction,
  ExecutionHistoryId,
  GroupSkillId,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeaponId,
  PlanStepId,
  PlanStepOperationType,
  ProductionPlanAbandonmentReason,
  ProductionPlanId,
  ProductionPlanStatus,
  RecalculationReason,
  RestorationBonusSet,
  RestorationBonusScope,
  RngState,
  SeriesSkillId,
  TargetWeaponId,
} from './common'
import type {
  CompromiseConditionMatch,
  IntermediateStateAxis,
  MaterialRequirement,
  OwnedWeapon,
  TargetWeapon,
} from './entities'

export interface ProductionPlan {
  id: ProductionPlanId
  status: ProductionPlanStatus
  baseSnapshot: PlanningInputSnapshot
  selectedBuildListEntryIds: BuildListEntryId[]
  calculationContext: CalculationContext
  steps: PlanStep[]
  conflicts: PlanConflict[]
  rejectedBuildListEntries: RejectedBuildListEntry[]
  requiredMaterials: MaterialRequirement[]
  currentStepId: PlanStepId | null
  recalculationReasons: RecalculationReason[]
  /**
   * Plan lifecycle metadata (`docs/DATA_MODEL.md` 11.1). `abandonmentReason` /
   * `abandonedAt` are non-null exactly when `status === 'abandoned'`, and
   * `completedAt` exactly when `status === 'completed'`.
   */
  abandonmentReason: ProductionPlanAbandonmentReason | null
  abandonedAt: ISODateTimeString | null
  completedAt: ISODateTimeString | null
  /**
   * The Conflict repair chain this Draft continues (`docs/DATA_MODEL.md`
   * 11.1.1, `docs/PLANNER_SPEC.md` 9.2.19.11 / 9.6.8). `null` for every Plan
   * that no 「この候補を優先」 actual repair of an earlier version saved: no
   * current Plan generation or save writes one (Issue #278 removed that repair
   * and its lineage derivation), and a stored value stays readable and
   * exported as it is. It is audit / chain-continuation data only: its
   * Entry and Target IDs are never current foreign keys, and it enters no
   * hash, snapshot, staleness or Execution semantics. Every later transition
   * (start, Execution, Undo, save point snapshots) keeps it exactly.
   */
  conflictRepairLineage: PlannerConflictRepairLineage | null
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
}

export interface PlanningInputSnapshot {
  initialExecutionState: ExpectedPlanState
  /** Audit hash of every PlannerInput Target (planning-input normalization). */
  targetWeaponsHash: string
  /** Audit hash of every PlannerInput BuildListEntry. */
  buildListEntriesHash: string
  /**
   * The planning definition (`id`, `createTargetDefinitionHash()`, `priority`,
   * `isEnabled`) of the Plan-dependent Targets only (`docs/DATA_MODEL.md` 11.2).
   *
   * Calculation schema 12 and later. `undefined` means a Plan of an earlier
   * calculation schema, which is failed closed at the CalculationContext
   * boundary and never read as "no dependency".
   */
  dependentTargetDefinitionsHash?: string
  /**
   * The `buildListEntriesHash` normalization of `selectedBuildListEntryIds`
   * only. Calculation schema 12 and later, exactly like
   * `dependentTargetDefinitionsHash`.
   */
  dependentBuildListEntriesHash?: string
  calculationContext: CalculationContext
  createdAt: ISODateTimeString
}

export interface ExpectedPlanState {
  rngStateHash: string
  normalCountersHash: string
  ownedWeaponsHash: string
  /**
   * `id`, `lifecycleStatus` and `preferredOwnedWeaponId` of the Plan-dependent
   * Targets only (`docs/PLANNER_SPEC.md` 16.5).
   *
   * Calculation schema 12 and later. `undefined` means a Plan of an earlier
   * calculation schema; it is never normalized to a computed value.
   */
  targetExecutionStateHash?: string
}

/**
 * The PlanStep ID whose confirmation binds a user observation to a weapon's
 * five restoration bonus slots (`docs/PLANNER_SPEC.md` 16.5).
 *
 * A blind production-target Normal has no predicted slots, so every expected
 * state until a Reset Bonuses replaces them normalizes the slots to this token
 * instead of to a fabricated value.
 */
export interface ExpectedStateObservationBindingToken {
  observationBinding: PlanStepId
}

/** `create_normal_artian` Step role (`docs/PLANNER_SPEC.md` 16.3). */
export type PlanStepNormalCreationRole = 'counter_advance' | 'production_target'

/** A value unknown at Plan generation that the user observes at Step confirmation. */
export interface PlanStepObservationBinding {
  kind: 'normal_restoration_bonuses'
}

/** Sets the Target's preferred owned weapon to the Step's tracked weapon (16.11). */
export interface PlanStepTargetLinkEffect {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
}

/** Labels the tracked weapon `practical` at a reached selected checkpoint (16.12). */
export interface PlanStepCompromiseLabelEffect {
  buildListEntryId: BuildListEntryId
  ownedWeaponId: OwnedWeaponId
}

/** Ideal completion and Target completion (16.13). */
export interface PlanStepTargetCompletionEffect {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
  ownedWeaponId: OwnedWeaponId
}

/**
 * The Execution effects one PlanStep applies when it is confirmed
 * (`docs/DATA_MODEL.md` 11.3, `docs/PLANNER_SPEC.md` 16.3).
 *
 * Planner calculation only records them: it never writes a Target, an
 * OwnedWeapon status, protection or in-progress state. The Execution service
 * applies them in the Step confirmation transaction, in the order target links,
 * compromise labels, target completions.
 */
export interface PlanStepExecutionEffects {
  /** The weapon this Step operates on or registers; `null` for a Counter-advance Normal. */
  trackedOwnedWeaponId: OwnedWeaponId | null
  /** Non-null exactly for `create_normal_artian`. */
  normalCreationRole: PlanStepNormalCreationRole | null
  /** The production-target Normal is registered by this Step. */
  registersTrackedWeapon: boolean
  /** Non-null only for a blind production-target Normal. */
  observationBinding: PlanStepObservationBinding | null
  targetLinks: PlanStepTargetLinkEffect[]
  compromiseLabels: PlanStepCompromiseLabelEffect[]
  targetCompletions: PlanStepTargetCompletionEffect[]
}

export interface PlanStep {
  id: PlanStepId
  order: number
  operationType: PlanStepOperationType
  title: string
  instruction: string
  targetWeaponId: TargetWeaponId | null
  buildListEntryId: BuildListEntryId | null
  /**
   * Observational metadata: every TargetWeapon whose Route this one physical
   * Step advanced. It never replaces the primary `targetWeaponId` /
   * `buildListEntryId` presentation authority, and `undefined` means the Plan
   * predates the field, so its shared attribution must not be inferred.
   */
  progressedTargetWeaponIds?: TargetWeaponId[]
  /**
   * The compromise checkpoints this one physical Step reaches
   * (`docs/PLANNER_SPEC.md` 7.5.4).
   *
   * A checkpoint is never its own operation: it is milestone metadata on the
   * real Step that completes the pinned lane pair, so no
   * `PlanStepOperationType` is added, nothing is reserved, no OwnedWeapon is
   * created, no status or protection changes, and the Plan neither stops nor
   * completes there. One shared physical Step can reach several Entries'
   * milestones at once.
   *
   * `undefined` means the Plan predates the field, which must not be read as
   * "this Step reaches no milestone".
   */
  checkpointMilestones?: PlanStepCheckpointMilestone[]
  candidateId: BuildCandidateId | null
  ownedWeaponId: OwnedWeaponId | null
  expectedResult: ExpectedResult | null
  expectedStateBefore: ExpectedPlanState
  expectedStateAfter: ExpectedPlanState
  inventoryChange: InventoryChange | null
  rngAdvance: RngAdvance
  /**
   * Calculation schema 12 and later (`docs/DATA_MODEL.md` 11.3). `undefined`
   * means a legacy Plan whose execution projection is unknown; it is never
   * inferred from its Steps.
   */
  executionEffects?: PlanStepExecutionEffects
  requiresUserConfirmation: boolean
  isCompleted: boolean
  completedAt: ISODateTimeString | null
  debug: PlanStepDebugInfo | null
}

/**
 * One selected checkpoint reached by the Step carrying it.
 *
 * Typed metadata rather than a reused `ExpectedResult` category: the Step's
 * `ExpectedResult` keeps its own responsibility of describing the actual state
 * expected after the physical operation.
 */
export interface PlanStepCheckpointMilestone {
  buildListEntryId: BuildListEntryId
  targetWeaponId: TargetWeaponId
  /** The selected Skill state held here, or `null` when the Skill lane end (Ideal) is held. */
  skillOpportunityId: IntermediateStateOpportunityId | null
  /** The selected Bonus state held here, or `null` when the Bonus lane end (Ideal) is held. */
  bonusOpportunityId: IntermediateStateOpportunityId | null
  /** How the held pair rates on each Target axis; explanatory only. */
  conditionMatch: CompromiseConditionMatch
  /** Operation units still remaining until this Entry's Ideal result. */
  remainingOperationCount: number
}

/**
 * The actual weapon state expected after one physical operation.
 *
 * It carries no Candidate category and no similarity metadata: independent
 * Practical Candidates and the similarity concept no longer exist, and
 * checkpoint explanation belongs to `PlanStep.checkpointMilestones` instead
 * (`docs/PLANNER_SPEC.md` 7.5.4).
 */
export interface ExpectedResult {
  restorationBonuses: RestorationBonusSet | null
  restorationBonusScope: RestorationBonusScope | null
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  /**
   * Whether this Step completes a Target's Ideal weapon. For a calculation
   * schema 12 Plan it mirrors `executionEffects.targetCompletions` and is never
   * the authority; a legacy Plan set it on its independent secure Step.
   */
  shouldSecure: boolean
}

export interface InventoryChange {
  addOwnedWeapon: OwnedWeapon | null
  removeOwnedWeaponIds: OwnedWeaponId[]
  updateOwnedWeapons: OwnedWeapon[]
  materialRequirements: MaterialRequirement[]
}

export interface RngAdvance {
  gogmaCounterDelta: number
  skillCounterDelta: number
  normalCounterDelta: number | null
  affectedNormalCounterId: string | null
}

export interface PlanStepDebugInfo {
  startBaseSeed: string | null
  startGogmaCounter: number | null
  endGogmaCounter: number | null
  startSkillCounter: number | null
  endSkillCounter: number | null
  startNormalCounter: number | null
  endNormalCounter: number | null
  plannerReason: string
}

/**
 * One conflict participant whose competing unit is a selected checkpoint
 * endpoint (`docs/PLANNER_SPEC.md` 9.5).
 *
 * Typed metadata so the UI can say that resolving this conflict requires
 * changing a checkpoint selection in the Build List, instead of inferring it
 * from a message. It never enters `PlanConflict.id`, which keeps its existing
 * generation rule.
 */
export interface PlanConflictCheckpointParticipant {
  buildListEntryId: BuildListEntryId
  axis: IntermediateStateAxis
  opportunityId: IntermediateStateOpportunityId
}

export interface PlanConflict {
  id: string
  kind: ConflictKind
  buildListEntryIds: BuildListEntryId[]
  reason: string
  recommendedBuildListEntryId: BuildListEntryId | null
  selectedBuildListEntryId: BuildListEntryId | null
  resolutionNote: string | null
  /**
   * Participants whose competing unit is a selected checkpoint endpoint.
   *
   * Empty means no selected checkpoint is involved. `undefined` means the Plan
   * predates the field and carries no such judgement; it must not be read as
   * "no checkpoint is involved".
   */
  checkpointParticipants?: PlanConflictCheckpointParticipant[]
}

/**
 * How one direct participant Target of a repair decision ended
 * (`docs/DATA_MODEL.md` 11.1.1, `docs/PLANNER_SPEC.md` 9.2.19.11): `replaced`
 * for a replacement the scenario composition accepted, whether or not the
 * final Plan selects it; `rejected_by_scenario_composition` for one its
 * individual trial found but the composition did not accept; otherwise the
 * individual outcome itself.
 */
export type PlannerConflictRepairOutcomeStatus =
  | 'replaced'
  | 'rejected_by_scenario_composition'
  | 'not_found_within_search_extent'
  | 'stopped_by_search_extent_bound'
  | 'stopped_by_candidate_trial_bound'
  | 'stopped_by_planner_rerun_bound'
  | 'blocked_by_selected_checkpoint'

export interface PlannerConflictRepairInvalidatedRoute {
  targetWeaponId: TargetWeaponId
  /** The Entry whose current Route the decision invalidated. */
  invalidatedBuildListEntryId: BuildListEntryId
  /** That Route's `candidateStableKey()`: the only key a later exclusion reads. */
  invalidatedRouteKey: string
  /** The accepted replacement; non-null exactly when `outcome === 'replaced'`. */
  replacementBuildListEntryId: BuildListEntryId | null
  outcome: PlannerConflictRepairOutcomeStatus
}

export interface PlannerConflictRepairDecision {
  conflictKind: ConflictKind
  fixedBuildListEntryId: BuildListEntryId
  fixedTargetWeaponId: TargetWeaponId
  /** One per direct participant Target, in the stable Target order. */
  invalidatedRoutes: PlannerConflictRepairInvalidatedRoute[]
}

/**
 * The repair chain of a Draft (`docs/DATA_MODEL.md` 11.1.1), persisted as
 * `ProductionPlan.conflictRepairLineage` since Phase 5-B.
 */
export interface PlannerConflictRepairLineage {
  /** In decision order: the first 「この候補を優先」 first. */
  decisions: PlannerConflictRepairDecision[]
}

export interface RejectedBuildListEntry {
  buildListEntryId: BuildListEntryId
  /**
   * The `targetWeaponId` of this Entry in the PlannerInput the Plan was
   * generated from (Issue #121, `docs/DATA_MODEL.md` 11.9), copied for every
   * `reason`. A record, never a current foreign key: the Target need not exist
   * and the ReferenceFinder never reads it. Absent on a record saved before the
   * field existed, and never backfilled.
   */
  targetWeaponId?: TargetWeaponId
  reason:
    | 'lower_priority'
    | 'resource_conflict'
    | 'longer_route'
    | 'already_satisfied'
    | 'requires_protected_weapon'
    | 'dominated_by_better_candidate'
  /**
   * Why a `resource_conflict` record is one (Issue #121,
   * `docs/PLANNER_SPEC.md` 9.6.9.1): only `resource_conflict` records carry it,
   * decided by Plan generation in `rejectedReason()`'s branch order from the
   * Planner's runtime records. Absent on a record saved before the field
   * existed, and never backfilled.
   */
  resourceConflictCause?: RejectedBuildListEntryResourceConflictCause
  detail: string
}

/**
 * The cause of a `resource_conflict` rejection (`docs/DATA_MODEL.md` 11.9).
 * The first two establish a competition with another Target; a stuck drop
 * without other pending Routes is no conflict; a stuck drop with other pending
 * Routes cannot tell.
 */
export type RejectedBuildListEntryResourceConflictCause =
  /** An explicit resolution selected another participant, which the Plan selects. */
  | 'explicit_resolution_not_selected'
  /** The provisional outcome of an unresolved conflict did not commit this Entry. */
  | 'provisional_outcome_not_committed'
  /** A deadlock / stall drop while no other committed Entry had remaining units. */
  | 'stuck_drop_without_other_routes'
  /** A deadlock / stall drop while another committed Entry also had remaining units. */
  | 'stuck_drop_with_other_routes'

export const rejectedBuildListEntryResourceConflictCauses = [
  'explicit_resolution_not_selected',
  'provisional_outcome_not_committed',
  'stuck_drop_without_other_routes',
  'stuck_drop_with_other_routes',
] as const satisfies readonly RejectedBuildListEntryResourceConflictCause[]

export interface ExecutionHistory {
  id: ExecutionHistoryId
  planId: ProductionPlanId
  planStepId: PlanStepId
  action: ExecutionAction
  actualResult: ActualResult | null
  wasExpected: boolean
  recalculationReason: RecalculationReason | null
  undoSnapshot: ExecutionUndoSnapshot
  createdAt: ISODateTimeString
}

export interface ActualResult {
  restorationBonuses: RestorationBonusSet | null
  restorationBonusScope: RestorationBonusScope | null
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  securedOwnedWeaponId: OwnedWeaponId | null
  note: string | null
}

export interface ExecutionUndoSnapshot {
  rngStateBefore: RngState
  normalCountersBefore: NormalArtianCounter[]
  affectedOwnedWeaponsBefore: OwnedWeapon[]
  addedOwnedWeaponIds: OwnedWeaponId[]
  removedOwnedWeaponsBefore: OwnedWeapon[]
  /**
   * Every TargetWeapon the Step changed, as it was before the Step: the linked
   * Target, any Target whose link was cleared, a completed Target, and every
   * Target whose preference an Ideal completion cleared - Plan-dependent or not
   * (`docs/DATA_MODEL.md` 12).
   */
  affectedTargetWeaponsBefore: TargetWeapon[]
  /** Undo restores this snapshot verbatim; it must not infer new stale reasons. */
  productionPlanBefore: ProductionPlan
  /** The Plan's game save point before the Step, so a deletion by the Step can be undone. */
  executionSavePointBefore: ExecutionSavePoint | null
}

/**
 * The game save point a user explicitly recorded for one ProductionPlan
 * (`docs/DATA_MODEL.md` 12.1, `docs/PLANNER_SPEC.md` 16.9).
 *
 * It is a different concept from a compromise checkpoint and is never called
 * one. At most one exists per Plan: its `id` is derived from
 * `productionPlanId` by `executionSavePointIdForPlan()`, so recording again
 * replaces the previous one instead of adding a second.
 */
export interface ExecutionSavePoint {
  id: string
  productionPlanId: ProductionPlanId
  lastExecutionHistoryId: ExecutionHistoryId | null
  rngState: RngState
  /** Every NormalArtianCounter. */
  normalCounters: NormalArtianCounter[]
  /** Execution-scope OwnedWeapons. */
  ownedWeapons: OwnedWeapon[]
  /** Execution-scope TargetWeapons. */
  targetWeapons: TargetWeapon[]
  productionPlan: ProductionPlan
  recordedAt: ISODateTimeString
}

/**
 * The chronological order of a Plan's ExecutionHistory: `createdAt` ascending,
 * then `id` ascending for entries recorded at the same time. The last entry in
 * this order is the Plan's latest ExecutionHistory; storage insertion order is
 * never an authority.
 */
export function compareExecutionHistoryOrder(
  left: Pick<ExecutionHistory, 'createdAt' | 'id'>,
  right: Pick<ExecutionHistory, 'createdAt' | 'id'>,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

const EXECUTION_SAVE_POINT_ID_PREFIX = 'execution-save-point:'

/** The one stable save point ID of a Plan; never a clock or random value. */
export function executionSavePointIdForPlan(planId: ProductionPlanId): string {
  return `${EXECUTION_SAVE_POINT_ID_PREFIX}${planId}`
}
