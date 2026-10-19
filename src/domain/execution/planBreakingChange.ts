import { createInitialRngState } from '../models/factories'
import type {
  BuildCandidate,
  BuildListEntry,
  CalculationContext,
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionSavePoint,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
  RecalculationReason,
  RngState,
  TargetWeapon,
} from '../models/publicTypes'
import {
  compareExecutionHistoryOrder,
  createExpectedPlanState,
  createTargetExecutionStateHash,
  executionSavePointIdForPlan,
} from '../models/publicTypes'
import {
  collectProductionPlanDependentTargetWeaponIds,
  createDependentBuildListEntriesHash,
  createDependentTargetDefinitionsHash,
} from '../planner/productionPlanGeneration'
import {
  collectExecutionScopeOwnedWeaponIds,
  prepareExecutionSavePointRestore,
} from './executionSavePoint'
import { ExecutionRuntimeError, executionFailure } from './executionRuntimeError'
import {
  abandonedProductionPlan,
  assertAbandonedStateValid,
  assertRunningPlanSavePointDecision,
  deriveRunningPlanSavePointChoiceRequirement,
  withoutPlanInProgress,
  type PlanAbandonSavePointDecision,
} from './planAbandonment'

/**
 * Why a change breaks the `active` Plan (`docs/PLANNER_SPEC.md` 16.6). These
 * are the existing recalculation reasons reused as transient warning reasons:
 * an approved breaking change never makes the Plan `stale` and never stores
 * them, it ends the Plan with `breaking_change_approved`.
 */
export type PlanBreakingReason = Extract<
  RecalculationReason,
  'rng_state_changed' | 'normal_counter_changed' | 'owned_weapon_changed' | 'target_changed' | 'build_list_changed'
>

/** The fixed order in which breaking reasons are reported. */
const PLAN_BREAKING_REASON_ORDER: readonly PlanBreakingReason[] = [
  'rng_state_changed',
  'normal_counter_changed',
  'owned_weapon_changed',
  'target_changed',
  'build_list_changed',
]

/**
 * The persisted collections an ordinary user save can change, and whose change
 * can break the `active` Plan. A save is judged on the whole post-state of
 * these, never on its primary entity alone: a Target edit that takes a weapon
 * over from a Plan-dependent Target changes that other Target too.
 */
export interface PlanBreakingMutableState {
  /** `null` only when no RngState has ever been stored. */
  rngState: RngState | null
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly BuildListEntry[]
}

export type PlanBreakingMutationResult =
  | { breaksPlan: false }
  | { breaksPlan: true; reasons: PlanBreakingReason[] }

export interface PlanBreakingMutationInput {
  /** The `active` Plan the change is judged against. */
  plan: ProductionPlan
  /** The Plan's ExecutionHistory, which decides the execution scope OwnedWeapons. */
  planExecutionHistory: readonly ExecutionHistory[]
  /** The current persisted state. */
  before: PlanBreakingMutableState
  /** The proposed post-state of the whole save, side effects included. */
  after: PlanBreakingMutableState
}

// `createExpectedPlanState()` always takes an RngState. Only its
// `rngStateHash` depends on it, so this placeholder is used for the other
// hashes when no RngState is stored; it never reaches the RNG comparison.
const PLACEHOLDER_RNG_STATE = createInitialRngState('1970-01-01T00:00:00.000Z')

