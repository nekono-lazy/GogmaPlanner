import type { OwnedWeapon } from '../../models/publicTypes'
import {
  selectCompatibleOwnedGogmaWeapons,
  selectCompatibleOwnedNormalArtianWeapons,
  selectConvertibleOwnedNormalArtianWeapons,
  selectSearchableNormalCounters,
} from '../routeEligibility'
import {
  constrainedBonusLaneCapabilityBlocker,
  constrainedBonusLaneSupportBlocker,
  hasConfirmedSkillInputs,
  isAvailableRouteSource,
  legalConversionSkillPositions,
  type RouteBaseLaneNeeds,
  type RouteSearchContext,
} from '../routeSearchShared'
import { EMPTY_COUNTER_RESERVATION } from '../counterReservation'
import type { RouteShapeConstraint, ShapeBaseUnavailableReason } from './shapeConstrainedTypes'

/*
 * The base diagnosis of the shape-constrained Route search (`docs/SEARCH_SPEC.md` 5.6.9,
 * `docs/PLANNER_GLOBAL_ASSIGNMENT_D0A2_DESIGN.md` 5.3 item 3): whether the
 * shape's Route base can be reached, evaluated before any Route search primitive runs, with the very helpers the
 * primitives use (the source selectors, `isAvailableRouteSource()`, `selectSearchableNormalCounters()`, the Normal
 * reservation, the formal `conversionSkillPositions()` walk, the Engine capabilities, the cached prediction support
 * and the shared constrained Bonus lane blockers), in the order source -> Counter / production target -> conversion
 * position -> capability -> support of the operations the lanes use. It predicts nothing, queries no support of an
 * operation the shape does not use, and decides no admission: the primitives and the base admission still do.
 */

/** The protected-weapon rule: a protected owned Gogma is operable only by a zero-operation shape. */
const operatesOnSource = (lanes: RouteBaseLaneNeeds) => lanes.skillStream || lanes.bonusOperations !== 'none'

function capabilityOfSkill(context: RouteSearchContext): ShapeBaseUnavailableReason | null {
  if (!hasConfirmedSkillInputs(context.input)) return { kind: 'capability_unavailable', capability: 'skill', cause: 'rng_input_unconfirmed' }
  if (!context.engine.capabilities.supportsSkillPrediction) return { kind: 'capability_unavailable', capability: 'skill', cause: 'engine_capability_unavailable' }
  return null
}

function supportOfSkill(context: RouteSearchContext): ShapeBaseUnavailableReason | null {
  const support = context.predictionSupport.skill()
  return support.supported ? null : { kind: 'prediction_unsupported', prediction: 'skill', reason: support.reason }
}

/** The capability and support of the Bonus lane's own operations, and of a Keep lane's first input (the source's slots). */
function bonusCapability(context: RouteSearchContext, lanes: RouteBaseLaneNeeds): ShapeBaseUnavailableReason | null {
  return constrainedBonusLaneCapabilityBlocker(context, lanes.bonusOperations)
}

function bonusSupport(
  context: RouteSearchContext,
  lanes: RouteBaseLaneNeeds,
  source: OwnedWeapon | null,
): ShapeBaseUnavailableReason | null {
  const blocker = constrainedBonusLaneSupportBlocker(context, lanes.bonusOperations)
  if (blocker !== null) return blocker
  // A `keep` lane Keeps the source's own slots first; a `reset_then_keep` lane's Keep input is a Reset result that
  // exists only inside the stream, and a new Normal's slots only after its prediction: the stream evaluates those.
  if (lanes.bonusOperations === 'keep' && source !== null) {
    const support = context.predictionSupport.gogmaKeep(source.restorationBonuses)
    if (!support.supported) return { kind: 'prediction_unsupported', prediction: 'gogma_keep', reason: support.reason }
  }
  return null
}

const first = (...reasons: Array<() => ShapeBaseUnavailableReason | null>) => {
  for (const reason of reasons) {
    const found = reason()
    if (found !== null) return found
  }
  return null
}

