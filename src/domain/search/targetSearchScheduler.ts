import type {
  BuildCandidate,
  BuildRoute,
  RouteOperation,
  SkillAmendmentResult,
} from '../models/publicTypes'
import { evaluateSkillCondition, satisfiesIdealBonuses } from '../target'
import {
  bonusAmendmentOperations, bonusAmendmentResults, bonusStreamBaseKey,
  type BonusStreamBase, type UnsupportedAmendmentPrediction,
} from './bonusStream'
import { countRouteOperations } from './candidateFactory'
import { createDeltaCross } from './deltaCross'
import { createIncrementalBonusRetention, createIncrementalSkillRetention } from './incrementalStreamSolutions'
import { createLazyIdealCross } from './lazyIdealCross'
import {
  createBaseCandidate, existingGogmaRouteKind,
  type CandidateSearchRouteContext, type RouteCompositionBase, type RouteSearchContext,
  type SearchFrontierPolicy,
} from './routeSearchShared'
import type { SearchRuntimeObserver } from './searchRuntime'
import { SearchWorkQueue } from './searchWorkQueue'
import { resetSkillsOperations, skillAmendmentResults } from './skillStream'
import {
  buildBonusSolutionSet, buildSkillSolutionSet, evaluateBonusSolutions, evaluateSkillSolutions,
  type EvaluatedBonusSolution, type EvaluatedSkillSolution, type RouteBonusSolution, type RouteSkillSolution,
} from './streamSolutions'

export type BonusStreamNotice =
  | { type: 'route_kind'; kind: BuildRoute['kind'] }
  | { type: 'unsupported'; prediction: UnsupportedAmendmentPrediction }

export interface ScheduledRouteBase {
  kindResolution: RouteCompositionBase['kindResolution']
  sourceOwnedWeaponId: BuildRoute['sourceOwnedWeaponId']
  baseOperations: readonly RouteOperation[]
  /**
   * The Skills `convert_normal_to_gogma` assigns for this base, or `null` when
   * `baseOperations` contains no conversion (SEARCH_SPEC 5.5.2.2).
   *
   * Required rather than optional: an existing-Gogma base's current Skills come
   * from the source weapon, not from a conversion, and must never be reported
   * as a conversion result.
   */
  conversionSkill: SkillAmendmentResult | null
  /**
   * The Route base's own `gogmaAdvance = 0` Bonus solution.
   *
   * `null` means the base has no current five slots at all, which happens only
   * when a blind Normal creation forged a weapon whose bonuses were never
   * predicted (`docs/SEARCH_SPEC.md` 6.1.1). No fabricated bonus set is
   * substituted, the zero-amendment Candidate does not exist, and the Bonus
   * axis starts at the first Reset Bonuses instead. `bonusBase` is then
   * required, because the base can produce no Candidate without it.
   */
  zeroBonus: RouteBonusSolution | null
  zeroSkill: RouteSkillSolution
  /** Null means capability/support unavailable. Current Ideal is checked here. */
  startSkillCounter: number | null
  bonusBase: BonusStreamBase | null
  onBonusNotice?(notice: BonusStreamNotice): void
  onCandidate(candidate: BuildCandidate): void
}

/**
 * One Cross pair of a registered Route base, composed into its concrete Route
 * and nothing more: no Candidate ID, `searchRunId`, timestamp, or Candidate
 * evaluation has happened yet.
 */
export interface ScheduledComposition {
  base: ScheduledRouteBase
  bonus: EvaluatedBonusSolution
  skill: EvaluatedSkillSolution
  route: BuildRoute
  /** The Route's own operation-unit count, i.e. the lower bound its work was queued at. */
  cost: number
}

/**
 * Receives each composition when its work item settles, in queue order.
 *
 * The scheduler's default is the ordinary Candidate Search materialization
 * (`createBaseCandidate()`, `ScheduledRouteBase.onCandidate`, and the cost the
 * canonical-Ideal stop of `run()` measures). A consumer that supplies its own
 * handler replaces all three, so it drives the queue with `step()` instead of
 * `run()`.
 */
export type ScheduledCompositionHandler = (composition: ScheduledComposition) => void

