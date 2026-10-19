import type {
  BonusAmendmentResult,
  BuildCandidate,
  BuildRoute,
  GroupSkillId,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  RestorationBonusScope,
  RestorationBonusSet,
  RngState,
  RouteOperation,
  SeriesSkillId,
  SkillAmendmentResult,
  TargetWeapon,
} from '../models/publicTypes'
import type { RngEngine, RngPredictionUnsupportedReason } from '../rng/rngEngine'
import { evaluateSkillCondition, satisfiesIdealBonuses } from '../target'
import { hasConfirmedGogmaInputs } from './searchRngInputs'
import {
  nextOperationPositions,
  type RouteSearchReservation,
} from './counterReservation'
import {
  bonusAmendmentOperations,
  bonusAmendmentResults,
  type BonusStreamSolutionSet,
  type TargetBonusStream,
} from './bonusStream'
import { createCandidateFromPrediction } from './candidateFactory'
import { crossStreamSolutions } from './crossComposition'
import type { SearchExecutionContext } from './searchExecution'
import type { SearchPredictionSupport } from './searchPredictionSupport'
import type { ScheduledRouteShapeFilter } from './targetSearchScheduler'
import {
  CandidateSearchError,
  type CandidateSearchInput,
  type CandidateSearchWarning,
  type SearchMasterSubset,
  type SkippedRoute,
} from './searchTypes'
import {
  buildBonusSolutionSet,
  buildSkillSolutionSet,
  selectIdealBonusAxis,
  selectIdealSkillAxis,
  type RouteBonusSolution,
  type RouteSkillSolution,
} from './streamSolutions'
import {
  resetSkillsOperations,
  skillAmendmentResults,
  type SkillStreamSolutionSet,
  type TargetSkillStream,
} from './skillStream'

export { hasConfirmedGogmaInputs, hasConfirmedSkillInputs } from './searchRngInputs'
export {
  createSearchPredictionSupport,
  type SearchPredictionSupport,
} from './searchPredictionSupport'

export interface RouteSearchResult {
  candidates: BuildCandidate[]
  searchedRoutes: BuildRoute['kind'][]
  skippedRoutes: SkippedRoute[]
  warnings: CandidateSearchWarning[]
  /**
   * The sources the context's `excludedSourceOwnedWeaponIds` removed from this
   * primitive's Route base enumeration (`docs/SEARCH_SPEC.md` 3.3). Absent
   * when nothing was removed.
   */
  excludedSourceOwnedWeaponIds?: OwnedWeaponId[]
  /** Finalize reporting after scheduled work has settled. */
  finalize?(): void
}

/**
 * What the Route search primitives actually read: the semantic Search / RNG
 * origin and the one extent the Route base registration itself needs.
 *
 * It is deliberately not a `CandidateSearchInput`. `searchRunId`, the
 * `routeFilter` and the rest of `CandidateSearchSettings` are ordinary
 * Candidate Search request data, so the same primitives can serve a consumer
 * that has none of them - Planner Alternative Search (`docs/SEARCH_SPEC.md`
 * 5.6.8) - without fabricating a request. The two stream extents belong to the
 * streams (`SkillStreamInput` / `BonusStreamInput`), not here.
 */
export interface RouteSearchInput {
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  ownedWeapons: OwnedWeapon[]
  master: SearchMasterSubset
  /**
   * SEARCH_SPEC 3.1 `maxNormalAdvance`: the maximum forge count of one Normal
   * Artian Route base, never the maximum offset.
   */
  maxNormalAdvance: number
}

/**
 * Which consumer's frontier the Route search primitives and the scheduler
 * build over the same streams.
 *
 * - `initial_candidate_search`: the ordinary Candidate Search. Its initial-Search
 *   policies apply: same-result retention (SEARCH_SPEC 5.5.2 / 5.5.3), Cross-only
 *   composition (5.5.4) and the #104 Normal Route base reduction (6.1.2).
 * - `planner_alternative`: Planner Alternative Search (5.6.8). None of those
 *   three applies: every absolute stream position is considered independently
 *   and every Ideal position is published for composition, every Ideal Bonus x
 *   Ideal Skill pair is composed lazily, and every predicted Normal offset of
 *   the extent is a full Route base. The streams themselves, their prediction
 *   memos and the B2 family-layout frontier reduction are the same.
 */
