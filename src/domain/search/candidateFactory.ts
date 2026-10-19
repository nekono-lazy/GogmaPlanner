import { getMaterialCostsFromSubset } from '../master/masterSelectors'
import {
  createReferencedOwnedWeaponsHash,
  createSearchStateHash,
  hashStableValue,
} from '../models/hashing'
import type {
  BonusAmendmentResult,
  BuildCandidate,
  BuildRoute,
  CandidateBonusAmendmentStep,
  CandidateConversionSkillStep,
  CandidateSkillAmendmentStep,
  MaterialRequirement,
  NormalArtianCounter,
  RouteOperation,
  SkillAmendmentResult,
  TargetWeapon,
} from '../models/publicTypes'
import { isBlindCreateNormalArtianOperation } from '../models/publicTypes'
import { validateBuildCandidate } from '../models/validation'
import { createIdealDifference, satisfiesIdealTarget } from '../target'
import { extractIntermediateStateGroups } from './intermediateStateExtraction'
import type { SearchExecutionContext } from './searchExecution'
import { CandidateSearchError } from './searchTypes'
import type { CandidateSearchInput } from './searchTypes'

export interface CandidatePrediction {
  finalBonuses: BuildCandidate['finalBonuses']
  restorationBonusScope: BuildCandidate['restorationBonusScope']
  seriesSkillId: BuildCandidate['seriesSkillId']
  groupSkillId: BuildCandidate['groupSkillId']
  route: BuildRoute
  /**
   * The Bonus stream's predicted result of each amendment of this Route, in
   * execution order. Omitted when the caller has no observational trace; the
   * Candidate then simply carries no `bonusAmendmentTrace`.
   */
  bonusAmendmentResults?: readonly BonusAmendmentResult[]
  /**
   * The Skill stream's predicted result of each Reset Skills of this Route, in
   * execution order. Omitted when the caller has no observational trace; the
   * Candidate then simply carries no `skillAmendmentTrace`.
   */
  skillAmendmentResults?: readonly SkillAmendmentResult[]
  /**
   * The initial Series / Group Skills this Route's `convert_normal_to_gogma`
   * assigns, as already predicted by the Skill stream at the conversion's own
   * Counter position. Omitted when the caller has no observational record; the
   * Candidate then simply carries no `conversionSkillTrace`.
   */
  conversionSkillResult?: SkillAmendmentResult
}

/**
 * Binds the Bonus stream's ordered amendment results to the positions the
 * amendment operations actually occupy in the finished Route.
 *
 * The binding is positional over the amendment operations themselves, not over
 * a precomputed base-operation offset, so a run of identical operation types
 * can never shift by one. A count mismatch is an internal inconsistency and
 * fails loudly rather than displaying a wrong result next to an operation.
 */
export function createCandidateBonusAmendmentTrace(
  operations: readonly RouteOperation[],
  results: readonly BonusAmendmentResult[],
): CandidateBonusAmendmentStep[] {
  const amendments = operations.flatMap((operation, operationIndex) =>
    operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses'
      ? [{ operationIndex, operationType: operation.type }]
      : [],
  )
  if (amendments.length !== results.length) {
    throw new CandidateSearchError(
      'invalid_candidate',
      `Route has ${amendments.length} bonus amendment operation(s) but ${results.length} predicted result(s).`,
    )
  }
  return amendments.map(({ operationIndex, operationType }, index) => ({
    operationIndex,
    operationType,
    restorationBonuses: results[index].restorationBonuses.map((bonus) => ({
      ...bonus,
    })) as CandidateBonusAmendmentStep['restorationBonuses'],
    restorationBonusScope: results[index].restorationBonusScope,
  }))
}

/**
 * The Skill counterpart of `createCandidateBonusAmendmentTrace()`.
 *
 * The binding is positional over the `reset_skills` operations themselves, so a
 * run of consecutive Reset Skills can never shift by one, and a count mismatch
 * fails loudly instead of repeating the final Skills next to every operation.
 */
export function createCandidateSkillAmendmentTrace(
  operations: readonly RouteOperation[],
  results: readonly SkillAmendmentResult[],
): CandidateSkillAmendmentStep[] {
  const amendments = operations.flatMap((operation, operationIndex) =>
    operation.type === 'reset_skills' ? [operationIndex] : [],
  )
  if (amendments.length !== results.length) {
    throw new CandidateSearchError(
      'invalid_candidate',
      `Route has ${amendments.length} Reset Skills operation(s) but ${results.length} predicted result(s).`,
    )
  }
  return amendments.map((operationIndex, index) => ({
    operationIndex,
    operationType: 'reset_skills',
    seriesSkillId: results[index].seriesSkillId,
    groupSkillId: results[index].groupSkillId,
  }))
}

