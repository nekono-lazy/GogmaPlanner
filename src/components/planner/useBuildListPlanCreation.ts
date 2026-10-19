import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CalculationContext, ProductionPlan } from '../../domain/models/publicTypes'
import type { PlannerOptions, PlannerResult } from '../../domain/planner'
import { createBuildListCalculationContext } from '../../services/buildList/createBuildListCalculationContext'
import {
  buildListOptimizationAdoptionSourceOf,
  type BuildListOptimizationAdoptionSource,
} from '../../services/planner/buildListOptimizationService'
import {
  planCreationOptimizationOf,
  type PlanCreationOperation,
  type PlanCreationPreparation,
  type PlanCreationRequest,
  type PlanCreationSession,
  type PlanCreationSessionState,
  type PrimaryPlanCreationState,
} from '../../services/planner/planCreationService'
import type { BuildListOptimizationAdoptionInspection } from '../../services/planner/plannerResultPersistenceService'
import {
  presentBuildListOptimizationAdoptionRefusal,
  type BuildListOptimizationAdoptionRefusalPresentation,
} from './planCreationPresentation'

/**
 * The Build List screen's plan creation controller (`docs/PLANNER_SPEC.md` 17.2 / 17.9 / 17.11 / 17.16, `docs/UI_FLOW.md` 10.2 /
 * 10.4, Issue #260 PR-6C). It connects the screen to the Application boundary and to Persistence; it judges nothing itself.
 *
 *   - one `PlanCreationSession` per screen mount (created on mount, disposed on unmount - leaving the screen cancels a calculation).
 *     A re-read of the screen's data never recreates or disposes it
 *   - the pre-start judgement is `session.inspect()`, display only: every press reads and judges again inside the session. An older
 *     inspection never replaces a newer one, and while one runs the previous judgement is not shown as current
 *   - an ordinary Planner run that finished is saved through the existing `savePlannerResult()` (an `incomplete` search never is),
 *     and only the Draft Persistence returned is navigated to
 *   - an `optimized` result is adopted only through `inspectBuildListOptimizationAdoption()`, the confirmation, and
 *     `saveBuildListOptimizationAdoption()`, with the adoption source of the shown run (`buildListOptimizationAdoptionSourceOf()`, the
 *     artifact and start snapshot of one run); a refusal discards the Preview and asks for a new calculation, which never starts by
 *     itself
 *
 * Nothing here falls back from the optimization to the ordinary Planner: the ordinary Planner runs only on a press.
 */

export interface BuildListPlanCreationDependencies {
  master: MasterDataRoot
  /** One session per screen mount; the controller disposes it on unmount. */
  createPlanCreationSession(): PlanCreationSession
  /** The ordinary Planner result save (`docs/UI_FLOW.md` 10.2): the stored Draft, or `null` when the result held no Plan. */
  savePlannerResult(result: PlannerResult, currentCalculationContext: CalculationContext): Promise<ProductionPlan | null>
  /** 17.11: the read-only adoption inspection. Never write authority. */
  inspectBuildListOptimizationAdoption(
    source: BuildListOptimizationAdoptionSource,
    currentCalculationContext: CalculationContext,
  ): Promise<BuildListOptimizationAdoptionInspection>
  /** 17.11: the one adoption transaction; returns the stored Draft. */
  saveBuildListOptimizationAdoption(
    source: BuildListOptimizationAdoptionSource,
    currentCalculationContext: CalculationContext,
  ): Promise<ProductionPlan>
}

/** The pre-start judgement shown before a press (`docs/UI_FLOW.md` 10.4). Display only. */
export type PlanCreationPreStartState =
  | { status: 'loading' }
  | { status: 'ready'; preparation: PlanCreationPreparation }

/** The save of one ordinary Planner run (`operation` + `runId` name the press it belongs to). */
export type OrdinaryPlannerSaveState =
  | { operation: PlanCreationOperation; runId: number; status: 'saving' }
  | { operation: PlanCreationOperation; runId: number; status: 'no_plan' }
  | { operation: PlanCreationOperation; runId: number; status: 'failed'; message: string }

/** One optimization run of the primary operation: the plan creation press and the optimization session's run of it. */
interface OptimizationRunKey {
  primaryRunId: number
  optimizationRunId: number
}

