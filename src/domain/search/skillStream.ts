import type {
  GroupSkillId,
  OwnedWeaponId,
  RngState,
  RouteOperation,
  SeriesSkillId,
  SkillAmendmentResult,
  TargetWeapon,
} from '../models/publicTypes'
import type { RngEngine, SkillPredictionResult } from '../rng/rngEngine'
import {
  EMPTY_COUNTER_RESERVATION,
  nextOperationPositions,
  type CounterReservation,
} from './counterReservation'
import { hasConfirmedSkillInputs } from './searchRngInputs'
import type { SearchExecutionContext } from './searchExecution'
import type { SearchMasterSubset } from './searchTypes'

/**
 * The semantic Skill stream input plus one explicit depth bound.
 *
 * The stream needs the Skill RNG inputs, the Master subset, and how many Reset
 * Skills positions it may cover. It deliberately does not take a
 * `CandidateSearchInput`: `searchRunId`, the route/result filters, and the rest
 * of `CandidateSearchSettings` are not stream inputs, and the Planner-driven
 * constrained enumerator (SEARCH_SPEC 5.6.7) supplies its own bound from
 * `ConstrainedEnumerationBounds` rather than from `CandidateSearchSettings`.
 *
 * `maxSkillAdvance` keeps its SEARCH_SPEC 3.1 meaning: the maximum Reset Skills
 * count, not the number of covered Skill Counter positions.
 */
export interface SkillStreamInput {
  rngState: RngState
  master: SearchMasterSubset
  maxSkillAdvance: number
  /**
   * The Skill Counter reservation of Planner Alternative Search
   * (`docs/SEARCH_SPEC.md` 5.6.8). Only `readReservedDepth()` reads it; the
   * ordinary `readDepth()` / `solve()` never do. Absent means empty.
   */
  reservation?: CounterReservation
}

