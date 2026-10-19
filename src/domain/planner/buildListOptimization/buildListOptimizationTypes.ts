/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17, Issue #260), Stage 0 - C.
 *
 * Shared plain-data types of the Stage 0 context, the ReachTable (Stage A), the reach options and the
 * resource assignment / coverage / structural candidate stages (Stage B / C), moved from the Global Assignment
 * Research (Issue #154, `docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.1 - 4.3), which now reuses them through its
 * own adapter. Everything here is structured-clone data: no RngEngine instance, no Clock, no random value. The
 * names follow the design's proposals; the meanings and invariants of design 4 / 5 are kept as written there.
 */
import type {
  ElementId, GroupSkillId, OwnedWeaponId, RestorationBonusScope, RestorationBonusSet, SeriesSkillId,
  TargetWeapon, TargetWeaponId, WeaponTypeId,
} from '../../models/publicTypes'
import type { PlannerInput } from '../plannerTypes'
import type { PlannerInputValidationResult } from '../plannerValidation'

/** The persisted `NormalArtianCounter.id` (`<weaponTypeId>:<rarity>`), one rarity-8 stream per weapon type. */
export type NormalArtianCounterId = string

/** How many Counter positions of each stream one scan covers (design 4.1 / 5.1 / 10.3). */
export interface ReachWindow {
  normal: number
  gogma: number
  skill: number
}

/**
 * Phase 0 output (design 4.1): the planning Target set fixed with the Production rule
 * (`validatePlannerInput().validBuildListEntries` -> `derivePlannerPlanningTargets()`), kept for every
 * later Phase. The existing BuildListEntries decide only which Targets are planning Targets; their Route
 * contents are never read again after this point.
 */
export interface BuildListOptimizationContext {
  plannerInput: PlannerInput
  validation: PlannerInputValidationResult
  /** Target ID stable order; never changed by a later Phase. */
  planningTargets: readonly TargetWeapon[]
  planningTargetIds: ReadonlySet<TargetWeaponId>
}

export type BuildListOptimizationContextResult =
  | { kind: 'context'; context: BuildListOptimizationContext }
  /**
   * `invalid_planner_input`: `validatePlannerInput()` reported issues, so the input is never continued
   * as if it were valid. `no_planning_target`: the input is valid but no Target has a valid Entry
   * (zero planning Targets, never "every active Target").
   */
  | { kind: 'unsupported_input'; reason: 'invalid_planner_input' | 'no_planning_target'; detail: string; validation: PlannerInputValidationResult }

/** `keepFamilyLayoutKey()`: the ordered slot family layout. Never an unordered multiset. */
export type LayoutKey = string

export type SourceCandidate =
  | {
      kind: 'owned_gogma'
      ownedWeaponId: OwnedWeaponId
      layout: LayoutKey
      scope: RestorationBonusScope
      currentSkillIdeal: boolean
      currentBonusIdeal: boolean
      /** A protected Gogma is a source only while both current axes are Ideal (zero-operation option). */
      isProtected: boolean
      /** `getPredictionSupport({ type: 'gogma_keep', currentBonuses: <this weapon's five slots> })`. */
      keepSupported: boolean
    }
  | {
      kind: 'owned_normal'
      ownedWeaponId: OwnedWeaponId
      layout: LayoutKey
      /** Always false: a protected Normal is never a conversion source (REQUIREMENTS 21). */
      isProtected: false
      keepSupported: boolean
    }
  | {
      kind: 'new_normal'
      counterId: NormalArtianCounterId
      /** The production-target forge position (0-based block index of that forge's result). */
      position: number
      layout: LayoutKey
      keepSupported: boolean
    }

export type ExcludedOwnedWeaponReason =
  | 'protected_gogma_not_ideal'
  | 'protected_normal'
  | 'normal_rarity_not_8'

export interface InclusiveRange {
  from: number
  to: number
}

export interface TargetReach {
  targetWeaponId: TargetWeaponId
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  /** The confirmed rarity-8 Normal Counter of the weapon type, or null (then no `new_normal` source exists). */
  normalCounterId: NormalArtianCounterId | null
  /** `getPredictionSupport()` of the Target's weapon type / element; Keep support is per source (`keepSupported`). */
  support: { normal: boolean; skill: boolean; gogmaReset: boolean }
  skill: {
    /**
     * Ideal Skill positions among `originSkill .. originSkill + window.skill` (ascending). The last
     * position is reachable only by a conversion Route's final Skill (SEARCH_SPEC 3.1: `M + 1`
     * positions); a Reset Skills of an existing Gogma uses positions up to `resetSkillsLimit`.
     */
    idealPositions: number[]
    resetSkillsLimit: number
    conversionLimit: number
  }
  bonus: {
    /** Gogma positions whose Reset result is Ideal in `gogma_artian` scope (ascending). */
    resetIdealPositions: number[]
    /** Ordered family layout of every scanned Reset result, in position order (for `reset_then_keep`). */
    resetLayoutByPosition: Map<number, LayoutKey>
    /**
     * Positions whose Keep from the layout is Ideal, for every layout of interest (a layout whose family
     * multiset equals the Ideal's and that occurs as a source or Reset layout in the window), keys in
     * ascending order. A layout outside the Ideal multiset is never Keep-Ideal (Keep preserves families)
     * and is therefore never predicted.
     */
    keepIdealPositionsByLayout: Map<LayoutKey, number[]>
    /** Layouts of interest whose Keep prediction input is unsupported by the Engine (no Keep option from them). */
    keepUnsupportedLayouts: LayoutKey[]
  }
  /** Owned sources in OwnedWeapon ID order, then `new_normal` by position. */
  sources: SourceCandidate[]
  excludedOwnedWeapons: { ownedWeaponId: OwnedWeaponId; reason: ExcludedOwnedWeaponReason }[]
}

export interface ReachScanSummary {
  /** Engine prediction calls actually made (memo misses). */
  predictions: { skill: number; gogmaReset: number; gogmaKeep: number; normal: number }
  /** Prediction requests answered from the memo (shared between Targets of one weapon type / element). */
  memoHits: { skill: number; gogmaReset: number; gogmaKeep: number; normal: number }
  supportQueries: number
  groups: {
    weaponTypeId: WeaponTypeId
    elementId: ElementId
    targetWeaponIds: TargetWeaponId[]
    keepLayoutsOfInterest: LayoutKey[]
  }[]
  /** Unsupported predictions: an option absence, never "the Ideal is unreachable". */
  unsupported: { targetWeaponId: TargetWeaponId; prediction: 'skill' | 'gogma_reset' | 'gogma_keep' | 'normal_artian'; reason: string; layout?: LayoutKey }[]
}

/**
 * The option set a ReachTable's options follow (design 5.2 / 19). It is stored on the table, and every Stage reads the option rule
 * of a table from it, so Stage A, B and C never judge one option by two different rules, and a result produced with one option set
 * is never read as another.
 *
 * `id` names the option set; `continuesCurrentIdealLanes` is the one rule it varies. When true (the continuation, G2 / A-2), an
 * unprotected owned Gogma's lane that is already Ideal also lists that lane's operations after `none` (`reset_skills` on a
 * current-Ideal Skill, `reset` / `keep_from_source` / `reset_then_keep` on a current-Ideal `gogma_artian` Bonus), except on a
 * source that is Ideal on both axes for the Target (G4-iii: the Planner never commits that Target's own Entry) and on a protected
 * source (REQUIREMENTS 21); when false, a current-Ideal lane has the requirement `none` only.
 *
 * The Build List global optimization runs `BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET` alone (`docs/PLANNER_SPEC.md` 17.6: the
 * option set the Research accepted as `a2`). The rule without continuation exists so that the Global Assignment Research reuses
 * this one authority for its own earlier option set (`a1`); its identities and its selection stay in the Research.
 */
export interface ReachOptionSet {
  readonly id: string
  readonly continuesCurrentIdealLanes: boolean
}

/** The option set of the Build List global optimization: an owned Gogma's current-Ideal lanes continue (the Research `a2` rule). */
export const BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET: ReachOptionSet = Object.freeze({
  id: 'build-list-optimization-reach-options:v1',
  continuesCurrentIdealLanes: true,
})

export interface ReachTable {
  /** The `ReachOptionSet.id` this table's options follow. */
  optionSet: string
  /** The `ReachOptionSet.continuesCurrentIdealLanes` every Stage derives and validates this table's options with. */
  continuesCurrentIdealLanes: boolean
  originSkill: number
  originGogma: number
  originNormal: Record<NormalArtianCounterId, number>
  window: ReachWindow
  /** The positions actually scanned per stream (inclusive). Nothing outside them is "absent". */
  scanned: { skill: InclusiveRange; gogma: InclusiveRange; normal: Record<NormalArtianCounterId, InclusiveRange> }
  /** The same elements and order as `BuildListOptimizationContext.planningTargets`. */
  targets: TargetReach[]
  summary: ReachScanSummary
}

export type ReachTableUnsupportedReason = 'unconfirmed_rng_state' | 'target_without_source' | 'blind_route_required' | 'checkpoint_selection'

export type ReachTableResult =
  | { kind: 'reach_table'; table: ReachTable }
  /**
   * `unconfirmed_rng_state`: Base Seed, Skill Counter or Gogma Counter is not a confirmed value, so no
   * stream origin exists. `target_without_source`: a planning Target has no owned source and no confirmed
   * rarity-8 Normal Counter (the blind variant is never an option). `blind_route_required`: a planning
   * Target has no owned source and its Normal prediction is unsupported, so only a blind Route could
   * reach it. `checkpoint_selection`: a valid Entry of a planning Target holds a selected intermediate
   * state, which this design never pins (design 15.1). None of them means the Ideal is unreachable. The
   * names are the concept names of `docs/PLANNER_SPEC.md` 17.4.
   */
  | { kind: 'unsupported_input'; reason: ReachTableUnsupportedReason; detail: string }
  /** `shouldCancel()` returned true; the partial scan is reported as progress, never as "no option". */
  | { kind: 'cancelled'; progress: { predictions: ReachScanSummary['predictions']; lastGroup: { weaponTypeId: WeaponTypeId; elementId: ElementId } | null } }

export type SkillRequirement =
  | { kind: 'none' }
  /** Owned Gogma: the last Reset Skills position `s*`. */
  | { kind: 'reset_skills'; finalPosition: number }
  /** New / owned Normal: conversion at `c`, final Skill position `s*` (`c = s*`: the conversion Skill is Ideal). */
  | { kind: 'conversion'; conversionPosition: number; finalPosition: number }

export type BonusRequirement =
  | { kind: 'none' }
  | { kind: 'reset'; finalPosition: number }
  | { kind: 'keep_from_source'; finalPosition: number }
  /** `Keep(layout(Reset(resetPosition)), finalPosition)` is Ideal, `resetPosition < finalPosition`. */
  | { kind: 'reset_then_keep'; resetPosition: number; finalPosition: number }

export interface StreamEnd {
  skill: number
  gogma: number
  normal: Record<NormalArtianCounterId, number>
}

/**
 * One necessary condition under which one Target reaches its Ideal (design 4.3 / 5.2): a source plus
 * the required Counter positions of each stream. It is not a Route, and it proves no coexistence.
 */
export interface ReachOption {
  targetWeaponId: TargetWeaponId
  source: SourceCandidate
  skillRequired: SkillRequirement
  bonusRequired: BonusRequirement
  /** The production-target forge of a `new_normal` source, otherwise null. */
  normalRequired: { counterId: NormalArtianCounterId; position: number } | null
  /** Last required position + 1 per stream; a stream without an operation ends at its origin. */
  streamEnd: StreamEnd
  /** `necessary_only` from the scan; `rng_replayed` only after `replayReachOptionRequiredOnly()` (design 5.3). */
  verification: 'necessary_only' | 'rng_replayed'
}

/** The required-only replay's final weapon state (design 5.3 `rng_replayed`, the shape 8.3 later compares). */
export interface ReachOptionFinalState {
  finalBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

export type BuildListOptimizationInvariantCode =
  | 'target_not_planning'
  | 'source_missing'
  | 'source_kind_mismatch'
  | 'requirement_inconsistent'
  | 'prediction_unsupported'
  | 'ideal_mismatch'
  | 'engine_contract_violation'
  | 'window_invalid'
  /** Phase C-1: a coverage / materialization order derivation contradicted its own pre-check (design 8.2). */
  | 'coverage_invariant'
  /** Stage D': the structural objective or the planning Target count cannot derive a final verification bound (`docs/PLANNER_SPEC.md` 17.13). */
  | 'step_bound_invalid'
  /** Stage D': the generated Entries do not replace the Build List through the replacement authority as Stage D promised. */
  | 'final_input_invariant'
  /** Stage D': a Plan meeting every other condition breaks the physical operation identities (`docs/PLANNER_SPEC.md` 17.7 item 6). */
  | 'objective_mismatch'
  /** A Stage's own output contradicts the next Stage's contract (a structural candidate without every planning Target, an unknown event). */
  | 'stage_contract_violation'

/**
 * An internal inconsistency (design 5.3): the scan and the Ideal judgement share one authority, so a mismatch is a bug, never a game
 * fact, and it is never read as "no option" or "no candidate". The Global Assignment Research catches it under its own name (the same
 * constructor).
 */
export class BuildListOptimizationInvariantError extends Error {
  readonly code: BuildListOptimizationInvariantCode

  constructor(code: BuildListOptimizationInvariantCode, message: string) {
    super(message)
    this.name = 'BuildListOptimizationInvariantError'
    this.code = code
  }
}