/**
 * Binds one conversion Skill observation to the Route's own conversion
 * operation index.
 *
 * Singular by contract: SEARCH_SPEC 6.1 / 6.1.1 / 6.2 give a conversion Route
 * exactly one `convert_normal_to_gogma`, so any other count while a result was
 * predicted is an internal inconsistency and fails loudly instead of binding to
 * an arbitrary one of them.
 */
export function createCandidateConversionSkillStep(
  operations: readonly RouteOperation[],
  result: SkillAmendmentResult,
): CandidateConversionSkillStep {
  const conversions = operations.flatMap((operation, operationIndex) =>
    operation.type === 'convert_normal_to_gogma' ? [operationIndex] : [],
  )
  if (conversions.length !== 1) {
    throw new CandidateSearchError(
      'invalid_candidate',
      `Route has ${conversions.length} conversion operation(s) but one predicted initial Skill result.`,
    )
  }
  return {
    operationIndex: conversions[0],
    operationType: 'convert_normal_to_gogma',
    seriesSkillId: result.seriesSkillId,
    groupSkillId: result.groupSkillId,
  }
}

/**
 * The in-game item material cost key of one Route operation.
 *
 * This is the game's consumable item cost (`MaterialCostMaster`), not an owned
 * weapon: v1 never consumes an owned Artian weapon as material. Every current
 * `RouteOperation` carries an item cost, so this is total.
 */
function itemMaterialOperation(operation: RouteOperation): {
  type: RouteOperation['type']
  units: number
} {
  return {
    type: operation.type,
    units: operation.type === 'create_normal_artian' ? operation.count : 1,
  }
}

export function collectRequiredMaterialsForOperations(
  operations: readonly RouteOperation[],
  weaponTypeId: string,
  input: Pick<CandidateSearchInput, 'master'>,
): MaterialRequirement[] {
  const quantities = new Map<string, number>()
  operations.forEach((operation) => {
    const info = itemMaterialOperation(operation)
    getMaterialCostsFromSubset(input.master, info.type, weaponTypeId).forEach(
      (cost) => {
        quantities.set(
          cost.materialId,
          (quantities.get(cost.materialId) ?? 0) + cost.quantity * info.units,
        )
      },
    )
  })
  return [...quantities]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([materialId, quantity]) => ({ materialId, quantity }))
}

export function collectRequiredMaterials(
  route: BuildRoute,
  weaponTypeId: string,
  input: Pick<CandidateSearchInput, 'master'>,
): MaterialRequirement[] {
  return collectRequiredMaterialsForOperations(
    route.operations,
    weaponTypeId,
    input,
  )
}

/**
 * The summed required quantity of one operation sequence.
 *
 * SEARCH_SPEC 5.5.3 uses this only as a deterministic tie-break inside one
 * stream's anchor ordering. It is NOT a dominance comparison: the display-only
 * checkpoint dominance never reads materials at all (5.8.4).
 */
export function totalMaterialQuantity(
  operations: readonly RouteOperation[],
  weaponTypeId: string,
  input: Pick<CandidateSearchInput, 'master'>,
): number {
  return collectRequiredMaterialsForOperations(
    operations,
    weaponTypeId,
    input,
  ).reduce((total, requirement) => total + requirement.quantity, 0)
}

/**
 * Operation units of one ordered operation sequence, counting a
 * `create_normal_artian` step as its forge `count`.
 *
 * Split out of `countRouteOperations()` so the constrained enumerator can score
 * a not-yet-composed `(base, Bonus, Skill)` combination with the same authority
 * the finished Candidate estimate uses (SEARCH_SPEC 5.6.7).
 */
export function countRouteOperationUnits(
  operations: readonly RouteOperation[],
): number {
  return operations.reduce(
    (total, operation) =>
      total + (operation.type === 'create_normal_artian' ? operation.count : 1),
    0,
  )
}

export function countRouteOperations(route: BuildRoute): number {
  return countRouteOperationUnits(route.operations)
}

