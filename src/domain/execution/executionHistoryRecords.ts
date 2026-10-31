import type { ExecutionHistory, ExecutionUndoSnapshot, ProductionPlan, ProductionPlanId } from '../models/publicTypes'
import { validateExecutionHistory, validateExecutionRecordCollection } from '../models/publicTypes'
import { executionFailure } from './executionRuntimeError'

/**
 * The ExecutionHistory records a process judges with (`docs/DATA_MODEL.md`
 * 14.2 / 14.6):
 * - `all`: every record (the persistent re-identification reminder, the
 *   OwnedWeapon delete reference check, Export)
 * - `plan`: the records of one Plan - a Plan operation, or a process that reads
 *   every Plan's records but judges one Plan (the Plan-breaking guard, the
 *   running Plan replan readers). `planId` is `null` when no Plan is judged
 *
 * A record whose Plan cannot be told (its `planId` is not a string) belongs to
 * the scope of every process that reads every Plan's records.
 */
export type ExecutionHistoryJudgementScope =
  | { kind: 'all' }
  | { kind: 'plan'; planId: ProductionPlanId | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inScope(row: unknown, scope: ExecutionHistoryJudgementScope): boolean {
  if (scope.kind === 'all') return true
  const planId = isRecord(row) ? row.planId : undefined
  return typeof planId !== 'string' || planId === scope.planId
}

/**
 * The `docs/DATA_MODEL.md` 12.2 metadata among stored `executionHistory` rows,
 * as read. A row that is not 12.2 metadata - one the Dexie version 11 upgrade
 * could not convert and kept in its version 10 shape, told apart by its shape
 * alone (`validateExecutionHistory()`) - is never returned as metadata: inside
 * `scope` it refuses the whole read with `execution_history_unconvertible`
 * (nothing is decided from records that leave it out), and outside it it is
 * left out. Each row is checked on its own, so the cost never depends on the
 * size of a Plan.
 */
export function requireExecutionHistoryMetadata(
  rows: readonly unknown[],
  scope: ExecutionHistoryJudgementScope,
): ExecutionHistory[] {
  const histories: ExecutionHistory[] = []
  const unconvertible: unknown[] = []
  for (const row of rows) {
    if (validateExecutionHistory(row as ExecutionHistory).isValid) histories.push(row as ExecutionHistory)
    else if (inScope(row, scope)) unconvertible.push(row)
  }
  if (unconvertible.length > 0) {
    const ids = unconvertible.map((row) => String(isRecord(row) ? row.id : row))
    executionFailure(
      'execution_history_unconvertible',
      `ExecutionHistory ${ids.map((id) => `'${id}'`).join(', ')} could not be converted to the current shape, so nothing that depends on it is decided.`,
    )
  }
  return histories
}

/**
 * Requires every given metadata record and every given Undo body to form
 * complete `docs/DATA_MODEL.md` 12.2 records - each pair valid, 1:1, of an
 * existing Plan - before a process decides anything from all of them (the
 * OwnedWeapon delete reference check, 14.6). A record whose body is missing or
 * broken could hold a reference nobody can see, so the whole decision refuses
 * with `execution_history_record_invalid` instead of reading what is left; no
 * body is filled in, deleted or read as empty.
 */
export function requireCompleteExecutionRecords(
  executionHistory: readonly ExecutionHistory[],
  executionUndoSnapshots: readonly ExecutionUndoSnapshot[],
  productionPlans: readonly Pick<ProductionPlan, 'id' | 'steps'>[],
): void {
  const validation = validateExecutionRecordCollection(executionHistory, executionUndoSnapshots, productionPlans)
  if (!validation.isValid) {
    executionFailure(
      'execution_history_record_invalid',
      'The ExecutionHistory metadata and Undo bodies do not form complete records, so their references cannot be checked.',
      validation.issues,
    )
  }
}

/** The one running (`active` / `stale`) Plan's ID, or `null` with none or several (none is picked). */
export function runningProductionPlanIdOf(
  plans: readonly { id: ProductionPlanId; status: string }[],
): ProductionPlanId | null {
  const running = plans.filter(({ status }) => status === 'active' || status === 'stale')
  return running.length === 1 ? running[0].id : null
}

/** The one `active` Plan's ID, or `null` with none or several (none is picked). */
export function activeProductionPlanIdOf(
  plans: readonly { id: ProductionPlanId; status: string }[],
): ProductionPlanId | null {
  const active = plans.filter(({ status }) => status === 'active')
  return active.length === 1 ? active[0].id : null
}
