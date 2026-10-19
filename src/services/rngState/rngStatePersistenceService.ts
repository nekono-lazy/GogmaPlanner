import {
  applyUserChanges,
  unchangedMutableState,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanGuardedMutation,
} from '../../domain/execution'
import type { ISODateTimeString, NormalArtianCounter, RngState, WeaponTypeId } from '../../domain/models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../../domain/models/publicTypes'
import { validateNormalArtianCounter, validateRngState } from '../../domain/models/validation'
import { normalArtianCounterId } from '../../db/repositories/normalArtianCounterRepository'
import { assertRepositoryValidation } from '../../db/repositoryError'
import {
  defaultPlanGuardedPersistence,
  type PlanGuardedPersistence,
} from '../execution/planBreakingChangeGuard'

/**
 * The RngState fields a direct RNG Setup save sets: the user's intent. The
 * record identity, `createdAt` and the Identification provenance
 * `lastIdentifiedAt` always come from the stored RngState: an RNG Setup save -
 * a value edit, a confirmation change, a notes-only save or a Counter Gate
 * change - never records or removes an Identification adoption
 * (`docs/DATA_MODEL.md` 6.1).
 */
export type RngStateSaveIntent = Pick<RngState, 'baseSeed' | 'gogmaCounter' | 'skillCounter' | 'counterGate' | 'notes'>

/**
 * One RngState save as a guarded mutation (`docs/PLANNER_SPEC.md` 16.6). The
 * intent is applied over the RngState of the state the mutation runs on. With
 * a `basis` - the RngState the screen edited - only the fields the user changed
 * from it are applied (`applyUserChanges()`), so after a save point restore a
 * Counter the user did not touch keeps its restored value. Without one every
 * intent field is applied.
 */
export function rngStateSaveMutation(
  intent: RngStateSaveIntent,
  basis: RngState | null,
  now: ISODateTimeString,
  fallback: RngState,
): PlanGuardedMutation<RngState> {
  return (base) => {
    const current = base.rngState ?? fallback
    const edited = basis === null
      ? { ...current, ...intent }
      : applyUserChanges<RngState>(current, basis, intent)
    const next: RngState = { ...edited, lastIdentifiedAt: current.lastIdentifiedAt, updatedAt: now }
    assertRepositoryValidation('RngState', validateRngState(next))
    return { result: next, state: { ...unchangedMutableState(base), rngState: next } }
  }
}

/**
 * The Identification provenance of a Normal Counter after an ordinary save
 * (`docs/DATA_MODEL.md` 6.2): the intent never carries it. A save that leaves
 * the stored `counter` value as it is keeps the stored provenance (a confirm /
 * unconfirm, an observation count edit), and one that changes the value - a
 * manual or Debug edit - resets it to `null`, because the current value no
 * longer is the identified one. A new record has none.
 */
function identificationProvenanceAfterSave(
  current: NormalArtianCounter | undefined,
  next: Pick<NormalArtianCounter, 'counter'>,
): ISODateTimeString | null {
  if (current === undefined) return null
  return next.counter === current.counter ? current.lastIdentifiedAt : null
}

function replaceCounter(
  base: Parameters<PlanGuardedMutation<NormalArtianCounter>>[0],
  current: NormalArtianCounter | undefined,
  next: NormalArtianCounter,
): ReturnType<PlanGuardedMutation<NormalArtianCounter>> {
  return {
    result: next,
    state: {
      ...unchangedMutableState(base),
      normalCounters: current === undefined
        ? [...base.normalCounters, next]
        : base.normalCounters.map((stored) => (stored.id === next.id ? next : stored)),
    },
  }
}

/**
 * One NormalArtianCounter save as a guarded mutation. The Counter body the
 * screen built is the user's intent for that one weapon type. With a `basis` -
 * the record the screen edited - only the fields the user changed from it are
 * applied to the stored record (`applyUserChanges()`); `createdAt` comes from
 * the stored record when it exists, and `lastIdentifiedAt` follows
 * `identificationProvenanceAfterSave()`, never the intent.
 */
export function normalArtianCounterSaveMutation(
  counter: NormalArtianCounter,
  basis: NormalArtianCounter | null,
  now: ISODateTimeString,
): PlanGuardedMutation<NormalArtianCounter> {
  return (base) => {
    const current = base.normalCounters.find(({ id }) => id === counter.id)
    const edited = current !== undefined && basis !== null && basis.id === counter.id
      ? applyUserChanges<NormalArtianCounter>(current, basis, counter)
      : counter
    const next: NormalArtianCounter = {
      ...edited,
      lastIdentifiedAt: identificationProvenanceAfterSave(current, edited),
      createdAt: current?.createdAt ?? counter.createdAt,
      updatedAt: now,
    }
    assertRepositoryValidation('NormalArtianCounter', validateNormalArtianCounter(next))
    return replaceCounter(base, current, next)
  }
}

/** The unique Normal Counter Identification result the Normal Counter Setup confirms (`docs/UI_FLOW.md` 6). */
export interface NormalArtianCounterIdentificationAdoption {
  weaponTypeId: WeaponTypeId
  /** The kernel's `startNormalCounter = C`: the Counter forged next in the restored state. */
  startNormalCounter: number
  /** The number of observations the unique result was searched with; never added to `C`. */
  observationCount: number
}