function operationAdvance(
  operations: readonly RouteOperation[],
  stream: 'gogma' | 'skill' | 'normal',
): number | null {
  const values = operations.flatMap((operation) => {
    if (stream === 'normal' && operation.type === 'create_normal_artian') {
      // A blind creation has no absolute Counter pair, so it contributes no
      // representable advance. A Route whose only Normal creation is blind
      // therefore reports `estimatedNormalAdvance = null`, which means "not
      // represented", never "the Normal Counter did not advance".
      return isBlindCreateNormalArtianOperation(operation)
        ? []
        : [operation.normalCounterAfter - operation.normalCounterBefore]
    }
    if (
      stream === 'skill' &&
      (operation.type === 'convert_normal_to_gogma' ||
        operation.type === 'reset_skills')
    ) {
      return [operation.skillCounterAfter - operation.skillCounterBefore]
    }
    if (
      stream === 'gogma' &&
      (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses')
    ) {
      return [operation.gogmaCounterAfter - operation.gogmaCounterBefore]
    }
    return []
  })
  return stream === 'normal' && values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0)
}

/**
 * The route-derived estimate and material fields of one composed result.
 *
 * They are a pure function of the concrete `RouteOperation[]`, the weapon type,
 * and the Master subset, so ordinary Candidate Search and the constrained
 * enumerator (SEARCH_SPEC 5.6.7) share this single authority. Nothing here
 * depends on `searchRunId`, the Clock, or any Candidate ID.
 */
export interface CandidateRouteEstimates {
  estimatedOperationCount: number
  estimatedGogmaAdvance: number
  estimatedSkillAdvance: number
  estimatedNormalAdvance: number | null
  requiredMaterials: MaterialRequirement[]
}

/**
 * The Planner-start Counters an estimate's advances are measured from
 * (`docs/SEARCH_SPEC.md` 3.1 / 5.6.8): the Gogma and Skill Counters and every
 * Normal Artian Counter by `NormalArtianCounter.id`.
 */
export interface CandidateRouteEstimateOrigin {
  gogmaCounter: number | null
  skillCounter: number | null
  normalCounters: readonly Pick<NormalArtianCounter, 'id' | 'counter'>[]
}

/**
 * The reach of one stream: from the origin Counter to the `counterAfter` of
 * the Route's last operation of that stream, or `null` when the Route has no
 * representable operation there (a blind Normal creation included).
 *
 * A Route that runs continuously from the origin - every ordinary Candidate
 * Search and constrained enumeration Route - reaches exactly the sum of its
 * operations' advances, so this equals `operationAdvance()` for it. A Planner
 * Alternative Route crossing held positions reaches further than its own
 * operation count.
 */
