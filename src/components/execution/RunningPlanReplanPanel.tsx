import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlan } from '../../domain/models/publicTypes'
import type { PlannerOptions } from '../../domain/planner'
import type { RunningPlanReplanSessionState, RunningPlanReplanStart } from '../../services/execution/runningPlanReplanService'
import { BuildListOptimizationDiagnosticsDetails } from '../planner/BuildListOptimizationDiagnostics'
import { UnsupportedReasonViewList } from '../planner/BuildListOptimizationResultPanel'
import { BuildListOptimizationRunningPanel } from '../planner/BuildListOptimizationRunningPanel'
import { createBuildListOptimizationTargetResolver, unsupportedReasonDebugText } from '../planner/buildListOptimizationPresentation'
import { TargetName } from '../planner/BuildListOptimizationPreviewPanel'
import { ProductionPlanReplanPreviewPanel } from './ProductionPlanReplanPreviewPanel'
import { RunningPlanReplanAdoptionDialog } from './RunningPlanReplanAdoptionDialog'
import { RunningPlanReplanPreviewView } from './RunningPlanReplanPreviewView'
import { ReplanRefusalAlert, RunningPlanReplanTargetConfirmation } from './RunningPlanReplanTargetConfirmation'
import {
  createReplanShortfallView,
  presentRunningPlanReplanUnsupportedReason,
  replanShortfallAdoptionCheckItems,
  replanTargetLabel,
  RUNNING_PLAN_REPLAN_ACTIVE_CONTINUES_NOTE,
  RUNNING_PLAN_REPLAN_AUXILIARY_LABEL,
  RUNNING_PLAN_REPLAN_AUXILIARY_NOTES,
  RUNNING_PLAN_REPLAN_AUXILIARY_OPTIONS_INVALID_MESSAGE,
  RUNNING_PLAN_REPLAN_AUXILIARY_PREVIEW_TITLE,
  RUNNING_PLAN_REPLAN_AUXILIARY_RUNNING_TITLE,
  RUNNING_PLAN_REPLAN_AUXILIARY_TITLE,
  RUNNING_PLAN_REPLAN_CLOSE_LABEL,
  RUNNING_PLAN_REPLAN_OPEN_LABEL,
  RUNNING_PLAN_REPLAN_RECALCULATE_NOTE,
  RUNNING_PLAN_REPLAN_RUNNING_NOTE,
  RUNNING_PLAN_REPLAN_RUNNING_TITLE,
  RUNNING_PLAN_REPLAN_SECTION_DESCRIPTION,
  RUNNING_PLAN_REPLAN_UNCHANGED_MESSAGE,
  isRunningPlanReplanOrdinaryPlannerSettingsShown,
  presentRunningPlanReplanFailure,
  runningPlanReplanResultViewOf,
  type ReplanShortfallView,
} from './runningPlanReplanPresentation'
import type { RunningPlanReplanController } from './useRunningPlanReplan'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/** The explicit auxiliary (18.5): inside the result that offers it, never a standing second button, never started by itself. */
function ReplanAuxiliaryBlock({
  onStart,
  disabledReason,
  disabled,
}: {
  onStart(): void
  disabled: boolean
  disabledReason: string | null
}) {
  const notesId = useId()
  const reasonId = useId()
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0 }}>
      <Stack spacing={1}>
        <Typography component="p" variant="subtitle2">{RUNNING_PLAN_REPLAN_AUXILIARY_TITLE}</Typography>
        <Box component="ul" id={notesId} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
          {RUNNING_PLAN_REPLAN_AUXILIARY_NOTES.map((note) => (
            <Typography component="li" variant="body2" color="text.secondary" key={note} sx={{ overflowWrap: 'anywhere' }}>
              {note}
            </Typography>
          ))}
        </Box>
        {disabledReason !== null && (
          <Typography id={reasonId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>{disabledReason}</Typography>
        )}
        <Button
          variant="outlined"
          onClick={onStart}
          disabled={disabled}
          aria-describedby={disabledReason !== null ? `${notesId} ${reasonId}` : notesId}
          sx={{ ...actionSx, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          {RUNNING_PLAN_REPLAN_AUXILIARY_LABEL}
        </Button>
      </Stack>
    </Box>
  )
}

/** The auxiliary Preview's 「この試算で作られない目標武器」 (18.5): count, names and typed reasons, so a partial plan never reads as whole. */
function AuxiliaryShortfall({ view }: { view: ReplanShortfallView }) {
  if (view.rows.length === 0) {
    return <Alert severity="info">{`今回の再計画の目標武器${view.totalCount}本すべてが、この試算で完成予定です。`}</Alert>
  }
  return (
    <Alert severity="warning">
      <Stack spacing={1}>
        <Typography variant="body2" className="tabular-nums" sx={{ fontWeight: 600 }}>
          {`この試算で作られない目標武器：${view.rows.length}本（今回の再計画の目標武器${view.totalCount}本のうち、完成予定は${view.completedCount}本）`}
        </Typography>
        <Box component="ul" aria-label="この試算で作られない目標武器" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
          {view.rows.map((row) => (
            <Typography component="li" variant="body2" key={row.key} sx={{ overflowWrap: 'anywhere' }}>
              {row.target === null ? replanTargetLabel(null) : <TargetName target={row.target} />}：{row.reasonLabel}
            </Typography>
          ))}
        </Box>
      </Stack>
    </Alert>
  )
}

/** Debug Mode only: the failure exactly as the session typed it (the Worker's message is shown here and nowhere else). */
function FailureDebugDetails({ state }: { state: Extract<RunningPlanReplanSessionState, { status: 'failed' }> }) {
  const { failure } = state
  const lines: string[] = [`kind: ${failure.kind}`]
  if ('code' in failure) lines.push(`code: ${failure.code}`)
  if ('domainCode' in failure) lines.push(`domainCode: ${failure.domainCode ?? 'null'}`)
  if ('issues' in failure) lines.push(`issues: ${failure.issues.join(' / ')}`)
  if ('message' in failure) lines.push(`message: ${failure.message ?? 'null'}`)
  return (
    <Box component="ul" aria-label="計算失敗の詳細（Debug）" sx={{ m: 0, pl: 2.5 }}>
      {lines.map((line) => (
        <Typography component="li" variant="caption" color="text.secondary" key={line} sx={{ overflowWrap: 'anywhere' }}>{line}</Typography>
      ))}
    </Box>
  )
}

/**
 * A finished non-`optimized` outcome (`docs/UI_FLOW.md` 16.5 「3. 結果」): `unsupported` lists its typed reasons, `not_found` and
 * `search_bound_reached` are the whole replan target set's results (never attributed to a Target, never "no plan exists"), a
 * cancellation is a notice, and a failure or contract violation is an error with 「もう一度試算」. The auxiliary sits inside only when
 * the session state offers it.
 */
function ReplanOutcome({
  state,
  start,
  master,
  debugMode,
  oldPlanActive,
  auxiliary,
  actionsDisabled,
  onRetry,
  onDiscard,
}: {
  state: Exclude<RunningPlanReplanSessionState, { status: 'idle' | 'preparing' | 'running' | 'disposed' }>
  start: RunningPlanReplanStart | null
  master: MasterDataRoot
  debugMode: boolean
  oldPlanActive: boolean
  auxiliary: ReactNode
  actionsDisabled: boolean
  onRetry(): void
  onDiscard(): void
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  const reasonViews = useMemo(() => {
    if (state.status !== 'completed' || state.completion.kind !== 'calculated' || state.completion.result.status !== 'unsupported') return []
    const resolve = createBuildListOptimizationTargetResolver(start?.plannerInput.targetWeapons ?? null, master)
    return state.completion.result.reasons.map((reason, index) => ({
      key: `${reason.kind}:${index}`,
      presentation: presentRunningPlanReplanUnsupportedReason(reason, resolve),
      debugText: unsupportedReasonDebugText(reason),
    }))
  }, [state, start, master])

  if (state.status === 'completed' && state.completion.kind === 'refused') {
    return <ReplanRefusalAlert refusal={state.completion.refusal} debugMode={debugMode} />
  }
  const outcome = state.status === 'cancelled'
    ? { kind: 'cancelled' as const, reason: state.reason }
    : state.status === 'failed'
      ? { kind: 'failed' as const, failure: state.failure }
      : state.completion.kind === 'calculated' && state.completion.result.status !== 'optimized'
        ? { kind: 'result' as const, result: state.completion.result }
        : null
  if (outcome === null) return null
  const view = runningPlanReplanResultViewOf(outcome)
  const retryable = outcome.kind === 'cancelled' || (outcome.kind === 'failed' && presentRunningPlanReplanFailure(outcome.failure).retryable)
  const searchResult = outcome.kind === 'result' && (outcome.result.status === 'not_found' || outcome.result.status === 'search_bound_reached')
  return (
    <Paper component="section" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Typography id={headingId} ref={headingRef} tabIndex={-1} component="h3" variant="h3">{view.title}</Typography>
        <Alert severity={view.severity}>
          <Stack spacing={0.5}>
            {view.messages.map((message) => (
              <Typography variant="body2" key={message} sx={{ overflowWrap: 'anywhere' }}>{message}</Typography>
            ))}
          </Stack>
        </Alert>
        {reasonViews.length > 0 && <UnsupportedReasonViewList views={reasonViews} label="再計画を使えない理由" debugMode={debugMode} />}
        {searchResult && <Typography variant="body2">{RUNNING_PLAN_REPLAN_RECALCULATE_NOTE}</Typography>}
        <Typography variant="body2" color="text.secondary">
          {oldPlanActive ? RUNNING_PLAN_REPLAN_ACTIVE_CONTINUES_NOTE : RUNNING_PLAN_REPLAN_UNCHANGED_MESSAGE}
        </Typography>
        {auxiliary}
        {debugMode && state.status === 'failed' && <FailureDebugDetails state={state} />}
        {debugMode && outcome.kind === 'result' && outcome.result.status === 'not_found' && (
          <>
            <Typography variant="caption" color="text.secondary">reason: {outcome.result.reason}</Typography>
            <BuildListOptimizationDiagnosticsDetails diagnostics={outcome.result.diagnostics} headingLevel="h4" />
          </>
        )}
        {debugMode && outcome.kind === 'result' && outcome.result.status === 'search_bound_reached' && (
          <BuildListOptimizationDiagnosticsDetails diagnostics={outcome.result.diagnostics} bounds={outcome.result.bounds} headingLevel="h4" />
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          {retryable && (
            <Button variant="contained" disabled={actionsDisabled} onClick={onRetry} sx={actionSx}>
              もう一度試算
            </Button>
          )}
          <Button variant="outlined" disabled={actionsDisabled} onClick={onDiscard} sx={actionSx}>
            結果を閉じる
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}

/**
 * 「現在地点からの再計画」 (`docs/UI_FLOW.md` 16.5, `docs/PLANNER_SPEC.md` 18), shared by the Build List and the Production Plan page.
 * Closed, it is one description and one button; the target confirmation, the calculation, the result, the Preview and the adoption
 * appear only after the user opened it. The controller owns every state; this component renders it.
 *
 * `plannerOptions` is the ordinary Planner setting the auxiliary uses (null while it is invalid: the auxiliary says so and does not
 * start). `runningPlan` is what the screen displays, for the auxiliary 16.8 Preview's comparison and save point label only.
 * `passiveNote` is a read-only sentence the screen derived (the Build List's additional candidate count, Issue #276 PR-6B): shown under
 * the description whether the replan is open or not, with no dismissal and no action of its own.
 * `ordinaryPlannerSettings` is the screen's own 「詳細設定（通常Planner用）」 (the Build List's; the Production Plan page has none and uses
 * the default): it is placed after the replan's contents only while the auxiliary that reads it is offered or shown (Issue #359).
 */
export function RunningPlanReplanPanel({
  controller,
  master,
  debugMode,
  plannerOptions,
  runningPlan,
  passiveNote = null,
  ordinaryPlannerSettings = null,
}: {
  controller: RunningPlanReplanController
  master: MasterDataRoot
  debugMode: boolean
  plannerOptions: PlannerOptions | null
  runningPlan: ProductionPlan | null
  passiveNote?: string | null
  ordinaryPlannerSettings?: ReactNode
}) {
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const adoptButtonRef = useRef<HTMLButtonElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const pendingFocusRef = useRef<'open' | 'adopt' | null>(null)
  const { session, preview, resultStart, adoption, notice } = controller

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus()
  }, [notice])
  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null) return
    const target = pending === 'adopt' ? adoptButtonRef.current : openButtonRef.current
    if (target === null) return
    pendingFocusRef.current = null
    target.focus()
  })

  const shortfallView = useMemo(
    () => controller.auxiliaryShortfall === null || resultStart === null
      ? null
      : createReplanShortfallView(controller.auxiliaryShortfall, resultStart.plannerInput.targetWeapons, master),
    [controller.auxiliaryShortfall, resultStart, master],
  )

  const close = () => {
    pendingFocusRef.current = 'open'
    controller.closePanel()
  }
  const cancelAdoption = () => {
    pendingFocusRef.current = 'adopt'
    controller.cancelAdoption()
  }

  const oldPlanActive = (resultStart?.runningPlanToken.status ?? runningPlan?.status) === 'active'
  const auxiliaryInProgress = controller.auxiliary.preview.status === 'loading'
    || controller.auxiliary.adoption.status === 'inspecting'
    || controller.auxiliary.adoption.status === 'submitting'
  const auxiliaryBlock = controller.auxiliaryOffer.offered ? (
    <ReplanAuxiliaryBlock
      onStart={() => controller.startAuxiliary(plannerOptions)}
      disabled={plannerOptions === null || controller.calculating || auxiliaryInProgress || adoption.status !== 'idle'}
      disabledReason={plannerOptions === null ? RUNNING_PLAN_REPLAN_AUXILIARY_OPTIONS_INVALID_MESSAGE : null}
    />
  ) : null

  const passive = passiveNote === null ? null : (
    <Typography variant="body2" className="tabular-nums" sx={{ overflowWrap: 'anywhere' }}>{passiveNote}</Typography>
  )

  if (!controller.open) {
    return (
      <Stack spacing={1.5}>
        <Typography variant="body2" color="text.secondary">{RUNNING_PLAN_REPLAN_SECTION_DESCRIPTION}</Typography>
        {passive}
        {notice !== null && (
          // Why the replan closed by itself (the running Plan changed): the opened Plan's state is gone, nothing switched over.
          <Alert severity={notice.severity} ref={noticeRef} tabIndex={-1} onClose={controller.dismissNotice}>
            {notice.message}
          </Alert>
        )}
        <Button
          ref={openButtonRef}
          variant="contained"
          disabled={!controller.available || runningPlan === null}
          // The replan is bound to the Plan this screen shows (never to whichever Plan a later read finds running).
          onClick={() => {
            if (runningPlan !== null) controller.openPanel(runningPlan.id)
          }}
          sx={{ ...actionSx, px: 3, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          {RUNNING_PLAN_REPLAN_OPEN_LABEL}
        </Button>
      </Stack>
    )
  }

  const showOutcome = session.status === 'cancelled' || session.status === 'failed'
    || (session.status === 'completed' && (session.completion.kind === 'refused' || session.completion.result.status !== 'optimized'))

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{RUNNING_PLAN_REPLAN_SECTION_DESCRIPTION}</Typography>
        <Button
          variant="text"
          onClick={close}
          disabled={controller.closeDisabled}
          sx={{ minHeight: 44, flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
        >
          {RUNNING_PLAN_REPLAN_CLOSE_LABEL}
        </Button>
      </Stack>
      {passive}

      {notice !== null && (
        <Alert severity={notice.severity} ref={noticeRef} tabIndex={-1} onClose={controller.dismissNotice}>
          {notice.message}
        </Alert>
      )}

      <RunningPlanReplanTargetConfirmation controller={controller} master={master} debugMode={debugMode} />

      {(session.status === 'preparing' || session.status === 'running') && (
        <BuildListOptimizationRunningPanel
          runKey={session.runId}
          stage={session.status === 'running' ? session.stage : null}
          onCancel={controller.cancelCalculation}
          title={RUNNING_PLAN_REPLAN_RUNNING_TITLE}
          note={RUNNING_PLAN_REPLAN_RUNNING_NOTE}
          progressLabel="再計画の計算中"
        />
      )}

      {showOutcome && (
        <ReplanOutcome
          key={'runId' in session ? session.runId : 'none'}
          state={session as Exclude<RunningPlanReplanSessionState, { status: 'idle' | 'preparing' | 'running' | 'disposed' }>}
          start={resultStart}
          master={master}
          debugMode={debugMode}
          oldPlanActive={oldPlanActive}
          auxiliary={auxiliaryBlock}
          actionsDisabled={controller.busy}
          onRetry={controller.startCalculation}
          onDiscard={controller.discardResult}
        />
      )}

      {preview !== null && resultStart !== null && (
        <RunningPlanReplanPreviewView
          key={'runId' in session ? session.runId : 'none'}
          preview={preview}
          start={resultStart}
          master={master}
          debugMode={debugMode}
          onAdopt={controller.requestAdoption}
          onDiscard={controller.discardResult}
          actionsDisabled={controller.busy}
          adoptionInspecting={adoption.status === 'inspecting'}
          adoptButtonRef={adoptButtonRef}
        />
      )}

      {(controller.auxiliary.preview.status !== 'idle' || controller.auxiliary.adoption.status !== 'idle') && (
        <ProductionPlanReplanPreviewPanel
          controller={controller.auxiliary}
          runningPlan={runningPlan ?? resultStart?.runningPlan ?? null}
          targetWeapons={resultStart?.plannerInput.targetWeapons ?? []}
          ownedWeapons={resultStart?.plannerInput.ownedWeapons ?? []}
          buildListEntries={controller.auxiliaryBuildListEntries}
          master={master}
          debugMode={debugMode}
          title={RUNNING_PLAN_REPLAN_AUXILIARY_PREVIEW_TITLE}
          runningTitle={RUNNING_PLAN_REPLAN_AUXILIARY_RUNNING_TITLE}
          previewSupplement={shortfallView === null ? null : <AuxiliaryShortfall view={shortfallView} />}
          adoptionCheckItems={shortfallView === null ? null : replanShortfallAdoptionCheckItems(shortfallView)}
        />
      )}

      {(adoption.status === 'confirming' || adoption.status === 'submitting') && resultStart !== null && (
        <RunningPlanReplanAdoptionDialog
          inspection={adoption.inspection}
          start={resultStart}
          master={master}
          submitting={adoption.status === 'submitting'}
          onCancel={cancelAdoption}
          onConfirm={controller.adopt}
        />
      )}

      {isRunningPlanReplanOrdinaryPlannerSettingsShown(controller) && ordinaryPlannerSettings}
    </Stack>
  )
}
