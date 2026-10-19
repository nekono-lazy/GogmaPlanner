export type Brand<T, B extends string> = T & { readonly __brand: B }

export type OwnedWeaponId = Brand<string, 'OwnedWeaponId'>
export type TargetWeaponId = Brand<string, 'TargetWeaponId'>
export type BuildCandidateId = Brand<string, 'BuildCandidateId'>
export type BuildListEntryId = Brand<string, 'BuildListEntryId'>
export type ProductionPlanId = Brand<string, 'ProductionPlanId'>
export type PlanStepId = Brand<string, 'PlanStepId'>
export type ExecutionHistoryId = Brand<string, 'ExecutionHistoryId'>
/**
 * One user-visible intermediate state of one stream lane (Skill or Bonus) of a
 * canonical Ideal Route.
 *
 * Derived deterministically from the Candidate's own meaning, the lane, and
 * the state's performance identity, never from a search run id, a clock, or an
 * enumeration ordinal (`docs/SEARCH_SPEC.md` 5.8).
 */
export type IntermediateStateGroupId = Brand<
  string,
  'IntermediateStateGroupId'
>
/** One lane position at which an intermediate state group's exact state is reached. */
export type IntermediateStateOpportunityId = Brand<
  string,
  'IntermediateStateOpportunityId'
>

export type ISODateTimeString = string
export type WeaponTypeId = string
export type ElementId = string
export type BonusTypeId = string
export type BonusRankId = string
export type SeriesSkillId = string
export type GroupSkillId = string
export type MaterialId = string

export type RngStateSource = 'manual' | 'observation'

export const V1_NORMAL_ARTIAN_RARITY = 8 as const
export type NormalArtianRarity = typeof V1_NORMAL_ARTIAN_RARITY
export type ArtianWeaponKind = 'normal' | 'gogma'
export type RestorationBonusScope = 'normal_artian' | 'gogma_artian'
/**
 * A user-facing organisation label on an owned Gogma Artian weapon, and nothing
 * more.
 *
 * It never decides whether the Planner or Search may operate on the weapon
 * (`isProtected` does), which weapon a Target starts from
 * (`TargetWeapon.preferredOwnedWeaponId` does), or whether a weapon satisfies a
 * Target (the actual restoration bonuses and Skills do). Because it carries no
 * calculation meaning, it is excluded from every semantic hash and calculation
 * identity, exactly like `name` and `memo` (`docs/DATA_MODEL.md` 3.2).
 */
export type OwnedWeaponStatus = 'unclassified' | 'practical' | 'ideal'
export type RouteKind =
  | 'normal_artian_to_gogma'
  | 'owned_normal_artian_to_gogma'
  | 'existing_gogma_current'
  | 'existing_gogma_reset_bonuses'
  | 'existing_gogma_keep_bonuses'
  | 'existing_gogma_reset_skills'
  | 'existing_gogma_mixed'
export type SkillMatchMode = 'all' | 'any'
export type ProductionPlanStatus =
  | 'draft'
  | 'active'
  | 'completed'
  | 'stale'
  | 'abandoned'
/** Why a Plan became `abandoned` (`docs/PLANNER_SPEC.md` 16.2). */
export type ProductionPlanAbandonmentReason =
  | 'user_abandoned'
  | 'replan_adopted'
  | 'finished_as_compromise'
  | 'breaking_change_approved'
export const productionPlanAbandonmentReasons = [
  'user_abandoned',
  'replan_adopted',
  'finished_as_compromise',
  'breaking_change_approved',
] as const satisfies readonly ProductionPlanAbandonmentReason[]
export type PlanStepOperationType =
  | 'create_normal_artian'
  | 'convert_normal_to_gogma'
  | 'reset_bonuses'
  | 'keep_bonuses'
  | 'reset_skills'
  /**
   * Current (calculation schema 12): confirms that an owned Gogma already holds
   * the Target's Ideal and completes the Target without advancing any Counter
   * (`docs/PLANNER_SPEC.md` 16.3).
   */
  | 'confirm_owned_ideal'
  /**
   * Legacy only: an independent secure Step of a calculation schema 11 or
   * earlier Plan. It stays in the type so a historical Plan can be displayed,
   * but the current Planner never generates it and it is never executable.
   */
  | 'reserve_weapon'
  /** Legacy only, exactly like `reserve_weapon`. */
  | 'confirm_result'
