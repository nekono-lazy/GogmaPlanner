import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PlanBreakingChangeApprovalRequiredError,
  type PlanAbandonSavePointDecision,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanBreakingReason,
} from '../../domain/execution'
import type { ProductionPlanId, TargetWeaponId } from '../../domain/models/publicTypes'
import {
  PLAN_GUARDED_BUSY_MESSAGE,
  planGuardedRefusalMessage,
  type PlanBreakingChangeRequiredInspection,
} from './planBreakingChangePresentation'

/**
 * One user change behind the breaking-change guard (`docs/PLANNER_SPEC.md`
 * 16.6, `docs/UI_FLOW.md` 16.3): its read-only inspection and the same change
 * saved with the approval. Both close over the very same intent, so an
 * inspection is never reused for another change.
 */
export interface PlanGuardedAction<R> {
  inspect(): Promise<PlanBreakingChangeInspection>
  apply(approval: PlanBreakingChangeApproval | null): Promise<R>
  /** A short operation-specific sentence under the warning. Never a judgement. */
  note?: string
  /**
   * The one Target this change is about, when the operation itself names it
   * (Issue #276 PR-6B, `docs/PLANNER_SPEC.md` 18.3): an edit, delete or
   * completion of that Target, or a change to its Build List Entry. With it,
   * a warning about a Plan-dependent Target or Entry may offer to leave the
   * change unsaved and exclude the Target in a replan instead. Omitted
   * whenever the operation names no single Target; nothing guesses one.
   */
  replanExclusionTargetWeaponId?: TargetWeaponId
}

/** 「保存せずに再計画を開く」: the change was left unsaved, and the replan of `planId` opens with the Target left out. */
export interface PlanBreakingReplanExclusionRequest {
  planId: ProductionPlanId
  targetWeaponId: TargetWeaponId
}

export type PlanGuardedActionOutcome<R> =
  /**
   * Saved. `planAbandoned` is true when the save ended the `active` Plan with the
   * user's approval - with 「最後のゲーム内セーブ地点へ戻す」 too, which restores,
   * saves the change over the restored state and abandons the Plan
   * (`docs/PLANNER_SPEC.md` 16.10).
   */
  | { status: 'applied'; result: R; planAbandoned: boolean }
  /**
   * The user cancelled the warning or the save point choice: nothing was saved.
   * `replanExclusion` is set when the user chose 「保存せずに再計画を開く」
   * instead: the change is just as cancelled, and the caller opens the replan
   * once its own cancel handling is done.
   */
  | { status: 'cancelled'; replanExclusion?: PlanBreakingReplanExclusionRequest }
  /** The runtime refused the save, or storage failed: nothing was saved. */
  | { status: 'refused'; message: string }

/** Which dialog the submitting state keeps open, with its controls disabled. */
export type PlanBreakingChangePhase = 'warning' | 'choosing_save_point' | 'confirming_restore'

/** What every phase of a pending change carries besides its inspection. */
interface PlanBreakingChangePending {
  inspection: PlanBreakingChangeRequiredInspection
  note: string | null
  /**
   * The replan exclusion the warning offers (Issue #276 PR-6B), or null: decided once, before the warning opens, from the action's
   * Target, the inspection's reasons and the read-only replan guidance. It never changes the warning, the approval or the save.
   */
  replanExclusion: PlanBreakingReplanExclusionRequest | null
}

/**
 * The warning's own state. Inspections and unguarded saves run outside it and
 * are counted by `busy` only; at most one change waits for a decision.
 */
export type PlanBreakingChangeApprovalState =
  | { status: 'idle' }
  | ({ status: 'warning' } & PlanBreakingChangePending)
  | ({ status: 'choosing_save_point' } & PlanBreakingChangePending)
  | ({ status: 'confirming_restore' } & PlanBreakingChangePending)
  | ({ status: 'submitting'; phase: PlanBreakingChangePhase } & PlanBreakingChangePending)

/**
 * Whether a running Plan's replan could leave a Target out (`RunningPlanReplanGuidanceReader.canExcludeInReplan()`): read-only and
 * display only.
 */
export type PlanBreakingReplanExclusionInspector = (planId: ProductionPlanId, targetWeaponId: TargetWeaponId) => Promise<boolean>

export interface UsePlanBreakingChangeApprovalOptions {
  /**
   * Enables the warning's 「保存せずに再計画を開く」 (Issue #276 PR-6B). Without it, no warning offers the replan exclusion, exactly as
   * before.
   */
  replanExclusion?: PlanBreakingReplanExclusionInspector
}

/** The warning reasons about a Plan-dependent Target or Entry (`docs/PLANNER_SPEC.md` 18.3): only they offer the exclusion. */
const REPLAN_EXCLUSION_REASONS: ReadonlySet<PlanBreakingReason> = new Set<PlanBreakingReason>(['target_changed', 'build_list_changed'])