/**
 * One Normal Counter Identification adoption as a guarded mutation
 * (`docs/UI_FLOW.md` 6, `docs/DATA_MODEL.md` 6.2): the stored record of the
 * weapon type (or a new one) gets `counter = startNormalCounter` - never
 * `C + observationCount` -, `isConfirmed = true`, the observation count, one
 * remaining candidate, `lastObservedAt = now` and the Identification provenance
 * `lastIdentifiedAt = now`. It is the only writer of that provenance.
 */
export function normalArtianCounterIdentificationAdoptionMutation(
  adoption: NormalArtianCounterIdentificationAdoption,
  now: ISODateTimeString,
): PlanGuardedMutation<NormalArtianCounter> {
  const id = normalArtianCounterId(adoption.weaponTypeId, V1_NORMAL_ARTIAN_RARITY)
  return (base) => {
    const current = base.normalCounters.find((stored) => stored.id === id)
    const next: NormalArtianCounter = {
      id,
      weaponTypeId: adoption.weaponTypeId,
      rarity: V1_NORMAL_ARTIAN_RARITY,
      counter: adoption.startNormalCounter,
      isConfirmed: true,
      observationCount: adoption.observationCount,
      candidateCount: 1,
      lastObservedAt: now,
      lastIdentifiedAt: now,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    }
    assertRepositoryValidation('NormalArtianCounter', validateNormalArtianCounter(next))
    return replaceCounter(base, current, next)
  }
}

export interface RngStatePersistenceDependencies {
  persistence: PlanGuardedPersistence
  clock: { now(): ISODateTimeString }
}

function intentOf(state: RngState): RngStateSaveIntent {
  return {
    baseSeed: state.baseSeed,
    gogmaCounter: state.gogmaCounter,
    skillCounter: state.skillCounter,
    counterGate: state.counterGate,
    notes: state.notes,
  }
}

/**
 * RNG Setup's direct RngState save and the Normal Counter Setup save
 * (confirm, unconfirm, Debug edit, Identification result), both behind the
 * breaking-change guard: on an `active` Plan a semantic change is refused
 * without approval, and with it the Plan is abandoned in the same transaction.
 */
export class RngStatePersistenceService {
  private readonly dependencies: RngStatePersistenceDependencies

  constructor(
    dependencies: RngStatePersistenceDependencies = {
      persistence: defaultPlanGuardedPersistence,
      clock: { now: () => new Date().toISOString() },
    },
  ) {
    this.dependencies = dependencies
  }

  /**
   * Saves the RNG Setup edit. `basis` is the RngState the screen edited, so
   * only the fields changed from it are applied.
   */
  async saveRngState(
    state: RngState,
    basis: RngState | null = null,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<RngState> {
    const mutation = rngStateSaveMutation(intentOf(state), basis, this.dependencies.clock.now(), state)
    return (await this.dependencies.persistence.apply(mutation, approval)).result
  }

  /** Whether the RNG Setup save needs the breaking-change approval (`docs/UI_FLOW.md` 16.3). Writes nothing. */
  inspectRngStateSave(state: RngState, basis: RngState | null = null): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.persistence.inspect(
      rngStateSaveMutation(intentOf(state), basis, this.dependencies.clock.now(), state),
    )
  }

  /**
   * Saves one Normal Counter record (confirm, unconfirm, Debug edit or an
   * Identification result). `basis` is the record the screen edited, if any.
   */
  async saveNormalArtianCounter(
    counter: NormalArtianCounter,
    basis: NormalArtianCounter | null = null,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<NormalArtianCounter> {
    const mutation = normalArtianCounterSaveMutation(counter, basis, this.dependencies.clock.now())
    return (await this.dependencies.persistence.apply(mutation, approval)).result
  }

  /**
   * Adopts the unique Normal Counter Identification result of one weapon type
   * (`docs/UI_FLOW.md` 6). The only writer of `NormalArtianCounter.lastIdentifiedAt`.
   */
  async adoptNormalArtianCounterIdentification(
    adoption: NormalArtianCounterIdentificationAdoption,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<NormalArtianCounter> {
    const mutation = normalArtianCounterIdentificationAdoptionMutation(adoption, this.dependencies.clock.now())
    return (await this.dependencies.persistence.apply(mutation, approval)).result
  }

  /**
   * Whether adopting the unique Normal Counter Identification result needs the
   * breaking-change approval (`docs/UI_FLOW.md` 16.3). The very same mutation
   * the adoption saves is inspected; the screen never builds the Counter
   * record itself. Writes nothing.
   */
  inspectNormalArtianCounterIdentificationAdoption(
    adoption: NormalArtianCounterIdentificationAdoption,
  ): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.persistence.inspect(
      normalArtianCounterIdentificationAdoptionMutation(adoption, this.dependencies.clock.now()),
    )
  }

  /** Whether the Normal Counter save needs the breaking-change approval. Writes nothing. */
  inspectNormalArtianCounterSave(
    counter: NormalArtianCounter,
    basis: NormalArtianCounter | null = null,
  ): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.persistence.inspect(
      normalArtianCounterSaveMutation(counter, basis, this.dependencies.clock.now()),
    )
  }
}

export const rngStatePersistenceService = new RngStatePersistenceService()
