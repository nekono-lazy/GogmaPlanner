import type {
  BuildListEntry,
  CalculationContext,
  DomainValidationResult,
  ExecutionHistory,
  ExecutionHistoryId,
  ExecutionSavePoint,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  ProductionPlan,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import {
  collectReferencedOwnedWeaponIds,
  compareExecutionHistoryOrder,
  executionSavePointIdForPlan,
  validateExecutionSavePoint,
  validateExecutionSavePointReferences,
  validateNormalArtianCounter,
  validateOwnedWeapon,
  validateProductionPlan,
  validateRngState,
  validateTargetWeapon,
} from '../models/publicTypes'
import { collectProductionPlanDependentTargetWeaponIds } from '../planner/productionPlanGeneration'
import { validateTargetPreferredOwnedWeapons } from '../target/preferredOwnedWeapon'
import { executionFailure } from './executionRuntimeError'
import { assertExecutableProductionPlan, type ExecutionPersistedState } from './planExecutionState'
import { requireExecutableCurrentStep } from './stepExecution'

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique<T extends string>(ids: Iterable<T>): T[] {
  return [...new Set(ids)].sort(compareIds)
}

/** The Plan's ExecutionHistory in the one chronological order authority. */
function orderedPlanHistory(plan: Pick<ProductionPlan, 'id'>, history: readonly ExecutionHistory[]): ExecutionHistory[] {
  return history.filter(({ planId }) => planId === plan.id).sort(compareExecutionHistoryOrder)
}

/**
 * The OwnedWeapons the Plan's selected BuildListEntry Routes reference
 * (`docs/PLANNER_SPEC.md` 16.9), by the same Route reference authority
 * `referencedOwnedWeaponsHash` uses. A selected Entry that no longer exists
 * contributes nothing here; its absence is checked separately.
 */
function collectPlanRouteOwnedWeaponIds(
  plan: Pick<ProductionPlan, 'selectedBuildListEntryIds'>,
  buildListEntries: readonly BuildListEntry[],
): OwnedWeaponId[] {
  const entryById = new Map(buildListEntries.map((entry) => [entry.id, entry]))
  return sortedUnique(plan.selectedBuildListEntryIds.flatMap((id) => {
    const entry = entryById.get(id)
    return entry ? collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route) : []
  }))
}

/**
 * The execution scope OwnedWeapon IDs of a Plan (`docs/PLANNER_SPEC.md` 16.9,
 * `docs/DATA_MODEL.md` 12.1), stably sorted: the union of
 * - the OwnedWeapons the Plan-dependent Entry Routes reference
 * - the existing OwnedWeapons this Plan's ExecutionHistory registered
 * - the OwnedWeapons in progress for this Plan
 *
 * An undone record is no longer persisted, so a weapon it registered is not in
 * scope. Every other OwnedWeapon stays out of the save point.
 */
export function collectExecutionScopeOwnedWeaponIds(
  plan: Pick<ProductionPlan, 'id' | 'selectedBuildListEntryIds'>,
  state: Pick<ExecutionPersistedState, 'ownedWeapons' | 'buildListEntries' | 'planExecutionHistory'>,
): OwnedWeaponId[] {
  const existing = new Set<string>(state.ownedWeapons.map(({ id }) => id))
  return sortedUnique([
    ...collectPlanRouteOwnedWeaponIds(plan, state.buildListEntries),
    ...orderedPlanHistory(plan, [...state.planExecutionHistory])
      .flatMap(({ undoSnapshot }) => undoSnapshot.addedOwnedWeaponIds)
      .filter((id) => existing.has(id)),
    ...state.ownedWeapons
      .filter(({ executionInProgress }) => executionInProgress?.productionPlanId === plan.id)
      .map(({ id }) => id),
  ])
}

/**
 * The execution scope TargetWeapon IDs of a Plan (16.9), stably sorted: the
 * Plan-dependent Targets plus every Target whose `preferredOwnedWeaponId` is an
 * execution scope OwnedWeapon, whether it depends on the Plan or not.
 */
