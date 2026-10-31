import type {
  BuildCandidate,
  BuildListEntry,
  ExecutionHistory,
  ExecutionUndoSnapshot,
  OwnedWeaponId,
  ProductionPlan,
  TargetWeapon,
  TargetWeaponId,
} from '../domain/models/publicTypes'
import { requireCompleteExecutionRecords } from '../domain/execution/executionHistoryRecords'
import { collectReferencedOwnedWeaponIds } from '../domain/models/hashing'
import { appDatabase, type AppDatabase } from './AppDatabase'
import { ExecutionHistoryRepository } from './repositories/executionHistoryRepository'

export type PersistenceReferenceKind =
  | 'owned_weapon'
  | 'target_weapon'
  | 'build_candidate'
  | 'build_list_entry'
  | 'production_plan'
  | 'execution_history'

export interface PersistenceReference {
  kind: PersistenceReferenceKind
  entityId: string
  path: string
}

function sortReferences(
  references: PersistenceReference[],
): PersistenceReference[] {
  return references.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.entityId.localeCompare(right.entityId) ||
      left.path.localeCompare(right.path),
  )
}

function findOwnedWeaponReferencesInPlan(
  plan: ProductionPlan,
  ownedWeaponId: OwnedWeaponId,
): PersistenceReference[] {
  const references: PersistenceReference[] = []
  const kind = 'production_plan'
  const entityId = plan.id
  plan.steps.forEach((step, index) => {
    const path = `steps[${index}]`
    if (step.ownedWeaponId === ownedWeaponId) {
      references.push({ kind, entityId, path: `${path}.ownedWeaponId` })
    }
    const change = step.inventoryChange
    if (change?.addOwnedWeapon?.id === ownedWeaponId) {
      references.push({ kind, entityId, path: `${path}.inventoryChange.addOwnedWeapon` })
    }
    if (change?.removeOwnedWeaponIds.includes(ownedWeaponId)) {
      references.push({ kind, entityId, path: `${path}.inventoryChange.removeOwnedWeaponIds` })
    }
    if (change?.updateOwnedWeapons.some(({ id }) => id === ownedWeaponId)) {
      references.push({ kind, entityId, path: `${path}.inventoryChange.updateOwnedWeapons` })
    }
  })
  return references
}

/** The persisted collections a reference search reads. */
export interface PersistenceReferenceCollections {
  targetWeapons: readonly TargetWeapon[]
  buildCandidates: readonly BuildCandidate[]
  buildListEntries: readonly BuildListEntry[]
  productionPlans: readonly ProductionPlan[]
  /** The metadata of every ExecutionHistory record. */
  executionHistory: readonly ExecutionHistory[]
  /** Every ExecutionHistory Undo body (`docs/DATA_MODEL.md` 14.6). */
  executionUndoSnapshots: readonly ExecutionUndoSnapshot[]
}

/**
 * Every persisted reference to an OwnedWeapon, found in the given collections.
 * Pure, so a transaction that decides a delete before any write - the Plan
 * breaking-change guard - applies exactly the policy `ReferenceFinder` does.
 *
 * The ExecutionHistory references sit in the metadata and the Undo bodies, so
 * every metadata record and every Undo body must first form complete records
 * (`requireCompleteExecutionRecords()`, `docs/DATA_MODEL.md` 14.6): a missing or
 * broken body could hold a reference, so the check refuses with
 * `execution_history_record_invalid` rather than report what is left.
 */
export function findOwnedWeaponReferencesIn(
  collections: PersistenceReferenceCollections,
  ownedWeaponId: OwnedWeaponId,
): PersistenceReference[] {
  requireCompleteExecutionRecords(collections.executionHistory, collections.executionUndoSnapshots, collections.productionPlans)
  const references: PersistenceReference[] = []
  // A Target that prefers this weapon as its Route origin is an ordinary
  // reference, so the existing referenced-entity delete protection applies
  // (`docs/DATA_MODEL.md` 8.5).
  collections.targetWeapons.forEach((target) => {
    if (target.preferredOwnedWeaponId === ownedWeaponId) {
      references.push({
        kind: 'target_weapon',
        entityId: target.id,
        path: 'preferredOwnedWeaponId',
      })
    }
    // The weapon a completed Target was completed with is its completion
    // assignment (Issue #334, `docs/DATA_MODEL.md` 8.7): the same delete
    // protection, told apart from a preference by its path. Reopening or
    // deleting that Target releases it.
    if (target.completedWithOwnedWeaponId === ownedWeaponId) {
      references.push({
        kind: 'target_weapon',
        entityId: target.id,
        path: 'completedWithOwnedWeaponId',
      })
    }
  })
  collections.buildCandidates.forEach((candidate) => {
    if (collectReferencedOwnedWeaponIds(candidate.route).includes(ownedWeaponId)) {
      references.push({
        kind: 'build_candidate',
        entityId: candidate.id,
        path: 'route',
      })
    }
  })
  collections.buildListEntries.forEach((entry) => {
    if (
      collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route).includes(
        ownedWeaponId,
      )
    ) {
      references.push({
        kind: 'build_list_entry',
        entityId: entry.id,
        path: 'candidateSnapshot.route',
      })
    }
  })
  collections.productionPlans.forEach((plan) =>
    references.push(...findOwnedWeaponReferencesInPlan(plan, ownedWeaponId)),
  )
  // The Plan body the former Undo snapshots copied is the content of the same
  // persisted Plan (`docs/DATA_MODEL.md` 12.2 / 14.6), so its references are
  // the `productionPlans` references above; the metadata and the Undo bodies
  // add only what they hold of their own.
  collections.executionHistory.forEach((entry) => {
    if (entry.actualResult?.securedOwnedWeaponId === ownedWeaponId) {
      references.push({
        kind: 'execution_history',
        entityId: entry.id,
        path: 'actualResult.securedOwnedWeaponId',
      })
    }
    if (entry.addedOwnedWeaponIds.includes(ownedWeaponId)) {
      references.push({
        kind: 'execution_history',
        entityId: entry.id,
        path: 'addedOwnedWeaponIds',
      })
    }
  })
  collections.executionUndoSnapshots.forEach((snapshot) => {
    if (snapshot.affectedOwnedWeaponsBefore.some(({ id }) => id === ownedWeaponId)) {
      references.push({
        kind: 'execution_history',
        entityId: snapshot.executionHistoryId,
        path: 'executionUndoSnapshot.affectedOwnedWeaponsBefore',
      })
    }
    if (snapshot.removedOwnedWeaponsBefore.some(({ id }) => id === ownedWeaponId)) {
      references.push({
        kind: 'execution_history',
        entityId: snapshot.executionHistoryId,
        path: 'executionUndoSnapshot.removedOwnedWeaponsBefore',
      })
    }
  })
  return sortReferences(references)
}

