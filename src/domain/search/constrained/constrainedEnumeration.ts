import type {
  RestorationBonusSet,
  RouteOperation,
} from '../../models/publicTypes'
import { isBlindCreateNormalArtianOperation } from '../../models/publicTypes'
import type { RngEngine } from '../../rng/rngEngine'
import { evaluateSkillCondition, satisfiesIdealBonuses } from '../../target'
import { createTargetBonusStream } from '../bonusStream'
import { countRouteOperationUnits } from '../candidateFactory'
import { createSearchPredictionSupport } from '../searchPredictionSupport'
import { createSearchExecutionContext } from '../searchExecution'
import { createTargetSkillStream } from '../skillStream'
import {
  evaluateBonusSolutions,
  evaluateSkillSolutions,
  selectIdealBonusAxis,
  selectIdealSkillAxis,
  type EvaluatedBonusSolution,
  type EvaluatedSkillSolution,
} from '../streamSolutions'
import {
  existingGogmaRouteKind,
  routeBonusSolutions,
  routeSkillSolutions,
} from '../routeSearchShared'
import {
  compareConstrainedCandidates,
  constrainedCandidateStableKey,
  createConstrainedCandidate,
} from './constrainedCandidateFactory'
import {
  ConstrainedWorkFrontier,
  constrainedPairKey,
  createConstrainedWorkPriority,
  type ConstrainedWorkItem,
} from './constrainedFrontier'
import { preferredSourceRank } from '../semanticKeys'
import {
  createConstrainedRouteBases,
  type ConstrainedRouteBase,
} from './constrainedRouteBases'
import {
  ConstrainedSearchError,
  type ConstrainedCandidate,
  type ConstrainedCandidateSearchInput,
  type ConstrainedCandidateVisitor,
  type ConstrainedEnumerationExecution,
  type ConstrainedEnumerationResult,
} from './constrainedTypes'
import { assertConstrainedCandidateSearchInput } from './constrainedValidation'

/**
 * Cancellation and Worker yield only. The constrained enumerator produces no
 * Candidate ID and no timestamp, so it never takes an ID factory or a Clock.
 */
export interface ConstrainedEnumerationExecutionOptions {
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
}

/**
 * The raw, retention-free position solutions of one Route base.
 *
 * Both the two Cross axes and the lazy off-axis frontier read these same
 * arrays, so the streams are still solved once per base and the off-axis work
 * adds no extra Engine prediction.
 */
interface ConstrainedBaseSolutions {
  base: ConstrainedRouteBase
  bonusSolutions: EvaluatedBonusSolution[]
  skillSolutions: EvaluatedSkillSolution[]
}

/**
 * One Route base's lattice.
 *
 * `bonusAxis` / `skillAxis` are the base's Ideal Bonus and Ideal Skill
 * solutions. The matrix stores only the two axes and the base's fixed cost,
 * never a cell array.
 */
interface ConstrainedMatrix {
  index: number
  base: ConstrainedRouteBase
  baseOperationUnits: number
  baseNormalAdvance: number | null
  /**
   * Derived once per base, like the two fields above: the Target preference is
   * static input, and the base's source never changes across the lattice.
   */
  basePreferredSourceRank: number
  bonusAxis: EvaluatedBonusSolution[]
  skillAxis: EvaluatedSkillSolution[]
}

interface StreamBoundStops {
  gogma: boolean
  skill: boolean
}

/**
 * Normal Counter advance contributed by a Route base's own operations.
 *
 * A blind Normal creation holds no absolute Counter pair, so it contributes no
 * representable advance and leaves the estimate `null`
 * (`docs/SEARCH_SPEC.md` 6.1.1).
 */
function baseNormalAdvance(operations: readonly RouteOperation[]): number | null {
  const advances = operations.flatMap((operation) =>
    operation.type === 'create_normal_artian' &&
    !isBlindCreateNormalArtianOperation(operation)
      ? [operation.normalCounterAfter - operation.normalCounterBefore]
      : [],
  )
  return advances.length === 0
    ? null
    : advances.reduce((total, value) => total + value, 0)
}