/**
 * Which lanes of one admitted Route base the shape-constrained Route
 * search opens (`docs/SEARCH_SPEC.md` 5.6.9).
 *
 * - `zero`: the lane's zero-operation solution alone, and no stream channel
 * - `stream`: the lane's stream channel, whatever the lane start state is (an
 *   Ideal lane start included), and never the zero-operation solution; only a
 *   solution whose last own operation stands at `finalPosition` reaches the
 *   composition. The Bonus lane names the stream base to read, which carries
 *   the shape's `shapePolicy`.
 */
export interface ScheduledRouteLaneAdmission {
  skill: { kind: 'zero' } | { kind: 'stream'; finalPosition: number }
  bonus: { kind: 'zero' } | { kind: 'stream'; streamBase: BonusStreamBase; finalPosition: number }
}

/**
 * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): the final admission of the
 * shape-constrained Route search, read from `RouteSearchContext.routeShapeFilter`.
 * No Candidate Search or Planner Alternative Search context carries one.
 *
 * The Route search primitives have already restricted the source, Counter,
 * production target and conversion position before generating a base
 * (`RouteSearchContext.routeBaseConstraint`), so `admit()` only confirms the
 * base and decides its lanes: `null` leaves the base unregistered. The
 * admitted base's Bonus notices are handed to `onBonusNotice` as well as to the
 * base's own handler.
 */
export interface ScheduledRouteShapeFilter {
  admit(base: ScheduledRouteBase): ScheduledRouteLaneAdmission | null
  onBonusNotice(notice: BonusStreamNotice): void
}

/** The absolute position of the last own operation of one stream solution; `null` for a zero-operation one. */
function lastOwnPosition(operations: readonly RouteOperation[]): number | null {
  const last = operations[operations.length - 1]
  if (last === undefined) return null
  return last.type === 'reset_skills' ? last.skillCounterBefore
    : last.type === 'reset_bonuses' || last.type === 'keep_bonuses' ? last.gogmaCounterBefore : null
}

interface CrossAxes {
  addBonus(value: EvaluatedBonusSolution): void
  addSkill(value: EvaluatedSkillSolution): void
}

/**
 * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): the Cross axes of one admitted
 * shape-constrained Route base. A `zero` lane takes its zero-operation solution
 * only; a `stream` lane takes only the solutions whose last own operation stands
 * at its `finalPosition`, so its zero-operation solution never enters the
 * composition even when the lane start state is Ideal. Nothing else changes:
 * the solutions, their order and the Cross itself are the ordinary ones.
 */
function shapeLaneAxes(axes: CrossAxes, lanes: ScheduledRouteLaneAdmission): CrossAxes {
  const takes = (lane: ScheduledRouteLaneAdmission['skill'] | ScheduledRouteLaneAdmission['bonus'], operations: readonly RouteOperation[]) =>
    lane.kind === 'zero' ? operations.length === 0 : lastOwnPosition(operations) === lane.finalPosition
  return {
    addBonus: (value) => { if (takes(lanes.bonus, value.solution.operations)) axes.addBonus(value) },
    addSkill: (value) => { if (takes(lanes.skill, value.solution.operations)) axes.addSkill(value) },
  }
}

/**
 * The concrete Route of one composed pair (SEARCH_SPEC 5.5.4). Pure: the
 * amendment operations of a conversion base run on the transient converted
 * weapon (`sourceOwnedWeaponId = null`), those of an existing-Gogma base on the
 * source weapon itself.
 */
function composeScheduledRoute(
  base: ScheduledRouteBase,
  bonus: EvaluatedBonusSolution,
  skill: EvaluatedSkillSolution,
): BuildRoute {
  const kind = base.kindResolution.type === 'fixed'
    ? base.kindResolution.kind : existingGogmaRouteKind(bonus.solution, skill.solution)
  const bindSource = (operation: RouteOperation): RouteOperation =>
    operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses' || operation.type === 'reset_skills'
      ? { ...operation, sourceOwnedWeaponId: base.kindResolution.type === 'fixed' ? null : base.sourceOwnedWeaponId }
      : operation
  return { kind, sourceOwnedWeaponId: base.sourceOwnedWeaponId, operations: [
    ...base.baseOperations,
    ...bonus.solution.operations.map(bindSource),
    ...skill.solution.operations.map(bindSource),
  ] }
}

