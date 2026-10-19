import type {
  BuildRoute,
  OwnedWeaponId,
  RestorationBonusSet,
  RouteOperation,
  TargetWeapon,
} from '../../models/publicTypes'
import { stableStringify } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import type { BonusStreamBase } from '../bonusStream'
import {
  selectCompatibleOwnedGogmaWeapons,
  selectConvertibleOwnedNormalArtianWeapons,
  selectSearchableNormalCounters,
} from '../routeEligibility'
import { hasConfirmedGogmaInputs, hasConfirmedSkillInputs } from '../searchRngInputs'
import type { SearchExecutionContext } from '../searchExecution'
import type { SearchPredictionSupport } from '../searchPredictionSupport'
import type { TargetSkillStream } from '../skillStream'
import type { RouteBonusSolution, RouteSkillSolution } from '../streamSolutions'
import type {
  ConstrainedEnumerationBounds,
  ConstrainedSearchOrigin,
} from './constrainedTypes'

/**
 * One constrained Route base (SEARCH_SPEC 5.5.1): one Normal Counter plus
 * `candidateOffset`, one owned Normal source, or one owned Gogma source.
 *
 * The base keeps its two stream entry points separate so B8-B1b can add lazy
 * off-axis `(B[i], K[j])` evaluation over the very same raw position solutions
 * without changing how a base is built.
 */
export interface ConstrainedRouteBase {
  /** Deterministic ordering key; never a random or ordinal value. */
  baseKey: string
  kindResolution:
    | { type: 'fixed'; kind: BuildRoute['kind'] }
    | { type: 'existing_gogma' }
  sourceOwnedWeaponId: OwnedWeaponId | null
  /** `create_normal_artian` / `convert_normal_to_gogma`, in execution order. */
  baseOperations: readonly RouteOperation[]
  /**
   * The source ID recorded on amendment and Reset Skills operations. It is
   * null for both conversion Routes, whose output is not yet a persisted
   * OwnedWeapon, and the source's own ID for existing-Gogma Routes.
   */
  amendmentSourceOwnedWeaponId: OwnedWeaponId | null
  zeroBonus: RouteBonusSolution
  zeroSkill: RouteSkillSolution
  /** `resetCount` for existing-Gogma bases, `resetCount + 1` for conversion. */
  skillAdvanceOffset: number
  /** Null disables Skill exploration for this base. */
  startSkillCounter: number | null
  /** Null disables Bonus amendment exploration for this base. */
  bonusBase: BonusStreamBase | null
}

export interface ConstrainedRouteBaseContext {
  target: TargetWeapon
  origin: ConstrainedSearchOrigin
  bounds: ConstrainedEnumerationBounds
  engine: RngEngine
  execution: SearchExecutionContext
  predictionSupport: SearchPredictionSupport
  skillStream: TargetSkillStream
  /** Shared Normal predictions, keyed by absolute Normal Counter position. */
  normalPredictions: Map<number, RestorationBonusSet>
  /** Whether the current Bonus five slots already satisfy the Ideal condition. */
  bonusesSatisfyIdeal(
    bonuses: RouteBonusSolution['finalBonuses'],
    scope: RouteBonusSolution['restorationBonusScope'],
  ): boolean
  /** Whether the current Skills already satisfy the Ideal Skill condition. */
  skillsSatisfyIdeal(
    seriesSkillId: RouteSkillSolution['seriesSkillId'],
    groupSkillId: RouteSkillSolution['groupSkillId'],
  ): boolean
}

export interface ConstrainedRouteBaseResult {
  bases: ConstrainedRouteBase[]
  /** True when `maxNormalForgeCount` truncated the Normal offset enumeration. */
  normalBoundReached: boolean
}

/**
 * The route policy of SEARCH_SPEC 5.6.7: every Route that is currently legal.
 *
 * There is no `CandidateRouteFilter` here. Legality is decided with the same
 * authorities the ordinary Search uses - the shared eligibility selectors,
 * `hasConfirmedSkillInputs` / `hasConfirmedGogmaInputs`, the Engine
 * capabilities, and `SearchPredictionSupport` - never with a second B8-only
 * implementation, and never by predicting a Production input the ordinary
 * Search treats as unsupported.
 */
