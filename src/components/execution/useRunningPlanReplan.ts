import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RepositoryError } from '../../db/repositoryError'
import { ExecutionRuntimeError, type PlanAbandonSavePointDecision } from '../../domain/execution'
import type { RunningPlanReplanAdoptionInspection } from '../../domain/execution/runningPlanReplanAdoption'
import type { RunningPlanReplanAuxiliaryShortfall } from '../../domain/execution/runningPlanReplanAuxiliary'
import {
  emptyReplanTargetSelection,
  type ReplanTargetSelection,
} from '../../domain/execution/runningPlanReplanTargets'
import type { BuildListEntry, ProductionPlanId, TargetWeaponId } from '../../domain/models/publicTypes'
import type { PlannerOptions } from '../../domain/planner'
import type { ProductionPlanReplanDependencies } from '../../services/execution/productionPlanReplanDependencies'
import type { RunningPlanReplanAuxiliaryReadyPreparation } from '../../services/execution/runningPlanReplanAuxiliaryService'
import type { RunningPlanReplanDependencies } from '../../services/execution/runningPlanReplanDependencies'
import type { RunningPlanReplanPreStartInspection } from '../../services/execution/runningPlanReplanPreStartService'
import {
  runningPlanIdentityRefusalOf,
  runningPlanReplanAuxiliaryOfferOf,
  runningPlanReplanPreviewOf,
  type RunningPlanReplanPreview,
  type RunningPlanReplanSession,
  type RunningPlanReplanSessionAuxiliaryOffer,
  type RunningPlanReplanSessionState,
  type RunningPlanReplanStart,
} from '../../services/execution/runningPlanReplanService'
import type { PlannerWorkerClient } from '../../services/planner/plannerWorkerClient'
import { runningPlanReplanInitialSelectionDroppedMessage } from './runningPlanReplanGuidancePresentation'
import {
  presentRunningPlanReplanRefusal,
  RUNNING_PLAN_REPLAN_AUXILIARY_OPTIONS_INVALID_MESSAGE,
  RUNNING_PLAN_REPLAN_PLAN_CHANGED_MESSAGE,
  RUNNING_PLAN_REPLAN_SAVE_POINT_RESTORED_MESSAGE,
  runningPlanReplanAdoptionRefusalMessage,
} from './runningPlanReplanPresentation'
import {
  useProductionPlanReplanPreview,
  type ProductionPlanReplanPreviewController,
  type ReplanPreviewRequestPreparation,
} from './useProductionPlanReplanPreview'

/**
 * The running Plan replan controller the Build List and the Production Plan page share (`docs/PLANNER_SPEC.md` 18.2 / 18.5 / 18.7 /
 * 18.8, `docs/UI_FLOW.md` 16.5, Issue #276 PR-6A). It connects the screen to the Application boundary; it judges nothing itself.
 *
 *   - the replan is opened for one Plan - the screen's displayed running Plan - and stays bound to that Plan ID (runtime-only) until
 *     it is closed: the pre-start inspection, the session's start and the auxiliary's preparation all name it, and another running
 *     Plan found by any of their fresh reads is refused (`running_plan_changed`) before its state is shown or calculated. The same
 *     Plan having moved on is no refusal: everything is derived again from the latest state
 *   - the target confirmation opens only on the user's press. Each selection change reads the current state again through the
 *     read-only pre-start inspection (PR-4's start reader and Stage 0R); the categories, counts and reasons are the Domain's. The
 *     selection is runtime-only and never persisted
 *   - one `RunningPlanReplanSession` per screen mount (created on mount, disposed on unmount: leaving the screen cancels the run).
 *     Its start reads afresh, so the confirmation shown before is never the start authority. A new start, a selection change, a
 *     Build List change on the screen, closing and a refused adoption drop the held result
 *   - an `optimized` result is adopted only through `inspectAdoption()`, the user's confirmation and one `adopt()` call naming the
 *     16.10 decision. Every refusal drops the Preview (it is never adopted again), the screen re-reads, and nothing recalculates or
 *     re-adopts by itself. It never goes through the Plan-breaking guard
 *   - the explicit auxiliary (the ordinary Planner over the registered Routes, 18.5) runs only on its own press, beside a result whose
 *     session state offers it (`runningPlanReplanAuxiliaryOfferOf()`); its input is the Application's scoped press-time preparation
 *     and its run, Preview and adoption are the unchanged 16.8 ones. No outcome of the re-optimization starts it
 */

