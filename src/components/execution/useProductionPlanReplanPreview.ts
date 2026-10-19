import { useCallback, useEffect, useRef, useState } from 'react'
import { RepositoryError } from '../../db/repositoryError'
import {
  ExecutionRuntimeError,
  type PlanAbandonSavePointDecision,
  type ProductionPlanReplanAdoptionOptions,
  type ProductionPlanReplanPreview,
} from '../../domain/execution'
import type { ProductionPlanId } from '../../domain/models/publicTypes'
import type { PlannerOptions } from '../../domain/planner'
import type { AdoptProductionPlanReplanPreviewResult } from '../../services/execution/productionPlanExecutionService'
import type { ProductionPlanReplanDependencies } from '../../services/execution/productionPlanReplanDependencies'
import {
  PlannerCancelledError,
  type PlannerWorkerClient,
} from '../../services/planner/plannerWorkerClient'
import { executionErrorMessage } from './executionStepPresentation'

/**
 * The transient replan Preview of one running Plan (`docs/PLANNER_SPEC.md`
 * 16.8, `docs/UI_FLOW.md` 16.4). It lives in React memory only: a reload, a
 * cancel, a discard, a refusal and an adoption all drop it, and nothing of it
 * is ever persisted.
 */
export type ReplanPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; runningPlanId: ProductionPlanId }
  | { status: 'completed'; preview: ProductionPlanReplanPreview }
  | { status: 'failure'; message: string }
  /** A Preview that ended without a result to show: cancelled, refused, or superseded by a runtime change. */
  | { status: 'notice'; message: string }

/** 「この再計画を採用」, from the read-only inspection to the one runtime call. */
export type ReplanAdoptionState =
  | { status: 'idle' }
  | { status: 'inspecting' }
  | { status: 'confirming'; options: ProductionPlanReplanAdoptionOptions }
  | { status: 'submitting'; options: ProductionPlanReplanAdoptionOptions }
  | { status: 'failure'; message: string }

export type AdoptedReplanResult = Extract<AdoptProductionPlanReplanPreviewResult, { kind: 'adopted' }>

export interface UseProductionPlanReplanPreviewOptions {
  replan: ProductionPlanReplanDependencies
  /** The Preview's own Planner Worker; created on the first Preview and disposed with the caller. */
  createWorkerClient(): PlannerWorkerClient
  /** The adoption succeeded: the running Plan ended and the new Plan is `active`. */
  onAdopted(result: AdoptedReplanResult): void
  /**
   * The runtime changed or refused against the running Plan's persisted state
   * (a save point restore, a refusal, a state change), so the caller re-reads
   * what it displays. Never called for a cancel or a discard.
   */
  onRunningPlanChanged(): void
}

export interface ProductionPlanReplanPreviewController {
  preview: ReplanPreviewState
  adoption: ReplanAdoptionState
  /** A Preview is being calculated or an adoption is in flight. */
  busy: boolean
  /**
   * 「現在地点から再計画を試算」. The runtime reads the running Plan token and
   * the current-state PlannerInput; `plannerOptions` are the caller's reviewed
   * Planner bounds when the screen offers them, never a Preview-only bound.
   */
  start(runningPlanId: ProductionPlanId, plannerOptions?: PlannerOptions): void
  /** Cancels a running Preview calculation. Nothing was written, so nothing is undone. */
  cancel(): void
  /** Drops the current Preview without any runtime call. */
  discard(): void
  /** 「この再計画を採用」: the read-only inspection that decides the confirmation dialog. */
  requestAdoption(): void
  cancelAdoption(): void
  /** The confirmed adoption with the user's 16.10 decision. */
  adopt(decision: PlanAbandonSavePointDecision): void
}

export const REPLAN_PREVIEW_CANCELLED_MESSAGE =
  '再計画の試算をキャンセルしました。現在の生産計画は変更されていません。'
export const REPLAN_SAVE_POINT_RESTORED_MESSAGE =
  '最後のゲーム内セーブ地点へ戻しました。ゲーム状態が変わったため、再計画をもう一度試算してください。この試算は採用されていません。'
const PREVIEW_READ_FAILED_MESSAGE =
  '再計画の入力を読み込めませんでした。状態は変更されていません。再試行してください。'
const PREVIEW_FAILED_MESSAGE = '再計画の試算に失敗しました。現在の生産計画は変更されていません。'
const ADOPTION_STORAGE_FAILED_MESSAGE = '保存に失敗しました。状態は変更されていません。再試行してください。'
const ADOPTION_FAILED_MESSAGE = '再計画を採用できませんでした。状態は変更されていません。'

let requestSequence = 0

function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  requestSequence += 1
  return `replan-preview-${Date.now()}-${requestSequence}`
}