async function conversionPosition(
  context: RouteSearchContext,
  conversionSkillPosition: number,
): Promise<ShapeBaseUnavailableReason | null> {
  const origin = context.input.rngState.skillCounter.value
  // The legal positions start at the confirmed Skill origin; without it the conversion is a capability matter.
  const unconfirmed = capabilityOfSkill(context)
  if (unconfirmed !== null && unconfirmed.kind === 'capability_unavailable' && unconfirmed.cause === 'rng_input_unconfirmed') return unconfirmed
  const legal = await legalConversionSkillPositions(context, origin as number)
  return legal.positions.includes(conversionSkillPosition)
    ? null
    : { kind: 'conversion_position_not_legal', legalPositions: legal.positions }
}

export async function diagnoseShapeConstrainedBase(
  context: RouteSearchContext,
  shape: RouteShapeConstraint,
  lanes: RouteBaseLaneNeeds,
): Promise<ShapeBaseUnavailableReason | null> {
  const { target, input } = context
  const base = shape.base
  switch (base.kind) {
    case 'owned_gogma': {
      const weapon = input.ownedWeapons.find((candidate) => candidate.id === base.ownedWeaponId)
      if (weapon === undefined) return { kind: 'source_not_found' }
      if (!selectCompatibleOwnedGogmaWeapons(target, input.ownedWeapons).some((candidate) => candidate.id === weapon.id)) return { kind: 'source_incompatible' }
      if (!isAvailableRouteSource(context, weapon.id)) return { kind: 'source_exclusive' }
      if (weapon.isProtected && operatesOnSource(lanes)) return { kind: 'source_protected' }
      return first(
        () => (lanes.skillStream ? capabilityOfSkill(context) : null),
        () => bonusCapability(context, lanes),
        () => (lanes.skillStream ? supportOfSkill(context) : null),
        () => bonusSupport(context, lanes, weapon),
      )
    }
    case 'owned_normal': {
      const weapon = input.ownedWeapons.find((candidate) => candidate.id === base.ownedWeaponId)
      if (weapon === undefined) return { kind: 'source_not_found' }
      if (!selectCompatibleOwnedNormalArtianWeapons(target, input.ownedWeapons).some((candidate) => candidate.id === weapon.id)) return { kind: 'source_incompatible' }
      if (!isAvailableRouteSource(context, weapon.id)) return { kind: 'source_exclusive' }
      if (!selectConvertibleOwnedNormalArtianWeapons(target, input.ownedWeapons).some((candidate) => candidate.id === weapon.id)) {
        return weapon.isProtected ? { kind: 'source_protected' } : { kind: 'source_not_convertible' }
      }
      const conversion = await conversionPosition(context, base.conversionSkillPosition)
      if (conversion !== null) return conversion
      return first(
        () => capabilityOfSkill(context),
        () => bonusCapability(context, lanes),
        () => supportOfSkill(context),
        () => bonusSupport(context, lanes, weapon),
      )
    }
    case 'new_normal': {
      const counter = selectSearchableNormalCounters(target, input.normalCounters).find((candidate) => candidate.id === base.counterId)
      if (counter === undefined || counter.counter === null) return { kind: 'normal_counter_unavailable' }
      const offset = base.productionTargetPosition - counter.counter
      if (offset < 0 || offset >= input.maxNormalAdvance) return { kind: 'production_target_outside_extent' }
      const normalReservation = context.reservation?.normal(counter.id) ?? EMPTY_COUNTER_RESERVATION
      if (normalReservation.isBlocked(base.productionTargetPosition)) return { kind: 'production_target_blocked' }
      const conversion = await conversionPosition(context, base.conversionSkillPosition)
      if (conversion !== null) return conversion
      return first(
        () => (!input.rngState.baseSeed.isConfirmed || input.rngState.baseSeed.value === null
          ? { kind: 'capability_unavailable', capability: 'normal_artian', cause: 'rng_input_unconfirmed' } : null),
        () => (!context.engine.capabilities.supportsNormalArtianPrediction
          ? { kind: 'capability_unavailable', capability: 'normal_artian', cause: 'engine_capability_unavailable' } : null),
        () => capabilityOfSkill(context),
        () => bonusCapability(context, lanes),
        () => {
          const support = context.predictionSupport.normalArtian()
          return support.supported ? null : { kind: 'prediction_unsupported', prediction: 'normal_artian', reason: support.reason }
        },
        () => supportOfSkill(context),
        () => bonusSupport(context, lanes, null),
      )
    }
  }
}
