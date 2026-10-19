import type { RestorationBonusSet, TargetWeapon } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import { createTargetBonusStream, type ReservedGogmaDepthObserver, type ReservedGogmaRuntimeObserver } from '../bonusStream'
import { createCounterReservation, EMPTY_COUNTER_RESERVATION } from '../counterReservation'
import { candidateStableKey } from '../candidateProcessing'
import { compareConstrainedCandidates } from '../constrained/constrainedCandidateFactory'
import type { ConstrainedSearchOrigin } from '../constrained/constrainedTypes'
import { searchExistingGogmaRoutes } from '../existingGogmaRouteSearch'
import { searchNormalArtianRoutes } from '../normalArtianRouteSearch'
import { searchOwnedNormalArtianRoutes } from '../ownedNormalArtianRouteSearch'
import type { RouteBaseConstraint, RouteSearchContext, RouteSearchResult } from '../routeSearchShared'
import { createSearchExecutionContext } from '../searchExecution'
import { createSearchPredictionSupport } from '../searchPredictionSupport'
import type { SearchRuntimeObserver, SearchRuntimeSection } from '../searchRuntime'
import { createTargetSkillStream, type ReservedSkillDepthObserver } from '../skillStream'
import { TargetSearchScheduler, type ScheduledRouteShapeFilter } from '../targetSearchScheduler'
import { createPlannerAlternativeCandidate } from './plannerAlternativeCandidateFactory'
import {
  PlannerAlternativeSearchError,
  type PlannerAlternativeCandidate,
  type PlannerAlternativeCandidateVisitor,
  type PlannerAlternativeReservation,
  type PlannerAlternativeSearchExecution,
  type PlannerAlternativeSearchExtent,
  type PlannerAlternativeSearchInput,
} from './plannerAlternativeTypes'
import { assertPlannerAlternativeSearchInput } from './plannerAlternativeValidation'

/**
 * Read-only observers of one search run (Planner Alternative Search Phase 3
 * Browser Worker benchmark, `docs/PLANNER_ALTERNATIVE_BROWSER_WORKER_BENCHMARK.md`).
 *
 * Execution-only, exactly like cancellation and yield: never part of
 * `PlannerAlternativeSearchInput`, the search identity, a Candidate identity,
 * the ordering or the termination. Every callback is invoked after the work it
 * reports, receives aggregate counts only, and returns nothing the search
 * reads, so the delivered Candidates, the summary and the prediction calls are
 * identical with and without it. Every Production caller leaves it undefined.
 */
export interface PlannerAlternativeSearchInstrumentation {
  /** One `TargetSearchScheduler.step()` settled one pending work item. */
  onWorkSettled?: () => void
  /** One held-aware Skill stream depth was generated and published. */
  onSkillReservedDepth?: ReservedSkillDepthObserver
  /** One held-aware Bonus stream depth was generated, published and reduced. */
  onGogmaReservedDepth?: ReservedGogmaDepthObserver
  /**
   * The section boundaries of each held-aware Bonus stream depth (Issue #154
   * Phase 2-C2.6-A3 runtime localization): boundaries only, no clock and no
   * extra scan in the stream; the observer stamps them itself.
   */
  onGogmaReservedRuntime?: ReservedGogmaRuntimeObserver
  /**
   * The section boundaries of the whole Search (Issue #154 Phase 2-C2.6-A4
   * outer runtime localization): the root, setup, Route registration, every
   * scheduler step and its work, and every delivery flush, strictly nested in
   * the registered hierarchy (`SEARCH_RUNTIME_SECTION_PARENT`). Boundaries
   * only, no clock and no Search state; the observer stamps them itself.
   */
  onSearchRuntime?: SearchRuntimeObserver
}

/**
 * Cancellation and Worker yield, plus the optional benchmark instrumentation.
 * Planner Alternative Search produces no Candidate ID and no timestamp, so it
 * never takes an ID factory or a Clock.
 */
export interface PlannerAlternativeSearchExecutionOptions {
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
  instrumentation?: PlannerAlternativeSearchInstrumentation
}