export interface PlanBreakingChangeApprovalController {
  state: PlanBreakingChangeApprovalState
  /** An inspection, a save, a warning or a choice is in flight. */
  busy: boolean
  /** A warning or the save point choice waits for the user, or the approved save is in flight. */
  deciding: boolean
  /**
   * Runs one guarded change: inspect, then save as usual, or warn first and
   * save with the user's approval. It resolves once the change was saved,
   * cancelled or refused. The change's own validation and reference errors
   * are rethrown as they are, so the screen reports them as before. While a
   * warning waits for its decision, another change that also needs one is
   * refused rather than queued behind it.
   */
  run<R>(action: PlanGuardedAction<R>): Promise<PlanGuardedActionOutcome<R>>
  /** 「キャンセル」 at any phase: nothing is saved and the pending change ends. */
  cancel(): void
  /**
   * 「保存せずに再計画を開く」 (only while the warning offers it): the pending change ends exactly as a cancellation - nothing is saved
   * and no Plan is touched - with the exclusion request in its outcome.
   */
  chooseReplanExclusion(): void
  /** 「生産計画を破棄して保存」: submits with no decision, or asks the 16.10 choice. */
  approve(): void
  /** 「現在地点を維持」. */
  keepCurrent(): void
  /** 「最後のゲーム内セーブ地点へ戻す」: asks the game-side confirmation first. */
  chooseRestore(): void
  /** The game went back to the save point: submits the restore decision. */
  confirmRestore(): void
}

interface PendingAction {
  action: PlanGuardedAction<unknown>
  inspection: PlanBreakingChangeRequiredInspection
  resolve(outcome: PlanGuardedActionOutcome<unknown>): void
  reject(error: unknown): void
}

/**
 * The breaking-change warning state machine every guarded screen shares
 * (`docs/UI_FLOW.md` 16.3 / 16.2). It holds no persisted state and judges
 * nothing itself: the inspection - the runtime's read-only answer, or the one
 * a refused save carried - is the only authority for whether the warning is
 * shown, which reasons it lists and whether the save point choice is asked.
 * The approval handed to the save is built from that inspection alone, and
 * it is used for that one pending change only.
 */