/**
 * Whether a proposed save breaks the `active` Plan (`docs/PLANNER_SPEC.md`
 * 16.6, `docs/UI_FLOW.md` 16.3), by exactly the authorities the Plan's own
 * premises are verified with - no second normalization:
 *
 * - `rng_state_changed` / `normal_counter_changed`: `createExpectedPlanState()`'s
 *   `rngStateHash` / `normalCountersHash`. Notes, observation metadata and
 *   timestamps are outside them and never break the Plan.
 * - `owned_weapon_changed`: the expected-state `ownedWeaponsHash` of the
 *   execution scope OwnedWeapons (`collectExecutionScopeOwnedWeaponIds()`), so
 *   status, name, memo, `executionInProgress` and timestamps never break it,
 *   and a weapon outside the scope never does.
 * - `target_changed`: the Plan-dependent Targets
 *   (`collectProductionPlanDependentTargetWeaponIds()`) through
 *   `createDependentTargetDefinitionsHash()` (performance definition, priority,
 *   `isEnabled`) and `createTargetExecutionStateHash()` (lifecycle, preferred
 *   owned weapon). Name and memo never break it; a Plan-independent Target
 *   never does.
 * - `build_list_changed`: `createDependentBuildListEntriesHash()` of the
 *   selected Entries, which excludes the derived staleness flags and
 *   timestamps. A Plan-independent or new Entry never breaks it.
 *
 * Scopes are taken from both the current and the proposed state, so a removed
 * dependency is still judged.
 */
export function detectPlanBreakingMutation(input: PlanBreakingMutationInput): PlanBreakingMutationResult {
  const { plan, before, after } = input
  const reasons = new Set<PlanBreakingReason>()

  const rngHash = (state: PlanBreakingMutableState) =>
    state.rngState === null ? null : createExpectedPlanState(state.rngState, [], [], { targetWeapons: [], dependentTargetWeaponIds: [] }).rngStateHash
  if (rngHash(before) !== rngHash(after)) reasons.add('rng_state_changed')

  const countersHash = (state: PlanBreakingMutableState) =>
    createExpectedPlanState(PLACEHOLDER_RNG_STATE, state.normalCounters, [], { targetWeapons: [], dependentTargetWeaponIds: [] }).normalCountersHash
  if (countersHash(before) !== countersHash(after)) reasons.add('normal_counter_changed')

  const scopeWeaponIds = new Set<string>([
    ...collectExecutionScopeOwnedWeaponIds(plan, { ...before, planExecutionHistory: input.planExecutionHistory }),
    ...collectExecutionScopeOwnedWeaponIds(plan, { ...after, planExecutionHistory: input.planExecutionHistory }),
  ])
  const scopeWeaponsHash = (state: PlanBreakingMutableState) =>
    createExpectedPlanState(
      PLACEHOLDER_RNG_STATE,
      [],
      state.ownedWeapons.filter(({ id }) => scopeWeaponIds.has(id)),
      { targetWeapons: [], dependentTargetWeaponIds: [] },
    ).ownedWeaponsHash
  if (scopeWeaponsHash(before) !== scopeWeaponsHash(after)) reasons.add('owned_weapon_changed')

  const dependentTargetIds = [...new Set([
    ...collectProductionPlanDependentTargetWeaponIds(plan, before.buildListEntries),
    ...collectProductionPlanDependentTargetWeaponIds(plan, after.buildListEntries),
  ])]
  const targetsHash = (state: PlanBreakingMutableState) => [
    createDependentTargetDefinitionsHash(state.targetWeapons, dependentTargetIds),
    createTargetExecutionStateHash({ targetWeapons: state.targetWeapons, dependentTargetWeaponIds: dependentTargetIds }),
  ].join('|')
  if (targetsHash(before) !== targetsHash(after)) reasons.add('target_changed')

  if (
    createDependentBuildListEntriesHash(before.buildListEntries, plan.selectedBuildListEntryIds) !==
    createDependentBuildListEntriesHash(after.buildListEntries, plan.selectedBuildListEntryIds)
  ) {
    reasons.add('build_list_changed')
  }

  return reasons.size === 0
    ? { breaksPlan: false }
    : { breaksPlan: true, reasons: PLAN_BREAKING_REASON_ORDER.filter((reason) => reasons.has(reason)) }
}

/**
 * Everything a guarded save reads, as one consistent persisted state. The
 * read-only collections let a mutation apply the existing reference protection
 * (`ReferenceFinder` policy) purely, before any write.
 */
export interface PlanGuardedMutationBase extends PlanBreakingMutableState {
  buildCandidates: readonly BuildCandidate[]
  productionPlans: readonly ProductionPlan[]
  executionHistory: readonly ExecutionHistory[]
}