/**
 * Planner-driven constrained candidate enumeration (SEARCH_SPEC 5.6.7,
 * PLANNER_SPEC 9.2.9), delivering Candidates one at a time.
 *
 * This is a separate API from `searchCandidates()` and deliberately does NOT
 * reuse `TargetSearchScheduler`, whose same-result retention, Cross-only
 * horizon, canonical-Ideal termination and bounded output cap are all
 * initial-Search policy. What it does reuse is the retention-free depth output
 * of the existing Skill and Bonus streams, so B1 Skill semantics, B2
 * family-layout frontier dedup, and the Production RNG input-level support
 * contract are unchanged.
 *
 * The enumerator applies none of the initial Search's stopping policies -
 * termination at the canonical Ideal, `CandidateSearchSettings`, or any UI
 * filter. Its only extent authority is `ConstrainedEnumerationBounds`.
 *
 * `onCandidate` receives each Candidate as it is discovered, in the traversal's
 * deterministic best-first order, and may return `'stop'` to end the
 * enumeration without evaluating anything further. That consumer stop is a
 * normal outcome, reported as `stoppedByConsumer`, and is not the
 * `shouldCancel()` cancellation, which still rejects with a
 * `CandidateSearchError('cancelled')`.
 *
 * The Search Domain never learns why the consumer stopped: no Planner conflict
 * DTO, Planner orchestration bound, or Planner type crosses this boundary.
 */
