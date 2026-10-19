import type {
  BonusAmendmentResult,
  OwnedWeaponId,
  RestorationBonusScope,
  RestorationBonusSet,
  RngState,
  RouteOperation,
  TargetWeapon,
} from '../models/publicTypes'
import { stableStringify } from '../models/publicTypes'
import { keepFamilyLayoutKey, type KeepFamilyMasterSubset } from '../rng/gogmaBonusFamily'
import type { RngEngine, RngPredictionUnsupportedReason } from '../rng/rngEngine'
import {
  EMPTY_COUNTER_RESERVATION,
  nextOperationPositions,
  type CounterReservation,
} from './counterReservation'
import type { SearchExecutionContext } from './searchExecution'
import type { SearchPredictionSupport } from './searchPredictionSupport'
import type { SearchMasterSubset } from './searchTypes'
import { compareStableKeys } from './semanticKeys'

/**
 * The semantic Bonus stream input plus one explicit depth bound.
 *
 * As with `SkillStreamInput`, the stream takes only what it actually needs, so
 * the Planner-driven constrained enumerator (SEARCH_SPEC 5.6.7) can bound it
 * with `ConstrainedEnumerationBounds` instead of `CandidateSearchSettings`.
 *
 * `maxGogmaAdvance` keeps its SEARCH_SPEC 3.1 meaning: the number of Gogma
 * Counter positions covered, not the number of Engine calls.
 */
export interface BonusStreamInput {
  rngState: RngState
  master: SearchMasterSubset
  maxGogmaAdvance: number
  /**
   * The Gogma Counter reservation of Planner Alternative Search
   * (`docs/SEARCH_SPEC.md` 5.6.8). Only `readReservedDepth()` reads it; the
   * ordinary `readDepth()` / `solve()` never do. Absent means empty.
   */
  reservation?: CounterReservation
}

export interface BonusStreamStep {
  gogmaCounterBefore: number
  gogmaCounterAfter: number
}

/**
 * One Bonus stream solution.
 *
 * `depth` is the Bonus stream operation count itself: depth `d` is the `d`-th
 * amendment, performed at Gogma Counter `gogmaCounterBefore + d - 1`.
 * `depth = 0` is the Route base's own current bonuses and is never part of a
 * solved set, because it is Route-base data rather than stream data.
 *
 * `lastResetDepth` is `0` when the state was reached by Keep alone, and `r > 0`
 * when the depth-`r` Reset is its last Reset. Because Reset ignores the current
 * bonuses and Keep depends only on the slot family layout, `(depth,
 * lastResetDepth)` is enough to rebuild the canonical operation sequence.
 */
export interface BonusStreamSolution {
  depth: number
  lastResetDepth: number
  bonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  /**
   * The canonical amendment history of this solution, latest amendment first.
   *
   * Observational only: it records which predicted five slots the canonical
   * operation sequence passes through, and never takes part in retention,
   * ordering, frontier reduction, or any Candidate identity.
   */
  results: BonusAmendmentResultNode
}

/**
 * One node of the shared, immutable amendment history list.
 *
 * The list is persistent: a Keep state links to its own parent state's node and
 * a Reset state links to the previous depth's Reset node, so states share every
 * common prefix and the memory stays linear in the number of reached states.
 * Linking a Reset to the previous Reset is exactly the canonical history
 * `bonusAmendmentOperationType()` describes, because Reset discards the current
 * bonuses and therefore cannot depend on which branch preceded it.
 */
export interface BonusAmendmentResultNode {
  readonly depth: number
  readonly result: BonusAmendmentResult
  readonly previous: BonusAmendmentResultNode | null
}

/**
 * One held-aware Bonus solution (`docs/SEARCH_SPEC.md` 5.6.8): its own
 * amendment operations at their absolute Gogma positions, which need not be
 * consecutive, because a held position may pass without an own operation.
 * `steps.length === depth`, and the operation types still follow the canonical
 * `(depth, lastResetDepth)` rule, so `bonusAmendmentOperations()` rebuilds its
 * Route operations from `{ steps }` exactly as it does for a contiguous set.
 */
export interface ReservedBonusStreamSolution extends BonusStreamSolution {
  steps: readonly BonusStreamStep[]
}

export interface UnsupportedAmendmentPrediction {
  type: 'reset_bonuses' | 'keep_bonuses'
  reason: RngPredictionUnsupportedReason
}

export interface BonusStreamSolutionSet {
  startGogmaCounter: number
  /** `steps[i]` is the (i + 1)-th amendment operation of this stream. */
  steps: readonly BonusStreamStep[]
  /** Every reached Bonus state, before the family layout frontier reduction. */
  solutions: readonly BonusStreamSolution[]
  unsupportedPredictions: readonly UnsupportedAmendmentPrediction[]
}

/**
 * The Route base state the Bonus stream starts from.
 *
 * A base of either scope carries its five current slots whenever they are
 * known, because they are the explicit Keep prediction input: an owned Normal,
 * an owned `normal_artian` scope Gogma, and a predicted new Normal all know
 * their slots, so Keep is searched from the first depth. The slots are `null`
 * only when the Route base forged its Normal Artian blind and therefore knows
 * no five slots at all (`docs/SEARCH_SPEC.md` 6.1.1 / 5.9). No fabricated
 * bonus set is ever substituted.
 */
export type BonusStreamBase = {
  /** Initial Search only: later Normal representatives need no Reset branches. */
  amendmentPolicy?: 'all' | 'keep_only'
  /**
   * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): the Bonus operation kinds the
   * shape-constrained Route search allows on this lane. Only the held-aware
   * `readReservedDepth()` reads it; the ordinary `readDepth()` / `solve()` /
   * `reachesBeyondExtent()` refuse a base that carries it, and it never
   * combines with `amendmentPolicy`. Absent in every Production base.
   */
  shapePolicy?: BonusShapePolicy
} & (
  | {
      startGogmaCounter: number
      bonuses: RestorationBonusSet
      restorationBonusScope: 'gogma_artian'
    }
  | {
      startGogmaCounter: number
      bonuses: RestorationBonusSet | null
      restorationBonusScope: 'normal_artian'
    }
)

/**
 * The Bonus operation kinds of one shape-constrained Bonus lane
 * (`docs/SEARCH_SPEC.md` 5.6.9), each ending with its last own operation at
 * `finalPosition`:
 *
 * - `reset`: Reset Bonuses only
 * - `keep`: Keep Bonuses only, so every Keep reads the base's family layout
 * - `reset_then_keep`: Reset Bonuses at or before `resetPosition`, then Keep
 *   Bonuses only after the Reset at `resetPosition`
 *
 * A stream base carrying it generates only those operations, queries the
 * prediction support of those operations only where they can stand, places no
 * own operation after `finalPosition` and records no extent stop there.
 * Prediction, the held window, the frontier rule and the single-pass cursor are
 * the ordinary held-aware ones.
 */
export type BonusShapePolicy =
  | { kind: 'reset'; finalPosition: number }
  | { kind: 'keep'; finalPosition: number }
  | { kind: 'reset_then_keep'; resetPosition: number; finalPosition: number }