export interface PlanGuardPersistedState extends PlanGuardedMutationBase {
  executionSavePoints: readonly ExecutionSavePoint[]
}

/**
 * The user's change as a pure function from a persisted state to the
 * post-state of that same save, including its Domain side effects (a released
 * Target preference, for instance) and its own validation. It must express the
 * user's intent against the state it is given - never re-inject a full entity
 * body read before - because after 「最後のゲーム内セーブ地点へ戻す」 it is applied
 * again to the restored state (`docs/PLANNER_SPEC.md` 16.10). A validation or
 * reference failure is thrown and nothing is written.
 */
export type PlanGuardedMutation<R> = (base: PlanGuardedMutationBase) => {
  state: PlanBreakingMutableState
  result: R
}

function sameUserValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The user's edit applied to the stored record: every field of `draft` that
 * differs from `basis` - the body the screen showed when the user edited - is
 * taken from the draft, and every field the user left as it was is taken from
 * `current`. With `current` equal to `basis` this is the draft itself; after a
 * save point restore, or a change another writer made in between, a field the
 * user never touched keeps the stored value instead of being written back from
 * the body read earlier (`docs/PLANNER_SPEC.md` 16.10).
 */
export function applyUserChanges<T extends object>(current: T, basis: T, draft: Partial<T>): T {
  const next = { ...current }
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (!sameUserValue(draft[key], basis[key])) next[key] = draft[key] as T[keyof T]
  }
  return next
}

/** The `active` Plan as the user saw it in the breaking-change warning. */
export interface ObservedBreakingPlan {
  planId: ProductionPlanId
  status: 'active'
  currentStepId: PlanStepId | null
  updatedAt: ISODateTimeString
}

/**
 * What the breaking-change warning (`docs/UI_FLOW.md` 16.3) and, when needed,
 * the 16.2 save point choice are built from. Read-only and advisory: applying
 * the change re-derives everything in its own transaction.
 */
export type PlanBreakingChangeInspection =
  | { approvalRequired: false }
  | ({
      approvalRequired: true
      reasons: PlanBreakingReason[]
      observedPlan: ObservedBreakingPlan
    } & (
      | { savePointChoiceRequired: false }
      | {
          savePointChoiceRequired: true
          savePointRecordedAt: ISODateTimeString
          savePointLastExecutionHistoryId: ExecutionHistoryId | null
          /** The Plan's current Step when the save point was recorded. */
          savePointCurrentStepId: PlanStepId | null
        }
    ))

/**
 * The user's approval of 「生産計画を破棄して保存」: the Plan they saw and their
 * answer to the 16.10 choice (`null` when none was offered). 「キャンセル」 is
 * not an approval; cancelling never calls the save.
 */
export interface PlanBreakingChangeApproval {
  observedPlan: ObservedBreakingPlan
  savePointDecision: PlanAbandonSavePointDecision
}

/** Refusal of a breaking change without approval, carrying the warning's content. */
export class PlanBreakingChangeApprovalRequiredError extends ExecutionRuntimeError {
  readonly inspection: Extract<PlanBreakingChangeInspection, { approvalRequired: true }>

  constructor(inspection: Extract<PlanBreakingChangeInspection, { approvalRequired: true }>) {
    super(
      'plan_breaking_change_approval_required',
      '実行中の生産計画の前提を変更するため、この変更は保存できません。生産計画を破棄して保存するには確認が必要です。',
    )
    this.name = 'PlanBreakingChangeApprovalRequiredError'
    this.inspection = inspection
  }
}

/** How an approved breaking change ended the Plan. */
export interface PlanBreakingChangeTermination {
  /** The Plan, now `abandoned` with `breaking_change_approved`. */
  plan: ProductionPlan
  savePointHandling: 'no_choice' | 'keep_current' | 'restore_save_point'
  /** The Plan's records after the save point, deleted by a restore; empty otherwise. */
  deletedExecutionHistoryIds: ExecutionHistoryId[]
  deletesExecutionSavePoint: boolean
}