/**
 * What the user confirmed happened at one Step (`docs/PLANNER_SPEC.md` 16.4).
 *
 * Current Execution records only `confirmed_expected`,
 * `actual_result_different`, `operation_uncertain`,
 * `operation_count_recovered` and `finished_as_compromise`. `secured_weapon` and `skipped_candidate` belong to
 * legacy Plans with an independent secure Step; they stay in the type so a
 * historical record can be displayed, and current Execution never writes them.
 */
export type ExecutionAction =
  | 'confirmed_expected'
  | 'actual_result_different'
  | 'operation_uncertain'
  /**
   * After `operation_uncertain`, the current game result matched exactly one
   * position of the same-operation Recovery Window, and the app state was
   * replayed along the Plan to that position (`docs/PLANNER_SPEC.md` 16.15).
   */
  | 'operation_count_recovered'
  | 'finished_as_compromise'
  | 'secured_weapon'
  | 'skipped_candidate'
export const currentExecutionActions = [
  'confirmed_expected',
  'actual_result_different',
  'operation_uncertain',
  'operation_count_recovered',
  'finished_as_compromise',
] as const satisfies readonly ExecutionAction[]
export const legacyExecutionActions = [
  'secured_weapon',
  'skipped_candidate',
] as const satisfies readonly ExecutionAction[]
export type RecalculationReason =
  | 'rng_state_changed'
  | 'normal_counter_changed'
  | 'target_changed'
  | 'build_list_changed'
  | 'owned_weapon_changed'
  | 'calculation_context_changed'
  | 'unexpected_result'
  /** The user recorded that what or how many operations were performed is unknown (16.15). */
  | 'execution_operation_uncertain'
  | 'planned_candidate_not_secured'
  | 'different_candidate_secured'
  | 'manual_recalculate'
export type ConflictKind =
  | 'same_gogma_counter'
  | 'same_skill_counter'
  | 'same_normal_counter'
  | 'same_owned_weapon_consumed'

export interface KnownValue<T> {
  value: T | null
  isConfirmed: boolean
  source: RngStateSource | null
}

