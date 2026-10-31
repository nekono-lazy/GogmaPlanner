import type { DomainValidationIssue, TargetWeapon } from '../models/publicTypes'
import { hasIntermediateStateSelection } from '../buildList/buildListEntry'
import type {
  PlannerInput,
  PlannerSearchState,
  PlannerWarning,
  ValidatedBuildListEntry,
} from './plannerTypes'
import { derivePlannerPlanningTargets } from './plannerPlanningTargets'
import { initialPlannerLaneProgress, type PlannerLaneProgress } from './plannerRouteLanes'
import { createSimulatedInventory } from './simulatedInventory'

export interface InitialPlannerSearchStateResult {
  isValid: boolean
  state: PlannerSearchState | null
  issues: DomainValidationIssue[]
  warnings: PlannerWarning[]
  /**
   * The planning Targets of this run (`derivePlannerPlanningTargets()`), in
   * stable ID order. The state tracks completion for exactly these Targets,
   * and `preparePlannerInitialContext()` hands this same list on as the run's
   * one planning Target authority.
   */
  planningTargets: TargetWeapon[]
}

/**
 * The one fail closed left of the abolished compromise checkpoints
 * (`docs/PLANNER_SPEC.md` 20.7 / 20.10, `docs/DATA_MODEL.md` 9.4): a valid
 * BuildListEntry that still carries a selected intermediate state of an earlier
 * calculation version. The current Planner plans no intermediate state, so the
 * whole input fails closed rather than reading the selection as empty; the
 * selection is never cleared and the Entry never rewritten. A legacy Entry is
 * `calculation_context_changed` and therefore never valid, so this guards the
 * contract rather than an ordinary input. A non-`planner` improvement
 * preference alone is no selection (17.4): the Planner no longer orders lanes
 * by it (7.6).
 */
function selectedIntermediateStateFailure(
  validEntries: readonly ValidatedBuildListEntry[],
): { issues: DomainValidationIssue[]; warnings: PlannerWarning[] } {
  const selected = validEntries
    .map(({ entry }) => entry)
    .filter(hasIntermediateStateSelection)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return {
    issues: selected.map((entry) => ({
      path: `buildListEntries.${entry.id}.intermediateStateSelection`,
      code: 'invalid_state' as const,
      message: selectedIntermediateStateMessage(entry.id),
    })),
    warnings: selected.map((entry) => ({
      kind: 'invalid_checkpoint_selection' as const,
      message: selectedIntermediateStateMessage(entry.id),
    })),
  }
}

function selectedIntermediateStateMessage(entryId: string): string {
  return `BuildListEntry '${entryId}' carries a selected intermediate state, which the current Planner no longer plans (Issue #100). Search its Target again and replace the BuildListEntry before planning.`
}

/**
 * Creates a full Planner run start state without applying any route or RNG
 * operation.
 *
 * Every planning Target starts incomplete (Issue #334 PR-3,
 * `docs/PLANNER_SPEC.md` 21.5): an owned weapon that already performs the
 * Target's completion condition completes nothing at Planner start, so the
 * Build List Route is executed as it is. A Target completes only once its own
 * Entry secured a weapon - its zero-operation `confirm_owned_ideal`, which the
 * caller applies after this state exists, included. Calculation schema 11..19
 * derived the start satisfaction from the inventory here and reported every
 * planning Target as satisfied with `all_targets_already_satisfied`.
 */
export function createInitialPlannerSearchState(input: PlannerInput, validEntries: readonly ValidatedBuildListEntry[]): InitialPlannerSearchStateResult {
  const planningTargets = derivePlannerPlanningTargets(input.targetWeapons, validEntries)
  const inventory = createSimulatedInventory(input.ownedWeapons)
  if (!inventory.isValid || inventory.inventory === null) {
    return { isValid: false, state: null, issues: inventory.issues, warnings: [], planningTargets }
  }
  const selectionFailure = selectedIntermediateStateFailure(validEntries)
  if (selectionFailure.issues.length > 0) {
    return { isValid: false, state: null, ...selectionFailure, planningTargets }
  }
  const routeProgressByEntryId: Record<string, PlannerLaneProgress> = {}
  const routeRuntimeByEntryId: PlannerSearchState['routeRuntimeByEntryId'] = {}
  const routeSourceVersionByEntryId: PlannerSearchState['routeSourceVersionByEntryId'] = {}
  validEntries.forEach(({ entry }) => {
    routeProgressByEntryId[entry.id] = initialPlannerLaneProgress()
    routeRuntimeByEntryId[entry.id] = { hasUnregisteredGogmaOutput: false, transientRestorationBonusScope: null }
    if (
      entry.candidateSnapshot.route.kind.startsWith('existing_gogma') &&
      entry.candidateSnapshot.route.sourceOwnedWeaponId !== null
    ) {
      routeSourceVersionByEntryId[entry.id] = 0
    }
  })
  // Only the planning Targets of this run are tracked: an active Target with no
  // valid BuildListEntry is not a goal of this Plan, so its completion must not
  // reach completion, scoring or the semantic state key.
  const targetSatisfaction = Object.fromEntries(
    planningTargets.map(({ id }) => [id, { completedInRun: false }]),
  ) as PlannerSearchState['targetSatisfaction']
  return { isValid: true, issues: [], warnings: [], planningTargets, state: {
    currentRngState: structuredClone(input.rngState),
    currentNormalCounters: structuredClone(input.normalCounters),
    simulatedInventory: inventory.inventory,
    targetSatisfaction,
    selectedBuildListEntryIds: [],
    routeProgressByEntryId,
    routeRuntimeByEntryId,
    sourceMutationVersionByOwnedWeaponId: {},
    candidateReadySourceVersionByEntryId: {},
    routeSourceVersionByEntryId,
    securedOwnedWeaponIdByEntryId: {},
    trace: [],
    weaponSwitchCount: 0,
    preferredSourceProgressCount: 0,
    lastWeaponOperationSubjectKey: null,
    totalCost: 0,
    evaluationScore: 0,
  } }
}