export type SearchFrontierPolicy = 'initial_candidate_search' | 'planner_alternative'

/**
 * Which operations the lanes of one shape-constrained Route base use
 * (`docs/SEARCH_SPEC.md` 5.6.9). They decide which stream bases a constrained
 * Route search primitive builds and which prediction support it requires; an
 * operation the shape forbids is never a requirement and its support is never
 * queried.
 */
export interface RouteBaseLaneNeeds {
  /** The Skill lane reads the Reset Skills stream (lane `reset_skills`). */
  skillStream: boolean
  /** The Bonus lane's own operations (`none` for the zero-operation lane). */
  bonusOperations: 'none' | 'reset' | 'keep' | 'reset_then_keep'
}

/**
 * The Route base restriction of the shape-constrained Route
 * search (`docs/SEARCH_SPEC.md` 5.6.9).
 * Only the shape-constrained Route search sets it; Candidate Search and
 * Planner Alternative Search never do.
 *
 * A Route search primitive reads it before it generates any Route base: only
 * the primitive of the shape's base kind runs, and it enumerates only the
 * shape's OwnedWeapon, or the shape's Normal Counter and production target
 * position, and converts only at the shape's conversion Skill position (the
 * intersection with the formal legal positions of `conversionSkillPositions()`).
 * It is a separate input from the formal reservation, which it never edits:
 * the exclusive-source rule and the protected-weapon rule still apply on their
 * own.
 */
export type RouteBaseConstraint = { lanes: RouteBaseLaneNeeds } & (
  | { kind: 'owned_gogma'; ownedWeaponId: OwnedWeaponId }
  | { kind: 'owned_normal'; ownedWeaponId: OwnedWeaponId; conversionSkillPosition: number }
  | { kind: 'new_normal'; counterId: NormalArtianCounter['id']; productionTargetPosition: number; conversionSkillPosition: number }
)

export interface RouteSearchContext {
  /** Absent means the ordinary `initial_candidate_search` policy. */
  frontierPolicy?: SearchFrontierPolicy
  /**
   * The fixed Route set's resource reservation (`docs/SEARCH_SPEC.md` 5.6.8).
   * Only Planner Alternative Search sets it; absent means an empty reservation,
   * which every ordinary Candidate Search context is.
   */
  reservation?: RouteSearchReservation
  /**
   * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): the shape-constrained Route
   * search's Route base restriction. Absent in every Candidate Search and Planner Alternative Search context, where
   * every primitive enumerates exactly as before.
   */
  routeBaseConstraint?: RouteBaseConstraint
  /**
   * Shape-constrained Route search only (`docs/SEARCH_SPEC.md` 5.6.9): the final base admission and
   * lane decision the `TargetSearchScheduler` of this context applies. Absent in
   * every Candidate Search and Planner Alternative Search context, where the scheduler registers every base by the
   * lane-start Ideal rule exactly as before.
   */
  routeShapeFilter?: ScheduledRouteShapeFilter
  /**
   * Ordinary Candidate Search only (`docs/SEARCH_SPEC.md` 3.3): the request's
   * `excludedSourceOwnedWeaponIds`. Absent in every Planner Alternative Search,
   * shape-constrained Route search and constrained enumeration context, where
   * every source is enumerated exactly as before; an empty set is the same.
   *
   * It is not a reservation: it carries none of the reservation's held or
   * conversion position rules, and the Route search primitives apply it on top
   * of the source rules (reservation, shape, compatibility, protection) so
   * they can tell the RouteKinds it emptied apart from the ones that had no
   * source anyway.
   */
  excludedSourceOwnedWeaponIds?: ReadonlySet<OwnedWeaponId>
  /** Normal predictions shared across counter records. */
  normalPredictions?: Map<number, RestorationBonusSet>
  target: TargetWeapon
  input: RouteSearchInput
  engine: RngEngine
  execution: SearchExecutionContext
  predictionSupport: SearchPredictionSupport
  /** Solved once per Target; never re-entered from inside a Gogma state. */
  skillStream: TargetSkillStream
  /** Solved once per Route base class; never re-entered from a Skill result. */
  bonusStream: TargetBonusStream
}