interface Channel<T> {
  /**
   * Every solution already delivered, replayed once to a later subscriber:
   * the initial-Search retained delta, or, under the Planner Alternative
   * policy, every Ideal absolute position published so far (one entry per
   * position, never collapsed per Ideal result).
   */
  retained: T[]
  subscribers: Array<(value: T) => void>
}
interface BonusChannel extends Channel<EvaluatedBonusSolution> {
  notices: BonusStreamNotice[]
  noticeSubscribers: Array<(notice: BonusStreamNotice) => void>
}

/**
 * Target-wide work ownership. A Route base is registered once. Shared channels
 * evaluate/retain each new complete depth once and deliver only retained deltas
 * to existing subscribers. New bases receive the already retained solutions
 * once as their own initial state, without re-evaluating any stream predicate.
 *
 * Every pending item is a Normal/source base, a next stream depth, or a new
 * Cross pair (never the Cartesian product). Its cost is a lower bound on any
 * Candidate it can introduce. Positive depths use the cheapest subscribing
 * base; base registration is monotone, so a later subscriber cannot lower it.
 *
 * `RouteSearchContext.frontierPolicy` selects the consumer policy. The ordinary
 * `initial_candidate_search` retains the first position of each stream result
 * and composes the Cross axes only. `planner_alternative` (SEARCH_SPEC 5.6.8)
 * considers every absolute stream position independently (no same-result
 * retention), publishes every Ideal position for composition, and composes
 * every Ideal pair through
 * `createLazyIdealCross()`, one pending cell per row and one queued wake-up
 * step per waiting row resumed, so the Cartesian product is still never
 * materialized ahead of the lower bound and no long synchronous expansion runs
 * between two checkpoints. The streams and their
 * prediction memos are shared by both.
 */
export class TargetSearchScheduler {
  readonly queue = new SearchWorkQueue()
  private readonly skills = new Map<number, Channel<EvaluatedSkillSolution>>()
  private readonly bonuses = new Map<string, BonusChannel>()
  private idealCost: number | null = null
  private extentReached = false

  private readonly context: RouteSearchContext
  private readonly onComposition: ScheduledCompositionHandler
  /**
   * Execution-only section boundary observer (Issue #154 Phase 2-C2.6-A4,
   * `docs/SEARCH_SPEC.md` 5.6.8). Only the Planner Alternative Search passes
   * one, and only when its caller does; every Production call leaves it
   * undefined, in which case no boundary argument is even evaluated.
   */
  private readonly runtime: SearchRuntimeObserver | undefined
  /**
   * Shape-constrained Route search only (5.6.9): `RouteSearchContext.routeShapeFilter`, undefined in
   * every Production scheduler.
   */
  private readonly shapeFilter: ScheduledRouteShapeFilter | undefined

  /**
   * The ordinary Candidate Search materialization needs the ordinary request
   * (`searchRunId`, `CalculationContext`), so only a
   * `CandidateSearchRouteContext` may omit the handler. Any other consumer
   * supplies its own handler and never fabricates a `CandidateSearchInput`.
   * A context carrying the shape filter (`docs/SEARCH_SPEC.md` 5.6.9)
   * runs only under the Planner Alternative policy.
   */
  constructor(context: CandidateSearchRouteContext)
  constructor(context: RouteSearchContext, onComposition: ScheduledCompositionHandler, runtime?: SearchRuntimeObserver)
  constructor(
    context: RouteSearchContext | CandidateSearchRouteContext,
    onComposition?: ScheduledCompositionHandler,
    runtime?: SearchRuntimeObserver,
  ) {
    this.context = context
    this.runtime = runtime
    this.shapeFilter = context.routeShapeFilter
    if (this.shapeFilter !== undefined && (context.frontierPolicy ?? 'initial_candidate_search') !== 'planner_alternative') {
      throw new Error('A shape filter runs only under the Planner Alternative frontier policy.')
    }
    if (onComposition) {
      this.onComposition = onComposition
    } else if ('searchInput' in context) {
      this.onComposition = (composition) => this.materializeCandidate(context, composition)
    } else {
      throw new Error('The ordinary Candidate materialization requires a CandidateSearchRouteContext.')
    }
  }

