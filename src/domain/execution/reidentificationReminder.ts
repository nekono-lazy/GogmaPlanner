import type {
  ExecutionHistory,
  ISODateTimeString,
  NormalArtianCounter,
  PlanStep,
  ProductionPlan,
  RngState,
} from '../models/publicTypes'
import { compareExecutionHistoryOrder } from '../models/publicTypes'

/**
 * Where the re-identification of a diverged operation happens
 * (`docs/PLANNER_SPEC.md` 16.15): a Normal Artian creation is re-identified in
 * Normal Counter Setup, every Gogma / Skill operation in RNG Setup
 * (Identification Wizard). The one destination authority of the stale Plan
 * guidance and the re-identification reminder.
 */
export type ReidentificationDestination = 'normal_counters' | 'rng'

export function executionReidentificationDestination(
  step: Pick<PlanStep, 'operationType'>,
): ReidentificationDestination {
  return step.operationType === 'create_normal_artian' ? 'normal_counters' : 'rng'
}

/**
 * One `actual_result_different` record whose prediction stream was not formally
 * re-identified after it (16.15).
 */
export type UnresolvedActualResultDivergence =
  | {
      executionHistoryId: ExecutionHistory['id']
      planStepId: PlanStep['id']
      destination: 'normal_counters'
      /**
       * The Normal Counter the diverged creation consumed
       * (`PlanStep.rngAdvance.affectedNormalCounterId`), or `null` when the Step
       * does not name one - then nothing can resolve it and it stays unresolved.
       */
      normalCounterId: string | null
    }
  | {
      executionHistoryId: ExecutionHistory['id']
      planStepId: PlanStep['id']
      destination: 'rng'
    }

/**
 * Whether the user must still re-identify a prediction stream because of a
 * Plan's `actual_result_different` record (`docs/PLANNER_SPEC.md` 16.15
 * 「RNG再同定を促す継続表示」). Display only and derived from the persisted
 * ExecutionHistory, RngState and NormalArtianCounters alone: no flag is
 * persisted and nothing here writes any of them. Shared by the Execution
 * Navigator's ended view and the persistent reminder of Dashboard / RNG Setup /
 * Candidate Search.
 *
 * `operation_uncertain` is recovered inside the Execution Navigator and keeps
 * its own guidance; it is not decided here.
 */
export type ExecutionReidentificationReminder =
  | { kind: 'none' }
  | {
      kind: 'actual_result_different'
      /** One entry per unresolved prediction stream, in stream order (Normal Counters by ID, then RNG). */
      unresolved: UnresolvedActualResultDivergence[]
    }

