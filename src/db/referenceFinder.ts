import type {
  BuildCandidate,
  BuildListEntry,
  ExecutionHistory,
  OwnedWeaponId,
  ProductionPlan,
  TargetWeapon,
  TargetWeaponId,
} from '../domain/models/publicTypes'
import { collectReferencedOwnedWeaponIds } from '../domain/models/hashing'
import { appDatabase, type AppDatabase } from './AppDatabase'

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
  kind: 'production_plan' | 'execution_history',
  entityId: string,
  prefix = '',
): PersistenceReference[] {
  const references: PersistenceReference[] = []
  plan.steps.forEach((step, index) => {
    const path = `${prefix}steps[${index}]`
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
  executionHistory: readonly ExecutionHistory[]
}

/**
 * Every persisted reference to an OwnedWeapon, found in the given collections.
 * Pure, so a transaction that decides a delete before any write - the Plan
 * breaking-change guard - applies exactly the policy `ReferenceFinder` does.
 */
export function findOwnedWeaponReferencesIn(
  collections: PersistenceReferenceCollections,
  ownedWeaponId: OwnedWeaponId,
): PersistenceReference[] {
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
    references.push(
      ...findOwnedWeaponReferencesInPlan(
        plan,
        ownedWeaponId,
        'production_plan',
        plan.id,
      ),
    ),
  )
  collections.executionHistory.forEach((entry) => {
    const snapshot = entry.undoSnapshot
    if (entry.actualResult?.securedOwnedWeaponId === ownedWeaponId) {
      references.push({
        kind: 'execution_history',
        entityId: entry.id,
        path: 'actualResult.securedOwnedWeaponId',
      })
    }
    if (snapshot.affectedOwnedWeaponsBefore.some(({ id }) => id === ownedWeaponId)) {
      references.push({
        kind: 'execution_history',
        entityId: entry.id,
        path: 'undoSnapshot.affectedOwnedWeaponsBefore',
      })
    }
    if (snapshot.addedOwnedWeaponIds.includes(ownedWeaponId)) {
      references.push({
        kind: 'execution_history',
        entityId: entry.id,
        path: 'undoSnapshot.addedOwnedWeaponIds',
      })
    }
    if (snapshot.removedOwnedWeaponsBefore.some(({ id }) => id === ownedWeaponId)) {
      references.push({
        kind: 'execution_history',
        entityId: entry.id,
        path: 'undoSnapshot.removedOwnedWeaponsBefore',
      })
    }
    references.push(
      ...findOwnedWeaponReferencesInPlan(
        snapshot.productionPlanBefore,
        ownedWeaponId,
        'execution_history',
        entry.id,
        'undoSnapshot.productionPlanBefore.',
      ),
    )
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

  async findOwnedWeaponReferences(
    ownedWeaponId: OwnedWeaponId,
  ): Promise<PersistenceReference[]> {
    const [targetWeapons, buildCandidates, buildListEntries, productionPlans, executionHistory] = await Promise.all([
      this.database.targetWeapons.toArray(),
      this.database.buildCandidates.toArray(),
      this.database.buildListEntries.toArray(),
      this.database.productionPlans.toArray(),
      this.database.executionHistory.toArray(),
    ])
    return findOwnedWeaponReferencesIn(
      { targetWeapons, buildCandidates, buildListEntries, productionPlans, executionHistory },
      ownedWeaponId,
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
