/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.13), Stage D (moved from the Global Assignment Research
 * Phase D-0A-2b, Issue #154).
 *
 * The scale of one shape-constrained Search predicted from positions alone, the caller's gate on it, and the caller's runtime
 * budget. The walk and the canonical creation use the very Production primitives the Search walks with (`nextOperationPositions()`,
 * `heldPrefixNormalCreation()`, `createCounterReservation()`), so the prediction cannot drift from the Search's legal-position rule.
 * Nothing here predicts RNG or runs a Search, and nothing holds a default limit: every gate and budget value is the caller's
 * explicit contract.
 */
import type { PlannerAlternativeReservation, PlannerAlternativeSearchExtent } from '../../search/alternative'
import { createCounterReservation, heldPrefixNormalCreation, nextOperationPositions, type CounterReservation } from '../../search/counterReservation'
import type { RouteShapeConstraint } from '../../search/shapeConstrained'
import type { InclusiveRange } from './buildListOptimizationTypes'
import type { PredictionCallCounts } from './countingRngEngine'
import type {
  ShapeConstrainedRouteRequest, ShapeSearchBudget, ShapeSearchBudgetComponent, ShapeSearchScale, ShapeSearchScaleComponent, ShapeSearchScaleGate, ShapeStreamScale,
} from './routeGenerationTypes'

export interface ShapeScaleInput {
  routeShape: RouteShapeConstraint
  reservation: PlannerAlternativeReservation
  origins: ShapeConstrainedRouteRequest['origins']
  extent: PlannerAlternativeSearchExtent
}

function normalReservationOf(reservation: PlannerAlternativeReservation, counterId: string): CounterReservation {
  const entry = reservation.normal.find(value => value.counterId === counterId)
  return createCounterReservation(entry?.held ?? [], entry?.blocked ?? [])
}

/** Own-operation bounds of one lane window: non-held positions plus the held required ones, the non-blocked ones, the longest held run. */
function streamScale(reservation: CounterReservation, window: InclusiveRange | null, required: readonly number[]): ShapeStreamScale {
  if (window === null) return { window: null, minOwnOperations: 0, maxOwnOperations: 0, maxHeldRun: 0 }
  let minOwnOperations = 0
  let maxOwnOperations = 0
  let maxHeldRun = 0
  let heldRun = 0
  for (let position = window.from; position <= window.to; position++) {
    const held = reservation.isHeld(position)
    if (!held || required.includes(position)) minOwnOperations += 1
    if (!reservation.isBlocked(position)) maxOwnOperations += 1
    heldRun = held ? heldRun + 1 : 0
    maxHeldRun = Math.max(maxHeldRun, heldRun)
  }
  return { window: { ...window }, minOwnOperations, maxOwnOperations, maxHeldRun }
}

/**
 * Positions only, before the Search. The conversion walk is the formal `conversionSkillPositions()` one
 * (`[origin, first non-held] \ blocked` below `origin + maxSkillAdvance + 1`).
 */
export async function predictShapeConstrainedSearchScale(input: ShapeScaleInput): Promise<ShapeSearchScale> {
  const { routeShape, reservation, origins, extent } = input
  const base = routeShape.base
  const skillReservation = createCounterReservation(reservation.skill.held, reservation.skill.blocked)
  const gogmaReservation = createCounterReservation(reservation.gogma.held, reservation.gogma.blocked)
  let conversionWalkPositions = 0
  let conversionLegalPositions: number[] = []
  let conversionLegal = true
  if (base.kind !== 'owned_gogma') {
    const limit = origins.skill + extent.maxSkillAdvance + 1
    let skips = 0
    const walk = await nextOperationPositions(skillReservation, origins.skill, limit, async () => { skips += 1 })
    conversionWalkPositions = origins.skill < limit ? skips + 1 : 0
    conversionLegalPositions = walk.positions
    conversionLegal = walk.positions.includes(base.conversionSkillPosition)
  }
  let normalForgeCount = 0
  if (base.kind === 'new_normal' && origins.normal !== null) {
    normalForgeCount = heldPrefixNormalCreation(normalReservationOf(reservation, base.counterId), origins.normal.position, base.productionTargetPosition).count
  }
  const skillLane = routeShape.skill
  const skillWindow = skillLane.kind === 'zero' ? null
    : { from: base.kind === 'owned_gogma' ? origins.skill : base.conversionSkillPosition + 1, to: skillLane.finalPosition }
  const skill = streamScale(skillReservation, skillWindow, skillLane.kind === 'zero' ? [] : [skillLane.finalPosition])
  const bonusLane = routeShape.bonus
  const gogmaWindow = bonusLane.kind === 'zero' ? null : { from: origins.gogma, to: bonusLane.finalPosition }
  const gogmaRequired = bonusLane.kind === 'zero' ? [] : bonusLane.kind === 'reset_then_keep' ? [bonusLane.resetPosition, bonusLane.finalPosition] : [bonusLane.finalPosition]
  const gogmaStream = streamScale(gogmaReservation, gogmaWindow, gogmaRequired)
  const depthUpperBound = skill.minOwnOperations + gogmaStream.minOwnOperations
  const supportQueries: ShapeSearchScale['preBase']['supportQueries'] = []
  if (base.kind === 'new_normal') supportQueries.push('normal_artian')
  if (base.kind !== 'owned_gogma' || skillLane.kind === 'reset_skills') supportQueries.push('skill')
  if (bonusLane.kind === 'reset' || bonusLane.kind === 'reset_then_keep') supportQueries.push('gogma_reset')
  if (bonusLane.kind === 'keep' || bonusLane.kind === 'reset_then_keep') supportQueries.push('gogma_keep')
  return {
    preBase: {
      primitive: base.kind,
      conversionWalkPositions,
      requiredPredictions: { normalArtian: base.kind === 'new_normal' ? 1 : 0, skill: base.kind === 'owned_gogma' ? 0 : 1 },
      baseWorkItems: base.kind === 'owned_gogma' ? 0 : 1,
      supportQueries,
    },
    normalForgeCount,
    conversionLegal,
    conversionLegalPositions,
    skill,
    gogma: {
      ...gogmaStream,
      policy: bonusLane.kind,
      frontierUpperBound: gogmaStream.maxOwnOperations,
      generatedStateUpperBound: depthUpperBound * gogmaStream.maxOwnOperations * (gogmaStream.maxHeldRun + 2),
    },
    depthUpperBound,
  }
}

const SCALE_COMPONENTS: readonly ShapeSearchScaleComponent[] = ['depthUpperBound', 'gogmaGeneratedStateUpperBound', 'normalForgeCount', 'conversionWalkPositions']

function scaleValue(scale: ShapeSearchScale, component: ShapeSearchScaleComponent): number {
  switch (component) {
    case 'depthUpperBound': return scale.depthUpperBound
    case 'gogmaGeneratedStateUpperBound': return scale.gogma.generatedStateUpperBound
    case 'normalForgeCount': return scale.normalForgeCount
    case 'conversionWalkPositions': return scale.preBase.conversionWalkPositions
  }
}

function gateLimit(gate: ShapeSearchScaleGate, component: ShapeSearchScaleComponent): number {
  switch (component) {
    case 'depthUpperBound': return gate.maxDepthUpperBound
    case 'gogmaGeneratedStateUpperBound': return gate.maxGogmaGeneratedStateUpperBound
    case 'normalForgeCount': return gate.maxNormalForgeCount
    case 'conversionWalkPositions': return gate.maxConversionWalkPositions
  }
}

/** The components of `scale` above the caller's gate; empty means the Search may run. */
export function exceededShapeSearchScaleGate(scale: ShapeSearchScale, gate: ShapeSearchScaleGate): ShapeSearchScaleComponent[] {
  return SCALE_COMPONENTS.filter(component => scaleValue(scale, component) > gateLimit(gate, component))
}

const isLimit = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function isValidShapeSearchScaleGate(gate: ShapeSearchScaleGate): boolean {
  return gate !== null && typeof gate === 'object'
    && [gate.maxDepthUpperBound, gate.maxGogmaGeneratedStateUpperBound, gate.maxNormalForgeCount, gate.maxConversionWalkPositions].every(isLimit)
}

export function isValidShapeSearchBudget(budget: ShapeSearchBudget): boolean {
  return budget !== null && typeof budget === 'object' && budget.maxPredictions !== null && typeof budget.maxPredictions === 'object'
    && [budget.maxGogmaGeneratedStates, budget.maxSkillStates, budget.maxSettledWork, budget.maxPredictions.normalArtian, budget.maxPredictions.skill,
      budget.maxPredictions.gogmaReset, budget.maxPredictions.gogmaKeep].every(isLimit)
}

/** What one Search used so far, in the budget's terms. */
export interface ShapeSearchUsage {
  gogmaGeneratedStates: number
  skillStates: number
  settledWork: number
  predictions: PredictionCallCounts
}

/** The budget components the usage exceeds (`used > max`: a Search may use exactly its budget). */
export function exceededShapeSearchBudget(usage: ShapeSearchUsage, budget: ShapeSearchBudget): ShapeSearchBudgetComponent[] {
  const pairs: [ShapeSearchBudgetComponent, number, number][] = [
    ['gogmaGeneratedStates', usage.gogmaGeneratedStates, budget.maxGogmaGeneratedStates],
    ['skillStates', usage.skillStates, budget.maxSkillStates],
    ['settledWork', usage.settledWork, budget.maxSettledWork],
    ['normalArtianPredictions', usage.predictions.normalArtian, budget.maxPredictions.normalArtian],
    ['skillPredictions', usage.predictions.skill, budget.maxPredictions.skill],
    ['gogmaResetPredictions', usage.predictions.gogmaReset, budget.maxPredictions.gogmaReset],
    ['gogmaKeepPredictions', usage.predictions.gogmaKeep, budget.maxPredictions.gogmaKeep],
  ]
  return pairs.filter(([, used, max]) => used > max).map(([component]) => component)
}
