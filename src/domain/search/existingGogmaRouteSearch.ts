import type { TargetSearchScheduler } from './targetSearchScheduler'
import type {
  BuildRoute,
  OwnedGogmaArtianWeapon,
  OwnedWeaponId,
} from '../models/publicTypes'
import { selectCompatibleOwnedGogmaWeapons } from './routeEligibility'
import {
  constrainedBonusLaneAvailable,
  hasConfirmedGogmaInputs,
  hasConfirmedSkillInputs,
  isAvailableRouteSource,
  partitionExcludedRouteSources,
  type RouteSearchContext,
  type RouteSearchResult,
} from './routeSearchShared'
import type { RouteBonusSolution, RouteSkillSolution } from './streamSolutions'

const bonusAmendmentKinds = ['existing_gogma_reset_bonuses', 'existing_gogma_keep_bonuses', 'existing_gogma_mixed'] as const

/**
 * A weapon a Planner reservation holds for a fixed Route is neither a Route
 * source nor an amendment subject here, its zero-operation current Route
 * included (SEARCH_SPEC 5.6.8); the ordinary Search has no reservation.
 * A shape constraint (5.6.9) further keeps only the shape's own
 * OwnedWeapon, before any base is generated; it is no reservation edit.
 */
function compatibleSources(context: RouteSearchContext): OwnedGogmaArtianWeapon[] {
  const sources = selectCompatibleOwnedGogmaWeapons(context.target, context.input.ownedWeapons)
    .filter((weapon) => isAvailableRouteSource(context, weapon.id))
  const constraint = context.routeBaseConstraint
  if (constraint === undefined) return sources
  if (constraint.kind !== 'owned_gogma') {
    throw new Error(`A '${constraint.kind}' Route base constraint never runs the existing Gogma Route search.`)
  }
  return sources.filter((weapon) => weapon.id === constraint.ownedWeaponId)
}

function pushAll(result: RouteSearchResult, routes: readonly BuildRoute['kind'][], reason: Parameters<RouteSearchResult['skippedRoutes']['push']>[0]['reason'], detail: string) {
  routes.forEach((route) => result.skippedRoutes.push({ route, reason, detail }))
}

/** The `resetCount = 0` Skill solution of one owned Gogma Route base. */
function zeroSkillSolution(source: OwnedGogmaArtianWeapon): RouteSkillSolution {
  return {
    resetCount: 0,
    seriesSkillId: source.seriesSkillId,
    groupSkillId: source.groupSkillId,
    estimatedSkillAdvance: 0,
    operations: [],
    amendmentResults: [],
  }
}

/** The `gogmaAdvance = 0` Bonus solution of one owned Gogma Route base. */
function zeroBonusSolution(source: OwnedGogmaArtianWeapon): RouteBonusSolution {
  return {
    gogmaAdvance: 0,
    lastResetDepth: 0,
    finalBonuses: source.restorationBonuses,
    restorationBonusScope: source.restorationBonusScope,
    operations: [],
    amendmentResults: [],
  }
}

const amendmentKinds = ['existing_gogma_reset_bonuses', 'existing_gogma_keep_bonuses', 'existing_gogma_reset_skills', 'existing_gogma_mixed'] as const

/**
 * Why the amendment RouteKinds have no unprotected source left: the request's
 * source exclusion (SEARCH_SPEC 3.3) when it removed an unprotected source,
 * otherwise the ordinary protection reason, exactly as without the exclusion.
 */
function noUnprotectedSource(
  excluded: readonly OwnedGogmaArtianWeapon[],
  detail: string,
): { reason: 'source_excluded_for_other_targets' | 'no_unprotected_source_weapon'; detail: string } {
  return excluded.some((weapon) => !weapon.isProtected)
    ? { reason: 'source_excluded_for_other_targets', detail: 'Every unprotected owned Gogma source is excluded for use by other Target weapons.' }
    : { reason: 'no_unprotected_source_weapon', detail }
}

