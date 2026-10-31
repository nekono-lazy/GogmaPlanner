import type {
  ArtianWeaponKind,
  BonusRankId,
  BonusTypeId,
  BuildCandidateId,
  BuildListEntryId,
  CalculationContext,
  CompletionConditionReviewReason,
  IntermediateStateGroupId,
  IntermediateStateOpportunityId,
  ElementId,
  GroupSkillId,
  ISODateTimeString,
  MaterialId,
  NormalArtianRarity,
  OwnedWeaponId,
  OwnedWeaponStatus,
  ProductionPlanId,
  RestorationBonus,
  RestorationBonusSet,
  RestorationBonusScope,
  RouteKind,
  SeriesSkillId,
  SkillMatchMode,
  TargetWeaponId,
  WeaponTypeId,
} from './common'

/**
 * The Execution-internal "作成中" state of an OwnedWeapon
 * (`docs/PLANNER_SPEC.md` 16.10.1, `docs/DATA_MODEL.md` 7.1).
 *
 * Orthogonal to `status`: it is never a user-facing label, the user never edits
 * it through ordinary CRUD, and only Execution turns it on or off. It holds a
 * ProductionPlan ID only, never a Target ID.
 */
export interface OwnedWeaponExecutionInProgress {
  productionPlanId: ProductionPlanId
  startedAt: ISODateTimeString
}

export interface OwnedWeaponBase {
  id: OwnedWeaponId
  kind: ArtianWeaponKind
  name: string
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  restorationBonuses: RestorationBonusSet
  /** All five stored slots belong to this family; mixed scope is invalid. */
  restorationBonusScope: RestorationBonusScope
  isProtected: boolean
  /**
   * `null` = not being produced by a running Plan. Like `status`, it carries no
   * calculation meaning: it stays out of every semantic hash, Search route
   * eligibility, and Planner inventory semantics, while Undo and game save
   * point restore must restore it exactly.
   */
  executionInProgress: OwnedWeaponExecutionInProgress | null
  memo: string | null
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
}

export interface OwnedNormalArtianWeapon extends OwnedWeaponBase {
  kind: 'normal'
  rarity: NormalArtianRarity
  seriesSkillId: null
  groupSkillId: null
  status: null
}

export interface OwnedGogmaArtianWeapon extends OwnedWeaponBase {
  kind: 'gogma'
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  status: OwnedWeaponStatus
}

export type OwnedWeapon = OwnedNormalArtianWeapon | OwnedGogmaArtianWeapon

/**
 * `active` = not yet completed. `completed` = its Ideal weapon was obtained; the
 * record is kept for history and ProductionPlan references but is excluded from
 * the ordinary Target list, Candidate Search, and Planner input
 * (`docs/DATA_MODEL.md` 8.1, `docs/PLANNER_SPEC.md` 16.13).
 */
export const targetWeaponLifecycleStatuses = ['active', 'completed'] as const
export type TargetWeaponLifecycleStatus =
  (typeof targetWeaponLifecycleStatuses)[number]