/**
 * Which operation a state of a shape-constrained lane may place next: Reset
 * before `resetPosition` (and on a `reset` lane), Keep from the Reset at
 * `resetPosition` on (and on a `keep` lane). A `reset_then_keep` lane places
 * Reset at or before `resetPosition` only, so a state at or after it is that
 * Reset or a Keep after it.
 */
function bonusShapeStage(shape: BonusShapePolicy, position: number): 'reset' | 'keep' {
  if (shape.kind === 'reset') return 'reset'
  if (shape.kind === 'keep') return 'keep'
  return position < shape.resetPosition ? 'reset' : 'keep'
}

/**
 * The Bonus stream of one TargetWeapon.
 *
 * Reset ignores the current bonuses, so it is predicted once per Gogma Counter
 * position. Keep preserves each slot's family and rerolls only the tier, so it
 * is predicted once per `(Gogma Counter, ordered family layout)`. Both memos
 * live on the Target, which keeps the prediction count independent of the
 * number of source weapons and Normal offsets.
 */
export interface TargetBonusStream {
  /**
   * `exhausted` means "read no further depth", and it mixes two reasons: the
   * stream ran out of generable states, or `maxGogmaAdvance` was reached. Only
   * `reachesBeyondExtent()` tells them apart.
   */
  readDepth(base: BonusStreamBase, depth: number): Promise<BonusStreamSolutionSet & { exhausted: boolean }>
  /**
   * Whether this stream stopped at `maxGogmaAdvance` while one more depth would
   * still generate a state (SEARCH_SPEC 5.6.8 stopped by extent), as opposed to
   * a natural end (no seed / capability, no generable amendment). It decides
   * from the prediction support of the frontier the stream already holds and
   * never predicts. Only Planner Alternative Search asks, so the ordinary Search
   * issues no additional support query.
   */
  reachesBeyondExtent(base: BonusStreamBase): boolean
  /** Standalone full-prefix adapter; scheduling uses readDepth. */
  solve(base: BonusStreamBase, through?: number): Promise<BonusStreamSolutionSet>
  /**
   * Planner Alternative Search only (`docs/SEARCH_SPEC.md` 5.6.8): every Bonus
   * state generated with exactly `depth` own amendments over the Gogma
   * reservation (see `createTargetBonusStream()` for the state rule).
   * `exhausted` means no state of this depth can place a further amendment
   * inside the Gogma window.
   *
   * Single-pass (SEARCH_SPEC 5.6.8): the stream identity is
   * `bonusStreamBaseKey(base, master)`, so two base objects with one key share
   * one cursor. The first legal read of a stream is depth 1, and each later
   * legal read is the depth right after the previous read. The returned raw
   * solutions are handed to the caller and never kept by the stream, so a
   * duplicate read, a backward read, a skip ahead, a read after a read that
   * returned `exhausted`, a read while another read of the same stream is in
   * flight, and any read after a failed read all throw instead of returning
   * `[]` or regenerating a past depth. Re-presenting a past Ideal position to a
   * later Route base is the scheduler's `BonusChannel.retained`, never a replay
   * of this stream. `reservedReachesBeyondExtent()` is not a depth read and may
   * be called after the terminal read.
   */
  readReservedDepth(base: BonusStreamBase, depth: number): Promise<{
    solutions: ReservedBonusStreamSolution[]
    unsupportedPredictions: readonly UnsupportedAmendmentPrediction[]
    exhausted: boolean
  }>
  /**
   * Whether the Gogma window cut a position where this held-aware stream would
   * still have generated a state (SEARCH_SPEC 5.6.8 stopped by extent), as
   * opposed to a natural end. It predicts nothing, reads no depth and does not
   * move the single-pass cursor, so it may be called after the terminal read.
   */
  reservedReachesBeyondExtent(base: BonusStreamBase): boolean
}

/**
 * A history node of the held-aware Bonus stream: the ordinary result node plus
 * the absolute Gogma positions of that amendment, so a state's operations are
 * rebuilt from its own history rather than from a shared contiguous step list.
 */
interface ReservedBonusResultNode extends BonusAmendmentResultNode {
  readonly step: BonusStreamStep
  readonly previous: ReservedBonusResultNode | null
}

function reservedBonusSteps(node: ReservedBonusResultNode | null): BonusStreamStep[] {
  const steps: BonusStreamStep[] = []
  for (let current = node; current !== null; current = current.previous) steps.push(current.step)
  return steps.reverse()
}

const EMPTY_SET = (startGogmaCounter: number): BonusStreamSolutionSet => ({
  startGogmaCounter,
  steps: [],
  solutions: [],
  unsupportedPredictions: [],
})

/** The canonical operation type of amendment `depth` for one solution. */
export function bonusAmendmentOperationType(
  solution: Pick<BonusStreamSolution, 'lastResetDepth'>,
  depth: number,
): 'reset_bonuses' | 'keep_bonuses' {
  return depth <= solution.lastResetDepth ? 'reset_bonuses' : 'keep_bonuses'
}

/**
 * Rebuilds the canonical amendment operation sequence of one solution.
 *
 * Depths `1 ... lastResetDepth` are Reset and the remaining depths are Keep.
 * That is exactly the history the frontier keeps as the representative: Reset
 * discards the current bonuses, so the depth-`r` Reset result is independent of
 * everything before it, and the following Keep chain is determined by the slot
 * family layout alone.
 */
export function bonusAmendmentOperations(
  set: BonusStreamSolutionSet,
  solution: BonusStreamSolution,
  sourceOwnedWeaponId: OwnedWeaponId | null,
): RouteOperation[] {
  return set.steps.slice(0, solution.depth).map((step, index) => ({
    type: bonusAmendmentOperationType(solution, index + 1),
    sourceOwnedWeaponId,
    gogmaCounterBefore: step.gogmaCounterBefore,
    gogmaCounterAfter: step.gogmaCounterAfter,
  }))
}

/**
 * The predicted five slots produced by each amendment of one solution, in
 * execution order and aligned index-for-index with
 * `bonusAmendmentOperations()`.
 *
 * The walk is the recorded canonical history, never a re-derivation from the
 * final result and never another solution that happens to sit at the same
 * depth, so entry `i` is the result of operation `i` of that same solution.
 */
export function bonusAmendmentResults(
  solution: BonusStreamSolution,
): BonusAmendmentResult[] {
  const results: BonusAmendmentResult[] = []
  let node: BonusAmendmentResultNode | null = solution.results
  for (let depth = solution.depth; depth >= 1; depth -= 1) {
    if (node === null || node.depth !== depth) {
      throw new Error(
        `Bonus amendment history is inconsistent at depth ${depth}.`,
      )
    }
    results.push(node.result)
    node = node.previous
  }
  if (node !== null) {
    throw new Error('Bonus amendment history is longer than its solution depth.')
  }
  return results.reverse()
}

interface BonusStateBase {
  depth: number
  lastResetDepth: number
  results: BonusAmendmentResultNode | null
}

/**
 * A state whose five slots are known. Its Keep family layout is defined
 * regardless of scope: a Normal-side bonus type is normalized to its Gogma
 * family through the Master mapping, so an inherited `normal_artian` base and
 * every Gogma-scope amendment result share one layout vocabulary.
 */
