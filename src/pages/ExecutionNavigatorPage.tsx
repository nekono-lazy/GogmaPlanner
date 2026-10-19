import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Divider,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import { Link as RouterLink, useParams } from 'react-router-dom'
import { PageShell } from '../components/PageShell'
import { ActualResultDifferentForm } from '../components/execution/ActualResultDifferentForm'
import { emptyActualResultDraft, type ActualResultDraft } from '../components/execution/actualResultDraft'
import { BlindObservationForm } from '../components/execution/BlindObservationForm'
import { CompromiseCheckpointPanel } from '../components/execution/CompromiseCheckpointPanel'
import { ExecutionDivergenceRecovery } from '../components/execution/ExecutionDivergenceRecovery'
import { ExecutionProgress } from '../components/execution/ExecutionProgress'
import { ExecutionStateControls } from '../components/execution/ExecutionStateControls'
import { ExecutionStepCard } from '../components/execution/ExecutionStepCard'
import {
  actualResultInputKind,
  createExecutionProgress,
  createExecutionStepPresentation,
  executionDivergenceView,
  executionErrorMessage,
  isRecalculationRequiredError,
  offersOperationUncertain,
  ownedWeaponLabel,
  targetWeaponLabel,
  weaponSwitchTarget,
  type ExecutionDivergenceView,
  type ExecutionStepPresentation,
} from '../components/execution/executionStepPresentation'
import { PlanStepDebugDetails } from '../components/debug/PlanStepDebugDetails'
import { OperationUncertainDialog } from '../components/execution/OperationUncertainDialog'
import { OperationUncertainRecovery } from '../components/execution/OperationUncertainRecovery'
import { WeaponSwitchPrompt } from '../components/execution/WeaponSwitchPrompt'
import { RepositoryError } from '../db/repositoryError'
import {
  ExecutionRuntimeError,
  listCurrentCompromiseCheckpoints,
  type CurrentCompromiseCheckpoint,
  type ExecutionActualResultObservation,
  type ExecutionNormalRestorationBonusObservation,
  type ExecutionReidentificationReminder,
  type OperationCountRecoveryObservation,
  type ReidentificationDestination,
  type ExecutionRuntimeErrorCode,
  type PlanAbandonSavePointDecision,
  type ProductionPlanAbandonmentOptions,
} from '../domain/execution'
import { loadMasterData } from '../domain/master/loadMasterData'
import type {
  BuildListEntryId,
  ExecutionHistory,
  PlanStep,
  PlanStepId,
  ProductionPlan,
  ProductionPlanId,
} from '../domain/models/publicTypes'
import { productionPlanAbandonmentReasonLabels } from '../presentation/labels'
import {
  createExecutionNavigatorDependencies,
  type ExecutionNavigatorPageDependencies,
  type ExecutionNavigatorSnapshot,
} from '../services/execution/executionNavigatorDependencies'
import type { ConfirmExpectedPlanStepRequest } from '../services/execution/productionPlanExecutionService'
import { evaluateProductionPlanCalculationCompatibility } from '../services/planner/prepareProductionPlanInteraction'
import { useSettingsStore } from '../stores/settingsStore'

const loadedMaster = loadMasterData()
// Created once for the application database; tests inject their own.
const defaultDependencies: ExecutionNavigatorPageDependencies | null = loadedMaster.ok
  ? createExecutionNavigatorDependencies(loadedMaster.data)
  : null

type LoadState =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; snapshot: ExecutionNavigatorSnapshot }

type ActionState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'failed'; code: ExecutionRuntimeErrorCode | null; message: string }

function failureFrom(caught: unknown): Extract<ActionState, { status: 'failed' }> {
  if (caught instanceof ExecutionRuntimeError) {
    return { status: 'failed', code: caught.code, message: executionErrorMessage(caught.code) }
  }
  if (caught instanceof RepositoryError) {
    return {
      status: 'failed',
      code: null,
      message: '保存に失敗しました。状態は変更されていません。もう一度お試しください。',
    }
  }
  return { status: 'failed', code: null, message: '操作を確定できませんでした。状態は変更されていません。' }
}

const buttonSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const
const primarySx = { minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } } as const

function NavigationLinks({ links }: { links: { label: string; to: string }[] }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {links.map(({ label, to }) => (
        <Button key={to} component={RouterLink} to={to} variant="outlined" color="inherit" sx={buttonSx}>
          {label}
        </Button>
      ))}
    </Stack>
  )
}

