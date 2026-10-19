import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PlanBreakingChangeApprovalRequiredError,
  type PlanAbandonSavePointDecision,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
} from '../../domain/execution'
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
}

export type PlanGuardedActionOutcome<R> =
  /**
   * Saved. `planAbandoned` is true when the save ended the `active` Plan with the
   * user's approval - with 「最後のゲーム内セーブ地点へ戻す」 too, which restores,
   * saves the change over the restored state and abandons the Plan
   * (`docs/PLANNER_SPEC.md` 16.10).
   */
  | { status: 'applied'; result: R; planAbandoned: boolean }
  /** The user cancelled the warning or the save point choice: nothing was saved. */
  | { status: 'cancelled' }
  /** The runtime refused the save, or storage failed: nothing was saved. */
  | { status: 'refused'; message: string }

/** Which dialog the submitting state keeps open, with its controls disabled. */
export type PlanBreakingChangePhase = 'warning' | 'choosing_save_point' | 'confirming_restore'

/**
 * The warning's own state. Inspections and unguarded saves run outside it and
 * are counted by `busy` only; at most one change waits for a decision.
 */
export type PlanBreakingChangeApprovalState =
  | { status: 'idle' }
  | { status: 'warning'; inspection: PlanBreakingChangeRequiredInspection; note: string | null }
  | { status: 'choosing_save_point'; inspection: PlanBreakingChangeRequiredInspection; note: string | null }
  | { status: 'confirming_restore'; inspection: PlanBreakingChangeRequiredInspection; note: string | null }
  | {
      status: 'submitting'
      inspection: PlanBreakingChangeRequiredInspection
      note: string | null
      phase: PlanBreakingChangePhase
    }

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
export function usePlanBreakingChangeApproval(): PlanBreakingChangeApprovalController {
  const [state, setStateValue] = useState<PlanBreakingChangeApprovalState>({ status: 'idle' })
  const [inFlight, setInFlight] = useState(0)
  const stateRef = useRef<PlanBreakingChangeApprovalState>(state)
  const pendingRef = useRef<PendingAction | null>(null)
  const aliveRef = useRef(false)

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

        if (pendingRef.current !== null || stateRef.current.status !== 'idle') {
          return { status: 'refused', message: PLAN_GUARDED_BUSY_MESSAGE }
        }
        const required = inspection as PlanBreakingChangeRequiredInspection
        return await new Promise<PlanGuardedActionOutcome<R>>((resolve, reject) => {
          pendingRef.current = {
            action: action as PlanGuardedAction<unknown>,
            inspection: required,
            resolve: resolve as (outcome: PlanGuardedActionOutcome<unknown>) => void,
            reject,
          }
          setState({ status: 'warning', inspection: required, note })
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

  const approve = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'warning') return
    if (current.inspection.savePointChoiceRequired) {
      setState({
        status: 'choosing_save_point',
        inspection: current.inspection,
        note: current.note,
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
    if (current.status !== 'choosing_save_point') return
    setState({
      status: 'confirming_restore',
      inspection: current.inspection,
      note: current.note,
    })
  }, [setState])

  const confirmRestore = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'confirming_restore' || !current.inspection.savePointChoiceRequired) return
    submit({ kind: 'restore_save_point', recordedAt: current.inspection.savePointRecordedAt }, 'confirming_restore')
  }, [submit])

  return {
    state,
    busy: inFlight > 0 || state.status !== 'idle',
    deciding: state.status !== 'idle',
    run,
    cancel,
    approve,
    keepCurrent,
    chooseRestore,
    confirmRestore,
  }
}