export async function createConstrainedRouteBases(
  context: ConstrainedRouteBaseContext,
): Promise<ConstrainedRouteBaseResult> {
  const { target, origin, bounds, engine, predictionSupport } = context
  const bases: ConstrainedRouteBase[] = []
  let normalBoundReached = false

  const skillInputsConfirmed = hasConfirmedSkillInputs(origin)
  const canSkill =
    skillInputsConfirmed &&
    engine.capabilities.supportsSkillPrediction &&
    predictionSupport.skill().supported
  const gogmaInputsConfirmed = hasConfirmedGogmaInputs(origin)
  const canAmend =
    gogmaInputsConfirmed && engine.capabilities.supportsGogmaPrediction
  const startGogmaCounter = origin.rngState.gogmaCounter.value
  const skillCounter = origin.rngState.skillCounter.value
  const baseSeed = origin.rngState.baseSeed.value

  /** Conversion Routes always consume one Skill result at the current position. */
  function conversionSkill(): {
    skills: ReturnType<TargetSkillStream['predictAt']>
    skillCounterBefore: number
    skillCounterAfter: number
  } | null {
    if (!canSkill || skillCounter === null) return null
    const skills = context.skillStream.predictAt(skillCounter)
    return {
      skills,
      skillCounterBefore: skillCounter,
      skillCounterAfter: engine.advanceSkillCounter(skillCounter, {
        type: 'convert_normal_to_gogma',
      }),
    }
  }

  function conversionBase(
    kind: 'normal_artian_to_gogma' | 'owned_normal_artian_to_gogma',
    baseKey: string,
    sourceOwnedWeaponId: OwnedWeaponId | null,
    baseOperations: readonly RouteOperation[],
    inheritedBonuses: RestorationBonusSet,
    conversion: NonNullable<ReturnType<typeof conversionSkill>>,
  ): ConstrainedRouteBase {
    const bonusIdeal = context.bonusesSatisfyIdeal(inheritedBonuses, 'normal_artian')
    const skillIdeal = context.skillsSatisfyIdeal(
      conversion.skills.seriesSkillId,
      conversion.skills.groupSkillId,
    )
    return {
      baseKey,
      kindResolution: { type: 'fixed', kind },
      sourceOwnedWeaponId,
      baseOperations,
      amendmentSourceOwnedWeaponId: null,
      zeroBonus: {
        gogmaAdvance: 0,
        lastResetDepth: 0,
        finalBonuses: inheritedBonuses,
        restorationBonusScope: 'normal_artian',
        operations: [],
        amendmentResults: [],
      },
      zeroSkill: {
        resetCount: 0,
        seriesSkillId: conversion.skills.seriesSkillId,
        groupSkillId: conversion.skills.groupSkillId,
        estimatedSkillAdvance: 1,
        operations: [],
        amendmentResults: [],
      },
      skillAdvanceOffset: 1,
      startSkillCounter: skillIdeal ? null : conversion.skillCounterAfter,
      bonusBase:
        canAmend && startGogmaCounter !== null && !bonusIdeal
          ? {
              startGogmaCounter,
              bonuses: inheritedBonuses,
              restorationBonusScope: 'normal_artian',
            }
          : null,
    }
  }

  // --- normal_artian_to_gogma -------------------------------------------
  const counters = selectSearchableNormalCounters(target, origin.normalCounters)
  const conversion = conversionSkill()
  const canForge =
    counters.length > 0 &&
    baseSeed !== null &&
    origin.rngState.baseSeed.isConfirmed &&
    engine.capabilities.supportsNormalArtianPrediction &&
    predictionSupport.normalArtian().supported
  if (canForge && conversion !== null) {
    for (const counter of counters) {
      if (counter.counter === null) continue
      const start = counter.counter
      for (let offset = 0; offset < bounds.maxNormalForgeCount; offset += 1) {
        await context.execution.checkpoint()
        // NormalArtianCounter is the 0-based block index of the next forge, so
        // offset k means forging k + 1 weapons and converting the last one.
        const forgeCount = offset + 1
        const candidateCounter = start + offset
        const bonuses =
          context.normalPredictions.get(candidateCounter) ??
          engine.predictNormalArtian({
            baseSeed: baseSeed as string,
            weaponTypeId: target.weaponTypeId,
            elementId: target.elementId,
            rarity: counter.rarity,
            normalCounter: candidateCounter,
            master: origin.master,
          })
        context.normalPredictions.set(candidateCounter, bonuses)
        const normalCounterAfter = engine.advanceNormalCounter(start, {
          type: 'create_normal_artian',
          count: forgeCount,
        })
        bases.push(
          conversionBase(
            'normal_artian_to_gogma',
            stableStringify(['normal_artian_to_gogma', counter.id, offset]),
            null,
            [
              {
                type: 'create_normal_artian',
                weaponTypeId: target.weaponTypeId,
                rarity: counter.rarity,
                count: forgeCount,
                normalCounterBefore: start,
                normalCounterAfter,
              },
              {
                type: 'convert_normal_to_gogma',
                weaponTypeId: target.weaponTypeId,
                skillCounterBefore: conversion.skillCounterBefore,
                skillCounterAfter: conversion.skillCounterAfter,
              },
            ],
            bonuses,
            conversion,
          ),
        )
      }
      // The Normal stream has no natural end, so covering the configured forge
      // counts is always a bound stop, never exhaustion.
      normalBoundReached = true
    }
  }

  // --- owned_normal_artian_to_gogma -------------------------------------
  if (conversion !== null) {
    for (const source of selectConvertibleOwnedNormalArtianWeapons(
      target,
      origin.ownedWeapons,
    )) {
      await context.execution.checkpoint()
      bases.push(
        conversionBase(
          'owned_normal_artian_to_gogma',
          stableStringify(['owned_normal_artian_to_gogma', source.id]),
          source.id,
          [
            {
              type: 'convert_normal_to_gogma',
              weaponTypeId: target.weaponTypeId,
              skillCounterBefore: conversion.skillCounterBefore,
              skillCounterAfter: conversion.skillCounterAfter,
            },
          ],
          source.restorationBonuses,
          conversion,
        ),
      )
    }
  }

  // --- existing_gogma_* -------------------------------------------------
  for (const source of selectCompatibleOwnedGogmaWeapons(
    target,
    origin.ownedWeapons,
  )) {
    await context.execution.checkpoint()
    const bonusIdeal = context.bonusesSatisfyIdeal(
      source.restorationBonuses,
      source.restorationBonusScope,
    )
    const skillIdeal = context.skillsSatisfyIdeal(
      source.seriesSkillId,
      source.groupSkillId,
    )
    bases.push({
      baseKey: stableStringify(['existing_gogma', source.id]),
      kindResolution: { type: 'existing_gogma' },
      sourceOwnedWeaponId: source.id,
      baseOperations: [],
      amendmentSourceOwnedWeaponId: source.id,
      zeroBonus: {
        gogmaAdvance: 0,
        lastResetDepth: 0,
        finalBonuses: source.restorationBonuses,
        restorationBonusScope: source.restorationBonusScope,
        operations: [],
        amendmentResults: [],
      },
      zeroSkill: {
        resetCount: 0,
        seriesSkillId: source.seriesSkillId,
        groupSkillId: source.groupSkillId,
        estimatedSkillAdvance: 0,
        operations: [],
        amendmentResults: [],
      },
      skillAdvanceOffset: 0,
      startSkillCounter:
        canSkill &&
        !source.isProtected &&
        !skillIdeal &&
        skillCounter !== null
          ? skillCounter
          : null,
      // Protection covers every performance mutation, so a protected source
      // enters neither Bonus nor Skill amendment exploration.
      bonusBase:
        canAmend &&
        startGogmaCounter !== null &&
        !source.isProtected &&
        !bonusIdeal
          ? {
              startGogmaCounter,
              bonuses: source.restorationBonuses,
              restorationBonusScope: source.restorationBonusScope,
            }
          : null,
    })
  }

  return {
    bases: bases.sort((left, right) =>
      left.baseKey < right.baseKey ? -1 : left.baseKey > right.baseKey ? 1 : 0,
    ),
    normalBoundReached,
  }
}
