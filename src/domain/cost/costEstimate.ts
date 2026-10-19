import type {
  BuildCandidate,
  BuildRoute,
  PlanStep,
  PlanStepNormalCreationRole,
  ProductionPlan,
  TargetWeaponId,
  WeaponTypeId,
} from '../models/publicTypes'
import {
  ARTIAN_PART_IDS,
  CONVERSION_DEVICE_COUNT,
  CONVERSION_ZENNY,
  GOGMA_RESTORATION_NANAIRO_KANE,
  GOGMA_RESTORATION_TICKET_COUNT,
  GOGMA_RESTORATION_ZENNY,
  NORMAL_ARTIAN_FORGE_ZENNY,
  NORMAL_FULL_RESTORATION_NANAIRO_KANE,
  NORMAL_FULL_RESTORATION_ZENNY,
  SKILL_REASSIGNMENT_DEVICE_COUNT_DIFFERENT_TYPE,
  SKILL_REASSIGNMENT_DEVICE_COUNT_SAME_TYPE,
  SKILL_REASSIGNMENT_ZENNY,
  getRare8ArtianPartRecipe,
  type ArtianPartId,
  type ArtianPartRequirement,
} from './costEstimateData'

/*
 * Display-only cost estimate (`docs/REQUIREMENTS.md` 22.1,
 * `docs/SEARCH_SPEC.md` 4.3, `docs/PLANNER_SPEC.md` 8.2, `docs/UI_FLOW.md` 9 / 11.0).
 *
 * One cost definition, two adapters. `collectCostEstimateOperationsFromRoute()`
 * reads a Candidate's saved `BuildRoute`; `collectCostEstimateOperationsFromPlan()`
 * reads the physical Steps a ProductionPlan actually executes, so a Step shared
 * by several Targets is counted once. Both feed `summarizeCostEstimate()`.
 *
 * Nothing here is read by Candidate Search, the Planner or Execution: the
 * estimate never enters a Candidate identity, hash, ordering, dedup key,
 * Planner score, Plan validity or persisted shape, and it manages no owned
 * item count and judges no shortage.
 */

/** One game operation that consumes items or zenny, as the cost estimate sees it. */
export type CostEstimateOperation =
  | {
      type: 'create_normal_artian'
      /** `null` when the weapon type could not be resolved; the forge is then unpriced for parts. */
      weaponTypeId: WeaponTypeId | null
      /**
       * The production-target Normal is fully restored once; a Counter-advance
       * Normal is forged and never restored.
       */
      role: PlanStepNormalCreationRole
    }
  | { type: 'convert_normal_to_gogma' }
  | { type: 'reset_bonuses' }
  | { type: 'keep_bonuses' }
  | { type: 'reset_skills' }

export interface CostEstimateSummary {
  /** Every rarity-8 Normal Artian forge, Counter-advance forges included. */
  normalForgeCount: number
  /** Parts of the forges whose weapon type has a recipe, in the fixed part order, zero entries omitted. */
  artianParts: ArtianPartRequirement[]
  /** Forges whose weapon type has no part recipe (or was unresolved); their parts are not listed. */
  unpricedForgeCount: number
  /** Full restorations: one per production-target Normal. */
  normalFullRestorationCount: number
  normalFullRestorationNanairoKane: number
  conversionCount: number
  conversionDeviceCount: number
  /** Reset Bonuses and Keep Bonuses together. */
  gogmaRestorationCount: number
  /** The two figures below are alternatives: one OR the other, never both. */
  gogmaRestorationNanairoKane: number
  gogmaRestorationTicketCount: number
  skillReassignmentCount: number
  /** Primary figure: a 激化 type different from the conversion's. */
  skillReassignmentDeviceCountDifferentType: number
  /** Supplementary figure: the same 激化 type as the conversion, half of the above. */
  skillReassignmentDeviceCountSameType: number
  /** Rough total zenny of every operation above. */
  zenny: number
  /** No operation consumes anything: an owned Ideal confirmed as it is. */
  isEmpty: boolean
}

