/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.7 / 17.13), Stage D': the final verification of one structural
 * candidate whose Routes Stage D generated for every planning Target.
 *
 * It re-implements no scheduler, Trace Replay, Target satisfaction or Counter advance. In order:
 *
 * 1. the final input: each generated Entry replaces its Target's one persisted Entry through the replacement authority
 *    (`resolveBuildListEntryReplacement()` / `applyBuildListEntryReplacements()` / `validateBuildListEntryReplacements()`); a generated
 *    Entry that is the Target's own Entry (the deterministic materializer's same-semantic reuse) leaves it unchanged; every other
 *    Entry is kept; `conflictResolutions = []`; `options.maxPlanSteps` = the Domain's derived bound; Targets, OwnedWeapons, RNG state,
 *    Normal Counters, CalculationContext and Master are untouched;
 * 2. the final input's validation: its planning Target set equals Stage 0's, no generated or reused Entry is excluded, and the
 *    excluded Entries and their warning kinds equal Stage 0's exactly;
 * 3. `createProductionPlanWithObserver()` - the ordinary Production Planner with its own Trace Replay (a Plan-generation error, a
 *    failed Trace Replay included, propagates: an internal inconsistency is never a rejected candidate);
 * 4. the result conditions: `completed`, every planning Target completed and counted, every planning Target's Entry selected, no
 *    Conflict, no rejected Entry, and no warning but the exclusion warnings of step 2;
 * 5. the physical identity: physical operations = Plan steps − `confirm_owned_ideal` Steps = Σ stream advances = the structural
 *    objective. A Plan meeting step 4 that breaks it fails closed (`objective_mismatch`), never a rejected candidate.
 *
 * Steps 2 and 4 that do not hold reject the candidate (the next structural candidate may still be tried); nothing here resolves a
 * Conflict, keeps a lineage or persists anything.
 */
import {
  applyBuildListEntryReplacements, resolveBuildListEntryReplacement, validateBuildListEntryReplacements, type BuildListEntryReplacement,
} from '../../buildList/buildListEntryReplacement'
import { stableStringify } from '../../models/publicTypes'
import type { BuildListEntry, BuildListEntryId, TargetWeaponId } from '../../models/publicTypes'
import { derivePlannerPlanningTargets } from '../plannerPlanningTargets'
import { roundUpPlannerMaxPlanSteps } from '../plannerStepBound'
import type { PlannerDependencies, PlannerInput, PlannerResult, PlannerWarning } from '../plannerTypes'
import { validatePlannerInput } from '../plannerValidation'
import { createProductionPlanWithObserver } from '../productionPlanGeneration'
import type { BuildListOptimizationInputExclusion, BuildListOptimizationVerificationRejection } from './buildListOptimizationResult'
import { BuildListOptimizationInvariantError, type BuildListOptimizationContext } from './buildListOptimizationTypes'
import { summarizePlanPhysicalOperations, type PlanPhysicalSummary } from './planPhysicalOperations'
import type { StructuralCandidateRouteGeneration } from './routeGenerationTypes'

/**
 * The margin of the final verification bound (`docs/PLANNER_SPEC.md` 17.13): not a condition of success, but the room that lets a
 * broken identity show as `objective_mismatch` instead of an `incomplete` run. The Build List global optimization's own constant.
 */
export const BUILD_LIST_OPTIMIZATION_MAX_PLAN_STEPS_MARGIN = 500

/** The only Plan Step type that advances no Counter and is no in-game operation (`docs/PLANNER_SPEC.md` 16.3). */
export const BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE = 'confirm_owned_ideal'

/**
 * `roundUpPlannerMaxPlanSteps(structuralObjective + planningTargetCount) + 500` (`docs/PLANNER_SPEC.md` 17.13): the scheduler counts
 * every Route action plus each Target's one securing action (`reserve_candidate` or `confirm_owned_ideal`). A structural objective
 * that is not a non-negative safe integer, a planning Target count below one, or a sum or result beyond the safe integers fails
 * closed; no guessed value (1000, 20,000) stands in.
 */