interface KnownBonusState extends BonusStateBase {
  scope: RestorationBonusScope
  bonuses: RestorationBonusSet
  familyLayoutKey: string
}

/**
 * Only a blind Route base (`docs/SEARCH_SPEC.md` 6.1.1) knows no five slots.
 * It has no family layout at all rather than a derived one, so nothing can be
 * Kept from it until the first Reset makes the slots known.
 */
interface UnknownBonusState extends BonusStateBase {
  scope: 'normal_artian'
  bonuses: null
  familyLayoutKey: null
}

type BonusState = KnownBonusState | UnknownBonusState

/**
 * A state produced by an amendment, so its history node always exists and its
 * scope is `gogma_artian`. Only a depth-0 Route base has `results = null`.
 */
interface GeneratedBonusState extends KnownBonusState {
  scope: 'gogma_artian'
  results: BonusAmendmentResultNode
}

/**
 * Same family layout means the same reachable Keep results at every later
 * position, so the frontier keeps one representative per layout. v1 prefers the
 * most recent Reset; the tie-break is a stable semantic key so the choice never
 * depends on generation, Map insertion, or Promise resolution order.
 */
function compareRepresentative(
  left: GeneratedBonusState,
  right: GeneratedBonusState,
): number {
  return (
    right.lastResetDepth - left.lastResetDepth ||
    compareStableKeys(stableStringify(left.bonuses), stableStringify(right.bonuses))
  )
}

/**
 * One completed depth of one held-aware Bonus stream (`readReservedDepth()`),
 * as aggregate counts only.
 *
 * Observation only (Planner Alternative Search Phase 3 benchmark,
 * `docs/PLANNER_ALTERNATIVE_BROWSER_WORKER_BENCHMARK.md`): it is reported after
 * the depth was generated, published and reduced, carries no state content,
 * and no search decision reads it back.
 */
export interface ReservedGogmaDepthObservation {
  /** 0-based creation order of this held-aware stream inside the Bonus stream. */
  streamIndex: number
  startGogmaCounter: number
  /** Own amendments of every state of this depth. */
  depth: number
  /** States generated and published at this depth, before the frontier reduction. */
  generatedStates: number
  /** Frontier states after the per-position family layout reduction. */
  frontierStates: number
  /** Distinct absolute positions (after the last own amendment) of the generated states. */
  absolutePositions: number
  /** Distinct Keep family layouts of the generated states. */
  familyLayouts: number
}

export type ReservedGogmaDepthObserver = (observation: ReservedGogmaDepthObservation) => void

/**
 * The mutually exclusive processing sections of one held-aware Bonus stream
 * depth (`readReservedDepth()`), in the order they run. Issue #154 Phase
 * 2-C2.6-A3 runtime localization only.
 */
export const RESERVED_GOGMA_RUNTIME_PHASES = [
  'window_collection',
  'support_evaluation',
  'state_generation',
  'solution_materialization',
  'frontier_reduction_sort',
  'exhaustion_scan',
] as const
export type ReservedGogmaRuntimePhase = typeof RESERVED_GOGMA_RUNTIME_PHASES[number]

/**
 * Counts the depth already holds at a boundary; `null` until the section that
 * produces the value has completed. Nothing is scanned to produce them.
 */
export interface ReservedGogmaRuntimeCounts {
  /** Frontier states the depth extends. */
  frontierStatesBefore: number
  /** Distinct legal next positions over that frontier. */
  legalPositionCount: number | null
  /** States generated (and published) at this depth. */
  generatedStates: number | null
  /** Frontier states after the reduction. */
  frontierStatesAfter: number | null
  /** Window memo entries of this stream at the boundary. */
  windowMemoEntries: number
}

interface ReservedGogmaRuntimeEventBase {
  /** 0-based creation order of this held-aware stream inside the Bonus stream. */
  streamIndex: number
  startGogmaCounter: number
  depth: number
  counts: ReservedGogmaRuntimeCounts
}

/**
 * One boundary of a held-aware Bonus stream depth. It carries no timestamp:
 * the stream reads no clock, and the observer stamps the boundary itself.
 */
export type ReservedGogmaRuntimeEvent =
  | ({ type: 'depth_started' } & ReservedGogmaRuntimeEventBase)
  | ({ type: 'phase_started'; phase: ReservedGogmaRuntimePhase } & ReservedGogmaRuntimeEventBase)
  | ({ type: 'phase_completed'; phase: ReservedGogmaRuntimePhase } & ReservedGogmaRuntimeEventBase)
  | ({ type: 'depth_completed'; exhausted: boolean } & ReservedGogmaRuntimeEventBase)

/**
 * Execution-only observer of the held-aware depth sections (Issue #154 Phase
 * 2-C2.6-A3). Called synchronously at each boundary, never awaited, its return
 * value never read; it changes no prediction, state, order or termination and
 * is absent in every Production call. A depth that throws reports no further
 * boundary.
 */
export type ReservedGogmaRuntimeObserver = (event: ReservedGogmaRuntimeEvent) => void

