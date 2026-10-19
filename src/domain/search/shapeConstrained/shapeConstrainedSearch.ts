import type { BuildRoute, RouteOperation } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import {
  createPlannerAlternativeFrontier,
  openPlannerAlternativeSearchSections,
  PLANNER_ALTERNATIVE_ROUTE_REGISTRATIONS,
  type PlannerAlternativeSearchExecutionOptions,
} from '../alternative/plannerAlternativeSearch'
import type { PlannerAlternativeCandidateVisitor } from '../alternative/plannerAlternativeTypes'
import type { UnsupportedAmendmentPrediction } from '../bonusStream'
import type { RouteBaseLaneNeeds } from '../routeSearchShared'
import type { SearchRuntimeSection } from '../searchRuntime'
import type {
  BonusStreamNotice,
  ScheduledRouteBase,
  ScheduledRouteLaneAdmission,
  ScheduledRouteShapeFilter,
} from '../targetSearchScheduler'
import { diagnoseShapeConstrainedBase } from './shapeConstrainedDiagnosis'
import {
  ShapeConstrainedSearchError,
  type RouteShapeConstraint,
  type ShapeConstrainedSearchExecution,
  type ShapeConstrainedSearchInput,
} from './shapeConstrainedTypes'
import {
  assertShapeConstrainedSearchInput,
  shapeConstrainedBonusPolicy,
  shapeConstrainedLaneNeeds,
  shapeConstrainedRouteBaseConstraint,
} from './shapeConstrainedValidation'

/** The one Route search primitive of each shape base kind (design 5.3 item 2). */
const PRIMITIVE_SECTION: Record<RouteShapeConstraint['base']['kind'], SearchRuntimeSection> = {
  owned_gogma: 'existing_gogma_route_registration',
  owned_normal: 'owned_normal_route_registration',
  new_normal: 'normal_route_registration',
}

const violation = (message: string): never => {
  throw new ShapeConstrainedSearchError('shape_search_contract_violation', message)
}

/** The Bonus operation kinds the shape allows, as unsupported notice types. */
function allowedBonusNotices(lanes: RouteBaseLaneNeeds): ReadonlySet<UnsupportedAmendmentPrediction['type']> {
  switch (lanes.bonusOperations) {
    case 'none': return new Set()
    case 'reset': return new Set(['reset_bonuses'])
    case 'keep': return new Set(['keep_bonuses'])
    case 'reset_then_keep': return new Set(['reset_bonuses', 'keep_bonuses'])
  }
}

/** Whether the base's own operations are exactly the shape's (source, Normal creation, conversion position). */
function baseMatchesShape(shape: RouteShapeConstraint, base: ScheduledRouteBase): boolean {
  const shapeBase = shape.base
  const operations = base.baseOperations
  switch (shapeBase.kind) {
    case 'owned_gogma':
      return base.kindResolution.type === 'existing_gogma' && base.sourceOwnedWeaponId === shapeBase.ownedWeaponId
        && operations.length === 0 && base.conversionSkill === null
    case 'owned_normal': {
      const [convert] = operations
      return base.kindResolution.type === 'fixed' && base.kindResolution.kind === 'owned_normal_artian_to_gogma'
        && base.sourceOwnedWeaponId === shapeBase.ownedWeaponId && operations.length === 1
        && convert?.type === 'convert_normal_to_gogma' && convert.skillCounterBefore === shapeBase.conversionSkillPosition
    }
    case 'new_normal': {
      const [create, convert] = operations
      return base.kindResolution.type === 'fixed' && base.kindResolution.kind === 'normal_artian_to_gogma'
        && base.sourceOwnedWeaponId === null && operations.length === 2
        && create?.type === 'create_normal_artian' && create.normalCounterBefore !== null && create.normalCounterAfter !== null
        && `${create.weaponTypeId}:${create.rarity}` === shapeBase.counterId
        && create.normalCounterAfter - 1 === shapeBase.productionTargetPosition
        && convert?.type === 'convert_normal_to_gogma' && convert.skillCounterBefore === shapeBase.conversionSkillPosition
    }
  }
}

