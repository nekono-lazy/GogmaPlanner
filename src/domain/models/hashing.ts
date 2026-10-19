import type {
  NormalArtianCounter,
  OwnedWeaponId,
  PlanStepId,
  RestorationBonusScope,
  RestorationBonusSet,
  RngState,
  TargetWeaponId,
} from './common'
import { V1_NORMAL_ARTIAN_RARITY } from './common'
import type { BuildRoute, OwnedWeapon, TargetWeapon } from './entities'
import { isBlindCreateNormalArtianOperation } from './entities'
import type { ExpectedPlanState, ExpectedStateObservationBindingToken } from './planning'

export class StableSerializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StableSerializationError'
  }
}

function serializeStable(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StableSerializationError('Only finite numbers can be hashed.')
    }
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new StableSerializationError(
      `Unsupported stable serialization value: ${typeof value}.`,
    )
  }
  if (ancestors.has(value)) {
    throw new StableSerializationError('Cyclic values cannot be hashed.')
  }

  ancestors.add(value)
  let result: string
  if (Array.isArray(value)) {
    result = `[${value
      .map((entry) => serializeStable(entry, ancestors))
      .join(',')}]`
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StableSerializationError(
        'Only plain objects can be hashed.',
      )
    }
    const record = value as Record<string, unknown>
    result = `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeStable(record[key], ancestors)}`,
      )
      .join(',')}}`
  }
  ancestors.delete(value)
  return result
}

export function stableStringify(value: unknown): string {
  return serializeStable(value, new WeakSet<object>())
}

export function hashStableValue(value: unknown): string {
  const serialized = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * The semantic content of one `KnownValue`: the value and whether it is
 * confirmed. Source, notes, and observation timestamps are non-semantic and
 * never participate in a stable value.
 */
export function normalizeKnownValue<T>(known: {
  value: T | null
  isConfirmed: boolean
}) {
  return { value: known.value, isConfirmed: known.isConfirmed }
}

function normalCounterId(
  operation: Extract<
    BuildRoute['operations'][number],
    { type: 'create_normal_artian' }
  >,
): string {
  return `${operation.weaponTypeId}:${V1_NORMAL_ARTIAN_RARITY}`
}

export function createSearchStateHash(
  route: BuildRoute,
  rngState: RngState,
  normalCounters: readonly NormalArtianCounter[],
): string {
  const usesGogmaPrediction = route.operations.some((operation) =>
    ['reset_bonuses', 'keep_bonuses'].includes(
      operation.type,
    ),
  )
  const usesSkillPrediction = route.operations.some(
    ({ type }) => type === 'convert_normal_to_gogma' || type === 'reset_skills',
  )
  // A blind Normal creation reads no Normal Artian Counter, so it never adds a
  // Normal Counter dependency: later confirming that Counter must not stale the
  // Candidate, whose semantics did not change (`docs/SEARCH_SPEC.md` 6.1.1).
  const relevantNormalCounterIds = [
    ...new Set(
      route.operations
        .filter(
          (operation): operation is Extract<
            BuildRoute['operations'][number],
            { type: 'create_normal_artian' }
          > => operation.type === 'create_normal_artian',
        )
        .filter((operation) => !isBlindCreateNormalArtianOperation(operation))
        .map(normalCounterId),
    ),
  ].sort()

  const normalized: Record<string, unknown> = {
    baseSeed: normalizeKnownValue(rngState.baseSeed),
  }
  if (usesGogmaPrediction) {
    normalized.gogmaCounter = normalizeKnownValue(rngState.gogmaCounter)
  }
  if (usesSkillPrediction) {
    normalized.skillCounter = normalizeKnownValue(rngState.skillCounter)
  }
  if (relevantNormalCounterIds.length > 0) {
    const counterById = new Map(
      normalCounters.map((counter) => [counter.id, counter]),
    )
    normalized.normalCounters = relevantNormalCounterIds.map((id) => {
      const counter = counterById.get(id)
      return {
        id,
        counter: counter?.counter ?? null,
        isConfirmed: counter?.isConfirmed ?? false,
      }
    })
  }
  return hashStableValue(normalized)
}

export function collectReferencedOwnedWeaponIds(
  route: BuildRoute,
): OwnedWeaponId[] {
  const ids = new Set<OwnedWeaponId>()
  if (route.sourceOwnedWeaponId !== null) {
    ids.add(route.sourceOwnedWeaponId)
  }
  route.operations.forEach((operation) => {
    if (
      operation.type === 'reset_bonuses' ||
      operation.type === 'keep_bonuses'
    ) {
      if (operation.sourceOwnedWeaponId !== null) ids.add(operation.sourceOwnedWeaponId)
    }
    if (
      operation.type === 'reset_skills' &&
      operation.sourceOwnedWeaponId !== null
    ) {
      if (operation.sourceOwnedWeaponId !== null) ids.add(operation.sourceOwnedWeaponId)
    }
  })
  return [...ids].sort()
}

/**
 * The semantic content of one OwnedWeapon as `referencedOwnedWeaponsHash`
 * defines it: identity, kind, weapon type, element, restoration bonus scope and
 * the stored five slots in order, protection, plus Series / Group Skill for a
 * Gogma weapon.
 *
 * `name`, `memo`, and the timestamps are excluded because they carry no
 * calculation meaning, and `status` is excluded for exactly the same reason: it
 * is a user-facing organisation label that decides nothing about Search routes,
 * Planner eligibility, or Target Satisfaction (`docs/DATA_MODEL.md` 3.2). So
 * relabelling a weapon must never stale a Candidate, a BuildListEntry, or a
 * ProductionPlan, while changing its protection, bonuses, Skills, scope, kind,
 * weapon type, or element still does.
 *
 * Exported so a caller that needs the same per-weapon semantics for a different
 * stable value - the Planner-start Search origin normalization of the Planner
 * Alternative search identity - reuses this authority instead of writing a
 * second normalization.
 */
export function normalizeReferencedOwnedWeapon(weapon: OwnedWeapon) {
  const common = {
    id: weapon.id,
    kind: weapon.kind,
    weaponTypeId: weapon.weaponTypeId,
    elementId: weapon.elementId,
    restorationBonusScope: weapon.restorationBonusScope,
    restorationBonuses: weapon.restorationBonuses.map((bonus) => ({
      bonusTypeId: bonus.bonusTypeId,
      bonusRankId: bonus.bonusRankId,
    })),
    isProtected: weapon.isProtected,
  }
  return weapon.kind === 'normal'
    ? common
    : {
        ...common,
        seriesSkillId: weapon.seriesSkillId,
        groupSkillId: weapon.groupSkillId,
      }
}

export function createReferencedOwnedWeaponsHash(
  route: BuildRoute,
  ownedWeapons: readonly OwnedWeapon[],
): string | null {
  const referencedIds = collectReferencedOwnedWeaponIds(route)
  if (referencedIds.length === 0) return null

  const weaponById = new Map(ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const normalized = referencedIds.map((id) => {
    const weapon = weaponById.get(id)
    return weapon ? normalizeReferencedOwnedWeapon(weapon) : { id, missing: true }
  })
  return hashStableValue(normalized)
}

type WithUnknownRestorationBonuses<T> = T extends OwnedWeapon
  ? Omit<T, 'restorationBonuses'> & { restorationBonuses: null }
  : never

/**
 * One OwnedWeapon as an expected execution state sees it.
 *
 * An actual persisted weapon always has its five slots. A weapon of a Plan's
 * execution projection may instead hold `restorationBonuses: null`: a blind
 * production-target Normal whose slots were never predicted and are bound to the
 * user's observation (`docs/PLANNER_SPEC.md` 16.5). Such a weapon is hashable
 * only together with its observation binding token, so no fabricated slots ever
 * reach a hash.
 */
export type ExpectedPlanStateOwnedWeapon =
  | OwnedWeapon
  | WithUnknownRestorationBonuses<OwnedWeapon>

/**
 * The Plan-dependent Target execution state input of an expected state
 * (`docs/PLANNER_SPEC.md` 16.5). Only `dependentTargetWeaponIds` are hashed; a
 * Plan-independent Target never enters it.
 */
export interface ExpectedPlanTargetExecutionInput {
  targetWeapons: readonly Pick<
    TargetWeapon,
    'id' | 'lifecycleStatus' | 'preferredOwnedWeaponId'
  >[]
  dependentTargetWeaponIds: readonly TargetWeaponId[]
}

export class ExpectedPlanStateNormalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpectedPlanStateNormalizationError'
  }
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeExpectedOwnedWeapon(
  weapon: ExpectedPlanStateOwnedWeapon,
  token: PlanStepId | undefined,
) {
  let restorationBonuses:
    | ExpectedStateObservationBindingToken
    | { bonusTypeId: string; bonusRankId: string }[]
  if (token !== undefined) {
    restorationBonuses = { observationBinding: token }
  } else if (weapon.restorationBonuses === null) {
    throw new ExpectedPlanStateNormalizationError(
      `OwnedWeapon '${weapon.id}' has unknown restoration bonuses but no observation binding token.`,
    )
  } else {
    restorationBonuses = weapon.restorationBonuses.map((bonus) => ({
      bonusTypeId: bonus.bonusTypeId,
      bonusRankId: bonus.bonusRankId,
    }))
  }
  const common = {
    id: weapon.id,
    kind: weapon.kind,
    weaponTypeId: weapon.weaponTypeId,
    elementId: weapon.elementId,
    restorationBonusScope: weapon.restorationBonusScope,
    restorationBonuses,
    isProtected: weapon.isProtected,
  }
  return weapon.kind === 'normal'
    ? { ...common, rarity: weapon.rarity }
    : {
        ...common,
        seriesSkillId: weapon.seriesSkillId,
        groupSkillId: weapon.groupSkillId,
      }
}

/**
 * `targetExecutionStateHash`: `id`, `lifecycleStatus` and
 * `preferredOwnedWeaponId` of each Plan-dependent Target in ID order
 * (`docs/PLANNER_SPEC.md` 16.5). Every other Target, and every timestamp, is
 * excluded, so adding or changing a Plan-independent Target never moves it. A
 * dependent Target that no longer exists hashes as missing.
 */
export function createTargetExecutionStateHash(
  input: ExpectedPlanTargetExecutionInput,
): string {
  const targetById = new Map(input.targetWeapons.map((target) => [target.id, target]))
  return hashStableValue(
    [...new Set(input.dependentTargetWeaponIds)]
      .sort(compareStableIds)
      .map((id) => {
        const target = targetById.get(id)
        return target
          ? {
              id,
              lifecycleStatus: target.lifecycleStatus,
              preferredOwnedWeaponId: target.preferredOwnedWeaponId,
            }
          : { id, missing: true }
      }),
  )
}

/** One confirmed observation binding of a Plan (`docs/PLANNER_SPEC.md` 16.5). */
export interface ObservedRestorationBonusBinding {
  ownedWeaponId: OwnedWeaponId
  planStepId: PlanStepId
  observedRestorationBonuses: RestorationBonusSet
  observedRestorationBonusScope: RestorationBonusScope
}

/**
 * Which actual weapons normalize to their observation binding token.
 *
 * A weapon is replaced by its token only when its current five slots, in slot
 * order, and its scope equal what the user observed at the binding Step.
 * Anything else keeps its real value, so an unplanned edit of an observed weapon
 * is detected as a mismatch instead of being hidden behind the token.
 */
export function resolveObservationBindingTokens(
  ownedWeapons: readonly OwnedWeapon[],
  bindings: readonly ObservedRestorationBonusBinding[],
): Map<OwnedWeaponId, PlanStepId> {
  const weaponById = new Map(ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const tokens = new Map<OwnedWeaponId, PlanStepId>()
  bindings.forEach((binding) => {
    const weapon = weaponById.get(binding.ownedWeaponId)
    if (
      weapon !== undefined &&
      weapon.restorationBonusScope === binding.observedRestorationBonusScope &&
      weapon.restorationBonuses.every(
        (bonus, slot) =>
          bonus.bonusTypeId === binding.observedRestorationBonuses[slot]?.bonusTypeId &&
          bonus.bonusRankId === binding.observedRestorationBonuses[slot]?.bonusRankId,
      )
    ) {
      tokens.set(binding.ownedWeaponId, binding.planStepId)
    }
  })
  return tokens
}

/**
 * One expected execution state (`docs/DATA_MODEL.md` 11.2).
 *
 * `observationBindingTokens` names the weapons whose five slots normalize to a
 * binding token. A Plan projection passes its still-bound weapons; an actual
 * state passes `resolveObservationBindingTokens()` so only an exact match of the
 * recorded observation is tokenized. `status`, `executionInProgress`, `name`,
 * `memo` and timestamps stay out of every hash.
 */
export function createExpectedPlanState(
  rngState: RngState,
  normalCounters: readonly NormalArtianCounter[],
  ownedWeapons: readonly ExpectedPlanStateOwnedWeapon[],
  targetExecution: ExpectedPlanTargetExecutionInput,
  observationBindingTokens: ReadonlyMap<OwnedWeaponId, PlanStepId> = new Map(),
): ExpectedPlanState {
  const normalizedRngState = {
    baseSeed: normalizeKnownValue(rngState.baseSeed),
    gogmaCounter: normalizeKnownValue(rngState.gogmaCounter),
    skillCounter: normalizeKnownValue(rngState.skillCounter),
  }
  const normalizedCounters = [...normalCounters]
    .sort((left, right) => compareStableIds(left.id, right.id))
    .map(({ id, counter, isConfirmed }) => ({ id, counter, isConfirmed }))
  const normalizedWeapons = [...ownedWeapons]
    .sort((left, right) => compareStableIds(left.id, right.id))
    // A Target's preferred owned weapon is Target execution state, not
    // inventory state, so it never enters this hash.
    .map((weapon) =>
      normalizeExpectedOwnedWeapon(weapon, observationBindingTokens.get(weapon.id)),
    )

  return {
    rngStateHash: hashStableValue(normalizedRngState),
    normalCountersHash: hashStableValue(normalizedCounters),
    ownedWeaponsHash: hashStableValue(normalizedWeapons),
    targetExecutionStateHash: createTargetExecutionStateHash(targetExecution),
  }
}