/**
 * Every persisted reference to a TargetWeapon, found in the given collections.
 * OwnedWeapon no longer references TargetWeapon: the relation is held on the
 * Target side, so deleting a Target never conflicts with inventory.
 */
export function findTargetWeaponReferencesIn(
  collections: Pick<PersistenceReferenceCollections, 'buildCandidates' | 'buildListEntries' | 'productionPlans'>,
  targetWeaponId: TargetWeaponId,
): PersistenceReference[] {
  const references: PersistenceReference[] = []
  collections.buildCandidates.forEach((candidate) => {
    if (candidate.targetWeaponId === targetWeaponId) {
      references.push({
        kind: 'build_candidate',
        entityId: candidate.id,
        path: 'targetWeaponId',
      })
    }
  })
  collections.buildListEntries.forEach((entry) => {
    if (entry.targetWeaponId === targetWeaponId) {
      references.push({
        kind: 'build_list_entry',
        entityId: entry.id,
        path: 'targetWeaponId',
      })
    }
  })
  collections.productionPlans.forEach((plan) => {
    plan.steps.forEach((step, index) => {
      if (step.targetWeaponId === targetWeaponId) {
        references.push({
          kind: 'production_plan',
          entityId: plan.id,
          path: `steps[${index}].targetWeaponId`,
        })
      }
      // Shared physical Steps attribute several Targets. Each field is its own
      // reference path, so a non-primary Target still blocks deletion.
      if (step.progressedTargetWeaponIds?.includes(targetWeaponId)) {
        references.push({
          kind: 'production_plan',
          entityId: plan.id,
          path: `steps[${index}].progressedTargetWeaponIds`,
        })
      }
    })
  })
  return sortReferences(references)
}

export class ReferenceFinder {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  /**
   * Every persisted reference to an OwnedWeapon. It reads every ExecutionHistory
   * record and every Undo body (`docs/DATA_MODEL.md` 14.6) in one read-only
   * transaction, so a record the Dexie version 11 upgrade could not convert
   * (`execution_history_unconvertible`) and records whose bodies do not pair
   * up (`execution_history_record_invalid`) refuse the check instead of being
   * left out.
   */
  async findOwnedWeaponReferences(
    ownedWeaponId: OwnedWeaponId,
  ): Promise<PersistenceReference[]> {
    const database = this.database
    return database.transaction(
      'r',
      [database.targetWeapons, database.buildCandidates, database.buildListEntries, database.productionPlans, database.executionHistory, database.executionUndoSnapshots],
      async () => {
        const history = new ExecutionHistoryRepository(database)
        const collections: PersistenceReferenceCollections = {
          targetWeapons: await database.targetWeapons.toArray(),
          buildCandidates: await database.buildCandidates.toArray(),
          buildListEntries: await database.buildListEntries.toArray(),
          productionPlans: await database.productionPlans.toArray(),
          executionHistory: await history.getAllExecutionHistory({ kind: 'all' }),
          executionUndoSnapshots: await history.getAllExecutionUndoSnapshots(),
        }
        return findOwnedWeaponReferencesIn(collections, ownedWeaponId)
      },
    )
  }

  async findTargetWeaponReferences(
    targetWeaponId: TargetWeaponId,
  ): Promise<PersistenceReference[]> {
    const [buildCandidates, buildListEntries, productionPlans] = await Promise.all([
      this.database.buildCandidates.toArray(),
      this.database.buildListEntries.toArray(),
      this.database.productionPlans.toArray(),
    ])
    return findTargetWeaponReferencesIn(
      { buildCandidates, buildListEntries, productionPlans },
      targetWeaponId,
    )
  }
}

export const referenceFinder = new ReferenceFinder(appDatabase)