  /** The frontier policy of this Target's search (`RouteSearchContext.frontierPolicy`). */
  get policy(): SearchFrontierPolicy {
    return this.context.frontierPolicy ?? 'initial_candidate_search'
  }

  /**
   * True once some search work was left unread only because an extent value
   * (Normal forge count, Gogma positions, Reset Skills count) ended it while a
   * further position was still reachable (SEARCH_SPEC 5.6.8 stopped by extent).
   * The Planner Alternative policy reads it; the ordinary Search never does.
   */
  get stoppedByExtent(): boolean {
    return this.extentReached
  }

  /** Records that an extent value left reachable work unread. */
  noteExtentReached(): void {
    this.extentReached = true
  }

  addBase(base: ScheduledRouteBase): void {
    if (this.shapeFilter === undefined) {
      this.registerBase(base, undefined)
      return
    }
    // Shape filter (5.6.9): the final admission, before anything is
    // queued. The admitted base hands its Bonus notices to the filter as well.
    const filter = this.shapeFilter
    const lanes = filter.admit(base)
    if (lanes === null) return
    const own = base.onBonusNotice
    this.registerBase({
      ...base,
      onBonusNotice(notice) {
        filter.onBonusNotice(notice)
        own?.call(base, notice)
      },
    }, lanes)
  }

