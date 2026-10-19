/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.12), Stage D (moved from the Global Assignment Research
 * Phase D-0A-2b, Issue #154).
 *
 * The request side of the shape-constrained route generation: the conversion of an `ExpectedRouteShape` into the shape-constrained
 * Route search's `RouteShapeConstraint` (`docs/SEARCH_SPEC.md` 5.6.9), the deterministic search identity, the position premises of
 * the minimal Route, the assembly of one request from a formal reservation, and the method rule of one Target.
 *
 * Every function is pure and reads the shape, the formal reservation and the Planner-start PlannerInput only: no prediction, no
 * Search, no Clock, no UUID, no enumeration ordinal and no delivery order. The formal reservation itself is derived by the caller
 * and is never edited here: the expected source, conversion position and production target restrict the Search's Route base
 * through the shape, never through held / blocked.
 */
import { hashStableValue } from '../../models/publicTypes'
import type { BuildListEntryId } from '../../models/publicTypes'
import { normalizePlannerAlternativeReservation, type PlannerAlternativeReservation } from '../../search/alternative'
import { createCounterReservation } from '../../search/counterReservation'
import type { RouteShapeConstraint } from '../../search/shapeConstrained'
import type { PlannerInput } from '../plannerTypes'
import { createPlannerStartSearchOrigin, normalizePlannerSearchOrigin, resolvePlannerSearchOriginTarget } from '../replacement/plannerSearchOrigin'
import type { BuildListOptimizationContext, ReachTable } from './buildListOptimizationTypes'
import type { ExpectedRouteShape } from './coverageTypes'
import { detectRouteContinuation, plannerStartOrigins, shapeSearchExtent, type ShapeOwnPositions } from './routeShape'
import {
  BuildListOptimizationMaterializationError,
  type MinimalRoutePremiseViolation, type PredictedSearchScale, type RouteGenerationIdentityTokens, type RouteGenerationMethodSelection,
  type ShapeConstrainedRouteRequest, type ShapeSearchScale,
} from './routeGenerationTypes'
import { predictShapeConstrainedSearchScale } from './shapeSearchScale'

function invalidShape(shape: ExpectedRouteShape, message: string): never {
  throw new BuildListOptimizationMaterializationError('invalid_shape', shape.targetWeaponId, `Target ${shape.targetWeaponId}: ${message}`)
}

/**
 * The Search's shape, read from `shape.option` alone (one value per option, no game state and no expected prediction is made up):
 *
 *   source owned_gogma -> base owned_gogma; owned_normal -> base owned_normal (c); new_normal -> base new_normal (Counter, p, c)
 *   Skill  none -> zero; reset_skills(s*) -> reset_skills(s*); conversion(c, c) -> zero; conversion(c, s*), c < s* -> reset_skills(s*)
 *   Bonus  none -> zero; reset(g*) -> reset(g*); keep_from_source(g*) -> keep(g*); reset_then_keep(g1, g*) -> reset_then_keep(g1, g*)
 *
 * A combination the ReachTable never builds (a conversion without a conversion source, a Normal source without a conversion or
 * with a zero Bonus lane, a production target that is not the source's) is an internal inconsistency: `invalid_shape`.
 */
export function toRouteShapeConstraint(shape: ExpectedRouteShape): RouteShapeConstraint {
  const option = shape.option
  const { source, skillRequired: skill, bonusRequired: bonus } = option
  let base: RouteShapeConstraint['base']
  let skillLane: RouteShapeConstraint['skill']
  if (source.kind === 'owned_gogma') {
    if (skill.kind === 'conversion') invalidShape(shape, 'an owned Gogma source has no conversion.')
    if (option.normalRequired !== null) invalidShape(shape, 'an owned Gogma source has no Normal production target.')
    base = { kind: 'owned_gogma', ownedWeaponId: source.ownedWeaponId }
    skillLane = skill.kind === 'none' ? { kind: 'zero' } : { kind: 'reset_skills', finalPosition: skill.finalPosition }
  } else {
    if (skill.kind !== 'conversion') invalidShape(shape, `a ${source.kind} source needs a conversion (got ${skill.kind}).`)
    if (skill.conversionPosition > skill.finalPosition) invalidShape(shape, `conversion ${skill.conversionPosition} follows its final Skill ${skill.finalPosition}.`)
    if (bonus.kind === 'none') invalidShape(shape, `a ${source.kind} source has no zero Bonus lane (its slots are normal_artian scope).`)
    skillLane = skill.conversionPosition === skill.finalPosition ? { kind: 'zero' } : { kind: 'reset_skills', finalPosition: skill.finalPosition }
    if (source.kind === 'owned_normal') {
      if (option.normalRequired !== null) invalidShape(shape, 'an owned Normal source has no Normal production target.')
      base = { kind: 'owned_normal', ownedWeaponId: source.ownedWeaponId, conversionSkillPosition: skill.conversionPosition }
    } else {
      const forge = option.normalRequired
      if (forge === null || forge.counterId !== source.counterId || forge.position !== source.position) {
        invalidShape(shape, 'a new Normal source needs its own production target on its own Counter.')
      }
      base = { kind: 'new_normal', counterId: source.counterId, productionTargetPosition: source.position, conversionSkillPosition: skill.conversionPosition }
    }
  }
  let bonusLane: RouteShapeConstraint['bonus']
  switch (bonus.kind) {
    case 'none': bonusLane = { kind: 'zero' }; break
    case 'reset': bonusLane = { kind: 'reset', finalPosition: bonus.finalPosition }; break
    case 'keep_from_source': bonusLane = { kind: 'keep', finalPosition: bonus.finalPosition }; break
    case 'reset_then_keep': bonusLane = { kind: 'reset_then_keep', resetPosition: bonus.resetPosition, finalPosition: bonus.finalPosition }; break
  }
  return { base, skill: skillLane, bonus: bonusLane }
}

/** The shape as a plain value with only its semantic fields (the identity's input). */
export function normalizeRouteShapeConstraint(shape: RouteShapeConstraint): RouteShapeConstraint {
  const base = shape.base
  return {
    base: base.kind === 'owned_gogma' ? { kind: base.kind, ownedWeaponId: base.ownedWeaponId }
      : base.kind === 'owned_normal' ? { kind: base.kind, ownedWeaponId: base.ownedWeaponId, conversionSkillPosition: base.conversionSkillPosition }
        : { kind: base.kind, counterId: base.counterId, productionTargetPosition: base.productionTargetPosition, conversionSkillPosition: base.conversionSkillPosition },
    skill: shape.skill.kind === 'zero' ? { kind: 'zero' } : { kind: 'reset_skills', finalPosition: shape.skill.finalPosition },
    bonus: shape.bonus.kind === 'zero' ? { kind: 'zero' }
      : shape.bonus.kind === 'reset_then_keep' ? { kind: 'reset_then_keep', resetPosition: shape.bonus.resetPosition, finalPosition: shape.bonus.finalPosition }
        : { kind: shape.bonus.kind, finalPosition: shape.bonus.finalPosition },
  }
}

/**
 * The deterministic search identity (also every Candidate's `searchRunId`): the caller's shape algorithm token and route policy, the
 * Target, the normalized Planner-start origin, the CalculationContext, the extent, the normalized formal reservation and the
 * normalized shape. No Clock, UUID, ordinal, delivery order or attempt count.
 */
export function shapeConstrainedSearchIdentity(input: {
  plannerInput: PlannerInput
  targetWeaponId: ShapeConstrainedRouteRequest['targetWeaponId']
  extent: ShapeConstrainedRouteRequest['extent']
  reservation: PlannerAlternativeReservation
  routeShape: RouteShapeConstraint
}, tokens: Pick<RouteGenerationIdentityTokens, 'shapeAlgorithm' | 'routePolicy' | 'shapeSearchIdentityPrefix'>): string {
  const origin = createPlannerStartSearchOrigin(input.plannerInput)
  const target = resolvePlannerSearchOriginTarget(origin, input.targetWeaponId)
  const context = origin.calculationContext
  return `${tokens.shapeSearchIdentityPrefix}${hashStableValue({
    algorithm: tokens.shapeAlgorithm,
    routePolicy: tokens.routePolicy,
    targetWeaponId: target.id,
    origin: normalizePlannerSearchOrigin(origin, target),
    calculationContext: { gameVersion: context.gameVersion, masterDataVersion: context.masterDataVersion, rngEngineVersion: context.rngEngineVersion, appSchemaVersion: context.appSchemaVersion },
    extent: { maxNormalAdvance: input.extent.maxNormalAdvance, maxGogmaAdvance: input.extent.maxGogmaAdvance, maxSkillAdvance: input.extent.maxSkillAdvance },
    reservation: normalizePlannerAlternativeReservation(input.reservation),
    shape: normalizeRouteShapeConstraint(input.routeShape),
  }).replace(':', '-')}`
}

/**
 * The position premises the minimal Route needs, from positions and the PlannerInput alone - the source exists, is not exclusive
 * and, when operated, not protected; `c` is a formal legal conversion position; `p` lies in the Normal extent and is not blocked;
 * every required Skill / Gogma position lies in its window and is not blocked. Compatibility and convertibility are the Search's
 * base diagnosis.
 */
export function checkMinimalRoutePremises(input: {
  routeShape: RouteShapeConstraint
  reservation: PlannerAlternativeReservation
  origins: ShapeConstrainedRouteRequest['origins']
  extent: ShapeConstrainedRouteRequest['extent']
  scale: ShapeSearchScale
  plannerInput: PlannerInput
}): MinimalRoutePremiseViolation[] {
  const { routeShape, reservation, origins, extent, scale } = input
  const violations: MinimalRoutePremiseViolation[] = []
  const base = routeShape.base
  const operatesSource = base.kind !== 'owned_gogma' || routeShape.skill.kind !== 'zero' || routeShape.bonus.kind !== 'zero'
  if (base.kind !== 'new_normal') {
    const weapon = input.plannerInput.ownedWeapons.find(value => value.id === base.ownedWeaponId)
    if (weapon === undefined) violations.push({ kind: 'source_not_found', ownedWeaponId: base.ownedWeaponId })
    else {
      if (reservation.exclusiveOwnedWeaponIds.includes(weapon.id)) violations.push({ kind: 'source_exclusive', ownedWeaponId: weapon.id })
      if (weapon.isProtected && operatesSource) violations.push({ kind: 'source_protected', ownedWeaponId: weapon.id })
    }
  }
  if (base.kind !== 'owned_gogma' && !scale.conversionLegal) {
    violations.push({ kind: 'conversion_position_not_legal', position: base.conversionSkillPosition, legalPositions: [...scale.conversionLegalPositions] })
  }
  if (base.kind === 'new_normal') {
    if (origins.normal === null) violations.push({ kind: 'normal_counter_origin_missing', counterId: base.counterId })
    else {
      const offset = base.productionTargetPosition - origins.normal.position
      if (offset < 0 || offset >= extent.maxNormalAdvance) violations.push({ kind: 'production_target_outside_extent', counterId: base.counterId, position: base.productionTargetPosition })
      const normal = reservation.normal.find(value => value.counterId === base.counterId)
      if (normal !== undefined && normal.blocked.includes(base.productionTargetPosition)) violations.push({ kind: 'production_target_blocked', counterId: base.counterId, position: base.productionTargetPosition })
    }
  }
  const skillReservation = createCounterReservation(reservation.skill.held, reservation.skill.blocked)
  const gogmaReservation = createCounterReservation(reservation.gogma.held, reservation.gogma.blocked)
  if (routeShape.skill.kind === 'reset_skills') {
    const position = routeShape.skill.finalPosition
    const window = { from: base.kind === 'owned_gogma' ? origins.skill : base.conversionSkillPosition + 1, to: origins.skill + extent.maxSkillAdvance - (base.kind === 'owned_gogma' ? 1 : 0) }
    if (position < window.from || position > window.to) violations.push({ kind: 'required_position_outside_extent', stream: 'skill', position, window })
    if (skillReservation.isBlocked(position)) violations.push({ kind: 'required_position_blocked', stream: 'skill', position })
  }
  if (routeShape.bonus.kind !== 'zero') {
    const window = { from: origins.gogma, to: origins.gogma + extent.maxGogmaAdvance - 1 }
    const positions = routeShape.bonus.kind === 'reset_then_keep' ? [routeShape.bonus.resetPosition, routeShape.bonus.finalPosition] : [routeShape.bonus.finalPosition]
    for (const position of positions) {
      if (position < window.from || position > window.to) violations.push({ kind: 'required_position_outside_extent', stream: 'gogma', position, window })
      if (gogmaReservation.isBlocked(position)) violations.push({ kind: 'required_position_blocked', stream: 'gogma', position })
    }
  }
  return violations
}

/**
 * One shape-constrained request from the shape and the formal reservation of the Entries the caller generated before it
 * (`reservationSourceEntryIds`, in materialization order). The extent is the shape's from the Planner-start origins.
 */
export async function assembleShapeConstrainedRouteRequest(input: {
  shape: ExpectedRouteShape
  reservation: PlannerAlternativeReservation
  reservationSourceEntryIds: BuildListEntryId[]
  context: Pick<BuildListOptimizationContext, 'plannerInput'>
  table: Pick<ReachTable, 'originSkill' | 'originGogma' | 'originNormal'>
}, tokens: Pick<RouteGenerationIdentityTokens, 'shapeAlgorithm' | 'routePolicy' | 'shapeSearchIdentityPrefix'>): Promise<ShapeConstrainedRouteRequest> {
  const { shape, reservation, context, table } = input
  const routeShape = toRouteShapeConstraint(shape)
  const streamOrigins = plannerStartOrigins(shape, table)
  const forge = shape.option.normalRequired
  const origins: ShapeConstrainedRouteRequest['origins'] = {
    skill: streamOrigins.skill,
    gogma: streamOrigins.gogma,
    normal: forge === null ? null : { counterId: forge.counterId, position: streamOrigins.normal! },
  }
  const extent = { ...shapeSearchExtent(shape, streamOrigins) }
  const predictedScale = await predictShapeConstrainedSearchScale({ routeShape, reservation, origins, extent })
  return {
    method: 'shape_constrained',
    targetWeaponId: shape.targetWeaponId,
    shape,
    routeShape,
    reservation,
    reservationSourceEntryIds: [...input.reservationSourceEntryIds],
    origins,
    extent,
    searchIdentity: shapeConstrainedSearchIdentity({ plannerInput: context.plannerInput, targetWeaponId: shape.targetWeaponId, extent, reservation, routeShape }, tokens),
    predictedScale,
    premiseViolations: checkMinimalRoutePremises({ routeShape, reservation, origins, extent, scale: predictedScale, plannerInput: context.plannerInput }),
  }
}

/**
 * The deterministic method order of one Target, from the ReachTable, the shape and its own positions only (never a delivery order,
 * a timing or an earlier result):
 *
 *   continuation shape                      -> shape_constrained
 *   continuous (one run per stream)         -> candidate_search_projected, then shape_constrained once when it does not match
 *   non-continuous (crosses held positions) -> shape_constrained
 *
 * Planner Alternative Search is never part of this rule.
 */
export function selectRouteGenerationMethods(
  shape: ExpectedRouteShape,
  own: ShapeOwnPositions,
  table: Pick<ReachTable, 'targets'>,
  predicted: { shapeConstrained: ShapeSearchScale; projected: PredictedSearchScale | null },
): RouteGenerationMethodSelection {
  const continuation = detectRouteContinuation(shape.option, table)
  const common = {
    continuous: own.continuous, continuation,
    predictedSearchScale: { shapeConstrained: structuredClone(predicted.shapeConstrained), projected: predicted.projected === null ? null : { ...predicted.projected } },
  }
  if (continuation !== null) return { ...common, rule: 'continuation_shape_constrained_only', order: ['shape_constrained'] }
  if (own.continuous) {
    if (predicted.projected === null) invalidShape(shape, 'a continuous shape needs its projected request.')
    return { ...common, rule: 'continuous_projected_then_shape_constrained', order: ['candidate_search_projected', 'shape_constrained'] }
  }
  return { ...common, rule: 'non_continuous_shape_constrained_only', order: ['shape_constrained'] }
}
