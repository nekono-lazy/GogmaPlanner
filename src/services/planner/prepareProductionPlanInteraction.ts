import {
  isProductionPlanCalculationCompatible,
  type BuildListEntry,
  type BuildListEntryId,
  type CalculationContext,
  type IntermediateStateOpportunityId,
  type PlanConflict,
  type ProductionPlan,
  type ProductionPlanStatus,
  type TargetWeapon,
} from '../../domain/models/publicTypes'
import {
  createActualExecutionState,
  executionStateMatches,
} from '../../domain/execution'
import {
  createPlanningBuildListEntriesHash,
  createPlanningTargetWeaponsHash,
  derivePlannerConflictDecisionSet,
  plannerConflictDecisionExclusions,
  plannerConflictEffectiveCheckpointParticipants,
  type PlannerConflictDecisionNotCarriedReason,
  type PlannerConflictDecisionSetResult,
  type PlannerConflictResolution,
  type PlannerInput,
  type PlannerWarningKind,
} from '../../domain/planner'
import type {
  PlannerInteractionPreparationResult,
} from '../../workers/plannerWorkerContracts'

/**
 * Why a participant of a persisted Conflict cannot be preferred now. A typed
 * code only: the screen chooses its own Japanese from it and never shows an
 * internal English reason (`docs/UI_FLOW.md` 11.6.4).
 */
export type ProductionPlanParticipantUnavailableReason =
  /** The Entry is not in the current Build List. */
  | 'entry_not_found'
  /** The Entry exists, but its Target is not a current Target (`docs/UI_FLOW.md` 11.6.3). */
  | 'target_not_found'
  /** The displayed Plan is not a draft; only a draft can be changed (9.6.7). */
  | 'plan_not_draft'
  | 'preparation_invalid'
  /** Current Planner input validation excluded the Entry (`exclusionKind` says why). */
  | 'planner_validation_excluded'
  /** The Conflict is no current initial Conflict (a dynamic one, or the input changed). */
  | 'current_conflict_not_found'
  | 'not_current_conflict_participant'
  /**
   * The current conflict keeps an effective selected compromise checkpoint
   * (`docs/PLANNER_SPEC.md` 9.5.1 / 9.6.2): 「この候補を優先」 cannot settle it -
   * the Domain refuses such a resolution - and the Build List checkpoint
   * selection is the only way out. A conflict whose checkpoint participants
   * another decision of the displayed Draft already excludes is not one.
   */
  | 'checkpoint_conflict'
  /**
   * An effective explicit decision of the displayed Draft in *another*
   * Conflict leaves this participant out of the run (`docs/PLANNER_SPEC.md`
   * 9.6.3 rule 9, `docs/UI_FLOW.md` 11.6.6). The Domain would supersede that
   * decision (rule 4), but the screen does not offer it here: the user changes
   * the other Conflict's choice first (`excludingDecisions` names it). Only
   * effective decisions count - not the Planner's provisional outcome, the
   * recommendation, or an earlier decision the current input cannot carry over -
   * and re-choosing it in a Conflict whose own effective decision excludes it is
   * not this case.
   */
  | 'excluded_by_other_decision'

export interface ProductionPlanParticipantViewModel {
  buildListEntryId: BuildListEntryId
  entry: BuildListEntry | null
  target: TargetWeapon | null
  /**
   * The current Target's name, or `null` when the Entry or its Target cannot be
   * read. Never an ID and never a made-up placeholder: the screen says the
   * Target cannot be confirmed instead (`docs/UI_FLOW.md` 11.6.3).
   */
  targetName: string | null
  /**
   * The selected intermediate state this participant is competing for in the
   * *current* conflict, or `null`.
   *
   * A conflict involving a selected state cannot be resolved by picking a
   * winning Entry: the loser's selection would simply be dropped, which the
   * Planner is never allowed to do. The UI uses this to say that the Build List
   * selection has to change instead (`docs/UI_FLOW.md` 11.1).
   */
  checkpointOpportunityId: IntermediateStateOpportunityId | null
  isRecommended: boolean
  isSelected: boolean
  isAvailable: boolean
  unavailableReason: ProductionPlanParticipantUnavailableReason | null
  /**
   * The typed exclusion code of the current validation (its warning kind) when
   * `unavailableReason` is `planner_validation_excluded`; `null` otherwise, or
   * when the exclusion came from the decision set and names no kind.
   */
  exclusionKind: PlannerWarningKind | null
  /**
   * The displayed Draft's effective explicit decisions of other Conflicts that
   * leave this participant out of the run, in conflict ID order, when
   * `unavailableReason` is `excluded_by_other_decision`; empty otherwise.
   */
  excludingDecisions: PlannerConflictResolution[]
}