export function deriveBuildListOptimizationMaxPlanSteps(structuralObjective: number, planningTargetCount: number): number {
  if (!Number.isSafeInteger(structuralObjective) || structuralObjective < 0) {
    throw new BuildListOptimizationInvariantError('step_bound_invalid', `The structural objective must be a non-negative safe integer (got ${String(structuralObjective)}).`)
  }
  if (!Number.isSafeInteger(planningTargetCount) || planningTargetCount < 1) {
    throw new BuildListOptimizationInvariantError('step_bound_invalid', `The planning Target count must be a positive safe integer (got ${String(planningTargetCount)}).`)
  }
  const requiredActions = structuralObjective + planningTargetCount
  if (!Number.isSafeInteger(requiredActions)) {
    throw new BuildListOptimizationInvariantError('step_bound_invalid', `The required actions ${String(requiredActions)} are not a safe integer.`)
  }
  const bound = roundUpPlannerMaxPlanSteps(requiredActions) + BUILD_LIST_OPTIMIZATION_MAX_PLAN_STEPS_MARGIN
  if (!Number.isSafeInteger(bound)) {
    throw new BuildListOptimizationInvariantError('step_bound_invalid', `The final verification bound ${String(bound)} is not a safe integer.`)
  }
  return bound
}

/** The final input of Stage D' and what it replaced. */
export interface BuildListOptimizationFinalInput {
  input: PlannerInput
  /** The Entries that replace a persisted Entry, in materialization order. */
  generatedBuildListEntries: BuildListEntry[]
  /** One per generated Entry, in the same order. */
  replacements: BuildListEntryReplacement[]
  /** Targets whose generated Entry is their persisted Entry (same semantic content), in materialization order. */
  unchangedTargetWeaponIds: TargetWeaponId[]
  /** Every planning Target's Entry in the final input (generated and reused), in materialization order. */
  routeEntryIds: BuildListEntryId[]
}

function finalInputInvariant(message: string): never {
  throw new BuildListOptimizationInvariantError('final_input_invariant', message)
}

/**
 * The final input of one candidate's generated Routes (`routes`, in materialization order, one per planning Target). The replacement
 * is the Production authority's alone: a generated Entry names the one persisted Entry of its Target it replaces, the replacement set
 * removes exactly those and adds the generated Entries once. A Route equal to the Target's persisted Entry (the materializer reused
 * it) is no replacement. Anything else is an internal inconsistency of Stage D and fails closed.
 */
export function buildBuildListOptimizationFinalInput(original: PlannerInput, routes: readonly BuildListEntry[], maxPlanSteps: number): BuildListOptimizationFinalInput {
  const persisted = original.buildListEntries
  const persistedById = new Map(persisted.map(entry => [entry.id as string, entry]))
  const seenTargets = new Set<string>()
  const generated: BuildListEntry[] = []
  const replacements: BuildListEntryReplacement[] = []
  const unchanged: TargetWeaponId[] = []
  for (const entry of routes) {
    if (seenTargets.has(entry.targetWeaponId)) finalInputInvariant(`Target ${entry.targetWeaponId} has two generated Routes.`)
    seenTargets.add(entry.targetWeaponId)
    const existing = persistedById.get(entry.id)
    if (existing !== undefined) {
      const targetEntries = persisted.filter(value => value.targetWeaponId === entry.targetWeaponId)
      if (targetEntries.length !== 1 || targetEntries[0]!.id !== entry.id || stableStringify(existing) !== stableStringify(entry)) {
        finalInputInvariant(`The reused Entry ${entry.id} is not Target ${entry.targetWeaponId}'s one persisted Entry with the same content.`)
      }
      unchanged.push(entry.targetWeaponId)
      continue
    }
    const resolution = resolveBuildListEntryReplacement(persisted, entry)
    if (resolution.status !== 'ready') finalInputInvariant(`${resolution.reason}: ${resolution.detail}`)
    generated.push(entry)
    replacements.push(resolution.replacement)
  }
  const finalEntries = applyBuildListEntryReplacements(persisted, replacements, generated)
  const placement = validateBuildListEntryReplacements(finalEntries, replacements, 'replaced')
  if (!placement.isValid) finalInputInvariant(placement.issues.map(issue => issue.message).join(' '))
  return {
    input: { ...structuredClone(original), buildListEntries: structuredClone(finalEntries), conflictResolutions: [], options: { maxPlanSteps } },
    generatedBuildListEntries: generated.map(entry => structuredClone(entry)),
    replacements,
    unchangedTargetWeaponIds: unchanged,
    routeEntryIds: routes.map(entry => entry.id),
  }
}

