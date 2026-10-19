import type {
  BuildListEntry,
  BuildListEntryId,
  NormalArtianCounter,
  OwnedWeaponId,
  RouteOperation,
} from '../models/publicTypes'
import {
  isBlindCreateNormalArtianOperation,
  stableStringify,
} from '../models/publicTypes'
import type { RngEngine } from '../rng/rngEngine'
import { entryIntermediateSelection } from './plannerCheckpoints'
import {
  isPlannerLaneUnitFastForwardable,
  routeOperationLane,
  type PlannerEntryLanes,
  type PlannerRouteLane,
} from './plannerRouteLanes'
import type {
  PlannerSearchRejection,
  PlannerSearchRoutePosition,
  PlannerSearchState,
} from './plannerTypes'

export type PlannerCounterStream = 'gogma' | 'skill' | 'normal' | null

export interface PlannerRouteUnit {
  entryId: BuildListEntryId
  operation: RouteOperation
  position: PlannerSearchRoutePosition
  /**
   * The execution lane of this unit (`docs/PLANNER_SPEC.md` 7.0.4) and its
   * 0-based index inside that lane. Planner-internal only, derived from the
   * saved operation type; never persisted.
   */
  lane: PlannerRouteLane
  laneIndex: number
  counterStream: PlannerCounterStream
  counterId: string | null
  counterBefore: number | null
  counterAfter: number | null
  physicalActionKey: string
  shareable: boolean
  exclusiveConsumedOwnedWeaponId: OwnedWeaponId | null
  /**
   * Planner-internal only: another Entry's real operation may pass this unit's
   * shared Counter position without executing it, because the immediately
   * following Route unit rewrites this unit's whole semantic output without
   * reading it (`docs/PLANNER_SPEC.md` 7.0.2).
   *
   * It is never persisted: no `RouteOperation`, `BuildRoute`, `BuildCandidate`,
   * `ProductionPlan`, or DB field carries it, and it is derived here from the
   * saved Route semantics alone.
   */
  canSkipWhenCounterPassed: boolean
}

export interface PlannerRouteUnitPlanResult {
  unitPlans: Map<BuildListEntryId, PlannerRouteUnit[]>
  rejections: PlannerSearchRejection[]
}

function engineAdvance(
  engine: RngEngine,
  operation: RouteOperation,
  current: number,
): number {
  switch (operation.type) {
    case 'create_normal_artian':
      return engine.advanceNormalCounter(current, {
        type: 'create_normal_artian',
        count: 1,
      })
    case 'convert_normal_to_gogma':
      return engine.advanceSkillCounter(current, { type: 'convert_normal_to_gogma' })
    case 'reset_bonuses':
      return engine.advanceGogmaCounter(current, { type: 'reset_bonuses' })
    case 'keep_bonuses':
      return engine.advanceGogmaCounter(current, { type: 'keep_bonuses' })
    case 'reset_skills':
      return engine.advanceSkillCounter(current, { type: 'reset_skills' })
  }
}

function ownedWeaponIdForOperation(
  entry: BuildListEntry,
  operation: RouteOperation,
): OwnedWeaponId | null {
  switch (operation.type) {
    case 'reset_bonuses':
    case 'keep_bonuses':
      return operation.sourceOwnedWeaponId
    case 'reset_skills':
      return operation.sourceOwnedWeaponId
    case 'convert_normal_to_gogma':
      return entry.candidateSnapshot.route.kind ===
        'owned_normal_artian_to_gogma'
        ? entry.candidateSnapshot.route.sourceOwnedWeaponId
        : null
    case 'create_normal_artian':
      return null
  }
}

/**
 * The physical weapon a Planner operation is performed on.
 *
 * A concrete OwnedWeapon is one subject no matter which BuildListEntry drives
 * it. An unregistered route output has no OwnedWeapon ID, so it stays
 * Entry-local: two Entries' transient Gogma weapons are two different physical
 * weapons (PR #4, `docs/PLANNER_SPEC.md` 7.0).
 */
export type PlannerWeaponOperationSubject =
  | { type: 'owned_weapon'; ownedWeaponId: OwnedWeaponId }
  | { type: 'entry_transient_gogma'; buildListEntryId: BuildListEntryId }

function weaponOperationSubject(
  entryId: BuildListEntryId,
  sourceOwnedWeaponId: OwnedWeaponId | null,
): PlannerWeaponOperationSubject {
  return sourceOwnedWeaponId === null
    ? { type: 'entry_transient_gogma', buildListEntryId: entryId }
    : { type: 'owned_weapon', ownedWeaponId: sourceOwnedWeaponId }
}

