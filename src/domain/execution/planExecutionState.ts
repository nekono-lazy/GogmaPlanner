import type {
  BuildListEntry,
  CalculationContext,
  ExecutionHistory,
  ExecutionSavePoint,
  ExecutionUndoSnapshot,
  ExpectedPlanState,
  NormalArtianCounter,
  ObservedRestorationBonusBinding,
  OwnedWeapon,
  PlanStep,
  PlanStepExecutionEffects,
  ProductionPlan,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  compareExecutionHistoryOrder,
  createExpectedPlanState,
  isExecutionContractProductionPlan,
  isProductionPlanCalculationCompatible,
  resolveObservationBindingTokens,
  validateProductionPlan,
} from '../models/publicTypes'
import {
  collectProductionPlanDependentTargetWeaponIds,
  createDependentBuildListEntriesHash,
  createDependentTargetDefinitionsHash,
} from '../planner/productionPlanGeneration'
import { inspectProductionPlanCompletionAssignmentSafety } from '../planner/productionPlanCompletionAssignmentSafety'
import { ExecutionRuntimeError, executionFailure } from './executionRuntimeError'

/**
 * The persisted state one Execution transaction reads before it decides
 * anything (`docs/PLANNER_SPEC.md` 16.1). Every collection is the whole current
 * collection, so a Plan-independent Target that prefers a tracked weapon is
 * visible too.
 */
export interface ExecutionPersistedState {
  rngState: RngState
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly BuildListEntry[]
  /** The metadata of every ExecutionHistory entry of the Plan being executed. */
  planExecutionHistory: readonly ExecutionHistory[]
  /**
   * The Undo bodies of the Plan's records after its game save point, read only
   * when the operation restores that save point (`docs/DATA_MODEL.md` 14.6).
   * Empty for every other operation: a Step confirmation, a save point record
   * or a 「現在地点を維持」 reads no Undo body.
   */
  undoSnapshotsAfterSavePoint: readonly ExecutionUndoSnapshot[]
  /** The Plan's game save point, if one was recorded. */
  executionSavePoint: ExecutionSavePoint | null
}

/** A Step of the current Execution contract always carries its effects. */
export type ExecutableProductionPlanStep = PlanStep & {
  executionEffects: PlanStepExecutionEffects
}

function sameExpectedPlanState(left: ExpectedPlanState, right: ExpectedPlanState): boolean {
  return (
    left.rngStateHash === right.rngStateHash &&
    left.normalCountersHash === right.normalCountersHash &&
    left.ownedWeaponsHash === right.ownedWeaponsHash &&
    left.targetExecutionStateHash === right.targetExecutionStateHash
  )
}

/** Which premise of `assertExecutableProductionPlan()` before its Domain validation a Plan fails. */
export type ProductionPlanExecutionContractBlock = 'calculation_context_changed' | 'plan_not_executable'

/**
 * The premises of `assertExecutableProductionPlan()` that need no Domain
 * validation, in its order: the CalculationContext compatibility, then the
 * Execution Plan contract. `null` when both hold. The assertion and the
 * read-only display judgements (Issue #335) share this one function, so a
 * display never offers what the runtime refuses for these reasons.
 */
export function productionPlanExecutionContractBlock(
  plan: ProductionPlan,
  currentCalculationContext: CalculationContext,
): ProductionPlanExecutionContractBlock | null {
  if (!isProductionPlanCalculationCompatible(plan, currentCalculationContext)) return 'calculation_context_changed'
  if (!isExecutionContractProductionPlan(plan)) return 'plan_not_executable'
  return null
}

/**
 * The Plan is an executable Plan of the current calculation schema under the current
 * CalculationContext (`isProductionPlanCalculationCompatible()`, which also keeps
 * a resolution-free version 17 Plan executable under 18). A legacy Plan keeps its
 * exact persisted contents and is refused here; it is never executed as a current Plan.
 */
export function assertExecutableProductionPlan(
  plan: ProductionPlan,
  currentCalculationContext: CalculationContext,
): void {
  const block = productionPlanExecutionContractBlock(plan, currentCalculationContext)
  if (block === 'calculation_context_changed') {
    executionFailure(
      'calculation_context_changed',
      `ProductionPlan '${plan.id}' was calculated under an incompatible CalculationContext.`,
    )
  }
  if (block === 'plan_not_executable') {
    executionFailure(
      'plan_not_executable',
      `ProductionPlan '${plan.id}' predates the Execution Plan contract and is never executable.`,
    )
  }
  const validation = validateProductionPlan(plan)
  if (!validation.isValid) {
    executionFailure(
      'plan_not_executable',
      `ProductionPlan '${plan.id}' fails Domain validation.`,
      validation.issues,
    )
  }
}

/**
 * The completion assignment premise of every operation that advances a Plan
 * (Issue #334, `docs/PLANNER_SPEC.md` 21.4.1): the Plan start (a replan
 * adoption's new Plan included), every Step confirmation (`confirmed_expected`,
 * `actual_result_different`, `operation_uncertain`) and the Current Position
 * Recovery. Judged from the state the transaction read through the one Domain
 * authority `inspectProductionPlanCompletionAssignmentSafety()`, after
 * `assertExecutableProductionPlan()` so an incompatible Plan reports
 * `calculation_context_changed` first. An unsafe Plan is refused as a whole with
 * `completion_assignment_conflict` before its conflicting completion Step is
 * reached. It is never applied to Undo, the game save point record / restore,
 * an abandonment or an approved breaking change: none of them advances the Plan.
 */