export interface SkillStreamStep {
  skillCounterBefore: number
  skillCounterAfter: number
  /**
   * The Skills this Reset Skills operation produces, i.e. the stream's own
   * memoized prediction at `skillCounterBefore`.
   *
   * Recorded while the step is generated, so it is the prediction this step
   * actually used rather than a later re-derivation. Observational only: no
   * retention key, ordering comparator, or Candidate identity reads it.
   */
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

/**
 * One Skill stream solution. `resetCount` is the Skill stream operation count
 * itself; `resetCount = 0` is the Route base's own current Skills and is never
 * part of a solved set because it is Route-base dependent, not stream data.
 */
export interface SkillStreamSolution {
  resetCount: number
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

/**
 * One held-aware Reset Skills solution (`docs/SEARCH_SPEC.md` 5.6.8): its own
 * Reset Skills operations at their absolute Skill positions, which need not be
 * consecutive, because a held position may pass without an own operation.
 * `resetCount` is the own operation count, `steps.length`.
 */
export interface ReservedSkillStreamSolution extends SkillStreamSolution {
  steps: readonly SkillStreamStep[]
}

export interface SkillStreamSolutionSet {
  startSkillCounter: number
  /** `steps[i]` is the (i + 1)-th Reset Skills operation of this stream. */
  steps: readonly SkillStreamStep[]
  /** Reset Skills solutions with `resetCount` 1 ... `maxSkillAdvance`. */
  solutions: readonly SkillStreamSolution[]
}

/**
 * The Skill stream of one TargetWeapon. The stream depends only on
 * `(TargetWeaponId, baseSeed, skillCounter)`, never on the Gogma state, the
 * source OwnedWeapon, or the Normal offset, so it is solved once per starting
 * Skill Counter and shared by every Route base.
 */
export interface TargetSkillStream {
  /** Confirmed Skill inputs plus Engine and input-level Skill prediction support. */
  isAvailable(): boolean
  /**
   * The memoized Skill prediction at one absolute Skill Counter position. Used
   * for the initial Skill assignment of `convert_normal_to_gogma`, which shares
   * the same positions as the Reset Skills solutions.
   */
  predictAt(skillCounter: number): SkillPredictionResult
  /**
   * `exhausted` means "read no further depth", and it mixes two reasons: the
   * stream has no further position, or `maxSkillAdvance` was reached. Only
   * `reachesBeyondExtent()` tells them apart.
   */
  readDepth(startSkillCounter: number, depth: number): Promise<SkillStreamSolutionSet & { exhausted: boolean }>
  /**
   * Whether this stream stopped at `maxSkillAdvance` with a further Reset
   * Skills position left unread (SEARCH_SPEC 5.6.8 stopped by extent). A Skill
   * stream is a linear scan with no natural end, so this is exactly "the
   * extent was read". It queries and predicts nothing.
   */
  reachesBeyondExtent(startSkillCounter: number): boolean
  /** Standalone full-prefix adapter; scheduling uses readDepth. */
  solve(startSkillCounter: number, through?: number): Promise<SkillStreamSolutionSet>
  /**
   * Planner Alternative Search only (`docs/SEARCH_SPEC.md` 5.6.8): the Reset
   * Skills solutions with exactly `depth` own operations over the Skill
   * reservation (see `createTargetSkillStream()` for the state rule).
   * `exhausted` means no state of this depth can place a further operation
   * inside the Skill window.
   */
  readReservedDepth(startSkillCounter: number, depth: number): Promise<{
    solutions: ReservedSkillStreamSolution[]
    exhausted: boolean
  }>
  /**
   * Whether the Skill window cut a reachable operation position of this
   * held-aware stream (SEARCH_SPEC 5.6.8 stopped by extent). It predicts nothing.
   */
  reservedReachesBeyondExtent(startSkillCounter: number): boolean
}

/**
 * The exclusive end of the Skill position window of one held-aware stream
 * (`docs/SEARCH_SPEC.md` 3.1 / 5.6.8), held positions included: an existing
 * Gogma's Reset Skills stand at `origin .. origin + M - 1`; a conversion Route's
 * stand after its conversion, at most at `origin + M`. A stream that starts at
 * the origin is an existing Gogma's, and any other stream starts right after a
 * conversion, which never stands before the origin.
 */
function reservedSkillPositionLimit(
  origin: number,
  startSkillCounter: number,
  maxSkillAdvance: number,
): number {
  return startSkillCounter === origin ? origin + maxSkillAdvance : origin + maxSkillAdvance + 1
}

/** One step of a held-aware Skill history, shared by every later state. */
interface ReservedSkillStepNode {
  readonly step: SkillStreamStep
  readonly previous: ReservedSkillStepNode | null
}

/** A held-aware Skill state: the position right after its last own operation. */
interface ReservedSkillState {
  /** The Skill Counter after the last own operation (the stream start at depth 0). */
  readonly nextFrom: number
  readonly node: ReservedSkillStepNode | null
}

function reservedSkillSteps(node: ReservedSkillStepNode | null): SkillStreamStep[] {
  const steps: SkillStreamStep[] = []
  for (let current = node; current !== null; current = current.previous) steps.push(current.step)
  return steps.reverse()
}

export function resetSkillsOperations(
  set: SkillStreamSolutionSet,
  resetCount: number,
  sourceOwnedWeaponId: OwnedWeaponId | null,
): RouteOperation[] {
  return set.steps.slice(0, resetCount).map((step) => ({
    type: 'reset_skills',
    sourceOwnedWeaponId,
    skillCounterBefore: step.skillCounterBefore,
    skillCounterAfter: step.skillCounterAfter,
  }))
}

/**
 * The predicted Skills produced by each Reset Skills of one solution, in
 * execution order and aligned index-for-index with `resetSkillsOperations()`.
 *
 * Both slice the same `set.steps` prefix, so entry `i` is always the result of
 * operation `i` of that same solution. The values come from the Skill stream's
 * own memoized prediction, so this adds no `predictSkills` call and no second
 * RNG implementation.
 */
export function skillAmendmentResults(
  set: SkillStreamSolutionSet,
  resetCount: number,
): SkillAmendmentResult[] {
  return set.steps.slice(0, resetCount).map((step) => ({
    seriesSkillId: step.seriesSkillId,
    groupSkillId: step.groupSkillId,
  }))
}

/**
 * One completed depth of one held-aware Skill stream
 * (`readReservedDepth()`), as aggregate counts only.
 *
 * Observation only (Planner Alternative Search Phase 3 benchmark,
 * `docs/PLANNER_ALTERNATIVE_BROWSER_WORKER_BENCHMARK.md`): it is reported after
 * the depth was generated and published, carries no state content, and no
 * search decision reads it back.
 */
export interface ReservedSkillDepthObservation {
  /** 0-based creation order of this held-aware stream inside the Skill stream. */
  streamIndex: number
  startSkillCounter: number
  /** Own Reset Skills operations of every state of this depth. */
  depth: number
  /** `(frontier state, legal position)` pairs visited, duplicates included. */
  transitions: number
  /** States published at this depth (one per absolute position). */
  states: number
  /** Distinct absolute positions of those states; equal to `states` by construction. */
  absolutePositions: number
}

export type ReservedSkillDepthObserver = (observation: ReservedSkillDepthObservation) => void

export function createTargetSkillStream(
  target: TargetWeapon,
  input: SkillStreamInput,
  engine: RngEngine,
  execution: SearchExecutionContext,
  isSkillPredictionSupported: () => boolean,
  /**
   * Execution-only observer of the held-aware depths (Planner Alternative
   * Search instrumentation). It never changes a prediction, a state, an order
   * or a termination; absent in every Production call.
   */
  observeReservedDepth?: ReservedSkillDepthObserver,
): TargetSkillStream {
  const predictions = new Map<number, SkillPredictionResult>()
  const sets = new Map<number, { steps: SkillStreamStep[]; solutions: SkillStreamSolution[]; counter: number }>()

  function predictAt(skillCounter: number): SkillPredictionResult {
    const cached = predictions.get(skillCounter)
    if (cached) return cached
    const predicted = engine.predictSkills({
      baseSeed: input.rngState.baseSeed.value as string,
      skillCounter,
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
      master: input.master,
    })
    predictions.set(skillCounter, predicted)
    return predicted
  }

  async function ensure(startSkillCounter: number, through: number) {
    const limit = Math.min(input.maxSkillAdvance, Math.max(0, through))
    let set = sets.get(startSkillCounter)
    if (!set) {
      set = { steps: [], solutions: [], counter: startSkillCounter }
      sets.set(startSkillCounter, set)
    }
    while (set.steps.length < limit) {
      await execution.checkpoint()
      const skillCounter = set.counter
      const skills = predictAt(skillCounter)
      const skillCounterAfter = engine.advanceSkillCounter(skillCounter, {
        type: 'reset_skills',
      })
      set.steps.push({
        skillCounterBefore: skillCounter,
        skillCounterAfter,
        seriesSkillId: skills.seriesSkillId,
        groupSkillId: skills.groupSkillId,
      })
      set.solutions.push({
        resetCount: set.steps.length,
        seriesSkillId: skills.seriesSkillId,
        groupSkillId: skills.groupSkillId,
      })
      set.counter = skillCounterAfter
    }
    return set
  }

  const reservation = input.reservation ?? EMPTY_COUNTER_RESERVATION
  interface ReservedSet {
    index: number
    depths: ReservedSkillState[][]
    frontier: ReservedSkillState[]
    done: boolean
    cutByExtent: boolean
    windows: Map<number, { positions: number[]; beyondLimit: boolean }>
  }
  const reservedSets = new Map<number, ReservedSet>()

  function reservedSet(startSkillCounter: number): ReservedSet {
    let set = reservedSets.get(startSkillCounter)
    if (!set) {
      set = {
        index: reservedSets.size,
        depths: [],
        frontier: [{ nextFrom: startSkillCounter, node: null }],
        done: false,
        cutByExtent: false,
        windows: new Map(),
      }
      reservedSets.set(startSkillCounter, set)
    }
    return set
  }

  /**
   * The legal next operation positions after one state, memoized per start
   * position because they depend on nothing else. Reaching the window end
   * records the extent cut: a Skill stream has no natural end.
   */
  async function reservedWindow(set: ReservedSet, from: number, limit: number) {
    let window = set.windows.get(from)
    if (!window) {
      window = await nextOperationPositions(reservation, from, limit, execution.checkpoint)
      set.windows.set(from, window)
    }
    if (window.beyondLimit) set.cutByExtent = true
    return window
  }

  /**
   * Held-aware Reset Skills states (`docs/SEARCH_SPEC.md` 5.6.8).
   *
   * A state is the position after its last own operation; its Skills are the
   * prediction at that operation's position, because Reset Skills reads
   * nothing it replaces. States of one own-operation count are keyed by that
   * position alone - two histories reaching it hold the same Skills and have
   * the same future - and the first one reached in ascending predecessor order
   * is kept. States of different operation counts are never merged. A held
   * position is skipped or operated on; a blocked one is only skipped.
   *
   * With no held position every state has exactly one next position, so this
   * is the ordinary linear scan: one state, one prediction and one checkpoint
   * per depth, the Skill window `start .. start + M - 1`.
   */
  async function ensureReserved(startSkillCounter: number, through: number): Promise<ReservedSet> {
    const set = reservedSet(startSkillCounter)
    const origin = input.rngState.skillCounter.value
    if (origin === null) {
      set.done = true
      return set
    }
    const limit = reservedSkillPositionLimit(origin, startSkillCounter, input.maxSkillAdvance)
    while (!set.done && set.depths.length < through) {
      const generated = new Map<number, ReservedSkillState>()
      let transitions = 0
      for (const state of set.frontier) {
        const { positions } = await reservedWindow(set, state.nextFrom, limit)
        transitions += positions.length
        for (const position of positions) {
          if (generated.has(position)) continue
          await execution.checkpoint()
          const skills = predictAt(position)
          const skillCounterAfter = engine.advanceSkillCounter(position, { type: 'reset_skills' })
          generated.set(position, {
            nextFrom: skillCounterAfter,
            node: {
              step: {
                skillCounterBefore: position,
                skillCounterAfter,
                seriesSkillId: skills.seriesSkillId,
                groupSkillId: skills.groupSkillId,
              },
              previous: state.node,
            },
          })
        }
      }
      if (generated.size === 0) {
        set.done = true
        break
      }
      set.frontier = [...generated.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, state]) => state)
      set.depths.push(set.frontier)
      observeReservedDepth?.({
        streamIndex: set.index,
        startSkillCounter,
        depth: set.depths.length,
        transitions,
        states: generated.size,
        absolutePositions: generated.size,
      })
    }
    return set
  }

