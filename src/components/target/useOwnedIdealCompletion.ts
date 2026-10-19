import { useCallback, useMemo, useState } from 'react'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../../domain/execution'
import type { OwnedGogmaArtianWeapon, OwnedWeaponId, TargetWeapon, TargetWeaponId } from '../../domain/models/publicTypes'
import type { TargetOwnedIdealCompletion } from '../../services/crud/targetWeaponLifecycleService'
import type { PlanBreakingChangeApprovalController } from '../execution/usePlanBreakingChangeApproval'
import {
  COMPLETE_WITH_OWNED_IDEAL_PLAN_BREAKING_NOTE,
  targetLifecycleErrorMessage,
  targetsReleasedByCompletion,
} from './ownedIdealPresentation'

/** The two calls 「この武器で目標を完了にする」 makes, as a screen injects them. */
export interface OwnedIdealCompletionApi {
  /** The read-only breaking-change inspection of that very completion. */
  inspectCompleteWithOwnedIdeal(targetId: TargetWeaponId, ownedWeaponId: OwnedWeaponId): Promise<PlanBreakingChangeInspection>
  /** `approval` is the breaking-change approval when the inspection required one (`docs/UI_FLOW.md` 16.3). */
  completeWithOwnedIdeal(
    targetId: TargetWeaponId,
    ownedWeaponId: OwnedWeaponId,
    approval?: PlanBreakingChangeApproval | null,
  ): Promise<TargetOwnedIdealCompletion>
}

export interface OwnedIdealCompletionPending {
  target: TargetWeapon
  weapon: OwnedGogmaArtianWeapon
}

export interface OwnedIdealCompletionController {
  /** The completion waiting for the user's confirmation, or in flight. */
  pending: OwnedIdealCompletionPending | null
  /** The other Targets preferring the pending weapon, named in the confirmation. */
  affectedTargets: TargetWeapon[]
  submitting: boolean
  /** A refusal or failure of the pending completion, shown inside the confirmation. */
  error: string | null
  /** 「この武器で目標を完了にする」 on a listed weapon: opens the confirmation. */
  begin(target: TargetWeapon, weapon: OwnedGogmaArtianWeapon): void
  /** 「キャンセル」: nothing is saved. */
  cancel(): void
  /** The confirmed completion: one guarded save, warned first when it breaks the active Plan. */
  confirm(): Promise<void>
}

export interface UseOwnedIdealCompletionOptions {
  api: OwnedIdealCompletionApi | null
  planGuard: PlanBreakingChangeApprovalController
  /** The Targets the screen shows, for naming the affected ones. Display only. */
  targets: readonly TargetWeapon[]
  onApplied(result: TargetOwnedIdealCompletion, planAbandoned: boolean): void
}

/**
 * The direct completion flow shared by the Target Weapons and Search screens
 * (`docs/UI_FLOW.md` 8.2): the explicit confirmation, then exactly one guarded
 * save through the shared breaking-change controller, which warns first when
 * the runtime says the completion breaks the `active` Plan (16.3). The screen
 * judges nothing itself: the affected Targets it names are display only, and
 * every refusal comes from the Service by typed code.
 */
export function useOwnedIdealCompletion({ api, planGuard, targets, onApplied }: UseOwnedIdealCompletionOptions): OwnedIdealCompletionController {
  const [pending, setPending] = useState<OwnedIdealCompletionPending | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const affectedTargets = useMemo(
    () => (pending === null ? [] : targetsReleasedByCompletion(targets, pending.target, pending.weapon)),
    [pending, targets],
  )

  const begin = useCallback((target: TargetWeapon, weapon: OwnedGogmaArtianWeapon) => {
    setPending({ target, weapon })
    setError(null)
  }, [])

  const cancel = useCallback(() => {
    if (submitting) return
    setPending(null)
    setError(null)
  }, [submitting])

  const confirm = useCallback(async () => {
    if (api === null || pending === null || submitting) return
    const { target, weapon } = pending
    setSubmitting(true)
    setError(null)
    try {
      // The inspection and the save name the same Target and weapon; the
      // runtime re-reads both inside its own transaction.
      const outcome = await planGuard.run({
        inspect: () => api.inspectCompleteWithOwnedIdeal(target.id, weapon.id),
        apply: (approval) => api.completeWithOwnedIdeal(target.id, weapon.id, approval),
        note: COMPLETE_WITH_OWNED_IDEAL_PLAN_BREAKING_NOTE,
      })
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'refused') {
        setError(outcome.message)
        return
      }
      setPending(null)
      onApplied(outcome.result, outcome.planAbandoned)
    } catch (caught: unknown) {
      setError(
        targetLifecycleErrorMessage(caught) ??
          (caught instanceof Error ? caught.message : '目標を完了にできません。'),
      )
    } finally {
      setSubmitting(false)
    }
  }, [api, onApplied, pending, planGuard, submitting])

  return { pending, affectedTargets, submitting, error, begin, cancel, confirm }
}
