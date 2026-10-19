import type {
  CalculationContext,
  RestorationBonusSet,
} from './common'
import type { OwnedWeapon, SkillCondition, TargetWeapon } from './entities'
import type { ProductionPlan } from './planning'

/**
 * Unordered multiset equality with duplicate counts preserved.
 *
 * This is the completed-result contract: Target conditions, Candidate
 * completion, and Candidate semantic identity all compare five slots this way,
 * so slot order alone never creates a second result.
 *
 * It is deliberately NOT the comparison for anything that feeds Keep
 * prediction: use `areRestorationBonusSlotsEqual()` there.
 *
 * Each left slot consumes the first still unmatched right slot with the same
 * `bonusTypeId` and `bonusRankId`; a bit mask records the consumed right slots,
 * so a duplicate on one side must be matched by as many on the other. A set
 * holds five slots, so this is at most 5 x 5 comparisons and allocates nothing.
 */
export function areRestorationBonusSetsEqual(
  left: RestorationBonusSet,
  right: RestorationBonusSet,
): boolean {
  if (left.length !== right.length) return false
  let matchedRight = 0
  for (let leftSlot = 0; leftSlot < left.length; leftSlot += 1) {
    const bonus = left[leftSlot]
    let rightSlot = 0
    while (
      rightSlot < right.length &&
      ((matchedRight & (1 << rightSlot)) !== 0 ||
        right[rightSlot].bonusTypeId !== bonus.bonusTypeId ||
        right[rightSlot].bonusRankId !== bonus.bonusRankId)
    ) {
      rightSlot += 1
    }
    if (rightSlot === right.length) return false
    matchedRight |= 1 << rightSlot
  }
  return true
}

/**
 * Slot-by-slot equality: slot 1 through slot 5 must hold the same
 * `bonusTypeId` and `bonusRankId` in the same positions.
 *
 * Keep Bonuses preserves the bonus family at each slot position and rerolls
 * only the tier, so two results with the identical multiset in a different slot
 * order are different Keep inputs. Wherever that distinction matters, the
 * multiset comparison above is wrong and this one is required.
 */
export function areRestorationBonusSlotsEqual(
  left: RestorationBonusSet,
  right: RestorationBonusSet,
): boolean {
  return left.every(
    (bonus, slot) =>
      bonus.bonusTypeId === right[slot]?.bonusTypeId &&
      bonus.bonusRankId === right[slot]?.bonusRankId,
  )
}

export function isCalculationContextCompatible(
  left: CalculationContext,
  right: CalculationContext,
): boolean {
  return (
    left.gameVersion === right.gameVersion &&
    left.masterDataVersion === right.masterDataVersion &&
    left.rngEngineVersion === right.rngEngineVersion &&
    left.appSchemaVersion === right.appSchemaVersion
  )
}