  return {
    readReservedDepth: async (startSkillCounter, depth) => {
      const set = await ensureReserved(startSkillCounter, depth)
      const states = set.depths[depth - 1] ?? []
      const origin = input.rngState.skillCounter.value
      let exhausted = true
      if (!set.done && origin !== null) {
        const limit = reservedSkillPositionLimit(origin, startSkillCounter, input.maxSkillAdvance)
        for (const state of states) {
          if ((await reservedWindow(set, state.nextFrom, limit)).positions.length > 0) exhausted = false
        }
      }
      return {
        solutions: states.map((state) => {
          const steps = reservedSkillSteps(state.node)
          const last = steps[steps.length - 1]
          return {
            resetCount: steps.length,
            seriesSkillId: last.seriesSkillId,
            groupSkillId: last.groupSkillId,
            steps,
          }
        }),
        exhausted,
      }
    },
    reservedReachesBeyondExtent: (startSkillCounter) =>
      reservedSets.get(startSkillCounter)?.cutByExtent ?? false,
    isAvailable: () =>
      hasConfirmedSkillInputs(input) &&
      engine.capabilities.supportsSkillPrediction &&
      isSkillPredictionSupported(),
    predictAt,
    readDepth: async (startSkillCounter, depth) => {
      const set = await ensure(startSkillCounter, depth)
      return { startSkillCounter, steps: set.steps,
        solutions: set.solutions[depth - 1] ? [set.solutions[depth - 1]] : [],
        exhausted: depth >= input.maxSkillAdvance }
    },
    reachesBeyondExtent: (startSkillCounter) =>
      (sets.get(startSkillCounter)?.steps.length ?? 0) >= input.maxSkillAdvance,
    solve: async (startSkillCounter, through = input.maxSkillAdvance) => {
      const set = await ensure(startSkillCounter, through)
      const limit = Math.min(input.maxSkillAdvance, Math.max(0, through))
      return { startSkillCounter, steps: set.steps.slice(0, limit), solutions: set.solutions.slice(0, limit) }
    },
  }
}
