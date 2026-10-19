/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage C replay (moved from the Global Assignment Research
 * Phase A, Issue #154).
 *
 * Required-only replay of one reach option (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 5.3,
 * `rng_replayed`): the source's initial state (an owned weapon as persisted, or the Production Normal
 * result at the forge position), then the required Skill unit(s) (conversion / Reset Skills), then the
 * required Bonus unit(s) (Reset / Keep), re-predicted with the Engine's public API, and the final state
 * judged with `satisfiesIdealTarget()`.
 *
 * Before any prediction the option itself is checked against the PlannerInput: the source exists and is
 * eligible for the requested units (a protected Normal is never converted, a protected Gogma accepts no
 * operation at all - REQUIREMENTS 21, design 5.2), every required position is a safe integer at or after
 * its stream origin, and `streamEnd` equals the value re-derived here from the required positions and
 * the origins - independently of the generator, because Phase B reads `streamEnd` as its objective and
 * bound (design 6.1 / 10.1).
 *
 * It is an RNG check of the required units only. Skippable chain units another Target may run between
 * them do not change these results (the skip rule's own premise), so they are not replayed. It proves
 * nothing about Production coexistence: no Route is materialized, no Trace Replay runs, and no Planner
 * is involved - those are Phase D / D'. A mismatch is an internal inconsistency between the scan
 * and this replay (both read the same Engine and the same Ideal authority) and fails closed as an
 * invariant error; it is never a game fact.
 */
import type { OwnedWeapon, RestorationBonusSet, TargetWeapon } from '../../models/publicTypes'
import type { NormalizedSeed, RngEngine } from '../../rng/rngEngine'
import { satisfiesIdealTarget } from '../../target/targetEvaluator'
import { BuildListOptimizationInvariantError, type BuildListOptimizationContext, type ReachOption, type ReachOptionFinalState, type StreamEnd } from './buildListOptimizationTypes'

export interface ReachOptionReplayResult {
  /** The same option with `verification: 'rng_replayed'`. */
  option: ReachOption
  /** The replayed final weapon state (the match condition Phase C / D compare against, design 8.3). */
  finalState: ReachOptionFinalState
  /** Engine predictions this replay made. */
  predictions: { skill: number; gogmaReset: number; gogmaKeep: number; normal: number }
}

function fail(code: BuildListOptimizationInvariantError['code'], message: string): never {
  throw new BuildListOptimizationInvariantError(code, message)
}

function requireSupported(engine: RngEngine, query: Parameters<RngEngine['getPredictionSupport']>[0], what: string): void {
  const support = engine.getPredictionSupport(query)
  if (!support.supported) fail('prediction_unsupported', `${what} is unsupported (${support.reason}); the scan never offers an option from an unsupported prediction.`)
}

/** A required position must be a safe integer at or after its stream origin (design 5.5: positions lie inside the scanned window). */
function requirePosition(value: number, origin: number, what: string): void {
  if (!Number.isSafeInteger(value)) fail('requirement_inconsistent', `${what} must be a safe integer (got ${String(value)}).`)
  if (value < origin) fail('requirement_inconsistent', `${what} ${value} is before the stream origin ${origin}.`)
}

function formatNormalEnd(normal: StreamEnd['normal']): string {
  return JSON.stringify(Object.fromEntries(Object.entries(normal).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))))
}

/**
 * Replays `option` for its Target from the context's PlannerInput and `engine`. Returns the
 * `rng_replayed` option and its final state, or throws `BuildListOptimizationInvariantError`.
 */