  /**
   * Registers one Route base. `lanes` is the shape admission
   * (5.6.9) and is undefined for every Production base, which opens its lanes
   * by the lane-start Ideal rule exactly as before.
   */
  private registerBase(base: ScheduledRouteBase, lanes: ScheduledRouteLaneAdmission | undefined): void {
    const { target, input } = this.context
    const baseCost = countRouteOperations({
      kind: base.kindResolution.type === 'fixed' ? base.kindResolution.kind : 'existing_gogma_mixed',
      sourceOwnedWeaponId: base.sourceOwnedWeaponId, operations: [...base.baseOperations],
    })
    const runtime = this.runtime
    // `onSettled` (the lazy Cross's next cell of the row) runs after the
    // composition, exactly as before; it is inside the work only so that the
    // runtime boundaries nest.
    const settleComposition = (
      bonus: EvaluatedBonusSolution,
      skill: EvaluatedSkillSolution,
      cost: number,
      onSettled?: () => void,
    ) => async () => {
      runtime?.({ type: 'section_started', section: 'composition_work' })
      runtime?.({ type: 'section_started', section: 'composition_checkpoint' })
      await this.context.execution.checkpoint()
      runtime?.({ type: 'section_completed', section: 'composition_checkpoint' })
      runtime?.({ type: 'section_started', section: 'compose_route' })
      const route = composeScheduledRoute(base, bonus, skill)
      runtime?.({ type: 'section_completed', section: 'compose_route' })
      runtime?.({ type: 'section_started', section: 'composition_consumer' })
      this.onComposition({ base, bonus, skill, route, cost })
      runtime?.({ type: 'section_completed', section: 'composition_consumer' })
      if (onSettled) {
        runtime?.({ type: 'section_started', section: 'cross_open_next' })
        onSettled()
        runtime?.({ type: 'section_completed', section: 'cross_open_next' })
      }
      runtime?.({ type: 'section_completed', section: 'composition_work' })
    }
    // The initial Search composes the Cross axes only (SEARCH_SPEC 5.5.4); the
    // Planner Alternative policy composes every Ideal pair, lazily (5.6.8).
    const axes = this.policy === 'planner_alternative'
      ? createLazyIdealCross({
        open: (bonus, skill, onSettled) => {
          const cost = baseCost + bonus.solution.gogmaAdvance + skill.solution.resetCount
          this.queue.enqueue({ lowerBound: cost, settle: settleComposition(bonus, skill, cost, onSettled) })
        },
        // One waiting row per work item, so resuming many rows passes the
        // ordinary `step()` checkpoint between any two of them.
        wake: (bonus, skill, resume) => {
          const cost = baseCost + bonus.solution.gogmaAdvance + skill.solution.resetCount
          this.queue.enqueue({ lowerBound: cost, settle: () => {
            runtime?.({ type: 'section_started', section: 'cross_wake_work' })
            runtime?.({ type: 'section_started', section: 'cross_wake' })
            resume()
            runtime?.({ type: 'section_completed', section: 'cross_wake' })
            runtime?.({ type: 'section_completed', section: 'cross_wake_work' })
          } })
        },
      })
      : createDeltaCross((bonus, skill) => {
        const cost = baseCost + bonus.solution.gogmaAdvance + skill.solution.resetCount
        this.queue.enqueue({ lowerBound: cost, settle: settleComposition(bonus, skill, cost) })
      })
    // A shape admission (5.6.9) lets each axis take only its lane's
    // solutions: the zero-operation one of a `zero` lane, the ones ending at
    // `finalPosition` of a `stream` lane.
    const cross = lanes === undefined ? axes : shapeLaneAxes(axes, lanes)

    const bonus = base.zeroBonus === null
      ? null
      : buildBonusSolutionSet(target, input, [base.zeroBonus])[0]
    const skill = buildSkillSolutionSet(target, [base.zeroSkill])[0]
    if (bonus) cross.addBonus(bonus)
    cross.addSkill(skill)
    // A Production lane opens only when its start state is not Ideal; a shape's
    // `stream` lane opens whatever its start state is (5.6.9).
    const skillLaneOpens = lanes === undefined ? !skill.idealMatch : lanes.skill.kind === 'stream'
    if (skillLaneOpens && base.startSkillCounter !== null) {
      const channel = this.skillChannel(base.startSkillCounter, baseCost)
      for (const value of channel.retained) cross.addSkill(value)
      channel.subscribers.push(cross.addSkill)
    }
    const bonusBase = lanes === undefined ? base.bonusBase
      : lanes.bonus.kind === 'stream' ? lanes.bonus.streamBase : null
    if (bonus === null && bonusBase === null) {
      throw new Error(
        'A Route base without a zero-amendment Bonus solution requires a Bonus stream base.',
      )
    }
    const bonusLaneOpens = lanes === undefined ? !bonus?.idealMatch : lanes.bonus.kind === 'stream'
    if (bonusLaneOpens && bonusBase !== null) {
      const channel = this.bonusChannel(bonusBase, baseCost)
      for (const value of channel.retained) cross.addBonus(value)
      channel.subscribers.push(cross.addBonus)
      if (base.onBonusNotice) {
        for (const notice of channel.notices) base.onBonusNotice(notice)
        channel.noticeSubscribers.push(base.onBonusNotice)
      }
    }
  }