/**
 * The stable identity of the weapon the player keeps selected while performing
 * this operation, or `null` for an operation whose in-game subject is not a
 * continuously operated restoration target.
 *
 * This is deliberately NOT `physicalActionKey`. That key also carries the
 * operation type and its Counter before / after, so it changes on every single
 * action even while the very same weapon stays selected, and it can therefore
 * never answer "is this the same weapon as the previous operation?"
 * (`docs/PLANNER_SPEC.md` 7.3).
 *
 * Only `reset_bonuses`, `keep_bonuses`, and `reset_skills` are covered: each
 * selects one existing Gogma weapon and operates on it in place.
 * `create_normal_artian` and `convert_normal_to_gogma` have no such
 * continuously operated subject, and `reserve_weapon` is a Planner-only action
 * with no in-game operation at all.
 */
export function plannerWeaponOperationSubjectKey(
  entryId: BuildListEntryId,
  operation: RouteOperation,
): string | null {
  if (
    operation.type !== 'reset_bonuses' &&
    operation.type !== 'keep_bonuses' &&
    operation.type !== 'reset_skills'
  ) {
    return null
  }
  return stableStringify(
    weaponOperationSubject(entryId, operation.sourceOwnedWeaponId),
  )
}

/**
 * Applies one executed physical operation to the branch's weapon switch metric.
 *
 * A `null` subject key means the operation has no continuously operated weapon
 * subject, so it neither counts a switch nor becomes the new `last` subject: a
 * `reserve_weapon` action between two operations on the same weapon must not be
 * read as leaving and returning to it (`docs/PLANNER_SPEC.md` 7.3).
 *
 * This is incremental Planner runtime state by design. Recomputing the metric
 * from the whole trace on every state comparison would make each comparison
 * O(trace length) in a search that compares thousands of states.
 */
export function advancePlannerWeaponSwitchMetric(
  state: Pick<
    PlannerSearchState,
    'weaponSwitchCount' | 'lastWeaponOperationSubjectKey'
  >,
  subjectKey: string | null,
): void {
  if (subjectKey === null) return
  if (
    state.lastWeaponOperationSubjectKey !== null &&
    state.lastWeaponOperationSubjectKey !== subjectKey
  ) {
    state.weaponSwitchCount += 1
  }
  state.lastWeaponOperationSubjectKey = subjectKey
}

export function createPlannerPhysicalActionIdentity(
  entry: BuildListEntry,
  operation: RouteOperation,
  operationIndex: number,
  unitIndex: number,
): { key: string; shareable: boolean } {
  if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
    return {
      key: stableStringify({
        type: operation.type,
        physicalSubject: weaponOperationSubject(
          entry.id,
          operation.sourceOwnedWeaponId,
        ),
        before: operation.gogmaCounterBefore,
        after: operation.gogmaCounterAfter,
      }),
      shareable: operation.sourceOwnedWeaponId !== null,
    }
  }
  if (
    operation.type === 'reset_skills' &&
    operation.sourceOwnedWeaponId !== null
  ) {
    return {
      key: stableStringify({
        type: operation.type,
        sourceOwnedWeaponId: operation.sourceOwnedWeaponId,
        before: operation.skillCounterBefore,
        after: operation.skillCounterAfter,
      }),
      shareable: true,
    }
  }
  return {
    key: stableStringify({
      entryId: entry.id,
      operationIndex,
      unitIndex,
      operation,
    }),
    shareable: false,
  }
}