// Application calculation semantics, independent of Dexie and AppSettings schemas.
// Version 2 invalidates pre-B5-F1 scope-blind Candidate Search results.
// Version 3 invalidates ProductionPlans created before physical operation
// subjects became part of transient Gogma action-sharing identity.
// Version 4 invalidates ProductionPlans created before a Route prefix another
// Entry's real operation already passed could be fast-forwarded: those Plans can
// hold shared Counter positions as conflicts and Entries rejected as
// counter_before_current that the current calculation would neither report nor
// reject.
// Version 5 invalidates ProductionPlans created before a partial result of a
// search a PlannerOptions bound truncated stopped being accepted as an
// executable ProductionPlan. Such a Plan was persistable as an ordinary Draft
// under version 4, a persisted Plan records no PlannerSearchTermination, and
// ProductionPlan compatibility is exact four-field equality, so a version 4
// Plan cannot be told apart from a complete one and is failed closed as a
// whole.
// Version 2, 3 and 4 BuildCandidate / BuildListEntry results remain explicitly
// compatible, because Search and snapshot semantics are unchanged.
// Version 6 changes Target compromise semantics, Candidate acceptance and Search
// termination. All version 1..5 Candidates, Build List snapshots and Plans are
// incompatible. The historical 2..5 build-result exception does not extend to 6.
// Version 7 makes protection cover every OwnedWeapon performance mutation,
// including Reset Skills, adds the zero-operation existing-Gogma Candidate,
// and changes new Practical protection defaults. All version 1..6 calculation
// artifacts are incompatible with these Search and Planner semantics.
// Dexie schema 2 migrates Targets separately; RNG semantics remain unchanged.
// Version 8 replaces `OwnedWeapon.relatedTargetWeaponIds` with the Target-side
// `preferredOwnedWeaponId`. That changes Target definition semantics, the
// same-cost Route selection of Candidate Search, and Planner Plan preference,
// so all version 1..7 Candidates, Build List snapshots and Plans are
// incompatible and fail closed. The historical 2..5 build-result exception is
// not extended to version 8. Dexie schema 3 migrates the persisted shape
// separately; RNG semantics remain unchanged.
// Version 9 removes the "consume an owned Gogma Artian weapon as material"
// Domain model entirely and reduces `OwnedWeapon.status` to a user-facing
// organisation label. That changes the active RouteOperation set
// (`use_weapon_as_material` no longer exists), Planner inventory semantics,
// Planner scoring, the PlanStep operation set, and the OwnedWeapon semantic
// hash contract, so all version 1..8 Candidates, Build List snapshots and Plans
// are incompatible and fail closed with `calculation_context_changed`. The
// historical 2..5 build-result exception is not extended to version 9. Dexie
// schema 4 migrates the persisted `material` status separately; RNG semantics
// remain unchanged. Game item materials (`MaterialRequirement`) are a different
// concept and are untouched.
// Version 10 replaces the independent Practical / Alternative BuildCandidate
// with the canonical Ideal Route plus selectable compromise checkpoints. A
// Candidate no longer carries a category, a condition match, or any similarity
// metadata; a Search result is at most one canonical Ideal per Target; a
// BuildListEntry additionally carries the user's selected checkpoint
// opportunities as a hard Planner constraint; and Planner scoring, PlanStep
// milestone metadata and `ExpectedResult` change with it. So all version 1..9
// Candidates, Build List snapshots and Plans are incompatible and fail closed
// with `calculation_context_changed`. The historical 2..5 build-result
// exception is not extended to version 10. No Dexie table shape changed, so
// `DATABASE_SCHEMA_VERSION` stays 4; the Export current shape does change, so
// `ExportRoot.schemaVersion` moves to 5. RNG semantics remain unchanged.
// Version 11 replaces the strict-prefix compromise checkpoint of one fixed
// operation sequence with axis-separated intermediate states: a Candidate
// carries the accepted states of its Skill lane and of its Bonus lane
// (`intermediateStateGroups`), a BuildListEntry carries at most one selected
// state per lane plus an improvement preference, and the Planner executes each
// Route as interleavable Skill / Bonus lanes whose selected states pin the
// compromise checkpoint. A version 10 `checkpointGroups` /
// `selectedCheckpointOpportunityIds` pair names strict-prefix operation
// indexes that no lane pin can be derived from, and reading it as "no
// selection" would silently drop a hard constraint, so all version 1..10
// Candidates, Build List snapshots and Plans are incompatible and fail closed
// with `calculation_context_changed`. No Dexie table shape changed, so
// `DATABASE_SCHEMA_VERSION` stays 4; the persisted entity shape does change, so
// `ExportRoot.schemaVersion` moves to 6. RNG semantics remain unchanged.
// The Execution lifecycle persistence foundation (Target lifecycle,
// `OwnedWeapon.executionInProgress`, `ExecutionSavePoint`) moves Dexie to 5 and
// `ExportRoot.schemaVersion` to 7 but deliberately stays at 11: its defaults
// change no calculation meaning, and the Target definition hash, planning-input
// hashes, expected execution state, PlanStep effects and reserve semantics are
// switched together, with their own version boundary, by a later PR.
// Version 12 switches the Execution lifecycle calculation contract
// (`docs/PLANNER_SPEC.md` 16): `createTargetDefinitionHash()` covers the Target
// performance definition only (priority, isEnabled, preferredOwnedWeaponId and
// lifecycle leave it), `PlanningInputSnapshot.targetWeaponsHash` becomes its own
// planning-input normalization and gains the Plan-dependent Target / Entry
// hashes, `ExpectedPlanState` gains the Plan-dependent Target execution state,
// every PlanStep carries `executionEffects` (tracked OwnedWeapon, Normal creation
// role, registration, observation binding, Target link, compromise label and
// Target completion), the independent `reserve_weapon` Step leaves the current
// Plan (completion rides on the last physical Step, and a zero-operation Ideal
// becomes `confirm_owned_ideal`), an owned Normal's conversion keeps its
// OwnedWeapon ID, a blind production-target Normal is bound to the user's
// observation instead of a prediction, and Ideal completion protects existing
// weapons too. A version 11 Plan's Steps, expected states and reserve Steps
// cannot be mapped onto that contract without guessing, and a version 11
// Candidate / Build List Entry carries a Target definition hash of the old
// normalization, so all version 1..11 Candidates, Build List snapshots and Plans
// are incompatible and fail closed with `calculation_context_changed`; none is
// migrated. No Dexie table or index changes, so `DATABASE_SCHEMA_VERSION` stays
// 5; the persisted ProductionPlan shape does change, so `ExportRoot.schemaVersion`
// moves to 8. RNG semantics remain unchanged.
//
// Version 13 moves the Target link of every Entry that starts from an existing
// OwnedWeapon from the Entry's first physical Step to the Plan start effect
// (`docs/PLANNER_SPEC.md` 16.2 / 16.11): Draft generation still changes nothing
// persisted, `draft -> active` applies those links in the same transaction, and
// `PlanningInputSnapshot.initialExecutionState` becomes the pre-start premise
// while the first Step's `expectedStateBefore` is the state after the start
// effect. Only a registered production-target Normal is still linked by a Step.
// A version 12 Plan expects those links on its Steps, and executing it under
// the new start would disagree with its own expected states, so every version
// 1..12 Plan fails closed with `calculation_context_changed`. Candidate Search
// and Build List snapshot semantics do not change, so an explicit build-result
// exception (`isBuildResultCalculationContextCompatible()`) keeps version 12
// Candidates and Build List Entries usable under 13; version 1..11 stay
// incompatible. No persisted shape changes,
// so `DATABASE_SCHEMA_VERSION` stays 6 and `ExportRoot.schemaVersion` stays 9.
//
// Version 14 switches the Production Planner strategy from the bounded Beam
// Search to Route commitment plus the deterministic scheduler (Issue #103
// Phase C, `docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 15.2). For the same
// PlannerInput the provisional outcome of an unresolved conflict, the returned
// `conflicts`, `rejectedBuildListEntries`, the Step order, which Entries a
// shared physical action carries, and the Planner-side preferred source
// preference (now removed) can all differ, and a persisted ProductionPlan
// records no generation strategy, so every version 1..13 Plan - Draft or
// active - fails closed with `calculation_context_changed`; none is migrated or
// rewritten. Candidate Search, the constrained enumerator and the BuildCandidate
// / BuildListEntry snapshot semantics do not change, so the explicit
// build-result exception `14 -> [12, 13]`
// (`isBuildResultCalculationContextCompatible()`) keeps version 12 and 13
// Candidates and Build List Entries usable under 14; version 1..11 stay
// incompatible. No persisted shape changes, so `DATABASE_SCHEMA_VERSION` stays
// 8, `ExportRoot.schemaVersion` stays 11 and `PRODUCTION_RNG_ENGINE_VERSION`
// is unchanged.
//
// Version 15 lets the Production Planner pass the Counter-advance forges of a
// predicted Normal creation (Issue #129, `docs/PLANNER_SPEC.md` 7.0.2): the
// first `count - 1` units of `create_normal_artian` become
// `canSkipWhenCounterPassed`, so another Entry's real forge at the same Normal
// Counter position fast-forwards them instead of making them a
// `same_normal_counter` conflict, while the production-target forge and a blind
// creation stay required. For the same PlannerInput the `conflicts`, the
// selected and rejected Entries, the Step order and the completion can differ,
// so every version 1..14 Plan - Draft or active - fails closed with
// `calculation_context_changed`; none is migrated or rewritten. Candidate
// Search and the BuildCandidate / BuildListEntry snapshot semantics do not
// change, so the explicit build-result exception `15 -> [12, 13, 14]` keeps
// version 12, 13 and 14 Candidates and Build List Entries usable under 15;
// version 1..11 stay incompatible. No persisted shape changes, so
// `DATABASE_SCHEMA_VERSION`, `ExportRoot.schemaVersion`,
// `AppSettings.schemaVersion`, `RngState.schemaVersion`,
// `PRODUCTION_RNG_ENGINE_VERSION` and the Master `dataVersion` are unchanged.
//
// Version 16 switches the Production Plan screen's Conflict what-if
// (「比較する」) and actual repair (「この候補を優先」) from the legacy B8 / B9
// constrained path to the Planner Alternative scenario (Issue #136 / #101,
// `docs/PLANNER_SPEC.md` 9.2.19, Phase 5-B). For the same PlannerInput and
// decision the saved Plan - its accepted replacements, its Conflicts, the
// expanded decision and the non-adopted Targets - can differ, and a persisted
// Plan records no generation strategy, so every version 1..15 Plan - Draft or
// active - fails closed with `calculation_context_changed`; none is migrated or
// rewritten. Candidate Search and the BuildCandidate / BuildListEntry snapshot
// semantics do not change, so the explicit build-result exception
// `16 -> [12, 13, 14, 15]` keeps version 12..15 Candidates and Build List
// Entries usable under 16; version 1..11 stay incompatible. The persisted
// `ProductionPlan.conflictRepairLineage` moves `DATABASE_SCHEMA_VERSION` to 10
// and `ExportRoot.schemaVersion` to 13 on their own; `AppSettings.schemaVersion`,
// `RngState.schemaVersion`, `PRODUCTION_RNG_ENGINE_VERSION` and the Master
// `dataVersion` are unchanged.
//
// Version 17 moves the last Production consumers of the legacy B8 constrained
// orchestration - the Build List's ordinary 「生産計画を作成」 and the running
// Plan's replan Preview - from `createConstrainedPlan()` to the ordinary
// `createPlan()` (Issue #136 / #101 Phase 6-A, `docs/PLANNER_SPEC.md` 9.2.7 /
// 9.2.19.15). Both hand the Planner `conflictResolutions = []`, so for them
// B8 never started constrained work and ordinarily returned the same ordinary
// result. But B8's orchestration budget `maxPlannerReruns = 4` also counted
// the runtime-unsupported retries inside that initial ordinary run, and the
// ordinary `createPlan()` has no such budget: an input that needs more than 4
// full runs of runtime-unsupported retries stopped with `plan = null` and
// the B8 rerun-limit warning on the old path (the literal is recorded in
// `docs/PLANNER_SPEC.md` 9.2.19.15; the path itself was removed in Phase
// 6-B2b), while the new path keeps
// excluding the unsupported Entries and can still produce a Plan. The Plan's
// existence, its selected and rejected Entries, warnings, Steps, completed
// Targets and required materials can therefore differ for the same
// PlannerInput, and a persisted Plan records no generation path, so every
// version 1..16 Plan - Draft or active - fails closed with
// `calculation_context_changed`; none is migrated or rewritten. Candidate
// Search, the constrained enumerator, RNG prediction and the BuildCandidate /
// BuildListEntry snapshot semantics do not change, so the explicit
// build-result exception `17 -> [12, 13, 14, 15, 16]` keeps version 12..16
// Candidates and Build List Entries usable under 17; version 1..11 stay
// incompatible. No persisted shape changes, so `DATABASE_SCHEMA_VERSION` stays
// 10, `ExportRoot.schemaVersion` stays 13, and `AppSettings.schemaVersion`,
// `RngState.schemaVersion`, `PRODUCTION_RNG_ENGINE_VERSION` and the Master
// `dataVersion` are unchanged.
//
// Version 18 switches the Production Plan screen's conflict resolution from the
// Planner Alternative repair to the ordinary Planner (Issue #278,
// `docs/PLANNER_SPEC.md` 9.6): 「この候補を優先」 re-runs `createPlan()` over a
// fresh input with the explicit decision set, route commitment keeps an
// explicitly preferred Entry before the others, a decision is Route-level and
// applies to initial conflicts only, a conflict whose remaining participants
// are one or none is no longer reported, and a preferred Entry that is not
// completed is never saved. For an input with explicit resolutions the Plan
// can therefore differ, so version 1..16 Plans and every version 17 Plan that
// carries a repair lineage or a selected Conflict fail closed with
// `calculation_context_changed`. An input without resolutions - the Build
// List's ordinary run, the Build List optimization's final verification and
// the replan Preview - plans exactly as under 17, so a version 17 Plan with
// `conflictRepairLineage === null` and no selected Conflict stays compatible
// through the one explicit ProductionPlan exception `18 -> 17`
// (`isProductionPlanCalculationCompatible()`), in every status. Candidate
// Search and the BuildCandidate / BuildListEntry snapshot semantics do not
// change, so the explicit build-result exception `18 -> [12, 13, 14, 15, 16,
// 17]` keeps version 12..17 Candidates and Build List Entries usable; version
// 1..11 stay incompatible. No persisted shape changes, so
// `DATABASE_SCHEMA_VERSION` stays 10, `ExportRoot.schemaVersion` stays 13, and
// `AppSettings.schemaVersion`, `RngState.schemaVersion`,
// `PRODUCTION_RNG_ENGINE_VERSION` and the Master `dataVersion` are unchanged.
export const CURRENT_CALCULATION_APP_SCHEMA_VERSION = 18

