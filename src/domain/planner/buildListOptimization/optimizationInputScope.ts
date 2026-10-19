/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.3 / 17.9 / 17.10): the pure derivations of the input's scope - the
 * registered Targets outside the planning Targets, and the Worker-side items of the input token. The Application and the UI read
 * these values and never recount them.
 */
import type { PlannerInput } from '../plannerTypes'
import type { ProductionPlan, TargetWeaponId } from '../../models/publicTypes'
import { createPlanningBuildListEntriesHash, createPlanningTargetWeaponsHash } from '../productionPlanGeneration'
import type { BuildListOptimizationInputToken, BuildListOptimizationOutOfScopeTargetCounts } from './buildListOptimizationResult'
import { BuildListOptimizationInvariantError } from './buildListOptimizationTypes'

/**
 * Every registered Target that is not a planning Target, in exactly one class, by the precedence completed -> disabled -> its
 * Entries were all excluded (stale and the like) -> it has no Entry. The planning Targets are never counted, so the classes never
 * add to the planning denominator (`termination.totalTargetCount`).
 */
export function countBuildListOptimizationOutOfScopeTargets(input: Pick<PlannerInput, 'targetWeapons' | 'buildListEntries'>,
  planningTargetIds: ReadonlySet<TargetWeaponId>): BuildListOptimizationOutOfScopeTargetCounts {
  const counts: BuildListOptimizationOutOfScopeTargetCounts = { noEntry: 0, excludedEntryOnly: 0, disabled: 0, completed: 0 }
  const listed = new Set<string>(input.buildListEntries.map(entry => entry.targetWeaponId))
  for (const target of input.targetWeapons) {
    if (planningTargetIds.has(target.id)) continue
    if (target.lifecycleStatus === 'completed') counts.completed += 1
    else if (!target.isEnabled) counts.disabled += 1
    else if (listed.has(target.id)) counts.excludedEntryOnly += 1
    else counts.noEntry += 1
  }
  return counts
}

/**
 * The Worker-side input token (`docs/PLANNER_SPEC.md` 17.10) of an optimization over `input` whose final Plan is `plan`: the Plan's own
 * `initialExecutionState` (Stage D' never edits the RNG state, the Normal Counters, the OwnedWeapons or a Target, so it is the input's
 * state), the input's planning Target hash (the Plan's, checked), the input Build List's hash (the Plan's is the replaced Build List's)
 * and the input's CalculationContext. The observed Draft ID and the running-Plan check stay the Application's.
 */
export function deriveBuildListOptimizationInputToken(input: PlannerInput, plan: ProductionPlan): BuildListOptimizationInputToken {
  const targetWeaponsHash = createPlanningTargetWeaponsHash(input.targetWeapons)
  if (plan.baseSnapshot.targetWeaponsHash !== targetWeaponsHash) {
    throw new BuildListOptimizationInvariantError('final_input_invariant', 'The final Plan was calculated over other Targets than the input.')
  }
  return {
    initialExecutionState: structuredClone(plan.baseSnapshot.initialExecutionState),
    targetWeaponsHash,
    inputBuildListEntriesHash: createPlanningBuildListEntriesHash(input.buildListEntries),
    calculationContext: structuredClone(input.calculationContext),
  }
}
