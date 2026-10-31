import { evaluateBuildListEntryStaleness } from '../buildList/staleness'
import type {
  BuildListEntryId,
  BuildListEntryStaleReason,
  CalculationContext,
  RejectedBuildListEntry,
  TargetWeaponId,
} from '../models/publicTypes'
import type { DomainValidationIssue } from '../models/validation'
import type { PlannerDependencies, PlannerInput, PlannerOptions, PlannerResult, PlannerWarningKind } from '../planner/plannerTypes'
import { validatePlannerInput, validatePlannerOptions } from '../planner/plannerValidation'
import { collectProductionPlanTargetCompletionTargetWeaponIds } from '../planner/productionPlanCompletionSummary'
import type { ProductionPlanReplanPreviewRequest, ReplanRunningPlanToken } from './replanAdoption'
import {
  prepareRunningPlanReplanOptimization,
  type RunningPlanReplanOptimizationResult,
  type RunningPlanReplanOptimizationUnsupportedReason,
} from './runningPlanReplanOptimization'
import type { ReplanTargetClassification } from './runningPlanReplanTargets'

/**
 * The explicit auxiliary of a running Plan replan (`docs/PLANNER_SPEC.md` 18.5 「補助導線（登録済みの候補での再計画）」, Issue #276 PR-5):
 * the ordinary Planner over the registered Routes of the replan target set's current Entries, offered only beside the re-optimization
 * outcomes the 18.5 table names and only when the user chooses it. Never an automatic fallback: nothing here runs a Planner, and no
 * re-optimization outcome starts the auxiliary by itself.
 *
 * - `deriveRunningPlanReplanAuxiliaryOffer()`: the 18.5 table over one re-optimization result
 * - `prepareRunningPlanReplanAuxiliaryInput()`: the press-time input over a fresh start (the replan Targets' current Entries only, the
 *   user's 「最大計画ステップ数」, the registered Routes as they are - no Entry is generated, replaced or rebuilt), as the ordinary 16.8
 *   replan Preview request, so the 16.8 Planner Worker entry (`createPlan()`), Preview and adoption contract apply unchanged
 * - `deriveRunningPlanReplanAuxiliaryShortfall()`: which replan Targets the auxiliary's ordinary Planner result does not complete, by
 *   Target ID and typed reason - never judged by a count alone
 *
 * Pure apart from the Engine's support queries (the input validation; nothing is predicted). Not re-exported by the Execution barrel,
 * like the calculation module it reads.
 */

/** Why the auxiliary is not offered beside a re-optimization result (18.5 table). */
export type RunningPlanReplanAuxiliaryNotOfferedReason =
  /** The re-optimization found a plan: nothing to replace it with. */
  | { kind: 'optimized' }
  /** The replan target set is empty: nothing would be made by either method. */
  | { kind: 'no_replan_target' }
  /** The input fails closed as a whole (a legacy duplicate, a broken selection, ...): the Build List must be tidied first. */
  | { kind: 'invalid_planner_input'; issues: Extract<RunningPlanReplanOptimizationUnsupportedReason, { kind: 'invalid_planner_input' }>['issues'] }

export type RunningPlanReplanAuxiliaryOffer =
  /**
   * Offered beside an `unsupported` result whose reasons are only `checkpoint_selection` / `unconfirmed_rng_state` /
   * `target_without_source` / `blind_route_required`, a `not_found` or a `search_bound_reached` (18.5).
   */
  | { offered: true; basis: 'unsupported_input' | 'not_found' | 'search_bound_reached' }
  | { offered: false; reason: RunningPlanReplanAuxiliaryNotOfferedReason }

/**
 * The 18.5 table over one re-optimization result. A per-old-Plan reason (`running_plan_targets_unknown`,
 * `operation_uncertain_unresolved`, `reidentification_required`), a cancellation, a calculation failure, a contract violation and an
 * adoption refusal are not results and offer nothing either; the Application never asks this for them.
 */
export function deriveRunningPlanReplanAuxiliaryOffer(result: RunningPlanReplanOptimizationResult): RunningPlanReplanAuxiliaryOffer {
  switch (result.status) {
    case 'optimized':
      return { offered: false, reason: { kind: 'optimized' } }
    case 'not_found':
    case 'search_bound_reached':
      return { offered: true, basis: result.status }
    case 'unsupported': {
      const blocking = blockingUnsupportedReason(result.reasons)
      return blocking === null ? { offered: true, basis: 'unsupported_input' } : { offered: false, reason: blocking }
    }
  }
}

function blockingUnsupportedReason(reasons: readonly RunningPlanReplanOptimizationUnsupportedReason[]): Exclude<RunningPlanReplanAuxiliaryNotOfferedReason, { kind: 'optimized' }> | null {
  for (const reason of reasons) {
    if (reason.kind === 'no_replan_target') return { kind: 'no_replan_target' }
    if (reason.kind === 'invalid_planner_input') return { kind: 'invalid_planner_input', issues: reason.issues }
  }
  return null
}