/** A Plan that no longer runs: what happened and where to go next. */
function EndedPlanView({
  plan,
  divergence,
  latestExecutionHistory,
  reidentificationReminder,
}: {
  plan: ProductionPlan
  /** The `actual_result_different` record that stopped a stale Plan, from its latest ExecutionHistory. */
  divergence: Extract<ExecutionDivergenceView, { action: 'actual_result_different' }> | null
  latestExecutionHistory: ExecutionHistory | null
  /** The 16.15 reminder derived from the persisted records, the RngState and the Normal Counters. */
  reidentificationReminder: ExecutionReidentificationReminder
}) {
  const planLink = { label: '作成プランを見る', to: `/plans/${plan.id}` }
  if (plan.status === 'completed') {
    return (
      <Alert severity="success">
        <AlertTitle>生産計画が完了しました</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">すべての作成手順を確定しました。</Typography>
          <NavigationLinks
            links={[
              { label: '所持武器を見る', to: '/owned-weapons' },
              { label: '目標武器を見る', to: '/target-weapons' },
              planLink,
            ]}
          />
        </Stack>
      </Alert>
    )
  }
  if (plan.status === 'abandoned' && plan.abandonmentReason === 'finished_as_compromise') {
    return (
      <Alert severity="info">
        <AlertTitle>妥協品として現在の生産計画を終了しました</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            残りの作成手順は実行されません。未完了の目標武器は、現在の状態から再計画できます。
          </Typography>
          <NavigationLinks
            links={[
              { label: 'ビルドリストへ', to: '/build-list' },
              { label: '目標武器へ', to: '/target-weapons' },
              planLink,
            ]}
          />
        </Stack>
      </Alert>
    )
  }
  if (
    plan.status === 'abandoned' &&
    plan.abandonmentReason === 'user_abandoned' &&
    latestExecutionHistory?.action === 'operation_uncertain'
  ) {
    // Abandoned from the operation_uncertain recovery (16.15): the Plan has
    // ended, so the ordinary Identification is the way back now.
    return (
      <Alert severity="info">
        <AlertTitle>作成プランを破棄しました</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            現在のゲーム状態に合わせて、RNG状態・通常アーティアCounter・所持武器を確認・再登録してから再計画してください。
          </Typography>
          <NavigationLinks
            links={[
              { label: 'RNG状態設定へ', to: '/rng' },
              { label: '通常アーティアCounterへ', to: '/normal-counters' },
              { label: '所持武器を確認する', to: '/owned-weapons' },
              { label: 'ビルドリストへ', to: '/build-list' },
            ]}
          />
        </Stack>
      </Alert>
    )
  }
  if (
    plan.status === 'abandoned' &&
    plan.abandonmentReason === 'user_abandoned' &&
    reidentificationReminder.kind === 'actual_result_different'
  ) {
    // Abandoning resolves no divergence (16.15): the prediction still differs
    // from the game until the diverged stream is formally re-identified after
    // the record. The wording and the link follow the destination the shared
    // authority derived; nothing is re-read from the Step here.
    const destinations = [...new Set(reidentificationReminder.unresolved.map(({ destination }) => destination))]
    const subject = (destination: ReidentificationDestination) =>
      destination === 'normal_counters' ? '通常アーティアCounter' : 'RNG状態'
    return (
      <Alert severity="warning">
        <AlertTitle>作成プランを破棄しました</AlertTitle>
        <Stack spacing={1.5}>
          {destinations.map((destination) => (
            <Stack key={destination} spacing={0.5}>
              <Typography variant="body2">
                予測と異なる結果が記録された後、{subject(destination)}の再特定がまだ完了していません。
              </Typography>
              <Typography variant="body2">
                現在のゲーム状態に合わせて{subject(destination)}を特定し直してから、候補検索・再計画を行ってください。
              </Typography>
            </Stack>
          ))}
          <NavigationLinks
            links={[
              ...destinations.map((destination) =>
                destination === 'normal_counters'
                  ? { label: '通常アーティアCounterへ', to: '/normal-counters' }
                  : { label: 'RNG状態設定へ', to: '/rng' }),
              { label: 'ビルドリストへ', to: '/build-list' },
              planLink,
            ]}
          />
        </Stack>
      </Alert>
    )
  }
  if (plan.status === 'abandoned' && plan.abandonmentReason === 'user_abandoned') {
    // The ordinary 「現在Planを破棄する」 (16.2): no divergence is implied, so no
    // RNG re-identification is asked for.
    return (
      <Alert severity="info">
        <AlertTitle>作成プランを破棄しました</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">現在状態から必要に応じて再計画できます。</Typography>
          <NavigationLinks
            links={[
              { label: 'ビルドリストへ', to: '/build-list' },
              { label: '目標武器へ', to: '/target-weapons' },
              planLink,
            ]}
          />
        </Stack>
      </Alert>
    )
  }
  if (plan.status === 'abandoned') {
    return (
      <Alert severity="info">
        <AlertTitle>この生産計画は終了しています</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            終了理由:{' '}
            {plan.abandonmentReason === null
              ? '記録なし'
              : productionPlanAbandonmentReasonLabels[plan.abandonmentReason]}
          </Typography>
          <NavigationLinks links={[planLink]} />
        </Stack>
      </Alert>
    )
  }
  if (plan.status === 'stale' && divergence !== null) {
    return <ExecutionDivergenceRecovery divergence={divergence} planId={plan.id} />
  }
  if (plan.status === 'stale') {
    return (
      <Alert severity="warning">
        <AlertTitle>この計画は再計算が必要です</AlertTitle>
        <Stack spacing={1.5}>
          <Typography variant="body2">
            予測と現在の状態が一致しないため、この生産計画の操作は続行できません。
          </Typography>
          <NavigationLinks links={[planLink, { label: 'ビルドリストへ', to: '/build-list' }]} />
        </Stack>
      </Alert>
    )
  }
  // draft
  return (
    <Alert severity="info">
      <AlertTitle>この生産計画はまだ開始されていません</AlertTitle>
      <Stack spacing={1.5}>
        <Typography variant="body2">作成プラン画面の「作成開始」から開始してください。</Typography>
        <NavigationLinks links={[planLink]} />
      </Stack>
    </Alert>
  )
}