export function summarizeCostEstimate(
  operations: readonly CostEstimateOperation[],
): CostEstimateSummary {
  const partQuantities = new Map<ArtianPartId, number>()
  let normalForgeCount = 0
  let unpricedForgeCount = 0
  let normalFullRestorationCount = 0
  let conversionCount = 0
  let gogmaRestorationCount = 0
  let skillReassignmentCount = 0

  operations.forEach((operation) => {
    switch (operation.type) {
      case 'create_normal_artian': {
        normalForgeCount += 1
        const recipe = operation.weaponTypeId === null
          ? null
          : getRare8ArtianPartRecipe(operation.weaponTypeId)
        if (recipe === null) {
          unpricedForgeCount += 1
        } else {
          recipe.forEach(({ partId, quantity }) => {
            partQuantities.set(partId, (partQuantities.get(partId) ?? 0) + quantity)
          })
        }
        if (operation.role === 'production_target') normalFullRestorationCount += 1
        return
      }
      case 'convert_normal_to_gogma':
        conversionCount += 1
        return
      case 'reset_bonuses':
      case 'keep_bonuses':
        gogmaRestorationCount += 1
        return
      case 'reset_skills':
        skillReassignmentCount += 1
        return
      default: {
        const exhaustive: never = operation
        throw new Error(`Unknown cost estimate operation: ${JSON.stringify(exhaustive)}`)
      }
    }
  })

  const zenny =
    normalForgeCount * NORMAL_ARTIAN_FORGE_ZENNY +
    normalFullRestorationCount * NORMAL_FULL_RESTORATION_ZENNY +
    conversionCount * CONVERSION_ZENNY +
    gogmaRestorationCount * GOGMA_RESTORATION_ZENNY +
    skillReassignmentCount * SKILL_REASSIGNMENT_ZENNY

  return {
    normalForgeCount,
    artianParts: ARTIAN_PART_IDS.flatMap((partId) => {
      const quantity = partQuantities.get(partId) ?? 0
      return quantity === 0 ? [] : [{ partId, quantity }]
    }),
    unpricedForgeCount,
    normalFullRestorationCount,
    normalFullRestorationNanairoKane:
      normalFullRestorationCount * NORMAL_FULL_RESTORATION_NANAIRO_KANE,
    conversionCount,
    conversionDeviceCount: conversionCount * CONVERSION_DEVICE_COUNT,
    gogmaRestorationCount,
    gogmaRestorationNanairoKane: gogmaRestorationCount * GOGMA_RESTORATION_NANAIRO_KANE,
    gogmaRestorationTicketCount: gogmaRestorationCount * GOGMA_RESTORATION_TICKET_COUNT,
    skillReassignmentCount,
    skillReassignmentDeviceCountDifferentType:
      skillReassignmentCount * SKILL_REASSIGNMENT_DEVICE_COUNT_DIFFERENT_TYPE,
    skillReassignmentDeviceCountSameType:
      skillReassignmentCount * SKILL_REASSIGNMENT_DEVICE_COUNT_SAME_TYPE,
    zenny,
    isEmpty: operations.length === 0,
  }
}

/**
 * The consuming operations of one Candidate Route.
 *
 * A `create_normal_artian` with `count = N` is N forges: N - 1 Counter-advance
 * Normals and one production-target Normal (the last one, the one converted).
 * An owned-weapon Route starts at its first operation, so nothing the user
 * already paid for the owned Normal or Gogma is counted again, and an
 * `existing_gogma_current` Route yields nothing.
 */
export function collectCostEstimateOperationsFromRoute(
  route: BuildRoute,
): CostEstimateOperation[] {
  return route.operations.flatMap((operation): CostEstimateOperation[] => {
    switch (operation.type) {
      case 'create_normal_artian':
        return Array.from({ length: operation.count }, (_, index) => ({
          type: 'create_normal_artian',
          weaponTypeId: operation.weaponTypeId,
          role: index === operation.count - 1 ? 'production_target' : 'counter_advance',
        }))
      case 'convert_normal_to_gogma':
        return [{ type: 'convert_normal_to_gogma' }]
      case 'reset_bonuses':
        return [{ type: 'reset_bonuses' }]
      case 'keep_bonuses':
        return [{ type: 'keep_bonuses' }]
      case 'reset_skills':
        return [{ type: 'reset_skills' }]
      default: {
        const exhaustive: never = operation
        throw new Error(`Unknown route operation: ${JSON.stringify(exhaustive)}`)
      }
    }
  })
}