export function createTargetBonusStream(
  target: TargetWeapon,
  input: BonusStreamInput,
  engine: RngEngine,
  execution: SearchExecutionContext,
  predictionSupport: SearchPredictionSupport,
  /**
   * Execution-only observer of the held-aware depths (Planner Alternative
   * Search instrumentation). It never changes a prediction, a state, an order
   * or a termination; absent in every Production call.
   */
  observeReservedDepth?: ReservedGogmaDepthObserver,
  /**
   * Execution-only observer of the held-aware depth sections (Issue #154
   * Phase 2-C2.6-A3 runtime localization). Boundaries only, no clock, no
   * extra scan; absent in every Production call.
   */
  observeReservedRuntime?: ReservedGogmaRuntimeObserver,
): TargetBonusStream {
  const resetPredictions = new Map<number, RestorationBonusSet>()
  /** Keep memo: Gogma Counter -> ordered family layout key -> prediction. */
  const keepPredictions = new Map<number, Map<string, RestorationBonusSet>>()
  const sets = new Map<string, {
    iterator: AsyncGenerator<BonusStreamSolutionSet, BonusStreamSolutionSet>
    value: BonusStreamSolutionSet
    done: boolean
    depths: BonusStreamSolution[][]
    /** The reduced frontier after the last generated depth. */
    frontier: { current: readonly BonusState[] }
  }>()

  function predictReset(gogmaCounter: number): RestorationBonusSet {
    const cached = resetPredictions.get(gogmaCounter)
    if (cached) return cached
    const predicted = engine.predictGogmaBonus({
      baseSeed: input.rngState.baseSeed.value as string,
      gogmaCounter,
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
      operation: { type: 'reset_bonuses' },
      master: input.master,
    })
    resetPredictions.set(gogmaCounter, predicted)
    return predicted
  }

  /**
   * Keep depends on the current slots only through their families, so states
   * that share a layout share this prediction. The representative's five slots
   * are the explicit Engine input; a tier difference never adds a call. The
   * memo is keyed by the `(gogmaCounter, familyLayoutKey)` pair as two nested
   * Maps, so a lookup builds no composite string key.
   */
  function predictKeep(
    gogmaCounter: number,
    familyLayoutKey: string,
    currentBonuses: RestorationBonusSet,
  ): RestorationBonusSet {
    const byFamilyLayout = keepPredictions.get(gogmaCounter)
    const cached = byFamilyLayout?.get(familyLayoutKey)
    if (cached) return cached
    const predicted = engine.predictGogmaBonus({
      baseSeed: input.rngState.baseSeed.value as string,
      gogmaCounter,
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
      operation: { type: 'keep_bonuses', currentBonuses },
      master: input.master,
    })
    if (byFamilyLayout) byFamilyLayout.set(familyLayoutKey, predicted)
    else keepPredictions.set(gogmaCounter, new Map([[familyLayoutKey, predicted]]))
    return predicted
  }

  function toState(
    depth: number,
    lastResetDepth: number,
    bonuses: RestorationBonusSet,
    previous: BonusAmendmentResultNode | null,
  ): GeneratedBonusState {
    return {
      depth,
      lastResetDepth,
      bonuses,
      scope: 'gogma_artian',
      familyLayoutKey: keepFamilyLayoutKey(bonuses, input.master),
      results: {
        depth,
        result: { restorationBonuses: bonuses, restorationBonusScope: 'gogma_artian' },
        previous,
      },
    }
  }

  async function* build(
    base: BonusStreamBase,
    published: { current: readonly BonusState[] },
  ): AsyncGenerator<BonusStreamSolutionSet, BonusStreamSolutionSet> {
    if (
      input.rngState.baseSeed.value === null ||
      !engine.capabilities.supportsGogmaPrediction
    ) {
      return EMPTY_SET(base.startGogmaCounter)
    }
    const steps: BonusStreamStep[] = []
    const solutions: BonusStreamSolution[] = []
    const unsupported = new Map<string, UnsupportedAmendmentPrediction>()
    const recordUnsupported = (
      type: UnsupportedAmendmentPrediction['type'],
      reason: RngPredictionUnsupportedReason,
    ) => unsupported.set(`${type}\u0000${reason}`, { type, reason })

    // Known five slots of either scope get their Keep family layout from the
    // shared resolver (Normal-side types through the Master mapping). Only a
    // blind base has none, so only it cannot be Kept before its first Reset.
    let frontier: BonusState[] = [
      base.bonuses === null
        ? {
            depth: 0,
            lastResetDepth: 0,
            bonuses: null,
            scope: 'normal_artian',
            familyLayoutKey: null,
            results: null,
          }
        : {
            depth: 0,
            lastResetDepth: 0,
            bonuses: base.bonuses,
            scope: base.restorationBonusScope,
            familyLayoutKey: keepFamilyLayoutKey(base.bonuses, input.master),
            results: null,
          },
    ]
    let gogmaCounterBefore = base.startGogmaCounter
    // The canonical Reset prefix: the depth-`d` Reset extends the depth-(d-1)
    // Reset, because Reset never reads the bonuses it replaces.
    let lastResetNode: BonusAmendmentResultNode | null = null

    for (let depth = 1; depth <= input.maxGogmaAdvance; depth += 1) {
      if (frontier.length === 0) break
      const generated: GeneratedBonusState[] = []
      let gogmaCounterAfter: number | null = null

      const resetSupport = predictionSupport.gogmaReset()
      if (resetSupport.supported && base.amendmentPolicy !== 'keep_only') {
        await execution.checkpoint()
        const reset = toState(depth, depth, predictReset(gogmaCounterBefore), lastResetNode)
        generated.push(reset)
        lastResetNode = reset.results
        gogmaCounterAfter = engine.advanceGogmaCounter(gogmaCounterBefore, {
          type: 'reset_bonuses',
        })
      } else if (!resetSupport.supported) {
        recordUnsupported('reset_bonuses', resetSupport.reason)
      }

      if (engine.capabilities.supportsKeepBonusesPrediction) {
        for (const state of frontier) {
          // A blind base knows no five slots, so nothing can be Kept from it
          // until the first Reset makes them known (SEARCH_SPEC 6.1.1). That is
          // an unknown-input case, not a prediction-support gap and not a game
          // rule: a known `normal_artian` state is Kept like any other. The
          // discriminant also narrows `familyLayoutKey` to `string`.
          if (state.bonuses === null) continue
          const keepSupport = predictionSupport.gogmaKeep(state.bonuses)
          if (!keepSupport.supported) {
            recordUnsupported('keep_bonuses', keepSupport.reason)
            continue
          }
          await execution.checkpoint()
          generated.push(toState(
            depth,
            state.lastResetDepth,
            predictKeep(gogmaCounterBefore, state.familyLayoutKey, state.bonuses),
            state.results,
          ))
          gogmaCounterAfter ??= engine.advanceGogmaCounter(gogmaCounterBefore, {
            type: 'keep_bonuses',
          })
        }
      }

      if (generated.length === 0 || gogmaCounterAfter === null) break
      // The generated outcomes are published before the frontier reduction, so
      // folding a layout never drops a Candidate reached at this depth.
      steps.push({ gogmaCounterBefore, gogmaCounterAfter })
      solutions.push(...generated.map(({ depth: solutionDepth, lastResetDepth, bonuses, scope, results }) => ({
        depth: solutionDepth,
        lastResetDepth,
        bonuses,
        restorationBonusScope: scope,
        results,
      })))

      const byLayout = new Map<string, GeneratedBonusState>()
      for (const state of generated) {
        const current = byLayout.get(state.familyLayoutKey)
        if (!current || compareRepresentative(state, current) < 0) {
          byLayout.set(state.familyLayoutKey, state)
        }
      }
      frontier = [...byLayout.values()].sort((left, right) =>
        compareStableKeys(left.familyLayoutKey, right.familyLayoutKey),
      )
      gogmaCounterBefore = gogmaCounterAfter
      published.current = frontier
      // Suspend with the frontier intact after one complete depth.
      yield {
        startGogmaCounter: base.startGogmaCounter,
        steps, solutions, unsupportedPredictions: [...unsupported.values()],
      }
    }

    return {
      startGogmaCounter: base.startGogmaCounter,
      steps,
      solutions,
      unsupportedPredictions: [...unsupported.values()],
    }
  }

  const reservation = input.reservation ?? EMPTY_COUNTER_RESERVATION

  /** A held-aware Bonus state (`docs/SEARCH_SPEC.md` 5.6.8). */
  interface ReservedBonusState {
    depth: number
    lastResetDepth: number
    bonuses: RestorationBonusSet | null
    scope: RestorationBonusScope
    familyLayoutKey: string | null
    results: ReservedBonusResultNode | null
    /** The position of the last own amendment; `start - 1` for the Route base. */
    position: number
    /** The Gogma Counter right after the last own amendment (the start for the base). */
    nextFrom: number
  }
  /**
   * One held-aware stream. It keeps no raw solution of a depth it already
   * returned (single-pass, SEARCH_SPEC 5.6.8): only the cursor, the reduced
   * frontier (whose result history chains the next depth extends), the
   * termination and extent flags, the unsupported notices and the window memo.
   */
  interface ReservedSet {
    index: number
    /** The one depth the next `readReservedDepth()` of this stream may read. */
    nextDepth: number
    /** Set once a read returned `exhausted` or failed: no further depth may be read. */
    closedBy: 'exhausted' | 'failed' | null
    /** A read of this stream is in flight. */
    reading: boolean
    frontier: ReservedBonusState[]
    done: boolean
    cutByExtent: boolean
    unsupported: Map<string, UnsupportedAmendmentPrediction>
    windows: Map<number, { positions: number[]; beyondLimit: boolean }>
  }
  const reservedSets = new Map<string, ReservedSet>()

  /**
   * `stableStringify(bonuses)` of a held-aware state, computed lazily and kept
   * per five-slot object (Issue #154 Phase 2-C2.6-A9). Generated states hold the
   * Reset / Keep prediction objects of the memos above, which nothing mutates,
   * so many states share one object and its serialization is computed once.
   * The value is the unchanged `stableStringify()` text itself (never a hash),
   * and the WeakMap holds no five-slot object alive.
   */
  const reservedBonusStableKeys = new WeakMap<RestorationBonusSet, string>()

  function reservedBonusStableKey(bonuses: RestorationBonusSet | null): string {
    if (bonuses === null) return stableStringify(null)
    const cached = reservedBonusStableKeys.get(bonuses)
    if (cached !== undefined) return cached
    const key = stableStringify(bonuses)
    reservedBonusStableKeys.set(bonuses, key)
    return key
  }

  /** The B2 representative rule of `compareRepresentative()`, for held-aware states. */
  function compareReservedRepresentative(left: ReservedBonusState, right: ReservedBonusState): number {
    return (
      right.lastResetDepth - left.lastResetDepth ||
      compareStableKeys(reservedBonusStableKey(left.bonuses), reservedBonusStableKey(right.bonuses))
    )
  }

  function compareReservedFrontier(left: ReservedBonusState, right: ReservedBonusState): number {
    return left.position - right.position ||
      compareStableKeys(left.familyLayoutKey ?? '', right.familyLayoutKey ?? '')
  }

  function reservedSet(base: BonusStreamBase): ReservedSet {
    const key = bonusStreamBaseKey(base, input.master)
    let set = reservedSets.get(key)
    if (!set) {
      set = {
        index: reservedSets.size,
        nextDepth: 1,
        closedBy: null,
        reading: false,
        frontier: [{
          depth: 0,
          lastResetDepth: 0,
          bonuses: base.bonuses,
          scope: base.restorationBonusScope,
          familyLayoutKey: base.bonuses === null ? null : keepFamilyLayoutKey(base.bonuses, input.master),
          results: null,
          position: base.startGogmaCounter - 1,
          nextFrom: base.startGogmaCounter,
        }],
        done: input.rngState.baseSeed.value === null || !engine.capabilities.supportsGogmaPrediction,
        cutByExtent: false,
        unsupported: new Map(),
        windows: new Map(),
      }
      reservedSets.set(key, set)
    }
    return set
  }

  function recordReservedUnsupported(
    set: ReservedSet,
    type: UnsupportedAmendmentPrediction['type'],
    reason: RngPredictionUnsupportedReason,
  ): void {
    set.unsupported.set(`${type}\u0000${reason}`, { type, reason })
  }

  /**
   * The legal next amendment positions after one state, memoized per start
   * position. A window the Gogma extent cuts records the extent stop only when
   * one more amendment would really be generated there - the same generation
   * conditions the next depth applies - so a natural end never counts.
   */
  async function reservedWindow(
    set: ReservedSet,
    base: BonusStreamBase,
    state: ReservedBonusState,
  ) {
    const limit = base.startGogmaCounter + input.maxGogmaAdvance
    let window = set.windows.get(state.nextFrom)
    if (!window) {
      window = await nextOperationPositions(reservation, state.nextFrom, limit, execution.checkpoint)
      set.windows.set(state.nextFrom, window)
    }
    if (window.beyondLimit && !set.cutByExtent) {
      const resetGenerates = base.amendmentPolicy !== 'keep_only' && predictionSupport.gogmaReset().supported
      const keepGenerates = engine.capabilities.supportsKeepBonusesPrediction &&
        state.bonuses !== null && predictionSupport.gogmaKeep(state.bonuses).supported
      if (resetGenerates || keepGenerates) set.cutByExtent = true
    }
    return window
  }

  /**
   * The held-aware Bonus states of one depth (`docs/SEARCH_SPEC.md` 5.6.8),
   * where the depth is the own amendment count. `readReservedDepth()` calls it
   * once per depth, in order; it extends only the reduced frontier and returns
   * the depth's raw solutions without keeping them.
   *
   * From each state the next amendment may stand at any legal position of its
   * window (`nextOperationPositions()`): a held position is skipped or used, a
   * blocked one only skipped, and the Bonus state is unchanged while it waits.
   * At each position the depth generates one Reset - the prediction at that
   * position, whose canonical history is the Reset chain of a depth-(d - 1)
   * Reset state reaching the position, because Reset reads nothing it replaces
   * - and one Keep per frontier state that reaches it, from the same
   * `(position, family layout)` memo the ordinary stream uses. Every generated
   * state is published before the frontier reduction.
   *
   * The B2 family-layout frontier is kept per absolute position: states of one
   * depth are merged only when they share both the position after their last
   * amendment and the family layout, which gives them the same future, and the
   * representative is the ordinary `compareRepresentative()` choice. States at
   * different positions, or of different depths, are never merged.
   *
   * With no held position every state stands at the same position, so this is
   * the ordinary stream: one Reset and one Keep per surviving layout per depth,
   * in the same order, over the window `start .. start + maxGogmaAdvance - 1`.
   */
  async function generateReservedDepth(
    set: ReservedSet,
    base: BonusStreamBase,
    depth: number,
    runtime: ReservedRuntimeBoundaries | undefined,
  ): Promise<ReservedBonusStreamSolution[]> {
    if (set.done) return []
    runtime?.phase('phase_started', 'window_collection')
    const windows: Array<ReadonlySet<number>> = []
    const positions = new Set<number>()
    for (const state of set.frontier) {
      const window = await reservedWindow(set, base, state)
      windows.push(new Set(window.positions))
      window.positions.forEach((position) => positions.add(position))
    }
    if (runtime !== undefined) {
      runtime.counts.legalPositionCount = positions.size
      runtime.phase('phase_completed', 'window_collection')
      runtime.phase('phase_started', 'support_evaluation')
    }
    const resetSupport = predictionSupport.gogmaReset()
    const resetAllowed = resetSupport.supported && base.amendmentPolicy !== 'keep_only'
    if (!resetSupport.supported) recordReservedUnsupported(set, 'reset_bonuses', resetSupport.reason)
    const keepCapable = engine.capabilities.supportsKeepBonusesPrediction
    const keepSupported = set.frontier.map((state, index) => {
      if (!keepCapable || state.bonuses === null || windows[index].size === 0) return false
      const support = predictionSupport.gogmaKeep(state.bonuses)
      if (!support.supported) recordReservedUnsupported(set, 'keep_bonuses', support.reason)
      return support.supported
    })
    if (runtime !== undefined) {
      runtime.phase('phase_completed', 'support_evaluation')
      runtime.phase('phase_started', 'state_generation')
    }

    const generated: ReservedBonusState[] = []
    for (const position of [...positions].sort((left, right) => left - right)) {
      if (resetAllowed) {
        const parent = depth === 1
          ? null
          : set.frontier.find((state, index) =>
            state.lastResetDepth === depth - 1 && state.depth === depth - 1 && windows[index].has(position))
        if (parent === undefined) {
          throw new Error(`Held-aware Bonus stream has no Reset chain reaching Gogma ${position} at depth ${depth}.`)
        }
        await execution.checkpoint()
        const bonuses = predictReset(position)
        const gogmaCounterAfter = engine.advanceGogmaCounter(position, { type: 'reset_bonuses' })
        generated.push(reservedGeneratedState(depth, depth, bonuses, keepFamilyLayoutKey(bonuses, input.master), parent?.results ?? null, position, gogmaCounterAfter))
      }
      for (const [index, state] of set.frontier.entries()) {
        if (!keepSupported[index] || !windows[index].has(position) || state.bonuses === null || state.familyLayoutKey === null) continue
        await execution.checkpoint()
        const bonuses = predictKeep(position, state.familyLayoutKey, state.bonuses)
        const gogmaCounterAfter = engine.advanceGogmaCounter(position, { type: 'keep_bonuses' })
        // Keep preserves the family of every slot (RNG_SPEC 6.1), so the result
        // has the parent's ordered family layout; it is reused, not recomputed.
        generated.push(reservedGeneratedState(depth, state.lastResetDepth, bonuses, state.familyLayoutKey, state.results, position, gogmaCounterAfter))
      }
    }
    if (runtime !== undefined) {
      runtime.counts.generatedStates = generated.length
      runtime.phase('phase_completed', 'state_generation')
    }
    if (generated.length === 0) {
      set.done = true
      return []
    }
    runtime?.phase('phase_started', 'solution_materialization')
    // Handed to the caller only; the stream keeps no reference to them.
    const solutions: ReservedBonusStreamSolution[] = generated.map((state) => ({
      depth: state.depth,
      lastResetDepth: state.lastResetDepth,
      bonuses: state.bonuses as RestorationBonusSet,
      restorationBonusScope: 'gogma_artian',
      results: state.results as ReservedBonusResultNode,
      steps: reservedBonusSteps(state.results),
    }))
    if (runtime !== undefined) {
      runtime.phase('phase_completed', 'solution_materialization')
      runtime.phase('phase_started', 'frontier_reduction_sort')
    }
    const byKey = new Map<string, ReservedBonusState>()
    for (const state of generated) {
      const key = `${state.position}\u0000${state.familyLayoutKey}`
      const current = byKey.get(key)
      if (!current || compareReservedRepresentative(state, current) < 0) byKey.set(key, state)
    }
    set.frontier = [...byKey.values()].sort(compareReservedFrontier)
    if (runtime !== undefined) {
      runtime.counts.frontierStatesAfter = set.frontier.length
      runtime.phase('phase_completed', 'frontier_reduction_sort')
    }
    if (observeReservedDepth !== undefined) {
      observeReservedDepth({
        streamIndex: set.index,
        startGogmaCounter: base.startGogmaCounter,
        depth,
        generatedStates: generated.length,
        frontierStates: set.frontier.length,
        absolutePositions: new Set(generated.map((state) => state.position)).size,
        familyLayouts: new Set(generated.map((state) => state.familyLayoutKey)).size,
      })
    }
    return solutions
  }

  /**
   * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): the shape-constrained lane's
   * next own Bonus positions after one state, by operation. The held window is
   * the ordinary `nextOperationPositions()` walk, cut right after
   * `finalPosition`: that cut is the shape's own end, never an extent stop, so
   * it is not recorded as one and reads no prediction support.
   */
  async function shapeOperationPositions(
    set: ReservedSet,
    shape: BonusShapePolicy,
    state: ReservedBonusState,
  ): Promise<{ reset: number[]; keep: number[] }> {
    let window = set.windows.get(state.nextFrom)
    if (!window) {
      window = await nextOperationPositions(reservation, state.nextFrom, shape.finalPosition + 1, execution.checkpoint)
      set.windows.set(state.nextFrom, window)
    }
    if (bonusShapeStage(shape, state.position) === 'keep') {
      return { reset: [], keep: state.bonuses === null ? [] : window.positions }
    }
    const resetLimit = shape.kind === 'reset_then_keep' ? shape.resetPosition : shape.finalPosition
    return { reset: window.positions.filter((position) => position <= resetLimit), keep: [] }
  }

  /**
   * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): one depth of a
   * shape-constrained held-aware Bonus stream base (`BonusStreamBase.shapePolicy`).
   *
   * It is the held-aware depth of `generateReservedDepth()` restricted to the
   * shape's operations: the same windows (cut at `finalPosition`), the same
   * Reset / Keep prediction memos and generated-state constructor, the same
   * generation order (per position, the Reset first, then each frontier
   * state's Keep in frontier order) and the same frontier rule - one
   * representative per (absolute position, Keep family layout) by
   * `compareReservedRepresentative()`, the frontier in `compareReservedFrontier()`
   * order. It differs only in what the shape forbids:
   *
   * - a Reset stands only where the shape's Reset stage allows it, and the
   *   Reset chain invariant is applied only there
   * - a Keep is generated only from a Keep-stage state (every state of a `keep`
   *   lane; on a `reset_then_keep` lane only the Reset at `resetPosition` and
   *   the Keeps after it), so a Keep never reads another history's layout and
   *   the frontier never folds the shape's history into another one
   * - Reset Bonuses support is queried only for a depth with a Reset position,
   *   and Keep Bonuses support only for a Keep-stage state with a Keep
   *   position, so an operation the shape forbids is never evaluated and never
   *   reported as unsupported
   *
   * It reports the held-aware depth observation but no runtime phase sections.
   */
  async function generateShapeReservedDepth(
    set: ReservedSet,
    shape: BonusShapePolicy,
    base: BonusStreamBase,
    depth: number,
  ): Promise<ReservedBonusStreamSolution[]> {
    if (set.done) return []
    const resetPositions: Array<ReadonlySet<number>> = []
    const keepPositions: Array<ReadonlySet<number>> = []
    const positions = new Set<number>()
    for (const state of set.frontier) {
      const next = await shapeOperationPositions(set, shape, state)
      resetPositions.push(new Set(next.reset))
      keepPositions.push(new Set(next.keep))
      for (const position of [...next.reset, ...next.keep]) positions.add(position)
    }
    let resetAllowed = false
    if (resetPositions.some((window) => window.size > 0)) {
      const support = predictionSupport.gogmaReset()
      resetAllowed = support.supported
      if (!support.supported) recordReservedUnsupported(set, 'reset_bonuses', support.reason)
    }
    const keepAllowed = set.frontier.map((state, index) => {
      if (keepPositions[index].size === 0 || state.bonuses === null || !engine.capabilities.supportsKeepBonusesPrediction) return false
      const support = predictionSupport.gogmaKeep(state.bonuses)
      if (!support.supported) recordReservedUnsupported(set, 'keep_bonuses', support.reason)
      return support.supported
    })

    // The Production generated-state constructor and frontier comparator, taken by reference rather than
    // re-spelled: the Issue #154 source-shape tests pin their Production call sites (B2J / A8 / A9).
    const generatedState = reservedGeneratedState
    const produced: ReservedBonusState[] = []
    for (const position of [...positions].sort((left, right) => left - right)) {
      if (resetAllowed && resetPositions.some((window) => window.has(position))) {
        const chain = depth === 1
          ? null
          : set.frontier.find((state, index) =>
            state.lastResetDepth === depth - 1 && state.depth === depth - 1 && resetPositions[index].has(position))
        if (chain === undefined) {
          throw new Error(`Shape-constrained Bonus stream has no Reset chain reaching Gogma ${position} at depth ${depth}.`)
        }
        await execution.checkpoint()
        const result = predictReset(position)
        produced.push(generatedState(depth, depth, result, keepFamilyLayoutKey(result, input.master),
          chain?.results ?? null, position, engine.advanceGogmaCounter(position, { type: 'reset_bonuses' })))
      }
      for (const [index, state] of set.frontier.entries()) {
        if (!keepAllowed[index] || !keepPositions[index].has(position) || state.bonuses === null || state.familyLayoutKey === null) continue
        await execution.checkpoint()
        const result = predictKeep(position, state.familyLayoutKey, state.bonuses)
        // Keep preserves the family of every slot (RNG_SPEC 6.1): the parent's layout key is reused.
        produced.push(generatedState(depth, state.lastResetDepth, result, state.familyLayoutKey,
          state.results, position, engine.advanceGogmaCounter(position, { type: 'keep_bonuses' })))
      }
    }
    if (produced.length === 0) {
      set.done = true
      return []
    }
    // Handed to the caller only, before the frontier reduction, exactly as the Production depth does.
    const solutions: ReservedBonusStreamSolution[] = produced.map((state) => ({
      depth: state.depth,
      lastResetDepth: state.lastResetDepth,
      bonuses: state.bonuses as RestorationBonusSet,
      restorationBonusScope: 'gogma_artian',
      results: state.results as ReservedBonusResultNode,
      steps: reservedBonusSteps(state.results),
    }))
    // The Production frontier rule itself, by reference (see `generatedState` above).
    const representativeOrder = compareReservedRepresentative
    const representatives = new Map<string, ReservedBonusState>()
    for (const state of produced) {
      const slot = `${state.position}\u0000${state.familyLayoutKey}`
      const kept = representatives.get(slot)
      if (kept === undefined || representativeOrder(state, kept) < 0) representatives.set(slot, state)
    }
    set.frontier = [...representatives.values()].sort(compareReservedFrontier)
    if (observeReservedDepth !== undefined) {
      observeReservedDepth({
        streamIndex: set.index,
        startGogmaCounter: base.startGogmaCounter,
        depth,
        generatedStates: produced.length,
        frontierStates: set.frontier.length,
        absolutePositions: new Set(produced.map((state) => state.position)).size,
        familyLayouts: new Set(produced.map((state) => state.familyLayoutKey)).size,
      })
    }
    return solutions
  }

  /** Shape-constrained Route search only (5.6.9): whether any frontier state of a shape-constrained stream can place a further own operation. */
  async function shapeStreamContinues(set: ReservedSet, shape: BonusShapePolicy): Promise<boolean> {
    let continues = false
    for (const state of set.frontier) {
      const next = await shapeOperationPositions(set, shape, state)
      if (next.reset.length > 0 || next.keep.length > 0) continues = true
    }
    return continues
  }

  /**
   * Fails closed on a `shapePolicy` the held-aware stream cannot read
   * (`docs/SEARCH_SPEC.md` 5.6.9): combined with `amendmentPolicy`, a position
   * outside the Gogma window `start .. start + maxGogmaAdvance - 1`, a Reset
   * position not before the final position, or a Keep-only lane from unknown
   * five slots.
   */
  function assertBonusShapePolicy(base: BonusStreamBase, shape: BonusShapePolicy): void {
    const fail = (message: string): never => {
      throw new Error(`Invalid Bonus shapePolicy for ${bonusStreamBaseKey(base, input.master)}: ${message}`)
    }
    if (base.amendmentPolicy !== undefined) fail('it never combines with amendmentPolicy.')
    if (shape.kind !== 'reset' && shape.kind !== 'keep' && shape.kind !== 'reset_then_keep') fail('unknown kind.')
    const limit = base.startGogmaCounter + input.maxGogmaAdvance
    const positions = shape.kind === 'reset_then_keep' ? [shape.resetPosition, shape.finalPosition] : [shape.finalPosition]
    if (positions.some((position) => !Number.isInteger(position) || position < base.startGogmaCounter || position >= limit)) {
      fail(`its positions must lie in the Gogma window ${base.startGogmaCounter} .. ${limit - 1}.`)
    }
    if (shape.kind === 'reset_then_keep' && shape.resetPosition >= shape.finalPosition) fail('resetPosition must precede finalPosition.')
    if (shape.kind === 'keep' && base.bonuses === null) fail('a Keep-only lane needs known current five slots.')
  }

  /** The ordinary stream reads no shape-constrained base (5.6.9): it is held-aware only. */
  function refuseShapePolicy(base: BonusStreamBase, api: string): void {
    if (base.shapePolicy !== undefined) {
      throw new Error(`The ordinary Bonus stream ${api}() never reads a shape-constrained base (shapePolicy is read by readReservedDepth() only).`)
    }
  }

  /** The boundary reporter of one observed depth read (Issue #154 Phase 2-C2.6-A3). */
  interface ReservedRuntimeBoundaries {
    readonly counts: ReservedGogmaRuntimeCounts
    phase(type: 'phase_started' | 'phase_completed', phase: ReservedGogmaRuntimePhase): void
    depth(type: 'depth_started'): void
    depth(type: 'depth_completed', exhausted: boolean): void
  }

  function reservedRuntimeBoundaries(
    observer: ReservedGogmaRuntimeObserver,
    set: ReservedSet,
    base: BonusStreamBase,
    depth: number,
  ): ReservedRuntimeBoundaries {
    const counts: ReservedGogmaRuntimeCounts = {
      frontierStatesBefore: set.frontier.length,
      legalPositionCount: null,
      generatedStates: null,
      frontierStatesAfter: null,
      windowMemoEntries: set.windows.size,
    }
    const snapshot = () => {
      counts.windowMemoEntries = set.windows.size
      return { streamIndex: set.index, startGogmaCounter: base.startGogmaCounter, depth, counts: { ...counts } }
    }
    return {
      counts,
      phase: (type, phase) => observer({ type, phase, ...snapshot() }),
      depth: (type: 'depth_started' | 'depth_completed', exhausted?: boolean) => observer(type === 'depth_started'
        ? { type, ...snapshot() }
        : { type, exhausted: exhausted as boolean, ...snapshot() }),
    }
  }

  /**
   * The single-pass cursor check of `readReservedDepth()` (SEARCH_SPEC 5.6.8).
   * A read the Production consumer never makes is an internal invariant
   * violation and fails closed; it never returns `[]` and never regenerates a
   * past depth, because the stream no longer holds one.
   */
  function claimReservedDepth(set: ReservedSet, base: BonusStreamBase, depth: number): void {
    const stream = `held-aware Bonus stream ${bonusStreamBaseKey(base, input.master)}`
    if (set.closedBy === 'failed') {
      throw new Error(`Single-pass violation: ${stream} failed an earlier read; depth ${depth} cannot be read.`)
    }
    if (set.reading) {
      throw new Error(`Single-pass violation: ${stream} is already reading depth ${set.nextDepth - 1}; depth ${depth} cannot be read concurrently.`)
    }
    if (set.closedBy === 'exhausted') {
      throw new Error(`Single-pass violation: ${stream} returned exhausted at depth ${set.nextDepth - 1}; depth ${depth} cannot be read.`)
    }
    if (!Number.isInteger(depth) || depth !== set.nextDepth) {
      const kind = !Number.isInteger(depth) ? 'a non-integer depth'
        : depth < set.nextDepth ? (depth === set.nextDepth - 1 ? 'a duplicate read' : 'a backward read') : 'a skip ahead'
      throw new Error(`Single-pass violation: ${stream} expects depth ${set.nextDepth}, got ${depth} (${kind}).`)
    }
    set.reading = true
    set.nextDepth = depth + 1
  }

  /**
   * One generated held-aware state. `familyLayoutKey` is the caller's
   * `keepFamilyLayoutKey(bonuses)`: computed from a Reset result, and the
   * parent's key for a Keep result, whose ordered families Keep preserves.
   */
  function reservedGeneratedState(
    depth: number,
    lastResetDepth: number,
    bonuses: RestorationBonusSet,
    familyLayoutKey: string,
    previous: ReservedBonusResultNode | null,
    position: number,
    gogmaCounterAfter: number,
  ): ReservedBonusState {
    return {
      depth,
      lastResetDepth,
      bonuses,
      scope: 'gogma_artian',
      familyLayoutKey,
      results: {
        depth,
        result: { restorationBonuses: bonuses, restorationBonusScope: 'gogma_artian' },
        previous,
        step: { gogmaCounterBefore: position, gogmaCounterAfter },
      },
      position,
      nextFrom: gogmaCounterAfter,
    }
  }

  async function ensure(base: BonusStreamBase, through: number) {
    const key = bonusStreamBaseKey(base, input.master)
    let cached = sets.get(key)
    if (!cached) {
      const frontier = { current: [] as readonly BonusState[] }
      cached = { iterator: build(base, frontier), value: EMPTY_SET(base.startGogmaCounter), done: false, depths: [], frontier }
      sets.set(key, cached)
    }
    const limit = Math.min(input.maxGogmaAdvance, Math.max(0, through))
    while (!cached.done && cached.depths.length < limit) {
      const previousCount = cached.value.solutions.length
      const next = await cached.iterator.next()
      cached.value = next.value
      cached.done = next.done === true
      // Slice only the newly generated suffix, never scan the previous prefix.
      if (!cached.done) cached.depths.push(next.value.solutions.slice(previousCount))
    }
    return cached
  }

  return {
    readReservedDepth: async (base, depth) => {
      const shape = base.shapePolicy
      if (shape !== undefined) assertBonusShapePolicy(base, shape)
      const set = reservedSet(base)
      claimReservedDepth(set, base, depth)
      try {
        const runtime = observeReservedRuntime === undefined
          ? undefined
          : reservedRuntimeBoundaries(observeReservedRuntime, set, base, depth)
        runtime?.depth('depth_started')
        const solutions = shape === undefined
          ? await generateReservedDepth(set, base, depth, runtime)
          : await generateShapeReservedDepth(set, shape, base, depth)
        // An empty depth is terminal. Otherwise the stream goes on while one
        // reduced frontier state still has a legal next position; every state's
        // window is visited, so the extent-cut record and the memo are as before.
        // A shape-constrained stream asks the same of the operations its shape allows.
        let exhausted = true
        if (solutions.length > 0 && shape !== undefined) {
          exhausted = !(await shapeStreamContinues(set, shape))
        } else if (solutions.length > 0) {
          runtime?.phase('phase_started', 'exhaustion_scan')
          for (const state of set.frontier) {
            if ((await reservedWindow(set, base, state)).positions.length > 0) exhausted = false
          }
          runtime?.phase('phase_completed', 'exhaustion_scan')
        }
        if (exhausted) set.closedBy = 'exhausted'
        set.reading = false
        runtime?.depth('depth_completed', exhausted)
        return { solutions, unsupportedPredictions: [...set.unsupported.values()], exhausted }
      } catch (error) {
        set.closedBy = 'failed'
        set.reading = false
        throw error
      }
    },
    reservedReachesBeyondExtent: (base) =>
      reservedSets.get(bonusStreamBaseKey(base, input.master))?.cutByExtent ?? false,
    readDepth: async (base, depth) => {
      refuseShapePolicy(base, 'readDepth')
      const cached = await ensure(base, depth)
      return {
        ...cached.value,
        solutions: cached.depths[depth - 1] ?? [],
        exhausted: cached.done || depth >= input.maxGogmaAdvance,
      }
    },
    reachesBeyondExtent: (base) => {
      refuseShapePolicy(base, 'reachesBeyondExtent')
      const cached = sets.get(bonusStreamBaseKey(base, input.master))
      if (!cached || cached.done || cached.depths.length < input.maxGogmaAdvance) return false
      // The same generation conditions the next depth would apply.
      if (base.amendmentPolicy !== 'keep_only' && predictionSupport.gogmaReset().supported) return true
      return engine.capabilities.supportsKeepBonusesPrediction && cached.frontier.current.some((state) =>
        state.bonuses !== null && predictionSupport.gogmaKeep(state.bonuses).supported)
    },
    solve: async (base, through = input.maxGogmaAdvance) => {
      refuseShapePolicy(base, 'solve')
      const cached = await ensure(base, through)
      const limit = Math.min(input.maxGogmaAdvance, Math.max(0, through))
      return {
        ...cached.value,
        steps: cached.value.steps.slice(0, limit),
        solutions: cached.depths.slice(0, limit).flat(),
      }
    },
  }
}