/** Refusals after which the shown Preview no longer describes anything adoptable. */
function previewInvalidatedBy(code: ExecutionRuntimeError['code']): boolean {
  return (
    code === 'replan_state_changed' ||
    code === 'replan_result_invalid' ||
    code === 'replan_plan_id_collision' ||
    code === 'replan_preview_not_allowed' ||
    code === 'plan_not_found' ||
    code === 'running_plan_conflict' ||
    code === 'running_plan_invariant_violated'
  )
}

/**
 * The replan Preview / adoption state machine both screens share.
 *
 * It is deliberately separate from the Production Plan page's Conflict
 * recalculation (`replanState`) and from the Build List's ordinary Planner run:
 * those save a Draft, this never saves anything but through the adoption
 * runtime. Every asynchronous step is guarded by a generation counter, so a
 * result of an earlier Preview, of a Plan the caller left, or of an unmounted
 * caller never lands.
 */
export function useProductionPlanReplanPreview(
  options: UseProductionPlanReplanPreviewOptions,
): ProductionPlanReplanPreviewController {
  const [preview, setPreviewState] = useState<ReplanPreviewState>({ status: 'idle' })
  const [adoption, setAdoptionState] = useState<ReplanAdoptionState>({ status: 'idle' })
  const previewRef = useRef<ReplanPreviewState>(preview)
  const adoptionRef = useRef<ReplanAdoptionState>(adoption)
  const generationRef = useRef(0)
  const aliveRef = useRef(false)
  const clientRef = useRef<PlannerWorkerClient | null>(null)
  const activeRequestRef = useRef<string | null>(null)
  // The latest callbacks and runtime, read when an asynchronous step lands.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const setPreview = useCallback((next: ReplanPreviewState) => {
    previewRef.current = next
    setPreviewState(next)
  }, [])
  const setAdoption = useCallback((next: ReplanAdoptionState) => {
    adoptionRef.current = next
    setAdoptionState(next)
  }, [])

  const cancelWorkerRequest = useCallback(() => {
    const requestId = activeRequestRef.current
    activeRequestRef.current = null
    if (requestId !== null) clientRef.current?.cancelPlan(requestId)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      generationRef.current += 1
      cancelWorkerRequest()
      clientRef.current?.dispose()
      clientRef.current = null
    }
  }, [cancelWorkerRequest])

  const isAdoptionBusy = () =>
    adoptionRef.current.status === 'inspecting' || adoptionRef.current.status === 'submitting'

  const start = useCallback((runningPlanId: ProductionPlanId, plannerOptions?: PlannerOptions) => {
    if (isAdoptionBusy()) return
    const generation = ++generationRef.current
    const isCurrent = () => aliveRef.current && generationRef.current === generation
    cancelWorkerRequest()
    setAdoption({ status: 'idle' })
    setPreview({ status: 'loading', runningPlanId })
    const { replan, createWorkerClient } = optionsRef.current
    void (async () => {
      try {
        // The running Plan token, the current-state PlannerInput and the
        // CalculationContext come from one read-only runtime transaction;
        // nothing the screen already holds is reused as Preview input.
        const request = await replan.prepareProductionPlanReplanPreview({ runningPlanId })
        if (!isCurrent()) return
        const input = plannerOptions === undefined
          ? request.plannerInput
          : { ...request.plannerInput, options: { ...plannerOptions } }
        const client = clientRef.current ?? createWorkerClient()
        clientRef.current = client
        const requestId = createRequestId()
        activeRequestRef.current = requestId
        // The ordinary Planner run (PLANNER_SPEC 16.8, Phase 6-A): the
        // current-state input carries no conflict resolution, so no
        // Route replacement could start. No progress callback: the
        // Preview is shown as indeterminate (UI_FLOW 10.0, Issue #103 Phase D-1).
        const result = await client.createPlan(requestId, input)
        if (!isCurrent() || activeRequestRef.current !== requestId) return
        activeRequestRef.current = null
        setPreview({ status: 'completed', preview: replan.createProductionPlanReplanPreview(request, result) })
      } catch (caught: unknown) {
        if (!isCurrent()) return
        activeRequestRef.current = null
        if (caught instanceof PlannerCancelledError) {
          setPreview({ status: 'notice', message: REPLAN_PREVIEW_CANCELLED_MESSAGE })
          return
        }
        if (caught instanceof ExecutionRuntimeError) {
          setPreview({ status: 'failure', message: executionErrorMessage(caught.code) })
          return
        }
        if (caught instanceof RepositoryError) {
          setPreview({ status: 'failure', message: PREVIEW_READ_FAILED_MESSAGE })
          return
        }
        setPreview({
          status: 'failure',
          message: caught instanceof Error ? `${PREVIEW_FAILED_MESSAGE}${caught.message}` : PREVIEW_FAILED_MESSAGE,
        })
      }
    })()
  }, [cancelWorkerRequest, setAdoption, setPreview])

  const cancel = useCallback(() => {
    if (previewRef.current.status !== 'loading') return
    generationRef.current += 1
    cancelWorkerRequest()
    setAdoption({ status: 'idle' })
    setPreview({ status: 'notice', message: REPLAN_PREVIEW_CANCELLED_MESSAGE })
  }, [cancelWorkerRequest, setAdoption, setPreview])

  const discard = useCallback(() => {
    if (isAdoptionBusy()) return
    generationRef.current += 1
    cancelWorkerRequest()
    setAdoption({ status: 'idle' })
    setPreview({ status: 'idle' })
  }, [cancelWorkerRequest, setAdoption, setPreview])

  /**
   * A runtime refusal or storage failure of the inspection or the adoption.
   * A refusal that names the Preview itself (the running Plan moved on, the
   * result cannot be adopted) drops the Preview and asks for a new one; every
   * other failure keeps the Preview and reports why.
   */
  const handleAdoptionFailure = useCallback((caught: unknown) => {
    if (caught instanceof ExecutionRuntimeError) {
      if (previewInvalidatedBy(caught.code)) {
        generationRef.current += 1
        setAdoption({ status: 'idle' })
        setPreview({ status: 'notice', message: executionErrorMessage(caught.code) })
      } else {
        setAdoption({ status: 'failure', message: executionErrorMessage(caught.code) })
      }
      optionsRef.current.onRunningPlanChanged()
      return
    }
    setAdoption({
      status: 'failure',
      message: caught instanceof RepositoryError ? ADOPTION_STORAGE_FAILED_MESSAGE : ADOPTION_FAILED_MESSAGE,
    })
  }, [setAdoption, setPreview])

  const requestAdoption = useCallback(() => {
    const current = previewRef.current
    if (current.status !== 'completed' || isAdoptionBusy()) return
    const generation = generationRef.current
    const isCurrent = () => aliveRef.current && generationRef.current === generation
    setAdoption({ status: 'inspecting' })
    void (async () => {
      try {
        // The inspection alone decides whether the 16.10 save point choice is
        // asked; nothing displayed before is used to guess it.
        const adoptionOptions = await optionsRef.current.replan.inspectProductionPlanReplanAdoption({
          preview: current.preview,
        })
        if (!isCurrent()) return
        setAdoption({ status: 'confirming', options: adoptionOptions })
      } catch (caught: unknown) {
        if (!isCurrent()) return
        handleAdoptionFailure(caught)
      }
    })()
  }, [handleAdoptionFailure, setAdoption])

  const cancelAdoption = useCallback(() => {
    if (adoptionRef.current.status === 'confirming' || adoptionRef.current.status === 'failure') {
      setAdoption({ status: 'idle' })
    }
  }, [setAdoption])

  const adopt = useCallback((decision: PlanAbandonSavePointDecision) => {
    const current = previewRef.current
    const currentAdoption = adoptionRef.current
    if (current.status !== 'completed' || currentAdoption.status !== 'confirming') return
    const generation = generationRef.current
    const isCurrent = () => aliveRef.current && generationRef.current === generation
    setAdoption({ status: 'submitting', options: currentAdoption.options })
    void (async () => {
      try {
        // One runtime call. Returning to the save point is that same call: the
        // runtime restores and adopts nothing, and the UI never calls the
        // ordinary save point restore in its place.
        const result = await optionsRef.current.replan.adoptProductionPlanReplanPreview({
          preview: current.preview,
          savePointDecision: decision,
        })
        if (!isCurrent()) return
        generationRef.current += 1
        setAdoption({ status: 'idle' })
        if (result.kind === 'adopted') {
          setPreview({ status: 'idle' })
          optionsRef.current.onAdopted(result)
          return
        }
        // `save_point_restored_repreview_required`: the Preview no longer
        // describes the persisted state and is never adopted afterwards.
        setPreview({ status: 'notice', message: REPLAN_SAVE_POINT_RESTORED_MESSAGE })
        optionsRef.current.onRunningPlanChanged()
      } catch (caught: unknown) {
        if (!isCurrent()) return
        handleAdoptionFailure(caught)
      }
    })()
  }, [handleAdoptionFailure, setAdoption, setPreview])

  return {
    preview,
    adoption,
    busy: preview.status === 'loading' || adoption.status === 'inspecting' || adoption.status === 'submitting',
    start,
    cancel,
    discard,
    requestAdoption,
    cancelAdoption,
    adopt,
  }
}
