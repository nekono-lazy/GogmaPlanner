import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  AlertTitle,
  Button,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom'
import { PageShell } from '../components/PageShell'
import {
  ProductionPlanCalculationContextDetails,
  ProductionPlanContent,
} from '../components/planner/ProductionPlanContent'
import { ProductionPlanConflictPreferenceDialog } from '../components/planner/ProductionPlanConflictPreferenceDialog'
import { ProductionPlanConflictSection } from '../components/planner/ProductionPlanConflictSection'
import {
  createProductionPlanConflictSectionDisplay,
  type ConflictNameSource,
  type ConflictSectionSource,
} from '../components/planner/productionPlanConflictPresentation'
import {
  UNRESOLVED_CONFLICT_PARTICIPANT_NAME,
  conflictPreferenceIncompleteRunMessage,
  conflictPreferenceInvalidResolutionMessage,
  conflictPreferenceNoPlanMessage,
  conflictPreferenceOutcomeMissingNotice,
  presentConflictDecisionConfirmation,
  presentConflictDecisionRefusal,
  presentConflictPreferenceSaveRefusal,
  presentPreferredEntriesIncomplete,
  type ConflictPreferenceConfirmation,
  type ConflictPreferenceEntryName,
  type ConflictPreferenceNotice,
} from '../components/planner/productionPlanConflictPreferencePresentation'
import { productionPlannerRunningTitles } from '../components/planner/productionPlannerSettingsPresentation'
import { PlanExecutionEntry, type PlanStartPreviewState } from '../components/execution/PlanExecutionEntry'
import { executionErrorMessage } from '../components/execution/executionStepPresentation'
import { ProductionPlanReplanPreviewPanel } from '../components/execution/ProductionPlanReplanPreviewPanel'
import { useProductionPlanReplanPreview } from '../components/execution/useProductionPlanReplanPreview'
import { ExecutionRuntimeError } from '../domain/execution'
import { loadMasterData } from '../domain/master/loadMasterData'
import type { MasterDataRoot } from '../domain/master/masterTypes'
import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  ProductionPlan,
  ProductionPlanId,
  TargetWeapon,
} from '../domain/models/publicTypes'
import type {
  PlannerConflictResolution,
  PlannerInput,
  PlannerResult,
} from '../domain/planner'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../domain/rng/production/productionRngEngine'
import { appDatabase } from '../db/AppDatabase'
import { buildListEntryRepository } from '../db/repositories/buildListEntryRepository'
import { productionPlanRepository } from '../db/repositories/productionPlanRepository'
import { targetWeaponRepository } from '../db/repositories/targetWeaponRepository'
import {
  createPlannerCalculationContext,
  createPlannerInput,
} from '../services/planner/createPlannerInput'
import { conflictResolutionPlannerOptions } from '../services/planner/plannerRuntimeOptions'
import {
  createProductionPlanInteractionViewModel,
  evaluateProductionPlanCalculationCompatibility,
  prepareProductionPlanConflictDecision,
  restorePersistedExplicitResolutions,
  type ProductionPlanInteractionViewModel,
} from '../services/planner/prepareProductionPlanInteraction'
import {
  createProductionPlannerWorkerClient,
  PlannerCancelledError,
  type PlannerWorkerClient,
} from '../services/planner/plannerWorkerClient'
import {
  plannerResultPersistenceService,
  type PlannerResultSaveOutcome,
} from '../services/planner/plannerResultPersistenceService'
import {
  createProductionPlanExecutionService,
  type ProductionPlanStartInspection,
} from '../services/execution/productionPlanExecutionService'
import {
  createProductionPlanReplanDependencies,
  type ProductionPlanReplanDependencies,
} from '../services/execution/productionPlanReplanDependencies'
import { useSettingsStore } from '../stores/settingsStore'
import type { PlannerInteractionPreparationResult } from '../workers/plannerWorkerContracts'

const loadedMaster = loadMasterData()
const defaultMaster = loadedMaster.ok ? loadedMaster.data : null