function operationReach(
  operations: readonly RouteOperation[],
  stream: 'gogma' | 'skill' | 'normal',
  origin: CandidateRouteEstimateOrigin,
): number | null {
  let reach: number | null = null
  for (const operation of operations) {
    let start: number | null
    let after: number
    if (stream === 'normal' && operation.type === 'create_normal_artian') {
      if (isBlindCreateNormalArtianOperation(operation)) continue
      start = origin.normalCounters.find(
        ({ id }) => id === `${operation.weaponTypeId}:${operation.rarity}`,
      )?.counter ?? null
      after = operation.normalCounterAfter
    } else if (
      stream === 'skill' &&
      (operation.type === 'convert_normal_to_gogma' || operation.type === 'reset_skills')
    ) {
      start = origin.skillCounter
      after = operation.skillCounterAfter
    } else if (
      stream === 'gogma' &&
      (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses')
    ) {
      start = origin.gogmaCounter
      after = operation.gogmaCounterAfter
    } else {
      continue
    }
    if (start === null) {
      throw new Error(`A Route ${stream} operation has no origin Counter to measure its reach from.`)
    }
    reach = after - start
  }
  return reach
}

/**
 * `origin` switches the advances from the operation sum to the reach from the
 * Planner-start Counters (`docs/SEARCH_SPEC.md` 5.6.8). The two agree for every
 * Route continuous from the origin, so only Planner Alternative Search passes
 * it; every other caller keeps the operation sum.
 */
export function createCandidateRouteEstimates(
  route: BuildRoute,
  weaponTypeId: string,
  master: Pick<CandidateSearchInput, 'master'>,
  origin?: CandidateRouteEstimateOrigin,
): CandidateRouteEstimates {
  if (origin !== undefined) {
    return {
      estimatedOperationCount: countRouteOperations(route),
      estimatedGogmaAdvance: operationReach(route.operations, 'gogma', origin) ?? 0,
      estimatedSkillAdvance: operationReach(route.operations, 'skill', origin) ?? 0,
      estimatedNormalAdvance: operationReach(route.operations, 'normal', origin),
      requiredMaterials: collectRequiredMaterials(route, weaponTypeId, master),
    }
  }
  return {
    estimatedOperationCount: countRouteOperations(route),
    estimatedGogmaAdvance: operationAdvance(route.operations, 'gogma') ?? 0,
    estimatedSkillAdvance: operationAdvance(route.operations, 'skill') ?? 0,
    estimatedNormalAdvance: operationAdvance(route.operations, 'normal'),
    requiredMaterials: collectRequiredMaterials(route, weaponTypeId, master),
  }
}

/**
 * Builds one composed Search result, or `null` when it is not an Ideal result.
 *
 * Only the Ideal condition is accepted now. A state that merely satisfies a
 * compromise condition is never an independent Candidate: it is offered to the
 * user as an intermediate state on a lane of an actual Ideal Route, and only
 * when it really lies on one (`docs/SEARCH_SPEC.md` 5.5.4 / 5.8).
 */
export function createCandidateFromPrediction(
  target: TargetWeapon,
  prediction: CandidatePrediction,
  input: CandidateSearchInput,
  execution: SearchExecutionContext,
): BuildCandidate | null {
  if (
    !satisfiesIdealTarget(
      target,
      prediction.finalBonuses,
      prediction.restorationBonusScope,
      prediction.seriesSkillId,
      prediction.groupSkillId,
      input.master,
    )
  ) {
    return null
  }
  const idealDifference = createIdealDifference(
    target,
    prediction.finalBonuses,
    prediction.seriesSkillId,
    prediction.groupSkillId,
  )

  const semanticHash = hashStableValue({
    searchRunId: input.searchRunId,
    targetWeaponId: target.id,
    finalBonuses: prediction.finalBonuses,
    restorationBonusScope: prediction.restorationBonusScope,
    seriesSkillId: prediction.seriesSkillId,
    groupSkillId: prediction.groupSkillId,
    route: prediction.route,
  })
  const candidate: BuildCandidate = {
    id: execution.createCandidateId({ targetWeaponId: target.id, semanticHash }),
    targetWeaponId: target.id,
    finalBonuses: prediction.finalBonuses.map((bonus) => ({ ...bonus })) as BuildCandidate['finalBonuses'],
    restorationBonusScope: prediction.restorationBonusScope,
    seriesSkillId: prediction.seriesSkillId,
    groupSkillId: prediction.groupSkillId,
    route: prediction.route,
    ...createCandidateRouteEstimates(
      prediction.route,
      target.weaponTypeId,
      input,
    ),
    idealDifference,
    searchStateHash: createSearchStateHash(
      prediction.route,
      input.rngState,
      input.normalCounters,
    ),
    referencedOwnedWeaponsHash: createReferencedOwnedWeaponsHash(
      prediction.route,
      input.ownedWeapons,
    ),
    calculationContext: { ...input.calculationContext },
    searchRunId: input.searchRunId,
    createdAt: execution.now(),
    ...(prediction.bonusAmendmentResults === undefined
      ? {}
      : {
          bonusAmendmentTrace: createCandidateBonusAmendmentTrace(
            prediction.route.operations,
            prediction.bonusAmendmentResults,
          ),
        }),
    ...(prediction.skillAmendmentResults === undefined
      ? {}
      : {
          skillAmendmentTrace: createCandidateSkillAmendmentTrace(
            prediction.route.operations,
            prediction.skillAmendmentResults,
          ),
        }),
    ...(prediction.conversionSkillResult === undefined
      ? {}
      : {
          conversionSkillTrace: createCandidateConversionSkillStep(
            prediction.route.operations,
            prediction.conversionSkillResult,
          ),
        }),
  }
  // Derived from the finished Route and the Target definition alone, so it
  // reuses the observational traces this Candidate already carries and adds no
  // RNG prediction call (`docs/SEARCH_SPEC.md` 5.8.1).
  candidate.intermediateStateGroups = extractIntermediateStateGroups(candidate, {
    target,
    master: input.master,
    ownedWeapons: input.ownedWeapons,
  })
  const valid = validateBuildCandidate(candidate, input.ownedWeapons)
  if (!valid.isValid) {
    throw new CandidateSearchError(
      'invalid_candidate',
      valid.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }
  return candidate
}