/**
 * Everything one guarded save writes, decided and validated before a single
 * write (`docs/DATA_MODEL.md` 14.4). `state` is the whole final state of the
 * mutable collections; the caller writes its difference from the persisted
 * state, so a save that ends no Plan writes exactly what it wrote before.
 */
export interface PlanGuardedMutationWrite<R> {
  result: R
  state: PlanBreakingMutableState
  planTermination: PlanBreakingChangeTermination | null
}

export interface PlanGuardedMutationInput<R> {
  state: PlanGuardPersistedState
  mutation: PlanGuardedMutation<R>
  approval: PlanBreakingChangeApproval | null
  currentCalculationContext: CalculationContext
  now: ISODateTimeString
}

function runningPlanOf(plans: readonly ProductionPlan[]): ProductionPlan | null {
  const running = plans.filter(({ status }) => status === 'active' || status === 'stale')
  if (running.length > 1) {
    executionFailure(
      'running_plan_invariant_violated',
      `${running.length} ProductionPlans are running (${running.map(({ id }) => id).join(', ')}); at most one may be active or stale.`,
    )
  }
  return running[0] ?? null
}

function planHistory(plan: Pick<ProductionPlan, 'id'>, history: readonly ExecutionHistory[]): ExecutionHistory[] {
  return history.filter(({ planId }) => planId === plan.id).sort(compareExecutionHistoryOrder)
}

function planSavePoint(plan: Pick<ProductionPlan, 'id'>, savePoints: readonly ExecutionSavePoint[]): ExecutionSavePoint | null {
  return savePoints.find(({ id }) => id === executionSavePointIdForPlan(plan.id)) ?? null
}

/** The mutable collections of a guarded save, taken over unchanged from its base. */
export function unchangedMutableState(state: PlanGuardedMutationBase): PlanBreakingMutableState {
  return {
    rngState: state.rngState,
    normalCounters: state.normalCounters,
    ownedWeapons: state.ownedWeapons,
    targetWeapons: state.targetWeapons,
    buildListEntries: state.buildListEntries,
  }
}

interface EvaluatedMutation<R> {
  applied: ReturnType<PlanGuardedMutation<R>>
  /** The `active` Plan; `null` when there is none (no Plan, or only a stale one). */
  activePlan: ProductionPlan | null
  breaking: PlanBreakingMutationResult
}

/**
 * Applies the mutation to the current state first - so its own validation and
 * reference protection refuse it before any Plan decision - and judges its
 * post-state against the `active` Plan. A `stale` Plan is never judged: it
 * already cannot continue, so a change is saved without a warning (16.6).
 */
function evaluateMutation<R>(state: PlanGuardPersistedState, mutation: PlanGuardedMutation<R>): EvaluatedMutation<R> {
  const running = runningPlanOf(state.productionPlans)
  const applied = mutation(state)
  const activePlan = running?.status === 'active' ? running : null
  const breaking: PlanBreakingMutationResult = activePlan === null
    ? { breaksPlan: false }
    : detectPlanBreakingMutation({
        plan: activePlan,
        planExecutionHistory: planHistory(activePlan, state.executionHistory),
        before: unchangedMutableState(state),
        after: applied.state,
      })
  return { applied, activePlan, breaking }
}

function approvalRequiredInspection(
  plan: ProductionPlan,
  reasons: PlanBreakingReason[],
  state: PlanGuardPersistedState,
): Extract<PlanBreakingChangeInspection, { approvalRequired: true }> {
  const base = {
    approvalRequired: true as const,
    reasons,
    observedPlan: {
      planId: plan.id,
      status: 'active' as const,
      currentStepId: plan.currentStepId,
      updatedAt: plan.updatedAt,
    },
  }
  const choice = deriveRunningPlanSavePointChoiceRequirement(
    plan,
    planSavePoint(plan, state.executionSavePoints),
    planHistory(plan, state.executionHistory),
  )
  if (!choice.required) return { ...base, savePointChoiceRequired: false }
  return {
    ...base,
    savePointChoiceRequired: true,
    savePointRecordedAt: choice.savePoint.recordedAt,
    savePointLastExecutionHistoryId: choice.savePoint.lastExecutionHistoryId,
    savePointCurrentStepId: choice.savePoint.productionPlan.currentStepId,
  }
}

