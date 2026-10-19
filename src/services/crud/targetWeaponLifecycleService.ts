import type { MasterDataRoot } from '../../domain/master/masterTypes'
import {
  unchangedMutableState,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanGuardedMutation,
} from '../../domain/execution'
import {
  validateOwnedWeapon,
  validateTargetWeapon,
  type OwnedGogmaArtianWeapon,
  type OwnedWeaponId,
  type TargetWeapon,
  type TargetWeaponId,
} from '../../domain/models/publicTypes'
import { isOwnedIdealForTarget, validateTargetPreferredOwnedWeapons } from '../../domain/target'
import {
  defaultPlanGuardedPersistence,
  type PlanGuardedPersistence,
} from '../execution/planBreakingChangeGuard'
import { EntityFormValidationError } from './entityCrudServices'

/**
 * Why a Target lifecycle action refused to change anything. Every code means
 * nothing was written: the request named a Target or a weapon that, in the
 * state the save ran on, no longer is what the screen showed
 * (`docs/UI_FLOW.md` 8.2 / 8.3). Typed codes are the only authority; no
 * message text is parsed.
 */
export type TargetWeaponLifecycleErrorCode =
  | 'target_not_found'
  | 'target_not_active'
  | 'target_not_completed'
  | 'owned_weapon_not_found'
  | 'owned_weapon_not_gogma'
  | 'owned_weapon_incompatible'
  | 'owned_weapon_no_longer_ideal'

const lifecycleErrorMessages: Record<TargetWeaponLifecycleErrorCode, string> = {
  target_not_found: 'この目標武器はすでに存在しません。一覧を更新してください。',
  target_not_active: 'この目標武器はすでに完了済みです。一覧を更新してください。',
  target_not_completed: 'この目標武器はすでに未完了です。一覧を更新してください。',
  owned_weapon_not_found: 'この所持武器はすでに存在しません。一覧を更新してください。',
  owned_weapon_not_gogma: 'この所持武器は巨戟アーティアではないため、目標の完了に使えません。一覧を更新してください。',
  owned_weapon_incompatible: 'この所持武器の武器種または属性が目標武器と一致しなくなったため、目標を完了にできません。一覧を更新してください。',
  owned_weapon_no_longer_ideal: 'この所持武器の現在の性能は目標武器の理想条件を満たしていないため、目標を完了にできません。一覧を更新してください。',
}

export class TargetWeaponLifecycleError extends Error {
  readonly code: TargetWeaponLifecycleErrorCode

  constructor(code: TargetWeaponLifecycleErrorCode) {
    super(lifecycleErrorMessages[code])
    this.name = 'TargetWeaponLifecycleError'
    this.code = code
  }
}

function lifecycleFailure(code: TargetWeaponLifecycleErrorCode): never {
  throw new TargetWeaponLifecycleError(code)
}

function domainMessages(result: { issues: Array<{ path: string; message: string }> }): string[] {
  return result.issues.map((issue) => `${issue.path || 'entity'}: ${issue.message}`)
}

/** What 「この武器で目標を完了にする」 persisted. */
export interface TargetOwnedIdealCompletion {
  /** The Target, now `completed`. */
  target: TargetWeapon
  /** The weapon, now a protected Ideal, exactly as persisted. */
  ownedWeapon: OwnedGogmaArtianWeapon
  /** The other Targets whose preference for the weapon was released. */
  releasedTargetIds: TargetWeaponId[]
}

/**
 * 「この武器で目標を完了にする」 as a guarded mutation (`docs/UI_FLOW.md` 8.2,
 * `docs/PLANNER_SPEC.md` 16.13, `docs/DATA_MODEL.md` 8.1 / 8.5).
 *
 * The request names IDs only. Both records are re-read from the state the
 * mutation runs on and re-validated there - the Target exists and is
 * `active`, the weapon exists, is a Gogma of the Target's weapon type and
 * element, and its *current* performance satisfies the Target's *current*
 * Ideal condition through the one shared `isOwnedIdealForTarget()` - so a
 * Target or weapon changed after the screen read it is refused rather than
 * completed on a stale judgement. The weapon keeps its ID, five slots, scope
 * and Skills and becomes `ideal` / protected; the Target becomes `completed`
 * with no Plan ID and no preference; every other Target preferring the weapon
 * loses that preference and nothing else, because a protected weapon can be
 * preferred by nobody. No Counter, RngState, Candidate, Entry, ExecutionHistory
 * or save point is touched, and no RNG prediction runs.
 */
export function completeTargetWithOwnedIdealMutation(
  master: MasterDataRoot,
  targetId: TargetWeaponId,
  ownedWeaponId: OwnedWeaponId,
  now: string,
): PlanGuardedMutation<TargetOwnedIdealCompletion> {
  return (base) => {
    const target = base.targetWeapons.find(({ id }) => id === targetId) ?? lifecycleFailure('target_not_found')
    if (target.lifecycleStatus !== 'active') lifecycleFailure('target_not_active')
    const weapon = base.ownedWeapons.find(({ id }) => id === ownedWeaponId) ?? lifecycleFailure('owned_weapon_not_found')
    if (weapon.kind !== 'gogma') lifecycleFailure('owned_weapon_not_gogma')
    if (weapon.weaponTypeId !== target.weaponTypeId || weapon.elementId !== target.elementId) {
      lifecycleFailure('owned_weapon_incompatible')
    }
    if (!isOwnedIdealForTarget(target, weapon, master)) lifecycleFailure('owned_weapon_no_longer_ideal')

    const completedWeapon: OwnedGogmaArtianWeapon = { ...weapon, status: 'ideal', isProtected: true, updatedAt: now }
    const completedTarget: TargetWeapon = {
      ...target,
      lifecycleStatus: 'completed',
      completedAt: now,
      completedByProductionPlanId: null,
      preferredOwnedWeaponId: null,
      updatedAt: now,
    }
    const releasedTargetIds: TargetWeaponId[] = []
    const targetWeapons = base.targetWeapons.map((stored) => {
      if (stored.id === target.id) return completedTarget
      if (stored.preferredOwnedWeaponId !== weapon.id) return stored
      releasedTargetIds.push(stored.id)
      return { ...stored, preferredOwnedWeaponId: null, updatedAt: now }
    })
    const ownedWeapons = base.ownedWeapons.map((stored) => (stored.id === weapon.id ? completedWeapon : stored))

    const issues = [
      ...domainMessages(validateTargetWeapon(completedTarget)),
      ...domainMessages(validateOwnedWeapon(completedWeapon)),
      ...domainMessages(validateTargetPreferredOwnedWeapons(targetWeapons, ownedWeapons)),
    ]
    if (issues.length) throw new EntityFormValidationError(issues)
    return {
      result: { target: completedTarget, ownedWeapon: completedWeapon, releasedTargetIds },
      state: { ...unchangedMutableState(base), ownedWeapons, targetWeapons },
    }
  }
}

