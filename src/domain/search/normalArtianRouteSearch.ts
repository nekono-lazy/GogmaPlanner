import { keepFamilyLayoutKey, keepFamilyMultisetKey } from '../rng/gogmaBonusFamily'
import type { TargetSearchScheduler } from './targetSearchScheduler'
import type { RouteOperation, SkillAmendmentResult } from '../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../models/publicTypes'
import type { BonusStreamNotice } from './targetSearchScheduler'
import {
  EMPTY_COUNTER_RESERVATION,
  heldPrefixNormalCreation,
} from './counterReservation'
import {
  constrainedBonusLaneAvailable,
  conversionSkillPositions,
  hasConfirmedGogmaInputs,
  hasConfirmedSkillInputs,
  type RouteSearchContext,
  type RouteSearchResult,
} from './routeSearchShared'
import { selectSearchableNormalCounters } from './routeEligibility'
import type {
  CandidateSearchNoticeSeverity,
  CandidateSearchWarning,
  SkippedRouteReason,
} from './searchTypes'
import type { RouteSkillSolution } from './streamSolutions'

interface RouteSkip {
  reason: SkippedRouteReason
  detail: string
}

/**
 * Why the predicted Normal Artian variant of SEARCH_SPEC 6.1 cannot run.
 *
 * It needs a confirmed Normal Artian Counter, a confirmed Base Seed, and
 * Normal Artian prediction, because it reads the forged weapon's five slots.
 */
function predictedNormalSkip(context: RouteSearchContext): RouteSkip | null {
  const { engine, input, target } = context
  if (selectSearchableNormalCounters(target, input.normalCounters).length === 0) {
    return {
      reason: 'normal_counter_unconfirmed',
      detail: `No confirmed Normal Artian Counter is available for '${target.weaponTypeId}'.`,
    }
  }
  if (!input.rngState.baseSeed.isConfirmed || input.rngState.baseSeed.value === null) {
    return {
      reason: 'rng_state_unconfirmed',
      detail: 'A confirmed Base Seed is required for Normal prediction.',
    }
  }
  if (!engine.capabilities.supportsNormalArtianPrediction) {
    return {
      reason: 'normal_prediction_unsupported',
      detail: 'The active RNG Engine does not support Normal Artian prediction.',
    }
  }
  const normalSupport = context.predictionSupport.normalArtian()
  if (!normalSupport.supported) {
    return {
      reason: 'normal_prediction_unsupported',
      detail: `The active RNG Engine does not support this Normal Artian input (${normalSupport.reason}).`,
    }
  }
  return null
}

/** Conversion is required by both variants of this RouteKind. */
function conversionSkip(context: RouteSearchContext): RouteSkip | null {
  const { engine, input } = context
  if (!hasConfirmedSkillInputs(input)) {
    return {
      reason: 'rng_state_unconfirmed',
      detail: 'Confirmed Base Seed and Skill Counter are required for conversion.',
    }
  }
  if (!engine.capabilities.supportsSkillPrediction) {
    return {
      reason: 'skill_prediction_unsupported',
      detail: 'The active RNG Engine does not support Skill prediction required for conversion.',
    }
  }
  const skillSupport = context.predictionSupport.skill()
  if (!skillSupport.supported) {
    return {
      reason: 'skill_prediction_unsupported',
      detail: `The active RNG Engine does not support this Skill input (${skillSupport.reason}).`,
    }
  }
  return null
}

/** Why Reset Bonuses cannot be predicted from the current Gogma position. */
function resetBonusesSkip(context: RouteSearchContext): RouteSkip | null {
  const { engine, input } = context
  if (!hasConfirmedGogmaInputs(input)) {
    return {
      reason: 'rng_state_unconfirmed',
      detail: 'Confirmed Base Seed and Gogma Counter are required for Reset Bonuses.',
    }
  }
  if (!engine.capabilities.supportsGogmaPrediction) {
    return {
      reason: 'gogma_prediction_unsupported',
      detail: 'The active RNG Engine does not support Gogma bonus prediction.',
    }
  }
  const resetSupport = context.predictionSupport.gogmaReset()
  if (!resetSupport.supported) {
    return {
      reason: 'gogma_prediction_unsupported',
      detail: `The active RNG Engine does not support this Reset Bonuses input (${resetSupport.reason}).`,
    }
  }
  return null
}

