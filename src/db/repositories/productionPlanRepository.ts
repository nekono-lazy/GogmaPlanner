import type {
  ISODateTimeString,
  ProductionPlan,
  ProductionPlanId,
  ProductionPlanStatus,
} from '../../domain/models/publicTypes'
import { validateProductionPlan } from '../../domain/models/validation'
import { appDatabase, type AppDatabase } from '../AppDatabase'
import {
  assertRepositoryValidation,
  RepositoryError,
} from '../repositoryError'
import { runInRepositoryTransaction } from '../transaction'

/** At most one Plan may be running at a time (`docs/PLANNER_SPEC.md` 16.2). */
const RUNNING_PLAN_STATUSES: readonly ProductionPlanStatus[] = ['active', 'stale']

/**
 * At most one not-yet-started Draft exists at a time (`docs/DATA_MODEL.md`
 * 11.1): the current Draft, which the next Planner save replaces atomically.
 * This is independent of the running-Plan rule - a Draft beside an `active` /
 * `stale` Plan is legal.
 */
const DRAFT_PLAN_STATUS: ProductionPlanStatus = 'draft'

export function isRunningProductionPlanStatus(status: ProductionPlanStatus): boolean {
  return RUNNING_PLAN_STATUSES.includes(status)
}

function sortPlans(plans: ProductionPlan[]): ProductionPlan[] {
  return plans.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  )
}

export class ProductionPlanRepository {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  getProductionPlan(
    id: ProductionPlanId,
  ): Promise<ProductionPlan | undefined> {
    return this.database.productionPlans.get(id)
  }

  async getAllProductionPlans(): Promise<ProductionPlan[]> {
    return sortPlans(await this.database.productionPlans.toArray())
  }

  async getActiveProductionPlan(): Promise<ProductionPlan | undefined> {
    const activePlans = await this.database.productionPlans
      .where('status')
      .equals('active')
      .toArray()
    if (activePlans.length > 1) {
      throw new RepositoryError(
        'active_plan_conflict',
        'Persistence contains more than one active ProductionPlan.',
      )
    }
    return activePlans[0]
  }

  /**
   * The one running Plan (`active` or `stale`, `docs/PLANNER_SPEC.md` 16.2), or
   * `undefined`. More than one fails closed.
   */
  async getRunningProductionPlan(): Promise<ProductionPlan | undefined> {
    const running = await this.readRunningPlans()
    if (running.length > 1) {
      throw new RepositoryError(
        'active_plan_conflict',
        'Persistence contains more than one running (active or stale) ProductionPlan.',
      )
    }
    return running[0]
  }

  /**
   * The one not-yet-started Draft (`docs/DATA_MODEL.md` 11.1), or `undefined`.
   * More than one fails closed.
   */
  async getDraftProductionPlan(): Promise<ProductionPlan | undefined> {
    const drafts = await this.readDraftPlans()
    if (drafts.length > 1) {
      throw new RepositoryError(
        'draft_plan_conflict',
        'Persistence contains more than one draft ProductionPlan.',
      )
    }
    return drafts[0]
  }

  /** Reads every running Plan in the current transaction zone. */
  private readRunningPlans(): Promise<ProductionPlan[]> {
    return this.database.productionPlans
      .where('status')
      .anyOf(RUNNING_PLAN_STATUSES)
      .toArray()
  }

  /** Reads every Draft in the current transaction zone. */
  private readDraftPlans(): Promise<ProductionPlan[]> {
    return this.database.productionPlans
      .where('status')
      .equals(DRAFT_PLAN_STATUS)
      .toArray()
  }

  private async assertNoOtherRunningPlan(plan: ProductionPlan): Promise<void> {
    if (!isRunningProductionPlanStatus(plan.status)) return
    const running = await this.readRunningPlans()
    if (running.some(({ id }) => id !== plan.id)) {
      throw new RepositoryError(
        'active_plan_conflict',
        'Another ProductionPlan is already running (active or stale).',
      )
    }
  }

  /**
   * Writing a Draft while a *different* Draft exists is refused. Updating the
   * stored Draft under its own ID is not a second Draft. The Planner save does
   * not hit this guard: it deletes the previous Draft first, in the same
   * transaction (`deleteDraftProductionPlans()`).
   */
  private async assertNoOtherDraftPlan(plan: ProductionPlan): Promise<void> {
    if (plan.status !== DRAFT_PLAN_STATUS) return
    const drafts = await this.readDraftPlans()
    if (drafts.some(({ id }) => id !== plan.id)) {
      throw new RepositoryError(
        'draft_plan_conflict',
        'Another draft ProductionPlan already exists.',
      )
    }
  }

  /**
   * Refuses a Plan ID the collection already holds, in the current transaction
   * zone.
   *
   * A newly calculated Plan carries a fresh ID, so an ID already stored -
   * whatever that Plan's status, the current Draft included - names a
   * different Plan and is never silently replaced. The Planner save calls this
   * before its Draft replacement (`deleteDraftProductionPlans()`), so a Draft
   * that happens to hold the new Plan's ID is refused rather than deleted and
   * re-added under the same key.
   */
  async assertProductionPlanIdFree(id: ProductionPlanId): Promise<void> {
    if ((await this.database.productionPlans.get(id)) !== undefined) {
      throw new RepositoryError(
        'production_plan_id_conflict',
        `ProductionPlan '${id}' already exists and is never replaced by a new Plan.`,
      )
    }
  }