export async function visitConstrainedCandidates(
  input: ConstrainedCandidateSearchInput,
  engine: RngEngine,
  onCandidate: ConstrainedCandidateVisitor,
  options: ConstrainedEnumerationExecutionOptions = {},
): Promise<ConstrainedEnumerationExecution> {
  const target = assertConstrainedCandidateSearchInput(input)
  const { origin, bounds } = input

  if (engine.version !== origin.calculationContext.rngEngineVersion) {
    throw new ConstrainedSearchError(
      'calculation_context_incompatible',
      'The RNG Engine version does not match the origin CalculationContext.',
    )
  }

  const execution = createSearchExecutionContext({
    shouldCancel: options.shouldCancel,
    yieldControl: options.yieldControl,
  })
  const predictionSupport = createSearchPredictionSupport(
    engine,
    target,
    origin.master,
  )
  const skillStream = createTargetSkillStream(
    target,
    {
      rngState: origin.rngState,
      master: origin.master,
      maxSkillAdvance: bounds.maxSkillResetCount,
    },
    engine,
    execution,
    () => predictionSupport.skill().supported,
  )
  const bonusStream = createTargetBonusStream(
    target,
    {
      rngState: origin.rngState,
      master: origin.master,
      maxGogmaAdvance: bounds.maxGogmaAdvance,
    },
    engine,
    execution,
    predictionSupport,
  )

  const { bases, normalBoundReached } = await createConstrainedRouteBases({
    target,
    origin,
    bounds,
    engine,
    execution,
    predictionSupport,
    skillStream,
    normalPredictions: new Map<number, RestorationBonusSet>(),
    // SEARCH_SPEC 5.6.1 continuation rules, evaluated with the shared Target
    // Domain authority. A stream whose current state already satisfies the
    // Ideal condition contributes only its zero-operation solution, which
    // occupies no Counter position and therefore cannot conflict.
    bonusesSatisfyIdeal: (bonuses, scope) =>
      satisfiesIdealBonuses(target, bonuses, scope, origin.master),
    skillsSatisfyIdeal: (seriesSkillId, groupSkillId) =>
      evaluateSkillCondition(
        target.idealSkillCondition,
        seriesSkillId,
        groupSkillId,
      ),
  })

  const streamBounds: StreamBoundStops = { gogma: false, skill: false }
  const matrices: ConstrainedMatrix[] = []
  for (const base of bases) {
    await execution.checkpoint()
    const solved = await solveBase(base)
    const baseOperationUnits = countRouteOperationUnits(base.baseOperations)
    const normalAdvance = baseNormalAdvance(base.baseOperations)
    const basePreferredSourceRank = preferredSourceRank(
      base.sourceOwnedWeaponId,
      target.preferredOwnedWeaponId,
    )
    matrices.push({
      index: matrices.length,
      base,
      baseOperationUnits,
      baseNormalAdvance: normalAdvance,
      basePreferredSourceRank,
      bonusAxis: selectIdealBonusAxis(solved.bonusSolutions),
      skillAxis: selectIdealSkillAxis(solved.skillSolutions),
    })
  }

  const frontier = new ConstrainedWorkFrontier()
  const enqueuedNodes = new Set<string>()
  const evaluatedPairs = new Set<string>()
  const deliveredCandidates = new Set<string>()
  let examinedCandidates = 0
  let evaluatedOffAxisPairs = 0
  let offAxisBoundStop = false
  let stoppedByConsumer = false

  // One seed per matrix. An empty axis means this Route base has no Ideal
  // solution on that stream, so the matrix contributes no cell at all.
  for (const matrix of matrices) enqueue(matrix, 0, 0)

  while (frontier.size > 0) {
    await execution.checkpoint()
    const item = frontier.pop() as ConstrainedWorkItem
    const matrix = matrices[item.matrixIndex]

    if (evaluatedPairs.has(item.pairKey)) {
      // This actual pair was already evaluated. It is not re-evaluated and
      // never recounted, but the frontier node still expands: dropping it would
      // make this matrix's neighbouring cells unreachable.
      expand(matrix, item)
      continue
    }

    if (item.offAxis) {
      if (evaluatedOffAxisPairs >= bounds.maxOffAxisPairEvaluations) {
        // A reachable off-axis cell the cap refuses to evaluate. Every cell
        // reachable from it is off-axis too, so nothing else becomes
        // unreachable, and the enumeration is a bound stop rather than
        // exhaustion.
        offAxisBoundStop = true
        continue
      }
      evaluatedOffAxisPairs += 1
    }
    evaluatedPairs.add(item.pairKey)

    const candidate = evaluatePair(matrix.base, item.bonus, item.skill)
    expand(matrix, item)
    if (candidate === null) continue
    examinedCandidates += 1
    if (candidate === 'rejected') continue
    // Two solutions reaching the same result at different Counter positions
    // carry different concrete operations, so only exact semantic duplicates
    // collapse here. This is not a retention rule.
    const key = constrainedCandidateStableKey(candidate)
    if (deliveredCandidates.has(key)) continue
    deliveredCandidates.add(key)
    if ((await onCandidate(candidate)) === 'stop') {
      stoppedByConsumer = true
      break
    }
  }

  const stoppedByBound =
    normalBoundReached ||
    streamBounds.gogma ||
    streamBounds.skill ||
    offAxisBoundStop
  return {
    targetWeaponId: target.id,
    summary: {
      examinedCandidates,
      evaluatedOffAxisPairs,
      // `exhausted` claims that nothing reachable was left uncovered. A bound
      // stop and a consumer stop both leave work behind, so neither may be
      // reported as exhaustion. `stoppedByBound` stays true only when a bound
      // actually truncated reachable work.
      exhausted: !stoppedByBound && !stoppedByConsumer,
      stoppedByBound,
    },
    stoppedByConsumer,
  }

  /** Queues one lattice cell, once per matrix coordinate pair. */
  function enqueue(matrix: ConstrainedMatrix, i: number, j: number): void {
    if (i >= matrix.bonusAxis.length || j >= matrix.skillAxis.length) return
    const nodeKey = `${matrix.index}:${i},${j}`
    if (enqueuedNodes.has(nodeKey)) return
    enqueuedNodes.add(nodeKey)
    const bonus = matrix.bonusAxis[i]
    const skill = matrix.skillAxis[j]
    frontier.push({
      matrixIndex: matrix.index,
      i,
      j,
      nodeKey,
      pairKey: constrainedPairKey(matrix.base.baseKey, bonus, skill),
      offAxis: i > 0 && j > 0,
      bonus,
      skill,
      // The single shared priority authority, so the traversal order stays
      // coordinate-wise monotone against the two canonical stream orderings.
      priority: createConstrainedWorkPriority(
        {
          baseKey: matrix.base.baseKey,
          operationUnits: matrix.baseOperationUnits,
          normalAdvance: matrix.baseNormalAdvance,
          preferredSourceRank: matrix.basePreferredSourceRank,
        },
        bonus,
        skill,
      ),
    })
  }

  /**
   * Discovers the two lattice neighbours of a settled cell.
   *
   * This is the whole reason no Cartesian product exists: cells are created
   * only from a cell that was actually reached, so the live frontier stays
   * proportional to the work performed rather than to the product of the two
   * axis lengths.
   */
  function expand(matrix: ConstrainedMatrix, item: ConstrainedWorkItem): void {
    enqueue(matrix, item.i + 1, item.j)
    enqueue(matrix, item.i, item.j + 1)
  }

  /**
   * Reads one Route base's raw Bonus and Skill position solutions.
   *
   * `solve()` returns the full depth prefix each stream published before its
   * initial-Search retention, so the same completed outcome reached at a later
   * Counter position survives as a separate solution here.
   */
  async function solveBase(
    base: ConstrainedRouteBase,
  ): Promise<ConstrainedBaseSolutions> {
    const bonusSet =
      base.bonusBase === null
        ? null
        : await bonusStream.solve(base.bonusBase, bounds.maxGogmaAdvance)
    if (bonusSet !== null && bonusSet.steps.length >= bounds.maxGogmaAdvance) {
      streamBounds.gogma = true
    }
    const skillSet =
      base.startSkillCounter === null
        ? null
        : await skillStream.solve(base.startSkillCounter, bounds.maxSkillResetCount)
    if (skillSet !== null && skillSet.steps.length >= bounds.maxSkillResetCount) {
      streamBounds.skill = true
    }

    return {
      base,
      bonusSolutions: evaluateBonusSolutions(
        target,
        { master: origin.master },
        routeBonusSolutions(
          bonusSet,
          base.zeroBonus,
          base.amendmentSourceOwnedWeaponId,
        ),
      ),
      skillSolutions: evaluateSkillSolutions(
        target,
        routeSkillSolutions(
          skillSet,
          base.zeroSkill,
          base.amendmentSourceOwnedWeaponId,
          base.skillAdvanceOffset,
        ),
      ),
    }
  }

  /**
   * Composes one `(Bonus, Skill)` pair into a Candidate.
   *
   * Returns `null` when the pair is not a Candidate at all (an existing-Gogma
   * base at `d = 0` and `k = 0`, whose operation list would be empty), and
   * `'rejected'` when a complete combination was evaluated against the Target
   * conditions but satisfied neither. Axis and off-axis pairs go through this
   * one function, so there is no off-axis-only Candidate factory and no
   * off-axis-only classification, estimate or hash path.
   */
  function evaluatePair(
    base: ConstrainedRouteBase,
    bonus: EvaluatedBonusSolution,
    skill: EvaluatedSkillSolution,
  ): ConstrainedCandidate | 'rejected' | null {
    const kind =
      base.kindResolution.type === 'fixed'
        ? base.kindResolution.kind
        : existingGogmaRouteKind(bonus.solution, skill.solution)
    const operations: RouteOperation[] = [
      ...base.baseOperations,
      ...bonus.solution.operations,
      ...skill.solution.operations,
    ]
    // Planner already derives zero-operation satisfaction directly from the
    // inventory, so constrained re-search emits only actionable alternatives.
    if (kind === 'existing_gogma_current') return null
    return (
      createConstrainedCandidate(target, origin, {
        finalBonuses: bonus.solution.finalBonuses,
        restorationBonusScope: bonus.solution.restorationBonusScope,
        seriesSkillId: skill.solution.seriesSkillId,
        groupSkillId: skill.solution.groupSkillId,
        route: {
          kind,
          sourceOwnedWeaponId: base.sourceOwnedWeaponId,
          operations,
        },
      }) ?? 'rejected'
    )
  }
}

