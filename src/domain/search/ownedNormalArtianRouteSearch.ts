import type { TargetSearchScheduler } from './targetSearchScheduler'
import type { RouteOperation } from '../models/publicTypes'
import {
  constrainedBonusLaneAvailable,
  conversionSkillPositions,
  hasConfirmedGogmaInputs,
  hasConfirmedSkillInputs,
  isAvailableRouteSource,
  partitionExcludedRouteSources,
  type RouteSearchContext,
  type RouteSearchResult,
} from './routeSearchShared'
import {
  selectCompatibleOwnedNormalArtianWeapons,
  selectConvertibleOwnedNormalArtianWeapons,
} from './routeEligibility'

export async function searchOwnedNormalArtianRoutes(
  context: RouteSearchContext,
  scheduler: TargetSearchScheduler,
): Promise<RouteSearchResult> {
  const { engine, input, target } = context
  const result: RouteSearchResult = { candidates: [], searchedRoutes: [], skippedRoutes: [], warnings: [] }
  // A shape constraint (5.6.9) keeps only the shape's own OwnedWeapon,
  // before any base is generated; it is no reservation edit.
  const constraint = context.routeBaseConstraint
  if (constraint !== undefined && constraint.kind !== 'owned_normal') {
    throw new Error(`A '${constraint.kind}' Route base constraint never runs the owned Normal Artian Route search.`)
  }
  const shapeSource = (weapon: { id: string }) => constraint === undefined || weapon.id === constraint.ownedWeaponId
  // A weapon a Planner reservation holds for a fixed Route is no source at all
  // (SEARCH_SPEC 5.6.8); the ordinary Search has no reservation.
  const compatible = selectCompatibleOwnedNormalArtianWeapons(target, input.ownedWeapons)
    .filter((weapon) => isAvailableRouteSource(context, weapon.id) && shapeSource(weapon))
  const admitted = selectConvertibleOwnedNormalArtianWeapons(target, input.ownedWeapons)
    .filter((weapon) => isAvailableRouteSource(context, weapon.id) && shapeSource(weapon))
  // The request's source exclusion (SEARCH_SPEC 3.3) applies on top of every
  // source rule above, before any base or prediction exists for the weapon.
  const { kept: sources, excluded } = partitionExcludedRouteSources(context, admitted)
  if (excluded.length > 0) result.excludedSourceOwnedWeaponIds = excluded.map(({ id }) => id)

  if (sources.length === 0) {
    result.skippedRoutes.push(excluded.length > 0
      ? {
          route: 'owned_normal_artian_to_gogma',
          reason: 'source_excluded_for_other_targets',
          detail: 'Every convertible owned Normal Artian source is excluded for use by other Target weapons.',
        }
      : {
          route: 'owned_normal_artian_to_gogma',
          reason: compatible.length > 0 ? 'no_unprotected_source_weapon' : 'no_owned_weapon_available',
          detail: compatible.length > 0 ? 'Only protected owned Normal Artian sources are available.' : 'No compatible owned Normal Artian weapon is available.',
        })
    return result
  }
  if (!hasConfirmedSkillInputs(input)) {
    result.skippedRoutes.push({ route: 'owned_normal_artian_to_gogma', reason: 'rng_state_unconfirmed', detail: 'Confirmed Base Seed and Skill Counter are required for conversion.' })
    return result
  }
  if (!engine.capabilities.supportsSkillPrediction) {
    result.skippedRoutes.push({ route: 'owned_normal_artian_to_gogma', reason: 'skill_prediction_unsupported', detail: 'The active RNG Engine does not support Skill prediction required for conversion.' })
    return result
  }
  const skillSupport = context.predictionSupport.skill()
  if (!skillSupport.supported) {
    result.skippedRoutes.push({ route: 'owned_normal_artian_to_gogma', reason: 'skill_prediction_unsupported', detail: `The active RNG Engine does not support this Skill input (${skillSupport.reason}).` })
    return result
  }
  const skillCounter = input.rngState.skillCounter.value!
  let canSearchAmendments = hasConfirmedGogmaInputs(input) && engine.capabilities.supportsGogmaPrediction
  if (constraint !== undefined) {
    // The shape's Bonus lane requires the support of its own operations only (5.6.9).
    canSearchAmendments = constrainedBonusLaneAvailable(context, constraint.lanes.bonusOperations)
  } else if (canSearchAmendments) {
    const resetSupport = context.predictionSupport.gogmaReset()
    if (!resetSupport.supported) {
      result.warnings.push({
        targetWeaponId: target.id,
        severity: 'warning',
        message: `Reset Bonuses was excluded from owned Normal Artian routes by input support (${resetSupport.reason}).`,
      })
      canSearchAmendments = false
    }
  }
  result.searchedRoutes.push('owned_normal_artian_to_gogma')
  // The ordinary Search converts at the origin; under a reservation the
  // conversion may cross held Skill positions (SEARCH_SPEC 5.6.8).
  const conversions = await conversionSkillPositions(context, skillCounter)
  if (conversions.beyondExtent) scheduler.noteExtentReached()
  for (const source of sources) {
    scheduler.queue.enqueue({
      lowerBound: 1,
      async settle() {
        for (const [index, conversionSkillCounter] of conversions.positions.entries()) {
          if (index > 0) await context.execution.checkpoint()
          registerConversion(source, conversionSkillCounter)
        }
      },
    })
  }
  return result

  function registerConversion(
    source: (typeof sources)[number],
    conversionSkillCounter: number,
  ): void {
    const skillCounterAfter = engine.advanceSkillCounter(conversionSkillCounter, { type: 'convert_normal_to_gogma' })
    const skills = context.skillStream.predictAt(conversionSkillCounter)
    const operations: RouteOperation[] = [{ type: 'convert_normal_to_gogma', weaponTypeId: target.weaponTypeId, skillCounterBefore: conversionSkillCounter, skillCounterAfter }]
    scheduler.addBase({
      kindResolution: { type: 'fixed', kind: 'owned_normal_artian_to_gogma' },
      sourceOwnedWeaponId: source.id,
      baseOperations: operations,
      // The same prediction the conversion assigns, kept as an
      // observational record (SEARCH_SPEC 5.5.2.2). No extra predictSkills.
      conversionSkill: { seriesSkillId: skills.seriesSkillId, groupSkillId: skills.groupSkillId },
      zeroBonus: { gogmaAdvance: 0, lastResetDepth: 0, finalBonuses: source.restorationBonuses, restorationBonusScope: 'normal_artian', operations: [], amendmentResults: [] },
      zeroSkill: { resetCount: 0, seriesSkillId: skills.seriesSkillId, groupSkillId: skills.groupSkillId, estimatedSkillAdvance: 1, operations: [], amendmentResults: [] },
      startSkillCounter: skillCounterAfter,
      bonusBase: canSearchAmendments ? { startGogmaCounter: input.rngState.gogmaCounter.value!, bonuses: source.restorationBonuses, restorationBonusScope: 'normal_artian' } : null,
      onCandidate: (candidate) => result.candidates.push(candidate),
      onBonusNotice(notice) {
        if (notice.type !== 'unsupported') return
        const unsupported = notice.prediction
        const message = `${unsupported.type} was excluded after converting OwnedWeapon '${source.id}' by input support (${unsupported.reason}).`
        if (!result.warnings.some((warning) => warning.message === message)) result.warnings.push({ targetWeaponId: target.id, severity: 'warning', message })
      },
    })
  }
}