export async function searchExistingGogmaRoutes(context: RouteSearchContext, scheduler: TargetSearchScheduler): Promise<RouteSearchResult> {
  const { engine, input } = context
  const result: RouteSearchResult = { candidates: [], searchedRoutes: [], skippedRoutes: [], warnings: [] }
  // The request's source exclusion (SEARCH_SPEC 3.3) applies on top of every
  // source rule, before any base or prediction exists for the weapon; the
  // zero-operation current Route of a protected weapon is excluded too.
  const { kept: all, excluded } = partitionExcludedRouteSources(context, compatibleSources(context))
  if (excluded.length > 0) result.excludedSourceOwnedWeaponIds = excluded.map(({ id }) => id)
  if (all.length === 0) {
    if (excluded.length === 0) {
      pushAll(result, ['existing_gogma_current', ...amendmentKinds], 'no_owned_weapon_available', 'No compatible owned Gogma weapon is available.')
      return result
    }
    result.skippedRoutes.push({ route: 'existing_gogma_current', reason: 'source_excluded_for_other_targets', detail: 'Every compatible owned Gogma source is excluded for use by other Target weapons.' })
    const shortage = noUnprotectedSource(excluded, 'Only protected sources are available for performance-amendment routes.')
    pushAll(result, amendmentKinds, shortage.reason, shortage.detail)
    return result
  }
  result.searchedRoutes.push('existing_gogma_current')

  const mutableSources = all.filter((weapon) => !weapon.isProtected)
  // A shape constraint (5.6.9) opens only the lanes its shape operates
  // on, and never queries the support of a lane it leaves at zero operations.
  const lanes = context.routeBaseConstraint?.lanes

  const hasSkillInputs = hasConfirmedSkillInputs(input)
  let skillInputUnsupportedReason: string | null = null
  let canSkill = false
  if (
    mutableSources.length > 0 &&
    hasSkillInputs &&
    engine.capabilities.supportsSkillPrediction &&
    (lanes === undefined || lanes.skillStream)
  ) {
    const skillSupport = context.predictionSupport.skill()
    canSkill = skillSupport.supported
    if (!skillSupport.supported) skillInputUnsupportedReason = skillSupport.reason
  }

  if (canSkill) {
    result.searchedRoutes.push('existing_gogma_reset_skills')
  } else if (mutableSources.length === 0) {
    result.skippedRoutes.push({
      route: 'existing_gogma_reset_skills',
      ...noUnprotectedSource(excluded, 'Only protected sources are available for Reset Skills routes.'),
    })
  } else {
    result.skippedRoutes.push({
      route: 'existing_gogma_reset_skills',
      reason: hasSkillInputs
        ? 'skill_prediction_unsupported'
        : 'rng_state_unconfirmed',
      detail: !hasSkillInputs
        ? 'Confirmed Base Seed and Skill Counter are required.'
        : skillInputUnsupportedReason
          ? `The active RNG Engine does not support this Skill input (${skillInputUnsupportedReason}).`
          : 'The active RNG Engine does not support Skill prediction.',
    })
  }

  const gogmaInputsConfirmed = hasConfirmedGogmaInputs(input)
  const canAmend = mutableSources.length > 0
    && gogmaInputsConfirmed
    && engine.capabilities.supportsGogmaPrediction
    && (lanes === undefined || constrainedBonusLaneAvailable(context, lanes.bonusOperations))
  const canKeep = engine.capabilities.supportsKeepBonusesPrediction
  const searchedAmendmentRoutes = new Set<BuildRoute['kind']>()
  const keepUnsupportedSources = new Set<OwnedWeaponId>()

  // Register each base once. Current Ideal streams have no future work.
  for (const source of all) {
    scheduler.addBase({
      kindResolution: { type: 'existing_gogma' },
      sourceOwnedWeaponId: source.id,
      baseOperations: [],
      // No conversion: the base's current Skills are the source weapon's own.
      conversionSkill: null,
      zeroBonus: zeroBonusSolution(source),
      zeroSkill: zeroSkillSolution(source),
      startSkillCounter:
        canSkill && !source.isProtected
          ? input.rngState.skillCounter.value
          : null,
      bonusBase: canAmend && !source.isProtected ? {
        startGogmaCounter: input.rngState.gogmaCounter.value!,
        bonuses: source.restorationBonuses,
        restorationBonusScope: source.restorationBonusScope,
      } : null,
      onCandidate: (candidate) => result.candidates.push(candidate),
      onBonusNotice(notice) {
        if (notice.type === 'route_kind') {
          searchedAmendmentRoutes.add(notice.kind)
          if (canSkill) searchedAmendmentRoutes.add('existing_gogma_mixed')
        } else if (notice.prediction.type === 'keep_bonuses') {
          keepUnsupportedSources.add(source.id)
          const message = `Keep Bonuses branches from OwnedWeapon '${source.id}' were excluded by input support (${notice.prediction.reason}).`
          if (!result.warnings.some((warning) => warning.message === message)) result.warnings.push({ targetWeaponId: context.target.id, severity: 'warning', message })
        }
      },
    })
  }

  if (mutableSources.length === 0) {
    const shortage = noUnprotectedSource(excluded, 'Only protected sources are available for performance-amendment routes.')
    pushAll(result, bonusAmendmentKinds, shortage.reason, shortage.detail)
    return result
  }
  if (!gogmaInputsConfirmed || !engine.capabilities.supportsGogmaPrediction) {
    pushAll(result, bonusAmendmentKinds, gogmaInputsConfirmed ? 'gogma_prediction_unsupported' : 'rng_state_unconfirmed', gogmaInputsConfirmed ? 'The active RNG Engine does not support Gogma prediction.' : 'Confirmed Base Seed and Gogma Counter are required.')
    return result
  }

  result.finalize = () => {
    // Queried only once the performance-amendment preconditions hold, so an unavailable
    // source or unconfirmed Gogma input never triggers a support query.
    const resetSupport = context.predictionSupport.gogmaReset()
    const canReset = resetSupport.supported

    if (searchedAmendmentRoutes.has('existing_gogma_reset_bonuses')) {
      result.searchedRoutes.push('existing_gogma_reset_bonuses')
    } else {
      result.skippedRoutes.push({
        route: 'existing_gogma_reset_bonuses',
        reason: !canReset && resetSupport.reason === 'master_data_unavailable'
          ? 'master_data_unavailable'
          : 'gogma_prediction_unsupported',
        detail: canReset
          ? 'No Reset Bonuses branch was searchable for the available sources.'
          : `Reset Bonuses input is unsupported (${resetSupport.reason}).`,
      })
    }

    if (searchedAmendmentRoutes.has('existing_gogma_keep_bonuses')) {
      result.searchedRoutes.push('existing_gogma_keep_bonuses')
    } else {
      // An owned Gogma's five slots are always known, so Keep is searched from
      // either scope; only the Engine's input support can exclude a source.
      result.skippedRoutes.push({
        route: 'existing_gogma_keep_bonuses',
        reason: 'keep_prediction_unsupported',
        detail: canKeep
          ? `Keep Bonuses input is unsupported for ${keepUnsupportedSources.size || mutableSources.length} available source(s).`
          : 'The active RNG Engine does not support Keep Bonuses prediction.',
      })
    }

    if (searchedAmendmentRoutes.has('existing_gogma_mixed')) {
      result.searchedRoutes.push('existing_gogma_mixed')
    } else {
      result.skippedRoutes.push({
        route: 'existing_gogma_mixed',
        reason: !canReset && resetSupport.reason === 'master_data_unavailable'
          ? 'master_data_unavailable'
          : hasSkillInputs && !canSkill
            ? 'skill_prediction_unsupported'
            : !hasSkillInputs
              ? 'rng_state_unconfirmed'
              : !canKeep
                ? 'keep_prediction_unsupported'
                : 'gogma_prediction_unsupported',
        detail: 'No supported mixed operation combination was searchable.',
      })
    }
  }
  return result
}
