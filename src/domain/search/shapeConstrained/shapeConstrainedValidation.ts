import type { TargetWeapon } from '../../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../../models/publicTypes'
import { PlannerAlternativeSearchError, type PlannerAlternativeReservation } from '../alternative/plannerAlternativeTypes'
import { assertPlannerAlternativeSearchInput } from '../alternative/plannerAlternativeValidation'
import type { BonusShapePolicy } from '../bonusStream'
import type { RouteBaseConstraint, RouteBaseLaneNeeds } from '../routeSearchShared'
import {
  ShapeConstrainedSearchError,
  type RouteShapeConstraint,
  type ShapeConstrainedBonusLane,
  type ShapeConstrainedSearchInput,
} from './shapeConstrainedTypes'

/** Which operations the shape's lanes use (`RouteBaseConstraint.lanes`). */
export function shapeConstrainedLaneNeeds(shape: RouteShapeConstraint): RouteBaseLaneNeeds {
  return {
    skillStream: shape.skill.kind === 'reset_skills',
    bonusOperations: shape.bonus.kind === 'zero' ? 'none' : shape.bonus.kind,
  }
}

/** The Route base restriction the Route search primitives read (`RouteSearchContext.routeBaseConstraint`). */
export function shapeConstrainedRouteBaseConstraint(shape: RouteShapeConstraint): RouteBaseConstraint {
  return { ...shape.base, lanes: shapeConstrainedLaneNeeds(shape) }
}

/** The held-aware Bonus stream policy of a Bonus stream lane, or `null` for the zero-operation lane. */
export function shapeConstrainedBonusPolicy(lane: ShapeConstrainedBonusLane): BonusShapePolicy | null {
  switch (lane.kind) {
    case 'zero':
      return null
    case 'reset':
    case 'keep':
      return { kind: lane.kind, finalPosition: lane.finalPosition }
    case 'reset_then_keep':
      return { kind: 'reset_then_keep', resetPosition: lane.resetPosition, finalPosition: lane.finalPosition }
  }
}

const position = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * The structural issues of one shape (`docs/SEARCH_SPEC.md` 5.6.9, design 5.3 item 1): every position a non-negative
 * integer, `resetPosition < finalPosition`, a known base / lane kind, a conversion base never with a zero Bonus
 * lane (its slots are `normal_artian` scope, never Ideal), a conversion base's Reset Skills after its conversion,
 * and each lane final position inside its stream window when that stream's origin is confirmed. The shape's
 * conversion and production target positions are judged by the base diagnosis against the formal authorities
 * (`conversion_position_not_legal`, `production_target_*`), never here.
 */