/**
 * Whether a persisted Conflict is a current initial Conflict, and if it is not,
 * why (`docs/PLANNER_SPEC.md` 9.6.7):
 *
 * - `current`: the current preparation detects the same Conflict ID
 * - `dynamic`: it does not, and the displayed Plan's calculation input equals
 *   the current persisted state, so the Planner found this Conflict while
 *   planning (after a drop / release / recommit); it is never choosable and a
 *   recalculation of the same input would find it again
 * - `input_changed`: it does not, and the input changed since the Plan was
 *   calculated; it cannot be reproduced over the current input
 * - `not_compared`: no safe judgement - the preparation is not `ready`, the
 *   Plan is not a draft, or the comparison could not be made. Never guessed as
 *   one of the two above
 */
export type ProductionPlanConflictCurrency = 'current' | 'dynamic' | 'input_changed' | 'not_compared'

export interface ProductionPlanConflictViewModel {
  id: string
  currency: ProductionPlanConflictCurrency
  /**
   * True when the current conflict keeps an effective selected compromise
   * checkpoint: a checkpoint participant the displayed Draft's earlier
   * decisions do not exclude (`docs/PLANNER_SPEC.md` 9.6.2). Every participant
   * is then unavailable with `checkpoint_conflict`, and the page sends the user
   * to the Build List instead of offering a winner.
   */
  involvesSelectedCheckpoint: boolean
  /**
   * For a Conflict whose persisted decision the current input cannot carry
   * over (`derivePlannerConflictDecisionSet()` rule 2), why; `null` for a
   * Conflict without a decision or whose decision is carried over. Display
   * only: the press re-derives the set and confirms what it drops.
   */
  decisionNotCarriedReason: PlannerConflictDecisionNotCarriedReason | null
  participants: ProductionPlanParticipantViewModel[]
}

/**
 * Whether the displayed Plan's calculation input equals the current persisted
 * state (`docs/PLANNER_SPEC.md` 9.6.7): `same_input`, `input_changed`, or
 * `not_compared` when no safe judgement exists (a non-draft Plan, or a
 * comparison that could not be made).
 */
export type ProductionPlanInputComparison = 'same_input' | 'input_changed' | 'not_compared'

export interface ProductionPlanInteractionViewModel {
  planStatus: ProductionPlanStatus
  isDraft: boolean
  inputComparison: ProductionPlanInputComparison
  conflicts: ProductionPlanConflictViewModel[]
}

export type ProductionPlanCalculationCompatibility =
  | { isCompatible: true; recalculationReasons: readonly [] }
  | {
      isCompatible: false
      recalculationReasons: readonly ['calculation_context_changed']
    }

/**
 * Evaluates whether a persisted Plan may enter the current interaction or
 * execution preparation path, through the one Domain authority
 * `isProductionPlanCalculationCompatible()` (`docs/PLANNER_SPEC.md` 9.6.10):
 * the Plan and its audit snapshot are judged by the same rule, and the only
 * Plan exception is the explicit, resolution-free `18 -> 17` one. Build-result
 * compatibility exceptions never apply to a Plan.
 */
export function evaluateProductionPlanCalculationCompatibility(
  plan: ProductionPlan,
  current: CalculationContext,
): ProductionPlanCalculationCompatibility {
  return isProductionPlanCalculationCompatible(plan, current)
    ? { isCompatible: true, recalculationReasons: [] }
    : {
        isCompatible: false,
        recalculationReasons: ['calculation_context_changed'],
      }
}

/**
 * Restores only persisted user choices. Planner recommendation and selected
 * output membership are deliberately not consulted.
 */