function addWarning(
  result: RouteSearchResult,
  targetWeaponId: CandidateSearchWarning['targetWeaponId'],
  severity: CandidateSearchNoticeSeverity,
  message: string,
): void {
  if (result.warnings.some((warning) => warning.message === message)) return
  result.warnings.push({ targetWeaponId, severity, message })
}

/**
 * How the forced Reset Bonuses route (SEARCH_SPEC 6.1.1) is announced to the
 * user.
 *
 * The route really was searched and its Candidates are ordinary Candidates, so
 * this is an informational notice rather than a warning: the text says what was
 * searched before it says what was unavailable. `docs/UI_FLOW.md` 9 forbids
 * showing an internal reason enum in the normal UI, so the reason only selects
 * which sentence is used and never appears in the text. The two supported
 * causes are genuinely different facts and must not be collapsed into one: an
 * unconfirmed Counter is not the same as missing Normal prediction, and a
 * Counter can be confirmed while only the prediction is unavailable.
 */
function blindResetSearchedMessage(reason: SkippedRouteReason): string {
  const cause =
    reason === 'normal_counter_unconfirmed'
      ? '通常アーティアのカウンターが未確定のため、作成直後の復元ボーナスは予測していません。'
      : '通常アーティアの初期復元ボーナス予測を利用できないため、作成直後の復元ボーナスは予測していません。'
  return [
    '通常アーティアの初期ボーナスを使わないルートで検索しました。',
    cause,
    '通常アーティアを1本作成して巨戟化したあと、復元ボーナスを再抽選して5枠を確定するルートを検索しています。',
  ].join('\n')
}

/**
 * The counterpart notice for the case where the forced Reset route is not
 * available either, so the whole RouteKind was skipped.
 *
 * This one stays a warning: nothing was searched for this RouteKind. The
 * predicted variant's own blocker is already reported as a `SkippedRoute`, so
 * the text explains only why the fallback could not stand in for it.
 */
function blindResetUnavailableMessage(reason: SkippedRouteReason): string {
  const cause =
    reason === 'rng_state_unconfirmed'
      ? '巨戟アーティアのカウンターが未確定のため、復元ボーナスの再抽選を予測できません。'
      : '現在の予測エンジンでは復元ボーナスの再抽選を予測できません。'
  return [
    '通常アーティアの初期ボーナスを使わないルートも実行できなかったため、通常アーティア経由のルートは検索していません。',
    cause,
  ].join('\n')
}

interface ConversionBase {
  skillCounter: number
  skillCounterAfter: number
  zeroSkill: RouteSkillSolution
  /**
   * The same predicted Skills the conversion assigns, kept as an observational
   * record (SEARCH_SPEC 5.5.2.2). It reads the Skill stream's existing memoized
   * prediction, so it adds no `predictSkills` call.
   */
  conversionSkill: SkillAmendmentResult
}