/**
 * Planner Alternative Search (`docs/SEARCH_SPEC.md` 5.6.8), delivering Ideal
 * Candidates one at a time for as long as the consumer asks for the next one.
 *
 * It is a separate consumer of the modern Candidate Search base, never a call
 * of `searchCandidates()`: the same Route search primitives register the Route
 * bases on the same `TargetSearchScheduler`, the same Skill / Bonus streams
 * predict, and the Phase 1-A composition seam hands each composed Route here
 * instead of to the ordinary materialization. So the initial Search policy of
 * stopping once the canonical Ideal cost is drained does not apply: the queue
 * is driven with `step()` until the consumer stops or the frontier runs out.
 *
 * Frontier. The context carries the `planner_alternative` frontier policy, so
 * none of the initial Search's other policies bounds what is reachable either:
 * every absolute stream position is considered independently and every Ideal
 * position is published for composition (no same-result retention), every Ideal
 * Bonus x Ideal Skill pair of a Route base is composed lazily, one row at a
 * time (no Cross-only), and every predicted Normal offset of the extent is a
 * full Route base (no #104 reduction). The streams, their prediction memos and
 * the B2 family-layout frontier reduction are the ordinary ones, so no
 * prediction depends on how many solutions another stream has.
 *
 * Delivery order. Every work item's lower bound is a lower bound on the
 * operation cost of every Candidate it can lead to, and compositions settle at
 * their exact cost. The compositions of one cost are buffered until no pending
 * work can add another of that cost, then delivered in the 5.6.3 six-key order
 * (`compareConstrainedCandidates()` with the Target's preferred source). So the
 * whole delivered sequence is in that order, and with an empty reservation and
 * the same extent the first delivered Candidate is the ordinary canonical Ideal.
 *
 * Termination. An empty queue ends the search: `stoppedByExtent` when an extent
 * value left reachable work unread, `exhausted` otherwise. A consumer stop sets
 * neither, and cancellation rejects.
 *
 * Reservation (`docs/SEARCH_SPEC.md` 5.6.8, Phase 2). Every Route satisfies the
 * coverage condition on each Counter stream: from the origin to its last own
 * operation, every position is an own operation or held, a blocked position
 * holds no own operation (a blocked Normal position no production target), and
 * a held position without an own operation leaves the weapon unchanged. The
 * streams read held-aware (`readReservedDepth()`), the conversion may cross
 * held Skill positions (`conversionSkillPositions()`), the predicted Normal
 * creation is the canonical held-prefix one (`heldPrefixNormalCreation()`),
 * and an exclusive OwnedWeapon is never a source. A held skip predicts
 * nothing, changes nothing and costs no operation, so the lower bounds and
 * `estimatedOperationCount` stay own operation counts, while the advances are
 * the reach from the origin. The stream-to-stream time order and cyclic waits
 * are the Planner's full rerun to judge, never this search's. An empty
 * reservation searches exactly the Phase 1 frontier.
 */
export async function visitPlannerAlternativeCandidates(
  input: PlannerAlternativeSearchInput,
  engine: RngEngine,
  onCandidate: PlannerAlternativeCandidateVisitor,
  options: PlannerAlternativeSearchExecutionOptions = {},
): Promise<PlannerAlternativeSearchExecution> {
  const runtime = options.instrumentation?.onSearchRuntime
  runtime?.({ type: 'section_started', section: 'search_runtime' })
  runtime?.({ type: 'section_started', section: 'search_setup' })
  const { target, reservation } = assertPlannerAlternativeSearchInput(input)
  const { origin, extent } = input
  if (engine.version !== origin.calculationContext.rngEngineVersion) {
    throw new PlannerAlternativeSearchError(
      'calculation_context_incompatible',
      'The RNG Engine version does not match the origin CalculationContext.',
    )
  }
  return createPlannerAlternativeFrontier({ target, reservation, origin, extent, engine, options }).run({
    onCandidate,
    registrations: PLANNER_ALTERNATIVE_ROUTE_REGISTRATIONS,
    excludedRouteKeys: input.excludedRouteKeys,
  })
}

/** One Route search primitive as the Planner Alternative frontier registers it. */
export type PlannerAlternativeRoutePrimitive = (
  context: RouteSearchContext,
  scheduler: TargetSearchScheduler,
) => Promise<RouteSearchResult>

/**
 * The same registration order as the ordinary Search, with no route filter:
 * the scope is every currently legal Search Route. The searchers' own searched
 * / skipped reports and notices are ordinary Search presentation and are not
 * part of this API.
 */
export const PLANNER_ALTERNATIVE_ROUTE_REGISTRATIONS: ReadonlyArray<readonly [SearchRuntimeSection, PlannerAlternativeRoutePrimitive]> = [
  ['normal_route_registration', searchNormalArtianRoutes],
  ['owned_normal_route_registration', searchOwnedNormalArtianRoutes],
  ['existing_gogma_route_registration', searchExistingGogmaRoutes],
]

/**
 * A validated Planner Alternative frontier input: the searched Target, the
 * normalized reservation, the Planner-start origin, the extent, the Engine
 * and the execution options. `routeBaseConstraint` and `shapeFilter` are the
 * shape-constrained Route search's (`docs/SEARCH_SPEC.md` 5.6.9);
 * Planner Alternative Search never passes them.
 */