export function collectExecutionScopeTargetWeaponIds(
  plan: Pick<ProductionPlan, 'selectedBuildListEntryIds' | 'steps'>,
  state: Pick<ExecutionPersistedState, 'targetWeapons' | 'buildListEntries'>,
  scopeOwnedWeaponIds: readonly OwnedWeaponId[],
): TargetWeaponId[] {
  const scopeWeapons = new Set<string>(scopeOwnedWeaponIds)
  return sortedUnique([
    ...collectProductionPlanDependentTargetWeaponIds(plan, state.buildListEntries),
    ...state.targetWeapons
      .filter(({ preferredOwnedWeaponId }) => preferredOwnedWeaponId !== null && scopeWeapons.has(preferredOwnedWeaponId))
      .map(({ id }) => id),
  ])
}

/**
 * The execution state at the moment a save point was recorded, as far as the
 * formal execution scope needs it: the OwnedWeapons and TargetWeapons that
 * existed then, and the Plan's ExecutionHistory up to the save point boundary.
 */
interface ExecutionScopeState {
  ownedWeapons: readonly OwnedWeapon[]
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly BuildListEntry[]
  planExecutionHistory: readonly ExecutionHistory[]
}

/**
 * The formal execution scope (`docs/PLANNER_SPEC.md` 16.9) the save point must
 * hold, checked against the save point's own snapshots. Recording and restoring
 * share this one authority; only where the state at the save point comes from
 * differs. Returns the IDs the save point lacks; nothing is ever filled in.
 *
 * OwnedWeapons: the Route references of the Plan-dependent Entries, every weapon
 * this Plan's ExecutionHistory up to the boundary registered (Execution never
 * deletes one, so each existed at the save point), every weapon in progress for
 * the Plan, and the tracked weapon of every Step the snapshot Plan completed
 * (already registered or operated on; never an unexecuted Step's weapon).
 * TargetWeapons: the Plan-dependent Targets and every Target preferring one of
 * those OwnedWeapons.
 */
function missingExecutionScope(
  savePoint: Pick<ExecutionSavePoint, 'productionPlan' | 'ownedWeapons' | 'targetWeapons'>,
  scopeState: ExecutionScopeState,
): { ownedWeaponIds: OwnedWeaponId[]; targetWeaponIds: TargetWeaponId[] } {
  const plan = savePoint.productionPlan
  const snapshotWeapons = new Set<string>(savePoint.ownedWeapons.map(({ id }) => id))
  const snapshotTargets = new Set<string>(savePoint.targetWeapons.map(({ id }) => id))
  const requiredOwnedWeaponIds = sortedUnique([
    ...collectExecutionScopeOwnedWeaponIds(plan, scopeState),
    ...orderedPlanHistory(plan, [...scopeState.planExecutionHistory])
      .flatMap(({ undoSnapshot }) => undoSnapshot.addedOwnedWeaponIds),
    ...plan.steps.flatMap((step) => {
      const tracked = step.executionEffects?.trackedOwnedWeaponId ?? null
      return step.isCompleted && tracked !== null ? [tracked] : []
    }),
  ])
  return {
    ownedWeaponIds: requiredOwnedWeaponIds.filter((id) => !snapshotWeapons.has(id)),
    targetWeaponIds: collectExecutionScopeTargetWeaponIds(plan, scopeState, requiredOwnedWeaponIds)
      .filter((id) => !snapshotTargets.has(id)),
  }
}

/**
 * The OwnedWeapons and TargetWeapons as they were when the save point was
 * recorded, used only to check the save point's completeness and never to
 * restore anything (16.9). Inside the snapshot the snapshot body is the
 * authority. Outside it, an entity is the before body of the earliest later
 * ExecutionHistory that changed it, or else its current body, and only if that
 * body was last updated no later than `recordedAt`: an entity the user added or
 * edited after the save point is never taken as having been in its scope.
 * OwnedWeapons a later record registered did not exist at the save point.
 */