export function restorePersistedExplicitResolutions(
  input: PlannerInput,
  plan: ProductionPlan,
): PlannerInput {
  const conflictResolutions: PlannerConflictResolution[] = plan.conflicts
    .flatMap((conflict) => {
      const selectedBuildListEntryId = conflict.selectedBuildListEntryId
      return selectedBuildListEntryId === null
        ? []
        : [{
            conflictKey: conflict.id,
            selectedBuildListEntryId,
          }]
    })

  return { ...input, conflictResolutions }
}

/** Replace only this explicit choice, retaining all other explicit resolutions. */
export function mergeExplicitConflictResolution(
  input: PlannerInput,
  resolution: PlannerConflictResolution,
): PlannerInput {
  const exists = input.conflictResolutions.some(
    ({ conflictKey }) => conflictKey === resolution.conflictKey,
  )
  return {
    ...input,
    conflictResolutions: exists
      ? input.conflictResolutions.map((existing) =>
          existing.conflictKey === resolution.conflictKey
            ? { ...resolution }
            : existing,
        )
      : [...input.conflictResolutions, { ...resolution }],
  }
}

export const CHECKPOINT_CONFLICT_MESSAGE =
  'この競合には途中採用する状態の選択が関係しています。作成リストで途中採用する状態を変更または解除してください。'

/**
 * Compares the displayed draft's calculation input with the current persisted
 * state (`docs/PLANNER_SPEC.md` 9.6.7) through the authorities the Plan start
 * and the Planner result save already use, read-only: CalculationContext
 * compatibility (`isProductionPlanCalculationCompatible()`), the Draft's
 * execution state against `baseSnapshot.initialExecutionState`
 * (`createActualExecutionState()` / `executionStateMatches()`, no observation
 * binding because a draft has executed nothing), and the planning-input
 * `targetWeaponsHash` / `buildListEntriesHash` over every current Target and
 * Build List Entry. Nothing is hashed here on its own, and no field is persisted.
 *
 * A non-draft Plan has moved its state on since it was calculated, so it is
 * `not_compared`; a comparison that cannot be made safely is `not_compared` too,
 * never a guess.
 */
export function compareProductionPlanInputWithCurrentState(
  plan: ProductionPlan,
  input: PlannerInput,
): ProductionPlanInputComparison {
  if (plan.status !== 'draft') return 'not_compared'
  try {
    if (!isProductionPlanCalculationCompatible(plan, input.calculationContext)) return 'input_changed'
    const sameExecutionState = executionStateMatches(
      createActualExecutionState(plan, input, []),
      plan.baseSnapshot.initialExecutionState,
    )
    return sameExecutionState &&
      createPlanningTargetWeaponsHash(input.targetWeapons) === plan.baseSnapshot.targetWeaponsHash &&
      createPlanningBuildListEntriesHash(input.buildListEntries) === plan.baseSnapshot.buildListEntriesHash
      ? 'same_input'
      : 'input_changed'
  } catch {
    return 'not_compared'
  }
}

type ParticipantAvailability = Pick<
  ProductionPlanParticipantViewModel,
  'isAvailable' | 'unavailableReason' | 'exclusionKind' | 'excludingDecisions'
>

function unavailable(
  reason: ProductionPlanParticipantUnavailableReason,
  exclusionKind: PlannerWarningKind | null = null,
  excludingDecisions: readonly PlannerConflictResolution[] = [],
): ParticipantAvailability {
  return {
    isAvailable: false,
    unavailableReason: reason,
    exclusionKind,
    excludingDecisions: excludingDecisions.map((resolution) => ({ ...resolution })),
  }
}

function available(): ParticipantAvailability {
  return { isAvailable: true, unavailableReason: null, exclusionKind: null, excludingDecisions: [] }
}

/**
 * What the displayed Draft's earlier decisions still mean over the current
 * preparation (`derivePlannerConflictDecisionSet()` with no new decision). A
 * refused reading - a non-draft or an inconsistent Draft - excludes nothing,
 * so every checkpoint participant counts as effective: the conservative
 * reading. `null` while no `ready` preparation exists.
 */
function carriedDecisions(
  plan: ProductionPlan,
  input: PlannerInput,
  preparation: PlannerInteractionPreparationResult,
): PlannerConflictDecisionSetResult | null {
  if (preparation.status !== 'ready') return null
  return derivePlannerConflictDecisionSet({
    displayedPlan: plan,
    currentCalculationContext: input.calculationContext,
    preparation,
    decision: null,
  })
}

