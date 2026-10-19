import type {
  ISODateTimeString,
  ProductionPlan,
  ProductionPlanId,
  ProductionPlanStatus,
} from '../../domain/models/publicTypes'
import {
  productionPlanAbandonmentReasonLabels,
  productionPlanRecalculationReasonLabels,
  productionPlanStatusLabels,
} from '../../presentation/labels'
import type { StatusTone } from '../StatusChip'
import { createProductionPlanSummary } from './productionPlanPresentation'

/**
 * Read-only projection of the persisted ProductionPlans for the Production
 * Plan list (`docs/UI_FLOW.md` 11.5).
 *
 * The exact persisted Plan is the only authority: `status`,
 * `recalculationReasons`, `abandonmentReason`, `createdAt`, `updatedAt` and
 * `steps` are read as stored. Nothing here reads a BuildCandidate or a
 * BuildListEntry, re-runs the Planner, predicts RNG, or invents a status such
 * as "failed" or "archived" that the Domain does not have.
 */

/**
 * The tone beside each status label. It only reinforces the label: every
 * status is readable from its text alone (`StatusChip`).
 */
export const productionPlanStatusTones: Record<ProductionPlanStatus, StatusTone> = {
  draft: 'info',
  active: 'positive',
  stale: 'caution',
  completed: 'positive',
  abandoned: 'neutral',
}

/**
 * Most recently changed Plan first: `updatedAt` descending, then `createdAt`
 * descending, then the ID as the stable tie-break. The repository's own
 * ascending order is left alone; this is a presentation sort over a copy.
 */
export function sortProductionPlansForList(
  plans: readonly ProductionPlan[],
): ProductionPlan[] {
  return [...plans].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id),
  )
}

const listDateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * A persisted ISO timestamp in the viewer's local time, for reading at a
 * glance. A value that is not a parseable date is shown as stored rather than
 * replaced by a guess.
 */
export function formatProductionPlanListDateTime(value: ISODateTimeString): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : listDateTimeFormat.format(date)
}

export interface ProductionPlanListItemPresentation {
  planId: ProductionPlanId
  status: ProductionPlanStatus
  statusLabel: string
  statusTone: StatusTone
  /** 「現在の下書き」 for the one Draft; `null` otherwise. */
  statusNote: string | null
  /**
   * The typed reasons shown beside the status: the recalculation reasons of a
   * `stale` Plan, the abandonment reason of an `abandoned` Plan, nothing for
   * the other statuses. Never a raw enum.
   */
  reasonLabels: string[]
  createdAt: ISODateTimeString
  updatedAt: ISODateTimeString
  createdAtLabel: string
  updatedAtLabel: string
  completedStepCount: number
  totalStepCount: number
  /** From `createProductionPlanSummary()`, never `selectedBuildListEntryIds.length`. */
  targetWeaponCount: number
  /** Only an `active` Plan resumes the Execution Navigator. */
  canResumeExecution: boolean
  /** Only the not-yet-started Draft may be deleted from the list. */
  canDeleteDraft: boolean
}

function reasonLabelsFor(plan: ProductionPlan): string[] {
  switch (plan.status) {
    case 'stale': {
      const labels = plan.recalculationReasons.map(
        (reason) => productionPlanRecalculationReasonLabels[reason],
      )
      const distinct = labels.filter((label, index) => labels.indexOf(label) === index)
      return distinct.length > 0 ? distinct : ['再計算理由の記録がありません']
    }
    case 'abandoned':
      return [
        plan.abandonmentReason === null
          ? '終了理由の記録がありません'
          : productionPlanAbandonmentReasonLabels[plan.abandonmentReason],
      ]
    case 'draft':
    case 'active':
    case 'completed':
      return []
  }
}

export function createProductionPlanListItemPresentation(
  plan: ProductionPlan,
): ProductionPlanListItemPresentation {
  const summary = createProductionPlanSummary(plan)
  return {
    planId: plan.id,
    status: plan.status,
    statusLabel: productionPlanStatusLabels[plan.status],
    statusTone: productionPlanStatusTones[plan.status],
    statusNote: plan.status === 'draft' ? '現在の下書き' : null,
    reasonLabels: reasonLabelsFor(plan),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    createdAtLabel: formatProductionPlanListDateTime(plan.createdAt),
    updatedAtLabel: formatProductionPlanListDateTime(plan.updatedAt),
    completedStepCount: plan.steps.filter((step) => step.isCompleted).length,
    totalStepCount: plan.steps.length,
    targetWeaponCount: summary.targetWeaponCount,
    canResumeExecution: plan.status === 'active',
    canDeleteDraft: plan.status === 'draft',
  }
}