  private skillChannel(start: number, baseCost: number): Channel<EvaluatedSkillSolution> {
    const existing = this.skills.get(start)
    if (existing) return existing
    const channel: Channel<EvaluatedSkillSolution> = { retained: [], subscribers: [] }
    const channelIndex = this.skills.size
    this.skills.set(start, channel)
    const alternative = this.policy === 'planner_alternative'
    const retention = createIncrementalSkillRetention(this.context.target)
    const runtime = this.runtime
    const next = (depth: number) => this.queue.enqueue({
      lowerBound: baseCost + depth,
      settle: async () => {
        runtime?.({ type: 'section_started', section: 'skill_depth_work', work: { channel: channelIndex, depth } })
        if (alternative) {
          // Held-aware reading over the Skill reservation (SEARCH_SPEC 5.6.8):
          // each solution carries its own absolute operation positions, and
          // `depth` stays the own operation count, i.e. the cost. Every
          // absolute position is judged with the Ideal Skill authority; only an
          // Ideal one is materialized, ordered and published, because the Lazy
          // Ideal Cross composes nothing else. Extent and exhaustion still
          // follow the raw depth.
          runtime?.({ type: 'section_started', section: 'skill_depth_read' })
          const reserved = await this.context.skillStream.readReservedDepth(start, depth)
          runtime?.({ type: 'section_completed', section: 'skill_depth_read' })
          runtime?.({ type: 'section_started', section: 'skill_ideal_filter' })
          const ideal = reserved.solutions.filter((solution) => evaluateSkillCondition(
            this.context.target.idealSkillCondition, solution.seriesSkillId, solution.groupSkillId,
          ))
          runtime?.({ type: 'section_completed', section: 'skill_ideal_filter' })
          runtime?.({ type: 'section_started', section: 'skill_route_materialization' })
          const solutions = ideal.map((solution) => {
            const own = { startSkillCounter: start, steps: solution.steps, solutions: [] }
            return {
              resetCount: solution.resetCount,
              seriesSkillId: solution.seriesSkillId,
              groupSkillId: solution.groupSkillId,
              estimatedSkillAdvance: solution.resetCount,
              operations: resetSkillsOperations(own, solution.resetCount, null),
              amendmentResults: skillAmendmentResults(own, solution.resetCount),
            }
          })
          runtime?.({ type: 'section_completed', section: 'skill_route_materialization' })
          runtime?.({ type: 'section_started', section: 'skill_evaluate_sort' })
          const evaluated = evaluateSkillSolutions(this.context.target, solutions)
          runtime?.({ type: 'section_completed', section: 'skill_evaluate_sort' })
          runtime?.({ type: 'section_started', section: 'skill_channel_publication' })
          for (const value of evaluated) {
            channel.retained.push(value)
            for (const receive of channel.subscribers) {
              runtime?.({ type: 'section_started', section: 'cross_add_skill' })
              receive(value)
              runtime?.({ type: 'section_completed', section: 'cross_add_skill' })
            }
          }
          runtime?.({ type: 'section_completed', section: 'skill_channel_publication' })
          runtime?.({ type: 'section_started', section: 'skill_depth_advance' })
          if (!reserved.exhausted) next(depth + 1)
          else if (this.context.skillStream.reservedReachesBeyondExtent(start)) this.noteExtentReached()
          runtime?.({ type: 'section_completed', section: 'skill_depth_advance' })
          runtime?.({ type: 'section_completed', section: 'skill_depth_work', counts: {
            rawSolutions: reserved.solutions.length,
            unsupportedPredictions: 0,
            idealSolutions: ideal.length,
            evaluatedSolutions: evaluated.length,
            subscriberCount: channel.subscribers.length,
            retainedCountAfter: channel.retained.length,
            exhausted: reserved.exhausted,
          } })
          return
        }
        const delta = await this.context.skillStream.readDepth(start, depth)
        const solutions = delta.solutions.map((solution) => ({
          ...solution, estimatedSkillAdvance: solution.resetCount,
          operations: resetSkillsOperations(delta, solution.resetCount, null),
          amendmentResults: skillAmendmentResults(delta, solution.resetCount),
        }))
        // Initial-Search retention keeps the first position of each Skill
        // result; the Planner Alternative policy (above) judges every absolute
        // position and publishes every Ideal one.
        for (const value of retention.appendDepth(solutions)) {
          channel.retained.push(value)
          for (const receive of channel.subscribers) receive(value)
        }
        if (!delta.exhausted) next(depth + 1)
        runtime?.({ type: 'section_completed', section: 'skill_depth_work' })
      },
    })
    next(1)
    return channel
  }