export function collectShapeConstraintIssues(
  shape: RouteShapeConstraint,
  input: Pick<ShapeConstrainedSearchInput, 'origin' | 'extent'>,
): string[] {
  const issues: string[] = []
  const base = shape.base
  if (base.kind === 'owned_gogma' || base.kind === 'owned_normal') {
    if (typeof base.ownedWeaponId !== 'string' || base.ownedWeaponId.length === 0) issues.push('shape.base.ownedWeaponId must be a non-empty OwnedWeapon ID.')
  } else if (base.kind === 'new_normal') {
    const suffix = `:${V1_NORMAL_ARTIAN_RARITY}`
    if (typeof base.counterId !== 'string' || !base.counterId.endsWith(suffix) || base.counterId.length === suffix.length) {
      issues.push(`shape.base.counterId must be a rarity-8 NormalArtianCounter ID ('<weaponTypeId>${suffix}').`)
    }
    if (!position(base.productionTargetPosition)) issues.push('shape.base.productionTargetPosition must be a non-negative integer.')
  } else {
    issues.push('shape.base.kind must be owned_gogma, owned_normal or new_normal.')
    return issues
  }
  const conversion = base.kind === 'owned_gogma' ? null : base.conversionSkillPosition
  if (conversion !== null && !position(conversion)) issues.push('shape.base.conversionSkillPosition must be a non-negative integer.')

  const skill = shape.skill
  if (skill.kind === 'reset_skills') {
    if (!position(skill.finalPosition)) issues.push('shape.skill.finalPosition must be a non-negative integer.')
    else if (conversion !== null && position(conversion) && skill.finalPosition <= conversion) {
      issues.push('shape.skill.finalPosition of a conversion base must follow its conversion Skill position.')
    }
  } else if (skill.kind !== 'zero') {
    issues.push('shape.skill.kind must be zero or reset_skills.')
  }

  const bonus = shape.bonus
  if (bonus.kind === 'zero') {
    if (conversion !== null) issues.push('A conversion Route base has no zero-operation Bonus lane (its slots are normal_artian scope).')
  } else if (bonus.kind === 'reset' || bonus.kind === 'keep' || bonus.kind === 'reset_then_keep') {
    if (!position(bonus.finalPosition)) issues.push('shape.bonus.finalPosition must be a non-negative integer.')
    if (bonus.kind === 'reset_then_keep') {
      if (!position(bonus.resetPosition)) issues.push('shape.bonus.resetPosition must be a non-negative integer.')
      else if (position(bonus.finalPosition) && bonus.resetPosition >= bonus.finalPosition) issues.push('shape.bonus.resetPosition must precede finalPosition.')
    }
  } else {
    issues.push('shape.bonus.kind must be zero, reset, keep or reset_then_keep.')
  }
  if (issues.length > 0) return issues

  // Lane final positions inside their stream windows (`docs/SEARCH_SPEC.md` 3.1 / 5.6.8), when the origin is known.
  const skillOrigin = input.origin.rngState.skillCounter.isConfirmed ? input.origin.rngState.skillCounter.value : null
  if (skill.kind === 'reset_skills' && skillOrigin !== null) {
    const first = conversion === null ? skillOrigin : (conversion as number) + 1
    const last = conversion === null ? skillOrigin + input.extent.maxSkillAdvance - 1 : skillOrigin + input.extent.maxSkillAdvance
    if (skill.finalPosition < first || skill.finalPosition > last) issues.push(`shape.skill.finalPosition must lie in the Skill window ${first} .. ${last}.`)
  }
  const gogmaOrigin = input.origin.rngState.gogmaCounter.isConfirmed ? input.origin.rngState.gogmaCounter.value : null
  if (bonus.kind !== 'zero' && gogmaOrigin !== null) {
    const last = gogmaOrigin + input.extent.maxGogmaAdvance - 1
    const positions = bonus.kind === 'reset_then_keep' ? [bonus.resetPosition, bonus.finalPosition] : [bonus.finalPosition]
    if (positions.some((value) => value < gogmaOrigin || value > last)) issues.push(`shape.bonus positions must lie in the Gogma window ${gogmaOrigin} .. ${last}.`)
  }
  return issues
}

/**
 * Fails closed on an invalid origin, Target, extent or reservation exactly as Planner Alternative Search does (the
 * same validation, re-thrown with the same code), then on an invalid shape (`invalid_shape`). No prediction runs.
 */
export function assertShapeConstrainedSearchInput(input: ShapeConstrainedSearchInput): {
  target: TargetWeapon
  reservation: PlannerAlternativeReservation
} {
  let validated: { target: TargetWeapon; reservation: PlannerAlternativeReservation }
  try {
    validated = assertPlannerAlternativeSearchInput({ ...input, excludedRouteKeys: [] })
  } catch (error) {
    if (error instanceof PlannerAlternativeSearchError && (error.code === 'invalid_input' || error.code === 'invalid_reservation')) {
      throw new ShapeConstrainedSearchError(error.code, error.message)
    }
    throw error
  }
  const issues = input.shape === null || typeof input.shape !== 'object'
    ? ['shape must be a Route shape constraint.']
    : collectShapeConstraintIssues(input.shape, input)
  if (issues.length > 0) throw new ShapeConstrainedSearchError('invalid_shape', issues.join('\n'))
  return validated
}