export function estimateCandidateCost(
  candidate: Pick<BuildCandidate, 'route'>,
): CostEstimateSummary {
  return summarizeCostEstimate(collectCostEstimateOperationsFromRoute(candidate.route))
}

export interface PlanCostEstimateOptions {
  /**
   * Fallback weapon type resolution for a Counter-advance Normal creation
   * whose Entry registers no production-target Normal in the same Plan. The
   * primary source is the registering Step's `inventoryChange.addOwnedWeapon`.
   */
  weaponTypeIdByTargetWeaponId?: ReadonlyMap<TargetWeaponId, WeaponTypeId>
}

export type PlanCostEstimateOperations =
  | { available: true; operations: CostEstimateOperation[] }
  /**
   * A legacy Plan (calculation schema 11 or earlier) records no
   * `executionEffects`, so its Normal creations cannot be told apart into
   * Counter-advance and production-target roles. Nothing is inferred.
   */
  | { available: false; reason: 'legacy_plan' }

/**
 * The consuming operations of one ProductionPlan, from its physical Steps.
 *
 * Every Step is one physical operation, so a Step shared by several Targets
 * is counted once. `confirm_owned_ideal` and the legacy `reserve_weapon` /
 * `confirm_result` Steps consume nothing. Completed Steps are included: the
 * summary describes the whole Plan, not its remainder.
 */
export function collectCostEstimateOperationsFromPlan(
  plan: Pick<ProductionPlan, 'steps'>,
  options: PlanCostEstimateOptions = {},
): PlanCostEstimateOperations {
  const weaponTypeByEntry = new Map<string, WeaponTypeId>()
  plan.steps.forEach((step) => {
    const registered = step.inventoryChange?.addOwnedWeapon ?? null
    if (
      step.operationType === 'create_normal_artian' &&
      step.executionEffects?.registersTrackedWeapon === true &&
      registered !== null &&
      step.buildListEntryId !== null
    ) {
      weaponTypeByEntry.set(step.buildListEntryId, registered.weaponTypeId)
    }
  })

  const resolveWeaponTypeId = (step: PlanStep): WeaponTypeId | null => {
    const byEntry = step.buildListEntryId === null
      ? undefined
      : weaponTypeByEntry.get(step.buildListEntryId)
    if (byEntry !== undefined) return byEntry
    const byTarget = step.targetWeaponId === null
      ? undefined
      : options.weaponTypeIdByTargetWeaponId?.get(step.targetWeaponId)
    return byTarget ?? null
  }

  const operations: CostEstimateOperation[] = []
  for (const step of plan.steps) {
    switch (step.operationType) {
      case 'create_normal_artian': {
        const role = step.executionEffects?.normalCreationRole ?? null
        if (role === null) return { available: false, reason: 'legacy_plan' }
        operations.push({
          type: 'create_normal_artian',
          weaponTypeId: resolveWeaponTypeId(step),
          role,
        })
        break
      }
      case 'convert_normal_to_gogma':
        operations.push({ type: 'convert_normal_to_gogma' })
        break
      case 'reset_bonuses':
        operations.push({ type: 'reset_bonuses' })
        break
      case 'keep_bonuses':
        operations.push({ type: 'keep_bonuses' })
        break
      case 'reset_skills':
        operations.push({ type: 'reset_skills' })
        break
      case 'confirm_owned_ideal':
      case 'reserve_weapon':
      case 'confirm_result':
        break
      default: {
        const exhaustive: never = step.operationType
        throw new Error(`Unknown PlanStep operation type: ${String(exhaustive)}`)
      }
    }
  }
  return { available: true, operations }
}

export type PlanCostEstimate =
  | { available: true; summary: CostEstimateSummary }
  | { available: false; reason: 'legacy_plan' }

export function estimateProductionPlanCost(
  plan: Pick<ProductionPlan, 'steps'>,
  options: PlanCostEstimateOptions = {},
): PlanCostEstimate {
  const collected = collectCostEstimateOperationsFromPlan(plan, options)
  return collected.available
    ? { available: true, summary: summarizeCostEstimate(collected.operations) }
    : collected
}