function ExecutionNavigator({
  planId,
  dependencies,
}: {
  planId: ProductionPlanId
  dependencies: ExecutionNavigatorPageDependencies
}) {
  // Observation only (`docs/REQUIREMENTS.md` 33): Debug Mode adds the current
  // Step's persisted internal information and changes no Execution semantics.
  const debugMode = useSettingsStore((state) => state.debugMode)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [action, setAction] = useState<ActionState>({ status: 'idle' })
  const [notices, setNotices] = useState<string[]>([])
  // Presentation-only acknowledgements (UI_FLOW 12.3 / 12.6): never persisted,
  // so a reload shows the prompt or the panel again.
  const [acknowledgedSwitchStepId, setAcknowledgedSwitchStepId] = useState<PlanStepId | null>(null)
  const [dismissedCheckpointEntryIds, setDismissedCheckpointEntryIds] = useState<BuildListEntryId[]>([])
  const aliveRef = useRef(false)
  const loadSequenceRef = useRef(0)
  const submittingRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** Re-reads the persisted state; an older or unmounted read never lands. */
  const reload = useCallback(async () => {
    loadSequenceRef.current += 1
    const sequence = loadSequenceRef.current
    const isCurrent = () => aliveRef.current && loadSequenceRef.current === sequence
    try {
      const snapshot = await dependencies.loadSnapshot(planId)
      if (!isCurrent()) return
      setLoad(snapshot === null ? { status: 'not_found' } : { status: 'loaded', snapshot })
    } catch {
      if (!isCurrent()) return
      setLoad({ status: 'error', message: '生産計画を読み込めませんでした。' })
    }
  }, [dependencies, planId])

  // The initial read of this route's Plan. Later reads go through `reload()`.
  useEffect(() => {
    loadSequenceRef.current += 1
    const sequence = loadSequenceRef.current
    const isCurrent = () => aliveRef.current && loadSequenceRef.current === sequence
    dependencies.loadSnapshot(planId).then(
      (snapshot) => {
        if (isCurrent()) setLoad(snapshot === null ? { status: 'not_found' } : { status: 'loaded', snapshot })
      },
      () => {
        if (isCurrent()) setLoad({ status: 'error', message: '生産計画を読み込めませんでした。' })
      },
    )
  }, [dependencies, planId])

  /**
   * Runs one Execution transaction. The Navigator never moves to the next Step
   * on its own: it re-reads the persisted state after the runtime accepted the
   * request, because the transaction may have registered or updated weapons and
   * Targets too. The success notices may read the runtime's own result.
   */
  const runTransaction = async <T,>(
    operation: () => Promise<T>,
    successNotices: (result: T) => string[],
  ) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setAction({ status: 'submitting' })
    setNotices([])
    try {
      const result = await operation()
      if (!aliveRef.current) return
      await reload()
      if (!aliveRef.current) return
      setNotices(successNotices(result))
      setAction({ status: 'idle' })
    } catch (caught: unknown) {
      if (!aliveRef.current) return
      const failure = failureFrom(caught)
      setAction(failure)
      // The Plan moved on or ended elsewhere: show what is persisted now.
      if (
        failure.code === 'step_not_current' ||
        failure.code === 'plan_not_active' ||
        failure.code === 'operation_count_recovery_changed' ||
        failure.code === 'operation_count_recovery_not_applicable' ||
        failure.code === 'save_point_changed' ||
        failure.code === 'save_point_not_found' ||
        failure.code === 'save_point_choice_required' ||
        failure.code === 'save_point_choice_not_required' ||
        failure.code === 'save_point_record_not_allowed' ||
        failure.code === 'save_point_restore_not_allowed' ||
        failure.code === 'plan_abandon_state_changed' ||
        failure.code === 'plan_abandon_not_allowed' ||
        failure.code === 'undo_history_not_latest' ||
        failure.code === 'undo_history_not_found' ||
        failure.code === 'undo_not_allowed'
      ) {
        await reload()
      }
    } finally {
      submittingRef.current = false
    }
  }

  const confirmStep = (
    snapshot: ExecutionNavigatorSnapshot,
    step: PlanStep,
    observation?: ExecutionNormalRestorationBonusObservation,
  ) => {
    const request: ConfirmExpectedPlanStepRequest =
      observation === undefined
        ? { planId: snapshot.plan.id, planStepId: step.id }
        : { planId: snapshot.plan.id, planStepId: step.id, observation }
    void runTransaction(
      () => dependencies.confirmExpectedPlanStep(request),
      () =>
        (step.executionEffects?.targetCompletions ?? []).map(
          ({ targetWeaponId }) => `「${targetWeaponLabel(targetWeaponId, snapshot.targetWeapons)}」が完成しました`,
        ),
    )
  }

  const finishAsCompromise = (
    snapshot: ExecutionNavigatorSnapshot,
    checkpoint: CurrentCompromiseCheckpoint,
  ) => {
    const planStepId = snapshot.plan.currentStepId
    if (planStepId === null) return
    void runTransaction(
      () =>
        dependencies.finishProductionPlanAsCompromise({
          planId: snapshot.plan.id,
          planStepId,
          buildListEntryId: checkpoint.buildListEntryId,
          targetWeaponId: checkpoint.targetWeaponId,
          ownedWeaponId: checkpoint.ownedWeaponId,
        }),
      () => [],
    )
  }

  const recordActualResultDifferent = (
    snapshot: ExecutionNavigatorSnapshot,
    step: PlanStep,
    actualResult: ExecutionActualResultObservation,
  ) => {
    void runTransaction(
      () =>
        dependencies.recordActualResultDifferent({
          planId: snapshot.plan.id,
          planStepId: step.id,
          actualResult,
        }),
      () => [],
    )
  }

  const recordOperationUncertain = (snapshot: ExecutionNavigatorSnapshot, step: PlanStep) => {
    void runTransaction(
      () => dependencies.recordOperationUncertain({ planId: snapshot.plan.id, planStepId: step.id }),
      () => [],
    )
  }

  const recoverOperationCount = (
    snapshot: ExecutionNavigatorSnapshot,
    observations: OperationCountRecoveryObservation[],
    recoveredPosition: number,
  ) => {
    const history = snapshot.latestExecutionHistory
    const planStepId = snapshot.plan.currentStepId
    if (history === null || planStepId === null) return
    void runTransaction(
      () =>
        dependencies.recoverOperationCount({
          planId: snapshot.plan.id,
          planStepId,
          uncertainExecutionHistoryId: history.id,
          observations,
          recoveredPosition,
        }),
      // The Plan the recovery transaction persisted decides the wording: a
      // recovery that reached the last Step completed the Plan.
      ({ plan }) => [
        plan.status === 'completed'
          ? '現在位置に合わせて生産計画を完了しました。'
          : '現在位置に合わせて作成プランを再開しました。',
      ],
    )
  }

  const restoreSavePoint = (snapshot: ExecutionNavigatorSnapshot, recordedAt: string) => {
    void runTransaction(
      () => dependencies.restoreExecutionSavePoint({ planId: snapshot.plan.id, recordedAt }),
      () => ['最後のゲーム内セーブ地点へ戻しました。ゲーム側も同じ地点から再開していることを確認してください。'],
    )
  }

  const recordSavePoint = (snapshot: ExecutionNavigatorSnapshot) => {
    // The runtime re-checks the Plan, its current Step and its premises; the
    // displayed state is never the write authority.
    void runTransaction(
      () => dependencies.recordExecutionSavePoint({ planId: snapshot.plan.id }),
      () => ['ゲーム内セーブ地点を記録しました。'],
    )
  }

  const undoLatest = (snapshot: ExecutionNavigatorSnapshot, executionHistoryId: ExecutionHistory['id']) => {
    // Names the record the user saw; a newer one is refused, never undone instead.
    void runTransaction(
      () => dependencies.undoLatestExecution({ planId: snapshot.plan.id, executionHistoryId }),
      () => ['最後のツール上の操作を元に戻しました。ゲーム内の操作は戻っていません。'],
    )
  }

  /** The read-only 16.10 inspection the abandonment dialog is built from. */
  const inspectAbandonment = async (
    snapshot: ExecutionNavigatorSnapshot,
  ): Promise<ProductionPlanAbandonmentOptions | null> => {
    if (submittingRef.current) return null
    setNotices([])
    try {
      const options = await dependencies.inspectProductionPlanAbandonment({ planId: snapshot.plan.id })
      if (!aliveRef.current) return null
      setAction({ status: 'idle' })
      return options
    } catch (caught: unknown) {
      if (!aliveRef.current) return null
      setAction(failureFrom(caught))
      await reload()
      return null
    }
  }

  const abandonWithDecision = (
    options: ProductionPlanAbandonmentOptions,
    savePointDecision: PlanAbandonSavePointDecision,
  ) => {
    // One runtime call: a save point restore and the abandonment are one transaction.
    void runTransaction(
      () =>
        dependencies.abandonProductionPlan({
          planId: options.planId,
          observedPlan: {
            status: options.planStatus,
            currentStepId: options.planCurrentStepId,
            updatedAt: options.planUpdatedAt,
          },
          savePointDecision,
        }),
      () => [],
    )
  }

  const abandonPlan = (snapshot: ExecutionNavigatorSnapshot) => {
    void runTransaction(async () => {
      // The existing user abandonment (16.2 / 16.10), with the Plan tokens it re-checks.
      const options = await dependencies.inspectProductionPlanAbandonment({ planId: snapshot.plan.id })
      return dependencies.abandonProductionPlan({
        planId: snapshot.plan.id,
        observedPlan: {
          status: options.planStatus,
          currentStepId: options.planCurrentStepId,
          updatedAt: options.planUpdatedAt,
        },
        savePointDecision: null,
      })
    }, () => [])
  }

  const planLink = `/plans/${planId}`
  const submitting = action.status === 'submitting'

  return (
    <PageShell
      title="実行ナビゲーション"
      description="作成プランに従って、ゲーム内の操作を1つずつ確定します。"
      actions={
        <Button component={RouterLink} to={planLink} variant="outlined" sx={{ minHeight: 44 }}>
          プラン全体を見る
        </Button>
      }
    >
      <Stack spacing={{ xs: 2, md: 3 }} sx={{ maxWidth: 880 }}>
        {load.status === 'loading' && (
          <Stack spacing={1} role="status" aria-live="polite">
            <LinearProgress aria-label="生産計画を読み込み中" />
            <Typography variant="body2">生産計画を読み込んでいます。</Typography>
          </Stack>
        )}
        {load.status === 'not_found' && (
          <Alert severity="warning">指定された生産計画が見つかりません。</Alert>
        )}
        {load.status === 'error' && <Alert severity="error">{load.message}</Alert>}

        {notices.map((notice) => (
          <Alert key={notice} severity="success" role="status">
            {notice}
          </Alert>
        ))}
        {action.status === 'failed' && (
          <Alert severity="error">
            <Stack spacing={1.5}>
              <Typography variant="body2">{action.message}</Typography>
              {action.code !== null && isRecalculationRequiredError(action.code) && (
                <>
                  <Typography variant="body2">
                    このStepは確定していません。作成プランを確認し、必要ならビルドリストから再計算してください。
                  </Typography>
                  <NavigationLinks
                    links={[
                      { label: '作成プランを見る', to: planLink },
                      { label: 'ビルドリストへ', to: '/build-list' },
                    ]}
                  />
                </>
              )}
            </Stack>
          </Alert>
        )}

        {load.status === 'loaded' && (
          <LoadedNavigator
            snapshot={load.snapshot}
            dependencies={dependencies}
            debugMode={debugMode}
            submitting={submitting}
            acknowledgedSwitchStepId={acknowledgedSwitchStepId}
            dismissedCheckpointEntryIds={dismissedCheckpointEntryIds}
            onAcknowledgeSwitch={setAcknowledgedSwitchStepId}
            onDismissCheckpoint={(id) => setDismissedCheckpointEntryIds((current) => [...current, id])}
            onConfirm={(step, observation) => confirmStep(load.snapshot, step, observation)}
            onFinish={(checkpoint) => finishAsCompromise(load.snapshot, checkpoint)}
            onRecordActualResult={(step, actualResult) =>
              recordActualResultDifferent(load.snapshot, step, actualResult)
            }
            onRecordOperationUncertain={(step) => recordOperationUncertain(load.snapshot, step)}
            onRecoverOperationCount={(observations, position) =>
              recoverOperationCount(load.snapshot, observations, position)
            }
            onRestoreSavePoint={(recordedAt) => restoreSavePoint(load.snapshot, recordedAt)}
            onAbandon={() => abandonPlan(load.snapshot)}
            stateControls={(options) => (
              <ExecutionStateControls
                plan={load.snapshot.plan}
                savePoint={load.snapshot.executionSavePoint}
                undo={load.snapshot.undo}
                savePointRestore={load.snapshot.savePointRestore}
                canRecordSavePoint={options.canRecordSavePoint}
                showsSavePoint={options.running}
                showsSavePointRestore={options.showsSavePointRestore}
                showsAbandon={options.running}
                submitting={submitting}
                onRecordSavePoint={() => recordSavePoint(load.snapshot)}
                onRestoreSavePoint={(recordedAt) => restoreSavePoint(load.snapshot, recordedAt)}
                onUndo={(historyId) => undoLatest(load.snapshot, historyId)}
                onInspectAbandonment={() => inspectAbandonment(load.snapshot)}
                onAbandon={abandonWithDecision}
              />
            )}
          />
        )}
      </Stack>
    </PageShell>
  )
}