/** The adoption of the shown `optimized` result (`docs/UI_FLOW.md` 10.4 「採用」). */
export type BuildListOptimizationAdoptionState =
  | { status: 'idle' }
  | { status: 'inspecting' }
  | { status: 'confirming'; inspection: BuildListOptimizationAdoptionInspection }
  | { status: 'saving'; inspection: BuildListOptimizationAdoptionInspection }

export interface BuildListPlanCreationController {
  /** False without Master Data (no session): nothing is offered. */
  available: boolean
  state: PlanCreationSessionState
  preStart: PlanCreationPreStartState
  ordinarySave: OrdinaryPlannerSaveState | null
  adoption: BuildListOptimizationAdoptionState
  adoptionRefusal: BuildListOptimizationAdoptionRefusalPresentation | null
  /** Reading, calculating, saving or adopting: no new press, and the Build List is not edited on this screen. */
  busy: boolean
  refreshPreStart(): void
  startPrimary(plannerOptions: PlannerOptions | null): void
  /** The auxiliary operation inside an optimization result (`startOrdinaryPlanner()`). */
  startAuxiliaryFromResult(plannerOptions: PlannerOptions | null): void
  /** The auxiliary operation inside the pre-start body (`startOrdinaryPlannerForPreStartUnsupported()`). */
  startAuxiliaryPreStart(plannerOptions: PlannerOptions | null): void
  cancel(): void
  /** Drops the shown result (「戻る」 / 「結果を閉じる」). */
  discardResult(): void
  /** A Build List change was saved on this screen (17.9): the shown results are stale and are dropped. */
  buildListChanged(): void
  requestAdoption(): void
  cancelAdoption(): void
  confirmAdoption(): void
  dismissAdoptionRefusal(): void
}

const IDLE_STATE: PlanCreationSessionState = { primary: { status: 'idle' }, auxiliary: { status: 'idle' } }

function slotOf(state: PlanCreationSessionState, operation: PlanCreationOperation): PrimaryPlanCreationState {
  return operation === 'primary' ? state.primary : state.auxiliary
}

function runIdOf(slot: PrimaryPlanCreationState): number | null {
  return 'runId' in slot ? slot.runId : null
}

/** The optimization run the primary operation shows, or null. */
function optimizationRunKeyOf(state: PlanCreationSessionState): OptimizationRunKey | null {
  const held = planCreationOptimizationOf(state)
  if (held === null || !('runId' in held.optimization)) return null
  return { primaryRunId: held.runId, optimizationRunId: held.optimization.runId }
}

function sameRunKey(left: OptimizationRunKey | null, right: OptimizationRunKey | null): boolean {
  return left !== null && right !== null && left.primaryRunId === right.primaryRunId && left.optimizationRunId === right.optimizationRunId
}

function isSlotInProgress(slot: PrimaryPlanCreationState): boolean {
  if (slot.status === 'preparing') return true
  if (slot.status === 'ordinary_planner') return slot.run.status === 'running'
  if (slot.status === 'build_list_optimization') {
    return slot.optimization.status === 'preparing' || slot.optimization.status === 'running'
  }
  return false
}