/**
 * The stream identity of one Route base (`docs/SEARCH_SPEC.md` 5.5.3).
 *
 * Reset reads nothing it replaces and Keep reads only the ordered slot family
 * layout, so the `depth >= 1` solution set depends on the base solely through
 * that layout: every offset and source sharing a layout at one Gogma position
 * shares one stream, whichever scope or tiers it holds. A blind base has no
 * layout and shares the single unknown stream, whose axis starts at the first
 * Reset. The initial-Search Keep-only policy has a distinct key so it never
 * aliases a full stream used by an owned source or constrained enumeration.
 * A shape-constrained base (`shapePolicy`, 5.6.9) adds its shape as a
 * further element, so it never aliases a Production stream or another shape;
 * a base without one keeps the Production key unchanged.
 */
export function bonusStreamBaseKey(
  base: BonusStreamBase,
  master: KeepFamilyMasterSubset,
): string {
  const key: unknown[] = [
    base.startGogmaCounter,
    base.amendmentPolicy ?? 'all',
    base.bonuses === null ? null : keepFamilyLayoutKey(base.bonuses, master),
  ]
  const shape = base.shapePolicy
  if (shape !== undefined) {
    key.push(['shape', shape.kind, shape.kind === 'reset_then_keep' ? shape.resetPosition : null, shape.finalPosition])
  }
  return stableStringify(key)
}