/**
 * The ordinary Candidate Search's Route search context.
 *
 * Only the ordinary materialization (`createBaseCandidate()`) reads
 * `searchInput`: its `searchRunId` and `CalculationContext` belong to the
 * `BuildCandidate` it builds. The Route search primitives themselves read
 * `input` alone.
 */
export interface CandidateSearchRouteContext extends RouteSearchContext {
  searchInput: CandidateSearchInput
}

/**
 * A Route base as defined by SEARCH_SPEC 5.5.1: one Normal Counter and
 * `candidateOffset`, one owned Normal source, or one owned Gogma source.
 *
 * The Bonus and Skill stream predictions are shared across Route bases, but the
 * base itself is not: a different source OwnedWeapon, a different forge count,
 * or different inherited five slots stay separate Route bases even when they
 * reach the same completed result. Initial Search may omit strictly dominated new
 * Normal registrations (SEARCH_SPEC 6.1.2), without changing that identity.
 */
export interface RouteCompositionBase {
  /**
   * Conversion Routes have a fixed RouteKind. Existing-Gogma Routes derive it
   * from the composed `(gogmaAdvance, resetCount)` pair instead.
   */
  kindResolution:
    | { type: 'fixed'; kind: BuildRoute['kind'] }
    | { type: 'existing_gogma' }
  sourceOwnedWeaponId: OwnedWeaponId | null
  /** `create_normal_artian` / `convert_normal_to_gogma`, in execution order. */
  baseOperations: readonly RouteOperation[]
  /**
   * The Skills `convert_normal_to_gogma` assigns for this base, or `null` for a
   * base without a conversion (SEARCH_SPEC 5.5.2.2).
   *
   * Required rather than optional so every Route base states which case it is:
   * an existing-Gogma base's own current Skills are not a conversion result and
   * must never be reported as one.
   */
  conversionSkill: SkillAmendmentResult | null
  bonusSolutions: readonly RouteBonusSolution[]
  skillSolutions: readonly RouteSkillSolution[]
}

/**
 * The Skill positions a `convert_normal_to_gogma` may stand at
 * (`docs/SEARCH_SPEC.md` 5.6.8): with no reservation, the origin alone, as in
 * the ordinary Search. Under a reservation the conversion stands at a position
 * that is not blocked and that every position from the origin up to it is held,
 * because the weapon does not exist in the Skill stream before its conversion;
 * so the fixed Route's Skill positions are crossed, never filled with a fake
 * Reset Skills. The window is the conversion Route's Skill window
 * (`origin .. origin + maxSkillAdvance`); a legal position beyond it is
 * reported as `beyondExtent`.
 */
export async function conversionSkillPositions(
  context: RouteSearchContext,
  origin: number,
): Promise<{ positions: number[]; beyondExtent: boolean }> {
  const legal = await legalConversionSkillPositions(context, origin)
  const constraint = context.routeBaseConstraint
  if (constraint === undefined) return legal
  // Shape constraint (5.6.9): the formal legal positions are always
  // walked; only the shape's own position survives, and a position outside the
  // shape is no unread work, so no extent stop is reported for it.
  if (constraint.kind === 'owned_gogma') {
    throw new Error('An owned-Gogma Route base constraint has no conversion Skill position.')
  }
  return {
    positions: legal.positions.filter((position) => position === constraint.conversionSkillPosition),
    beyondExtent: false,
  }
}

/**
 * The formal legal conversion Skill positions of `conversionSkillPositions()`
 * before any shape restriction: the same walk, with the same
 * checkpoints, whether or not a `routeBaseConstraint` is set.
 */
export async function legalConversionSkillPositions(
  context: RouteSearchContext,
  origin: number,
): Promise<{ positions: number[]; beyondExtent: boolean }> {
  const reservation = context.reservation
  if (reservation === undefined) return { positions: [origin], beyondExtent: false }
  const { positions, beyondLimit } = await nextOperationPositions(
    reservation.skill,
    origin,
    reservation.conversionSkillPositionLimit,
    context.execution.checkpoint,
  )
  return { positions, beyondExtent: beyondLimit }
}