export interface TargetWeapon {
  id: TargetWeaponId
  name: string
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  priority: 1 | 2 | 3 | 4 | 5
  isEnabled: boolean
  /**
   * The owned weapon this Target prefers as the starting point of its Route.
   *
   * A soft planning preference, never a hard Route constraint: Search still
   * explores every executable Route, and a shorter or otherwise better one wins
   * (`docs/SEARCH_SPEC.md` 8.1, `docs/PLANNER_SPEC.md` 7.4). The relation is an
   * optional 1:1 - a Target names at most one weapon, and one weapon is the
   * preferred origin of at most one Target - and it never restricts Target
   * Satisfaction, which stays a judgment about actual weapon performance.
   */
  preferredOwnedWeaponId: OwnedWeaponId | null
  /**
   * Target lifecycle. Not a performance definition. Existing data is never
   * inferred `completed` by a migration, whatever weapons the user owns.
   */
  lifecycleStatus: TargetWeaponLifecycleStatus
  /** Non-null exactly when `lifecycleStatus === 'completed'`. */
  completedAt: ISODateTimeString | null
  /**
   * The Plan whose Execution completed this Target. `null` for an active Target
   * and for a Target the user completed with an owned weapon.
   */
  completedByProductionPlanId: ProductionPlanId | null
  /**
   * The completion assignment (`docs/DATA_MODEL.md` 8.7, `docs/PLANNER_SPEC.md`
   * 21.3): the owned weapon this `completed` Target was completed with. Always
   * `null` for an `active` Target, and `null` ("not recorded") for a Target
   * completed before the assignment was recorded - never inferred from a Plan
   * or an owned Ideal. It points one way, Target -> weapon; one weapon is the
   * completion of at most one Target, and an assigned weapon is never the
   * completion, the Route base or the preferred origin of another Target
   * (21.4). Only Execution completion and the direct completion write it; only
   * reopening, Undo and a save point restore clear it. Not a performance
   * definition and part of no hash.
   */
  completedWithOwnedWeaponId: OwnedWeaponId | null
  /**
   * The completion bonus Variants (`docs/DATA_MODEL.md` 8.2): one or more
   * equal five-slot configurations, any one of which completes the Bonus side.
   * Their order carries no meaning.
   */
  completionBonusVariants: CompletionBonusVariant[]
  /** The completion Skill condition; `matchMode` is always `all` (8.4). */
  completionSkillCondition: SkillCondition
  /**
   * Why the completion condition needs the user's review (8.6). Non-empty keeps
   * the Target out of every calculation until the user explicitly saves it.
   * Not a performance definition: never part of `createTargetDefinitionHash()`.
   */
  completionConditionReview: CompletionConditionReviewReason[]
  memo: string | null
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
}

/**
 * One required slot of a completion Variant: this bonus type at this rank or
 * any higher rank by Master `BonusRankMaster.order` (`docs/DATA_MODEL.md` 8.2).
 */
export interface CompletionBonusSlot {
  bonusTypeId: BonusTypeId
  minimumRankId: BonusRankId
}

export type CompletionBonusSlots = [
  CompletionBonusSlot,
  CompletionBonusSlot,
  CompletionBonusSlot,
  CompletionBonusSlot,
  CompletionBonusSlot,
]

/**
 * One completion configuration of a Target (`docs/DATA_MODEL.md` 8.2).
 *
 * The five slots are an unordered multiset with duplicate counts preserved;
 * `id` is a UI editing key only and never enters a hash, an identity or a
 * judgement.
 */
export interface CompletionBonusVariant {
  id: string
  slots: CompletionBonusSlots
}

export interface SkillCondition {
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  matchMode: SkillMatchMode
}

/**
 * The predicted five slots produced by one Bonus amendment operation.
 *
 * Purely observational: it explains a Route that is already decided, so it
 * never participates in Candidate semantic identity, hashing, ordering, or
 * deduplication. The five slots keep their stored slot order because Keep
 * preserves the bonus family at each slot position.
 */
export interface BonusAmendmentResult {
  restorationBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
}

/**
 * One entry of `BuildCandidate.bonusAmendmentTrace`.
 *
 * `operationIndex` is the position of the described operation inside
 * `BuildRoute.operations`, so the association survives repeated identical
 * operation types.
 */
export interface CandidateBonusAmendmentStep extends BonusAmendmentResult {
  operationIndex: number
  operationType: 'reset_bonuses' | 'keep_bonuses'
}

/**
 * The predicted Series / Group Skills produced by one Reset Skills operation.
 *
 * The Skill counterpart of `BonusAmendmentResult`, and purely observational for
 * the same reason: it explains a Route that is already decided, so it never
 * participates in Candidate semantic identity, hashing, ordering, retention, or
 * deduplication. `null` keeps its ordinary meaning of "no skill".
 */