function participantAvailability(
  plan: ProductionPlan,
  input: PlannerInput,
  conflict: PlanConflict,
  entry: BuildListEntry | undefined,
  target: TargetWeapon | null,
  preparation: PlannerInteractionPreparationResult,
  carriedExcluded: readonly BuildListEntryId[],
  carriedExclusions: ReadonlyMap<BuildListEntryId, readonly PlannerConflictResolution[]>,
): ParticipantAvailability {
  if (!entry) return unavailable('entry_not_found')
  // An Entry whose Target is gone is excluded by validation anyway; it is
  // named first so the screen says the Target cannot be confirmed.
  if (target === null) return unavailable('target_not_found')
  if (plan.status !== 'draft') return unavailable('plan_not_draft')
  if (preparation.status === 'invalid') return unavailable('preparation_invalid')
  if (!preparation.validBuildListEntryIds.includes(entry.id)) {
    const excluded = preparation.excludedBuildListEntries.find(
      ({ buildListEntryId }) => buildListEntryId === entry.id,
    )
    return unavailable('planner_validation_excluded', excluded?.kind ?? null)
  }
  const currentConflict = preparation.currentConflicts.find(
    ({ id }) => id === conflict.id,
  )
  if (!currentConflict) return unavailable('current_conflict_not_found')
  if (!currentConflict.buildListEntryIds.includes(entry.id)) {
    return unavailable('not_current_conflict_participant')
  }
  if (plannerConflictEffectiveCheckpointParticipants(currentConflict, carriedExcluded).length > 0) {
    // Conservative by contract: a conflict an effective selected checkpoint
    // takes part in is out of scope for winner selection, whichever side it
    // sits on (`docs/PLANNER_SPEC.md` 9.5.1 / 9.6.2).
    return unavailable('checkpoint_conflict')
  }
  // The same Domain authority the press runs (9.6.3 rule 1). The set-level
  // refusals (an inconsistent set, two preferred Entries in an undecided
  // conflict) are explained when the user presses, so they do not make the
  // participant unavailable here. A refusal that holds whatever the other
  // Conflicts decided (preferring a checkpoint participant itself) is named
  // before the exclusion below, which changing another choice would lift.
  const decisionSet = derivePlannerConflictDecisionSet({
    displayedPlan: plan,
    currentCalculationContext: input.calculationContext,
    preparation,
    decision: { conflictKey: conflict.id, selectedBuildListEntryId: entry.id },
  })
  if (decisionSet.status === 'refused') {
    switch (decisionSet.refusal.reason) {
      case 'checkpoint_conflict':
        return unavailable('checkpoint_conflict')
      case 'plan_not_editable':
        return unavailable('plan_not_draft')
      case 'conflict_not_current':
        return unavailable('current_conflict_not_found')
      case 'entry_not_participant':
        return unavailable('not_current_conflict_participant')
      case 'entry_not_valid':
        return unavailable('planner_validation_excluded')
      case 'inconsistent_decision_set':
      case 'preferred_entries_conflict':
        break
    }
  }
  // 9.6.3 rule 9: an effective decision of another Conflict leaves this
  // participant out of the run, so it is not offered here even though the
  // Domain would supersede that decision. Re-choosing it where this
  // Conflict's own effective decision excludes it stays a re-choice, even when
  // other decisions exclude it too: otherwise an Entry several decisions
  // exclude could be chosen in no Conflict at all.
  const excluders = carriedExclusions.get(entry.id) ?? []
  const otherExcluders = excluders.filter(({ conflictKey }) => conflictKey !== conflict.id)
  if (otherExcluders.length > 0 && otherExcluders.length === excluders.length) {
    return unavailable('excluded_by_other_decision', null, otherExcluders)
  }
  return available()
}

/**
 * The explicit decision set of one 「この候補を優先」 over the current
 * preparation (`docs/PLANNER_SPEC.md` 9.6.3): the Domain function the press and
 * the availability share, with the displayed Draft and the fresh input's
 * CalculationContext. `null` while no `ready` preparation exists.
 */