interface StateControlsOptions {
  /** An `active` / `stale` Plan: the save point and the abandonment apply. */
  running: boolean
  canRecordSavePoint: boolean
  showsSavePointRestore: boolean
}

function LoadedNavigator({
  snapshot,
  dependencies,
  debugMode,
  submitting,
  acknowledgedSwitchStepId,
  dismissedCheckpointEntryIds,
  onAcknowledgeSwitch,
  onDismissCheckpoint,
  onConfirm,
  onFinish,
  onRecordActualResult,
  onRecordOperationUncertain,
  onRecoverOperationCount,
  onRestoreSavePoint,
  onAbandon,
  stateControls,
}: {
  snapshot: ExecutionNavigatorSnapshot
  dependencies: ExecutionNavigatorPageDependencies
  debugMode: boolean
  submitting: boolean
  acknowledgedSwitchStepId: PlanStepId | null
  dismissedCheckpointEntryIds: readonly BuildListEntryId[]
  onAcknowledgeSwitch(stepId: PlanStepId): void
  onDismissCheckpoint(buildListEntryId: BuildListEntryId): void
  onConfirm(step: PlanStep, observation?: ExecutionNormalRestorationBonusObservation): void
  onFinish(checkpoint: CurrentCompromiseCheckpoint): void
  onRecordActualResult(step: PlanStep, actualResult: ExecutionActualResultObservation): void
  onRecordOperationUncertain(step: PlanStep): void
  onRecoverOperationCount(observations: OperationCountRecoveryObservation[], position: number): void
  onRestoreSavePoint(recordedAt: string): void
  onAbandon(): void
  /** 「実行状態の管理」, below the Step's game actions. */
  stateControls(options: StateControlsOptions): ReactNode
}) {
  const { plan, ownedWeapons, targetWeapons, buildListEntries, latestExecutionHistory } = snapshot
  const progress = createExecutionProgress(plan)

  /**
   * The current Step's persisted internal information, in Debug Mode only
   * (`docs/REQUIREMENTS.md` 33, `docs/UI_FLOW.md` 15).
   *
   * Placed below the Step's game actions and collapsed by default, so the
   * primary action stays the prominent control. Only the current Step is
   * shown, so a confirmed Step's values never linger as the current ones. A
   * `stale` Plan keeps its persisted Debug values but says they may no longer
   * match the current state.
   */
  const stepDebugDetails = (step: PlanStep) =>
    debugMode ? (
      <PlanStepDebugDetails
        step={step}
        headingLevel="h2"
        title={`現在Step（ステップ ${step.order}）のPlanStep Debug`}
        note={
          plan.status === 'stale' ? (
            <Alert severity="warning">
              この生産計画は再計算が必要な状態です。この予測は現在状態と一致しない可能性があります。
            </Alert>
          ) : null
        }
      />
    ) : null

  if (plan.status !== 'active') {
    const divergence = executionDivergenceView(plan, latestExecutionHistory)
    const uncertainStep = divergence?.action === 'operation_uncertain'
      ? plan.steps.find(({ id }) => id === divergence.planStepId) ?? null
      : null
    if (uncertainStep !== null) {
      const presentation = createExecutionStepPresentation(uncertainStep, ownedWeapons, targetWeapons)
      return (
        <>
          <ExecutionProgress progress={progress} />
          {submitting && (
            <Stack spacing={1} role="status" aria-live="polite">
              <LinearProgress aria-label="操作を保存中" />
              <Typography variant="body2">操作を保存しています。</Typography>
            </Stack>
          )}
          <OperationUncertainRecovery
            plan={plan}
            availability={snapshot.operationCountRecovery}
            savePoint={snapshot.executionSavePoint}
            undoAvailable={snapshot.undo.kind === 'available'}
            master={dependencies.master}
            weaponTypeId={presentation.weaponTypeId}
            elementId={presentation.elementId}
            submitting={submitting}
            onRecover={onRecoverOperationCount}
            onRestoreSavePoint={onRestoreSavePoint}
            onAbandon={onAbandon}
          />
          {/* The recovery owns its save point restore; Undo and the ordinary abandonment stay here. */}
          {stateControls({ running: true, canRecordSavePoint: false, showsSavePointRestore: false })}
          {stepDebugDetails(uncertainStep)}
        </>
      )
    }
    const running = plan.status === 'stale'
    return (
      <>
        {plan.status !== 'draft' && <ExecutionProgress progress={progress} />}
        {submitting && (
          <Stack spacing={1} role="status" aria-live="polite">
            <LinearProgress aria-label="操作を保存中" />
            <Typography variant="body2">操作を保存しています。</Typography>
          </Stack>
        )}
        <EndedPlanView
          plan={plan}
          divergence={divergence?.action === 'actual_result_different' ? divergence : null}
          latestExecutionHistory={latestExecutionHistory}
          reidentificationReminder={snapshot.reidentificationReminder}
        />
        {plan.status !== 'draft' &&
          stateControls({ running, canRecordSavePoint: false, showsSavePointRestore: running })}
        {progress.currentStep !== null && stepDebugDetails(progress.currentStep)}
      </>
    )
  }

  if (!evaluateProductionPlanCalculationCompatibility(plan, dependencies.currentCalculationContext).isCompatible) {
    return (
      <>
        <Alert severity="warning">
          <AlertTitle>この計画は再計算が必要です</AlertTitle>
          <Stack spacing={1.5}>
            <Typography variant="body2">
              この生産計画は現在の計算契約と互換性がないため、実行を続けられません。
            </Typography>
            <NavigationLinks
              links={[
                { label: '作成プランを見る', to: `/plans/${plan.id}` },
                { label: 'ビルドリストへ', to: '/build-list' },
              ]}
            />
          </Stack>
        </Alert>
        {stateControls({ running: true, canRecordSavePoint: false, showsSavePointRestore: false })}
      </>
    )
  }

  const step = progress.currentStep
  if (step === null) {
    return (
      <Alert severity="error">
        この生産計画には現在のStepがありません。作成プランを確認してください。
      </Alert>
    )
  }

  const presentation = createExecutionStepPresentation(step, ownedWeapons, targetWeapons)
  // The same still-current authority the compromise finish runtime checks.
  const checkpoint =
    listCurrentCompromiseCheckpoints(plan, buildListEntries).find(
      ({ buildListEntryId }) => !dismissedCheckpointEntryIds.includes(buildListEntryId),
    ) ?? null
  const switchWeaponId = weaponSwitchTarget(plan, step)
  /**
   * The weapon switch guidance is an interstitial placed *before* the current
   * Step is shown (`docs/PLANNER_SPEC.md` 16.14, `docs/UI_FLOW.md` 12.6), so
   * the Step card itself is not rendered until 「武器を切り替えました」:
   * the operation name, instruction, expected result and every action stay
   * absent from the DOM and the accessibility tree, not merely hidden.
   */
  const showsSwitchPrompt = checkpoint === null && switchWeaponId !== null && acknowledgedSwitchStepId !== step.id
  const showsActions = checkpoint === null

  const header = (
    <>
      <ExecutionProgress progress={progress} />
      {submitting && (
        <Stack spacing={1} role="status" aria-live="polite">
          <LinearProgress aria-label="操作を保存中" />
          <Typography variant="body2">操作を保存しています。</Typography>
        </Stack>
      )}
    </>
  )

  if (showsSwitchPrompt && switchWeaponId !== null) {
    // Presentation-only: the acknowledgement confirms no Step and is never
    // persisted, so the state controls stay exactly as available as they are
    // on the current Step, and a reload shows this interstitial again.
    return (
      <>
        {header}
        <WeaponSwitchPrompt
          weaponLabel={ownedWeaponLabel(switchWeaponId, ownedWeapons)}
          weapon={ownedWeapons.find(({ id }) => id === switchWeaponId) ?? null}
          master={dependencies.master}
          onAcknowledge={() => onAcknowledgeSwitch(step.id)}
        />
        {stateControls({ running: true, canRecordSavePoint: true, showsSavePointRestore: true })}
      </>
    )
  }

  return (
    <>
      {header}
      {checkpoint !== null && (
        <CompromiseCheckpointPanel
          weaponLabel={ownedWeaponLabel(checkpoint.ownedWeaponId, ownedWeapons)}
          targetLabel={targetWeaponLabel(checkpoint.targetWeaponId, targetWeapons)}
          labelledPractical={!checkpoint.heldBeforeLabelStep}
          finishing={submitting}
          onContinue={() => onDismissCheckpoint(checkpoint.buildListEntryId)}
          onFinish={() => onFinish(checkpoint)}
        />
      )}
      <ExecutionStepCard presentation={presentation} master={dependencies.master}>
        {presentation.actionKind === 'not_executable' ? (
          <Alert severity="warning">
            このStepは現在の実行形式ではないため、実行ナビでは確定できません。
          </Alert>
        ) : (
          showsActions && (
            <StepActions
              key={step.id}
              presentation={presentation}
              dependencies={dependencies}
              targetFound={presentation.target !== null}
              submitting={submitting}
              onConfirm={(observation) => onConfirm(step, observation)}
              onRecordActualResult={(actualResult) => onRecordActualResult(step, actualResult)}
              onRecordOperationUncertain={() => onRecordOperationUncertain(step)}
            />
          )
        )}
      </ExecutionStepCard>
      {stateControls({ running: true, canRecordSavePoint: true, showsSavePointRestore: true })}
      {stepDebugDetails(step)}
    </>
  )
}