export async function searchNormalArtianRoutes(
  context: RouteSearchContext,
  scheduler: TargetSearchScheduler,
): Promise<RouteSearchResult> {
  const { engine, input, target } = context
  const result: RouteSearchResult = {
    candidates: [],
    searchedRoutes: [],
    skippedRoutes: [],
    warnings: [],
  }

  const constraint = context.routeBaseConstraint
  if (constraint !== undefined && constraint.kind !== 'new_normal') {
    throw new Error(`A '${constraint.kind}' Route base constraint never runs the Normal Artian Route search.`)
  }
  const normalSkip = predictedNormalSkip(context)
  const conversionUnavailable = conversionSkip(context)
  if (conversionUnavailable) {
    // Conversion is required by both variants, so neither can run. The
    // predicted variant reports its own blocker first, preserving the existing
    // skip reason whenever a confirmed Normal Counter is genuinely missing.
    result.skippedRoutes.push({
      route: 'normal_artian_to_gogma',
      ...(normalSkip ?? conversionUnavailable),
    })
    return result
  }
  if (constraint !== undefined && normalSkip !== null) {
    // A shape names a predicted production target (5.6.9): the blind
    // variant is never its stand-in and is never registered.
    result.skippedRoutes.push({ route: 'normal_artian_to_gogma', ...normalSkip })
    return result
  }

  const skillCounter = input.rngState.skillCounter.value
  if (skillCounter === null) return result
  /**
   * The conversion assigns the initial Series / Group Skills at its Skill
   * position, identically for both variants of this RouteKind: the current
   * Skill position in the ordinary Search, or any position a Planner
   * reservation lets the conversion cross to (SEARCH_SPEC 5.6.8).
   */
  const conversions = await conversionSkillPositions(context, skillCounter)
  if (conversions.beyondExtent) scheduler.noteExtentReached()
  /**
   * It stays lazy so a Route that is never registered predicts nothing, exactly
   * as before this variant existed.
   */
  const conversion = (conversionSkillCounter: number): ConversionBase => {
    const skills = context.skillStream.predictAt(conversionSkillCounter)
    return {
      skillCounter: conversionSkillCounter,
      skillCounterAfter: engine.advanceSkillCounter(conversionSkillCounter, {
        type: 'convert_normal_to_gogma',
      }),
      zeroSkill: {
        resetCount: 0,
        seriesSkillId: skills.seriesSkillId,
        groupSkillId: skills.groupSkillId,
        estimatedSkillAdvance: 1,
        operations: [],
        amendmentResults: [],
      },
      conversionSkill: {
        seriesSkillId: skills.seriesSkillId,
        groupSkillId: skills.groupSkillId,
      },
    }
  }
  const onBonusNotice = (notice: BonusStreamNotice): void => {
    if (notice.type !== 'unsupported') return
    addWarning(
      result,
      target.id,
      'warning',
      `${notice.prediction.type} was excluded from the Normal Artian route by input support (${notice.prediction.reason}).`,
    )
  }

  const conversionBases: ConversionBases = { positions: conversions.positions, at: conversion }
  if (normalSkip === null) {
    searchPredictedNormalRoutes(context, scheduler, result, conversionBases, onBonusNotice)
    return result
  }
  searchBlindResetNormalRoute(context, scheduler, result, conversionBases, onBonusNotice, normalSkip)
  return result
}

/** The legal conversion Skill positions and the lazy conversion at one of them. */
interface ConversionBases {
  positions: readonly number[]
  at(conversionSkillCounter: number): ConversionBase
}

/**
 * Registers one Route base per legal conversion Skill position: exactly one in
 * the ordinary Search (the origin), possibly several under a Planner
 * reservation. A long list stays cancellable between registrations.
 */
async function forEachConversion(
  context: RouteSearchContext,
  conversions: ConversionBases,
  register: (converted: ConversionBase) => void,
): Promise<void> {
  for (const [index, position] of conversions.positions.entries()) {
    if (index > 0) await context.execution.checkpoint()
    register(conversions.at(position))
  }
}

/**
 * The forced Reset Bonuses Normal Artian route (SEARCH_SPEC 6.1.1).
 *
 * Exactly one Normal Artian is forged and its five slots are never predicted,
 * so neither a confirmed Normal Artian Counter nor Normal Artian prediction is
 * required. The Route is well defined only because its first bonus amendment is
 * always Reset Bonuses, which redraws all five slots from the Gogma Counter
 * position alone and therefore reads nothing the forge produced.
 */
function searchBlindResetNormalRoute(
  context: RouteSearchContext,
  scheduler: TargetSearchScheduler,
  result: RouteSearchResult,
  conversions: ConversionBases,
  onBonusNotice: (notice: BonusStreamNotice) => void,
  normalSkip: RouteSkip,
): void {
  const { input, target } = context
  const resetSkip = resetBonusesSkip(context)
  if (resetSkip !== null) {
    result.skippedRoutes.push({ route: 'normal_artian_to_gogma', ...normalSkip })
    addWarning(result, target.id, 'warning', blindResetUnavailableMessage(resetSkip.reason))
    return
  }

  result.searchedRoutes.push('normal_artian_to_gogma')
  addWarning(result, target.id, 'info', blindResetSearchedMessage(normalSkip.reason))
  scheduler.queue.enqueue({
    // create + convert + the mandatory first Reset Bonuses.
    lowerBound: 3,
    // One blind base per legal conversion position, never one per Normal
    // offset: the blind forge holds no Normal Counter position, so a Normal
    // reservation neither blocks it nor gives it a fabricated position.
    settle: () => forEachConversion(context, conversions, (converted) => {
      const operations: RouteOperation[] = [
        {
          type: 'create_normal_artian',
          weaponTypeId: target.weaponTypeId,
          rarity: V1_NORMAL_ARTIAN_RARITY,
          count: 1,
          normalCounterBefore: null,
          normalCounterAfter: null,
        },
        {
          type: 'convert_normal_to_gogma',
          weaponTypeId: target.weaponTypeId,
          skillCounterBefore: converted.skillCounter,
          skillCounterAfter: converted.skillCounterAfter,
        },
      ]
      scheduler.addBase({
        kindResolution: { type: 'fixed', kind: 'normal_artian_to_gogma' },
        sourceOwnedWeaponId: null,
        baseOperations: operations,
        conversionSkill: converted.conversionSkill,
        // No zero-amendment solution exists: the inherited five slots are
        // unknown, and no fabricated bonus set stands in for them. The Bonus
        // axis therefore starts at the first Reset Bonuses.
        zeroBonus: null,
        zeroSkill: converted.zeroSkill,
        startSkillCounter: converted.skillCounterAfter,
        bonusBase: {
          startGogmaCounter: input.rngState.gogmaCounter.value as number,
          bonuses: null,
          restorationBonusScope: 'normal_artian',
        },
        onCandidate: (candidate) => result.candidates.push(candidate),
        onBonusNotice,
      })
    }),
  })
}

