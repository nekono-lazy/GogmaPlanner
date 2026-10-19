import type { AppDatabase } from '../../db/AppDatabase'
import type { ExecutionSavePointRestoreWrite } from '../../domain/execution'

/**
 * Writes one decided game save point restore (`docs/PLANNER_SPEC.md` 16.9),
 * inside the caller's read-write transaction: the restore of
 * `restoreExecutionSavePoint()` and of the replan adoption's restore choice.
 * The save point itself is kept. It decides nothing:
 * `prepareExecutionSavePointRestore()` already validated every body it writes.
 * (The Planner Alternative repair save, which wrote a restore instead of its
 * result, was removed in Issue #278 PR-5.)
 */
export async function writeExecutionSavePointRestore(
  database: AppDatabase,
  restore: ExecutionSavePointRestoreWrite,
): Promise<void> {
  await database.rngState.put(restore.rngState)
  // The save point holds the whole collection: a Counter record absent from
  // it must not survive the restore.
  await database.normalArtianCounters.clear()
  if (restore.normalCounters.length > 0) await database.normalArtianCounters.bulkPut(restore.normalCounters)
  if (restore.deletedOwnedWeaponIds.length > 0) await database.ownedWeapons.bulkDelete(restore.deletedOwnedWeaponIds)
  if (restore.restoredOwnedWeapons.length > 0) await database.ownedWeapons.bulkPut(restore.restoredOwnedWeapons)
  if (restore.restoredTargetWeapons.length > 0) await database.targetWeapons.bulkPut(restore.restoredTargetWeapons)
  await database.productionPlans.put(restore.plan)
  if (restore.deletedExecutionHistoryIds.length > 0) {
    await database.executionHistory.bulkDelete(restore.deletedExecutionHistoryIds)
  }
}
