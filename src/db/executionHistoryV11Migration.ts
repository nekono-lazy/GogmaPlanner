import type { Transaction } from 'dexie'
import {
  orderExecutionHistoryKeys,
  startExecutionHistoryPlanConversion,
  type ExecutionHistoryOrderKeyCandidate,
} from '../domain/models/executionHistoryConversion'

/**
 * The Dexie version(11) upgrade of the ExecutionHistory records
 * (`docs/DATA_MODEL.md` 14.2 「Dexieでの手順」, `docs/PLANNER_SPEC.md` 19.8): every
 * record of the version 10 shape becomes the 12.2 metadata, put under its own
 * key, and its Undo body, added to `executionUndoSnapshots`.
 *
 * 1. The order values are gathered without reading any record value: key
 *    cursors over the primary key, the `planId` index and the `createdAt`
 *    index, joined by primary key. A record missing from an index (no valid
 *    key there) gets no value for it and cannot be ordered.
 * 2. `orderExecutionHistoryKeys()` groups the records by Plan and orders them by
 *    `compareExecutionHistoryOrder()` - never by the IndexedDB key order.
 * 3. Per Plan, the Plan's current body is read once and the records are read
 *    one at a time from the last to the first (`get`), each converted by the
 *    shared `startExecutionHistoryPlanConversion()` and written before the next
 *    is read, so no two record values are held at once and each is read once.
 *
 * A record the conversion returns as unconvertible - and every record that
 * could not be ordered - is left exactly as persisted, with no Undo body
 * (case 2). Anything else that goes wrong (a failed request, a quota error, an
 * unexpected exception) propagates, which aborts the whole versionchange
 * transaction so the database stays at version 10 (case 3). The conversion is
 * synchronous: nothing but IndexedDB requests is awaited, so the upgrade
 * transaction never commits on its own.
 */
export async function upgradeExecutionHistoryToV11(transaction: Transaction): Promise<void> {
  const history = transaction.table('executionHistory')
  const undoSnapshots = transaction.table('executionUndoSnapshots')
  const productionPlans = transaction.table('productionPlans')

  const candidates = new Map<unknown, ExecutionHistoryOrderKeyCandidate>()
  await history.toCollection().eachPrimaryKey((id) => {
    candidates.set(id, { id, planId: undefined, createdAt: undefined })
  })
  await history.orderBy('planId').eachKey((planId, cursor) => {
    const candidate = candidates.get(cursor.primaryKey)
    if (candidate !== undefined) candidate.planId = planId
  })
  await history.orderBy('createdAt').eachKey((createdAt, cursor) => {
    const candidate = candidates.get(cursor.primaryKey)
    if (candidate !== undefined) candidate.createdAt = createdAt
  })

  // An unordered record (`invalid_order_key`) stays exactly as it is.
  const { plans } = orderExecutionHistoryKeys(candidates.values())
  for (const { planId, records } of plans) {
    const currentPlan: unknown = await productionPlans.get(planId)
    const conversion = startExecutionHistoryPlanConversion(planId, currentPlan)
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const { id, createdAt } = records[index]
      const result = conversion.convertPrevious({ id, planId, createdAt }, await history.get(id))
      // An unconvertible record is kept exactly as persisted, without a body.
      if (result.kind === 'unconvertible') continue
      await history.put(result.executionHistory)
      await undoSnapshots.add(result.executionUndoSnapshot)
    }
  }
}