export function usePlanBreakingChangeApproval(options: UsePlanBreakingChangeApprovalOptions = {}): PlanBreakingChangeApprovalController {
  const [state, setStateValue] = useState<PlanBreakingChangeApprovalState>({ status: 'idle' })
  const [inFlight, setInFlight] = useState(0)
  const stateRef = useRef<PlanBreakingChangeApprovalState>(state)
  const pendingRef = useRef<PendingAction | null>(null)
  const aliveRef = useRef(false)
  const exclusionInspectorRef = useRef(options.replanExclusion)
  useEffect(() => {
    exclusionInspectorRef.current = options.replanExclusion
  })

  const setState = useCallback((next: PlanBreakingChangeApprovalState) => {
    stateRef.current = next
    if (aliveRef.current) setStateValue(next)
  }, [])
  const track = useCallback((delta: number) => {
    if (aliveRef.current) setInFlight((count) => Math.max(0, count + delta))
  }, [])

  const finish = useCallback((outcome: PlanGuardedActionOutcome<unknown>) => {
    const pending = pendingRef.current
    pendingRef.current = null
    setState({ status: 'idle' })
    pending?.resolve(outcome)
  }, [setState])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // A warning left open by an unmounting screen saves nothing.
      const pending = pendingRef.current
      pendingRef.current = null
      stateRef.current = { status: 'idle' }
      pending?.resolve({ status: 'cancelled' })
    }
  }, [])

  const run = useCallback(<R,>(action: PlanGuardedAction<R>): Promise<PlanGuardedActionOutcome<R>> => {
    const note = action.note ?? null
    track(1)
    return (async (): Promise<PlanGuardedActionOutcome<R>> => {
      try {
        let inspection: PlanBreakingChangeInspection
        try {
          inspection = await action.inspect()
        } catch (caught: unknown) {
          const refusal = planGuardedRefusalMessage(caught)
          if (refusal !== null) return { status: 'refused', message: refusal }
          throw caught
        }
        if (!aliveRef.current) return { status: 'cancelled' }

        if (!inspection.approvalRequired) {
          try {
            const result = await action.apply(null)
            return { status: 'applied', result, planAbandoned: false }
          } catch (caught: unknown) {
            if (caught instanceof PlanBreakingChangeApprovalRequiredError) {
              // An `active` Plan appeared between the inspection and the save:
              // the refusal carries the warning's content, so it is shown as
              // the warning rather than as an error.
              inspection = caught.inspection
            } else {
              const refusal = planGuardedRefusalMessage(caught)
              if (refusal !== null) return { status: 'refused', message: refusal }
              throw caught
            }
          }
          if (!aliveRef.current) return { status: 'cancelled' }
        }

        const required = inspection as PlanBreakingChangeRequiredInspection
        // Decided before the warning opens, so the warning never changes under the user's eyes. A failed read offers nothing.
        const exclusionTargetId = action.replanExclusionTargetWeaponId
        const exclusionInspector = exclusionInspectorRef.current
        let replanExclusion: PlanBreakingReplanExclusionRequest | null = null
        if (
          exclusionTargetId !== undefined
          && exclusionInspector !== undefined
          && required.reasons.some((reason) => REPLAN_EXCLUSION_REASONS.has(reason))
        ) {
          const planId = required.observedPlan.planId
          const offered = await exclusionInspector(planId, exclusionTargetId).catch(() => false)
          if (!aliveRef.current) return { status: 'cancelled' }
          if (offered) replanExclusion = { planId, targetWeaponId: exclusionTargetId }
        }

        if (pendingRef.current !== null || stateRef.current.status !== 'idle') {
          return { status: 'refused', message: PLAN_GUARDED_BUSY_MESSAGE }
        }
        return await new Promise<PlanGuardedActionOutcome<R>>((resolve, reject) => {
          pendingRef.current = {
            action: action as PlanGuardedAction<unknown>,
            inspection: required,
            resolve: resolve as (outcome: PlanGuardedActionOutcome<unknown>) => void,
            reject,
          }
          setState({ status: 'warning', inspection: required, note, replanExclusion })
        })
      } finally {
        track(-1)
      }
    })()
  }, [setState, track])

  const submit = useCallback((decision: PlanAbandonSavePointDecision, phase: PlanBreakingChangePhase) => {
    const pending = pendingRef.current
    const current = stateRef.current
    if (
      pending === null ||
      (current.status !== 'warning' && current.status !== 'choosing_save_point' && current.status !== 'confirming_restore')
    ) {
      return
    }
    setState({
      status: 'submitting',
      inspection: pending.inspection,
      note: current.note,
      replanExclusion: current.replanExclusion,
      phase,
    })
    // The approval is the inspection the user saw and their decision; the
    // Plan token is never rebuilt from a fresh read.
    const approval: PlanBreakingChangeApproval = {
      observedPlan: pending.inspection.observedPlan,
      savePointDecision: decision,
    }
    void (async () => {
      try {
        const result = await pending.action.apply(approval)
        if (pendingRef.current !== pending) return
        // Every approved breaking change ends the `active` Plan, whichever
        // save point decision the user made (16.10).
        finish({ status: 'applied', result, planAbandoned: true })
      } catch (caught: unknown) {
        if (pendingRef.current !== pending) return
        const refusal = planGuardedRefusalMessage(caught)
        if (refusal !== null) {
          finish({ status: 'refused', message: refusal })
          return
        }
        pendingRef.current = null
        setState({ status: 'idle' })
        pending.reject(caught)
      }
    })()
  }, [finish, setState])

  const cancel = useCallback(() => {
    const current = stateRef.current
    if (current.status === 'submitting' || current.status === 'idle') return
    finish({ status: 'cancelled' })
  }, [finish])

  const chooseReplanExclusion = useCallback(() => {
    const current = stateRef.current
    // Only the warning itself offers it, never while the approved save is in flight or after the approval.
    if (current.status !== 'warning' || current.replanExclusion === null) return
    finish({ status: 'cancelled', replanExclusion: current.replanExclusion })
  }, [finish])

  const approve = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'warning') return
    if (current.inspection.savePointChoiceRequired) {
      setState({
        status: 'choosing_save_point',
        inspection: current.inspection,
        note: current.note,
        replanExclusion: current.replanExclusion,
      })
      return
    }
    submit(null, 'warning')
  }, [setState, submit])

  const keepCurrent = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'choosing_save_point' || !current.inspection.savePointChoiceRequired) return
    submit({ kind: 'keep_current', recordedAt: current.inspection.savePointRecordedAt }, 'choosing_save_point')
  }, [submit])

  const chooseRestore = useCallback(() => {
    const current = stateRef.current
    // A restore the inspection says cannot run is never offered (Issue #335).
    if (
      current.status !== 'choosing_save_point' ||
      !current.inspection.savePointChoiceRequired ||
      !current.inspection.savePointRestore.restorable
    ) return
    setState({
      status: 'confirming_restore',
      inspection: current.inspection,
      note: current.note,
      replanExclusion: current.replanExclusion,
    })
  }, [setState])

  const confirmRestore = useCallback(() => {
    const current = stateRef.current
    if (
      current.status !== 'confirming_restore' ||
      !current.inspection.savePointChoiceRequired ||
      !current.inspection.savePointRestore.restorable
    ) return
    submit({ kind: 'restore_save_point', recordedAt: current.inspection.savePointRecordedAt }, 'confirming_restore')
  }, [submit])

  return {
    state,
    busy: inFlight > 0 || state.status !== 'idle',
    deciding: state.status !== 'idle',
    run,
    cancel,
    chooseReplanExclusion,
    approve,
    keepCurrent,
    chooseRestore,
    confirmRestore,
  }
}