/**
 * Whether another Entry's real operation passing this unit's shared Counter
 * position lets the Planner treat the unit as already passed.
 *
 * The condition is deliberately narrow: the immediately following Route
 * operation must rewrite this operation's entire semantic output without
 * reading it, so neither the later Route result nor any displayed expected
 * result changes when the unit is skipped.
 *
 * - `reset_bonuses` draws all five slots from the Gogma stream position alone,
 *   so any bonus operation directly followed by `reset_bonuses` is unobserved
 * - `keep_bonuses` reads only the current slot families and preserves them, so
 *   a Keep directly followed by another Keep leaves that next Keep's families,
 *   and therefore its result, unchanged (`docs/RNG_SPEC.md` 5.3)
 * - a Reset directly followed by a Keep is required, because the Keep reads the
 *   Reset's families
 * - `reset_skills` writes only the Series / Group Skill pair and predicts it
 *   from the Skill stream position alone, so a Reset Skills directly followed
 *   by another Reset Skills is unobserved
 *
 * A predicted `create_normal_artian` of `count = N` is judged per unit
 * (Issue #129): its first `N - 1` units are Counter-advance forges whose
 * weapons the Route never uses - only the shared Normal Counter moving by one
 * matters - so another Entry's real forge at that position passes them. Its
 * last unit forges the production-target Normal the following conversion
 * uses, a weapon of this Entry alone, and is never skippable. A blind creation
 * holds no Counter position and is never skippable either.
 *
 * Every other operation is never skippable. `convert_normal_to_gogma` carries
 * physical and inventory side effects, and a route's final operation forms the
 * Candidate result itself.
 *
 * "Immediately following" is judged inside the unit's own lane
 * (`docs/PLANNER_SPEC.md` 7.0.4): a Skill amendment interleaved between two
 * Bonus amendments reads nothing the first Bonus amendment wrote, so it does
 * not make that amendment observed.
 *
 * A unit that ends one of this Entry's selected intermediate states is never
 * skippable either, whatever the operation types say: the whole point of
 * selecting it is that the player holds that exact intermediate weapon, so the
 * state is observed rather than immediately overwritten
 * (`docs/PLANNER_SPEC.md` 7.5.1). Earlier units whose entire output the next
 * lane operation rewrites stay skippable, because skipping them leaves the
 * selected state itself unchanged.
 */
function canSkipWhenCounterPassed(
  operations: readonly RouteOperation[],
  operationIndex: number,
  unitIndex: number,
  unitCount: number,
  selectedEndpointOperationIndexes: ReadonlySet<number>,
): boolean {
  const operation = operations[operationIndex]
  if (operation.type === 'create_normal_artian') {
    if (isBlindCreateNormalArtianOperation(operation)) return false
    return unitIndex < unitCount - 1
  }
  if (unitIndex !== unitCount - 1) return false
  if (selectedEndpointOperationIndexes.has(operationIndex)) return false
  const lane = routeOperationLane(operation)
  const next = operations
    .slice(operationIndex + 1)
    .find((candidate) => routeOperationLane(candidate) === lane)
  if (next === undefined) return false
  if (operation.type === 'reset_skills') {
    return (
      next.type === 'reset_skills' &&
      operation.sourceOwnedWeaponId === next.sourceOwnedWeaponId
    )
  }
  if (operation.type !== 'reset_bonuses' && operation.type !== 'keep_bonuses') {
    return false
  }
  if (next.type === 'reset_bonuses') {
    return operation.sourceOwnedWeaponId === next.sourceOwnedWeaponId
  }
  return (
    next.type === 'keep_bonuses' &&
    operation.type === 'keep_bonuses' &&
    operation.sourceOwnedWeaponId === next.sourceOwnedWeaponId
  )
}

function counterDetails(
  operation: RouteOperation,
): {
  stream: PlannerCounterStream
  counterId: string | null
  before: number | null
  after: number | null
} {
  switch (operation.type) {
    case 'create_normal_artian':
      // A blind creation holds no absolute Counter position, so it occupies no
      // Normal Counter stream position: it has no counter precondition, takes
      // part in no Counter conflict, and moves no persisted Counter
      // (`docs/PLANNER_SPEC.md` 7.0.3). It is still one required physical
      // PlanStep, because the weapon really is forged.
      return isBlindCreateNormalArtianOperation(operation)
        ? { stream: null, counterId: null, before: null, after: null }
        : {
            stream: 'normal',
            counterId: `${operation.weaponTypeId}:${operation.rarity}`,
            before: operation.normalCounterBefore,
            after: operation.normalCounterAfter,
          }
    case 'convert_normal_to_gogma':
      return { stream: 'skill', counterId: null, before: operation.skillCounterBefore, after: operation.skillCounterAfter }
    case 'reset_bonuses':
    case 'keep_bonuses':
      return { stream: 'gogma', counterId: null, before: operation.gogmaCounterBefore, after: operation.gogmaCounterAfter }
    case 'reset_skills':
      return {
        stream: 'skill',
        counterId: null,
        before: operation.skillCounterBefore,
        after: operation.skillCounterAfter,
      }
  }
}

function exclusiveConsumedWeaponId(
  entry: BuildListEntry,
  operation: RouteOperation,
): OwnedWeaponId | null {
  if (
    operation.type === 'convert_normal_to_gogma' &&
    entry.candidateSnapshot.route.kind === 'owned_normal_artian_to_gogma'
  ) {
    return entry.candidateSnapshot.route.sourceOwnedWeaponId
  }
  if (
    operation.type === 'reset_bonuses' ||
    operation.type === 'keep_bonuses'
  ) {
    return operation.sourceOwnedWeaponId
  }
  return null
}