export interface ProductionPlanPageDependencies {
  master: MasterDataRoot
  /** Current runtime authority used before any Worker is created. */
  currentCalculationContext: CalculationContext
  getPlan(planId: ProductionPlanId): Promise<ProductionPlan | undefined>
  /**
   * Current persisted Target definitions, used only to resolve display names
   * for the read-only Plan contents. It is deliberately independent of the
   * Worker preparation lifecycle, and a failure here degrades to ID fallback
   * instead of hiding the persisted Plan.
   */
  getTargetWeapons(): Promise<TargetWeapon[]>
  /**
   * Current persisted Build List Entries, read beside the Targets only to name
   * a Conflict participant (Entry -> Target) while no current Worker
   * preparation exists - preparing, after a failure, or for a stale Plan
   * (`docs/UI_FLOW.md` 11.6.3). Never an availability or write authority.
   */
  getBuildListEntries(): Promise<BuildListEntry[]>
  createInput(calculationContext: CalculationContext): Promise<PlannerInput>
  createWorkerClient(): PlannerWorkerClient
  /**
   * Saves the ordinary Planner result of 「この候補を優先」 as the new Draft
   * (`docs/PLANNER_SPEC.md` 9.6.6): the decisions it was calculated from must
   * be honoured, recorded and every preferred Entry completed, and the current
   * Draft must still be `expectedSourceDraftId` - the displayed Draft, never an
   * ID read again at save time. The Build List is never written, so no
   * Plan-breaking approval or save point choice applies.
   */
  savePlannerConflictPreferenceResult(
    result: PlannerResult,
    context: {
      conflictResolutions: readonly PlannerConflictResolution[]
      expectedSourceDraftId: ProductionPlanId
    },
    currentCalculationContext: CalculationContext,
  ): Promise<PlannerResultSaveOutcome>
  /**
   * The read-only preview of the Target links a draft's start makes
   * (`docs/UI_FLOW.md` 11). Never write authority: the start re-verifies.
   */
  inspectProductionPlanStart(planId: ProductionPlanId): Promise<ProductionPlanStartInspection>
  /**
   * `draft -> active` and the Plan start Target links, in one Execution
   * runtime transaction (`docs/PLANNER_SPEC.md` 16.2 / 16.11).
   */
  startProductionPlan(planId: ProductionPlanId): Promise<ProductionPlan>
  /**
   * 「現在地点から再計画を試算」 / 「この再計画を採用」 of an active or stale
   * Plan (`docs/PLANNER_SPEC.md` 16.8, `docs/UI_FLOW.md` 16.4): the Preview
   * input, the transient Preview, the read-only adoption inspection and the
   * one adoption transaction. Kept apart from the Draft-only Conflict
   * recalculation above.
   */
  replan: ProductionPlanReplanDependencies
}

function createDefaultDependencies(
  master: MasterDataRoot,
): ProductionPlanPageDependencies {
  const executionService = createProductionPlanExecutionService(master)
  return {
    master,
    currentCalculationContext: createPlannerCalculationContext(
      master,
      PRODUCTION_RNG_ENGINE_VERSION,
    ),
    getPlan: (planId) => productionPlanRepository.getProductionPlan(planId),
    getTargetWeapons: () => targetWeaponRepository.getAllTargetWeapons(),
    getBuildListEntries: () => buildListEntryRepository.getAllBuildListEntries(),
    createInput: (calculationContext) =>
      createPlannerInput(master, calculationContext),
    createWorkerClient: createProductionPlannerWorkerClient,
    savePlannerConflictPreferenceResult: (result, context, currentCalculationContext) =>
      plannerResultPersistenceService.savePlannerConflictPreferenceResult(
        result,
        context,
        currentCalculationContext,
      ),
    inspectProductionPlanStart: (planId) => executionService.inspectProductionPlanStart(planId),
    startProductionPlan: (planId) => executionService.startProductionPlan(planId),
    replan: createProductionPlanReplanDependencies(master, appDatabase, executionService),
  }
}

const defaultDependencies: ProductionPlanPageDependencies | null = defaultMaster
  ? createDefaultDependencies(defaultMaster)
  : null

interface ProductionPlanPageProps {
  dependencies?: ProductionPlanPageDependencies
}

type ProductionPlanPageState =
  | { status: 'loading_plan' }
  | { status: 'not_found' }
  | {
      status: 'stale'
      plan: ProductionPlan
      reason: 'persisted_status' | 'calculation_context_changed'
    }
  | { status: 'preparing'; plan: ProductionPlan }
  | {
      status: 'ready'
      plan: ProductionPlan
      /** Presentation pairing only; every action rebuilds its own fresh input. */
      input: PlannerInput
      preparation: PlannerInteractionPreparationResult
      viewModel: ProductionPlanInteractionViewModel
    }
  | {
      status: 'error'
      message: string
      plan: ProductionPlan | null
      /** The raw internal message of an unexpected failure, shown in Debug Mode only. */
      detail?: string
    }

/**
 * 「この候補を優先」 (Issue #278, `docs/PLANNER_SPEC.md` 9.6.3 - 9.6.6,
 * `docs/UI_FLOW.md` 11.6.6): the explicit decision set, an optional
 * confirmation of the earlier decisions it drops, the ordinary `createPlan()`
 * over a fresh input, and the conflict preference save. Every state but a
 * successful save keeps the displayed Draft and the Build List as they are.
 */
type ReplanUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  /** Rule 7: the earlier decisions this press drops wait for the user's confirmation. */
  | { status: 'confirming'; confirmation: ConflictPreferenceConfirmation }
  | { status: 'saving' }
  | {
      status: 'failure'
      message: string
      /** The raw internal message of an unexpected failure, shown in Debug Mode only. */
      detail?: string
    }
  | { status: 'notice'; message: string }
  | { status: 'invalid_resolution' }
  /** A typed refusal or an incomplete preferred Entry: nothing was saved. */
  | { status: 'not_saved'; notice: ConflictPreferenceNotice }

let fallbackRequestSequence = 0

function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  fallbackRequestSequence += 1
  return `planner-interaction-${Date.now()}-${fallbackRequestSequence}`
}

/**
 * The replan runtime of a page without Master Data: it never runs, because the
 * page renders no replan control then, and it rejects rather than guesses.
 */
