/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.3 / 17.6), Stage 0 (moved from the Global Assignment
 * Research Phase 0, Issue #154).
 *
 * Fixes the planning Target set of one PlannerInput with exactly the Production rule
 * (`docs/PLANNER_SPEC.md` 4.1, `docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.1):
 * `validatePlannerInput()` -> `validBuildListEntries` -> `derivePlannerPlanningTargets()`. It never
 * re-derives the set from the raw Build List or from every active Target, never continues an invalid
 * input, and reads the existing Entries only for this membership question - their Route contents
 * (source, Counter positions, Candidate) are not an input of any later Phase.
 */
import { derivePlannerPlanningTargets } from '../plannerPlanningTargets'
import type { PlannerDependencies, PlannerInput } from '../plannerTypes'
import { validatePlannerInput, type PlannerInputValidationResult } from '../plannerValidation'
import type { BuildListOptimizationContext, BuildListOptimizationContextResult } from './buildListOptimizationTypes'

export function createBuildListOptimizationContext(plannerInput: PlannerInput, dependencies: PlannerDependencies): BuildListOptimizationContextResult {
  return createBuildListOptimizationContextFromValidation(plannerInput, validatePlannerInput(plannerInput, dependencies))
}

/**
 * The same Stage 0 context over a `validatePlannerInput()` result of `plannerInput` the caller already holds (the plan creation
 * method of `docs/PLANNER_SPEC.md` 17.2 judges the input once and derives the optimization's preconditions from that very
 * validation). The rule is `createBuildListOptimizationContext()`'s; `validation` must be the validation of `plannerInput`.
 */
export function createBuildListOptimizationContextFromValidation(plannerInput: PlannerInput, validation: PlannerInputValidationResult): BuildListOptimizationContextResult {
  if (!validation.isValid) {
    const detail = validation.issues.map(issue => `${issue.path}: ${issue.message}`).join(' ')
    return { kind: 'unsupported_input', reason: 'invalid_planner_input', detail, validation }
  }
  const planningTargets = derivePlannerPlanningTargets(plannerInput.targetWeapons, validation.validBuildListEntries)
  if (planningTargets.length === 0) {
    const excluded = validation.excludedBuildListEntries.map(({ entry, reason }) => `${entry.id} ${reason}`).join(' ')
    return { kind: 'unsupported_input', reason: 'no_planning_target', validation,
      detail: `No valid BuildListEntry gives a planning Target (${plannerInput.buildListEntries.length} Entries, ${validation.excludedBuildListEntries.length} excluded${excluded ? `: ${excluded}` : ''}).` }
  }
  const context: BuildListOptimizationContext = {
    plannerInput,
    validation,
    planningTargets: Object.freeze([...planningTargets]),
    planningTargetIds: new Set(planningTargets.map(target => target.id)),
  }
  return { kind: 'context', context }
}

export interface PlanningTargetSetComparison {
  unchanged: boolean
  /** Planning Targets of `other` that the context does not hold. */
  added: string[]
  /** Planning Targets of the context that `other` no longer holds. */
  removed: string[]
  otherIsValid: boolean
}

/**
 * Whether another PlannerInput (for example the final input of a later Phase, with generated Entries
 * swapped in) fixes the same planning Target ID set as the context (design 13.1 Phase 0 case 6,
 * `planning_target_set_changed`). An invalid `other` is reported as such and compared against an empty
 * set, never read as "unchanged".
 */
export function comparePlanningTargetSet(context: BuildListOptimizationContext, other: PlannerInput, dependencies: PlannerDependencies): PlanningTargetSetComparison {
  const validation = validatePlannerInput(other, dependencies)
  const otherIds = validation.isValid
    ? new Set(derivePlannerPlanningTargets(other.targetWeapons, validation.validBuildListEntries).map(target => target.id))
    : new Set<string>()
  const added = [...otherIds].filter(id => !context.planningTargetIds.has(id as typeof context.planningTargets[number]['id'])).sort()
  const removed = [...context.planningTargetIds].filter(id => !otherIds.has(id)).sort()
  return { unchanged: validation.isValid && added.length === 0 && removed.length === 0, added, removed, otherIsValid: validation.isValid }
}
