/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage C (moved from the Global Assignment Research
 * Phase C-1, Issue #154).
 *
 * Builds the design's `StructuralCandidate` from one Phase B-1 resource assignment
 * (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.3 / 4.4 / 8.1 - 8.3): the static coverage pre-check, the
 * predicted coverers, the materialization order, and one `ExpectedRouteShape` per planning Target.
 *
 * Order of the checks: the ReachTable must belong to the context (same planning Targets in the same
 * order, the same confirmed origins), the assignment must be consistent with the table
 * (`checkStreamCoverage()` validates every option and aggregate before judging), the coverage must be
 * feasible, and only then is every option replayed with `replayReachOptionRequiredOnly()` - the one
 * required-only replay authority (design 5.3) - whose final state becomes the shape's match condition.
 * A replay inconsistency propagates as the existing `BuildListOptimizationInvariantError`; it is never turned
 * into an infeasible or "no Route" result. A `coverage_infeasible` result runs no replay and no
 * prediction, and says nothing about the RNG validity of the options.
 *
 * Nothing here materializes a Route, derives or edits a resource reservation, runs a Search, the Planner
 * or Trace Replay, or changes the assignment (its ordinal, objective, sources and required positions are
 * passed through). The result is not verified, and its objective is never an upper bound (design 6.3).
 */
import type { RngEngine } from '../../rng/rngEngine'
import { requiredPositionsOf } from './assignmentFeasibility'
import type { ResourceAssignmentCandidate } from './assignmentTypes'
import { checkStreamCoverage, coverageStreamLabel, deriveMaterializationOrder } from './coverage'
import type {
  ChainOperation, CoverageInvalidInput, CoverageSegment, CoverageStream, ExpectedRouteShape, PredictedChainSegment, StreamCoverage, StructuralCandidateResult,
} from './coverageTypes'
import { replayReachOptionRequiredOnly } from './requiredOnlyReplay'
import { BuildListOptimizationInvariantError, type BuildListOptimizationContext, type ReachOption, type ReachTable } from './buildListOptimizationTypes'

export interface StructuralCandidateInputs {
  /** The ReachTable the assignment was generated from. */
  table: ReachTable
  /** The context the table was built from (the PlannerInput the replay reads). */
  context: BuildListOptimizationContext
  /** The Engine the table was scanned with. */
  engine: RngEngine
}

function invariant(message: string): never {
  throw new BuildListOptimizationInvariantError('coverage_invariant', message)
}

/** The table must be the context's: the same planning Targets in the same order, the same confirmed origins. */
export function checkTableBelongsToContext(table: ReachTable, context: BuildListOptimizationContext): CoverageInvalidInput | null {
  const planning = context.planningTargets.map(target => target.id)
  const rows = table.targets.map(row => row.targetWeaponId)
  if (planning.length !== rows.length || planning.some((id, index) => id !== rows[index])) {
    return { kind: 'invalid_input', reason: 'planning_target_mismatch', detail: `The ReachTable's Targets [${rows.join(', ')}] differ from the context's planning Targets [${planning.join(', ')}].` }
  }
  const { skillCounter, gogmaCounter } = context.plannerInput.rngState
  if (!skillCounter.isConfirmed || skillCounter.value !== table.originSkill || !gogmaCounter.isConfirmed || gogmaCounter.value !== table.originGogma) {
    return { kind: 'invalid_input', reason: 'origin_mismatch', detail: `The ReachTable origins Skill ${table.originSkill} / Gogma ${table.originGogma} differ from the context's confirmed Counters.` }
  }
  for (const [counterId, origin] of Object.entries(table.originNormal)) {
    const counter = context.plannerInput.normalCounters.find(value => value.id === counterId)
    if (!counter || !counter.isConfirmed || counter.counter !== origin) {
      return { kind: 'invalid_input', reason: 'origin_mismatch', detail: `The ReachTable's Normal Counter ${counterId} origin ${origin} differs from the context's confirmed Counter.` }
    }
  }
  return null
}

/** The operation of a chain segment the option's Target covers (design 8.3); every one of them is a skippable unit. */
function chainOperationOf(stream: CoverageStream, segment: CoverageSegment, option: ReachOption): ChainOperation {
  const where = `Target ${option.targetWeaponId}, ${coverageStreamLabel(stream)} chain ${segment.from}..${segment.to}`
  if (stream.kind === 'normal') {
    if (option.normalRequired === null || segment.to >= option.normalRequired.position) invariant(`${where}: not a Counter-advance forge before the production target.`)
    return 'create_normal_artian'
  }
  if (stream.kind === 'skill') {
    const skill = option.skillRequired
    if (skill.kind === 'none' || segment.to >= skill.finalPosition) invariant(`${where}: not a Reset Skills chain before the final Skill position.`)
    if (skill.kind === 'conversion' && segment.from <= skill.conversionPosition) invariant(`${where}: before or at the conversion ${skill.conversionPosition}.`)
    return 'reset_skills'
  }
  const bonus = option.bonusRequired
  if (bonus.kind === 'none' || segment.to >= bonus.finalPosition) invariant(`${where}: not a Bonus chain before the final Bonus position.`)
  if (bonus.kind === 'reset') return 'reset_bonuses'
  if (bonus.kind === 'keep_from_source') return 'keep_bonuses'
  // reset_then_keep: a Reset chain before the required Reset, a Keep chain between it and the final Keep.
  if (segment.to < bonus.resetPosition) return 'reset_bonuses'
  if (segment.from > bonus.resetPosition) return 'keep_bonuses'
  return invariant(`${where}: contains the required Reset ${bonus.resetPosition}.`)
}

function predictedOf(option: ReachOption, coverage: readonly StreamCoverage[]): ExpectedRouteShape['predicted'] {
  const chainSegments: PredictedChainSegment[] = []
  const ownPositionCount = { skill: 0, gogma: 0, normal: 0 }
  for (const stream of coverage) {
    for (const segment of stream.segments) {
      if (segment.covererTargetWeaponId !== option.targetWeaponId) continue
      ownPositionCount[stream.stream.kind] += segment.to - segment.from + 1
      if (segment.kind === 'chain') chainSegments.push({ stream: stream.stream, from: segment.from, to: segment.to, operation: chainOperationOf(stream.stream, segment, option) })
    }
  }
  return { chainSegments, ownPositionCount }
}

/**
 * The structural candidate of one resource assignment, or why there is none. See the module comment
 * for the check order; `BuildListOptimizationInvariantError` is thrown for a replay or derivation
 * inconsistency, never returned as a result.
 */
export function buildStructuralCandidate(assignment: ResourceAssignmentCandidate, inputs: StructuralCandidateInputs): StructuralCandidateResult {
  const { table, context, engine } = inputs
  const mismatch = checkTableBelongsToContext(table, context)
  if (mismatch) return mismatch
  const coverage = checkStreamCoverage(assignment, table)
  if (coverage.kind === 'invalid_input') return coverage
  if (coverage.kind === 'coverage_infeasible') return { kind: 'coverage_infeasible', assignment, uncovered: coverage.uncovered, firstUncovered: coverage.firstUncovered }
  const plan = deriveMaterializationOrder(assignment, table, coverage.coverage)
  const replayPredictions = { skill: 0, gogmaReset: 0, gogmaKeep: 0, normal: 0 }
  const expectedShapes: ExpectedRouteShape[] = table.targets.map(row => {
    const option = assignment.chosen.get(row.targetWeaponId)!
    const replay = replayReachOptionRequiredOnly(option, context, engine)
    replayPredictions.skill += replay.predictions.skill
    replayPredictions.gogmaReset += replay.predictions.gogmaReset
    replayPredictions.gogmaKeep += replay.predictions.gogmaKeep
    replayPredictions.normal += replay.predictions.normal
    return {
      targetWeaponId: row.targetWeaponId,
      option: replay.option,
      match: {
        sourceOwnedWeaponId: option.source.kind === 'new_normal' ? null : option.source.ownedWeaponId,
        required: requiredPositionsOf(option),
        finalBonuses: replay.finalState.finalBonuses,
        restorationBonusScope: replay.finalState.restorationBonusScope,
        seriesSkillId: replay.finalState.seriesSkillId,
        groupSkillId: replay.finalState.groupSkillId,
      },
      predicted: predictedOf(option, coverage.coverage),
    }
  })
  return {
    kind: 'structural_candidate',
    candidate: {
      kind: 'structural_candidate',
      ordinal: assignment.ordinal,
      assignment,
      coverage: coverage.coverage,
      materializationOrder: plan.order,
      materializationDependencies: plan.skillDependencies,
      expectedShapes,
      replayPredictions,
    },
  }
}