export function replayReachOptionRequiredOnly(option: ReachOption, context: BuildListOptimizationContext, engine: RngEngine): ReachOptionReplayResult {
  const input = context.plannerInput
  const master = input.master
  const target: TargetWeapon | undefined = context.planningTargets.find(value => value.id === option.targetWeaponId)
  if (!target) fail('target_not_planning', `Target ${option.targetWeaponId} is not a planning Target of this context.`)
  const { baseSeed, skillCounter, gogmaCounter } = input.rngState
  if (!baseSeed.isConfirmed || baseSeed.value === null) fail('requirement_inconsistent', 'The replay needs a confirmed Base Seed.')
  if (!skillCounter.isConfirmed || skillCounter.value === null || !gogmaCounter.isConfirmed || gogmaCounter.value === null) {
    fail('requirement_inconsistent', 'The replay needs a confirmed Skill Counter and Gogma Counter as the stream origins.')
  }
  const seed = baseSeed.value as NormalizedSeed
  const originSkill = skillCounter.value
  const originGogma = gogmaCounter.value
  const { weaponTypeId, elementId } = target
  const predictions = { skill: 0, gogmaReset: 0, gogmaKeep: 0, normal: 0 }
  const { source, skillRequired, bonusRequired } = option
  // The same rule the ReachTable applies: the confirmed rarity-8 Normal Counter of the Target's weapon type, or none.
  const counterRecord = input.normalCounters.find(value => value.weaponTypeId === weaponTypeId && value.rarity === 8) ?? null
  const counter = counterRecord && counterRecord.isConfirmed && counterRecord.counter !== null ? { id: counterRecord.id, origin: counterRecord.counter } : null

  // 1. The source: it must exist in the PlannerInput and be eligible for the requested units.
  let owned: OwnedWeapon | null = null
  if (source.kind === 'new_normal') {
    if (counter === null) fail('requirement_inconsistent', `A new_normal source needs a confirmed rarity-8 Normal Counter for ${weaponTypeId}; none exists.`)
    if (source.counterId !== counter.id) fail('requirement_inconsistent', `new_normal names Counter ${source.counterId}; the Target's confirmed Counter is ${counter.id}.`)
    requirePosition(source.position, counter.origin, 'new_normal position')
    if (option.normalRequired === null || option.normalRequired.position !== source.position || option.normalRequired.counterId !== source.counterId) {
      fail('requirement_inconsistent', 'A new_normal option must name its forge position as normalRequired.')
    }
  } else {
    if (option.normalRequired !== null) fail('requirement_inconsistent', 'An owned source has no Normal forge requirement.')
    owned = input.ownedWeapons.find(weapon => weapon.id === source.ownedWeaponId) ?? null
    if (!owned) fail('source_missing', `OwnedWeapon ${source.ownedWeaponId} is not in the PlannerInput.`)
    if (owned.weaponTypeId !== weaponTypeId || owned.elementId !== elementId) fail('source_kind_mismatch', `OwnedWeapon ${owned.id} is not compatible with Target ${target.id}.`)
    if ((source.kind === 'owned_gogma') !== (owned.kind === 'gogma')) fail('source_kind_mismatch', `OwnedWeapon ${owned.id} is a ${owned.kind} weapon; the option names ${source.kind}.`)
    if (owned.kind === 'normal' && owned.isProtected) fail('source_kind_mismatch', `OwnedWeapon ${owned.id} is a protected Normal and never a conversion source.`)
    // REQUIREMENTS 21: a protected Gogma is never a Reset Bonuses / Keep Bonuses / Reset Skills source. Its only
    // option is the zero-operation one from its current Ideal state (design 5.2).
    if (owned.kind === 'gogma' && owned.isProtected && (skillRequired.kind !== 'none' || bonusRequired.kind !== 'none')) {
      fail('source_kind_mismatch', `OwnedWeapon ${owned.id} is protected; a protected Gogma accepts no Skill or Bonus operation (requested skill ${skillRequired.kind}, bonus ${bonusRequired.kind}).`)
    }
  }

  // 2. Requirement kinds against the source kind, and the required positions against the origins.
  if (skillRequired.kind === 'conversion') {
    if (source.kind === 'owned_gogma') fail('source_kind_mismatch', 'A conversion needs a Normal source.')
    requirePosition(skillRequired.conversionPosition, originSkill, 'conversionPosition')
    requirePosition(skillRequired.finalPosition, originSkill, 'Skill finalPosition')
    if (skillRequired.conversionPosition > skillRequired.finalPosition) fail('requirement_inconsistent', `conversionPosition ${skillRequired.conversionPosition} is after finalPosition ${skillRequired.finalPosition}.`)
  } else if (skillRequired.kind === 'reset_skills') {
    if (source.kind !== 'owned_gogma') fail('source_kind_mismatch', 'Reset Skills needs an owned Gogma source.')
    requirePosition(skillRequired.finalPosition, originSkill, 'Skill finalPosition')
  } else if (source.kind !== 'owned_gogma') {
    fail('source_kind_mismatch', 'A Normal source always needs a conversion.')
  }
  if (bonusRequired.kind === 'none') {
    if (source.kind !== 'owned_gogma' || owned?.restorationBonusScope !== 'gogma_artian') fail('requirement_inconsistent', 'A Bonus requirement of none needs an owned Gogma already in gogma_artian scope.')
  } else {
    requirePosition(bonusRequired.finalPosition, originGogma, 'Gogma finalPosition')
    if (bonusRequired.kind === 'reset_then_keep') {
      requirePosition(bonusRequired.resetPosition, originGogma, 'resetPosition')
      if (bonusRequired.resetPosition >= bonusRequired.finalPosition) fail('requirement_inconsistent', `reset_then_keep needs resetPosition ${bonusRequired.resetPosition} < finalPosition ${bonusRequired.finalPosition}.`)
    }
  }

  // 3. `streamEnd` re-derived from the required positions and the origins (design 4.3: last required position + 1,
  //    the origin for a stream without an operation, the Target's Counter alone on the Normal side). Phase B reads it
  //    as Σ (end − origin), so a generator error here must never pass as rng_replayed.
  const expectedEnd: StreamEnd = {
    skill: skillRequired.kind === 'none' ? originSkill : skillRequired.finalPosition + 1,
    gogma: bonusRequired.kind === 'none' ? originGogma : bonusRequired.finalPosition + 1,
    normal: counter === null ? {} : { [counter.id]: source.kind === 'new_normal' ? source.position + 1 : counter.origin },
  }
  if (option.streamEnd.skill !== expectedEnd.skill) fail('requirement_inconsistent', `streamEnd.skill ${String(option.streamEnd.skill)} differs from the re-derived ${expectedEnd.skill}.`)
  if (option.streamEnd.gogma !== expectedEnd.gogma) fail('requirement_inconsistent', `streamEnd.gogma ${String(option.streamEnd.gogma)} differs from the re-derived ${expectedEnd.gogma}.`)
  const actualNormal = option.streamEnd.normal
  const normalKeys = Object.keys(actualNormal)
  const expectedKeys = Object.keys(expectedEnd.normal)
  if (normalKeys.length !== expectedKeys.length || expectedKeys.some(key => !(key in actualNormal) || actualNormal[key] !== expectedEnd.normal[key])) {
    fail('requirement_inconsistent', `streamEnd.normal ${formatNormalEnd(actualNormal)} differs from the re-derived ${formatNormalEnd(expectedEnd.normal)}.`)
  }

  // 4. The source's initial state.
  let bonuses: RestorationBonusSet
  let scope: ReachOptionFinalState['restorationBonusScope']
  let seriesSkillId: ReachOptionFinalState['seriesSkillId'] = null
  let groupSkillId: ReachOptionFinalState['groupSkillId'] = null
  if (source.kind === 'new_normal') {
    requireSupported(engine, { type: 'normal_artian', weaponTypeId, elementId, rarity: 8 }, 'Normal Artian prediction')
    predictions.normal += 1
    bonuses = engine.predictNormalArtian({ baseSeed: seed, weaponTypeId, elementId, rarity: 8, normalCounter: source.position, master })
    scope = 'normal_artian'
  } else {
    bonuses = structuredClone(owned!.restorationBonuses)
    scope = owned!.restorationBonusScope
    seriesSkillId = owned!.seriesSkillId
    groupSkillId = owned!.groupSkillId
  }

  // 5. The required Skill unit(s): conversion (Skill +1 at c) and / or the final Skill position s*.
  if (skillRequired.kind === 'conversion') {
    requireSupported(engine, { type: 'skill', weaponTypeId, elementId }, 'Skill prediction')
    predictions.skill += 1
    const conversion = engine.predictSkills({ baseSeed: seed, skillCounter: skillRequired.conversionPosition, weaponTypeId, elementId, master })
    seriesSkillId = conversion.seriesSkillId
    groupSkillId = conversion.groupSkillId
    if (skillRequired.finalPosition > skillRequired.conversionPosition) {
      predictions.skill += 1
      const final = engine.predictSkills({ baseSeed: seed, skillCounter: skillRequired.finalPosition, weaponTypeId, elementId, master })
      seriesSkillId = final.seriesSkillId
      groupSkillId = final.groupSkillId
    }
  } else if (skillRequired.kind === 'reset_skills') {
    requireSupported(engine, { type: 'skill', weaponTypeId, elementId }, 'Skill prediction')
    predictions.skill += 1
    const final = engine.predictSkills({ baseSeed: seed, skillCounter: skillRequired.finalPosition, weaponTypeId, elementId, master })
    seriesSkillId = final.seriesSkillId
    groupSkillId = final.groupSkillId
  }

  // 6. The required Bonus unit(s). Reset reads no current slot; Keep reads the current families (any scope).
  const reset = (position: number) => {
    requireSupported(engine, { type: 'gogma_reset', weaponTypeId, elementId, master }, 'Gogma Reset prediction')
    predictions.gogmaReset += 1
    return engine.predictGogmaBonus({ baseSeed: seed, gogmaCounter: position, weaponTypeId, elementId, operation: { type: 'reset_bonuses' }, master })
  }
  const keep = (position: number, current: RestorationBonusSet) => {
    requireSupported(engine, { type: 'gogma_keep', weaponTypeId, elementId, currentBonuses: current, master }, 'Gogma Keep prediction')
    predictions.gogmaKeep += 1
    return engine.predictGogmaBonus({ baseSeed: seed, gogmaCounter: position, weaponTypeId, elementId, operation: { type: 'keep_bonuses', currentBonuses: structuredClone(current) }, master })
  }
  if (bonusRequired.kind === 'reset') {
    bonuses = reset(bonusRequired.finalPosition)
    scope = 'gogma_artian'
  } else if (bonusRequired.kind === 'keep_from_source') {
    bonuses = keep(bonusRequired.finalPosition, bonuses)
    scope = 'gogma_artian'
  } else if (bonusRequired.kind === 'reset_then_keep') {
    bonuses = keep(bonusRequired.finalPosition, reset(bonusRequired.resetPosition))
    scope = 'gogma_artian'
  }

  // 7. The final state must satisfy the Ideal (the same authority the scan used).
  if (!satisfiesIdealTarget(target, bonuses, scope, seriesSkillId, groupSkillId, master)) {
    fail('ideal_mismatch', `Required-only replay of Target ${target.id} (${sourceDescription(option)}) does not reach the Ideal; the scan and the replay disagree.`)
  }
  return {
    option: { ...option, verification: 'rng_replayed' },
    finalState: { finalBonuses: bonuses, restorationBonusScope: scope, seriesSkillId, groupSkillId },
    predictions,
  }
}

function sourceDescription(option: ReachOption): string {
  const source = option.source.kind === 'new_normal' ? `new_normal ${option.source.counterId}@${option.source.position}` : `${option.source.kind} ${option.source.ownedWeaponId}`
  return `${source}, skill ${JSON.stringify(option.skillRequired)}, bonus ${JSON.stringify(option.bonusRequired)}`
}
