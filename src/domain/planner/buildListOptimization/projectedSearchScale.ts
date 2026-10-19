/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.13), Stage D (moved from the Global Assignment Research
 * Phase D-0A, Issue #154).
 *
 * The Search scale of one projected Candidate Search, computed from its extent before the Search runs, with the very Production
 * primitives the Search walks with (`createCounterReservation()`, `nextOperationPositions()`, `heldPrefixNormalCreation()`), so the
 * prediction cannot drift from the Search's legal-position rule:
 *
 *   conversionPositions  `nextOperationPositions(skill reservation, origin, origin + M + 1)` - the `conversionSkillPositions()`
 *                        walk: `[origin, first non-held] \ blocked` inside the conversion window. An owned Gogma has no
 *                        conversion: 0.
 *   skillLegalWidth      non-blocked positions of the Skill window (`origin .. origin + M - 1`; a conversion Route's
 *                        `origin .. origin + M`, SEARCH_SPEC 3.1).
 *   gogmaLegalWidth      non-blocked positions of `origin .. origin + N - 1`.
 *   normalForgeCount     own forges of the canonical held-prefix creation (PLANNER_SPEC 9.2.19.4) up to the production target;
 *                        0 for an owned source.
 *
 * A projected Candidate Search has no reservation, so it is predicted with the empty reservation from the projected starts. The
 * values are the gate's input; the gate's limits are always the caller's: nothing here holds a default threshold.
 */
import type { PlannerAlternativeReservation } from '../../search/alternative'
import { createCounterReservation, heldPrefixNormalCreation, nextOperationPositions } from '../../search/counterReservation'
import type { NormalArtianCounterId } from './buildListOptimizationTypes'
import type { ShapeSearchExtent } from './routeShape'
import type { PredictedSearchScale, SearchScaleDetail, SearchScaleGate } from './routeGenerationTypes'

export interface SearchScaleInput {
  /** A conversion Route (new / owned Normal source) or an existing Gogma Route. */
  routeBase: 'conversion' | 'owned_gogma'
  /** The reservation the Search reads (the empty reservation for a projected Candidate Search). */
  reservation: PlannerAlternativeReservation
  origins: { skill: number; gogma: number }
  /** A new Normal source's Counter, its start and production target; null for an owned source. */
  normal: { counterId: NormalArtianCounterId; origin: number; productionTarget: number } | null
  extent: ShapeSearchExtent
}

function legalWidth(blocked: readonly number[], from: number, to: number): number {
  const blockedSet = new Set(blocked)
  let width = 0
  for (let position = from; position <= to; position++) if (!blockedSet.has(position)) width += 1
  return width
}

export async function predictProjectedSearchScale(input: SearchScaleInput): Promise<{ scale: PredictedSearchScale; detail: SearchScaleDetail }> {
  const { reservation, origins, extent } = input
  const skillWindow = {
    from: origins.skill,
    to: origins.skill + extent.maxSkillAdvance - (input.routeBase === 'conversion' ? 0 : 1),
  }
  const gogmaWindow = { from: origins.gogma, to: origins.gogma + extent.maxGogmaAdvance - 1 }
  let conversionSkillPositions: number[] = []
  let conversionBeyondExtent = false
  if (input.routeBase === 'conversion') {
    const walk = await nextOperationPositions(
      createCounterReservation(reservation.skill.held, reservation.skill.blocked),
      origins.skill,
      origins.skill + extent.maxSkillAdvance + 1,
      async () => {},
    )
    conversionSkillPositions = walk.positions
    conversionBeyondExtent = walk.beyondLimit
  }
  let normalCreation: SearchScaleDetail['normalCreation'] = null
  if (input.normal !== null) {
    const { counterId, origin, productionTarget } = input.normal
    const counterReservation = reservation.normal.find(entry => entry.counterId === counterId)
    normalCreation = heldPrefixNormalCreation(
      createCounterReservation(counterReservation?.held ?? [], counterReservation?.blocked ?? []),
      origin,
      productionTarget,
    )
  }
  return {
    scale: {
      conversionPositions: conversionSkillPositions.length,
      gogmaLegalWidth: legalWidth(reservation.gogma.blocked, gogmaWindow.from, gogmaWindow.to),
      skillLegalWidth: legalWidth(reservation.skill.blocked, skillWindow.from, skillWindow.to),
      normalForgeCount: normalCreation?.count ?? 0,
    },
    detail: {
      origins: { skill: origins.skill, gogma: origins.gogma, normal: input.normal === null ? null : { counterId: input.normal.counterId, position: input.normal.origin } },
      conversionSkillPositions,
      conversionBeyondExtent,
      skillWindow,
      gogmaWindow,
      normalCreation,
    },
  }
}

export const PROJECTED_SEARCH_SCALE_KEYS = Object.freeze(['conversionPositions', 'gogmaLegalWidth', 'skillLegalWidth', 'normalForgeCount'] as const)

/** The components of `scale` above the caller's gate; empty means the request may run. */
export function exceededSearchScaleGate(scale: PredictedSearchScale, gate: SearchScaleGate): (keyof PredictedSearchScale)[] {
  const limit: Record<keyof PredictedSearchScale, number> = {
    conversionPositions: gate.maxConversionPositions,
    gogmaLegalWidth: gate.maxGogmaLegalWidth,
    skillLegalWidth: gate.maxSkillLegalWidth,
    normalForgeCount: gate.maxNormalForgeCount,
  }
  return PROJECTED_SEARCH_SCALE_KEYS.filter(key => scale[key] > limit[key])
}

/** Whether every gate limit is a non-negative safe integer (the caller states each one explicitly). */
export function isValidSearchScaleGate(gate: SearchScaleGate): boolean {
  return gate !== null && typeof gate === 'object'
    && [gate.maxConversionPositions, gate.maxGogmaLegalWidth, gate.maxSkillLegalWidth, gate.maxNormalForgeCount]
      .every(value => Number.isSafeInteger(value) && value >= 0)
}