/**
 * Why the Bonus lane of a shape-constrained Route base cannot have a
 * Bonus stream base (`docs/SEARCH_SPEC.md` 5.6.9), or `null` when it can.
 *
 * Only the operations the shape's Bonus lane uses are required: confirmed
 * Gogma inputs and Gogma prediction for any stream lane, Reset Bonuses support
 * only when the lane resets, Keep Bonuses capability only when it keeps. The
 * Keep support of one concrete input is the stream's to evaluate, at the stage
 * and state that Keeps. The constrained Route search primitives and the
 * shape base diagnosis share this one authority, so they never disagree.
 */
export type RouteBaseLaneBlocker =
  | {
      kind: 'capability_unavailable'
      capability: 'gogma' | 'keep_bonuses'
      cause: 'rng_input_unconfirmed' | 'engine_capability_unavailable'
    }
  | { kind: 'prediction_unsupported'; prediction: 'gogma_reset'; reason: RngPredictionUnsupportedReason }

export function constrainedBonusLaneCapabilityBlocker(
  context: RouteSearchContext,
  operations: RouteBaseLaneNeeds['bonusOperations'],
): RouteBaseLaneBlocker | null {
  if (operations === 'none') return null
  if (!hasConfirmedGogmaInputs(context.input)) {
    return { kind: 'capability_unavailable', capability: 'gogma', cause: 'rng_input_unconfirmed' }
  }
  if (!context.engine.capabilities.supportsGogmaPrediction) {
    return { kind: 'capability_unavailable', capability: 'gogma', cause: 'engine_capability_unavailable' }
  }
  if ((operations === 'keep' || operations === 'reset_then_keep') && !context.engine.capabilities.supportsKeepBonusesPrediction) {
    return { kind: 'capability_unavailable', capability: 'keep_bonuses', cause: 'engine_capability_unavailable' }
  }
  return null
}

export function constrainedBonusLaneSupportBlocker(
  context: RouteSearchContext,
  operations: RouteBaseLaneNeeds['bonusOperations'],
): RouteBaseLaneBlocker | null {
  if (operations !== 'reset' && operations !== 'reset_then_keep') return null
  const support = context.predictionSupport.gogmaReset()
  return support.supported ? null : { kind: 'prediction_unsupported', prediction: 'gogma_reset', reason: support.reason }
}

/** Whether a constrained Bonus lane gets a Bonus stream base: neither blocker applies. */
export function constrainedBonusLaneAvailable(
  context: RouteSearchContext,
  operations: RouteBaseLaneNeeds['bonusOperations'],
): boolean {
  return operations !== 'none'
    && constrainedBonusLaneCapabilityBlocker(context, operations) === null
    && constrainedBonusLaneSupportBlocker(context, operations) === null
}

/**
 * Whether an OwnedWeapon may be a Route source here: always in the ordinary
 * Search; never under a Planner reservation that holds it exclusively for a
 * fixed Route (`docs/PLANNER_SPEC.md` 9.2.19.3). A preferred weapon is no
 * exception - the preference is a soft ordering, the reservation a hard rule.
 */
export function isAvailableRouteSource(
  context: RouteSearchContext,
  ownedWeaponId: OwnedWeaponId,
): boolean {
  return !(context.reservation?.exclusiveOwnedWeaponIds.has(ownedWeaponId) ?? false)
}

/**
 * Splits the sources the existing rules admit into the ones the ordinary
 * Candidate Search request keeps and the ones its source exclusion removes
 * (`docs/SEARCH_SPEC.md` 3.3). Order is preserved on both sides. Without an
 * exclusion every source is kept, so a context of any other consumer is
 * unaffected.
 */
export function partitionExcludedRouteSources<T extends { id: OwnedWeaponId }>(
  context: RouteSearchContext,
  sources: readonly T[],
): { kept: T[]; excluded: T[] } {
  const exclusion = context.excludedSourceOwnedWeaponIds
  if (exclusion === undefined || exclusion.size === 0) return { kept: [...sources], excluded: [] }
  const kept: T[] = []
  const excluded: T[] = []
  for (const source of sources) (exclusion.has(source.id) ? excluded : kept).push(source)
  return { kept, excluded }
}

/**
 * A Skill stream whose current Skills already satisfy the Ideal Skill condition
 * is finished: Ideal implies Practical, so no later Skill position can produce a
 * higher category. Only the Skill stream stops; the Bonus stream is unaffected.
 */