/**
 * Incremental initial-Search dominance (SEARCH_SPEC 6.1.2).
 * Reset erases the initial slots, so only offset zero needs its full stream.
 * Other offsets first require Ideal-compatible unordered families, then only
 * the first representative of each ordered Keep layout.
 * A later equivalent base costs strictly more for identical Bonus/Skill futures;
 * no later canonical tie-break can rescue it. This is NOT Planner pruning.
 *
 * Under the Planner Alternative policy (SEARCH_SPEC 5.6.8) none of it applies:
 * every offset of the extent is registered as a full Route base, exactly like
 * offset zero, because a Planner reservation can make an earlier production
 * target unusable. The offsets stay lazy (one cursor, `forgeCount + 1` lower
 * bound), and their predictions and streams are the same memoized ones.
 *
 * Offset `k` is the production target position `start + k` of the extent,
 * held positions included. Under a Normal reservation a blocked target is not
 * used, and the creation is the canonical held-prefix one
 * (`heldPrefixNormalCreation()`): the fixed Routes forge the held run from the
 * origin, the alternative Route forges the rest through its own target. Its
 * forge count never decreases with the offset, so the lower bound stays
 * monotone. With no reservation it is the ordinary `start / start + k + 1`.
 */
function searchPredictedNormalRoutes(
  context: RouteSearchContext,
  scheduler: TargetSearchScheduler,
  result: RouteSearchResult,
  conversions: ConversionBases,
  onBonusNotice: (notice: BonusStreamNotice) => void,
): void {
  const { engine, input, target } = context
  const baseSeed = input.rngState.baseSeed.value as string
  // A shape constraint (5.6.9) keeps only the shape's Counter and its
  // one production target offset, before any Normal is predicted or queued.
  const constraint = context.routeBaseConstraint?.kind === 'new_normal' ? context.routeBaseConstraint : undefined
  const counters = selectSearchableNormalCounters(target, input.normalCounters)
    .filter((counter) => constraint === undefined || counter.id === constraint.counterId)
  let canSearchAmendments =
    hasConfirmedGogmaInputs(input) && engine.capabilities.supportsGogmaPrediction
  if (constraint !== undefined) {
    // The shape's Bonus lane requires the support of its own operations only (5.6.9).
    canSearchAmendments = constrainedBonusLaneAvailable(context, constraint.lanes.bonusOperations)
  } else if (canSearchAmendments) {
    const resetSupport = context.predictionSupport.gogmaReset()
    if (!resetSupport.supported) {
      addWarning(
        result,
        target.id,
        'warning',
        `Reset Bonuses was excluded from the Normal Artian route by input support (${resetSupport.reason}).`,
      )
      canSearchAmendments = false
    }
  }
  const initialSearch = (context.frontierPolicy ?? 'initial_candidate_search') === 'initial_candidate_search'
  const idealFamilyMultiset = keepFamilyMultisetKey(target.idealBonuses, input.master)
  result.searchedRoutes.push('normal_artian_to_gogma')
  // No legal conversion position inside the Skill window: no base can exist.
  if (conversions.positions.length === 0) return
  for (const counter of counters) {
    if (counter.counter === null) continue
    const start = counter.counter
    const normalReservation = context.reservation?.normal(counter.id) ?? EMPTY_COUNTER_RESERVATION
    const keepLayouts = new Set<string>()
    // The shape's own offset: no other offset is predicted, queued or read as an extent stop.
    const shapeOffset = constraint === undefined ? undefined : constraint.productionTargetPosition - start
    const scheduleOffset = (offset: number): void => {
      if (shapeOffset !== undefined && (offset !== shapeOffset || offset < 0 || offset >= input.maxNormalAdvance)) return
      if (offset >= input.maxNormalAdvance) {
        // The next forge count is reachable work the extent leaves unread.
        scheduler.noteExtentReached()
        return
      }
      const candidateCounter = start + offset
      const creation = heldPrefixNormalCreation(normalReservation, start, candidateCounter)
      const forgeCount = creation.count
      scheduler.queue.enqueue({
        lowerBound: forgeCount + 1,
        async settle() {
          // A fixed Route's production target: this Route's own target
          // cannot stand there (its Counter-advance forges may).
          if (normalReservation.isBlocked(candidateCounter)) {
            scheduleOffset(offset + 1)
            return
          }
          const converted = conversions.positions.map((position) => conversions.at(position))
          const bonuses = context.normalPredictions?.get(candidateCounter) ?? engine.predictNormalArtian({
            baseSeed, weaponTypeId: target.weaponTypeId, elementId: target.elementId,
            rarity: counter.rarity, normalCounter: candidateCounter, master: input.master,
          })
          context.normalPredictions?.set(candidateCounter, bonuses)
          // Keep preserves family counts. Later Reset routes are already
          // represented by offset zero; an incompatible Keep-only base cannot
          // reach the unordered Ideal bonus multiset, at any Skill position.
          if (initialSearch && offset > 0 && keepFamilyMultisetKey(bonuses, input.master) !== idealFamilyMultiset) {
            scheduleOffset(offset + 1)
            return
          }
          const layout = keepFamilyLayoutKey(bonuses, input.master)
          const firstLayout = !keepLayouts.has(layout)
          keepLayouts.add(layout)
          // Normal-scope slots can never be Ideal (even identical labels).
          // No amendment-free Candidate is lost here. Keep the first base's
          // ordinary scope validation, notices and full canonical frontier.
          if (initialSearch && offset > 0 && (!canSearchAmendments || !firstLayout ||
            !engine.capabilities.supportsKeepBonusesPrediction)) {
            scheduleOffset(offset + 1)
            return
          }
          const normalCounterAfter = engine.advanceNormalCounter(creation.normalCounterBefore, { type: 'create_normal_artian', count: forgeCount })
          for (const [index, conversion] of converted.entries()) {
            if (index > 0) await context.execution.checkpoint()
            const operations: RouteOperation[] = [
              { type: 'create_normal_artian', weaponTypeId: target.weaponTypeId, rarity: counter.rarity, count: forgeCount, normalCounterBefore: creation.normalCounterBefore, normalCounterAfter },
              { type: 'convert_normal_to_gogma', weaponTypeId: target.weaponTypeId, skillCounterBefore: conversion.skillCounter, skillCounterAfter: conversion.skillCounterAfter },
            ]
            scheduler.addBase({
              kindResolution: { type: 'fixed', kind: 'normal_artian_to_gogma' },
              sourceOwnedWeaponId: null,
              baseOperations: operations,
              conversionSkill: conversion.conversionSkill,
              zeroBonus: { gogmaAdvance: 0, lastResetDepth: 0, finalBonuses: bonuses, restorationBonusScope: 'normal_artian', operations: [], amendmentResults: [] },
              zeroSkill: conversion.zeroSkill,
              startSkillCounter: conversion.skillCounterAfter,
              bonusBase: !canSearchAmendments ? null
                // A shape-constrained base carries no amendmentPolicy; the shape filter adds its shapePolicy (5.6.9).
                : constraint !== undefined ? { startGogmaCounter: input.rngState.gogmaCounter.value as number, bonuses, restorationBonusScope: 'normal_artian' }
                  : { startGogmaCounter: input.rngState.gogmaCounter.value as number, bonuses, restorationBonusScope: 'normal_artian', amendmentPolicy: !initialSearch || offset === 0 ? 'all' : 'keep_only' },
              onCandidate: (candidate) => result.candidates.push(candidate),
              onBonusNotice,
            })
          }
          // This cursor advances once; no previous offset is registered again.
          scheduleOffset(offset + 1)
        },
      })
    }
    scheduleOffset(shapeOffset ?? 0)
  }
}