/**
 * Compatibility for Search and Build List calculation artifacts.
 *
 * App schema 3 changes only Planner physical-action sharing, app schema 4 only
 * how the Planner treats a Route prefix whose shared Counter position another
 * Entry's real operation already passed, and app schema 5 only whether a
 * partial result of a bound-truncated Planner search may be persisted as an
 * executable ProductionPlan. None of the three touches Candidate Search or
 * BuildListEntry snapshot semantics, so a version 2, 3 or 4 BuildCandidate or
 * BuildListEntry remains safe to use under a later version when the other
 * calculation authorities are unchanged.
 *
 * App schema 13 changes only ProductionPlan execution: the Target link of an
 * Entry starting from an existing OwnedWeapon moves from its first physical
 * Step to the Plan start effect (`docs/PLANNER_SPEC.md` 16.2 / 16.11). Candidate
 * Search, BuildCandidate and BuildListEntry snapshot semantics, the checkpoint
 * selection and the improvement preference are untouched, so a version 12
 * BuildCandidate or BuildListEntry stays usable under version 13. Version 1..11
 * stay incompatible under 13.
 *
 * App schema 14 changes only the Production Planner strategy: the full Planner
 * run moves from the bounded Beam Search to Route commitment plus the
 * deterministic scheduler (Issue #103 Phase C,
 * `docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 15.2 / 15.3). Candidate
 * Search, the constrained enumerator, BuildCandidate and BuildListEntry snapshot
 * semantics and staleness are untouched, so a version 12 or 13 BuildCandidate
 * or BuildListEntry stays usable under version 14. Version 1..11 stay
 * incompatible, and the exception never reaches a ProductionPlan: every
 * version 1..13 Plan fails closed under 14.
 *
 * App schema 15 changes only the Production Planner's handling of the
 * Counter-advance forges of a predicted Normal creation (Issue #129,
 * `docs/PLANNER_SPEC.md` 7.0.2): they are fast-forwarded instead of competing
 * as `same_normal_counter` conflicts. Candidate Search, the constrained
 * enumerator, BuildCandidate and BuildListEntry snapshot semantics and
 * staleness are untouched, so a version 12, 13 or 14 BuildCandidate or
 * BuildListEntry stays usable under version 15. Version 1..11 stay
 * incompatible, and the exception never reaches a ProductionPlan: every
 * version 1..14 Plan fails closed under 15.
 *
 * App schema 16 changes only how the Production Plan screen's Conflict
 * what-if and actual repair are calculated and saved (the Planner Alternative
 * scenario, `docs/PLANNER_SPEC.md` 9.2.19.15). Candidate Search, BuildCandidate
 * and BuildListEntry snapshot semantics and staleness are untouched, so a
 * version 12, 13, 14 or 15 BuildCandidate or BuildListEntry stays usable under
 * version 16. Version 1..11 stay incompatible, and the exception never reaches
 * a ProductionPlan: every version 1..15 Plan fails closed under 16.
 *
 * App schema 17 changes only which Planner entry the Build List's ordinary
 * Plan creation and the running Plan's replan Preview run (the ordinary
 * `createPlan()` without the legacy B8 `maxPlannerReruns` budget on its
 * runtime-unsupported retries, `docs/PLANNER_SPEC.md` 9.2.19.15). Candidate
 * Search, the constrained enumerator, BuildCandidate and BuildListEntry
 * snapshot semantics and staleness are untouched, so a version 12, 13, 14, 15
 * or 16 BuildCandidate or BuildListEntry stays usable under version 17.
 * Version 1..11 stay incompatible, and the exception never reaches a
 * ProductionPlan: every version 1..16 Plan fails closed under 17.
 *
 * App schema 18 changes only how a Planner input carrying explicit conflict
 * resolutions is planned and how the Production Plan screen's 「この候補を優先」
 * is calculated and saved (Issue #278, `docs/PLANNER_SPEC.md` 9.6.10).
 * Candidate Search, BuildCandidate and BuildListEntry snapshot semantics and
 * staleness are untouched, so a version 12..17 BuildCandidate or
 * BuildListEntry stays usable under version 18. Version 1..11 stay
 * incompatible. ProductionPlans have their own narrow exception
 * (`isProductionPlanCalculationCompatible()`), never this map.
 *
 * Each exception is directional and deliberately narrow: version 1 stays
 * incompatible, it is never a general forward compatibility for future
 * versions, every other CalculationContext field must still be equal, and the
 * ordinary staleness checks still apply.
 */
const COMPATIBLE_BUILD_RESULT_APP_SCHEMA_VERSIONS: ReadonlyMap<number, readonly number[]> =
  new Map([
    [3, [2]],
    [4, [2, 3]],
    [5, [2, 3, 4]],
    [13, [12]],
    [14, [12, 13]],
    [15, [12, 13, 14]],
    [16, [12, 13, 14, 15]],
    [17, [12, 13, 14, 15, 16]],
    [18, [12, 13, 14, 15, 16, 17]],
  ])

export function isBuildResultCalculationContextCompatible(
  result: CalculationContext,
  current: CalculationContext,
): boolean {
  return (
    result.gameVersion === current.gameVersion &&
    result.masterDataVersion === current.masterDataVersion &&
    result.rngEngineVersion === current.rngEngineVersion &&
    (result.appSchemaVersion === current.appSchemaVersion ||
      (
        COMPATIBLE_BUILD_RESULT_APP_SCHEMA_VERSIONS.get(current.appSchemaVersion) ?? []
      ).includes(result.appSchemaVersion))
  )
}