export function useBuildListPlanCreation({
  dependencies,
  onSaved,
  onPersistedStateChanged,
}: {
  dependencies: BuildListPlanCreationDependencies | null
  /** Persistence stored a Draft (an ordinary save or an adoption): its own ID is the only navigation target. */
  onSaved(plan: ProductionPlan): void
  /** A press or an inspection found the persisted state moved (a running Plan, a refused adoption): the screen re-reads it. */
  onPersistedStateChanged(): void
}): BuildListPlanCreationController {
  const [state, setState] = useState<PlanCreationSessionState>(IDLE_STATE)
  const [preStart, setPreStart] = useState<PlanCreationPreStartState>({ status: 'loading' })
  const [ordinarySave, setOrdinarySave] = useState<OrdinaryPlannerSaveState | null>(null)
  const [adoption, setAdoption] = useState<BuildListOptimizationAdoptionState>({ status: 'idle' })
  const [adoptionRefusal, setAdoptionRefusal] = useState<BuildListOptimizationAdoptionRefusalPresentation | null>(null)
  const sessionRef = useRef<PlanCreationSession | null>(null)
  const inspectSequenceRef = useRef(0)
  // An ordinary Planner result being saved, synchronously (no press starts while it is stored).
  const savingRef = useRef(false)
  // The adoption in progress, synchronously (a second click before React re-renders never starts a second inspection or save).
  const adoptionRef = useRef<{ key: OptimizationRunKey; source: BuildListOptimizationAdoptionSource; phase: 'inspecting' | 'confirming' | 'saving' } | null>(null)
  // A judgement that found a running Plan asks the screen to re-read once; it asks again only after a judgement without one, so a
  // disagreement between the two reads never turns into a re-read loop.
  const runningPlanReloadRequestedRef = useRef(false)
  const callbacksRef = useRef({ onSaved, onPersistedStateChanged })
  useEffect(() => {
    callbacksRef.current = { onSaved, onPersistedStateChanged }
  })

  const createSession = dependencies?.createPlanCreationSession
  useEffect(() => {
    if (createSession === undefined) return
    // A new session starts idle (the state this hook starts from); every later change arrives through the subscription.
    const created = createSession()
    sessionRef.current = created
    const unsubscribe = created.subscribe(setState)
    return () => {
      unsubscribe()
      if (sessionRef.current === created) sessionRef.current = null
      // Leaving the screen cancels whatever runs (the Worker is terminated) and drops every result and adoption.
      created.dispose()
      adoptionRef.current = null
      savingRef.current = false
      inspectSequenceRef.current += 1
      setState(IDLE_STATE)
    }
  }, [createSession])

  /** True while `runId` is still the press `operation` shows in this very session. */
  const isCurrentPress = useCallback((target: PlanCreationSession, operation: PlanCreationOperation, runId: number) => (
    sessionRef.current === target && runIdOf(slotOf(target.getState(), operation)) === runId
  ), [])

  const refreshPreStart = useCallback(() => {
    const current = sessionRef.current
    if (current === null) return
    inspectSequenceRef.current += 1
    const sequence = inspectSequenceRef.current
    // While the judgement runs, the previous one is not shown as current.
    setPreStart({ status: 'loading' })
    void current.inspect().catch((error: unknown): PlanCreationPreparation => ({
      kind: 'start_read_failed',
      code: 'transaction_failed',
      message: error instanceof Error ? error.message : String(error),
    })).then((preparation) => {
      if (sequence !== inspectSequenceRef.current || sessionRef.current !== current) return
      setPreStart({ status: 'ready', preparation })
      if (preparation.kind !== 'running_plan_exists') {
        runningPlanReloadRequestedRef.current = false
      } else if (!runningPlanReloadRequestedRef.current) {
        runningPlanReloadRequestedRef.current = true
        callbacksRef.current.onPersistedStateChanged()
      }
    })
  }, [])

  const saveOrdinaryResult = useCallback(async (
    target: PlanCreationSession,
    operation: PlanCreationOperation,
    runId: number,
    result: PlannerResult,
  ) => {
    // A search the bound truncated is never saved or opened (UI_FLOW 10.1); the typed status decides, never a message.
    if (result.termination.status === 'incomplete' || dependencies === null) return
    setOrdinarySave({ operation, runId, status: 'saving' })
    savingRef.current = true
    try {
      // Rebuilt at save time: the compatibility check is against the current state (PLANNER_SPEC 9.2.15).
      const saved = await dependencies.savePlannerResult(result, createBuildListCalculationContext(dependencies.master))
      if (!isCurrentPress(target, operation, runId)) return
      if (saved !== null) {
        // Persistence is the success authority: its stored Plan's own ID, never the Worker result's.
        callbacksRef.current.onSaved(saved)
        return
      }
      setOrdinarySave({ operation, runId, status: 'no_plan' })
    } catch (caught: unknown) {
      if (!isCurrentPress(target, operation, runId)) return
      setOrdinarySave({ operation, runId, status: 'failed', message: caught instanceof Error ? caught.message : '生産計画を保存できませんでした。' })
    } finally {
      savingRef.current = false
    }
  }, [dependencies, isCurrentPress])

  /** Follows one press until it settles, then acts on what it ended as (a save, a re-judgement). */
  const followPress = useCallback(async (
    operation: PlanCreationOperation,
    press: (target: PlanCreationSession) => Promise<PlanCreationSessionState>,
  ) => {
    const target = sessionRef.current
    if (target === null) return
    const before = slotOf(target.getState(), operation)
    const pending = press(target)
    const started = slotOf(target.getState(), operation)
    // A press its entry did not take changed nothing at all.
    const runId = started === before ? null : runIdOf(started)
    await pending
    if (runId === null || !isCurrentPress(target, operation, runId)) return
    const slot = slotOf(target.getState(), operation)
    if (slot.status === 'not_started') {
      // The press judged afresh and started nothing: the pre-start body follows the current state again.
      if (slot.reason.kind === 'running_plan_exists') callbacksRef.current.onPersistedStateChanged()
      refreshPreStart()
      return
    }
    if (slot.status === 'ordinary_planner' && slot.run.status === 'completed') {
      await saveOrdinaryResult(target, operation, runId, slot.run.result)
    }
  }, [isCurrentPress, refreshPreStart, saveOrdinaryResult])

  const resetAdoption = useCallback(() => {
    adoptionRef.current = null
    setAdoption({ status: 'idle' })
  }, [])

  const busy = useMemo(() => (
    isSlotInProgress(state.primary)
    || isSlotInProgress(state.auxiliary)
    || ordinarySave?.status === 'saving'
    || adoption.status !== 'idle'
  ), [state, ordinarySave, adoption])

  /** `busy` as of now, not as of the last render: a second click before React re-renders starts nothing. */
  const isBusyNow = useCallback(() => {
    const current = sessionRef.current
    if (current === null) return true
    const now = current.getState()
    return isSlotInProgress(now.primary) || isSlotInProgress(now.auxiliary) || savingRef.current || adoptionRef.current !== null
  }, [])

  const startPrimary = useCallback((plannerOptions: PlannerOptions | null) => {
    if (isBusyNow()) return
    setOrdinarySave(null)
    setAdoptionRefusal(null)
    resetAdoption()
    const request: PlanCreationRequest = { plannerOptions }
    void followPress('primary', (target) => target.start(request))
  }, [isBusyNow, followPress, resetAdoption])

  const startAuxiliaryFromResult = useCallback((plannerOptions: PlannerOptions | null) => {
    if (isBusyNow()) return
    setOrdinarySave(null)
    void followPress('ordinary_planner_auxiliary', (target) => target.startOrdinaryPlanner({ plannerOptions }))
  }, [isBusyNow, followPress])

  const startAuxiliaryPreStart = useCallback((plannerOptions: PlannerOptions | null) => {
    if (isBusyNow()) return
    setOrdinarySave(null)
    setAdoptionRefusal(null)
    void followPress('ordinary_planner_auxiliary', (target) => target.startOrdinaryPlannerForPreStartUnsupported({ plannerOptions }))
  }, [isBusyNow, followPress])

  const cancel = useCallback(() => {
    sessionRef.current?.cancel()
  }, [])

  const discardResult = useCallback(() => {
    if (adoptionRef.current?.phase === 'saving') return
    resetAdoption()
    setOrdinarySave(null)
    sessionRef.current?.discard()
  }, [resetAdoption])

  const buildListChanged = useCallback(() => {
    // 17.9: a Build List change on this screen drops the shown results (the Preview, the auxiliary offer beside it, an ordinary run's
    // notice). The refreshed pre-start judgement follows from the re-read Build List.
    if (adoptionRef.current?.phase === 'saving') return
    resetAdoption()
    setOrdinarySave(null)
    setAdoptionRefusal(null)
    const current = sessionRef.current
    if (current !== null && (current.getState().primary.status !== 'idle' || current.getState().auxiliary.status !== 'idle')) current.discard()
  }, [resetAdoption])

  // An adoption belongs to one shown run: a new run, a discard or a dispose ends it, and a late answer for it is ignored.
  const shownRunKey = optimizationRunKeyOf(state)
  const shownPrimaryRunId = shownRunKey?.primaryRunId ?? null
  const shownOptimizationRunId = shownRunKey?.optimizationRunId ?? null
  useEffect(() => {
    const pending = adoptionRef.current
    if (pending === null || pending.phase === 'saving') return
    const shown = shownPrimaryRunId === null || shownOptimizationRunId === null
      ? null
      : { primaryRunId: shownPrimaryRunId, optimizationRunId: shownOptimizationRunId }
    if (!sameRunKey(pending.key, shown)) resetAdoption()
  }, [shownPrimaryRunId, shownOptimizationRunId, resetAdoption])

  const refuseAdoption = useCallback((target: PlanCreationSession, caught: unknown) => {
    adoptionRef.current = null
    setAdoption({ status: 'idle' })
    setAdoptionRefusal(presentBuildListOptimizationAdoptionRefusal(caught))
    // The Preview no longer stands for the current state: it is dropped, and nothing is calculated or started by itself.
    if (sessionRef.current === target) target.discard()
    callbacksRef.current.onPersistedStateChanged()
  }, [])

  const requestAdoption = useCallback(() => {
    const target = sessionRef.current
    if (target === null || dependencies === null || adoptionRef.current !== null) return
    const current = target.getState()
    const held = planCreationOptimizationOf(current)
    const key = optimizationRunKeyOf(current)
    const source = held === null ? null : buildListOptimizationAdoptionSourceOf(held.optimization)
    if (key === null || source === null) return
    adoptionRef.current = { key, source, phase: 'inspecting' }
    setAdoptionRefusal(null)
    setAdoption({ status: 'inspecting' })
    void dependencies.inspectBuildListOptimizationAdoption(source, createBuildListCalculationContext(dependencies.master)).then(
      (inspection) => {
        const pending = adoptionRef.current
        // A discarded or replaced Preview never opens a dialog for itself.
        if (pending === null || pending.source !== source || pending.phase !== 'inspecting' || sessionRef.current !== target) return
        if (!sameRunKey(pending.key, optimizationRunKeyOf(target.getState()))) return
        adoptionRef.current = { ...pending, phase: 'confirming' }
        setAdoption({ status: 'confirming', inspection })
      },
      (caught: unknown) => {
        const pending = adoptionRef.current
        if (pending === null || pending.source !== source || sessionRef.current !== target) return
        refuseAdoption(target, caught)
      },
    )
  }, [dependencies, refuseAdoption])

  const cancelAdoption = useCallback(() => {
    if (adoptionRef.current?.phase !== 'confirming') return
    resetAdoption()
  }, [resetAdoption])

  const confirmAdoption = useCallback(() => {
    const target = sessionRef.current
    const pending = adoptionRef.current
    if (target === null || dependencies === null || pending === null || pending.phase !== 'confirming') return
    if (!sameRunKey(pending.key, optimizationRunKeyOf(target.getState())) || adoption.status !== 'confirming') {
      resetAdoption()
      return
    }
    const { source } = pending
    adoptionRef.current = { ...pending, phase: 'saving' }
    setAdoption({ status: 'saving', inspection: adoption.inspection })
    void dependencies.saveBuildListOptimizationAdoption(source, createBuildListCalculationContext(dependencies.master)).then(
      (plan) => {
        if (sessionRef.current !== target || adoptionRef.current?.source !== source) return
        // Persistence's stored Draft is the only navigation target (17.11); the Preview's Plan ID is never used.
        callbacksRef.current.onSaved(plan)
      },
      (caught: unknown) => {
        if (sessionRef.current !== target || adoptionRef.current?.source !== source) return
        refuseAdoption(target, caught)
      },
    )
  }, [adoption, dependencies, refuseAdoption, resetAdoption])

  const dismissAdoptionRefusal = useCallback(() => setAdoptionRefusal(null), [])

  return {
    available: createSession !== undefined,
    state,
    preStart,
    ordinarySave,
    adoption,
    adoptionRefusal,
    busy,
    refreshPreStart,
    startPrimary,
    startAuxiliaryFromResult,
    startAuxiliaryPreStart,
    cancel,
    discardResult,
    buildListChanged,
    requestAdoption,
    cancelAdoption,
    confirmAdoption,
    dismissAdoptionRefusal,
  }
}