export interface UseRunningPlanReplanOptions {
  /** Null without Master Data: nothing is offered. */
  dependencies: RunningPlanReplanDependencies | null
  /** The 16.8 runtime the auxiliary's Preview and adoption use. */
  ordinaryReplan: ProductionPlanReplanDependencies
  /** The auxiliary's ordinary Planner Worker; created on its first run and disposed with the screen. */
  createPlannerWorkerClient(): PlannerWorkerClient
  /** An adoption succeeded (the re-optimization or the auxiliary): the new Plan is `active`. */
  onAdopted(newPlanId: ProductionPlanId): void
  /** The persisted state moved (a refused adoption, a save point restore): the screen re-reads what it shows. */
  onPersistedStateChanged(): void
}

/** The target confirmation's read (display only). `previous` keeps the last ready read on screen while a newer one loads. */
export type RunningPlanReplanTargetsState =
  | { status: 'closed' }
  | { status: 'loading'; previous: Extract<RunningPlanReplanPreStartInspection, { kind: 'ready' }> | null }
  | { status: 'loaded'; inspection: RunningPlanReplanPreStartInspection }

export type RunningPlanReplanAdoptionState =
  | { status: 'idle' }
  | { status: 'inspecting' }
  | { status: 'confirming'; inspection: RunningPlanReplanAdoptionInspection }
  | { status: 'submitting'; inspection: RunningPlanReplanAdoptionInspection }

export interface RunningPlanReplanNotice {
  severity: 'info' | 'error'
  message: string
}

export interface RunningPlanReplanController {
  available: boolean
  open: boolean
  targets: RunningPlanReplanTargetsState
  selection: ReplanTargetSelection
  session: RunningPlanReplanSessionState
  /** The start the shown completion (or running calculation) belongs to: its Targets and weapons name the result. */
  resultStart: RunningPlanReplanStart | null
  preview: RunningPlanReplanPreview | null
  adoption: RunningPlanReplanAdoptionState
  /** The outcome of the last adoption attempt that ended without navigation (a refusal, a save point restore). */
  notice: RunningPlanReplanNotice | null
  auxiliaryOffer: RunningPlanReplanSessionAuxiliaryOffer
  /** The auxiliary's 16.8 Preview controller (its own Worker and state machine). */
  auxiliary: ProductionPlanReplanPreviewController
  /** The replan Targets the shown auxiliary Preview does not make, by typed reason; null without a finished auxiliary Preview. */
  auxiliaryShortfall: RunningPlanReplanAuxiliaryShortfall | null
  /** The auxiliary input's Entries (to name its Conflict participants), or null. */
  auxiliaryBuildListEntries: readonly BuildListEntry[] | null
  /** The Plan the replan was opened for (runtime-only); null while closed. */
  targetPlanId: ProductionPlanId | null
  /** The re-optimization is reading or calculating. */
  calculating: boolean
  /**
   * Reading, calculating, adopting, running the auxiliary or adopting through it: the selection, the Build List edits, a new start
   * and dropping the result wait.
   */
  busy: boolean
  /** An adoption (the re-optimization's or the auxiliary's) is being checked, confirmed or saved: the replan cannot be closed. */
  closeDisabled: boolean
  /**
   * Opens the target confirmation of `planId`'s replan (the screen's displayed running Plan, or the Plan a proposal / a warning named)
   * and binds the replan to that Plan. `initialSelection` is a runtime-only suggestion: an ID the current state cannot apply it to is
   * dropped with a notice, never forced. Ignored while an adoption is being checked, confirmed or saved.
   */
  openPanel(planId: ProductionPlanId, initialSelection?: ReplanTargetSelection): void
  closePanel(): void
  /**
   * The screen re-read which Plan is running now (null for none). A replan open for another Plan is closed - its results are dropped -
   * and the notice says the running Plan changed; nothing switches to the new Plan by itself.
   */
  runningPlanChanged(currentPlanId: ProductionPlanId | null): void
  setExcluded(targetWeaponId: TargetWeaponId, excluded: boolean): void
  setIncluded(targetWeaponId: TargetWeaponId, included: boolean): void
  resetSelection(): void
  reloadTargets(): void
  startCalculation(): void
  cancelCalculation(): void
  /** Drops the shown result and the auxiliary's Preview (「結果を閉じる」 / 「現在の計画を続ける」). */
  discardResult(): void
  requestAdoption(): void
  cancelAdoption(): void
  adopt(decision: PlanAbandonSavePointDecision): void
  /** The auxiliary press, with the user's 「最大計画ステップ数」 (null while it is invalid: nothing starts). */
  startAuxiliary(plannerOptions: PlannerOptions | null): void
  /** A Build List change was saved on this screen (18.7): the shown results are dropped and the confirmation re-read. */
  buildListChanged(): void
  dismissNotice(): void
}