function reconstructScopeStateAtSavePoint(
  savePoint: ExecutionSavePoint,
  state: Pick<ExecutionPersistedState, 'ownedWeapons' | 'targetWeapons' | 'buildListEntries'>,
  kept: readonly ExecutionHistory[],
  after: readonly ExecutionHistory[],
): ExecutionScopeState {
  const addedAfter = new Set<string>(after.flatMap(({ undoSnapshot }) => undoSnapshot.addedOwnedWeaponIds))
  function outsideSnapshot<T extends { id: string; updatedAt: ISODateTimeString }>(
    snapshot: readonly T[],
    current: readonly T[],
    befores: (history: ExecutionHistory) => readonly T[],
  ): T[] {
    const inSnapshot = new Set<string>(snapshot.map(({ id }) => id))
    const bodies = new Map<string, T>()
    after.forEach((history) => befores(history).forEach((body) => {
      if (!bodies.has(body.id)) bodies.set(body.id, body)
    }))
    current.forEach((body) => {
      if (!bodies.has(body.id)) bodies.set(body.id, body)
    })
    return [...bodies.values()].filter(({ id, updatedAt }) =>
      !inSnapshot.has(id) && !addedAfter.has(id) && updatedAt <= savePoint.recordedAt)
  }
  return {
    ownedWeapons: [
      ...savePoint.ownedWeapons,
      ...outsideSnapshot(savePoint.ownedWeapons, state.ownedWeapons, ({ undoSnapshot }) => [
        ...undoSnapshot.affectedOwnedWeaponsBefore,
        ...undoSnapshot.removedOwnedWeaponsBefore,
      ]),
    ],
    targetWeapons: [
      ...savePoint.targetWeapons,
      ...outsideSnapshot(savePoint.targetWeapons, state.targetWeapons, ({ undoSnapshot }) => undoSnapshot.affectedTargetWeaponsBefore),
    ],
    buildListEntries: state.buildListEntries,
    planExecutionHistory: kept,
  }
}

export interface ExecutionSavePointRecordInput {
  /** The current persisted Plan. */
  plan: ProductionPlan
  state: ExecutionPersistedState
  currentCalculationContext: CalculationContext
  now: ISODateTimeString
}

/**
 * Decides one "ゲーム内セーブ済みとして記録" (`docs/PLANNER_SPEC.md` 16.9,
 * `docs/DATA_MODEL.md` 12.1): the snapshot of the current persisted Execution
 * state the user confirmed the game saved.
 *
 * Only an `active` executable Plan whose Plan-dependent premises are unchanged
 * and whose persisted state equals its current Step's `expectedStateBefore` is
 * recorded, so a diverged state is never snapshotted. The snapshot holds the
 * whole RngState, every NormalArtianCounter, the execution scope OwnedWeapons
 * and TargetWeapons, the whole Plan and the Plan's latest ExecutionHistory ID,
 * each as an exact copy; only `recordedAt` is new. Its ID is the Plan-derived
 * one, so writing it replaces the Plan's previous save point. Nothing else is
 * changed and no ExecutionHistory is added.
 */