/**
 * The excluded Entries of one validation with the warning each exclusion added, copied from the validation's typed record (no warning
 * message is read or parsed: the message is kept as the value the validation produced).
 */
export function buildListOptimizationInputExclusionsOf(validation: ReturnType<typeof validatePlannerInput>): BuildListOptimizationInputExclusion[] {
  const targetOf = new Map(validation.excludedBuildListEntries.map(({ entry }) => [entry.id as string, entry.targetWeaponId]))
  return validation.excludedBuildListEntryWarnings.map(({ buildListEntryId, warning }) => ({
    buildListEntryId, targetWeaponId: targetOf.get(buildListEntryId)!, warningKind: warning.kind, warningMessage: warning.message,
  }))
}

/** The exclusion set identity (`docs/PLANNER_SPEC.md` 17.7 item 3): Entry, Target and warning kind. */
const exclusionKey = (value: BuildListOptimizationInputExclusion) => `${value.buildListEntryId}\u0000${value.targetWeaponId}\u0000${value.warningKind}`

/**
 * The warnings no allowed warning explains (`docs/PLANNER_SPEC.md` 17.7 item 3): each warning is matched, value by value, to one equal
 * allowed warning - the same kind and the same message - and an allowed warning explains at most as many warnings as it occurs
 * (multiplicity counted). Allowed warnings left unmatched are no issue. Nothing is parsed: the message is compared as a whole value.
 * Stage D' and the adoption's [P1] share this one rule.
 */
export function unexplainedBuildListOptimizationWarnings(
  warnings: readonly PlannerWarning[],
  allowed: readonly Pick<PlannerWarning, 'kind' | 'message'>[],
): PlannerWarning[] {
  const key = (warning: Pick<PlannerWarning, 'kind' | 'message'>) => stableStringify({ kind: warning.kind, message: warning.message })
  const remaining = new Map<string, number>()
  for (const warning of allowed) remaining.set(key(warning), (remaining.get(key(warning)) ?? 0) + 1)
  return warnings.filter(warning => {
    const left = remaining.get(key(warning)) ?? 0
    if (left === 0) return true
    remaining.set(key(warning), left - 1)
    return false
  })
}

const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export interface FinalVerificationInputs {
  /** The Stage 0 context (its planning Targets are the denominator; its PlannerInput is the original input). */
  context: BuildListOptimizationContext
  /** Stage 0's excluded Entries and warning kinds. */
  inputExclusions: readonly BuildListOptimizationInputExclusion[]
  /** Stage D's output for the candidate: every planning Target generated. */
  generation: StructuralCandidateRouteGeneration
  /** The Production Planner's own dependencies (ID factory and Clock: the Plan's IDs and times are the Production ones). */
  dependencies: PlannerDependencies
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
  /** Tests only. The Production calculation never passes it: Stage D' is the ordinary Production Planner. */
  planner?: typeof createProductionPlanWithObserver
}

export type FinalVerificationOutcome =
  | {
      kind: 'optimized'
      plannerResult: PlannerResult
      finalInput: BuildListOptimizationFinalInput
      maxPlanSteps: number
      physical: PlanPhysicalSummary
      nonPhysicalStepCount: number
      fullPlannerRuns: number
    }
  | { kind: 'rejected'; rejections: BuildListOptimizationVerificationRejection[]; maxPlanSteps: number; fullPlannerRuns: number }
  | { kind: 'cancelled' }