/**
 * The current Step's actions (`docs/UI_FLOW.md` 12): the ordinary
 * confirmation first, and the divergence records 「結果が違う」 / 「何を何回
 * 操作したか分からない」 in a separate section below it, so they are not
 * tapped by mistake. Keyed by the Step, so a draft never outlives its Step; a
 * refused record keeps the draft.
 */
function StepActions({
  presentation,
  dependencies,
  targetFound,
  submitting,
  onConfirm,
  onRecordActualResult,
  onRecordOperationUncertain,
}: {
  presentation: ExecutionStepPresentation
  dependencies: ExecutionNavigatorPageDependencies
  targetFound: boolean
  submitting: boolean
  onConfirm(observation?: ExecutionNormalRestorationBonusObservation): void
  onRecordActualResult(actualResult: ExecutionActualResultObservation): void
  onRecordOperationUncertain(): void
}) {
  const [enteringActualResult, setEnteringActualResult] = useState(false)
  const [draft, setDraft] = useState<ActualResultDraft>(emptyActualResultDraft)
  const [confirmingUncertain, setConfirmingUncertain] = useState(false)
  const { step, actionKind } = presentation
  const actualKind = actualResultInputKind(step)
  const uncertain = offersOperationUncertain(step)

  if (enteringActualResult && actualKind !== null) {
    return (
      <ActualResultDifferentForm
        master={dependencies.master}
        kind={actualKind}
        weaponTypeId={presentation.weaponTypeId}
        elementId={presentation.elementId}
        draft={draft}
        disabled={submitting}
        onChange={setDraft}
        onSubmit={onRecordActualResult}
        onCancel={() => setEnteringActualResult(false)}
      />
    )
  }

  return (
    <>
      {actionKind === 'confirm_expected' && (
        <Button
          variant="contained"
          size="large"
          disabled={submitting}
          onClick={() => onConfirm()}
          sx={primarySx}
        >
          結果一致・次へ
        </Button>
      )}
      {actionKind === 'confirm_owned_ideal' && (
        <Button
          variant="contained"
          size="large"
          disabled={submitting}
          onClick={() => onConfirm()}
          sx={primarySx}
        >
          所持武器で完成を確認
        </Button>
      )}
      {actionKind === 'observe_normal_bonuses' && (
        targetFound ? (
          <BlindObservationForm
            master={dependencies.master}
            weaponTypeId={presentation.weaponTypeId}
            elementId={presentation.elementId}
            disabled={submitting}
            onSubmit={(observation) => onConfirm(observation)}
          />
        ) : (
          <Alert severity="error">
            このStepの目標武器が見つからないため、5枠を入力できません。
          </Alert>
        )
      )}
      {(actualKind !== null || uncertain) && (
        <>
          {/* Kept apart from the primary action so it is never tapped by mistake. */}
          <Divider sx={{ pt: 2 }} />
          <Box role="group" aria-label="想定外の結果を記録" sx={{ pt: 1 }}>
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                ゲーム内の結果や操作が案内と違った場合
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {actualKind !== null && (
                  <Button
                    variant="outlined"
                    color="warning"
                    disabled={submitting}
                    onClick={() => setEnteringActualResult(true)}
                    sx={buttonSx}
                  >
                    結果が違う
                  </Button>
                )}
                {uncertain && (
                  <Button
                    variant="outlined"
                    color="warning"
                    disabled={submitting}
                    onClick={() => setConfirmingUncertain(true)}
                    sx={buttonSx}
                  >
                    何を何回操作したか分からない
                  </Button>
                )}
              </Stack>
            </Stack>
          </Box>
          <OperationUncertainDialog
            open={confirmingUncertain}
            submitting={submitting}
            onCancel={() => setConfirmingUncertain(false)}
            onConfirm={() => {
              setConfirmingUncertain(false)
              onRecordOperationUncertain()
            }}
          />
        </>
      )}
    </>
  )
}

interface ExecutionNavigatorPageProps {
  dependencies?: ExecutionNavigatorPageDependencies
}

export function ExecutionNavigatorPage({
  dependencies = defaultDependencies ?? undefined,
}: ExecutionNavigatorPageProps) {
  const { planId } = useParams()
  if (!dependencies) {
    return (
      <PageShell title="実行ナビゲーション" description="作成プランに従って、ゲーム内の操作を1つずつ確定します。">
        <Alert severity="error">マスターデータを読み込めません。</Alert>
      </PageShell>
    )
  }
  if (!planId) {
    return (
      <PageShell title="実行ナビゲーション" description="作成プランに従って、ゲーム内の操作を1つずつ確定します。">
        <Alert severity="warning">指定された生産計画が見つかりません。</Alert>
      </PageShell>
    )
  }
  // Keyed by the route Plan: another planId starts a fresh navigator, so no
  // state or in-flight result of the previous Plan can reach it.
  return (
    <ExecutionNavigator
      key={planId}
      planId={planId as ProductionPlanId}
      dependencies={dependencies}
    />
  )
}