/**
 * The final admission (design 5.3 item 7). The primitives already generated the shape's base alone, so a mismatch,
 * a missing stream base a lane needs, or a second base is a seam contract violation, never a shape verdict.
 */
function createShapeFilter(
  shape: RouteShapeConstraint,
  lanes: RouteBaseLaneNeeds,
  record: { admitted: boolean; required: UnsupportedAmendmentPrediction[]; forbidden: number },
): ScheduledRouteShapeFilter {
  const allowed = allowedBonusNotices(lanes)
  const bonusPolicy = shapeConstrainedBonusPolicy(shape.bonus)
  return {
    admit(base) {
      if (record.admitted) violation('A second Route base was offered for admission.')
      if (!baseMatchesShape(shape, base)) violation('A Route base that differs from the shape was offered for admission.')
      let skill: ScheduledRouteLaneAdmission['skill'] = { kind: 'zero' }
      if (shape.skill.kind === 'reset_skills') {
        if (base.startSkillCounter === null) violation('The admitted Route base has no Skill stream for the shape\'s Reset Skills lane.')
        skill = { kind: 'stream', finalPosition: shape.skill.finalPosition }
      }
      let bonus: ScheduledRouteLaneAdmission['bonus'] = { kind: 'zero' }
      if (shape.bonus.kind === 'zero') {
        if (base.zeroBonus === null) violation('The admitted Route base has no current five slots for the shape\'s zero Bonus lane.')
      } else {
        const streamBase = base.bonusBase
        if (streamBase === null || bonusPolicy === null) return violation('The admitted Route base has no Bonus stream for the shape\'s Bonus lane.')
        if (streamBase.amendmentPolicy !== undefined || streamBase.shapePolicy !== undefined) violation('A shape-constrained Bonus stream base carries no other stream policy.')
        bonus = { kind: 'stream', streamBase: { ...streamBase, shapePolicy: bonusPolicy }, finalPosition: shape.bonus.finalPosition }
      }
      record.admitted = true
      return { skill, bonus }
    },
    onBonusNotice(notice: BonusStreamNotice) {
      if (notice.type !== 'unsupported') return
      if (allowed.has(notice.prediction.type)) record.required.push(notice.prediction)
      else record.forbidden += 1
    },
  }
}

const lastPosition = (operations: readonly RouteOperation[], types: ReadonlyArray<RouteOperation['type']>) => {
  const own = operations.filter((operation) => types.includes(operation.type))
  const last = own[own.length - 1]
  if (last === undefined) return null
  return 'gogmaCounterBefore' in last ? last.gogmaCounterBefore : 'skillCounterBefore' in last ? last.skillCounterBefore : null
}

/** A delivered Route ends at the shape's final positions on both lanes (and has no operation on a zero lane). */
function routeEndsAtShape(shape: RouteShapeConstraint, route: BuildRoute): boolean {
  const skill = lastPosition(route.operations, ['reset_skills'])
  const bonus = lastPosition(route.operations, ['reset_bonuses', 'keep_bonuses'])
  return skill === (shape.skill.kind === 'zero' ? null : shape.skill.finalPosition)
    && bonus === (shape.bonus.kind === 'zero' ? null : shape.bonus.finalPosition)
}

