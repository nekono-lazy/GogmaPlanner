import type {
  CalculationContext,
  ISODateTimeString,
  ProductionPlan,
  TargetWeapon,
} from '../models/publicTypes'
import { validateProductionPlan, validateTargetWeapon } from '../models/publicTypes'
import {
  applyProductionPlanStartTargetLinks,
  deriveProductionPlanStartTargetLinks,
  inspectProductionPlanStartTargetLinkChanges,
  type ProductionPlanStartTargetLinkChange,
} from '../planner/productionPlanStartEffects'
import { validateTargetPreferredOwnedWeapons } from '../target/preferredOwnedWeapon'
import { executionFailure } from './executionRuntimeError'
import {
  assertExecutableProductionPlan,
  assertPlanDependenciesUnchanged,
  createActualExecutionState,
  executionStateMatches,
  requireCurrentPlanStep,
  type ExecutionPersistedState,
} from './planExecutionState'
import { inconsistent } from './stepExecution'

export interface ProductionPlanStartInput {
  plan: ProductionPlan
  /** Every persisted Plan whose status is `active` or `stale`. */
  runningPlans: readonly ProductionPlan[]
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  now: ISODateTimeString
}

/** Everything one Plan start writes: the active Plan and the Targets the start effect changed. */
export interface ProductionPlanStartWrite {
  plan: ProductionPlan
  targetWeapons: TargetWeapon[]
}

/**
 * The Target preference changes starting this Plan would make against the
 * given Targets (`docs/UI_FLOW.md` 11, `docs/PLANNER_SPEC.md` 16.11), for the
 * read-only pre-start preview. It reads the same start-effect authority the
 * start applies and decides nothing: the start re-derives and re-verifies
 * everything inside its own transaction.
 */
export function inspectProductionPlanStartTargetLinks(
  plan: Pick<ProductionPlan, 'selectedBuildListEntryIds'>,
  state: Pick<ExecutionPersistedState, 'targetWeapons' | 'buildListEntries'>,
): ProductionPlanStartTargetLinkChange[] {
  return inspectProductionPlanStartTargetLinkChanges(
    state.targetWeapons,
    deriveProductionPlanStartTargetLinks(plan.selectedBuildListEntryIds, state.buildListEntries),
  )
}

/**
 * Starts executing a draft Plan (`docs/PLANNER_SPEC.md` 16.2).
 *
 * Starting performs no game operation, so no Counter advances, no OwnedWeapon
 * changes, no weapon becomes in progress, and no ExecutionHistory is recorded.
 * It moves the Plan `draft -> active` and applies the Plan start effect: the
 * Target of each Entry that starts from an existing OwnedWeapon comes to prefer
 * that weapon, and any other Target preferring it prefers nothing (16.11).
 *
 * It is refused unless the Plan is an executable current Plan, no other Plan is
 * running, its Plan-dependent premises are unchanged, and the persisted state
 * equals `PlanningInputSnapshot.initialExecutionState`. After the start effect
 * the state must equal the first Step's `expectedStateBefore`, and the Targets
 * must pass entity and preference collection validation; otherwise nothing is
 * written. A Target that already prefers its weapon is not rewritten.
 */
export function prepareProductionPlanStart(input: ProductionPlanStartInput): ProductionPlanStartWrite {
  const { plan, state, now } = input
  if (plan.status !== 'draft') {
    executionFailure(
      'plan_not_startable',
      `ProductionPlan '${plan.id}' is '${plan.status}'; only a draft Plan can start.`,
    )
  }
  if (plan.steps.length === 0 || plan.currentStepId === null) {
    executionFailure(
      'plan_not_startable',
      `ProductionPlan '${plan.id}' has no Step to execute.`,
    )
  }
  assertExecutableProductionPlan(plan, input.currentCalculationContext)
  const otherRunning = input.runningPlans.filter(({ id }) => id !== plan.id)
  if (otherRunning.length > 0) {
    executionFailure(
      'running_plan_conflict',
      `ProductionPlan '${otherRunning[0].id}' is already running (${otherRunning[0].status}).`,
    )
  }
  const step = requireCurrentPlanStep(plan, plan.currentStepId)
  assertPlanDependenciesUnchanged(plan, state.targetWeapons, state.buildListEntries)
  // A draft has executed nothing, so no observation binding applies.
  if (!executionStateMatches(createActualExecutionState(plan, state, []), plan.baseSnapshot.initialExecutionState)) {
    executionFailure(
      'execution_state_mismatch',
      `The current RNG, Normal Counter, OwnedWeapon or Plan-dependent Target state differs from the state ProductionPlan '${plan.id}' was calculated from.`,
    )
  }

  const links = deriveProductionPlanStartTargetLinks(plan.selectedBuildListEntryIds, state.buildListEntries)
  const nextTargets = applyProductionPlanStartTargetLinks(state.targetWeapons, links)
  const changedTargets = nextTargets.flatMap((target, index): TargetWeapon[] =>
    target.preferredOwnedWeaponId === state.targetWeapons[index].preferredOwnedWeaponId
      ? []
      : [{ ...target, updatedAt: now }],
  )
  if (!executionStateMatches(createActualExecutionState(plan, { ...state, targetWeapons: nextTargets }, []), step.expectedStateBefore)) {
    inconsistent(`The Plan start effect of ProductionPlan '${plan.id}' does not reach its first Step's expectedStateBefore.`)
  }
  for (const target of changedTargets) {
    const validation = validateTargetWeapon(target)
    if (!validation.isValid) {
      executionFailure('entity_validation_failed', `TargetWeapon '${target.id}' fails Domain validation after the Plan start.`, validation.issues)
    }
  }
  const preferences = validateTargetPreferredOwnedWeapons(nextTargets, state.ownedWeapons)
  if (!preferences.isValid) {
    executionFailure('collection_validation_failed', 'The Target preferred owned weapon collection is invalid after the Plan start.', preferences.issues)
  }

  const started: ProductionPlan = { ...structuredClone(plan), status: 'active', updatedAt: now }
  const validation = validateProductionPlan(started)
  if (!validation.isValid) {
    executionFailure(
      'entity_validation_failed',
      `The started ProductionPlan '${plan.id}' fails Domain validation.`,
      validation.issues,
    )
  }
  return { plan: started, targetWeapons: changedTargets }
}