/**
 * 「未完了に戻す」 as a guarded mutation (`docs/UI_FLOW.md` 8.3, `docs/DATA_MODEL.md`
 * 8.1): the Target, re-read from the state the mutation runs on and required to
 * be `completed`, returns to `active` with no completion metadata and no
 * preference. No owned weapon is touched - the weapon that completed it is
 * never guessed, un-protected or relabelled.
 */
export function reopenTargetWeaponMutation(
  targetId: TargetWeaponId,
  now: string,
): PlanGuardedMutation<TargetWeapon> {
  return (base) => {
    const target = base.targetWeapons.find(({ id }) => id === targetId) ?? lifecycleFailure('target_not_found')
    if (target.lifecycleStatus !== 'completed') lifecycleFailure('target_not_completed')
    const reopened: TargetWeapon = {
      ...target,
      lifecycleStatus: 'active',
      completedAt: null,
      completedByProductionPlanId: null,
      preferredOwnedWeaponId: null,
      updatedAt: now,
    }
    const targetWeapons = base.targetWeapons.map((stored) => (stored.id === target.id ? reopened : stored))
    const issues = [
      ...domainMessages(validateTargetWeapon(reopened)),
      ...domainMessages(validateTargetPreferredOwnedWeapons(targetWeapons, base.ownedWeapons)),
    ]
    if (issues.length) throw new EntityFormValidationError(issues)
    return { result: reopened, state: { ...unchangedMutableState(base), targetWeapons } }
  }
}

export interface TargetWeaponLifecycleDependencies {
  /**
   * The guarded persistence boundary: the completion (or reopening), its
   * preference releases and, with the user's approval, the end of a running
   * Plan it breaks are one transaction (`docs/PLANNER_SPEC.md` 16.6).
   */
  persistence: PlanGuardedPersistence
}

/**
 * The explicit Target lifecycle actions of `docs/UI_FLOW.md` 8.2 / 8.3. They
 * are kept apart from `TargetWeaponCrudService.save()`, which never changes a
 * lifecycle: only Execution and these two actions do.
 */
export class TargetWeaponLifecycleService {
  private readonly master: MasterDataRoot
  private readonly dependencies: TargetWeaponLifecycleDependencies

  constructor(
    master: MasterDataRoot,
    dependencies: TargetWeaponLifecycleDependencies = { persistence: defaultPlanGuardedPersistence },
  ) {
    this.master = master
    this.dependencies = dependencies
  }

  /** Whether completing the Target with this weapon needs the breaking-change approval. Writes nothing. */
  inspectCompleteWithOwnedIdeal(
    targetId: TargetWeaponId,
    ownedWeaponId: OwnedWeaponId,
    now = new Date().toISOString(),
  ): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.persistence.inspect(
      completeTargetWithOwnedIdealMutation(this.master, targetId, ownedWeaponId, now),
    )
  }

  /**
   * Completes the Target with the owned Ideal weapon. A completion that breaks
   * the `active` Plan is refused unless `approval` names that Plan and the save
   * point decision; with it the Plan is abandoned (`breaking_change_approved`)
   * in the same transaction. The returned weapon and Target are the records as
   * finally persisted, the Plan termination's in-progress clearing included.
   */
  async completeWithOwnedIdeal(
    targetId: TargetWeaponId,
    ownedWeaponId: OwnedWeaponId,
    now = new Date().toISOString(),
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<TargetOwnedIdealCompletion> {
    const outcome = await this.dependencies.persistence.apply(
      completeTargetWithOwnedIdealMutation(this.master, targetId, ownedWeaponId, now),
      approval,
    )
    const { result, state } = outcome
    const persistedWeapon = state.ownedWeapons.find(({ id }) => id === result.ownedWeapon.id)
    const persistedTarget = state.targetWeapons.find(({ id }) => id === result.target.id)
    return {
      ...result,
      ownedWeapon: persistedWeapon?.kind === 'gogma' ? persistedWeapon : result.ownedWeapon,
      target: persistedTarget ?? result.target,
    }
  }

  /** Whether returning the Target to `active` needs the breaking-change approval. Writes nothing. */
  inspectReopen(targetId: TargetWeaponId, now = new Date().toISOString()): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.persistence.inspect(reopenTargetWeaponMutation(targetId, now))
  }

  /** Returns a completed Target to `active`; the owned weapons stay exactly as they are. */
  async reopen(
    targetId: TargetWeaponId,
    now = new Date().toISOString(),
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<TargetWeapon> {
    return (await this.dependencies.persistence.apply(reopenTargetWeaponMutation(targetId, now), approval)).result
  }
}