/**
 * Reads whether saving the change needs the breaking-change approval, and what
 * the warning and the save point choice must show. It writes nothing. A change
 * that fails its own validation is refused here as it would be on save.
 */
export function inspectPlanGuardedMutation<R>(
  state: PlanGuardPersistedState,
  mutation: PlanGuardedMutation<R>,
): PlanBreakingChangeInspection {
  const { activePlan, breaking } = evaluateMutation(state, mutation)
  if (activePlan === null || !breaking.breaksPlan) return { approvalRequired: false }
  return approvalRequiredInspection(activePlan, breaking.reasons, state)
}

/**
 * Decides one guarded user save (`docs/PLANNER_SPEC.md` 16.6 / 16.10,
 * `docs/UI_FLOW.md` 16.2 / 16.3).
 *
 * The change is applied to the current state and validated first. When it
 * does not break an `active` Plan - there is none, the running Plan is
 * `stale`, or only non-semantic or Plan-independent data changes - it is saved
 * as it is and no Plan, save point, ExecutionHistory or in-progress mark is
 * touched. An approval is then refused, so nothing is abandoned on an approval
 * the user gave for a different state.
 *
 * When it breaks the `active` Plan it is refused without an approval
 * (`plan_breaking_change_approval_required`), and with one only while the Plan
 * is still exactly the one the user saw and the save point decision answers
 * the 16.10 choice re-derived here. Then, in the one transaction:
 *
 * - no choice / 「現在地点を維持」: the change is saved over the current state
 * - 「最後のゲーム内セーブ地点へ戻す」: the save point restore
 *   (`prepareExecutionSavePointRestore()`, every fail-closed check included) is
 *   decided first, and the change is applied again to the restored state -
 *   restore, then the change, then the abandonment (16.10)
 *
 * and the (restored) Plan becomes `abandoned` with `breaking_change_approved`,
 * every weapon in progress for it stops being in progress, and its save point
 * is deleted. Target preferences change only through the change itself. No
 * ExecutionHistory is added, so the abandonment is never undoable (16.16).
 */
export function preparePlanGuardedMutation<R>(input: PlanGuardedMutationInput<R>): PlanGuardedMutationWrite<R> {
  const { state, approval, now } = input
  const { applied, activePlan, breaking } = evaluateApprovedMutation(input)
  if (activePlan === null || !breaking.breaksPlan) {
    return { result: applied.result, state: applied.state, planTermination: null }
  }
  if (approval === null) {
    throw new PlanBreakingChangeApprovalRequiredError(approvalRequiredInspection(activePlan, breaking.reasons, state))
  }

  const history = planHistory(activePlan, state.executionHistory)
  const savePoint = planSavePoint(activePlan, state.executionSavePoints)
  const choice = deriveRunningPlanSavePointChoiceRequirement(activePlan, savePoint, history)
  assertRunningPlanSavePointDecision(activePlan, choice, approval.savePointDecision)

  if (approval.savePointDecision?.kind === 'restore_save_point') {
    return applyAfterSavePointRestore(input, activePlan, approval.savePointDecision.recordedAt, history, savePoint)
  }
  return terminate(activePlan, applied, now, {
    savePointHandling: approval.savePointDecision === null ? 'no_choice' : 'keep_current',
    deletedExecutionHistoryIds: [],
    deletesExecutionSavePoint: savePoint !== null,
  })
}

/**
 * Applies the change to the current state and, with an approval, refuses one
 * the user gave for a different state: the Plan moved on, became stale or
 * ended, or the change no longer breaks it.
 */