export function prepareExecutionSavePointRecord(input: ExecutionSavePointRecordInput): ExecutionSavePoint {
  const { plan, state } = input
  if (plan.status !== 'active') {
    executionFailure(
      'save_point_record_not_allowed',
      `ProductionPlan '${plan.id}' is '${plan.status}'; a game save point is recorded only for an active Plan.`,
    )
  }
  requireExecutableCurrentStep({
    plan,
    planStepId: plan.currentStepId as NonNullable<ProductionPlan['currentStepId']>,
    state,
    currentCalculationContext: input.currentCalculationContext,
  })

  const ownedWeaponIds = collectExecutionScopeOwnedWeaponIds(plan, state)
  const weaponById = new Map(state.ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const missingWeapon = ownedWeaponIds.find((id) => !weaponById.has(id))
  if (missingWeapon !== undefined) {
    executionFailure(
      'save_point_required_entity_missing',
      `OwnedWeapon '${missingWeapon}', which a Plan-dependent Route references, no longer exists.`,
    )
  }
  const targetWeaponIds = collectExecutionScopeTargetWeaponIds(plan, state, ownedWeaponIds)
  const targetById = new Map(state.targetWeapons.map((target) => [target.id, target]))
  const missingTarget = targetWeaponIds.find((id) => !targetById.has(id))
  if (missingTarget !== undefined) {
    executionFailure(
      'save_point_required_entity_missing',
      `Plan-dependent TargetWeapon '${missingTarget}' no longer exists.`,
    )
  }

  const history = orderedPlanHistory(plan, [...state.planExecutionHistory])
  const savePoint: ExecutionSavePoint = {
    id: executionSavePointIdForPlan(plan.id),
    productionPlanId: plan.id,
    lastExecutionHistoryId: history.at(-1)?.id ?? null,
    rngState: structuredClone(state.rngState),
    normalCounters: structuredClone([...state.normalCounters]),
    ownedWeapons: ownedWeaponIds.map((id) => structuredClone(weaponById.get(id) as OwnedWeapon)),
    targetWeapons: targetWeaponIds.map((id) => structuredClone(targetById.get(id) as TargetWeapon)),
    productionPlan: structuredClone(plan),
    recordedAt: input.now,
  }

  const structure = validateExecutionSavePoint(savePoint)
  if (!structure.isValid) {
    executionFailure('entity_validation_failed', `The game save point of ProductionPlan '${plan.id}' fails Domain validation.`, structure.issues)
  }
  const references = validateExecutionSavePointReferences([savePoint], [plan], history)
  if (!references.isValid) {
    executionFailure('entity_validation_failed', `The game save point of ProductionPlan '${plan.id}' has an invalid reference.`, references.issues)
  }
  // Completeness of the snapshot itself, by the same formal scope authority the
  // restore re-checks it with.
  const missing = missingExecutionScope(savePoint, { ...state, planExecutionHistory: history })
  const uncovered = [...missing.ownedWeaponIds, ...missing.targetWeaponIds]
  if (uncovered.length > 0) {
    executionFailure('save_point_snapshot_invalid', `The game save point does not cover execution scope entities: ${uncovered.join(', ')}.`)
  }
  return savePoint
}

export interface ExecutionSavePointRestoreInput {
  /** The current persisted Plan. */
  plan: ProductionPlan
  /**
   * The `recordedAt` of the save point the user saw. The Plan's current save
   * point must still be exactly that one; a save point recorded later (for
   * example from another tab) is never restored in its place.
   */
  recordedAt: ISODateTimeString
  state: Pick<
    ExecutionPersistedState,
    'ownedWeapons' | 'targetWeapons' | 'buildListEntries' | 'planExecutionHistory' | 'executionSavePoint'
  >
  currentCalculationContext: CalculationContext
}

/**
 * Everything one save point restore writes, decided and validated before a
 * single write happens (`docs/DATA_MODEL.md` 14.4). Every value is an exact
 * persisted body; nothing is predicted, derived from Counter differences or
 * re-timestamped. The save point itself is kept unchanged.
 */
export interface ExecutionSavePointRestoreWrite {
  rngState: RngState
  /** The whole NormalArtianCounter collection after the restore; it replaces the current collection. */
  normalCounters: NormalArtianCounter[]
  /** The OwnedWeapons this Plan's Execution registered after the save point. */
  deletedOwnedWeaponIds: OwnedWeaponId[]
  /** The save point's execution scope OwnedWeapons. */
  restoredOwnedWeapons: OwnedWeapon[]
  /**
   * The save point's TargetWeapons that still exist, plus every existing Target
   * outside the save point scope that Execution changed after it, as it was
   * before the earliest such change.
   */
  restoredTargetWeapons: TargetWeapon[]
  plan: ProductionPlan
  /** The Plan's ExecutionHistory recorded after the save point, oldest first. */
  deletedExecutionHistoryIds: ExecutionHistoryId[]
  savePoint: ExecutionSavePoint
}

function snapshotInvalid(message: string, validation?: DomainValidationResult): never {
  executionFailure('save_point_snapshot_invalid', message, validation?.issues ?? [])
}

function assertRestoredValid(label: string, validation: DomainValidationResult): void {
  if (!validation.isValid) {
    executionFailure('save_point_restore_invalid', `${label} fails validation after the save point restore.`, validation.issues)
  }
}

/**
 * The Plan's ExecutionHistory recorded after the save point: every record
 * ordered after the boundary `lastExecutionHistoryId`, or every record when the
 * save point was recorded before any. A boundary that no longer exists or
 * belongs to another Plan is refused, never read as `null`. The restore and the
 * save point choice of a Plan-ending action (16.10) share this one authority.
 */
export function splitExecutionHistoryAtSavePoint(
  plan: Pick<ProductionPlan, 'id'>,
  savePoint: ExecutionSavePoint,
  planExecutionHistory: readonly ExecutionHistory[],
): { kept: ExecutionHistory[]; after: ExecutionHistory[] } {
  const ordered = orderedPlanHistory(plan, [...planExecutionHistory])
  const references = validateExecutionSavePointReferences([savePoint], [plan], ordered)
  if (!references.isValid) {
    snapshotInvalid(`The game save point of ProductionPlan '${plan.id}' has an invalid ExecutionHistory boundary.`, references)
  }
  const boundaryId = savePoint.lastExecutionHistoryId
  if (boundaryId === null) return { kept: [], after: ordered }
  const boundary = ordered.find(({ id }) => id === boundaryId) as ExecutionHistory
  return {
    kept: ordered.filter((history) => compareExecutionHistoryOrder(history, boundary) <= 0),
    after: ordered.filter((history) => compareExecutionHistoryOrder(history, boundary) > 0),
  }
}

/**
 * Decides one "最後のゲーム内セーブ地点へ戻す" (`docs/PLANNER_SPEC.md` 16.9,
 * `docs/DATA_MODEL.md` 12.1) purely from the persisted state and the save point.
 *
 * Refused for anything but an `active` / `stale` executable Plan whose current
 * save point is the one the user saw, is structurally valid, has an existing
 * boundary of its own Plan, snapshots an `active` Plan and covers the required
 * scope. Before any write it also refuses when an entity the restored Plan
 * needs no longer exists: a snapshot OwnedWeapon, a selected BuildListEntry or a
 * Plan-dependent Target. Nothing deleted is ever revived.
 *
 * It restores only the Execution state the game save corresponds to: the
 * RngState, the whole Normal Counter collection, the scope OwnedWeapons, the
 * still existing scope TargetWeapons and the Plan to their snapshot bodies;
 * deletes the OwnedWeapons this Plan's Execution registered after the save
 * point; returns every existing Target outside the snapshot that a later record
 * changed to the before body of the earliest such record; and deletes the later
 * records. Plan-independent additions, Build List Entries, OwnedWeapons outside
 * the scope, other Plans and settings are left as they are. The save point is
 * kept, and no ExecutionHistory is added.
 */
export function prepareExecutionSavePointRestore(input: ExecutionSavePointRestoreInput): ExecutionSavePointRestoreWrite {
  const { plan, state } = input
  if (plan.status !== 'active' && plan.status !== 'stale') {
    executionFailure(
      'save_point_restore_not_allowed',
      `ProductionPlan '${plan.id}' is '${plan.status}'; a game save point is restored only for an active or stale Plan.`,
    )
  }
  assertExecutableProductionPlan(plan, input.currentCalculationContext)

  const savePoint = state.executionSavePoint
  if (savePoint === null) {
    executionFailure('save_point_not_found', `ProductionPlan '${plan.id}' has no game save point.`)
  }
  if (savePoint.recordedAt !== input.recordedAt) {
    executionFailure(
      'save_point_changed',
      `The game save point of ProductionPlan '${plan.id}' was recorded at '${savePoint.recordedAt}', not at the requested '${input.recordedAt}'.`,
    )
  }
  const structure = validateExecutionSavePoint(savePoint)
  if (!structure.isValid) {
    snapshotInvalid(`The game save point of ProductionPlan '${plan.id}' fails Domain validation.`, structure)
  }
  if (savePoint.productionPlanId !== plan.id || savePoint.id !== executionSavePointIdForPlan(plan.id)) {
    snapshotInvalid(`The game save point '${savePoint.id}' is not the save point of ProductionPlan '${plan.id}'.`)
  }
  const snapshotPlan = savePoint.productionPlan
  if (snapshotPlan.status !== 'active') {
    snapshotInvalid(`The snapshot Plan of the game save point is '${snapshotPlan.status}', not active.`)
  }
  assertExecutableProductionPlan(snapshotPlan, input.currentCalculationContext)
  const { kept, after } = splitExecutionHistoryAtSavePoint(plan, savePoint, state.planExecutionHistory)

  // Fail closed before any write when the restored Plan needs a deleted entity.
  const weapons = new Map(state.ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const targets = new Map(state.targetWeapons.map((target) => [target.id, target]))
  const entryIds = new Set<string>(state.buildListEntries.map(({ id }) => id))
  const dependentTargetIds = collectProductionPlanDependentTargetWeaponIds(snapshotPlan, state.buildListEntries)
  const missing = [
    ...savePoint.ownedWeapons.filter(({ id }) => !weapons.has(id)).map(({ id }) => `OwnedWeapon '${id}'`),
    ...snapshotPlan.selectedBuildListEntryIds.filter((id) => !entryIds.has(id)).map((id) => `BuildListEntry '${id}'`),
    ...dependentTargetIds.filter((id) => !targets.has(id)).map((id) => `TargetWeapon '${id}'`),
  ]
  if (missing.length > 0) {
    executionFailure(
      'save_point_required_entity_missing',
      `The restored ProductionPlan '${plan.id}' needs entities that no longer exist: ${missing.join(', ')}.`,
    )
  }
  // Snapshot completeness, separate from current existence above: the save point
  // must hold its whole formal execution scope as it was when recorded, and a
  // lacking snapshot is never completed from the current state.
  const uncovered = missingExecutionScope(
    savePoint,
    reconstructScopeStateAtSavePoint(savePoint, state, kept, after),
  )
  if (uncovered.ownedWeaponIds.length > 0 || uncovered.targetWeaponIds.length > 0) {
    snapshotInvalid(
      `The game save point does not cover its execution scope: ${[...uncovered.ownedWeaponIds, ...uncovered.targetWeaponIds].join(', ')}.`,
    )
  }

  const snapshotWeaponIds = new Set<string>(savePoint.ownedWeapons.map(({ id }) => id))
  const addedAfter = sortedUnique(after.flatMap(({ undoSnapshot }) => undoSnapshot.addedOwnedWeaponIds))
  const contradiction = addedAfter.find((id) => snapshotWeaponIds.has(id))
  if (contradiction !== undefined) {
    snapshotInvalid(`OwnedWeapon '${contradiction}' is in the save point yet was registered after it.`)
  }

  const rngState = structuredClone(savePoint.rngState)
  const normalCounters = structuredClone(savePoint.normalCounters)
  const deletedOwnedWeaponIds = addedAfter.filter((id) => weapons.has(id))
  const restoredOwnedWeapons = structuredClone(savePoint.ownedWeapons)
  const snapshotTargetIds = new Set<string>(savePoint.targetWeapons.map(({ id }) => id))
  const restoredTargetWeapons = structuredClone(savePoint.targetWeapons.filter(({ id }) => targets.has(id)))
  // Outside the snapshot, the earliest later record's before body is the Target
  // as it was at the save point.
  const earliestBefore = new Map<string, TargetWeapon>()
  after.forEach(({ undoSnapshot }) => undoSnapshot.affectedTargetWeaponsBefore.forEach((target) => {
    if (!snapshotTargetIds.has(target.id) && !earliestBefore.has(target.id)) {
      earliestBefore.set(target.id, target)
    }
  }))
  earliestBefore.forEach((target) => {
    if (targets.has(target.id)) restoredTargetWeapons.push(structuredClone(target))
  })
  const restoredPlan = structuredClone(snapshotPlan)

  // The resulting collections, as they will be persisted.
  deletedOwnedWeaponIds.forEach((id) => weapons.delete(id))
  restoredOwnedWeapons.forEach((weapon) => weapons.set(weapon.id, weapon))
  restoredTargetWeapons.forEach((target) => targets.set(target.id, target))

  assertRestoredValid('RngState', validateRngState(rngState))
  normalCounters.forEach((counter) =>
    assertRestoredValid(`NormalArtianCounter '${counter.id}'`, validateNormalArtianCounter(counter)))
  restoredOwnedWeapons.forEach((weapon) =>
    assertRestoredValid(`OwnedWeapon '${weapon.id}'`, validateOwnedWeapon(weapon)))
  restoredTargetWeapons.forEach((target) =>
    assertRestoredValid(`TargetWeapon '${target.id}'`, validateTargetWeapon(target)))
  assertRestoredValid(`ProductionPlan '${restoredPlan.id}'`, validateProductionPlan(restoredPlan))
  assertRestoredValid(
    'The Target preferred owned weapon collection',
    validateTargetPreferredOwnedWeapons([...targets.values()], [...weapons.values()]),
  )
  assertRestoredValid('ExecutionSavePoint', validateExecutionSavePoint(savePoint))
  assertRestoredValid(
    'ExecutionSavePoint references',
    validateExecutionSavePointReferences([savePoint], [restoredPlan], kept),
  )

  return {
    rngState,
    normalCounters,
    deletedOwnedWeaponIds,
    restoredOwnedWeapons,
    restoredTargetWeapons,
    plan: restoredPlan,
    deletedExecutionHistoryIds: after.map(({ id }) => id),
    savePoint,
  }
}