function objectiveMismatch(message: string, detail: Record<string, unknown>): never {
  throw new BuildListOptimizationInvariantError('objective_mismatch', `${message} ${JSON.stringify(detail)}`)
}

/**
 * Stage D' over one candidate whose Routes were all generated (`docs/PLANNER_SPEC.md` 17.7). The original input is never edited;
 * the returned final input is a new value.
 */
export async function verifyBuildListOptimizationCandidate(inputs: FinalVerificationInputs): Promise<FinalVerificationOutcome> {
  const { context, generation, dependencies } = inputs
  if (generation.outcome.kind !== 'all_generated') {
    throw new BuildListOptimizationInvariantError('stage_contract_violation', `Stage D' verifies an all_generated candidate only (got ${generation.outcome.kind}).`)
  }
  const planningIds = context.planningTargets.map(target => target.id as string)
  const routeTargets = generation.generatedEntries.map(entry => entry.targetWeaponId as string)
  if (routeTargets.length !== planningIds.length || new Set(routeTargets).size !== routeTargets.length || planningIds.some(id => !routeTargets.includes(id))) {
    throw new BuildListOptimizationInvariantError('stage_contract_violation', `The generated Routes cover [${[...routeTargets].sort(compareCodeUnits).join(', ')}], not the planning Targets [${planningIds.join(', ')}].`)
  }
  const maxPlanSteps = deriveBuildListOptimizationMaxPlanSteps(generation.objective, planningIds.length)
  const final = buildBuildListOptimizationFinalInput(context.plannerInput, generation.generatedEntries, maxPlanSteps)
  const rejected = (rejections: BuildListOptimizationVerificationRejection[], fullPlannerRuns: number): FinalVerificationOutcome => ({ kind: 'rejected', rejections, maxPlanSteps, fullPlannerRuns })

  // 2. The final input's validation, planning Target set and exclusions (decided before the Planner runs).
  const validation = validatePlannerInput(final.input, dependencies)
  if (!validation.isValid) return rejected([{ code: 'final_input_invalid', issues: validation.issues.map(({ path, code }) => ({ path, code })) }], 0)
  const finalPlanning = new Set(derivePlannerPlanningTargets(final.input.targetWeapons, validation.validBuildListEntries).map(target => target.id as string))
  const stage0 = new Set(planningIds)
  const added = [...finalPlanning].filter(id => !stage0.has(id)).sort(compareCodeUnits) as TargetWeaponId[]
  const removed = planningIds.filter(id => !finalPlanning.has(id)) as TargetWeaponId[]
  const routeIds = new Set<string>(final.routeEntryIds)
  const excludedRoutes = validation.excludedBuildListEntries.map(({ entry }) => entry.id).filter(id => routeIds.has(id))
  const finalExclusions = buildListOptimizationInputExclusionsOf(validation)
  const before = new Set(inputs.inputExclusions.map(exclusionKey))
  const after = new Set(finalExclusions.map(exclusionKey))
  const missing = inputs.inputExclusions.filter(value => !after.has(exclusionKey(value)))
  const unexpected = finalExclusions.filter(value => !before.has(exclusionKey(value)))
  const inputRejections: BuildListOptimizationVerificationRejection[] = []
  if (added.length > 0 || removed.length > 0) inputRejections.push({ code: 'planning_target_set_changed', added, removed })
  if (excludedRoutes.length > 0) inputRejections.push({ code: 'generated_entry_excluded', buildListEntryIds: excludedRoutes })
  if (missing.length > 0 || unexpected.length > 0 || finalExclusions.length !== inputs.inputExclusions.length) {
    inputRejections.push({ code: 'input_exclusions_changed', missing: structuredClone(missing), unexpected: structuredClone(unexpected) })
  }
  if (inputRejections.length > 0) return rejected(inputRejections, 0)

  // 3. The ordinary Production Planner (every full run counted: the first run and each runtime-unsupported retry).
  let fullPlannerRuns = 0
  const result = await (inputs.planner ?? createProductionPlanWithObserver)(final.input, dependencies, {
    ...(inputs.shouldCancel ? { shouldCancel: inputs.shouldCancel } : {}), ...(inputs.yieldControl ? { yieldControl: inputs.yieldControl } : {}),
  }, { beforePlannerRun: () => { fullPlannerRuns += 1 } })
  if (result.termination.status === 'cancelled') return { kind: 'cancelled' }

  // 4. The result conditions.
  const rejections: BuildListOptimizationVerificationRejection[] = []
  const plan = result.plan
  const planningCount = planningIds.length
  const { termination } = result
  if (plan === null) rejections.push({ code: 'plan_missing' })
  if (termination.status !== 'completed') rejections.push({ code: 'termination_not_completed', status: termination.status, reachedLimits: [...termination.reachedLimits] })
  if (termination.completedTargetCount !== planningCount) rejections.push({ code: 'completed_target_count_mismatch', completed: termination.completedTargetCount, planning: planningCount })
  if (termination.totalTargetCount !== planningCount) rejections.push({ code: 'total_target_count_mismatch', total: termination.totalTargetCount, planning: planningCount })
  if (plan !== null) {
    const selected = new Set<string>(plan.selectedBuildListEntryIds)
    const selectionMissing = final.routeEntryIds.filter(id => !selected.has(id))
    const selectionUnexpected = plan.selectedBuildListEntryIds.filter(id => !routeIds.has(id))
    if (selectionMissing.length > 0 || selectionUnexpected.length > 0) rejections.push({ code: 'selected_entries_mismatch', missing: selectionMissing, unexpected: selectionUnexpected })
    if (plan.rejectedBuildListEntries.length > 0) rejections.push({ code: 'rejected_entries', count: plan.rejectedBuildListEntries.length })
  }
  if (result.conflicts.length > 0 || (plan?.conflicts.length ?? 0) > 0) rejections.push({ code: 'conflicts', count: Math.max(result.conflicts.length, plan?.conflicts.length ?? 0) })
  // Only the exclusion warnings of the final input's validation may stay: matched value by value, never by parsing a message.
  const unexpectedWarnings = unexplainedBuildListOptimizationWarnings(result.warnings, validation.excludedBuildListEntryWarnings.map(({ warning }) => warning))
  if (unexpectedWarnings.length > 0) rejections.push({ code: 'unexpected_warnings', warnings: structuredClone(unexpectedWarnings) })
  if (rejections.length > 0 || plan === null) return rejected(rejections, fullPlannerRuns)

  // 5. The physical identity: a Plan meeting every other condition that breaks it is a broken premise, never a rejection.
  let physical: PlanPhysicalSummary
  try {
    physical = summarizePlanPhysicalOperations(plan, final.input)
  } catch (error) {
    objectiveMismatch('The physical summary refused the Plan.', { error: error instanceof Error ? error.message : String(error) })
  }
  const unexpectedNonPhysical = Object.keys(physical.nonPhysicalSteps).filter(type => type !== BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE).sort(compareCodeUnits)
  if (unexpectedNonPhysical.length > 0) objectiveMismatch('A Step of another type advanced no Counter.', { types: unexpectedNonPhysical })
  const nonPhysicalStepCount = physical.nonPhysicalSteps[BUILD_LIST_OPTIMIZATION_NON_PHYSICAL_STEP_TYPE] ?? 0
  const identities = {
    physicalOperations: physical.physicalOperations, planSteps: physical.planSteps, nonPhysicalStepCount,
    streamAdvanceSum: physical.streamAdvanceSum, structuralObjective: generation.objective,
  }
  if (physical.physicalOperations !== physical.planSteps - nonPhysicalStepCount
    || physical.physicalOperations !== physical.streamAdvanceSum
    || physical.physicalOperations !== generation.objective) {
    objectiveMismatch('Physical operations, Plan steps without confirm_owned_ideal, the stream advances and the structural objective differ.', identities)
  }
  return { kind: 'optimized', plannerResult: result, finalInput: final, maxPlanSteps, physical, nonPhysicalStepCount, fullPlannerRuns }
}
