import { useMemo } from 'react'
import { Typography } from '@mui/material'
import { estimateProductionPlanCost } from '../../domain/cost'
import type { ProductionPlan, TargetWeapon, TargetWeaponId, WeaponTypeId } from '../../domain/models/publicTypes'
import { CostEstimateSummary } from '../cost/CostEstimateSummary'
import { costEstimateNotes } from '../cost/costEstimatePresentation'

interface ProductionPlanCostEstimateProps {
  plan: ProductionPlan
  /**
   * Display-only fallback for the weapon type of a Counter-advance Normal
   * whose Plan never registers the production-target Normal; the Plan's own
   * registering Step is the primary source.
   */
  targetWeapons: readonly TargetWeapon[]
}

/**
 * The whole-Plan cost estimate (`docs/UI_FLOW.md` 11.0, `docs/PLANNER_SPEC.md` 8.2).
 *
 * Derived at display time from the persisted physical Steps, so a Step shared
 * by several Targets is counted once and no Candidate or Entry cost is summed.
 * A legacy Plan without `executionEffects` shows that the estimate cannot be
 * derived instead of guessing the Normal creation roles.
 */
export function ProductionPlanCostEstimate({ plan, targetWeapons }: ProductionPlanCostEstimateProps) {
  const estimate = useMemo(
    () =>
      estimateProductionPlanCost(plan, {
        weaponTypeIdByTargetWeaponId: new Map<TargetWeaponId, WeaponTypeId>(
          targetWeapons.map((target) => [target.id, target.weaponTypeId]),
        ),
      }),
    [plan, targetWeapons],
  )
  if (!estimate.available) {
    return (
      <Typography variant="body2" color="text.secondary">
        {costEstimateNotes.legacyPlan}
      </Typography>
    )
  }
  return <CostEstimateSummary summary={estimate.summary} note={costEstimateNotes.planScope} />
}