function rejection(
  entry: BuildListEntry,
  actionType: RouteOperation['type'],
  detail: string,
  reason: PlannerSearchRejection['reason'] = 'rng_contract_unavailable',
): PlannerSearchRejection {
  return {
    buildListEntryId: entry.id,
    actionType,
    reason,
    detail,
  }
}

/**
 * The Route operation indexes that end this Entry's selected intermediate
 * states. A selected lane start is held from the beginning and has no ending
 * operation.
 */
function selectedEndpointOperationIndexes(entry: BuildListEntry): Set<number> {
  const selection = entryIntermediateSelection(entry)
  const indexes = new Set<number>()
  for (const selected of [selection.skill, selection.bonus]) {
    if (
      selected !== null &&
      selected.opportunity.lanePosition > 0 &&
      selected.opportunity.operationIndex !== null
    ) {
      indexes.add(selected.opportunity.operationIndex)
    }
  }
  return indexes
}

function createEntryUnitPlan(
  entry: BuildListEntry,
  engine: RngEngine,
): { units: PlannerRouteUnit[] | null; rejection: PlannerSearchRejection | null } {
  const units: PlannerRouteUnit[] = []
  const operations = entry.candidateSnapshot.route.operations
  const checkpointEndpoints = selectedEndpointOperationIndexes(entry)
  const laneCounts: Record<PlannerRouteLane, number> = { base: 0, bonus: 0, skill: 0 }
  for (
    let operationIndex = 0;
    operationIndex < operations.length;
    operationIndex += 1
  ) {
    const operation = operations[operationIndex]
    const detail = counterDetails(operation)
    const unitCount =
      operation.type === 'create_normal_artian' ? operation.count : 1
    let current = detail.before
    for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
      let next = detail.after
      if (detail.stream !== null && current !== null) {
        try {
          next = engineAdvance(engine, operation, current)
        } catch (error) {
          return {
            units: null,
            rejection: rejection(
              entry,
              operation.type,
              error instanceof Error
                ? error.message
                : 'The RNG Engine rejected the saved RouteOperation.',
            ),
          }
        }
      }
      if (
        detail.stream !== null &&
        current !== null &&
        next !== null &&
        next < current
      ) {
        return {
          units: null,
          rejection: rejection(
            entry,
            operation.type,
            `The saved RouteOperation rewinds its counter from ${current} to ${next}.`,
            'counter_after_mismatch',
          ),
        }
      }
      const identity = createPlannerPhysicalActionIdentity(
        entry,
        operation,
        operationIndex,
        unitIndex,
      )
      const lane = routeOperationLane(operation)
      units.push({
        entryId: entry.id,
        operation: structuredClone(operation),
        position: { operationIndex, unitIndex, unitCount },
        lane,
        laneIndex: laneCounts[lane],
        counterStream: detail.stream,
        counterId: detail.counterId,
        counterBefore: current,
        counterAfter: next,
        physicalActionKey: identity.key,
        shareable: identity.shareable,
        exclusiveConsumedOwnedWeaponId: exclusiveConsumedWeaponId(
          entry,
          operation,
        ),
        canSkipWhenCounterPassed: canSkipWhenCounterPassed(
          operations,
          operationIndex,
          unitIndex,
          unitCount,
          checkpointEndpoints,
        ),
      })
      laneCounts[lane] += 1
      current = next
    }
    if (
      detail.stream !== null &&
      current !== detail.after
    ) {
      return {
        units: null,
        rejection: rejection(
          entry,
          operation.type,
          `RNG Engine advancement ended at ${current}, but the saved operation ends at ${detail.after}.`,
          'counter_after_mismatch',
        ),
      }
    }
  }
  return { units, rejection: null }
}

export function createPlannerRouteUnitPlans(
  entries: readonly BuildListEntry[],
  engine: RngEngine,
): PlannerRouteUnitPlanResult {
  const unitPlans = new Map<BuildListEntryId, PlannerRouteUnit[]>()
  const rejections: PlannerSearchRejection[] = []
  entries.forEach((entry) => {
    const planned = createEntryUnitPlan(entry, engine)
    if (planned.units) unitPlans.set(entry.id, planned.units)
    if (planned.rejection) rejections.push(planned.rejection)
  })
  return { unitPlans, rejections }
}