/**
 * The one explicit ProductionPlan exception: a Plan calculated under app
 * schema 17 stays compatible with a schema 18 runtime only when nothing in it
 * came from an explicit conflict resolution (`docs/PLANNER_SPEC.md` 9.6.10) -
 * no repair lineage and no Conflict with a selection. Those Plans were
 * calculated from an input without resolutions, whose output schema 18 keeps.
 * It is a directional map entry, never a range: no other version and no future
 * version inherits it.
 */
const COMPATIBLE_RESOLUTION_FREE_PRODUCTION_PLAN_APP_SCHEMA_VERSIONS: ReadonlyMap<number, readonly number[]> =
  new Map([[18, [17]]])

/**
 * Whether a persisted ProductionPlan may be used as a current Plan under the
 * current CalculationContext (`docs/PLANNER_SPEC.md` 9.6.10): every caller that
 * decides whether a Plan is current - the Production Plan screen, the Plan
 * start, the Execution runtime and Navigator, the Dashboard, the save point
 * restore and Undo - reads this one function.
 *
 * Both `plan.calculationContext` and `plan.baseSnapshot.calculationContext`
 * are judged by the same rule. Either they equal `current` exactly in all four
 * fields, or `current.appSchemaVersion` has an explicit exception for their
 * `appSchemaVersion` (`18 -> 17`), the other three fields are equal, the Plan
 * carries no `conflictRepairLineage` and no Conflict records a
 * `selectedBuildListEntryId`. The status is not read. The Plan / snapshot
 * consistency check of `validateProductionPlan()` stays exact equality.
 */
export function isProductionPlanCalculationCompatible(
  plan: Pick<ProductionPlan, 'calculationContext' | 'baseSnapshot' | 'conflictRepairLineage' | 'conflicts'>,
  current: CalculationContext,
): boolean {
  const contexts = [plan.calculationContext, plan.baseSnapshot.calculationContext]
  if (contexts.every((context) => isCalculationContextCompatible(context, current))) return true
  const exceptions =
    COMPATIBLE_RESOLUTION_FREE_PRODUCTION_PLAN_APP_SCHEMA_VERSIONS.get(current.appSchemaVersion) ?? []
  return (
    contexts.every((context) =>
      context.gameVersion === current.gameVersion &&
      context.masterDataVersion === current.masterDataVersion &&
      context.rngEngineVersion === current.rngEngineVersion &&
      exceptions.includes(context.appSchemaVersion),
    ) &&
    (plan.conflictRepairLineage ?? null) === null &&
    plan.conflicts.every(({ selectedBuildListEntryId }) => selectedBuildListEntryId === null)
  )
}

/**
 * Whether Candidate Search and the Planner treat this Target as a planning
 * target: it is enabled and still `active`. A `completed` Target keeps its
 * record but is excluded from both inputs (`docs/DATA_MODEL.md` 8.1). This is
 * an input exclusion, never a staleness judgment: the BuildListEntries of a
 * completed Target are not stale.
 */
export function isTargetWeaponPlanningEligible(
  target: Pick<TargetWeapon, 'isEnabled' | 'lifecycleStatus'>,
): boolean {
  return target.isEnabled && target.lifecycleStatus === 'active'
}

export function canResetBonuses(weapon: OwnedWeapon): boolean {
  return weapon.kind === 'gogma' && !weapon.isProtected
}

/**
 * Keep Bonuses legality of an owned Gogma source.
 *
 * An owned Gogma's five slots are always known, so Keep is legal from either
 * `restorationBonusScope`: the Engine resolves each slot's family from its
 * bonus type alone (Normal-side types through the Master mapping) and the
 * result is `gogma_artian` scope (`docs/SEARCH_SPEC.md` 5.9). Only kind and
 * protection decide; scope and status never do.
 */
export function canKeepBonuses(weapon: OwnedWeapon): boolean {
  return weapon.kind === 'gogma' && !weapon.isProtected
}

export function canResetSkills(weapon: OwnedWeapon): boolean {
  return weapon.kind === 'gogma' && !weapon.isProtected
}

export function isSkillConditionUnconstrained(
  condition: SkillCondition,
): boolean {
  return condition.seriesSkillId === null && condition.groupSkillId === null
}