/** The fresh start the auxiliary input is prepared from: one read of the old Plan and the current state (PR-4's start reader). */
export interface RunningPlanReplanAuxiliaryStart {
  runningPlanToken: ReplanRunningPlanToken
  replanTargets: ReplanTargetClassification
  /** The fresh `createPlannerInput()` value of that read: every Target and Entry, `conflictResolutions = []`. */
  plannerInput: PlannerInput
}

export type RunningPlanReplanAuxiliaryPreparation =
  | {
      kind: 'ready'
      /**
       * The 16.8 replan Preview request of the auxiliary: the old Plan's token and the fresh input scoped to the replan Targets' current
       * Entries (in input order, stale ones included as they are; every Target kept), with the user's `options` and no conflict
       * resolution. It is run by the ordinary Planner Worker (`createPlan()`) and adopted through the unchanged 16.8 adoption.
       */
      request: ProductionPlanReplanPreviewRequest
      /** The replan target set the input was scoped to (the classification's order). */
      replanTargetWeaponIds: TargetWeaponId[]
    }
  /** The fresh state offers no auxiliary (18.5): nothing is prepared, and no other calculation starts. */
  | { kind: 'not_offered'; reason: Exclude<RunningPlanReplanAuxiliaryNotOfferedReason, { kind: 'optimized' }> }
  /** The user's 「最大計画ステップ数」 is not a valid Planner option: nothing starts and no default is substituted. */
  | { kind: 'planner_options_invalid'; issues: DomainValidationIssue[] }

/**
 * The press-time input of the auxiliary (18.5), over a fresh start. The fresh state decides again whether the auxiliary is offered at
 * all: Stage 0R (`prepareRunningPlanReplanOptimization()`, the re-optimization's own input conditions) is applied, and an empty replan
 * target set or an input that fails closed as a whole offers none. Every other outcome - Stage 0R ready, or only the reasons the
 * ordinary Planner can run (`checkpoint_selection`, `unconfirmed_rng_state`, `target_without_source`, `blind_route_required`) - prepares
 * the input. The registered Routes are used as they are and the selection of an intermediate state is kept: no Entry is changed.
 *
 * Throws for a broken caller contract (the start's classification not being PR-2's derivation over its input).
 */
export function prepareRunningPlanReplanAuxiliaryInput(
  start: RunningPlanReplanAuxiliaryStart,
  options: PlannerOptions,
  dependencies: PlannerDependencies,
): RunningPlanReplanAuxiliaryPreparation {
  const optionsValidation = validatePlannerOptions(options)
  if (!optionsValidation.isValid) return { kind: 'planner_options_invalid', issues: [...optionsValidation.issues] }
  const prepared = prepareRunningPlanReplanOptimization({ plannerInput: start.plannerInput, replanTargets: start.replanTargets }, dependencies)
  if (prepared.kind === 'unsupported') {
    const blocking = blockingUnsupportedReason(prepared.reasons)
    if (blocking !== null) return { kind: 'not_offered', reason: blocking }
  }
  const replanIds = new Set<string>(start.replanTargets.replanTargetWeaponIds)
  const plannerInput: PlannerInput = {
    ...structuredClone(start.plannerInput),
    buildListEntries: structuredClone(start.plannerInput.buildListEntries.filter((entry) => replanIds.has(entry.targetWeaponId))),
    options: { maxPlanSteps: options.maxPlanSteps },
    conflictResolutions: [],
  }
  return {
    kind: 'ready',
    request: {
      runningPlanToken: { ...start.runningPlanToken },
      plannerInput,
      calculationContext: structuredClone(start.plannerInput.calculationContext),
    },
    replanTargetWeaponIds: [...start.replanTargets.replanTargetWeaponIds],
  }
}

/**
 * Why the auxiliary's result does not complete one replan Target (18.5 「試算が完成させない目標武器」), from typed information only:
 *
 * - `no_entry`: the Target holds no current Entry, so the ordinary Planner has no registered Route for it (候補なし)
 * - `entry_excluded`: the input validation excluded its Entry, with the warning kind; a stale Entry also names its stale reasons,
 *   recomputed from the input's state (候補がstale（理由の種類）など)
 * - `search_incomplete`: the run was truncated by the 「最大計画ステップ数」 bound (探索未完了)
 * - `no_plan`: the run ended with no Plan
 * - `entry_rejected`: the Plan rejected its Entry, with the recorded reason and, for a `resource_conflict`, its cause
 *   (競合のため今回作成しない など)
 * - `not_completed`: none of the above names a cause; the Target is still reported as not completed, never counted as done
 */