export function skillsSatisfyIdeal(
  context: RouteSearchContext,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): boolean {
  return evaluateSkillCondition(
    context.target.idealSkillCondition,
    seriesSkillId,
    groupSkillId,
  )
}

/**
 * The Bonus-stream counterpart of `skillsSatisfyIdeal` (SEARCH_SPEC 5.6.1).
 * A Route base whose current Gogma-scope five slots match `idealBonuses`
 * searches no Bonus amendment at all, so it consumes no `maxGogmaAdvance` position and
 * calls `predictGogmaBonus` zero times. The Skill stream keeps running.
 */
export function bonusesSatisfyIdeal(
  context: RouteSearchContext,
  bonuses: RestorationBonusSet,
  restorationBonusScope: RestorationBonusScope,
): boolean {
  return satisfiesIdealBonuses(context.target, bonuses, restorationBonusScope, context.input.master)
}

/**
 * The Route base's Skill solutions: the zero-operation solution plus the shared
 * stream's Reset Skills solutions (SEARCH_SPEC 5.5.2 / 5.5.5).
 *
 * `set` is `null` when the Skill stream was not solved for this base, either
 * because Skill prediction is unavailable or because the current Skills already
 * satisfy the Ideal condition. The zero-operation solution still exists.
 */
export function routeSkillSolutions(
  set: SkillStreamSolutionSet | null,
  zeroSolution: RouteSkillSolution,
  sourceOwnedWeaponId: OwnedWeaponId | null,
  skillAdvanceOffset: number,
): RouteSkillSolution[] {
  if (!set) return [zeroSolution]
  return [
    zeroSolution,
    ...set.solutions.map((solution) => ({
      resetCount: solution.resetCount,
      seriesSkillId: solution.seriesSkillId,
      groupSkillId: solution.groupSkillId,
      estimatedSkillAdvance: solution.resetCount + skillAdvanceOffset,
      operations: resetSkillsOperations(
        set,
        solution.resetCount,
        sourceOwnedWeaponId,
      ),
      amendmentResults: skillAmendmentResults(set, solution.resetCount),
    })),
  ]
}

/**
 * The Route base's Bonus solutions: the zero-operation solution plus the shared
 * stream's amendment solutions (SEARCH_SPEC 5.5.3 / 5.5.5).
 *
 * `set` is `null` when no amendment was searched for this base, either because
 * Gogma prediction is unavailable, the source is protected, or the current
 * Gogma-scope five slots already match `idealBonuses`.
 */
export function routeBonusSolutions(
  set: BonusStreamSolutionSet | null,
  zeroSolution: RouteBonusSolution,
  sourceOwnedWeaponId: OwnedWeaponId | null,
): RouteBonusSolution[] {
  if (!set) return [zeroSolution]
  return [
    zeroSolution,
    ...set.solutions.map((solution) => ({
      gogmaAdvance: solution.depth,
      lastResetDepth: solution.lastResetDepth,
      finalBonuses: solution.bonuses,
      restorationBonusScope: solution.restorationBonusScope,
      operations: bonusAmendmentOperations(set, solution, sourceOwnedWeaponId),
      amendmentResults: bonusAmendmentResults(solution),
    })),
  ]
}

/**
 * The Search composition boundary's fail-loud check that a conversion Route
 * really carries its conversion Skill observation and a non-conversion Route
 * does not (SEARCH_SPEC 5.5.2.2).
 *
 * The correspondence is structural here rather than best effort: every Search
 * Route base states its `conversionSkill`, so a base whose operations disagree
 * with it is an internal inconsistency, never a Candidate that silently drops
 * the display.
 */
export function conversionSkillPrediction(
  route: BuildRoute,
  conversionSkill: SkillAmendmentResult | null,
): SkillAmendmentResult | undefined {
  const hasConversion = route.operations.some(
    (operation) => operation.type === 'convert_normal_to_gogma',
  )
  if (hasConversion === (conversionSkill !== null)) {
    return conversionSkill ?? undefined
  }
  throw new CandidateSearchError(
    'invalid_candidate',
    hasConversion
      ? 'A conversion Route base must supply the predicted initial Skills of its conversion.'
      : 'A Route base without a conversion operation must not supply a conversion Skill result.',
  )
}