  private bonusChannel(base: BonusStreamBase, baseCost: number): BonusChannel {
    const key = bonusStreamBaseKey(base, this.context.input.master)
    const existing = this.bonuses.get(key)
    if (existing) return existing
    const channel: BonusChannel = { retained: [], subscribers: [], notices: [], noticeSubscribers: [] }
    const channelIndex = this.bonuses.size
    this.bonuses.set(key, channel)
    const alternative = this.policy === 'planner_alternative'
    const retention = createIncrementalBonusRetention(this.context.target, this.context.input)
    const runtime = this.runtime
    const noticeKeys = new Set<string>()
    const publishNotice = (notice: BonusStreamNotice) => {
      const id = JSON.stringify(notice)
      if (noticeKeys.has(id)) return
      noticeKeys.add(id)
      channel.notices.push(notice)
      for (const receive of channel.noticeSubscribers) receive(notice)
    }
    const next = (depth: number) => this.queue.enqueue({
      lowerBound: baseCost + depth,
      settle: async () => {
        runtime?.({ type: 'section_started', section: 'bonus_depth_work', work: { channel: channelIndex, depth } })
        if (alternative) {
          // Held-aware reading over the Gogma reservation (SEARCH_SPEC 5.6.8):
          // each state carries its own absolute amendment positions, and
          // `depth` stays the own amendment count, i.e. the cost.
          runtime?.({ type: 'section_started', section: 'bonus_depth_read' })
          const reserved = await this.context.bonusStream.readReservedDepth(base, depth)
          runtime?.({ type: 'section_completed', section: 'bonus_depth_read' })
          runtime?.({ type: 'section_started', section: 'bonus_notice_scan' })
          for (const solution of reserved.solutions) {
            publishNotice({ type: 'route_kind', kind: solution.lastResetDepth === solution.depth
              ? 'existing_gogma_reset_bonuses'
              : solution.lastResetDepth === 0 ? 'existing_gogma_keep_bonuses' : 'existing_gogma_mixed' })
          }
          for (const prediction of reserved.unsupportedPredictions) publishNotice({ type: 'unsupported', prediction })
          runtime?.({ type: 'section_completed', section: 'bonus_notice_scan' })
          // The notices above come from every raw state. Every absolute
          // position is then judged with the Ideal Bonus authority itself (its
          // Master rank assertion included); only an Ideal one is materialized,
          // ordered and published, because the Lazy Ideal Cross composes
          // nothing else. Extent and exhaustion still follow the raw depth.
          runtime?.({ type: 'section_started', section: 'bonus_ideal_filter' })
          const ideal = reserved.solutions.filter((solution) => satisfiesIdealBonuses(
            this.context.target, solution.bonuses, solution.restorationBonusScope, this.context.input.master,
          ))
          runtime?.({ type: 'section_completed', section: 'bonus_ideal_filter' })
          runtime?.({ type: 'section_started', section: 'bonus_route_materialization' })
          const solutions = ideal.map((solution) => ({
            gogmaAdvance: solution.depth, lastResetDepth: solution.lastResetDepth,
            finalBonuses: solution.bonuses, restorationBonusScope: solution.restorationBonusScope,
            operations: bonusAmendmentOperations(
              { startGogmaCounter: base.startGogmaCounter, steps: solution.steps, solutions: [], unsupportedPredictions: [] },
              solution,
              null,
            ),
            amendmentResults: bonusAmendmentResults(solution),
          }))
          runtime?.({ type: 'section_completed', section: 'bonus_route_materialization' })
          runtime?.({ type: 'section_started', section: 'bonus_evaluate_sort' })
          const evaluated = evaluateBonusSolutions(this.context.target, this.context.input, solutions)
          runtime?.({ type: 'section_completed', section: 'bonus_evaluate_sort' })
          runtime?.({ type: 'section_started', section: 'bonus_channel_publication' })
          for (const value of evaluated) {
            channel.retained.push(value)
            for (const receive of channel.subscribers) {
              runtime?.({ type: 'section_started', section: 'cross_add_bonus' })
              receive(value)
              runtime?.({ type: 'section_completed', section: 'cross_add_bonus' })
            }
          }
          runtime?.({ type: 'section_completed', section: 'bonus_channel_publication' })
          runtime?.({ type: 'section_started', section: 'bonus_depth_advance' })
          if (!reserved.exhausted) next(depth + 1)
          else if (this.context.bonusStream.reservedReachesBeyondExtent(base)) this.noteExtentReached()
          runtime?.({ type: 'section_completed', section: 'bonus_depth_advance' })
          runtime?.({ type: 'section_completed', section: 'bonus_depth_work', counts: {
            rawSolutions: reserved.solutions.length,
            unsupportedPredictions: reserved.unsupportedPredictions.length,
            idealSolutions: ideal.length,
            evaluatedSolutions: evaluated.length,
            subscriberCount: channel.subscribers.length,
            retainedCountAfter: channel.retained.length,
            exhausted: reserved.exhausted,
          } })
          return
        }
        const delta = await this.context.bonusStream.readDepth(base, depth)
        for (const solution of delta.solutions) {
          publishNotice({ type: 'route_kind', kind: solution.lastResetDepth === solution.depth
            ? 'existing_gogma_reset_bonuses'
            : solution.lastResetDepth === 0 ? 'existing_gogma_keep_bonuses' : 'existing_gogma_mixed' })
        }
        for (const prediction of delta.unsupportedPredictions) publishNotice({ type: 'unsupported', prediction })
        const solutions = delta.solutions.map((solution) => ({
          gogmaAdvance: solution.depth, lastResetDepth: solution.lastResetDepth,
          finalBonuses: solution.bonuses, restorationBonusScope: solution.restorationBonusScope,
          operations: bonusAmendmentOperations(delta, solution, null),
          amendmentResults: bonusAmendmentResults(solution),
        }))
        // Initial-Search retention keeps the first position of each (scope,
        // multiset); the Planner Alternative policy (above) judges every
        // generated state and publishes every Ideal absolute position. The B2
        // family-layout frontier reduction applies to both, per absolute
        // position in the held-aware reading.
        for (const value of retention.appendDepth(solutions)) {
          channel.retained.push(value)
          for (const receive of channel.subscribers) receive(value)
        }
        if (!delta.exhausted) next(depth + 1)
        runtime?.({ type: 'section_completed', section: 'bonus_depth_work' })
      },
    })
    next(1)
    return channel
  }