function evaluateApprovedMutation<R>(input: PlanGuardedMutationInput<R>): EvaluatedMutation<R> {
  const { state, mutation, approval } = input
  const evaluated = evaluateMutation(state, mutation)
  const { activePlan, breaking } = evaluated

  if (approval !== null) {
    if (
      activePlan === null ||
      activePlan.id !== approval.observedPlan.planId ||
      approval.observedPlan.status !== 'active' ||
      activePlan.currentStepId !== approval.observedPlan.currentStepId ||
      activePlan.updatedAt !== approval.observedPlan.updatedAt
    ) {
      executionFailure(
        'plan_breaking_change_state_changed',
        `ProductionPlan '${approval.observedPlan.planId}' is no longer the active Plan the user saw; review the change again.`,
      )
    }
    if (!breaking.breaksPlan) {
      executionFailure(
        'plan_breaking_change_approval_not_required',
        `The change no longer breaks ProductionPlan '${activePlan.id}', so no approval applies; review the change again.`,
      )
    }
  }
  return evaluated
}

function applyAfterSavePointRestore<R>(
  input: PlanGuardedMutationInput<R>,
  plan: ProductionPlan,
  recordedAt: ISODateTimeString,
  history: readonly ExecutionHistory[],
  savePoint: ExecutionSavePoint | null,
): PlanGuardedMutationWrite<R> {
  const { state, mutation, now } = input
  // The restore contract as it is: every refusal happens here, before the
  // change or the abandonment is decided.
  const restore = prepareExecutionSavePointRestore({
    plan,
    recordedAt,
    state: {
      ownedWeapons: state.ownedWeapons,
      targetWeapons: state.targetWeapons,
      buildListEntries: state.buildListEntries,
      planExecutionHistory: history,
      executionSavePoint: savePoint,
    },
    currentCalculationContext: input.currentCalculationContext,
  })

  const deletedWeapons = new Set<string>(restore.deletedOwnedWeaponIds)
  const restoredWeapons = new Map(restore.restoredOwnedWeapons.map((weapon) => [weapon.id, weapon]))
  const restoredTargets = new Map(restore.restoredTargetWeapons.map((target) => [target.id, target]))
  const deletedHistory = new Set<string>(restore.deletedExecutionHistoryIds)
  const restoredBase: PlanGuardedMutationBase = {
    rngState: restore.rngState,
    normalCounters: restore.normalCounters,
    ownedWeapons: [
      ...state.ownedWeapons.filter(({ id }) => !deletedWeapons.has(id) && !restoredWeapons.has(id)),
      ...restore.restoredOwnedWeapons,
    ],
    targetWeapons: state.targetWeapons.map((target) => restoredTargets.get(target.id) ?? target),
    buildListEntries: state.buildListEntries,
    buildCandidates: state.buildCandidates,
    productionPlans: state.productionPlans.map((stored) => (stored.id === plan.id ? restore.plan : stored)),
    executionHistory: state.executionHistory.filter(({ id }) => !deletedHistory.has(id)),
  }
  // The user's change, applied to the restored state: nothing read before the
  // restore is written back over it.
  const applied = mutation(restoredBase)
  return terminate(restore.plan, applied, now, {
    savePointHandling: 'restore_save_point',
    deletedExecutionHistoryIds: restore.deletedExecutionHistoryIds,
    deletesExecutionSavePoint: true,
  })
}

function terminate<R>(
  base: ProductionPlan,
  applied: ReturnType<PlanGuardedMutation<R>>,
  now: ISODateTimeString,
  handling: Omit<PlanBreakingChangeTermination, 'plan'>,
): PlanGuardedMutationWrite<R> {
  const ownedWeapons = withoutPlanInProgress(base.id, [...applied.state.ownedWeapons], now)
  const changedWeapons = ownedWeapons.filter((weapon, index) => weapon !== applied.state.ownedWeapons[index])
  const plan = abandonedProductionPlan(base, now, 'breaking_change_approved')
  assertAbandonedStateValid(plan, changedWeapons, ownedWeapons, applied.state.targetWeapons)
  return {
    result: applied.result,
    state: { ...applied.state, ownedWeapons },
    planTermination: { plan, ...handling },
  }
}
