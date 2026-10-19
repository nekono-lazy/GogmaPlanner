import type { Table } from 'dexie'
import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import { RepositoryError } from '../../db/repositoryError'
import {
  ExecutionRuntimeError,
  inspectPlanGuardedMutation,
  preparePlanGuardedMutation,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanBreakingChangeTermination,
  type PlanBreakingMutableState,
  type PlanGuardPersistedState,
  type PlanGuardedMutation,
  type PlanGuardedMutationWrite,
} from '../../domain/execution'
import { loadMasterData } from '../../domain/master/loadMasterData'
import type { CalculationContext, ISODateTimeString } from '../../domain/models/publicTypes'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'

/** The outcome of one guarded save: the mutation's own result, and how it ended the Plan if it did. */
export interface PlanGuardedMutationOutcome<R> {
  result: R
  /**
   * The mutable collections exactly as persisted by this save, after any Plan
   * termination (an approved breaking change clears the Plan's in-progress
   * marks after the mutation ran), so a caller can return the final record.
   */
  state: PlanBreakingMutableState
  /** `null` unless an approved breaking change ended the `active` Plan. */
  planTermination: PlanBreakingChangeTermination | null
}

/**
 * Extra writes one guarded save performs inside the same transaction, after the
 * guard wrote the decided state and any Plan termination. The Planner result
 * save uses it for its Draft replacement (`docs/PLANNER_SPEC.md` 9.2.15), which
 * lives outside the mutable collections a guarded mutation decides. It judges
 * nothing: every Plan-breaking decision was already made on the mutation's
 * post-state. A failure it throws rolls the whole save back.
 */
export interface PlanGuardedApplyOptions<R> {
  afterWrite?: (outcome: PlanGuardedMutationOutcome<R>) => Promise<void>
}

/**
 * The persistence boundary every user save that can break an `active`
 * ProductionPlan goes through (`docs/PLANNER_SPEC.md` 16.6, `docs/UI_FLOW.md`
 * 16.3): RNG Setup, Identification adoption, Normal Counter, OwnedWeapon and
 * TargetWeapon CRUD, and the Build List selection / delete.
 *
 * A caller first `inspect`s the change to learn whether the warning (and the
 * 16.10 save point choice) must be shown, then `apply`s the same change with
 * the user's approval. Without an approval a breaking change is refused.
 */
export interface PlanGuardedPersistence {
  inspect<R>(mutation: PlanGuardedMutation<R>): Promise<PlanBreakingChangeInspection>
  apply<R>(
    mutation: PlanGuardedMutation<R>,
    approval?: PlanBreakingChangeApproval | null,
    options?: PlanGuardedApplyOptions<R>,
  ): Promise<PlanGuardedMutationOutcome<R>>
}

export interface PlanBreakingChangeGuardDependencies {
  database: AppDatabase
  /** The CalculationContext a save point restore requires the Plan to be executable under. */
  currentCalculationContext: CalculationContext
  clock: { now(): ISODateTimeString }
}

/** Marks a failure the pure preparation raised, so it reaches the caller unwrapped. */
class PreparationFailure extends Error {
  constructor(cause: unknown) {
    super('A guarded save was refused before any write.', { cause })
    this.name = 'PreparationFailure'
  }
}