/** A canonical UTC ISO date-time exactly as `Date.prototype.toISOString()` writes it. */
function isCanonicalIsoDateTime(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/**
 * Whether `identifiedAt` is strictly later than `divergedAt`. Both are compared
 * only as canonical UTC ISO strings, whose lexicographic order is chronological
 * - the same string order `compareExecutionHistoryOrder()` uses; no locale
 * conversion. Anything that cannot be decided safely - an equal instant, a
 * `null` provenance or a non-canonical value - is "not later", so an unresolved
 * divergence is never taken as resolved.
 */
function isIdentifiedAfter(identifiedAt: ISODateTimeString | null, divergedAt: ISODateTimeString): boolean {
  if (identifiedAt === null) return false
  if (!isCanonicalIsoDateTime(identifiedAt) || !isCanonicalIsoDateTime(divergedAt)) return false
  return identifiedAt > divergedAt
}

/**
 * Whether the current RngState is a formal RNG Identification adoption made
 * after the divergence (16.15): `lastIdentifiedAt` - written only by the
 * Identification adoption - is strictly later, and the three values the
 * adoption sets (Base Seed, Skill Counter, Gogma Counter) still are the adopted
 * ones: confirmed, from `observation`, and held. A later RNG Setup save that
 * changed one of them makes it `manual`, so the state is no longer the
 * identified one; a notes-only or Counter Gate save leaves them as adopted.
 * One adoption identifies all three, so the Gogma stream and the Skill stream
 * are resolved together (`docs/RNG_SPEC.md` 9.9).
 */
export function isRngIdentifiedAfter(
  rngState: Pick<RngState, 'baseSeed' | 'gogmaCounter' | 'skillCounter' | 'lastIdentifiedAt'> | null,
  divergedAt: ISODateTimeString,
): boolean {
  if (rngState === null) return false
  if (!isIdentifiedAfter(rngState.lastIdentifiedAt, divergedAt)) return false
  return [rngState.baseSeed, rngState.gogmaCounter, rngState.skillCounter].every(
    (known) => known.value !== null && known.isConfirmed && known.source === 'observation',
  )
}

/**
 * Whether the Normal Counter the divergence names holds a unique Normal Counter
 * Identification result adopted after it (16.15): the record exists,
 * `lastIdentifiedAt` - written only by that adoption and reset by a save that
 * changes the value - is strictly later, and the identified value is still
 * confirmed and held, so Candidate Search can use it. An unconfirmed record
 * stays unresolved until it is confirmed again; another weapon type's Counter
 * never counts.
 */
export function isNormalCounterIdentifiedAfter(
  counter: Pick<NormalArtianCounter, 'counter' | 'isConfirmed' | 'lastIdentifiedAt'> | undefined,
  divergedAt: ISODateTimeString,
): boolean {
  if (counter === undefined) return false
  if (!isIdentifiedAfter(counter.lastIdentifiedAt, divergedAt)) return false
  return counter.isConfirmed && counter.counter !== null
}

/**
 * The prediction stream one `actual_result_different` record diverged on: the
 * Normal Counter of a Normal Artian creation (`rngAdvance.affectedNormalCounterId`),
 * or the RNG Identification streams (Gogma / Skill) for every other operation.
 * A Normal creation Step naming no Counter, or a record whose Step is missing,
 * is its own stream that nothing resolves.
 */
type DivergenceStream =
  | { key: string; destination: 'normal_counters'; normalCounterId: string | null }
  | { key: 'rng'; destination: 'rng' }

function divergenceStream(step: PlanStep | undefined, history: ExecutionHistory): DivergenceStream {
  if (step === undefined) {
    return { key: `unresolvable:${history.id}`, destination: 'normal_counters', normalCounterId: null }
  }
  if (executionReidentificationDestination(step) === 'rng') return { key: 'rng', destination: 'rng' }
  const normalCounterId = step.rngAdvance.affectedNormalCounterId
  return normalCounterId === null
    ? { key: `unresolvable:${history.id}`, destination: 'normal_counters', normalCounterId: null }
    : { key: `normal:${normalCounterId}`, destination: 'normal_counters', normalCounterId }
}

/**
 * Derives the re-identification reminder of one Plan (16.15) from its
 * persisted ExecutionHistory and the current RngState / NormalArtianCounters.
 *
 * Every `actual_result_different` record of the Plan is grouped by the
 * prediction stream it diverged on, and the latest record of each stream (by
 * `compareExecutionHistoryOrder()`) is judged against that stream's
 * Identification provenance: the Normal Counter it names
 * (`isNormalCounterIdentifiedAfter()`) or the RngState
 * (`isRngIdentifiedAfter()`). A formal adoption after the latest record of a
 * stream also comes after every earlier record of the same stream, so the
 * earlier ones are resolved with it; a record of another stream is never
 * resolved by it. Under the current lifecycle one Plan holds at most one such
 * record - the record makes the Plan `stale` and no later Step is confirmed -
 * but nothing here relies on it.
 *
 * - Ending the Plan (abandonment, replan adoption, a breaking change) resolves
 *   nothing: the record stays and the reminder with it.
 * - A save point restore or an Undo that deleted the record resolves it, simply
 *   because the record no longer exists; no earlier state is remembered.
 * - An RNG Setup save that changed no adopted value (notes, Counter Gate) keeps
 *   an adoption; `RngState.updatedAt` alone never resolves anything.
 * - A manual / Debug save is never an Identification adoption.
 */
export function deriveExecutionReidentificationReminder(input: {
  plan: Pick<ProductionPlan, 'id' | 'steps'>
  planExecutionHistory: readonly ExecutionHistory[]
  rngState: Pick<RngState, 'baseSeed' | 'gogmaCounter' | 'skillCounter' | 'lastIdentifiedAt'> | null
  normalCounters: readonly Pick<NormalArtianCounter, 'id' | 'counter' | 'isConfirmed' | 'lastIdentifiedAt'>[]
}): ExecutionReidentificationReminder {
  const latestByStream = new Map<string, { stream: DivergenceStream; history: ExecutionHistory }>()
  input.planExecutionHistory
    .filter(({ planId, action }) => planId === input.plan.id && action === 'actual_result_different')
    .sort(compareExecutionHistoryOrder)
    .forEach((history) => {
      const step = input.plan.steps.find(({ id }) => id === history.planStepId)
      const stream = divergenceStream(step, history)
      latestByStream.set(stream.key, { stream, history })
    })
  const unresolved: UnresolvedActualResultDivergence[] = []
  for (const { stream, history } of latestByStream.values()) {
    if (stream.destination === 'rng') {
      if (isRngIdentifiedAfter(input.rngState, history.createdAt)) continue
      unresolved.push({ executionHistoryId: history.id, planStepId: history.planStepId, destination: 'rng' })
      continue
    }
    const counter = stream.normalCounterId === null
      ? undefined
      : input.normalCounters.find(({ id }) => id === stream.normalCounterId)
    if (isNormalCounterIdentifiedAfter(counter, history.createdAt)) continue
    unresolved.push({
      executionHistoryId: history.id,
      planStepId: history.planStepId,
      destination: 'normal_counters',
      normalCounterId: stream.normalCounterId,
    })
  }
  if (unresolved.length === 0) return { kind: 'none' }
  unresolved.sort((left, right) =>
    left.destination === right.destination
      ? streamKey(left).localeCompare(streamKey(right))
      : left.destination === 'normal_counters' ? -1 : 1)
  return { kind: 'actual_result_different', unresolved }
}

function streamKey(divergence: UnresolvedActualResultDivergence): string {
  return divergence.destination === 'rng' ? 'rng' : divergence.normalCounterId ?? `unresolvable:${divergence.executionHistoryId}`
}