/**
 * Collects a complete constrained enumeration into one sorted array.
 *
 * This is the B8-B1a shape, kept as a helper over the sequential core: it
 * consumes `visitConstrainedCandidates()` to the end and applies the existing
 * `compareConstrainedCandidates()` final ordering. The two orders may differ,
 * and deliberately so - a global sort that also covered not-yet-expanded
 * off-axis cells could only be established by expanding them, which is exactly
 * the Cartesian traversal SEARCH_SPEC 5.6.7 forbids. Incremental delivery is
 * required to be deterministic, semantic, best-first and run-independent, not
 * to equal this array's order. See `docs/CANDIDATE_SEARCH_REDESIGN.md` 4.3.
 */
export async function enumerateConstrainedCandidates(
  input: ConstrainedCandidateSearchInput,
  engine: RngEngine,
  options: ConstrainedEnumerationExecutionOptions = {},
): Promise<ConstrainedEnumerationResult> {
  const candidates: ConstrainedCandidate[] = []
  const execution = await visitConstrainedCandidates(
    input,
    engine,
    (candidate) => {
      candidates.push(candidate)
      return 'continue'
    },
    options,
  )
  // The Target's preferred owned weapon only orders solutions the existing
  // priorities already rate equally; it never changes what was enumerated.
  // The streaming `visitConstrainedCandidates()` delivery order applies the
  // same preference in its own traversal priority, so this final sort is not
  // the only place it takes effect (`docs/SEARCH_SPEC.md` 8.1).
  const preferredOwnedWeaponId =
    input.origin.targetWeapons.find(({ id }) => id === input.targetWeaponId)
      ?.preferredOwnedWeaponId ?? null
  return {
    targetWeaponId: execution.targetWeaponId,
    candidates: candidates.sort((left, right) =>
      compareConstrainedCandidates(left, right, preferredOwnedWeaponId),
    ),
    summary: execution.summary,
  }
}