function sameBody(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The Dexie implementation of `PlanGuardedPersistence`. Each call is one
 * transaction over every table a guarded save can read or write: it reads the
 * whole current state inside the transaction, lets the pure Domain decide and
 * validate the change, the breaking judgement, the approval, the save point
 * choice and restore, and the Plan termination, and only then writes. A
 * refusal - a validation or reference error of the change itself, or an
 * `ExecutionRuntimeError` - is rethrown as it is; a storage failure becomes
 * `RepositoryError`. Either way the transaction rolls back and nothing is
 * changed: the Plan never ends without the change, nor the change without the
 * Plan ending.
 */
export class PlanBreakingChangeGuard implements PlanGuardedPersistence {
  private readonly dependencies: PlanBreakingChangeGuardDependencies

  constructor(dependencies: PlanBreakingChangeGuardDependencies) {
    this.dependencies = dependencies
  }

  inspect<R>(mutation: PlanGuardedMutation<R>): Promise<PlanBreakingChangeInspection> {
    return this.run('r', async () => {
      const state = await this.readState()
      return this.prepare(() => inspectPlanGuardedMutation(state, mutation))
    })
  }

  apply<R>(
    mutation: PlanGuardedMutation<R>,
    approval: PlanBreakingChangeApproval | null = null,
    options: PlanGuardedApplyOptions<R> = {},
  ): Promise<PlanGuardedMutationOutcome<R>> {
    return this.run('rw', async () => {
      const state = await this.readState()
      const write = this.prepare(() => preparePlanGuardedMutation({
        state,
        mutation,
        approval,
        currentCalculationContext: this.dependencies.currentCalculationContext,
        now: this.dependencies.clock.now(),
      }))
      await this.write(state, write)
      const outcome = { result: write.result, state: write.state, planTermination: write.planTermination }
      await options.afterWrite?.(outcome)
      return outcome
    })
  }

  private prepare<T>(decide: () => T): T {
    try {
      return decide()
    } catch (error: unknown) {
      throw new PreparationFailure(error)
    }
  }

  private async readState(): Promise<PlanGuardPersistedState> {
    const { database } = this.dependencies
    return {
      rngState: (await database.rngState.get('current')) ?? null,
      normalCounters: await database.normalArtianCounters.toArray(),
      ownedWeapons: await database.ownedWeapons.toArray(),
      targetWeapons: await database.targetWeapons.toArray(),
      buildListEntries: await database.buildListEntries.toArray(),
      buildCandidates: await database.buildCandidates.toArray(),
      productionPlans: await database.productionPlans.toArray(),
      executionHistory: await database.executionHistory.toArray(),
      executionSavePoints: await database.executionSavePoints.toArray(),
    }
  }

  /**
   * Writes the difference between the persisted state and the decided final
   * state: removed records are deleted and changed or new ones put, so a record
   * the save did not touch is never rewritten. The ended Plan, the deleted
   * records after a restored save point and the deleted save point follow.
   */
  private async write<R>(persisted: PlanGuardPersistedState, write: PlanGuardedMutationWrite<R>): Promise<void> {
    const { database } = this.dependencies
    const next: PlanBreakingMutableState = write.state
    if (next.rngState !== null && !sameBody(persisted.rngState, next.rngState)) {
      await database.rngState.put(next.rngState)
    }
    await this.writeCollection(database.normalArtianCounters, persisted.normalCounters, next.normalCounters)
    await this.writeCollection(database.ownedWeapons, persisted.ownedWeapons, next.ownedWeapons)
    await this.writeCollection(database.targetWeapons, persisted.targetWeapons, next.targetWeapons)
    await this.writeCollection(database.buildListEntries, persisted.buildListEntries, next.buildListEntries)

    const termination = write.planTermination
    if (termination === null) return
    await database.productionPlans.put(termination.plan)
    if (termination.deletedExecutionHistoryIds.length > 0) {
      await database.executionHistory.bulkDelete(termination.deletedExecutionHistoryIds)
    }
    if (termination.deletesExecutionSavePoint) {
      await database.executionSavePoints.where('productionPlanId').equals(termination.plan.id).delete()
    }
  }

  private async writeCollection<T extends { id: string }>(
    table: Table<T, string>,
    persisted: readonly T[],
    next: readonly T[],
  ): Promise<void> {
    const nextIds = new Set(next.map(({ id }) => id))
    const persistedById = new Map(persisted.map((record) => [record.id, record]))
    const deleted = persisted.filter(({ id }) => !nextIds.has(id)).map(({ id }) => id)
    // A record the persisted state did not hold is added, never put: its ID was
    // free when this transaction read the state, so a record another writer
    // stored under it can never be silently overwritten.
    const added = next.filter(({ id }) => !persistedById.has(id))
    const changed = next.filter(
      (record) => persistedById.has(record.id) && !sameBody(persistedById.get(record.id), record),
    )
    if (deleted.length > 0) await table.bulkDelete(deleted)
    if (changed.length > 0) await table.bulkPut(changed)
    if (added.length > 0) await table.bulkAdd(added)
  }

  private async run<T>(mode: 'r' | 'rw', operation: () => Promise<T>): Promise<T> {
    const { database } = this.dependencies
    try {
      return await database.transaction(
        mode,
        [
          database.rngState,
          database.normalArtianCounters,
          database.ownedWeapons,
          database.targetWeapons,
          database.buildListEntries,
          database.buildCandidates,
          database.productionPlans,
          database.executionHistory,
          database.executionSavePoints,
        ],
        operation,
      )
    } catch (error: unknown) {
      if (error instanceof PreparationFailure) throw error.cause
      if (error instanceof ExecutionRuntimeError || error instanceof RepositoryError) throw error
      throw new RepositoryError(
        'transaction_failed',
        'The guarded save transaction failed and was rolled back.',
        { cause: error },
      )
    }
  }
}

export function createPlanBreakingChangeGuard(
  currentCalculationContext: CalculationContext,
  database: AppDatabase = appDatabase,
): PlanBreakingChangeGuard {
  return new PlanBreakingChangeGuard({
    database,
    currentCalculationContext,
    clock: { now: () => new Date().toISOString() },
  })
}

let defaultGuard: PlanBreakingChangeGuard | null = null

function productionGuard(): PlanBreakingChangeGuard {
  if (defaultGuard === null) {
    const master = loadMasterData()
    if (!master.ok) throw new Error('マスターデータが利用できないため保存できません。')
    defaultGuard = createPlanBreakingChangeGuard(createBuildListCalculationContext(master.data))
  }
  return defaultGuard
}

/**
 * The application's guard over the application database, created on first use
 * so importing a service never loads Master Data by itself.
 */
export const defaultPlanGuardedPersistence: PlanGuardedPersistence = {
  inspect: (mutation) => productionGuard().inspect(mutation),
  apply: (mutation, approval, options) => productionGuard().apply(mutation, approval, options),
}