const unavailableReplanDependencies: ProductionPlanReplanDependencies = {
  prepareProductionPlanReplanPreview: () => Promise.reject(new Error('マスターデータを読み込めません。')),
  createProductionPlanReplanPreview: () => {
    throw new Error('マスターデータを読み込めません。')
  },
  inspectProductionPlanReplanAdoption: () => Promise.reject(new Error('マスターデータを読み込めません。')),
  adoptProductionPlanReplanPreview: () => Promise.reject(new Error('マスターデータを読み込めません。')),
}

/**
 * Names a conflict participant by its current Target (`docs/UI_FLOW.md`
 * 11.6.3): the Entry of the fresh input, then its Target's name. An Entry or a
 * Target that cannot be read is never shown by ID.
 */
function createConflictParticipantNameResolver(input: PlannerInput): ConflictPreferenceEntryName {
  const entriesById = new Map(input.buildListEntries.map((entry) => [entry.id, entry]))
  const targetsById = new Map(input.targetWeapons.map((target) => [target.id, target]))
  return (buildListEntryId) => {
    const entry = entriesById.get(buildListEntryId)
    const target = entry ? targetsById.get(entry.targetWeaponId) : undefined
    return target?.name ?? UNRESOLVED_CONFLICT_PARTICIPANT_NAME
  }
}

/**
 * What an unexpected failure says in the normal UI: a fixed Japanese sentence,
 * never the internal (often English) error text, which Debug Mode shows apart
 * (`docs/UI_FLOW.md` 11.6.4).
 */
const PREPARATION_FAILURE_MESSAGE =
  '生産計画の現在状態を確認できませんでした。画面を再読み込みしてください。'
const PLAN_LOAD_FAILURE_MESSAGE =
  '生産計画を読み込めませんでした。画面を再読み込みしてください。'
/** An unexpected failure of 「この候補を優先」 before the save (preparation or the Planner run). */
const PREFERENCE_RECALCULATION_FAILURE_MESSAGE =
  '生産計画の再計算に失敗しました。表示中の生産計画は変更していません。もう一度確認してください。'

function caughtDetail(caught: unknown): string | undefined {
  return caught instanceof Error ? caught.message : undefined
}

/** A titled, border-based page section. */
function PlanPageSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={2}>
        <Typography id={headingId} component="h2" variant="h2">
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  )
}