/**
 * The shape-constrained Route search (`docs/SEARCH_SPEC.md` 5.6.9, `docs/PLANNER_GLOBAL_ASSIGNMENT_D0A2_DESIGN.md` 5.3):
 * the Production Search API the Build List global optimization (`docs/PLANNER_SPEC.md` 17) materializes a shape with,
 * first built for the Global Assignment Research (Issue #154 Phase D-0A-2a), which reuses it through its adapter. A
 * Route it delivers can hold a form ordinary Candidate Search never returns (a lane continued past an Ideal lane
 * start), so a caller verifies it independently before using it as a Candidate.
 *
 * It is Planner Alternative Search's frontier (`createPlannerAlternativeFrontier()`: the same context, streams,
 * scheduler, Lazy Ideal Cross, Candidate factory, cost-layer buffer, six-key delivery, deduplication, consumer stop,
 * cancellation and yield) under the formal reservation, with the shape applied before any Route base exists:
 *
 * 1. validate the origin, Target, extent and reservation as Planner Alternative Search does, then the shape
 * 2. diagnose the shape's base with the primitives' own helpers (`ShapeBaseUnavailableReason`); when it cannot be
 *    reached, no primitive runs and the reason is returned
 * 3. run only the shape's Route search primitive, which enumerates only the shape's source, Counter, production
 *    target offset and conversion position (the intersection with the formal legal positions)
 * 4. admit that one base, open each lane as the shape says - a stream lane even when its start state is already
 *    Ideal - and read the Bonus stream under the shape's operation kind policy
 * 5. deliver, in the six-key order, only Routes whose last own Skill / Bonus operations stand at the shape's final
 *    positions
 *
 * It predicts nothing new, edits no reservation, decides no Planner question (Counter precondition, physical action
 * identity, inventory), produces no Candidate ID / timestamp / identity, and never states that a shape does not
 * exist: a diagnosis that passed with no registered base, or a delivered Route off the shape, rejects with
 * `shape_search_contract_violation`.
 */
export async function visitShapeConstrainedRouteCandidates(
  input: ShapeConstrainedSearchInput,
  engine: RngEngine,
  onCandidate: PlannerAlternativeCandidateVisitor,
  options: PlannerAlternativeSearchExecutionOptions = {},
): Promise<ShapeConstrainedSearchExecution> {
  openPlannerAlternativeSearchSections(options)
  const { target, reservation } = assertShapeConstrainedSearchInput(input)
  const { origin, extent, shape } = input
  if (engine.version !== origin.calculationContext.rngEngineVersion) {
    throw new ShapeConstrainedSearchError(
      'calculation_context_incompatible',
      'The RNG Engine version does not match the origin CalculationContext.',
    )
  }
  const lanes = shapeConstrainedLaneNeeds(shape)
  const record = { admitted: false, required: [] as UnsupportedAmendmentPrediction[], forbidden: 0 }
  const frontier = createPlannerAlternativeFrontier({
    target, reservation, origin, extent, engine, options,
    routeBaseConstraint: shapeConstrainedRouteBaseConstraint(shape),
    shapeFilter: createShapeFilter(shape, lanes, record),
  })

  const unavailable = await diagnoseShapeConstrainedBase(frontier.context, shape, lanes)
  if (unavailable !== null) {
    frontier.closeWithoutRun()
    return {
      targetWeaponId: target.id,
      summary: { deliveredCandidates: 0, exhausted: false, stoppedByExtent: false },
      stoppedByConsumer: false,
      base: { admitted: false, unavailable },
      requiredUnsupportedPredictions: [],
      forbiddenOperationNotices: 0,
    }
  }

  const section = PRIMITIVE_SECTION[shape.base.kind]
  const execution = await frontier.run({
    onCandidate: (candidate) => {
      if (!routeEndsAtShape(shape, candidate.route)) violation('A delivered Route does not end at the shape\'s final positions.')
      return onCandidate(candidate)
    },
    registrations: PLANNER_ALTERNATIVE_ROUTE_REGISTRATIONS.filter(([registration]) => registration === section),
    excludedRouteKeys: [],
  })
  if (!record.admitted) violation('The base diagnosis passed but the shape\'s Route base was never registered.')
  return {
    targetWeaponId: execution.targetWeaponId,
    summary: {
      deliveredCandidates: execution.summary.deliveredCandidates,
      exhausted: execution.summary.exhausted,
      stoppedByExtent: execution.summary.stoppedByExtent,
    },
    stoppedByConsumer: execution.stoppedByConsumer,
    base: { admitted: true, unavailable: null },
    requiredUnsupportedPredictions: [...record.required],
    forbiddenOperationNotices: record.forbidden,
  }
}