  /**
   * Inserts a Plan that must not already exist.
   *
   * A newly calculated Plan carries a fresh ID, so a colliding key means the
   * stored Plan is a different Plan; it is never silently replaced
   * (`assertProductionPlanIdFree()`, a typed refusal ahead of the Dexie key
   * constraint). The running Plan guard, the Draft guard and Domain validation
   * are the same authorities `put` uses.
   */
  addProductionPlan(plan: ProductionPlan): Promise<ProductionPlan> {
    assertRepositoryValidation('ProductionPlan', validateProductionPlan(plan))
    return runInRepositoryTransaction(
      this.database,
      [this.database.productionPlans],
      async () => {
        await this.assertProductionPlanIdFree(plan.id)
        await this.assertNoOtherRunningPlan(plan)
        await this.assertNoOtherDraftPlan(plan)
        await this.database.productionPlans.add(plan)
        return plan
      },
    )
  }

  putProductionPlan(plan: ProductionPlan): Promise<ProductionPlan> {
    assertRepositoryValidation('ProductionPlan', validateProductionPlan(plan))
    return runInRepositoryTransaction(
      this.database,
      [this.database.productionPlans],
      async () => {
        await this.assertNoOtherRunningPlan(plan)
        await this.assertNoOtherDraftPlan(plan)
        await this.database.productionPlans.put(plan)
        return plan
      },
    )
  }

  /**
   * Deletes every Draft in the current transaction zone and returns their IDs.
   *
   * This is the atomic replacement step of the Planner save
   * (`docs/PLANNER_SPEC.md` 9.2.15): the caller adds the new Draft in the same
   * transaction, so a failed save rolls the deletion back and the previous
   * Draft survives. Only Draft records are deleted; `active` / `stale` /
   * `completed` / `abandoned` Plans and the BuildListEntries a Draft referenced
   * are never touched, because a Draft owns no Entry.
   */
  async deleteDraftProductionPlans(): Promise<ProductionPlanId[]> {
    const ids = (await this.readDraftPlans()).map(({ id }) => id)
    await this.database.productionPlans.bulkDelete(ids)
    return ids
  }

  deleteProductionPlan(id: ProductionPlanId): Promise<void> {
    return this.database.productionPlans.delete(id)
  }

  /**
   * Deletes the one not-yet-started Draft the user chose in the Production
   * Plan list (`docs/UI_FLOW.md` 11.5, `docs/DATA_MODEL.md` 11.1).
   *
   * The exact persisted Plan is re-read inside the transaction, so a Plan that
   * was a Draft when the list was drawn and has since been started is never
   * deleted: a missing Plan is `not_found`, a stored status other than `draft`
   * is refused with `draft_plan_delete_not_allowed`, and a collection holding
   * two or more Drafts (the invariant 11.1 rules out) fails closed with
   * `draft_plan_conflict` before anything is read by ID. Only the ProductionPlan
   * record is deleted: a Draft owns no BuildListEntry, BuildCandidate,
   * TargetWeapon, OwnedWeapon, ExecutionHistory or ExecutionSavePoint, so
   * nothing cascades. A refusal writes nothing.
   */
  deleteDraftProductionPlan(id: ProductionPlanId): Promise<void> {
    return runInRepositoryTransaction(
      this.database,
      [this.database.productionPlans],
      async () => {
        const drafts = await this.readDraftPlans()
        if (drafts.length > 1) {
          throw new RepositoryError(
            'draft_plan_conflict',
            'Persistence contains more than one draft ProductionPlan.',
          )
        }
        const stored = await this.database.productionPlans.get(id)
        if (!stored) {
          throw new RepositoryError(
            'not_found',
            `ProductionPlan '${id}' was not found.`,
          )
        }
        if (stored.status !== DRAFT_PLAN_STATUS) {
          throw new RepositoryError(
            'draft_plan_delete_not_allowed',
            `ProductionPlan '${id}' is ${stored.status}, not a draft, and is never deleted by the Draft delete.`,
          )
        }
        await this.database.productionPlans.delete(id)
      },
    )
  }

  activateProductionPlan(
    planId: ProductionPlanId,
    previousActivePlanReplacement?: ProductionPlan,
    now: ISODateTimeString = new Date().toISOString(),
  ): Promise<ProductionPlan> {
    if (previousActivePlanReplacement) {
      assertRepositoryValidation(
        'ProductionPlan',
        validateProductionPlan(previousActivePlanReplacement),
      )
      if (isRunningProductionPlanStatus(previousActivePlanReplacement.status)) {
        throw new RepositoryError(
          'active_plan_conflict',
          'The previous running Plan replacement must be neither active nor stale.',
        )
      }
    }

    return runInRepositoryTransaction(
      this.database,
      [this.database.productionPlans],
      async () => {
        const next = await this.database.productionPlans.get(planId)
        if (!next) {
          throw new RepositoryError(
            'not_found',
            `ProductionPlan '${planId}' was not found.`,
          )
        }
        const runningPlans = await this.readRunningPlans()
        if (runningPlans.length > 1) {
          throw new RepositoryError(
            'active_plan_conflict',
            'Persistence contains more than one running (active or stale) ProductionPlan.',
          )
        }
        const current = runningPlans[0]
        if (current && current.id !== planId) {
          if (
            !previousActivePlanReplacement ||
            previousActivePlanReplacement.id !== current.id
          ) {
            throw new RepositoryError(
              'active_plan_conflict',
              'Switching active Plans requires the previous Plan replacement.',
            )
          }
          await this.assertNoOtherDraftPlan(previousActivePlanReplacement)
          await this.database.productionPlans.put(previousActivePlanReplacement)
        }
        const activated: ProductionPlan = {
          ...next,
          status: 'active',
          updatedAt: now,
        }
        assertRepositoryValidation(
          'ProductionPlan',
          validateProductionPlan(activated),
        )
        await this.database.productionPlans.put(activated)
        return activated
      },
    )
  }
}

export const productionPlanRepository = new ProductionPlanRepository(appDatabase)