/**
 * Applies the physical Normal Artian Counter advance of a blind creation.
 *
 * A blind `create_normal_artian` occupies no Counter stream position, so it has
 * no Counter precondition and never joins a Counter position conflict. That is
 * a statement about the Route: its Candidate result does not depend on any
 * absolute Normal Counter position. It is NOT a statement about the runtime -
 * the player really does forge one Normal Artian weapon, and the game Counter
 * really does advance (`docs/PLANNER_SPEC.md` 7.0.3).
 *
 * So whenever the tool currently holds a confirmed Counter for that weapon
 * type, that Counter advances here through the same `advanceNormalCounter()`
 * authority the predicted variant uses. An unconfirmed, null, or absent Counter
 * record stays exactly as it is: an unconfirmed value is not authority, so it
 * is never advanced and no record is invented.
 *
 * Returns `null` when nothing changed, so a caller can skip the state write.
 */
export function advanceBlindNormalCreationCounters(
  counters: readonly NormalArtianCounter[],
  operation: RouteOperation,
  engine: RngEngine,
): NormalArtianCounter[] | null {
  if (
    operation.type !== 'create_normal_artian' ||
    !isBlindCreateNormalArtianOperation(operation)
  ) {
    return null
  }
  const counterId = `${operation.weaponTypeId}:${operation.rarity}`
  const target = counters.find(({ id }) => id === counterId)
  if (!target || !target.isConfirmed || target.counter === null) return null
  const advanced = engine.advanceNormalCounter(target.counter, {
    type: 'create_normal_artian',
    count: operation.count,
  })
  return counters.map((counter) =>
    counter.id === counterId ? { ...counter, counter: advanced } : counter,
  )
}

export function routeUnitOwnedWeaponId(
  entry: BuildListEntry,
  unit: PlannerRouteUnit,
): OwnedWeaponId | null {
  return ownedWeaponIdForOperation(entry, unit.operation)
}

export function arePlannerRouteUnitsShareable(
  left: PlannerRouteUnit,
  right: PlannerRouteUnit,
): boolean {
  return (
    left.shareable &&
    right.shareable &&
    left.physicalActionKey === right.physicalActionKey
  )
}

/** The shared Counter value a unit's precondition is compared against. */
export function currentPlannerCounterValue(
  state: PlannerSearchState,
  unit: PlannerRouteUnit,
): number | null {
  if (unit.counterStream === 'gogma') {
    return state.currentRngState.gogmaCounter.value
  }
  if (unit.counterStream === 'skill') {
    return state.currentRngState.skillCounter.value
  }
  if (unit.counterStream === 'normal') {
    return (
      state.currentNormalCounters.find(({ id }) => id === unit.counterId)
        ?.counter ?? null
    )
  }
  return null
}

/**
 * Advances Route progress past units whose shared Counter position a different
 * Entry's real operation already passed.
 *
 * This is Counter stream progression, not physical action sharing: no
 * PlannerSearchAction is created, nothing is added to the trace,
 * `progressedBuildListEntryIds` / `progressedTargetWeaponIds`, the inventory,
 * the route runtime output, or any source mutation version
 * (`docs/PLANNER_SPEC.md` 7.0.2). A unit that is not
 * `canSkipWhenCounterPassed` is never passed here, so a past required unit
 * still fails closed in the ordinary counter precondition. Each lane is passed
 * on its own - the base lane only through the Counter-advance forges of a
 * predicted Normal creation (Issue #129), which the checkpoint pin never gates
 * - and a stream lane never beyond the Entry's checkpoint pin while the other
 * lane has not reached its own pin (7.5.2).
 */
export function fastForwardPlannerRouteProgress(
  state: PlannerSearchState,
  lanePlans: ReadonlyMap<BuildListEntryId, PlannerEntryLanes>,
): void {
  lanePlans.forEach((lanes, entryId) => {
    const started = state.routeProgressByEntryId[entryId]
    if (started === undefined) return
    let progress = started
    for (const lane of ['base', 'bonus', 'skill'] as const) {
      while (progress[lane] < lanes[lane].length) {
        const unit = lanes[lane][progress[lane]]
        if (unit.counterBefore === null) break
        if (!isPlannerLaneUnitFastForwardable(unit, progress, lanes.pin)) break
        const current = currentPlannerCounterValue(state, unit)
        if (current === null || current <= unit.counterBefore) break
        progress = { ...progress, [lane]: progress[lane] + 1 }
      }
    }
    if (progress !== started) state.routeProgressByEntryId[entryId] = progress
  })
}