export interface PlannerAlternativeFrontierSetup {
  target: TargetWeapon
  reservation: PlannerAlternativeReservation
  origin: ConstrainedSearchOrigin
  extent: PlannerAlternativeSearchExtent
  engine: RngEngine
  options: PlannerAlternativeSearchExecutionOptions
  routeBaseConstraint?: RouteBaseConstraint
  shapeFilter?: ScheduledRouteShapeFilter
}

/**
 * One Planner Alternative frontier after its setup (the open `search_setup`
 * runtime section included). `run()` closes the setup section, registers the
 * given Route search primitives in order, drives the delivery loop and closes
 * the Search root section.
 */
export interface PlannerAlternativeFrontier {
  readonly context: RouteSearchContext
  run(request: {
    onCandidate: PlannerAlternativeCandidateVisitor
    registrations: ReadonlyArray<readonly [SearchRuntimeSection, PlannerAlternativeRoutePrimitive]>
    excludedRouteKeys: readonly string[]
  }): Promise<PlannerAlternativeSearchExecution>
  /** Closes the setup and Search root sections of a frontier that will not run (shape base diagnosis, 5.6.9). */
  closeWithoutRun(): void
}

/**
 * The setup, Route registration and delivery loop of
 * `visitPlannerAlternativeCandidates()`, shared with the
 * shape-constrained Route search (`docs/SEARCH_SPEC.md` 5.6.9) so neither
 * duplicates the context, the scheduler, the cost-layer buffer, the six-key
 * delivery or the termination. Not part of the Search Domain's public exports
 * (`alternative/index.ts` names its exports). The caller validates the input
 * and opens the `search_runtime` and `search_setup` runtime sections first.
 */