export interface CalculationContext {
  gameVersion: string
  masterDataVersion: number
  rngEngineVersion: string
  appSchemaVersion: number
}

export interface RestorationBonus {
  bonusTypeId: BonusTypeId
  bonusRankId: BonusRankId
}

export type RestorationBonusSet = [
  RestorationBonus,
  RestorationBonus,
  RestorationBonus,
  RestorationBonus,
  RestorationBonus,
]

/**
 * The RngState record shape version. Version 2 adds `lastIdentifiedAt`, the
 * Identification provenance (`docs/DATA_MODEL.md` 6.1).
 */
export const RNG_STATE_SCHEMA_VERSION = 2

export interface RngState {
  id: 'current'
  schemaVersion: typeof RNG_STATE_SCHEMA_VERSION
  baseSeed: KnownValue<string>
  gogmaCounter: KnownValue<number>
  skillCounter: KnownValue<number>
  counterGate: KnownValue<number>
  notes: string | null
  /**
   * When the current Base Seed / Skill Counter / Gogma Counter were adopted from
   * a formal Identification result (`docs/RNG_SPEC.md` 9.9), or `null` when no
   * such adoption is recorded. Written only by the Identification adoption;
   * an RNG Setup save, a Debug edit, a save point record and an Execution Step
   * never write it. Reminder / recovery provenance only: it is not a
   * calculation semantic and enters no semantic hash (`docs/DATA_MODEL.md` 6.1).
   */
  lastIdentifiedAt: ISODateTimeString | null
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
}

