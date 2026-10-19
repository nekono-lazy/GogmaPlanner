import type { DomainValidationIssue, TargetWeapon } from '../models/publicTypes'
import type {
  PlannerInput,
  PlannerSearchState,
  PlannerWarning,
  ValidatedBuildListEntry,
} from './plannerTypes'
import {
  derivePlannerCheckpointRequirements,
  isIntermediatePinHeldAtRouteStart,
} from './plannerCheckpoints'
import { derivePlannerPlanningTargets } from './plannerPlanningTargets'
import { initialPlannerLaneProgress, type PlannerLaneProgress } from './plannerRouteLanes'
import { createSimulatedInventory } from './simulatedInventory'
import {
  areAllPlanningTargetsAlreadySatisfied,
  deriveTargetSatisfaction,
} from './targetSatisfaction'

export interface InitialPlannerSearchStateResult {
  isValid: boolean
  state: PlannerSearchState | null
  issues: DomainValidationIssue[]
  warnings: PlannerWarning[]
  /**
   * The planning Targets of this run (`derivePlannerPlanningTargets()`), in
   * stable ID order. The state tracks satisfaction for exactly these Targets,
   * and `preparePlannerInitialContext()` hands this same list on as the run's
   * one planning Target authority.
   */
  planningTargets: TargetWeapon[]
}

/** Creates a full Planner run start state without applying any route or RNG operation. */
export function createInitialPlannerSearchState(input: PlannerInput, validEntries: readonly ValidatedBuildListEntry[]): InitialPlannerSearchStateResult {
  const planningTargets = derivePlannerPlanningTargets(input.targetWeapons, validEntries)
  const inventory = createSimulatedInventory(input.ownedWeapons)
  if (!inventory.isValid || inventory.inventory === null) {
    return { isValid: false, state: null, issues: inventory.issues, warnings: [], planningTargets }
  }
  const routeProgressByEntryId: Record<string, PlannerLaneProgress> = {}
  const routeRuntimeByEntryId: PlannerSearchState['routeRuntimeByEntryId'] = {}
  const routeSourceVersionByEntryId: PlannerSearchState['routeSourceVersionByEntryId'] = {}
  const reachedCheckpointByEntryId: PlannerSearchState['reachedCheckpointByEntryId'] = {}
  validEntries.forEach(({ entry }) => {
    routeProgressByEntryId[entry.id] = initialPlannerLaneProgress()
    routeRuntimeByEntryId[entry.id] = { hasUnregisteredGogmaOutput: false, transientRestorationBonusScope: null }
    // An existing Gogma whose selected lane states are its own lane starts
    // already holds its compromise checkpoint: no operation produces it, so it
    // is reached before the first action (`docs/PLANNER_SPEC.md` 7.5.2).
    if (isIntermediatePinHeldAtRouteStart(entry)) reachedCheckpointByEntryId[entry.id] = true
    if (
      entry.candidateSnapshot.route.kind.startsWith('existing_gogma') &&
      entry.candidateSnapshot.route.sourceOwnedWeaponId !== null
    ) {
      routeSourceVersionByEntryId[entry.id] = 0
    }
  })
  // Only the planning Targets of this run are tracked: an active Target with no
  // valid BuildListEntry is not a goal of this Plan, so its satisfaction must
  // not reach completion, scoring or the semantic state key.
  const targetSatisfaction = deriveTargetSatisfaction(
    planningTargets,
    input.ownedWeapons,
    input.master,
  )
  const targetSatisfactionById = Object.fromEntries(
    targetSatisfaction.map(({ targetWeaponId, hasPractical, hasIdeal }) => [
      targetWeaponId,
      { hasPractical, hasIdeal },
    ]),
  ) as PlannerSearchState['targetSatisfaction']
  // A selected checkpoint is a hard constraint even when the Target already
  // holds an Ideal weapon. The Planner would otherwise finish that Target
  // without ever running its required Entry, silently discarding the
  // selection, so the input fails closed instead (`docs/PLANNER_SPEC.md` 7.5.8).
  const alreadyIdealIssues: DomainValidationIssue[] = []
  const alreadyIdealWarnings: PlannerWarning[] = []
  derivePlannerCheckpointRequirements(validEntries.map(({ entry }) => entry))
    .requirements.requiredEntryIdByTargetId.forEach((entryId, targetId) => {
      if (targetSatisfactionById[targetId]?.hasIdeal !== true) return
      const message =
        `TargetWeapon '${targetId}' already holds an Ideal weapon, but BuildListEntry '${entryId}' carries a selected intermediate state. Clear that selection in the Build List before planning.`
      alreadyIdealIssues.push({ path: 'buildListEntries', code: 'invalid_state', message })
      alreadyIdealWarnings.push({ kind: 'selected_checkpoint_target_already_ideal', message })
    })
  if (alreadyIdealIssues.length > 0) {
    return { isValid: false, state: null, issues: alreadyIdealIssues, warnings: alreadyIdealWarnings, planningTargets }
  }
  const warnings: PlannerWarning[] = areAllPlanningTargetsAlreadySatisfied(targetSatisfaction)
    ? [{
        kind: 'all_targets_already_satisfied',
        message: 'Every planning TargetWeapon (a Target with a valid BuildListEntry) already has an Ideal Gogma weapon.',
      }]
    : []
  return { isValid: true, issues: [], warnings, planningTargets, state: {
    currentRngState: structuredClone(input.rngState),
    currentNormalCounters: structuredClone(input.normalCounters),
    simulatedInventory: inventory.inventory,
    targetSatisfaction: targetSatisfactionById,
    selectedBuildListEntryIds: [],
    routeProgressByEntryId,
    routeRuntimeByEntryId,
    sourceMutationVersionByOwnedWeaponId: {},
    candidateReadySourceVersionByEntryId: {},
    routeSourceVersionByEntryId,
    inFlightExistingSourceByOwnedWeaponId: {},
    securedOwnedWeaponIdByEntryId: {},
    reachedCheckpointByEntryId,
    trace: [],
    weaponSwitchCount: 0,
    preferredSourceProgressCount: 0,
    improvementPreferenceViolationCount: 0,
    lastWeaponOperationSubjectKey: null,
    totalCost: 0,
    evaluationScore: 0,
  } }
}