export function ProductionPlanPage({
  dependencies = defaultDependencies ?? undefined,
}: ProductionPlanPageProps) {
  const { planId } = useParams()
  const navigate = useNavigate()
  const debugMode = useSettingsStore((state) => state.debugMode)
  const replanHeadingId = useId()
  const savingHeadingId = useId()
  const selectionActionIdentityRef = useRef(0)
  const selectionActiveRef = useRef(false)
  const selectionSavingRef = useRef(false)
  const lifecycleIdentityRef = useRef(0)
  // Resolves the pending rule 7 confirmation of the current press; `false`
  // (cancel, a route change, an unmount) runs nothing.
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const clientRef = useRef<PlannerWorkerClient | null>(null)
  const activeWorkerRequestRef = useRef<string | null>(null)
  const [state, setState] = useState<ProductionPlanPageState>(
    dependencies
      ? { status: 'loading_plan' }
      : {
          status: 'error',
          message: 'マスターデータを読み込めません。',
          plan: null,
        },
  )
  const [targetWeapons, setTargetWeapons] = useState<readonly TargetWeapon[]>([])

  const [replanState, setReplanState] = useState<ReplanUiState>({ status: 'idle' })
  const [startState, setStartState] = useState<
    { status: 'idle' } | { status: 'starting' } | { status: 'failure'; message: string }
  >({ status: 'idle' })
  const startingRef = useRef(false)
  const [startPreview, setStartPreview] = useState<
    {
      planId: ProductionPlanId
      attempt: number
      state: Exclude<PlanStartPreviewState, { status: 'loading' }>
    } | null
  >(null)
  // 「再確認」 starts another preview read; a result of an earlier attempt never lands.
  const [startPreviewAttempt, setStartPreviewAttempt] = useState(0)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const replanBusy =
    replanState.status === 'loading' ||
    replanState.status === 'confirming' ||
    replanState.status === 'saving'
  // A runtime change against the running Plan (a save point restore, a refused
  // adoption) re-reads the exact persisted Plan through the ordinary lifecycle.
  const [planReloadSequence, setPlanReloadSequence] = useState(0)

  // The 16.8 replan Preview / adoption of an active or stale Plan. Its state
  // machine and its Planner Worker are its own: the Draft-only Conflict
  // recalculation (`replanState`) and what-if never share them.
  const executionReplan = useProductionPlanReplanPreview({
    replan: dependencies?.replan ?? unavailableReplanDependencies,
    createWorkerClient: () => {
      if (!dependencies) throw new Error('マスターデータを読み込めません。')
      return dependencies.createWorkerClient()
    },
    // The new Plan is `active` now: its Execution Navigator, never this page.
    onAdopted: (result) => void navigate(`/plans/${result.newPlan.id}/run`),
    onRunningPlanChanged: () => setPlanReloadSequence((sequence) => sequence + 1),
  })
  const discardExecutionReplan = executionReplan.discard
  // A Preview belongs to the Plan it was started from; another route Plan drops it.
  useEffect(() => () => discardExecutionReplan(), [planId, discardExecutionReplan])

  // The start preview is read only for a draft that can start: never for a
  // stale or ended Plan, and never after the start, so no future-tense link
  // change is shown for an active Plan.
  const startableDraftPlanId =
    (state.status === 'preparing' || state.status === 'ready' || (state.status === 'error' && state.plan !== null)) &&
    state.plan?.status === 'draft'
      ? state.plan.id
      : null
  useEffect(() => {
    if (!dependencies || startableDraftPlanId === null) return
    let active = true
    const attempt = startPreviewAttempt
    dependencies.inspectProductionPlanStart(startableDraftPlanId).then(
      (inspection) => {
        if (active) setStartPreview({ planId: startableDraftPlanId, attempt, state: { status: 'ready', inspection } })
      },
      () => {
        if (active) setStartPreview({ planId: startableDraftPlanId, attempt, state: { status: 'failed' } })
      },
    )
    return () => {
      active = false
    }
  }, [dependencies, startableDraftPlanId, startPreviewAttempt])
  // Only the result of the current Plan's current attempt counts; anything else
  // is still loading, and 「作成開始」 waits for it.
  const startPreviewState: PlanStartPreviewState =
    startPreview !== null &&
    startPreview.planId === startableDraftPlanId &&
    startPreview.attempt === startPreviewAttempt
      ? startPreview.state
      : { status: 'loading' }

  // Target display names load on their own, so neither a slow nor a failed
  // Target read can delay or hide the persisted Plan contents; an unresolved
  // Target simply falls back to its ID in the read-only Plan view.
  //
  // The Conflict section also names participants (Entry -> Target) from this
  // read and the current Build List while no ready preparation exists
  // (`docs/UI_FLOW.md` 11.6.3). A failed read is a state of its own there: the
  // section says it cannot confirm the names, and never shows an ID instead.
  const [persistedNames, setPersistedNames] = useState<ConflictNameSource>({ status: 'loading' })
  useEffect(() => {
    if (!dependencies) return
    let active = true
    queueMicrotask(() => {
      if (active) setPersistedNames({ status: 'loading' })
    })
    const targets = dependencies.getTargetWeapons()
    void targets
      .then((weapons) => {
        if (active) setTargetWeapons(weapons)
      })
      .catch(() => {
        if (active) setTargetWeapons([])
      })
    void Promise.all([dependencies.getBuildListEntries(), targets])
      .then(([buildListEntries, weapons]) => {
        if (active) setPersistedNames({ status: 'loaded', buildListEntries, targetWeapons: weapons })
      })
      .catch(() => {
        if (active) setPersistedNames({ status: 'failed' })
      })
    return () => {
      active = false
    }
  }, [dependencies, planId])

  useEffect(() => {
    const lifecycleIdentity = lifecycleIdentityRef.current + 1
    lifecycleIdentityRef.current = lifecycleIdentity
    let active = true
    let client: PlannerWorkerClient | null = null
    const isCurrent = () =>
      active && lifecycleIdentityRef.current === lifecycleIdentity
    const setCurrentState = (nextState: ProductionPlanPageState) => {
      queueMicrotask(() => {
        if (isCurrent()) setState(nextState)
      })
    }

    if (!dependencies) {
      setCurrentState({
        status: 'error',
        message: 'マスターデータを読み込めません。',
        plan: null,
      })
      return () => {
        active = false
      }
    }
    if (!planId) {
      setCurrentState({ status: 'not_found' })
      return () => {
        active = false
      }
    }

    setCurrentState({ status: 'loading_plan' })
    queueMicrotask(() => {
      if (!isCurrent()) return
      setReplanState({ status: 'idle' })
      setStartState({ status: 'idle' })
    })

    const run = async () => {
      let loadedPlan: ProductionPlan | null = null
      try {
        // The exact persisted Plan is loaded first and unconditionally, so no
        // Worker concern can keep its read-only contents off the page.
        const plan = await dependencies.getPlan(planId as ProductionPlanId)
        if (!isCurrent()) return
        if (!plan) {
          setState({ status: 'not_found' })
          return
        }
        loadedPlan = plan
        // A stale Plan runs no what-if or Conflict action, so it needs no
        // Worker Client at all.
        if (plan.status === 'stale') {
          setState({ status: 'stale', plan, reason: 'persisted_status' })
          return
        }
        const compatibility = evaluateProductionPlanCalculationCompatibility(
          plan,
          dependencies.currentCalculationContext,
        )
        if (!compatibility.isCompatible) {
          setState({
            status: 'stale',
            plan,
            reason: compatibility.recalculationReasons[0],
          })
          return
        }
        setState({ status: 'preparing', plan })

        // Created only here: a failure now falls into the catch below, which
        // keeps `loadedPlan` on the error state instead of discarding it.
        const preparationClient = dependencies.createWorkerClient()
        client = preparationClient
        clientRef.current = preparationClient

        const calculationContext = createPlannerCalculationContext(
          dependencies.master,
          preparationClient.engineVersion,
        )
        const freshInput = await dependencies.createInput(calculationContext)
        if (!isCurrent()) return
        const input = restorePersistedExplicitResolutions(freshInput, plan)
        const requestId = createRequestId()
        activeWorkerRequestRef.current = requestId
        const preparation = await preparationClient.prepareInteraction(requestId, input)
        if (!isCurrent() || activeWorkerRequestRef.current !== requestId) return
        activeWorkerRequestRef.current = null
        setState({
          status: 'ready',
          plan,
          input,
          preparation,
          viewModel: createProductionPlanInteractionViewModel(
            plan,
            input,
            preparation,
          ),
        })
      } catch (caught: unknown) {
        if (!isCurrent() || caught instanceof PlannerCancelledError) return
        activeWorkerRequestRef.current = null
        setState({
          status: 'error',
          message: loadedPlan === null ? PLAN_LOAD_FAILURE_MESSAGE : PREPARATION_FAILURE_MESSAGE,
          plan: loadedPlan,
          detail: caughtDetail(caught),
        })
      }
    }
    void run()

    return () => {
      active = false
      selectionActionIdentityRef.current += 1
      selectionActiveRef.current = false
      selectionSavingRef.current = false
      const resolveConfirmation = confirmationResolverRef.current
      confirmationResolverRef.current = null
      resolveConfirmation?.(false)
      const activeRequestId = activeWorkerRequestRef.current
      activeWorkerRequestRef.current = null
      // `client` stays null when this lifecycle never reached Worker creation:
      // a stale Plan, a missing Plan, or a Plan load abandoned before it
      // resolved. There is then nothing to cancel or dispose.
      if (client !== null) {
        if (activeRequestId !== null) client.cancelPlan(activeRequestId)
        client.dispose()
        if (clientRef.current === client) clientRef.current = null
      }
    }
  }, [dependencies, planId, planReloadSequence])

  /**
   * 「この候補を優先」 (Issue #278, `docs/PLANNER_SPEC.md` 9.6.3 - 9.6.6,
   * `docs/UI_FLOW.md` 11.6.6). It re-reads the current persisted state into a
   * fresh input and preparation, builds the explicit decision set through the
   * one Domain authority, asks the user to confirm when an earlier decision is
   * dropped, runs the ordinary `createPlan()` - never a Planner Alternative
   * search, generated Entry, replacement or repair lineage - and saves only a
   * result whose every preferred Entry is completed. Nothing else is written.
   */
  const startPreferring = async (
    conflictId: string,
    buildListEntryId: BuildListEntryId,
  ) => {
    if (!dependencies || state.status !== 'ready' || selectionActiveRef.current) return
    const displayedPlan = state.plan
    const participant = state.viewModel.conflicts
      .find(({ id }) => id === conflictId)
      ?.participants.find((entry) => entry.buildListEntryId === buildListEntryId)
    const client = clientRef.current
    if (!client || !participant?.isAvailable) return

    const previousRequestId = activeWorkerRequestRef.current
    activeWorkerRequestRef.current = null
    if (previousRequestId !== null) client.cancelPlan(previousRequestId)

    const actionIdentity = ++selectionActionIdentityRef.current
    const lifecycleIdentity = lifecycleIdentityRef.current
    selectionActiveRef.current = true
    const isCurrentAction = () =>
      selectionActionIdentityRef.current === actionIdentity &&
      lifecycleIdentityRef.current === lifecycleIdentity &&
      clientRef.current === client
    setReplanState({ status: 'loading' })

    try {
      const calculationContext = createPlannerCalculationContext(
        dependencies.master,
        client.engineVersion,
      )
      const freshInput = await dependencies.createInput(calculationContext)
      if (!isCurrentAction()) return
      const plannerInput = restorePersistedExplicitResolutions(freshInput, displayedPlan)
      const preparationRequestId = createRequestId()
      activeWorkerRequestRef.current = preparationRequestId
      const preparation = await client.prepareInteraction(preparationRequestId, plannerInput)
      if (!isCurrentAction() || activeWorkerRequestRef.current !== preparationRequestId) return
      activeWorkerRequestRef.current = null
      const viewModel = createProductionPlanInteractionViewModel(
        displayedPlan,
        plannerInput,
        preparation,
      )
      setState({ status: 'ready', plan: displayedPlan, input: plannerInput, preparation, viewModel })
      const currentParticipant = viewModel.conflicts
        .find(({ id }) => id === conflictId)
        ?.participants.find((entry) => entry.buildListEntryId === buildListEntryId)
      if (preparation.status === 'invalid' || !currentParticipant?.isAvailable) {
        setReplanState({
          status: 'notice',
          message: '現在の状態が変化したため、この候補を優先できませんでした。',
        })
        return
      }

      const nameOf = createConflictParticipantNameResolver(plannerInput)
      const decisionSet = prepareProductionPlanConflictDecision(
        displayedPlan,
        plannerInput,
        preparation,
        { conflictKey: conflictId, selectedBuildListEntryId: buildListEntryId },
      )
      if (decisionSet === null) return
      if (decisionSet.status === 'refused') {
        setReplanState({
          status: 'not_saved',
          notice: presentConflictDecisionRefusal(decisionSet.refusal, nameOf),
        })
        return
      }
      if (decisionSet.requiresConfirmation) {
        const confirmed = await new Promise<boolean>((resolve) => {
          confirmationResolverRef.current = resolve
          setReplanState({
            status: 'confirming',
            confirmation: presentConflictDecisionConfirmation(decisionSet, nameOf),
          })
        })
        if (!isCurrentAction()) return
        if (!confirmed) {
          setReplanState({ status: 'idle' })
          return
        }
        setReplanState({ status: 'loading' })
      }

      // The ordinary Planner over the fresh input and the decision set alone
      // (9.6.4). The Application caller is the Planner bound authority (7.2.1):
      // the bound comes from the Plan this page shows, never from the Build
      // List page's temporary input (Issue #130).
      const conflictResolutions = decisionSet.resolutions
      const runInput: PlannerInput = {
        ...freshInput,
        conflictResolutions: conflictResolutions.map((resolution) => ({ ...resolution })),
        options: conflictResolutionPlannerOptions(displayedPlan),
      }
      const requestId = createRequestId()
      activeWorkerRequestRef.current = requestId
      const result = await client.createPlan(requestId, runInput)
      if (!isCurrentAction() || activeWorkerRequestRef.current !== requestId) return
      activeWorkerRequestRef.current = null

      // Every branch below is decided by a typed field, never a message.
      if (result.termination.status === 'incomplete') {
        setReplanState({
          status: 'failure',
          message: conflictPreferenceIncompleteRunMessage(result.termination.limits.maxPlanSteps),
        })
        return
      }
      if (result.warnings.some(({ kind }) => kind === 'invalid_conflict_resolution')) {
        // A Plan that could not honour an explicit decision is never saved,
        // and no other participant or the Planner recommendation is tried.
        setReplanState({ status: 'invalid_resolution' })
        return
      }
      if (result.plan === null) {
        setReplanState({ status: 'notice', message: conflictPreferenceNoPlanMessage })
        return
      }
      const outcome = result.conflictResolutionOutcome
      if (outcome === undefined) {
        setReplanState({ status: 'not_saved', notice: conflictPreferenceOutcomeMissingNotice })
        return
      }
      if (!outcome.allPreferredEntriesCompleted) {
        setReplanState({ status: 'not_saved', notice: presentPreferredEntriesIncomplete(outcome, nameOf) })
        return
      }

      if (!isCurrentAction()) return
      selectionSavingRef.current = true
      setReplanState({ status: 'saving' })
      try {
        // Persistence re-checks every condition inside its one transaction,
        // the displayed Draft as the source authority included (9.6.6).
        const saved = await dependencies.savePlannerConflictPreferenceResult(
          result,
          { conflictResolutions, expectedSourceDraftId: displayedPlan.id },
          createPlannerCalculationContext(dependencies.master, client.engineVersion),
        )
        if (!isCurrentAction()) return
        if (saved.kind === 'no_plan') {
          setReplanState({ status: 'notice', message: conflictPreferenceNoPlanMessage })
          return
        }
        setReplanState({ status: 'idle' })
        void navigate(`/plans/${saved.plan.id}`)
      } catch (caught: unknown) {
        if (!isCurrentAction()) return
        setReplanState({
          status: 'failure',
          message: presentConflictPreferenceSaveRefusal(caught),
          detail: caughtDetail(caught),
        })
      }
    } catch (caught: unknown) {
      if (!isCurrentAction()) return
      // A fixed Japanese sentence; the internal (often English) error text is
      // Debug Mode only (`docs/UI_FLOW.md` 11.6.4).
      setReplanState(caught instanceof PlannerCancelledError
        ? { status: 'idle' }
        : {
            status: 'failure',
            message: PREFERENCE_RECALCULATION_FAILURE_MESSAGE,
            detail: caughtDetail(caught),
          })
    } finally {
      if (isCurrentAction()) {
        activeWorkerRequestRef.current = null
        selectionActiveRef.current = false
        selectionSavingRef.current = false
        confirmationResolverRef.current = null
      }
    }
  }

  const resolveConfirmation = (confirmed: boolean) => {
    const resolve = confirmationResolverRef.current
    confirmationResolverRef.current = null
    resolve?.(confirmed)
  }

  const cancelReplanning = () => {
    // Atomic persistence cannot be cancelled, including before the next render.
    if (selectionSavingRef.current) return
    selectionActionIdentityRef.current += 1
    selectionActiveRef.current = false
    const requestId = activeWorkerRequestRef.current
    activeWorkerRequestRef.current = null
    if (requestId !== null) clientRef.current?.cancelPlan(requestId)
    setReplanState({ status: 'idle' })
  }

  /**
   * 「作成開始」: the runtime alone moves the Plan to `active`; the page only
   * navigates once it did, and never for a Plan the route has left.
   */
  const startPlan = async (plan: ProductionPlan) => {
    if (!dependencies || startingRef.current) return
    startingRef.current = true
    const lifecycleIdentity = lifecycleIdentityRef.current
    const isCurrent = () => mountedRef.current && lifecycleIdentityRef.current === lifecycleIdentity
    setStartState({ status: 'starting' })
    try {
      const started = await dependencies.startProductionPlan(plan.id)
      if (!isCurrent()) return
      setStartState({ status: 'idle' })
      navigate(`/plans/${started.id}/run`)
    } catch (caught: unknown) {
      if (!isCurrent()) return
      setStartState({
        status: 'failure',
        message:
          caught instanceof ExecutionRuntimeError
            ? caught.code === 'execution_state_mismatch' || caught.code === 'plan_dependency_changed'
              ? `${executionErrorMessage(caught.code)}生産計画は開始していません。ビルドリストから再計算してください。`
              : executionErrorMessage(caught.code)
            : '生産計画を開始できませんでした。状態は変更されていません。',
      })
    } finally {
      startingRef.current = false
    }
  }

  const loadedPlan =
    state.status === 'preparing' || state.status === 'ready' || state.status === 'stale'
      ? state.plan
      : state.status === 'error'
        ? state.plan
        : null

  // Persisted `ProductionPlan.conflicts` is the Conflict display authority in
  // every state that holds the exact persisted Plan (UI_FLOW 11.0): the list
  // never disappears because the Worker preparation is still running or has
  // failed. Only `ready` carries the current preparation, which is the sole
  // authority for whether a participant can be preferred; every other state
  // shows the persisted decisions read-only (UI_FLOW 11.6).
  const conflictSource: ConflictSectionSource | null =
    state.status === 'ready'
      ? { status: 'ready', viewModel: state.viewModel, preparation: state.preparation }
      : state.status === 'preparing'
        ? { status: 'preparing' }
        : state.status === 'error' && state.plan !== null
          ? { status: 'preparation_failed' }
          : state.status === 'stale'
            ? { status: 'stale' }
            : null
  // A ready preparation names participants from its own fresh input - the
  // state its availability was judged on; every other state from the page's
  // independent read of the current Build List and Targets.
  const conflictNames: ConflictNameSource =
    state.status === 'ready'
      ? { status: 'loaded', buildListEntries: state.input.buildListEntries, targetWeapons: state.input.targetWeapons }
      : persistedNames
  const conflictDisplay =
    dependencies && loadedPlan && conflictSource !== null
      ? createProductionPlanConflictSectionDisplay({
          plan: loadedPlan,
          source: conflictSource,
          names: conflictNames,
          master: dependencies.master,
        })
      : null
  const debugPreparationMessages =
    state.status === 'ready' && state.preparation.status === 'invalid'
      ? [
          ...state.preparation.issues.map(({ path, message }) => `${path}: ${message}`),
          ...state.preparation.warnings.map(({ kind, message }) => `${kind}: ${message}`),
        ]
      : []

  // The page's own running / saving / result notices of 「この候補を優先」,
  // placed at the top of the Conflict section.
  const preferenceStatus = state.status === 'ready' && (
    <>
      {replanState.status === 'loading' && (
        <Paper
          component="section"
          variant="outlined"
          role="status"
          aria-live="polite"
          aria-labelledby={replanHeadingId}
          sx={{ p: { xs: 1.5, md: 2 } }}
        >
          <Stack spacing={1.5}>
            <Typography id={replanHeadingId} component="h3" variant="h3">
              {productionPlannerRunningTitles.recalculation}
            </Typography>
            <LinearProgress aria-label="Planner再計算中" variant="indeterminate" />
            <Button
              variant="outlined"
              onClick={cancelReplanning}
              sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
            >
              再計算をキャンセル
            </Button>
          </Stack>
        </Paper>
      )}
      {replanState.status === 'saving' && (
        // Atomic persistence has started: no cancel is offered.
        <Paper
          component="section"
          variant="outlined"
          role="status"
          aria-live="polite"
          aria-labelledby={savingHeadingId}
          sx={{ p: { xs: 1.5, md: 2 } }}
        >
          <Stack spacing={1.5}>
            <Typography id={savingHeadingId} component="h3" variant="h3">
              生産計画を保存しています。
            </Typography>
            <LinearProgress aria-label="生産計画を保存中" />
            <Typography variant="caption" color="text.secondary">
              保存中はキャンセルできません。
            </Typography>
          </Stack>
        </Paper>
      )}
      {replanState.status === 'failure' && (
        <Alert severity="error">
          {replanState.message}
          {debugMode && replanState.detail !== undefined && (
            <Typography
              component="span"
              variant="caption"
              sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere', fontFamily: 'monospace' }}
            >
              {replanState.detail}
            </Typography>
          )}
        </Alert>
      )}
      {replanState.status === 'notice' && <Alert severity="info">{replanState.message}</Alert>}
      {replanState.status === 'invalid_resolution' && (
        <Alert severity="warning">{conflictPreferenceInvalidResolutionMessage}</Alert>
      )}
      {replanState.status === 'not_saved' && (
        <Alert severity="warning">
          <AlertTitle>{replanState.notice.title}</AlertTitle>
          <Stack spacing={0.5}>
            {replanState.notice.messages.map((message) => (
              <Typography key={message} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {message}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}
    </>
  )

  // The Worker preparation indicator and the Conflict section. The page keeps
  // building and owning them - every preparation / preference state and
  // handler stays here - and only hands the node to the read-only Plan view,
  // which places it after the material sections and before the Target routes
  // (UI_FLOW 11.0, Issue #121). Presentation order only.
  const conflictSection = (
    <>
      {state.status === 'preparing' && (
        <Stack spacing={1} role="status" aria-live="polite">
          <LinearProgress aria-label="現在のPlanner入力を準備中" />
          <Typography variant="body2">現在の保存状態から操作可否を確認しています。</Typography>
        </Stack>
      )}

      {conflictDisplay !== null && (
        <PlanPageSection title="競合と解決">
          <ProductionPlanConflictSection
            display={conflictDisplay}
            debugMode={debugMode}
            busy={replanBusy}
            onPrefer={(conflictId, buildListEntryId) =>
              void startPreferring(conflictId, buildListEntryId as BuildListEntryId)}
            statusSlot={preferenceStatus}
            debugPreparationMessages={debugPreparationMessages}
          />
        </PlanPageSection>
      )}
    </>
  )

  return (
    <PageShell
      title="生産計画"
      description={`生産計画（${loadedPlan?.id ?? planId ?? '未指定'}）の全体を確認します。`}
      actions={
        // Presentation only: the list is a separate read-only screen, and
        // this link takes no part in the Plan display / what-if / start /
        // replan state machine below.
        <Button component={RouterLink} to="/plans" variant="outlined" sx={{ minHeight: 44 }}>
          生産計画一覧へ
        </Button>
      }
    >
      <Stack spacing={{ xs: 2, md: 3 }}>
        {state.status === 'loading_plan' && (
          <Stack spacing={1} role="status" aria-live="polite">
            <LinearProgress aria-label="生産計画を読み込み中" />
            <Typography variant="body2">生産計画を読み込んでいます。</Typography>
          </Stack>
        )}
        {state.status === 'not_found' && (
          <Alert severity="warning">指定された生産計画が見つかりません。</Alert>
        )}
        {state.status === 'error' && (
          <Alert severity="error">
            {state.message}
            {debugMode && state.detail !== undefined && (
              <Typography
                component="span"
                variant="caption"
                sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere', fontFamily: 'monospace' }}
              >
                {state.detail}
              </Typography>
            )}
          </Alert>
        )}
        {state.status === 'stale' && (
          // The link sits inside the message instead of in the Alert action
          // slot, so at 375px it wraps under the text with a full-height
          // touch target rather than squeezing the message beside it.
          <Alert severity="warning">
            <AlertTitle>再計算が必要な生産計画です</AlertTitle>
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2">
                {state.reason === 'calculation_context_changed'
                  ? 'この生産計画は現在の計算契約と互換性がありません。ビルドリストから再計算してください。'
                  : 'この生産計画は現在の状態と一致しません。ビルドリストから再計算してください。'}
              </Typography>
              <Button
                component={RouterLink}
                to="/build-list"
                variant="outlined"
                color="inherit"
                sx={{ minHeight: 44 }}
              >
                ビルドリストへ戻る
              </Button>
            </Stack>
          </Alert>
        )}
        {loadedPlan && state.status !== 'stale' && (
          <PlanExecutionEntry
            plan={loadedPlan}
            starting={startState.status === 'starting'}
            startError={startState.status === 'failure' ? startState.message : null}
            startPreview={startPreviewState}
            onRetryStartPreview={() => setStartPreviewAttempt((attempt) => attempt + 1)}
            onStart={() => void startPlan(loadedPlan)}
          />
        )}
        {/* 16.8: only a running (active / stale) Plan can be replanned from the
            current state. A draft keeps its ordinary start / recalculation, and
            an ended Plan offers nothing. The runtime decides every refusal. */}
        {dependencies && loadedPlan && (loadedPlan.status === 'active' || loadedPlan.status === 'stale') && (
          <PlanPageSection title="現在地点からの再計画">
            <ProductionPlanReplanPreviewPanel
              controller={executionReplan}
              runningPlan={loadedPlan}
              targetWeapons={targetWeapons}
              master={dependencies.master}
              debugMode={debugMode}
              onStart={() => executionReplan.start(loadedPlan.id)}
            />
          </PlanPageSection>
        )}
        {/* Read-only Plan contents come straight from the exact persisted Plan,
            so they render as soon as it is loaded - while the Worker
            preparation is still running, after it failed, and for a stale Plan
            whose Conflict controls stay disabled. */}
        {dependencies && loadedPlan ? (
          <ProductionPlanContent
            plan={loadedPlan}
            targetWeapons={targetWeapons}
            master={dependencies.master}
            debugMode={debugMode}
            conflictSection={conflictSection}
            // The overview's provisional wording only: a draft whose
            // CalculationContext is compatible can still have a participant
            // preferred (UI_FLOW 11.0).
            conflictPreferenceAvailable={
              loadedPlan.status === 'draft' &&
              evaluateProductionPlanCalculationCompatibility(loadedPlan, dependencies.currentCalculationContext).isCompatible
            }
          />
        ) : (
          conflictSection
        )}

        {debugMode && dependencies && loadedPlan && (
          <ProductionPlanCalculationContextDetails
            plan={loadedPlan}
            current={dependencies.currentCalculationContext}
          />
        )}
      </Stack>
      <ProductionPlanConflictPreferenceDialog
        confirmation={replanState.status === 'confirming' ? replanState.confirmation : null}
        onCancel={() => resolveConfirmation(false)}
        onConfirm={() => resolveConfirmation(true)}
      />
    </PageShell>
  )
}