export interface SkillAmendmentResult {
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

/**
 * One entry of `BuildCandidate.skillAmendmentTrace`.
 *
 * `operationIndex` is the position of the described operation inside
 * `BuildRoute.operations`, so a run of consecutive `reset_skills` operations can
 * never be shifted by one against its predicted result.
 */
export interface CandidateSkillAmendmentStep extends SkillAmendmentResult {
  operationIndex: number
  operationType: 'reset_skills'
}

/**
 * `BuildCandidate.conversionSkillTrace`: the initial Series / Group Skills that
 * `convert_normal_to_gogma` assigns.
 *
 * A separate observational contract from `skillAmendmentTrace`, which stays
 * Reset Skills only (`docs/SEARCH_SPEC.md` 5.5.2.1). It is singular because a
 * Route carries at most one conversion operation (SEARCH_SPEC 6.1 / 6.1.1 /
 * 6.2), and it is bound by `operationIndex` inside the finished
 * `BuildRoute.operations` for the same reason the other traces are.
 */
export interface CandidateConversionSkillStep extends SkillAmendmentResult {
  operationIndex: number
  operationType: 'convert_normal_to_gogma'
}

/**
 * Which Target condition one compromise checkpoint state satisfies.
 *
 * Purely explanatory: it is derived from the Target definition and the reached
 * performance state, so it is never an intermediate state group's identity
 * authority, never a Candidate identity input, and never a Planner decision
 * input (`docs/SEARCH_SPEC.md` 5.8.2).
 */
export interface CompromiseConditionMatch {
  bonus: 'ideal' | 'practical' | 'alternative'
  skill: 'ideal' | 'practical'
}

/** The two independent stream lanes of one Route (`docs/SEARCH_SPEC.md` 5.8). */
export type IntermediateStateAxis = 'skill' | 'bonus'

export type IntermediateSkillMatch = 'practical' | 'ideal'
export type IntermediateBonusMatch = 'practical' | 'alternative' | 'ideal'

interface IntermediateStateOpportunityBase {
  id: IntermediateStateOpportunityId
  /**
   * How many operations of this lane have been executed when the state is
   * held: `0` is the lane's starting state (the conversion-assigned Skills, or
   * an existing Gogma's current Skills / five slots), `n` is the state right
   * after the lane's `n`-th operation. It is always strictly less than the
   * lane's operation count: the lane end is the Ideal result, never an
   * intermediate state.
   */
  lanePosition: number
  /**
   * Index inside `BuildRoute.operations` of the operation that produces this
   * state, or `null` for a Route base state no operation produces (an existing
   * Gogma's own current state).
   */
  operationIndex: number | null
}

/** One Skill lane position at which a Skill state group's pair is reached. */
export interface IntermediateSkillOpportunity extends IntermediateStateOpportunityBase {
  axis: 'skill'
}

/**
 * One Bonus lane position at which a Bonus state group's product is reached.
 *
 * The exact ordered five slots are kept here, not on the group: two lane
 * positions reaching the same unordered multiset are the same user-visible
 * product but different weapon states, and Planner / Trace Replay verify the
 * exact ordered state (`docs/SEARCH_SPEC.md` 5.8.3).
 */
export interface IntermediateBonusOpportunity extends IntermediateStateOpportunityBase {
  axis: 'bonus'
  restorationBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
}

export type IntermediateStateOpportunity =
  | IntermediateSkillOpportunity
  | IntermediateBonusOpportunity

/**
 * One user-visible Skill state of the Route's Skill lane that satisfies the
 * Target's Skill condition (`docs/SEARCH_SPEC.md` 5.8.2).
 */
export interface IntermediateSkillStateGroup {
  axis: 'skill'
  id: IntermediateStateGroupId
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  /** Explanatory only; derived from the Target and this state. */
  match: IntermediateSkillMatch
  /** Ascending by `lanePosition`; never empty, never deduplicated. */
  opportunities: IntermediateSkillOpportunity[]
}

/**
 * One user-visible Bonus product of the Route's Bonus lane that satisfies the
 * Target's Bonus condition (`docs/SEARCH_SPEC.md` 5.8.2).
 *
 * Group identity is scope plus the unordered five-slot multiset with duplicate
 * counts preserved. Slot order is deliberately excluded here and preserved per
 * opportunity instead.
 */
export interface IntermediateBonusStateGroup {
  axis: 'bonus'
  id: IntermediateStateGroupId
  restorationBonusScope: RestorationBonusScope
  /** Representative ordered slots, taken from the earliest opportunity. */
  restorationBonuses: RestorationBonusSet
  /** Explanatory only; derived from the Target and this state. */
  match: IntermediateBonusMatch
  /** Ascending by `lanePosition`; never empty, never deduplicated. */
  opportunities: IntermediateBonusOpportunity[]
  /**
   * Display organisation only (`docs/SEARCH_SPEC.md` 5.8.4).
   *
   * `true` means another retained Bonus group is conservatively, obviously
   * better. It is never a Domain dominance: the group and every one of its
   * opportunities stay available to the user and to the Planner, because a
   * "worse" state can be the only one that avoids a Counter conflict.
   */
  isDisplaySecondary: boolean
  dominatingGroupId: IntermediateStateGroupId | null
}

export type IntermediateStateGroup =
  | IntermediateSkillStateGroup
  | IntermediateBonusStateGroup

/**
 * Legacy (calculation schema 11..18, `docs/PLANNER_SPEC.md` 7.6, historical):
 * which lane the Planner improved first once the compromise checkpoint had
 * been reached. Issue #100 abolished the preference (20.7); the literals stay
 * so a persisted legacy Entry's selection still validates and hashes, and the
 * Planner no longer orders anything by it.
 */
export type ImprovementPreference = 'planner' | 'skill_first' | 'bonus_first'

export const improvementPreferences: readonly ImprovementPreference[] = [
  'planner',
  'skill_first',
  'bonus_first',
]

/**
 * Legacy (calculation schema 11..18, `docs/DATA_MODEL.md` 9.4, historical):
 * the user's intermediate-state intent for one BuildListEntry - at most one
 * selected opportunity per lane, which pinned the Planner's compromise
 * checkpoint. Issue #100 abolished it (`docs/PLANNER_SPEC.md` 20.7): no
 * current Entry carries one, a persisted one is kept exactly as stored (never
 * rewritten or cleared), and a valid Entry still selecting a state fails the
 * Planner input closed instead of being read as "nothing selected".
 */
export interface IntermediateStateSelection {
  skillOpportunityId: IntermediateStateOpportunityId | null
  bonusOpportunityId: IntermediateStateOpportunityId | null
  improvementPreference: ImprovementPreference
}

export interface BuildCandidate {
  id: BuildCandidateId
  targetWeaponId: TargetWeaponId
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  route: BuildRoute
  estimatedOperationCount: number
  estimatedGogmaAdvance: number
  estimatedSkillAdvance: number
  estimatedNormalAdvance: number | null
  requiredMaterials: MaterialRequirement[]
  idealDifference: IdealDifference
  /**
   * Legacy (calculation schema 11..18, `docs/SEARCH_SPEC.md` 5.8, historical):
   * the accepted intermediate states of this Candidate's own Skill lane and
   * Bonus lane. Issue #100 abolished the intermediate states
   * (`docs/PLANNER_SPEC.md` 20.7): Candidate Search extracts none, so a
   * schema 19 or later Candidate carries no field, and a persisted one is kept
   * exactly as stored and validated structurally only where present
   * (`docs/DATA_MODEL.md` 9.1).
   *
   * It never entered any Candidate semantic identity: not the Candidate ID
   * `semanticHash`, `candidateStableKey`, the deduplication key, the
   * `BuildCandidateMeaning` fingerprint, `searchStateHash` or
   * `referencedOwnedWeaponsHash`. A legacy Entry's `intermediateStateSelection`
   * resolves its ids against this field, which is why both are kept together.
   * A calculation schema 10 Candidate stored its strict-prefix checkpoints in
   * the untyped `checkpointGroups` instead (`docs/DATA_MODEL.md` 9.4).
   */
  intermediateStateGroups?: IntermediateStateGroup[]
  searchStateHash: string
  referencedOwnedWeaponsHash: string | null
  calculationContext: CalculationContext
  searchRunId: string
  createdAt: ISODateTimeString
  /**
   * Observational per-amendment expected results, in execution order.
   *
   * Optional so Candidates persisted before this field existed stay valid and
   * never become stale: the field explains an already decided Route and changes
   * no calculation meaning. UI omits the prediction display when it is absent.
   */
  bonusAmendmentTrace?: CandidateBonusAmendmentStep[]
  /**
   * Observational per-Reset-Skills expected results, in execution order.
   *
   * Optional for the same reason as `bonusAmendmentTrace`: Candidates persisted
   * before this field existed stay valid and never become stale, because the
   * field explains an already decided Route and changes no calculation meaning.
   * `seriesSkillId` / `groupSkillId` remain the authority for the Route's final
   * Skills. UI omits the prediction display when the field is absent.
   */
  skillAmendmentTrace?: CandidateSkillAmendmentStep[]
  /**
   * Observational initial Skill assignment of this Route's conversion.
   *
   * Present only for a Route containing `convert_normal_to_gogma`, and optional
   * for the same reason as the two amendment traces: it explains an already
   * decided Route, so a Candidate persisted before this field existed stays
   * valid and never becomes stale. `seriesSkillId` / `groupSkillId` remain the
   * authority for the Route's final Skills, which a later `reset_skills`
   * overwrites. UI omits the prediction display when the field is absent.
   */
  conversionSkillTrace?: CandidateConversionSkillStep
}

export interface BuildRoute {
  kind: RouteKind
  operations: RouteOperation[]
  sourceOwnedWeaponId: OwnedWeaponId | null
}

export type RouteOperation =
  | CreateNormalArtianOperation
  | ConvertToGogmaOperation
  | ResetBonusesOperation
  | KeepBonusesOperation
  | ResetSkillsOperation

interface CreateNormalArtianOperationBase {
  type: 'create_normal_artian'
  weaponTypeId: WeaponTypeId
  rarity: NormalArtianRarity
}

/**
 * Normal Artian creation from a confirmed Normal Artian Counter.
 *
 * The absolute Counter positions are known, so the five restoration bonus
 * slots of every forged weapon are predictable and the Planner can check the
 * Counter precondition of each forge.
 */
export interface PredictedCreateNormalArtianOperation
  extends CreateNormalArtianOperationBase {
  count: number
  normalCounterBefore: number
  normalCounterAfter: number
}

/**
 * Normal Artian creation with no confirmed Normal Artian Counter
 * (`docs/SEARCH_SPEC.md` 6.1.1).
 *
 * The forged weapon's five slots are never read: the Route's first bonus
 * amendment is always `reset_bonuses`, which redraws all five slots from the
 * Gogma Counter position alone. Exactly one weapon is forged, because forging
 * more would only add operations and materials without changing the result.
 *
 * `null` means the absolute Normal Counter position is unknown, never that the
 * Counter does not advance. The game Counter does advance by one; the tool
 * simply holds no confirmed value to advance, so it stores none rather than
 * inventing one.
 */
export interface BlindCreateNormalArtianOperation
  extends CreateNormalArtianOperationBase {
  count: 1
  normalCounterBefore: null
  normalCounterAfter: null
}

export type CreateNormalArtianOperation =
  | PredictedCreateNormalArtianOperation
  | BlindCreateNormalArtianOperation

/**
 * Whether one `create_normal_artian` operation is the blind variant.
 *
 * The two variants are discriminated by the nullability of their Counter
 * positions, so an operation persisted before the blind variant existed keeps
 * its exact predicted meaning and stays valid.
 */
export function isBlindCreateNormalArtianOperation(
  operation: CreateNormalArtianOperation,
): operation is BlindCreateNormalArtianOperation {
  return operation.normalCounterBefore === null
}

export interface ConvertToGogmaOperation {
  type: 'convert_normal_to_gogma'
  weaponTypeId: WeaponTypeId
  skillCounterBefore: number
  skillCounterAfter: number
}

export interface ResetBonusesOperation {
  type: 'reset_bonuses'
  /** null denotes the transient Gogma created by this route. */
  sourceOwnedWeaponId: OwnedWeaponId | null
  gogmaCounterBefore: number
  gogmaCounterAfter: number
}

export interface KeepBonusesOperation {
  type: 'keep_bonuses'
  /** null denotes the transient Gogma created by this route. */
  sourceOwnedWeaponId: OwnedWeaponId | null
  gogmaCounterBefore: number
  gogmaCounterAfter: number
}

export interface ResetSkillsOperation {
  type: 'reset_skills'
  sourceOwnedWeaponId: OwnedWeaponId | null
  skillCounterBefore: number
  skillCounterAfter: number
}

export interface IdealDifference {
  missingBonuses: RestorationBonus[]
  extraBonuses: RestorationBonus[]
  matchedBonusCount: number
  seriesSkillMatches: boolean
  groupSkillMatches: boolean
  summary: string
}

export type BuildListEntryStaleReason =
  | 'target_definition_changed'
  | 'rng_state_changed'
  | 'owned_weapon_changed'
  | 'calculation_context_changed'

export interface BuildListEntry {
  id: BuildListEntryId
  candidateId: BuildCandidateId
  targetWeaponId: TargetWeaponId
  candidateSnapshot: BuildCandidate
  /**
   * Legacy (calculation schema 11..18, `docs/PLANNER_SPEC.md` 7.5 / 7.6,
   * historical): the intermediate states the user chose to hold on the way to
   * the Ideal, plus the improvement preference. Issue #100 abolished both
   * (20.7): `createBuildListEntry()` writes no field, so a schema 19 or later
   * Entry carries none, and a persisted one is kept exactly as stored - never
   * rewritten to `null` or cleared (20.8).
   *
   * Each selected id must exist in `candidateSnapshot.intermediateStateGroups`
   * on its own lane (validated structurally where present, 7.5.9). The
   * selection never entered the Candidate's own meaning
   * (`createBuildCandidateMeaningFingerprint()`) and never stales the Entry,
   * but it still enters the Plan's build-list hash normalization exactly as
   * schema 11..18 defined it, so no persisted Plan hash moves. Absent means
   * nothing is selected and the preference is `planner`. A calculation schema
   * 10 Entry stored its selection in the untyped `selectedCheckpointOpportunityIds`
   * instead (`docs/DATA_MODEL.md` 9.4).
   */
  intermediateStateSelection?: IntermediateStateSelection
  targetDefinitionHash: string
  searchStateHash: string
  referencedOwnedWeaponsHash: string | null
  calculationContext: CalculationContext
  isStale: boolean
  staleReasons: BuildListEntryStaleReason[]
  createdAt: ISODateTimeString
}

export interface MaterialRequirement {
  materialId: MaterialId
  quantity: number
}

export interface RngCapabilities {
  canPredictGogma: boolean
  canPredictSkills: boolean
  canSearchNormalArtian: boolean
  normalArtianSearchableCounterIds: string[]
  canRunPlanner: boolean
  missingRequirements: string[]
}