export type RunningPlanReplanAuxiliaryShortfallReason =
  | { kind: 'no_entry' }
  | { kind: 'entry_excluded'; buildListEntryId: BuildListEntryId; warningKind: PlannerWarningKind; staleReasons: BuildListEntryStaleReason[] }
  | { kind: 'search_incomplete' }
  | { kind: 'no_plan' }
  | {
      kind: 'entry_rejected'
      buildListEntryId: BuildListEntryId
      reason: RejectedBuildListEntry['reason']
      resourceConflictCause: NonNullable<RejectedBuildListEntry['resourceConflictCause']> | null
    }
  | { kind: 'not_completed' }

export interface RunningPlanReplanAuxiliaryShortfall {
  /** The replan target set the auxiliary was prepared for, in its order. */
  replanTargetWeaponIds: TargetWeaponId[]
  /** The replan Targets the result's Plan completes (its `executionEffects.targetCompletions`, 9.6.9.1), in the set's order. */
  completedTargetWeaponIds: TargetWeaponId[]
  /** Every other replan Target with its reason, in the set's order. */
  uncompleted: { targetWeaponId: TargetWeaponId; reason: RunningPlanReplanAuxiliaryShortfallReason }[]
  /** True exactly when every replan Target is in `completedTargetWeaponIds` (an ID comparison, never a count). */
  completesEveryReplanTarget: boolean
}

/**
 * The replan Targets the auxiliary's ordinary Planner `result` over `request` does not complete (18.5), by Target ID and typed reason.
 * Completion is read from the Plan's own target completions and only for a result the 16.8 adoption could take (a run that was not
 * truncated); a truncated run completes nothing. The exclusions are the ordinary Planner's own input validation over the same input.
 */
export function deriveRunningPlanReplanAuxiliaryShortfall(
  prepared: { request: Pick<ProductionPlanReplanPreviewRequest, 'plannerInput'>; replanTargetWeaponIds: readonly TargetWeaponId[] },
  result: Pick<PlannerResult, 'plan' | 'termination'>,
  dependencies: PlannerDependencies,
): RunningPlanReplanAuxiliaryShortfall {
  const { plannerInput } = prepared.request
  const truncated = result.termination.status === 'incomplete'
  const completed = new Set<string>(
    truncated || result.plan === null ? [] : collectProductionPlanTargetCompletionTargetWeaponIds(result.plan) ?? [],
  )
  const validation = validatePlannerInput(plannerInput, dependencies)
  const exclusionByEntryId = new Map(validation.excludedBuildListEntryWarnings.map(({ buildListEntryId, warning }) => [buildListEntryId as string, warning.kind]))
  const rejectedByEntryId = new Map((result.plan?.rejectedBuildListEntries ?? []).map((rejected) => [rejected.buildListEntryId as string, rejected]))
  const targetById = new Map(plannerInput.targetWeapons.map((target) => [target.id as string, target]))

  const reasonOf = (targetWeaponId: TargetWeaponId): RunningPlanReplanAuxiliaryShortfallReason => {
    const entries = plannerInput.buildListEntries.filter((entry) => entry.targetWeaponId === targetWeaponId)
    if (entries.length === 0) return { kind: 'no_entry' }
    const excluded = entries.find(({ id }) => exclusionByEntryId.has(id))
    if (excluded !== undefined) {
      const warningKind = exclusionByEntryId.get(excluded.id)!
      return {
        kind: 'entry_excluded',
        buildListEntryId: excluded.id,
        warningKind,
        staleReasons: warningKind === 'build_list_entry_stale'
          ? staleReasonsOf(excluded, targetById.get(targetWeaponId) ?? null, plannerInput, plannerInput.calculationContext)
          : [],
      }
    }
    if (truncated) return { kind: 'search_incomplete' }
    if (result.plan === null) return { kind: 'no_plan' }
    const rejected = entries.map(({ id }) => rejectedByEntryId.get(id)).find((record) => record !== undefined)
    if (rejected !== undefined) {
      return { kind: 'entry_rejected', buildListEntryId: rejected.buildListEntryId, reason: rejected.reason, resourceConflictCause: rejected.resourceConflictCause ?? null }
    }
    return { kind: 'not_completed' }
  }

  const replanTargetWeaponIds = [...prepared.replanTargetWeaponIds]
  const completedTargetWeaponIds = replanTargetWeaponIds.filter((id) => completed.has(id))
  const uncompleted = replanTargetWeaponIds.filter((id) => !completed.has(id)).map((targetWeaponId) => ({ targetWeaponId, reason: reasonOf(targetWeaponId) }))
  return { replanTargetWeaponIds, completedTargetWeaponIds, uncompleted, completesEveryReplanTarget: uncompleted.length === 0 }
}

function staleReasonsOf(
  entry: PlannerInput['buildListEntries'][number],
  target: PlannerInput['targetWeapons'][number] | null,
  input: PlannerInput,
  calculationContext: CalculationContext,
): BuildListEntryStaleReason[] {
  return evaluateBuildListEntryStaleness(entry, {
    target,
    rngState: input.rngState,
    normalCounters: input.normalCounters,
    ownedWeapons: input.ownedWeapons,
    calculationContext,
  }).staleReasons
}