const IDLE: RunningPlanReplanSessionState = { status: 'idle' }

function withToggled(ids: readonly TargetWeaponId[], id: TargetWeaponId, on: boolean): TargetWeaponId[] {
  const rest = ids.filter((existing) => existing !== id)
  return on ? [...rest, id] : rest
}

function startOf(state: RunningPlanReplanSessionState): RunningPlanReplanStart | null {
  if (state.status === 'running') return state.start
  if (state.status === 'completed' && state.completion.kind === 'calculated') return state.completion.start
  return null
}

function refusalNotStarted(message: string): ReplanPreviewRequestPreparation {
  return { kind: 'not_started', message }
}

export function useRunningPlanReplan(options: UseRunningPlanReplanOptions): RunningPlanReplanController {
  const { dependencies } = options
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<RunningPlanReplanTargetsState>({ status: 'closed' })
  const [selection, setSelection] = useState<ReplanTargetSelection>(emptyReplanTargetSelection)
  const [session, setSession] = useState<RunningPlanReplanSessionState>(IDLE)
  const [adoption, setAdoptionState] = useState<RunningPlanReplanAdoptionState>({ status: 'idle' })
  const [notice, setNotice] = useState<RunningPlanReplanNotice | null>(null)
  const [auxiliaryPrepared, setAuxiliaryPrepared] = useState<RunningPlanReplanAuxiliaryReadyPreparation | null>(null)
  // The Plan the replan is bound to: state for rendering, ref for the callbacks that land after a render.
  const [targetPlanId, setTargetPlanIdState] = useState<ProductionPlanId | null>(null)
  const targetPlanIdRef = useRef<ProductionPlanId | null>(null)
  const openRef = useRef(false)
  const auxiliaryAdoptionActiveRef = useRef(false)
  const sessionRef = useRef<RunningPlanReplanSession | null>(null)
  const inspectSequenceRef = useRef(0)
  const adoptionSequenceRef = useRef(0)
  const auxiliarySequenceRef = useRef(0)
  const adoptionRef = useRef<RunningPlanReplanAdoptionState>(adoption)
  const callbacksRef = useRef(options)
  useEffect(() => {
    callbacksRef.current = options
  })

  const setAdoption = useCallback((next: RunningPlanReplanAdoptionState) => {
    adoptionRef.current = next
    setAdoptionState(next)
  }, [])

  // The latest selection and re-read, for the auxiliary's runtime callbacks (which land after this render).
  const auxiliaryRuntimeChangedRef = useRef<() => void>(() => undefined)
  const auxiliary = useProductionPlanReplanPreview({
    replan: options.ordinaryReplan,
    createWorkerClient: () => callbacksRef.current.createPlannerWorkerClient(),
    onAdopted: (result) => callbacksRef.current.onAdopted(result.newPlan.id),
    // The auxiliary's adoption refused or restored the save point: the persisted state moved, so the re-optimization's result
    // the auxiliary was offered beside no longer describes it either. It is dropped (a new calculation is asked for), the
    // confirmation is read again, and the auxiliary's own notice stays.
    onRunningPlanChanged: () => auxiliaryRuntimeChangedRef.current(),
  })
  const discardAuxiliary = auxiliary.discard

  const createSession = dependencies?.createSession
  useEffect(() => {
    if (createSession === undefined) return
    const created = createSession()
    sessionRef.current = created
    const unsubscribe = created.subscribe(setSession)
    return () => {
      unsubscribe()
      if (sessionRef.current === created) sessionRef.current = null
      // Leaving the screen cancels the run (the Worker is terminated) and drops every result and adoption.
      created.dispose()
      inspectSequenceRef.current += 1
      adoptionSequenceRef.current += 1
      auxiliarySequenceRef.current += 1
      adoptionRef.current = { status: 'idle' }
      setSession(IDLE)
    }
  }, [createSession])

  const setTargetPlanId = useCallback((next: ProductionPlanId | null) => {
    targetPlanIdRef.current = next
    setTargetPlanIdState(next)
  }, [])
  const setOpenState = useCallback((next: boolean) => {
    openRef.current = next
    setOpen(next)
  }, [])

  const isAdoptionBusy = () => adoptionRef.current.status === 'inspecting' || adoptionRef.current.status === 'submitting'
  // The auxiliary's adoption checked, confirmed or being saved: closing the replan would hide what happens to it.
  const auxiliaryAdoptionActive = auxiliary.adoption.status === 'inspecting' || auxiliary.adoption.status === 'confirming'
    || auxiliary.adoption.status === 'submitting'
  useEffect(() => {
    auxiliaryAdoptionActiveRef.current = auxiliaryAdoptionActive
  })

  /** Drops the held results: the session's (cancelling a run) and the auxiliary's, and any adoption in confirmation. */
  const dropResults = useCallback(() => {
    adoptionSequenceRef.current += 1
    auxiliarySequenceRef.current += 1
    setAdoption({ status: 'idle' })
    setAuxiliaryPrepared(null)
    sessionRef.current?.discard()
    discardAuxiliary()
  }, [discardAuxiliary, setAdoption])
  const dropResultsRef = useRef(dropResults)
  useEffect(() => {
    dropResultsRef.current = dropResults
  })

  /**
   * Reads the target confirmation for `next`. With `suggested`, `next` is an initial selection the replan was opened with (a proposal's
   * Targets taken in, a warning's Target left out): when the read refuses it as `invalid_selection`, exactly the IDs the Domain names in
   * its issues are dropped - never forced, never guessed - the user is told how many, and the rest is read again (18.2).
   */
  const inspect = useCallback((next: ReplanTargetSelection, suggested = false) => {
    const inspectTargets = dependencies?.inspectTargets
    const expectedPlanId = targetPlanIdRef.current
    if (inspectTargets === undefined || expectedPlanId === null) return
    const read = (selection: ReplanTargetSelection, dropInapplicable: boolean) => {
      inspectSequenceRef.current += 1
      const sequence = inspectSequenceRef.current
      setTargets((current) => ({
        status: 'loading',
        previous: current.status === 'loaded' && current.inspection.kind === 'ready'
          ? current.inspection
          : current.status === 'loading' ? current.previous : null,
      }))
      void inspectTargets(selection, expectedPlanId).then((answer) => {
        // An older read never replaces a newer one, nor lands after the replan was closed or bound to another Plan.
        if (inspectSequenceRef.current !== sequence || targetPlanIdRef.current !== expectedPlanId) return
        const identityRefusal = answer.kind === 'ready' ? runningPlanIdentityRefusalOf(answer.start, expectedPlanId) : null
        const inspection: RunningPlanReplanPreStartInspection = identityRefusal === null ? answer : { kind: 'refused', refusal: identityRefusal }
        // Another Plan runs now: its state is never shown here, and a result held for the opened Plan is dropped with it.
        if (inspection.kind === 'refused' && inspection.refusal.kind === 'running_plan_changed') dropResultsRef.current()
        if (dropInapplicable && inspection.kind === 'refused' && inspection.refusal.kind === 'invalid_selection') {
          const { issues } = inspection.refusal
          const kept: ReplanTargetSelection = {
            excludedTargetWeaponIds: selection.excludedTargetWeaponIds.filter((id) =>
              !issues.some((issue) => issue.selection === 'exclude' && issue.targetWeaponId === id)),
            includedTargetWeaponIds: selection.includedTargetWeaponIds.filter((id) =>
              !issues.some((issue) => issue.selection === 'include' && issue.targetWeaponId === id)),
          }
          const dropped = new Set(issues.map((issue) => `${issue.selection}:${issue.targetWeaponId}`)).size
          setSelection(kept)
          setNotice({ severity: 'info', message: runningPlanReplanInitialSelectionDroppedMessage(dropped) })
          read(kept, false)
          return
        }
        setTargets({ status: 'loaded', inspection })
      })
    }
    read(next, suggested)
  }, [dependencies])

  /**
   * Opens the target confirmation of `planId`'s replan and binds the replan to that Plan. `initialSelection` is a suggestion the
   * proposal or the warning brings (Issue #276 PR-6B): it is never persisted, nothing is calculated, and an ID the current state cannot
   * apply it to is dropped rather than forced. Any result held before is dropped: it was not calculated for this selection.
   */
  const openPanel = useCallback((planId: ProductionPlanId, initialSelection: ReplanTargetSelection = emptyReplanTargetSelection) => {
    if (dependencies === null || isAdoptionBusy() || auxiliaryAdoptionActiveRef.current) return
    dropResults()
    setTargetPlanId(planId)
    setOpenState(true)
    setNotice(null)
    const next = {
      excludedTargetWeaponIds: [...initialSelection.excludedTargetWeaponIds],
      includedTargetWeaponIds: [...initialSelection.includedTargetWeaponIds],
    }
    setSelection(next)
    inspect(next, next.excludedTargetWeaponIds.length > 0 || next.includedTargetWeaponIds.length > 0)
  }, [dependencies, dropResults, inspect, setOpenState, setTargetPlanId])

  /** Closes the replan and unbinds its Plan; `notice` is what the closed entry then says (the running Plan changed). */
  const closeWith = useCallback((notice: RunningPlanReplanNotice | null): boolean => {
    if (isAdoptionBusy() || auxiliaryAdoptionActiveRef.current) return false
    dropResults()
    inspectSequenceRef.current += 1
    setTargetPlanId(null)
    setOpenState(false)
    setTargets({ status: 'closed' })
    setSelection(emptyReplanTargetSelection)
    setNotice(notice)
    return true
  }, [dropResults, setOpenState, setTargetPlanId])

  const closePanel = useCallback(() => {
    closeWith(null)
  }, [closeWith])

  const runningPlanChanged = useCallback((currentPlanId: ProductionPlanId | null) => {
    if (!openRef.current || targetPlanIdRef.current === currentPlanId) return
    closeWith({ severity: 'info', message: RUNNING_PLAN_REPLAN_PLAN_CHANGED_MESSAGE })
  }, [closeWith])

  const calculating = session.status === 'preparing' || session.status === 'running'
  const busy = calculating || adoption.status === 'inspecting' || adoption.status === 'submitting' || auxiliary.busy
    || auxiliaryAdoptionActive
  const closeDisabled = adoption.status === 'inspecting' || adoption.status === 'submitting' || auxiliaryAdoptionActive

  const changeSelection = useCallback((next: ReplanTargetSelection) => {
    // 18.7: a changed replan target set drops the result calculated for the earlier one.
    dropResults()
    setNotice(null)
    setSelection(next)
    inspect(next)
  }, [dropResults, inspect])

  const setExcluded = (targetWeaponId: TargetWeaponId, excluded: boolean) => {
    if (busy) return
    changeSelection({ ...selection, excludedTargetWeaponIds: withToggled(selection.excludedTargetWeaponIds, targetWeaponId, excluded) })
  }
  const setIncluded = (targetWeaponId: TargetWeaponId, included: boolean) => {
    if (busy) return
    changeSelection({ ...selection, includedTargetWeaponIds: withToggled(selection.includedTargetWeaponIds, targetWeaponId, included) })
  }
  const resetSelection = () => {
    if (busy) return
    changeSelection(emptyReplanTargetSelection)
  }
  const reloadTargets = useCallback(() => {
    if (open) inspect(selection)
  }, [inspect, open, selection])

  const startCalculation = () => {
    const current = sessionRef.current
    const expectedPlanId = targetPlanIdRef.current
    if (current === null || expectedPlanId === null || busy) return
    adoptionSequenceRef.current += 1
    auxiliarySequenceRef.current += 1
    setAdoption({ status: 'idle' })
    setAuxiliaryPrepared(null)
    discardAuxiliary()
    setNotice(null)
    // The start reads afresh and refuses another running Plan before any Worker starts (`running_plan_changed`).
    void current.start(selection, expectedPlanId).then((state) => {
      // A start the current state refused also changes what the confirmation shows: read it again.
      if (state.status === 'completed' && state.completion.kind === 'refused' && sessionRef.current === current) inspect(selection)
    })
  }

  const cancelCalculation = () => sessionRef.current?.cancel()

  const discardResult = () => {
    if (isAdoptionBusy() || auxiliaryAdoptionActiveRef.current) return
    dropResults()
  }

  const preview = runningPlanReplanPreviewOf(session)
  const resultStart = startOf(session)

  /** Every adoption refusal: the Preview is dropped and never adopted again, the screen re-reads, nothing re-runs by itself. */
  const refuseAdoption = useCallback((caught: unknown) => {
    const code = caught instanceof ExecutionRuntimeError
      ? caught.code
      : caught instanceof RepositoryError ? 'transaction_failed' : null
    dropResults()
    setNotice({ severity: 'error', message: runningPlanReplanAdoptionRefusalMessage(code) })
    callbacksRef.current.onPersistedStateChanged()
  }, [dropResults])

  const requestAdoption = () => {
    const adoptionDependencies = dependencies
    if (adoptionDependencies === null || preview === null || isAdoptionBusy() || calculating) return
    adoptionSequenceRef.current += 1
    const sequence = adoptionSequenceRef.current
    setAdoption({ status: 'inspecting' })
    void adoptionDependencies.inspectAdoption({ preview }).then(
      (inspection) => {
        if (adoptionSequenceRef.current === sequence) setAdoption({ status: 'confirming', inspection })
      },
      (caught: unknown) => {
        if (adoptionSequenceRef.current !== sequence) return
        refuseAdoption(caught)
        inspect(selection)
      },
    )
  }

  const cancelAdoption = () => {
    if (adoptionRef.current.status === 'confirming') setAdoption({ status: 'idle' })
  }

  const adopt = (decision: PlanAbandonSavePointDecision) => {
    const current = adoptionRef.current
    if (dependencies === null || preview === null || current.status !== 'confirming') return
    adoptionSequenceRef.current += 1
    const sequence = adoptionSequenceRef.current
    setAdoption({ status: 'submitting', inspection: current.inspection })
    void dependencies.adopt({ preview, savePointDecision: decision }).then(
      (result) => {
        if (adoptionSequenceRef.current !== sequence) return
        setAdoption({ status: 'idle' })
        if (result.kind === 'adopted') {
          dropResults()
          callbacksRef.current.onAdopted(result.newPlan.id)
          return
        }
        // Returning to the save point restored it only: nothing was adopted, and the Preview no longer describes the state.
        dropResults()
        setNotice({ severity: 'info', message: RUNNING_PLAN_REPLAN_SAVE_POINT_RESTORED_MESSAGE })
        callbacksRef.current.onPersistedStateChanged()
        inspect(selection)
      },
      (caught: unknown) => {
        if (adoptionSequenceRef.current !== sequence) return
        refuseAdoption(caught)
        inspect(selection)
      },
    )
  }

  const auxiliaryOffer = runningPlanReplanAuxiliaryOfferOf(session)

  const startAuxiliary = (plannerOptions: PlannerOptions | null) => {
    const auxiliaryDependencies = dependencies
    if (auxiliaryDependencies === null || !auxiliaryOffer.offered || busy || resultStart === null) return
    const runSelection = resultStart.selection
    // The Plan of the result the auxiliary sits in: its fresh read must find that very Plan running.
    const runningPlanId = resultStart.runningPlanToken.planId
    auxiliarySequenceRef.current += 1
    const sequence = auxiliarySequenceRef.current
    setAuxiliaryPrepared(null)
    auxiliary.startWith(runningPlanId, async (): Promise<ReplanPreviewRequestPreparation> => {
      if (plannerOptions === null) return refusalNotStarted(RUNNING_PLAN_REPLAN_AUXILIARY_OPTIONS_INVALID_MESSAGE)
      // One fresh read at the press: the auxiliary's own offer is judged again over it (18.5).
      const prepared = await auxiliaryDependencies.prepareAuxiliary(runSelection, plannerOptions, runningPlanId)
      const changed = prepared.kind === 'refused' && prepared.refusal.kind === 'running_plan_changed'
        || prepared.kind === 'ready' && prepared.request.runningPlanToken.planId !== runningPlanId
      if (changed) {
        // Another Plan runs now: no ordinary Planner runs on its Entries, and the result the auxiliary sat in is dropped too.
        if (auxiliarySequenceRef.current === sequence) planChangedRef.current()
        return refusalNotStarted(RUNNING_PLAN_REPLAN_PLAN_CHANGED_MESSAGE)
      }
      switch (prepared.kind) {
        case 'refused': {
          const refusal = presentRunningPlanReplanRefusal(prepared.refusal)
          return refusalNotStarted(`${refusal.title}。${refusal.description}`)
        }
        case 'not_offered':
          return refusalNotStarted(prepared.reason.kind === 'no_replan_target'
            ? '再計画する目標武器が無いため、登録済みの候補での再計画は開始しませんでした。'
            : '作成リストに整理が必要な項目があるため、登録済みの候補での再計画は開始しませんでした。')
        case 'planner_options_invalid':
          return refusalNotStarted(RUNNING_PLAN_REPLAN_AUXILIARY_OPTIONS_INVALID_MESSAGE)
        case 'ready':
          if (auxiliarySequenceRef.current === sequence) setAuxiliaryPrepared(prepared)
          return { kind: 'ready', request: prepared.request }
      }
    })
  }

  const auxiliaryShortfall = useMemo(() => {
    if (dependencies === null || auxiliaryPrepared === null || auxiliary.preview.status !== 'completed') return null
    return dependencies.auxiliaryShortfall(auxiliaryPrepared, auxiliary.preview.preview.result)
  }, [auxiliary.preview, auxiliaryPrepared, dependencies])

  // The auxiliary found another Plan running: the re-optimization's result is dropped and the confirmation re-read (it refuses too).
  const planChangedRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    planChangedRef.current = () => {
      adoptionSequenceRef.current += 1
      setAdoption({ status: 'idle' })
      sessionRef.current?.discard()
      if (open) inspect(selection)
    }
  })

  useEffect(() => {
    auxiliaryRuntimeChangedRef.current = () => {
      adoptionSequenceRef.current += 1
      setAdoption({ status: 'idle' })
      sessionRef.current?.discard()
      if (open) inspect(selection)
      callbacksRef.current.onPersistedStateChanged()
    }
  })

  const buildListChanged = () => {
    // An adoption being checked, confirmed or saved keeps its result (the screen's edits wait meanwhile; the adoption re-checks).
    if (isAdoptionBusy() || auxiliaryAdoptionActiveRef.current) return
    dropResults()
    if (open) inspect(selection)
  }

  return {
    available: dependencies !== null,
    open,
    targets,
    selection,
    session,
    resultStart,
    preview,
    adoption,
    notice,
    auxiliaryOffer,
    auxiliary,
    auxiliaryShortfall,
    auxiliaryBuildListEntries: auxiliaryPrepared?.request.plannerInput.buildListEntries ?? null,
    targetPlanId,
    calculating,
    busy,
    closeDisabled,
    openPanel,
    closePanel,
    runningPlanChanged,
    setExcluded,
    setIncluded,
    resetSelection,
    reloadTargets,
    startCalculation,
    cancelCalculation,
    discardResult,
    requestAdoption,
    cancelAdoption,
    adopt,
    startAuxiliary,
    buildListChanged,
    dismissNotice: () => setNotice(null),
  }
}