export function prepareProductionPlanConflictDecision(
  plan: ProductionPlan,
  input: PlannerInput,
  preparation: PlannerInteractionPreparationResult,
  decision: PlannerConflictResolution,
): PlannerConflictDecisionSetResult | null {
  if (preparation.status !== 'ready') return null
  return derivePlannerConflictDecisionSet({
    displayedPlan: plan,
    currentCalculationContext: input.calculationContext,
    preparation,
    decision,
  })
}

function conflictCurrency(
  conflictId: string,
  preparation: PlannerInteractionPreparationResult,
  inputComparison: ProductionPlanInputComparison,
): ProductionPlanConflictCurrency {
  if (preparation.status !== 'ready') return 'not_compared'
  if (preparation.currentConflicts.some(({ id }) => id === conflictId)) return 'current'
  // A Conflict ID that is merely absent proves nothing on its own: only the
  // same calculation input makes it the run's own dynamic Conflict (9.6.7).
  switch (inputComparison) {
    case 'same_input':
      return 'dynamic'
    case 'input_changed':
      return 'input_changed'
    case 'not_compared':
      return 'not_compared'
  }
}

/** Builds presentation state without adding a new Domain validity rule. */
export function createProductionPlanInteractionViewModel(
  plan: ProductionPlan,
  input: PlannerInput,
  preparation: PlannerInteractionPreparationResult,
): ProductionPlanInteractionViewModel {
  const entriesById = new Map(
    input.buildListEntries.map((entry) => [entry.id, entry]),
  )
  const targetsById = new Map(
    input.targetWeapons.map((target) => [target.id, target]),
  )
  const carried = carriedDecisions(plan, input, preparation)
  const carriedExcluded = carried?.status === 'ready' ? carried.excludedBuildListEntryIds : []
  // Which effective earlier decision leaves each Entry out: the Domain's own
  // attribution of the same carried set, never the persisted selections.
  const carriedExclusions =
    carried?.status === 'ready' && preparation.status === 'ready'
      ? plannerConflictDecisionExclusions(preparation.currentConflicts, carried.resolutions)
      : new Map<BuildListEntryId, PlannerConflictResolution[]>()
  const notCarriedByConflictId = new Map(
    (carried?.notCarriedOver ?? []).map(({ resolution, reason }) => [resolution.conflictKey, reason]),
  )
  const inputComparison = compareProductionPlanInputWithCurrentState(plan, input)

  return {
    planStatus: plan.status,
    isDraft: plan.status === 'draft',
    inputComparison,
    conflicts: plan.conflicts.map((conflict) => {
      // The current preparation is the authority for checkpoint involvement:
      // the persisted Plan's own metadata may predate a Build List change. A
      // checkpoint participant an earlier decision excludes is not effective.
      const currentConflict =
        preparation.status === 'ready'
          ? preparation.currentConflicts.find(({ id }) => id === conflict.id)
          : undefined
      const currentCheckpointParticipants = currentConflict
        ? plannerConflictEffectiveCheckpointParticipants(currentConflict, carriedExcluded)
        : []
      return {
        id: conflict.id,
        currency: conflictCurrency(conflict.id, preparation, inputComparison),
        involvesSelectedCheckpoint: currentCheckpointParticipants.length > 0,
        decisionNotCarriedReason:
          conflict.selectedBuildListEntryId === null
            ? null
            : notCarriedByConflictId.get(conflict.id) ?? null,
        participants: conflict.buildListEntryIds.map((buildListEntryId) => {
          const entry = entriesById.get(buildListEntryId)
          const target = entry
            ? targetsById.get(entry.targetWeaponId) ?? null
            : null
          return {
            buildListEntryId,
            entry: entry ?? null,
            target,
            targetName: target?.name ?? null,
            checkpointOpportunityId:
              currentCheckpointParticipants.find(
                (participant) => participant.buildListEntryId === buildListEntryId,
              )?.opportunityId ?? null,
            isRecommended:
              conflict.recommendedBuildListEntryId === buildListEntryId,
            isSelected: conflict.selectedBuildListEntryId === buildListEntryId,
            ...participantAvailability(
              plan,
              input,
              conflict,
              entry,
              target,
              preparation,
              carriedExcluded,
              carriedExclusions,
            ),
          }
        }),
      }
    }),
  }
}