export function assertProductionPlanCompletionAssignmentSafe(
  plan: ProductionPlan,
  targetWeapons: readonly TargetWeapon[],
): void {
  const safety = inspectProductionPlanCompletionAssignmentSafety(plan, targetWeapons)
  if (safety.safe) return
  throw new ExecutionRuntimeError(
    'completion_assignment_conflict',
    `ProductionPlan '${plan.id}' would make one owned weapon the completion of two Targets (${safety.issues.map(({ reason }) => reason).join(', ')}).`,
    [],
    safety.issues,
  )
}

/** The current incomplete Step of an executable Plan. */
export function requireCurrentPlanStep(
  plan: ProductionPlan,
  planStepId: PlanStep['id'] | null,
): ExecutableProductionPlanStep {
  if (plan.currentStepId === null || planStepId !== plan.currentStepId) {
    executionFailure(
      'step_not_current',
      `PlanStep '${planStepId}' is not the current Step of ProductionPlan '${plan.id}'.`,
    )
  }
  const step = plan.steps.find(({ id }) => id === planStepId)
  if (!step || step.isCompleted) {
    executionFailure(
      'step_not_current',
      `PlanStep '${planStepId}' is not an incomplete Step of ProductionPlan '${plan.id}'.`,
    )
  }
  if (step.executionEffects === undefined) {
    executionFailure(
      'plan_not_executable',
      `PlanStep '${step.id}' carries no executionEffects.`,
    )
  }
  return step as ExecutableProductionPlanStep
}

/**
 * The Plan's invariant premises (`docs/PLANNER_SPEC.md` 16.6): the planning
 * definition of every Plan-dependent Target and every selected BuildListEntry.
 * Plan-independent Targets and Entries never take part, and the Target
 * preference / lifecycle Execution itself changes is verified by the expected
 * Target execution state instead.
 */
export function assertPlanDependenciesUnchanged(
  plan: ProductionPlan,
  targetWeapons: readonly TargetWeapon[],
  buildListEntries: readonly BuildListEntry[],
): void {
  const missingEntry = plan.selectedBuildListEntryIds.find(
    (id) => !buildListEntries.some((entry) => entry.id === id),
  )
  if (missingEntry !== undefined) {
    executionFailure(
      'plan_dependency_changed',
      `Plan-dependent BuildListEntry '${missingEntry}' no longer exists.`,
    )
  }
  if (
    createDependentBuildListEntriesHash(buildListEntries, plan.selectedBuildListEntryIds) !==
    plan.baseSnapshot.dependentBuildListEntriesHash
  ) {
    executionFailure(
      'plan_dependency_changed',
      'A Plan-dependent BuildListEntry changed after the Plan was calculated.',
    )
  }
  const dependentTargetIds = collectProductionPlanDependentTargetWeaponIds(plan, buildListEntries)
  if (
    createDependentTargetDefinitionsHash([...targetWeapons], dependentTargetIds) !==
    plan.baseSnapshot.dependentTargetDefinitionsHash
  ) {
    executionFailure(
      'plan_dependency_changed',
      'A Plan-dependent Target definition, priority, or enablement changed after the Plan was calculated.',
    )
  }
}

/**
 * The observation bindings the Plan's confirmed Steps recorded
 * (`docs/PLANNER_SPEC.md` 16.5): a Step with an observation binding and the
 * five slots the user entered when confirming it.
 */
export function collectPlanObservationBindings(
  plan: ProductionPlan,
  planExecutionHistory: readonly ExecutionHistory[],
): ObservedRestorationBonusBinding[] {
  const stepById = new Map(plan.steps.map((step) => [step.id, step]))
  return [...planExecutionHistory]
    .filter(({ planId }) => planId === plan.id)
    .sort(compareExecutionHistoryOrder)
    .flatMap((history) => {
      const step = stepById.get(history.planStepId)
      const tracked = step?.executionEffects?.trackedOwnedWeaponId ?? null
      const actual = history.actualResult
      if (
        step?.executionEffects?.observationBinding == null ||
        tracked === null ||
        actual === null ||
        actual.restorationBonuses === null ||
        actual.restorationBonusScope === null
      ) {
        return []
      }
      return [{
        ownedWeaponId: tracked,
        planStepId: step.id,
        observedRestorationBonuses: actual.restorationBonuses,
        observedRestorationBonusScope: actual.restorationBonusScope,
      }]
    })
}

/**
 * The actual execution state of the persisted entities, hashed by the same
 * authority the Plan's expected states were built with. Only a weapon whose
 * five slots and scope exactly equal a recorded observation normalizes to its
 * binding token.
 */
export function createActualExecutionState(
  plan: ProductionPlan,
  state: Pick<
    ExecutionPersistedState,
    'rngState' | 'normalCounters' | 'ownedWeapons' | 'targetWeapons' | 'buildListEntries'
  >,
  bindings: readonly ObservedRestorationBonusBinding[],
): ExpectedPlanState {
  return createExpectedPlanState(
    state.rngState,
    state.normalCounters,
    state.ownedWeapons,
    {
      targetWeapons: state.targetWeapons,
      dependentTargetWeaponIds: collectProductionPlanDependentTargetWeaponIds(
        plan,
        state.buildListEntries,
      ),
    },
    resolveObservationBindingTokens(state.ownedWeapons, bindings),
  )
}

export function executionStateMatches(
  actual: ExpectedPlanState,
  expected: ExpectedPlanState,
): boolean {
  return sameExpectedPlanState(actual, expected)
}