export interface NormalArtianCounter {
  id: string
  weaponTypeId: WeaponTypeId
  rarity: NormalArtianRarity
  counter: number | null
  isConfirmed: boolean
  observationCount: number
  lastObservedAt: ISODateTimeString | null
  candidateCount: number | null
  /**
   * When the current `counter` value was adopted from a unique Normal Counter
   * Identification result (`docs/UI_FLOW.md` 6), or `null` when it was not.
   * Written only by that adoption; a manual / Debug save that changes `counter`
   * resets it to `null`, and one that leaves `counter` as it is keeps it.
   * Reminder / recovery provenance only, never a calculation semantic
   * (`docs/DATA_MODEL.md` 6.2).
   */
  lastIdentifiedAt: ISODateTimeString | null
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
}

/**
 * The AppSettings record shape version (`docs/DATA_MODEL.md` 13). Version 2
 * added `candidateSearchDefaults`. It is independent of
 * `DATABASE_SCHEMA_VERSION`, `ExportRoot.schemaVersion` and
 * `CURRENT_CALCULATION_APP_SCHEMA_VERSION`.
 */
export const APP_SETTINGS_SCHEMA_VERSION = 2

/**
 * The three Candidate Search bounds the user keeps as the usual starting
 * values of the Search screen (`docs/DATA_MODEL.md` 13, `docs/UI_FLOW.md` 9 /
 * 14). They carry no calculation meaning of their own: the Search screen copies
 * them into its per-search `CandidateSearchSettings`, and a change made there
 * is never written back. Each is a positive integer; no ordering between them
 * is required.
 */
export interface CandidateSearchDefaults {
  maxNormalAdvance: number
  maxGogmaAdvance: number
  maxSkillAdvance: number
}

/**
 * The recommended initial Candidate Search bounds: a new AppSettings record,
 * the AppSettings v1 -> v2 migration and the Export schema 11 -> 12 migration
 * use them, and `defaultCandidateSearchSettings` reuses them. The Bonus
 * (Gogma) bound starts above the Normal Artian one because the Gogma Counter
 * is shared by every weapon: another weapon's production can advance it, while
 * a Normal Artian Counter belongs to one weapon type. This is a recommendation,
 * never a validation constraint.
 */
export const recommendedCandidateSearchDefaults: Readonly<CandidateSearchDefaults> = Object.freeze({
  maxNormalAdvance: 350,
  maxGogmaAdvance: 500,
  maxSkillAdvance: 1500,
})

export interface AppSettings {
  id: 'settings'
  schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION
  debugMode: boolean
  resultPageSize: number
  defaultSearchLimit: number
  candidateSearchDefaults: CandidateSearchDefaults
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
}