export function createPlannerAlternativeFrontier(setup: PlannerAlternativeFrontierSetup): PlannerAlternativeFrontier {
  const { target, reservation, origin, extent, engine, options } = setup
  const runtime = options.instrumentation?.onSearchRuntime
  const execution = createSearchExecutionContext({
    shouldCancel: options.shouldCancel,
    yieldControl: options.yieldControl,
  })
  const instrumentation = options.instrumentation
  const predictionSupport = createSearchPredictionSupport(engine, target, origin.master)
  const skillReservation = createCounterReservation(reservation.skill.held, reservation.skill.blocked)
  const gogmaReservation = createCounterReservation(reservation.gogma.held, reservation.gogma.blocked)
  const normalReservations = new Map(reservation.normal.map((entry) =>
    [entry.counterId, createCounterReservation(entry.held, entry.blocked)] as const))
  const originSkillCounter = origin.rngState.skillCounter.value
  const context: RouteSearchContext = {
    frontierPolicy: 'planner_alternative',
    reservation: {
      normal: (counterId) => normalReservations.get(counterId) ?? EMPTY_COUNTER_RESERVATION,
      skill: skillReservation,
      gogma: gogmaReservation,
      exclusiveOwnedWeaponIds: new Set(reservation.exclusiveOwnedWeaponIds),
      // Read only once a confirmed Skill Counter allowed a conversion Route.
      conversionSkillPositionLimit: (originSkillCounter ?? 0) + extent.maxSkillAdvance + 1,
    },
    target,
    input: {
      rngState: origin.rngState,
      normalCounters: origin.normalCounters,
      ownedWeapons: origin.ownedWeapons,
      master: origin.master,
      maxNormalAdvance: extent.maxNormalAdvance,
    },
    engine,
    execution,
    predictionSupport,
    normalPredictions: new Map<number, RestorationBonusSet>(),
    skillStream: createTargetSkillStream(
      target,
      {
        rngState: origin.rngState,
        master: origin.master,
        maxSkillAdvance: extent.maxSkillAdvance,
        reservation: skillReservation,
      },
      engine,
      execution,
      () => predictionSupport.skill().supported,
      instrumentation?.onSkillReservedDepth,
    ),
    bonusStream: createTargetBonusStream(
      target,
      {
        rngState: origin.rngState,
        master: origin.master,
        maxGogmaAdvance: extent.maxGogmaAdvance,
        reservation: gogmaReservation,
      },
      engine,
      execution,
      predictionSupport,
      instrumentation?.onGogmaReservedDepth,
      instrumentation?.onGogmaReservedRuntime,
    ),
    // Shape-constrained Route search only (5.6.9); a Planner Alternative context never carries either.
    ...(setup.routeBaseConstraint === undefined ? {} : { routeBaseConstraint: setup.routeBaseConstraint }),
    ...(setup.shapeFilter === undefined ? {} : { routeShapeFilter: setup.shapeFilter }),
  }

  let buffered: PlannerAlternativeCandidate[] = []
  let bufferedCost: number | null = null
  const scheduler = new TargetSearchScheduler(context, (composition) => {
    if (bufferedCost !== null && composition.cost !== bufferedCost) {
      throw new Error(
        'Planner Alternative Search received a composition of another cost before the buffered cost was delivered.',
      )
    }
    const candidate = createPlannerAlternativeCandidate(target, origin, composition)
    if (candidate === null) return
    buffered.push(candidate)
    bufferedCost = composition.cost
  }, runtime)

  const run: PlannerAlternativeFrontier['run'] = async ({ onCandidate, registrations, excludedRouteKeys }) => {
    runtime?.({ type: 'section_completed', section: 'search_setup' })
    runtime?.({ type: 'section_started', section: 'route_registration' })
    for (const [section, search] of registrations) {
      runtime?.({ type: 'section_started', section })
      await search(context, scheduler)
      runtime?.({ type: 'section_completed', section })
    }
    runtime?.({ type: 'section_completed', section: 'route_registration' })

    const excluded = new Set(excludedRouteKeys)
    const seen = new Set<string>()
    let deliveredCandidates = 0
    let excludedCandidates = 0
    const skippedExcludedRouteKeys: string[] = []
    let stoppedByConsumer = false

    delivery: for (;;) {
      const next = scheduler.queue.nextLowerBound
      if (bufferedCost !== null && (next === null || next > bufferedCost)) {
        runtime?.({ type: 'section_started', section: 'delivery_flush' })
        runtime?.({ type: 'section_started', section: 'delivery_sort' })
        const ready = buffered.sort((left, right) =>
          compareConstrainedCandidates(left, right, target.preferredOwnedWeaponId))
        runtime?.({ type: 'section_completed', section: 'delivery_sort' })
        buffered = []
        bufferedCost = null
        for (const candidate of ready) {
          // A long equal-cost flush stays cancellable and yields like any work.
          runtime?.({ type: 'section_started', section: 'delivery_checkpoint' })
          await execution.checkpoint()
          runtime?.({ type: 'section_completed', section: 'delivery_checkpoint' })
          runtime?.({ type: 'section_started', section: 'delivery_key_dedup' })
          const key = candidateStableKey(candidate)
          // Only exact semantic duplicates collapse; this is not retention.
          if (seen.has(key)) {
            runtime?.({ type: 'section_completed', section: 'delivery_key_dedup' })
            continue
          }
          seen.add(key)
          if (excluded.has(key)) {
            excludedCandidates += 1
            skippedExcludedRouteKeys.push(key)
            runtime?.({ type: 'section_completed', section: 'delivery_key_dedup' })
            continue
          }
          deliveredCandidates += 1
          runtime?.({ type: 'section_completed', section: 'delivery_key_dedup' })
          runtime?.({ type: 'section_started', section: 'delivery_consumer' })
          const verdict = await onCandidate(candidate)
          runtime?.({ type: 'section_completed', section: 'delivery_consumer' })
          if (verdict === 'stop') {
            stoppedByConsumer = true
            runtime?.({ type: 'section_completed', section: 'delivery_flush' })
            break delivery
          }
        }
        runtime?.({ type: 'section_completed', section: 'delivery_flush' })
        continue
      }
      if (!(await scheduler.step())) break
      instrumentation?.onWorkSettled?.()
    }

    // The frontier ran out unless the consumer stopped first. Whether it ran out
    // naturally or an extent value cut reachable work is the scheduler's record.
    const stoppedByExtent = !stoppedByConsumer && scheduler.stoppedByExtent
    runtime?.({ type: 'section_completed', section: 'search_runtime' })
    return {
      targetWeaponId: target.id,
      summary: {
        deliveredCandidates,
        excludedCandidates,
        exhausted: !stoppedByConsumer && !stoppedByExtent,
        stoppedByExtent,
      },
      stoppedByConsumer,
      skippedExcludedRouteKeys,
    }
  }
  const closeWithoutRun = () => {
    runtime?.({ type: 'section_completed', section: 'search_setup' })
    runtime?.({ type: 'section_completed', section: 'search_runtime' })
  }
  return { context, run, closeWithoutRun }
}

/**
 * Opens the Search root and setup runtime sections of one frontier, before the
 * caller validates its input, exactly as `visitPlannerAlternativeCandidates()`
 * does: for the shape-constrained Route search (5.6.9), which shares
 * the frontier and so its runtime section hierarchy.
 */
export function openPlannerAlternativeSearchSections(options: PlannerAlternativeSearchExecutionOptions): void {
  const runtime = options.instrumentation?.onSearchRuntime
  runtime?.({ type: 'section_started', section: 'search_runtime' })
  runtime?.({ type: 'section_started', section: 'search_setup' })
}
