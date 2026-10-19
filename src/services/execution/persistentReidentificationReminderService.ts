import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  deriveExecutionReidentificationReminder,
  type UnresolvedActualResultDivergence,
} from '../../domain/execution'
import type {
  ExecutionHistory,
  NormalArtianCounter,
  ProductionPlan,
  RngState,
  WeaponTypeId,
} from '../../domain/models/publicTypes'

/**
 * The persistent re-identification reminder of Dashboard / RNG Setup /
 * Candidate Search (`docs/PLANNER_SPEC.md` 16.15 「再同定を促す継続表示」): a
 * read-only display model over every persisted ProductionPlan. It is never
 * persisted, and it is not a resolution authority of its own - every "still
 * unresolved" here is exactly what `deriveExecutionReidentificationReminder()`
 * returned for one Plan, only grouped by prediction stream for display.
 */

export interface PersistentReidentificationNormalCounter {
  /** The Normal Counter the diverged creation consumed (`PlanStep.rngAdvance.affectedNormalCounterId`). */
  normalCounterId: string
  /**
   * The weapon type of the current NormalArtianCounter record of that ID, so the
   * UI can name it through the Master; `null` when no record exists now. Never
   * parsed from the ID.
   */
  weaponTypeId: WeaponTypeId | null
}

export type PersistentReidentificationReminder =
  | { kind: 'none' }
  | {
      kind: 'actual_result_different'
      /** An unresolved Gogma / Skill divergence exists: the RNG Identification adoption is still needed. */
      rngRequired: boolean
      /** The Normal Counters with an unresolved creation divergence, one entry per Counter ID, sorted by ID. */
      normalCounters: readonly PersistentReidentificationNormalCounter[]
      /**
       * A Normal creation divergence whose Counter cannot be identified safely
       * (a Step naming no Counter, a Step or a Plan the record no longer
       * resolves to). Nothing resolves it and no other Counter is guessed.
       */
      hasUnresolvableNormalCounter: boolean
    }

export interface PersistentReidentificationReminderInput {
  plans: readonly Pick<ProductionPlan, 'id' | 'steps'>[]
  executionHistory: readonly ExecutionHistory[]
  rngState: Pick<RngState, 'baseSeed' | 'gogmaCounter' | 'skillCounter' | 'lastIdentifiedAt'> | null
  normalCounters: readonly Pick<NormalArtianCounter, 'id' | 'weaponTypeId' | 'counter' | 'isConfirmed' | 'lastIdentifiedAt'>[]
}

/**
 * Groups the ExecutionHistory by Plan, judges every Plan - whatever its status,
 * `completed` and `abandoned` included, because ending a Plan resolves nothing
 * - through the one Domain authority, and merges the unresolved streams for
 * display: the RNG stream once, each Normal Counter once, and one flag for the
 * divergences nothing can resolve. Two Plans diverged on one stream are one
 * request; the merge never decides that anything is resolved.
 *
 * An `actual_result_different` record whose Plan no longer exists is judged
 * against a Plan without Steps, so the helper's own missing-Step fail-closed
 * applies: it stays an unresolvable request rather than being ignored.
 */
export function aggregatePersistentReidentificationReminder(
  input: PersistentReidentificationReminderInput,
): PersistentReidentificationReminder {
  const historyByPlan = new Map<string, ExecutionHistory[]>()
  for (const history of input.executionHistory) {
    const list = historyByPlan.get(history.planId)
    if (list) list.push(history)
    else historyByPlan.set(history.planId, [history])
  }
  const planById = new Map(input.plans.map((plan) => [plan.id as string, plan]))
  const planIds = new Set<string>(planById.keys())
  for (const history of input.executionHistory) {
    if (history.action === 'actual_result_different') planIds.add(history.planId)
  }

  const unresolved: UnresolvedActualResultDivergence[] = []
  for (const planId of planIds) {
    const plan = planById.get(planId) ?? { id: planId as ProductionPlan['id'], steps: [] }
    const reminder = deriveExecutionReidentificationReminder({
      plan,
      planExecutionHistory: historyByPlan.get(planId) ?? [],
      rngState: input.rngState,
      normalCounters: input.normalCounters,
    })
    if (reminder.kind === 'actual_result_different') unresolved.push(...reminder.unresolved)
  }
  if (unresolved.length === 0) return { kind: 'none' }

  const normalCounterIds = new Set<string>()
  let rngRequired = false
  let hasUnresolvableNormalCounter = false
  for (const divergence of unresolved) {
    if (divergence.destination === 'rng') rngRequired = true
    else if (divergence.normalCounterId === null) hasUnresolvableNormalCounter = true
    else normalCounterIds.add(divergence.normalCounterId)
  }
  const normalCounters = [...normalCounterIds].sort((left, right) => left.localeCompare(right)).map((normalCounterId) => ({
    normalCounterId,
    weaponTypeId: input.normalCounters.find(({ id }) => id === normalCounterId)?.weaponTypeId ?? null,
  }))
  return { kind: 'actual_result_different', rngRequired, normalCounters, hasUnresolvableNormalCounter }
}

/**
 * Reads the current persisted state the reminder is derived from - every
 * ProductionPlan, every ExecutionHistory record, the current RngState and every
 * NormalArtianCounter - and aggregates it. Read-only: nothing is written, and no
 * flag is stored anywhere. A failed read rejects; the caller must never show a
 * failure as "no re-identification needed".
 */
export async function loadPersistentReidentificationReminder(
  database: AppDatabase = appDatabase,
): Promise<PersistentReidentificationReminder> {
  const [plans, executionHistory, rngState, normalCounters] = await Promise.all([
    database.productionPlans.toArray(),
    database.executionHistory.toArray(),
    database.rngState.get('current'),
    database.normalArtianCounters.toArray(),
  ])
  return aggregatePersistentReidentificationReminder({
    plans,
    executionHistory,
    rngState: rngState ?? null,
    normalCounters,
  })
}