export function createBaseCandidate(
  context: CandidateSearchRouteContext,
  bonuses: RestorationBonusSet,
  restorationBonusScope: RestorationBonusScope,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
  route: BuildRoute,
  bonusAmendmentResults: readonly BonusAmendmentResult[],
  skillAmendmentResults: readonly SkillAmendmentResult[],
  conversionSkill: SkillAmendmentResult | null,
): BuildCandidate | null {
  const conversionSkillResult = conversionSkillPrediction(route, conversionSkill)
  return createCandidateFromPrediction(
    context.target,
    {
      finalBonuses: bonuses,
      restorationBonusScope,
      seriesSkillId,
      groupSkillId,
      route,
      bonusAmendmentResults,
      skillAmendmentResults,
      ...(conversionSkillResult === undefined ? {} : { conversionSkillResult }),
    },
    context.searchInput,
    context.execution,
  )
}

/**
 * The existing-Gogma RouteKind of one composed `(d, k)` pair.
 *
 * The canonical amendment history is Reset for depths `1 ... lastResetDepth`
 * and Keep afterwards, so the Bonus-only kind follows from those two numbers.
 * `d = 0` with `k = 0` is the current, zero-operation Candidate. It keeps a
 * protected source visible when its current performance satisfies the Target
 * without opening any amendment stream.
 */
export function existingGogmaRouteKind(
  bonus: RouteBonusSolution,
  skill: RouteSkillSolution,
): BuildRoute['kind'] {
  if (bonus.gogmaAdvance === 0) {
    return skill.resetCount === 0
      ? 'existing_gogma_current'
      : 'existing_gogma_reset_skills'
  }
  if (skill.resetCount > 0) return 'existing_gogma_mixed'
  if (bonus.lastResetDepth === bonus.gogmaAdvance) {
    return 'existing_gogma_reset_bonuses'
  }
  return bonus.lastResetDepth === 0
    ? 'existing_gogma_keep_bonuses'
    : 'existing_gogma_mixed'
}

function routeKindFor(
  base: RouteCompositionBase,
  bonus: RouteBonusSolution,
  skill: RouteSkillSolution,
): BuildRoute['kind'] {
  return base.kindResolution.type === 'fixed'
    ? base.kindResolution.kind
    : existingGogmaRouteKind(bonus, skill)
}

/**
 * Composes one Route base's independently solved Bonus and Skill solutions with
 * the Cross rule (SEARCH_SPEC 5.5.4).
 *
 * No prediction happens here, so composing more Bonus states, more source
 * weapons, or more Normal offsets never adds a `predictSkills` or
 * `predictGogmaBonus` call. The number of Candidates built per Route base is
 * bounded by `|B| + |K| - 1`, never by `|B| * |K|`.
 *
 * Only the Ideal axes take part: a composed Search result is always an Ideal
 * Candidate, and a compromise state is offered only as a checkpoint on the
 * canonical Ideal Route.
 */
export async function composeRouteCandidates(
  context: CandidateSearchRouteContext,
  base: RouteCompositionBase,
): Promise<BuildCandidate[]> {
  const bonusSet = buildBonusSolutionSet(
    context.target,
    context.input,
    base.bonusSolutions,
  )
  const skillSet = buildSkillSolutionSet(context.target, base.skillSolutions)
  const candidates: BuildCandidate[] = []
  const pairs = crossStreamSolutions(
    selectIdealBonusAxis(bonusSet),
    selectIdealSkillAxis(skillSet),
  )
  for (const pair of pairs) {
    const bonus = pair.bonus.solution
    const skill = pair.skill.solution
    const kind = routeKindFor(base, bonus, skill)
    const operations = [
      ...base.baseOperations,
      ...bonus.operations,
      ...skill.operations,
    ]
    await context.execution.checkpoint()
    const candidate = createBaseCandidate(
      context,
      bonus.finalBonuses,
      bonus.restorationBonusScope,
      skill.seriesSkillId,
      skill.groupSkillId,
      { kind, sourceOwnedWeaponId: base.sourceOwnedWeaponId, operations },
      bonus.amendmentResults,
      skill.amendmentResults,
      base.conversionSkill,
    )
    if (candidate) candidates.push(candidate)
  }
  return candidates
}
