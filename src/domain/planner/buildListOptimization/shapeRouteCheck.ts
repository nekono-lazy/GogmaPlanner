/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6, `docs/SEARCH_SPEC.md` 5.6.9), Stage D (moved from the Global
 * Assignment Research Phase D-0A-2b, Issue #154).
 *
 * The independent Route checks of one shape-constrained Entry (`checkShapeConstrainedRoute()`). The shape-constrained Route search
 * can return Route forms the ordinary Searches never return (a lane continued past an Ideal lane start, a Route crossing held
 * positions with a fixed source, conversion and final position), so its delivery is used only after these checks. They never read
 * the Search's internal state: they start again from the Entry, the Planner-start PlannerInput, the Entries generated before it
 * (the formal reservation is derived here again), the expected Route shape, the Production RNG Engine's public API and the
 * CalculationContext, and:
 *
 * 1. predict every operation again, chain units included, in Route order - the new Normal at its production target, the
 *    conversion Skill, every Reset Skills, every Reset Bonuses and every Keep Bonuses (Keep from the five slots the checks
 *    themselves hold, never from the expected final state) - and compare each result with the Candidate's observational traces
 *    and the last state with the final weapon (a Counter-advance forge's weapon is never used: its position alone);
 * 2. check every Counter before / after against `advance*Counter()` and the strict increase of each stream;
 * 3. check that every Keep reads the family layout the shape fixes (the source's, or the Reset at `g1`'s);
 * 4. check the formal reservation's coverage: every position of a stream from its origin (a conversion's Skill stream: `c`) up to
 *    the last own operation is an own operation or held, no own operation stands on a blocked position, every Skill position
 *    below `c` is held, the Normal creation is the canonical held-prefix one, and no source is exclusive or protected;
 * 5. validate the Candidate and the Entry and compare their hashes, CalculationContext, traces and estimates with the Production
 *    authorities;
 * 6. compare the Planner's own required positions (`createPlannerRouteUnitPlans()`) and the source with the shape.
 *
 * It predicts only at the Route's own operation positions (never at a held position of another Target), writes nothing back into
 * the Entry, and its predictions are counted apart from the Search's. `passed` means every check held - never "verified": the
 * ordinary Planner and its Trace Replay (Stage D') are the authority. `validateBuildRoute()` alone is a structural check and is
 * never taken as the result.
 */
import { createTargetDefinitionHash } from '../../buildList'
import {
  areRestorationBonusSetsEqual, collectReferencedOwnedWeaponIds, createReferencedOwnedWeaponsHash, createSearchStateHash, stableStringify,
  V1_NORMAL_ARTIAN_RARITY, validateBuildCandidate, validateBuildListEntry,
} from '../../models/publicTypes'
import type {
  BuildListEntry, GroupSkillId, OwnedWeapon, RestorationBonusScope, RestorationBonusSet, RouteOperation, SeriesSkillId, TargetWeapon,
} from '../../models/publicTypes'
import { keepFamilyLayoutKey } from '../../rng/gogmaBonusFamily'
import type { NormalizedSeed, RngEngine } from '../../rng/rngEngine'
import { emptyPlannerAlternativeReservation, normalizePlannerAlternativeReservation, type PlannerAlternativeReservation } from '../../search/alternative'
import { createCandidateRouteEstimates } from '../../search/candidateFactory'
import { createCounterReservation, heldPrefixNormalCreation, type CounterReservation } from '../../search/counterReservation'
import { satisfiesIdealTarget } from '../../target'
import { derivePlannerAlternativeReservation } from '../alternative/plannerAlternativeReservation'
import { createPlannerRouteUnitPlans } from '../plannerRouteProgress'
import type { BuildListOptimizationContext, ReachTable } from './buildListOptimizationTypes'
import { createCountingRngEngine, snapshotPredictionCallCounts } from './countingRngEngine'
import type { RouteCheckIssue, RouteCheckIssueCode, RouteCheckReport, ShapeConstrainedRouteRequest } from './routeGenerationTypes'

export interface ShapeRouteCheckInput {
  entry: BuildListEntry
  request: ShapeConstrainedRouteRequest
  context: Pick<BuildListOptimizationContext, 'plannerInput' | 'planningTargets'>
  table: Pick<ReachTable, 'originSkill' | 'originGogma' | 'targets'>
  /** The Entries generated before this Target, in order: the only source of the formal reservation. */
  materializedEntries: readonly BuildListEntry[]
  /** The Production RNG Engine (wrapped here once more, so the checks' predictions are counted on their own). */
  engine: RngEngine
}

/** The weapon the checks hold while they walk the Route (their own state, never the Search's). */
interface WeaponState {
  bonuses: RestorationBonusSet | null
  scope: RestorationBonusScope | null
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
}

const same = (left: unknown, right: unknown) => stableStringify(left) === stableStringify(right)

class StopChecks extends Error {}

function normalOriginOf(context: ShapeRouteCheckInput['context'], counterId: string): number | null {
  const counter = context.plannerInput.normalCounters.find(value => value.id === counterId)
  return counter !== undefined && counter.isConfirmed && counter.counter !== null ? counter.counter : null
}

function formalReservation(entries: readonly BuildListEntry[], engine: RngEngine): PlannerAlternativeReservation {
  return entries.length === 0 ? structuredClone(emptyPlannerAlternativeReservation) : derivePlannerAlternativeReservation(entries, engine)
}

/** Pure apart from the Engine calls it makes; never throws for a failed check (it reports it), only for a programming error. */
export function checkShapeConstrainedRoute(input: ShapeRouteCheckInput): RouteCheckReport {
  const counting = createCountingRngEngine(input.engine)
  const engine = counting.engine
  const issues: RouteCheckIssue[] = []
  const issue = (code: RouteCheckIssueCode, operationIndex: number | null, detail: string) => { issues.push({ code, operationIndex, detail }) }
  const { entry, request, context, table } = input
  const plannerInput = context.plannerInput
  const candidate = entry.candidateSnapshot
  const route = candidate.route
  const operations = route.operations
  const shape = request.shape
  const routeShape = request.routeShape
  const base = routeShape.base
  const master = plannerInput.master
  const seed = plannerInput.rngState.baseSeed.value as NormalizedSeed
  const originSkill = table.originSkill
  const originGogma = table.originGogma

  const finish = (): RouteCheckReport => ({ passed: issues.length === 0, issues, checkedOperations: operations.length, predictions: snapshotPredictionCallCounts(counting.counts) })

  // 4 (part): the formal reservation, derived again from the earlier Entries.
  let reservation: PlannerAlternativeReservation
  try {
    reservation = formalReservation(input.materializedEntries, engine)
  } catch (error) {
    issue('reservation_mismatch', null, `The formal reservation cannot be derived from the earlier Entries: ${error instanceof Error ? error.message : String(error)}`)
    return finish()
  }
  if (!same(normalizePlannerAlternativeReservation(reservation), normalizePlannerAlternativeReservation(request.reservation))) {
    issue('reservation_mismatch', null, 'The request reservation is not the formal reservation of the earlier Entries.')
  }
  const skillReservation = createCounterReservation(reservation.skill.held, reservation.skill.blocked)
  const gogmaReservation = createCounterReservation(reservation.gogma.held, reservation.gogma.blocked)
  const normalReservationOf = (counterId: string): CounterReservation => {
    const value = reservation.normal.find(item => item.counterId === counterId)
    return createCounterReservation(value?.held ?? [], value?.blocked ?? [])
  }

  // 5 (part): the Target, the Candidate and the Entry.
  const target: TargetWeapon | undefined = context.planningTargets.find(value => value.id === request.targetWeaponId)
  if (target === undefined) {
    issue('target_mismatch', null, `Target ${request.targetWeaponId} is not a planning Target.`)
    return finish()
  }
  if (entry.targetWeaponId !== target.id || candidate.targetWeaponId !== target.id) issue('target_mismatch', null, 'The Entry or its Candidate names another Target.')
  if (entry.candidateId !== candidate.id) issue('entry_invalid', null, 'The Entry does not name its own Candidate snapshot.')
  const candidateValidation = validateBuildCandidate(candidate, plannerInput.ownedWeapons)
  if (!candidateValidation.isValid) issue('candidate_invalid', null, candidateValidation.issues.map(({ path, message }) => `${path}: ${message}`).join('; '))
  const entryValidation = validateBuildListEntry(entry)
  if (!entryValidation.isValid) issue('entry_invalid', null, entryValidation.issues.map(({ path, message }) => `${path}: ${message}`).join('; '))

  // Route base, source and kind.
  const expectedSource = base.kind === 'new_normal' ? null : base.ownedWeaponId
  if (route.sourceOwnedWeaponId !== expectedSource || shape.match.sourceOwnedWeaponId !== expectedSource) {
    issue('source_mismatch', null, `The Route source ${String(route.sourceOwnedWeaponId)} is not the shape's ${String(expectedSource)}.`)
  }
  const kindOk = base.kind === 'owned_gogma' ? route.kind.startsWith('existing_gogma_')
    : base.kind === 'owned_normal' ? route.kind === 'owned_normal_artian_to_gogma' : route.kind === 'normal_artian_to_gogma'
  if (!kindOk) issue('route_kind_mismatch', null, `RouteKind ${route.kind} is not one of a ${base.kind} base.`)

  const ownedById = new Map<string, OwnedWeapon>(plannerInput.ownedWeapons.map(weapon => [weapon.id, weapon]))
  const sourceWeapon = expectedSource === null ? null : ownedById.get(expectedSource) ?? null
  if (expectedSource !== null && sourceWeapon === null) {
    issue('source_mismatch', null, `The source OwnedWeapon ${expectedSource} is not in the PlannerInput.`)
    return finish()
  }
  // 4 (part): no exclusive weapon, no protected weapon operated.
  for (const id of collectReferencedOwnedWeaponIds(route)) {
    if (reservation.exclusiveOwnedWeaponIds.includes(id)) issue('exclusive_source', null, `The Route uses ${id}, an exclusive weapon of an earlier Route.`)
  }
  const operated = new Set<string>()
  if (base.kind === 'owned_normal') operated.add(base.ownedWeaponId)
  for (const operation of operations) {
    if ((operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses' || operation.type === 'reset_skills') && operation.sourceOwnedWeaponId !== null) operated.add(operation.sourceOwnedWeaponId)
  }
  for (const id of operated) if (ownedById.get(id)?.isProtected === true) issue('protected_source', null, `The Route operates the protected weapon ${id}.`)

  // 1 - 4: the operations, in Route order.
  const state: WeaponState = sourceWeapon === null
    ? { bonuses: null, scope: null, seriesSkillId: null, groupSkillId: null }
    : { bonuses: structuredClone(sourceWeapon.restorationBonuses), scope: sourceWeapon.restorationBonusScope, seriesSkillId: sourceWeapon.seriesSkillId ?? null, groupSkillId: sourceWeapon.groupSkillId ?? null }
  const sourceLayout = state.bonuses === null ? null : keepFamilyLayoutKey(state.bonuses, master)
  const expectedBase: RouteOperation['type'][] = base.kind === 'new_normal' ? ['create_normal_artian', 'convert_normal_to_gogma']
    : base.kind === 'owned_normal' ? ['convert_normal_to_gogma'] : []
  const amendmentSource = base.kind === 'owned_gogma' ? base.ownedWeaponId : null
  let skillNext = originSkill
  let gogmaNext = originGogma
  let lastSkill: number | null = null
  let lastBonus: number | null = null
  let lastReset: number | null = null
  let keeps = 0
  let keepLayout: string | null = routeShape.bonus.kind === 'keep' ? sourceLayout : null
  let conversionIndex: number | null = null
  const bonusTrace = new Map((candidate.bonusAmendmentTrace ?? []).map(step => [step.operationIndex, step]))
  const skillTrace = new Map((candidate.skillAmendmentTrace ?? []).map(step => [step.operationIndex, step]))
  const bonusOperations: number[] = []
  const skillOperations: number[] = []

  const predict = <T>(operationIndex: number, label: string, call: () => T): T => {
    try {
      return call()
    } catch (error) {
      issue('prediction_unavailable', operationIndex, `${label}: ${error instanceof Error ? error.message : String(error)}`)
      throw new StopChecks()
    }
  }
  const covered = (stream: 'skill' | 'gogma', reservationOf: CounterReservation, from: number, to: number, operationIndex: number) => {
    for (let position = from; position < to; position++) {
      if (!reservationOf.isHeld(position)) issue('coverage_gap', operationIndex, `${stream} position ${position} before the operation at ${to} is neither an own operation nor held.`)
    }
  }
  const advanced = (operationIndex: number, expected: number, actual: number, what: string) => {
    if (expected !== actual) issue('counter_advance_mismatch', operationIndex, `${what}: the Engine advances to ${expected}, the operation says ${actual}.`)
  }

  try {
    for (const [index, operation] of operations.entries()) {
      if (index < expectedBase.length) {
        if (operation.type !== expectedBase[index]) {
          issue('operation_sequence', index, `Operation ${index} is ${operation.type}, the ${base.kind} base needs ${expectedBase[index]}.`)
          throw new StopChecks()
        }
      } else if (operation.type === 'create_normal_artian' || operation.type === 'convert_normal_to_gogma') {
        issue('operation_sequence', index, `A ${operation.type} after the Route base.`)
        throw new StopChecks()
      }
      switch (operation.type) {
        case 'create_normal_artian': {
          if (base.kind !== 'new_normal') throw new StopChecks()
          if (operation.normalCounterBefore === null || operation.normalCounterAfter === null) {
            issue('operation_sequence', index, 'A blind creation: the route generation never plans one.')
            throw new StopChecks()
          }
          if (operation.weaponTypeId !== target.weaponTypeId || `${operation.weaponTypeId}:${operation.rarity}` !== base.counterId) {
            issue('production_target_mismatch', index, `The creation is on ${operation.weaponTypeId}:${operation.rarity}, the shape on ${base.counterId}.`)
          }
          const p = base.productionTargetPosition
          if (operation.normalCounterAfter - 1 !== p) issue('production_target_mismatch', index, `The production target is ${operation.normalCounterAfter - 1}, the shape's ${p}.`)
          const origin = normalOriginOf(context, base.counterId)
          const normal = normalReservationOf(base.counterId)
          if (origin === null) issue('normal_creation_not_canonical', index, `Counter ${base.counterId} has no confirmed Planner-start value.`)
          else {
            const canonical = heldPrefixNormalCreation(normal, origin, p)
            if (canonical.normalCounterBefore !== operation.normalCounterBefore || canonical.normalCounterAfter !== operation.normalCounterAfter || canonical.count !== operation.count) {
              issue('normal_creation_not_canonical', index, `The creation ${operation.normalCounterBefore}..${operation.normalCounterAfter} (${operation.count}) is not the held-prefix one ${canonical.normalCounterBefore}..${canonical.normalCounterAfter} (${canonical.count}).`)
            }
            for (let position = origin; position < operation.normalCounterBefore; position++) {
              if (!normal.isHeld(position)) issue('coverage_gap', index, `Normal position ${position} before the creation is not held.`)
            }
          }
          if (normal.isBlocked(p)) issue('blocked_position', index, `The production target ${p} is blocked.`)
          if (operation.count !== operation.normalCounterAfter - operation.normalCounterBefore) issue('counter_advance_mismatch', index, 'The forge count is not the Counter span.')
          let cursor = operation.normalCounterBefore
          for (let unit = 0; unit < operation.count; unit++) cursor = engine.advanceNormalCounter(cursor, { type: 'create_normal_artian', count: 1 })
          advanced(index, cursor, operation.normalCounterAfter, 'Normal Counter (forge by forge)')
          advanced(index, engine.advanceNormalCounter(operation.normalCounterBefore, { type: 'create_normal_artian', count: operation.count }), operation.normalCounterAfter, 'Normal Counter')
          // Only the production target's weapon is used; the Counter-advance forges are checked by position alone.
          state.bonuses = predict(index, 'Normal Artian prediction', () => engine.predictNormalArtian({ baseSeed: seed, weaponTypeId: target.weaponTypeId, elementId: target.elementId, rarity: V1_NORMAL_ARTIAN_RARITY, normalCounter: p, master }))
          state.scope = 'normal_artian'
          if (routeShape.bonus.kind === 'keep') keepLayout = keepFamilyLayoutKey(state.bonuses, master)
          break
        }
        case 'convert_normal_to_gogma': {
          if (base.kind === 'owned_gogma') throw new StopChecks()
          const c = operation.skillCounterBefore
          conversionIndex = index
          if (c !== base.conversionSkillPosition) issue('conversion_position_mismatch', index, `The conversion is at ${c}, the shape's at ${base.conversionSkillPosition}.`)
          if (operation.weaponTypeId !== target.weaponTypeId) issue('target_mismatch', index, `The conversion is of ${operation.weaponTypeId}.`)
          advanced(index, engine.advanceSkillCounter(c, { type: 'convert_normal_to_gogma' }), operation.skillCounterAfter, 'Skill Counter (conversion)')
          if (c < skillNext) issue('counter_discontinuity', index, `The conversion at ${c} precedes the Skill origin ${skillNext}.`)
          covered('skill', skillReservation, skillNext, c, index)
          if (skillReservation.isBlocked(c)) issue('blocked_position', index, `The conversion position ${c} is blocked.`)
          if (state.bonuses === null) {
            issue('operation_sequence', index, 'A conversion without a Normal weapon.')
            throw new StopChecks()
          }
          const skills = predict(index, 'conversion Skill prediction', () => engine.predictSkills({ baseSeed: seed, skillCounter: c, weaponTypeId: target.weaponTypeId, elementId: target.elementId, master }))
          const trace = candidate.conversionSkillTrace
          if (trace === undefined || trace.operationIndex !== index || trace.operationType !== 'convert_normal_to_gogma'
            || trace.seriesSkillId !== skills.seriesSkillId || trace.groupSkillId !== skills.groupSkillId) {
            issue('trace_mismatch', index, `The conversion Skill trace ${JSON.stringify(trace ?? null)} is not the prediction ${JSON.stringify(skills)} at ${c}.`)
          }
          state.seriesSkillId = skills.seriesSkillId
          state.groupSkillId = skills.groupSkillId
          state.scope = 'normal_artian'
          skillNext = operation.skillCounterAfter
          break
        }
        case 'reset_skills': {
          const s = operation.skillCounterBefore
          skillOperations.push(index)
          if (routeShape.skill.kind !== 'reset_skills') issue('operation_sequence', index, 'A Reset Skills on a zero Skill lane.')
          if (operation.sourceOwnedWeaponId !== amendmentSource) issue('source_mismatch', index, `Reset Skills on ${String(operation.sourceOwnedWeaponId)}, the shape's weapon is ${String(amendmentSource)}.`)
          if (s < skillNext) issue('counter_discontinuity', index, `Reset Skills at ${s} does not follow ${skillNext - 1}.`)
          else covered('skill', skillReservation, skillNext, s, index)
          if (skillReservation.isBlocked(s)) issue('blocked_position', index, `Skill position ${s} is blocked.`)
          advanced(index, engine.advanceSkillCounter(s, { type: 'reset_skills' }), operation.skillCounterAfter, 'Skill Counter (Reset Skills)')
          const skills = predict(index, 'Reset Skills prediction', () => engine.predictSkills({ baseSeed: seed, skillCounter: s, weaponTypeId: target.weaponTypeId, elementId: target.elementId, master }))
          const trace = skillTrace.get(index)
          if (trace === undefined || trace.operationType !== 'reset_skills' || trace.seriesSkillId !== skills.seriesSkillId || trace.groupSkillId !== skills.groupSkillId) {
            issue('trace_mismatch', index, `The Reset Skills trace ${JSON.stringify(trace ?? null)} is not the prediction ${JSON.stringify(skills)} at ${s}.`)
          }
          state.seriesSkillId = skills.seriesSkillId
          state.groupSkillId = skills.groupSkillId
          skillNext = operation.skillCounterAfter
          lastSkill = s
          break
        }
        case 'reset_bonuses':
        case 'keep_bonuses': {
          const g = operation.gogmaCounterBefore
          bonusOperations.push(index)
          const lane = routeShape.bonus
          if (lane.kind === 'zero'
            || (lane.kind === 'reset' && operation.type !== 'reset_bonuses')
            || (lane.kind === 'keep' && operation.type !== 'keep_bonuses')
            || (lane.kind === 'reset_then_keep' && operation.type === 'reset_bonuses' && g > lane.resetPosition)
            || (lane.kind === 'reset_then_keep' && operation.type === 'keep_bonuses' && (g <= lane.resetPosition || lastReset !== lane.resetPosition))) {
            issue('operation_sequence', index, `${operation.type} at ${g} is not allowed by the ${lane.kind} Bonus lane.`)
          }
          if (operation.sourceOwnedWeaponId !== amendmentSource) issue('source_mismatch', index, `${operation.type} on ${String(operation.sourceOwnedWeaponId)}, the shape's weapon is ${String(amendmentSource)}.`)
          if (g < gogmaNext) issue('counter_discontinuity', index, `${operation.type} at ${g} does not follow ${gogmaNext - 1}.`)
          else covered('gogma', gogmaReservation, gogmaNext, g, index)
          if (gogmaReservation.isBlocked(g)) issue('blocked_position', index, `Gogma position ${g} is blocked.`)
          advanced(index, engine.advanceGogmaCounter(g, { type: operation.type }), operation.gogmaCounterAfter, `Gogma Counter (${operation.type})`)
          let result: RestorationBonusSet
          if (operation.type === 'reset_bonuses') {
            result = predict(index, 'Reset Bonuses prediction', () => engine.predictGogmaBonus({ baseSeed: seed, gogmaCounter: g, weaponTypeId: target.weaponTypeId, elementId: target.elementId, operation: { type: 'reset_bonuses' }, master }))
            lastReset = g
            if (lane.kind === 'reset_then_keep' && g === lane.resetPosition) {
              keepLayout = keepFamilyLayoutKey(result, master)
              const recorded = table.targets.find(row => row.targetWeaponId === target.id)?.bonus.resetLayoutByPosition.get(g)
              if (recorded !== keepLayout) issue('keep_input_layout_mismatch', index, `The Reset at g1 ${g} has another layout than the ReachTable recorded.`)
            }
          } else {
            const current = state.bonuses
            if (current === null) {
              issue('operation_sequence', index, 'A Keep with unknown current slots.')
              throw new StopChecks()
            }
            const inputLayout = keepFamilyLayoutKey(current, master)
            if (keepLayout === null || inputLayout !== keepLayout) issue('keep_input_layout_mismatch', index, `Keep at ${g} reads layout ${inputLayout.split('\u0000').join('|')}, the shape fixes ${String(keepLayout).split('\u0000').join('|')}.`)
            result = predict(index, 'Keep Bonuses prediction', () => engine.predictGogmaBonus({ baseSeed: seed, gogmaCounter: g, weaponTypeId: target.weaponTypeId, elementId: target.elementId, operation: { type: 'keep_bonuses', currentBonuses: structuredClone(current) }, master }))
            if (keepFamilyLayoutKey(result, master) !== inputLayout) issue('keep_input_layout_mismatch', index, `Keep at ${g} did not keep the slot families.`)
            keeps += 1
          }
          const trace = bonusTrace.get(index)
          if (trace === undefined || trace.operationType !== operation.type || trace.restorationBonusScope !== 'gogma_artian' || !same(trace.restorationBonuses, result)) {
            issue('trace_mismatch', index, `The ${operation.type} trace at ${g} is not the prediction.`)
          }
          state.bonuses = result
          state.scope = 'gogma_artian'
          gogmaNext = operation.gogmaCounterAfter
          lastBonus = g
          break
        }
      }
    }
  } catch (error) {
    if (!(error instanceof StopChecks)) throw error
    return finish()
  }

  // The lanes end at the shape's final positions.
  if (operations.length < expectedBase.length) issue('operation_sequence', null, `The ${base.kind} base needs ${expectedBase.join(', ')}.`)
  const skillLane = routeShape.skill
  if ((skillLane.kind === 'zero' ? null : skillLane.finalPosition) !== lastSkill) issue('operation_sequence', null, `The last Reset Skills is at ${String(lastSkill)}, the shape's Skill lane ends at ${skillLane.kind === 'zero' ? 'zero' : skillLane.finalPosition}.`)
  const bonusLane = routeShape.bonus
  if ((bonusLane.kind === 'zero' ? null : bonusLane.finalPosition) !== lastBonus) issue('operation_sequence', null, `The last Bonus operation is at ${String(lastBonus)}, the shape's Bonus lane ends at ${bonusLane.kind === 'zero' ? 'zero' : bonusLane.finalPosition}.`)
  if (bonusLane.kind === 'reset_then_keep' && (lastReset !== bonusLane.resetPosition || keeps === 0)) issue('operation_sequence', null, `A Reset-then-Keep lane needs its last Reset at ${bonusLane.resetPosition} and a Keep after it.`)
  if (bonusLane.kind === 'keep' && keepLayout !== shape.option.source.layout) issue('keep_input_layout_mismatch', null, 'The source\'s family layout differs from the one the ReachTable recorded.')

  // 1 / 5: traces bound one to one, and the last state is the final weapon.
  if ((candidate.bonusAmendmentTrace ?? []).length !== bonusOperations.length || bonusOperations.some(index => !bonusTrace.has(index))) issue('trace_mismatch', null, 'The Bonus trace is not one entry per Bonus operation.')
  if ((candidate.skillAmendmentTrace ?? []).length !== skillOperations.length || skillOperations.some(index => !skillTrace.has(index))) issue('trace_mismatch', null, 'The Skill trace is not one entry per Reset Skills.')
  if ((candidate.conversionSkillTrace === undefined) !== (conversionIndex === null)) issue('trace_mismatch', null, 'A conversion Skill trace without a conversion, or the reverse.')
  if (state.bonuses === null || state.scope === null) issue('final_state_mismatch', null, 'The final weapon has no five slots.')
  else {
    if (!same(candidate.finalBonuses, state.bonuses) || candidate.restorationBonusScope !== state.scope || candidate.seriesSkillId !== state.seriesSkillId || candidate.groupSkillId !== state.groupSkillId) {
      issue('final_state_mismatch', null, 'The Candidate\'s final weapon is not the re-predicted last state.')
    }
    const match = shape.match
    if (!areRestorationBonusSetsEqual(state.bonuses, match.finalBonuses) || state.scope !== match.restorationBonusScope || state.seriesSkillId !== match.seriesSkillId || state.groupSkillId !== match.groupSkillId) {
      issue('final_state_mismatch', null, 'The re-predicted final weapon is not the shape\'s required-only replay.')
    }
    if (!satisfiesIdealTarget(target, state.bonuses, state.scope, state.seriesSkillId, state.groupSkillId, master)) issue('not_ideal', null, 'The re-predicted final weapon is not Ideal for the Target.')
  }

  // 5: hashes, CalculationContext and estimates against the Production authorities.
  if (candidate.searchStateHash !== createSearchStateHash(route, plannerInput.rngState, plannerInput.normalCounters)) issue('hash_mismatch', null, 'searchStateHash is not the Planner-start state\'s.')
  if (candidate.referencedOwnedWeaponsHash !== createReferencedOwnedWeaponsHash(route, plannerInput.ownedWeapons)) issue('hash_mismatch', null, 'referencedOwnedWeaponsHash is not the Planner-start inventory\'s.')
  if (entry.targetDefinitionHash !== createTargetDefinitionHash(target)) issue('hash_mismatch', null, 'The Entry\'s Target definition hash is not the Target\'s.')
  if (entry.searchStateHash !== candidate.searchStateHash || entry.referencedOwnedWeaponsHash !== candidate.referencedOwnedWeaponsHash) issue('hash_mismatch', null, 'The Entry\'s hashes are not its Candidate\'s.')
  const contextOf = (value: typeof plannerInput.calculationContext) => [value.gameVersion, value.masterDataVersion, value.rngEngineVersion, value.appSchemaVersion]
  if (!same(contextOf(candidate.calculationContext), contextOf(plannerInput.calculationContext)) || !same(contextOf(entry.calculationContext), contextOf(plannerInput.calculationContext))
    || plannerInput.calculationContext.rngEngineVersion !== engine.version) {
    issue('calculation_context_mismatch', null, 'The Candidate / Entry CalculationContext is not the PlannerInput\'s and the Engine\'s.')
  }
  try {
    const estimates = createCandidateRouteEstimates(route, target.weaponTypeId, { master }, { gogmaCounter: originGogma, skillCounter: originSkill, normalCounters: plannerInput.normalCounters })
    if (estimates.estimatedOperationCount !== candidate.estimatedOperationCount || estimates.estimatedGogmaAdvance !== candidate.estimatedGogmaAdvance
      || estimates.estimatedSkillAdvance !== candidate.estimatedSkillAdvance || estimates.estimatedNormalAdvance !== candidate.estimatedNormalAdvance
      || !same(estimates.requiredMaterials, candidate.requiredMaterials)) {
      issue('estimate_mismatch', null, 'The Candidate\'s estimates are not the origin-reach estimates of its Route.')
    }
  } catch (error) {
    issue('estimate_mismatch', null, error instanceof Error ? error.message : String(error))
  }

  // 6: the Planner's required positions and the source against the shape.
  const plans = createPlannerRouteUnitPlans([entry], engine)
  const units = plans.unitPlans.get(entry.id)
  if (plans.rejections.length > 0 || units === undefined) issue('unit_plan_rejected', null, plans.rejections.map(rejection => rejection.detail).join('; ') || 'No unit plan.')
  else {
    const required = { skill: [] as number[], gogma: [] as number[], normal: [] as { counterId: string; position: number }[] }
    for (const unit of units) {
      if (unit.canSkipWhenCounterPassed) continue
      if (unit.counterStream === null || unit.counterBefore === null) required.normal.push({ counterId: '', position: Number.NaN })
      else if (unit.counterStream === 'skill') required.skill.push(unit.counterBefore)
      else if (unit.counterStream === 'gogma') required.gogma.push(unit.counterBefore)
      else required.normal.push({ counterId: unit.counterId ?? '', position: unit.counterBefore })
    }
    const ascending = (values: number[]) => [...values].sort((left, right) => left - right)
    const expected = shape.match.required
    if (!same(ascending(required.skill), expected.skill) || !same(ascending(required.gogma), expected.gogma)
      || !same(required.normal, expected.normal === null ? [] : [expected.normal])) {
      issue('required_positions_mismatch', null, `The Planner's required positions ${JSON.stringify(required)} are not the shape's ${JSON.stringify(expected)}.`)
    }
  }
  return finish()
}