  /**
   * Empty queue is formal exhaustion, including no-Candidate/no-future-work.
   * On an Ideal at D, drain ALL pending work with lowerBound <= D (including
   * work discovered during that drain). Only then are the canonical Ideal
   * ties settled. No empty layers or configured-maximum loop.
   * The exhaustive option is an internal oracle for bounded Search tests.
   */
  async run(stopAtIdeal = true): Promise<void> {
    while (this.queue.nextLowerBound !== null) {
      if (stopAtIdeal && this.idealCost !== null && this.queue.nextLowerBound > this.idealCost) break
      await this.step()
    }
  }

  /**
   * Settles the one pending work item with the lowest lower bound, behind the
   * ordinary cancellation / yield checkpoint. Returns `false`, doing nothing,
   * when no work is pending. It applies no termination policy of its own.
   */
  async step(): Promise<boolean> {
    if (this.queue.nextLowerBound === null) return false
    const runtime = this.runtime
    runtime?.({ type: 'section_started', section: 'scheduler_step' })
    runtime?.({ type: 'section_started', section: 'scheduler_checkpoint' })
    await this.context.execution.checkpoint()
    runtime?.({ type: 'section_completed', section: 'scheduler_checkpoint' })
    // The heap pop and the dispatch stay in `scheduler_settle` itself; a work
    // item the scheduler did not create (a Route base a Route search
    // primitive queued) reports no work section of its own.
    runtime?.({ type: 'section_started', section: 'scheduler_settle' })
    await this.queue.settleNext()
    runtime?.({ type: 'section_completed', section: 'scheduler_settle' })
    runtime?.({ type: 'section_started', section: 'scheduler_post_settle' })
    // Activity signal only. It counts settled work; it never gates, orders,
    // or terminates the queue.
    this.context.execution.onWorkSettled()
    runtime?.({ type: 'section_completed', section: 'scheduler_post_settle' })
    runtime?.({ type: 'section_completed', section: 'scheduler_step' })
    return true
  }

  /** The ordinary Candidate Search materialization of one composition. */
  private materializeCandidate(
    context: CandidateSearchRouteContext,
    { base, bonus, skill, route, cost }: ScheduledComposition,
  ): void {
    const candidate = createBaseCandidate(
      context, bonus.solution.finalBonuses, bonus.solution.restorationBonusScope,
      skill.solution.seriesSkillId, skill.solution.groupSkillId,
      route,
      bonus.solution.amendmentResults,
      skill.solution.amendmentResults,
      base.conversionSkill,
    )
    if (!candidate) return
    base.onCandidate(candidate)
    // Every composed Candidate is an Ideal Candidate, so any Candidate at
    // all settles the cost the canonical-Ideal drain is measured against.
    this.idealCost = Math.min(this.idealCost ?? cost, cost)
  }
}
