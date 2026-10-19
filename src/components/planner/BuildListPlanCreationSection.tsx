import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Alert, AlertTitle, Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlan } from '../../domain/models/publicTypes'
import type { PlannerOptions } from '../../domain/planner'
import { planCreationMethodOf } from '../../domain/planner/buildListOptimization'
import { plannerWarningLabels } from '../../presentation/labels'
import {
  isOrdinaryPlannerAuxiliaryOffered,
  isOrdinaryPlannerAuxiliaryOfferedForPreparation,
  type OrdinaryPlannerRunState,
  type PlanCreationOperation,
  type PrimaryPlanCreationState,
} from '../../services/planner/planCreationService'
import { BuildListOptimizationAdoptionDialog } from './BuildListOptimizationAdoptionDialog'
import {
  BuildListOptimizationResultPanel,
  BuildListOptimizationUnsupportedReasonList,
  OrdinaryPlannerAuxiliaryBlock,
  type OrdinaryPlannerAuxiliaryAction,
} from './BuildListOptimizationResultPanel'
import { BuildListOptimizationRunningPanel } from './BuildListOptimizationRunningPanel'
import {
  ORDINARY_PLANNER_AUXILIARY_OPTIONS_INVALID_MESSAGE,
  buildListOptimizationOutcomeOf,
} from './buildListOptimizationPresentation'
import {
  ADOPTION_INSPECTING_MESSAGE,
  PLAN_CREATION_BUSY_MESSAGE,
  PLAN_CREATION_CANCELLED_MESSAGE,
  PLAN_CREATION_DRAFT_REPLACED_NOTE,
  PLAN_CREATION_FAILED_MESSAGE,
  PLAN_CREATION_INVALID_INPUT_MESSAGE,
  PLAN_CREATION_JUDGEMENT_FAILED_MESSAGE,
  PLAN_CREATION_JUDGING_MESSAGE,
  PLAN_CREATION_NO_PLAN_MESSAGE,
  PLAN_CREATION_NO_VALID_ENTRY_MESSAGE,
  PLAN_CREATION_ORDINARY_LINES,
  PLAN_CREATION_PREPARING_TITLE,
  PLAN_CREATION_PRIMARY_LABEL,
  PLAN_CREATION_READ_FAILED_MESSAGE,
  PLAN_CREATION_RUNNING_PLAN_MESSAGE,
  PLAN_CREATION_SAVING_MESSAGE,
  PLAN_CREATION_SETTINGS_HEADING,
  ordinaryPlannerRetryAction,
  planCreationOptimizationLines,
  planCreationUnsupportedLead,
  planCreationValidEntryCount,
  presentPlanCreationNotStarted,
} from './planCreationPresentation'
import {
  createPlannerCompletedTargetsText,
  createPlannerReachedLimitMessages,
  plannerIncompleteSearchTitle,
} from './plannerSearchLimitPresentation'
import {
  productionPlannerOptionsInvalidMessage,
  productionPlannerRunningNote,
  productionPlannerRunningTitles,
} from './productionPlannerSettingsPresentation'
import type { BuildListPlanCreationController, OrdinaryPlannerSaveState } from './useBuildListPlanCreation'

const cancelButtonSx = { minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } } as const

/** The indeterminate running state of a press that is reading or of an ordinary Planner run (`docs/UI_FLOW.md` 10.0). */
function IndeterminateStatus({ title, progressLabel, note, onCancel }: { title: string; progressLabel: string; note?: string; onCancel(): void }) {
  const headingId = useId()
  return (
    <Paper component="section" variant="outlined" role="status" aria-live="polite" aria-labelledby={headingId} sx={{ p: { xs: 1.5, md: 2 }, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Typography id={headingId} component="h3" variant="h3">
          {title}
        </Typography>
        <LinearProgress aria-label={progressLabel} variant="indeterminate" />
        {note !== undefined && (
          <Typography variant="caption" color="text.secondary">
            {note}
          </Typography>
        )}
        <Button variant="outlined" onClick={onCancel} sx={cancelButtonSx}>
          キャンセル
        </Button>
      </Stack>
    </Paper>
  )
}

/**
 * One ordinary Planner run - the one valid Entry primary operation or the auxiliary operation - with the existing displays
 * (`docs/UI_FLOW.md` 10.0 / 10.1 / 10.2): the indeterminate running state, an incomplete search (never saved), the save, the no-Plan
 * notice, a failure, a cancellation and the Planner warnings.
 */
function OrdinaryPlannerRunDisplay({
  operation,
  runId,
  run,
  save,
  onCancel,
}: {
  operation: PlanCreationOperation
  runId: number
  run: OrdinaryPlannerRunState
  save: OrdinaryPlannerSaveState | null
  onCancel(): void
}) {
  switch (run.status) {
    case 'running':
      return <IndeterminateStatus title={productionPlannerRunningTitles.plan} progressLabel="生産計画の作成中" note={productionPlannerRunningNote} onCancel={onCancel} />
    case 'cancelled':
      return run.reason === 'cancelled' ? <Alert severity="info">{PLAN_CREATION_CANCELLED_MESSAGE}</Alert> : null
    case 'failed':
      return <Alert severity="error">{run.message.length > 0 ? run.message : PLAN_CREATION_FAILED_MESSAGE}</Alert>
    case 'completed': {
      const { result } = run
      const ownSave = save !== null && save.operation === operation && save.runId === runId ? save : null
      return (
        <Stack spacing={1.5}>
          {result.termination.status === 'incomplete' && (
            <Alert severity="warning">
              <AlertTitle>{plannerIncompleteSearchTitle}</AlertTitle>
              <Stack spacing={0.5}>
                {createPlannerReachedLimitMessages(result.termination, {
                  settingsHeading: PLAN_CREATION_SETTINGS_HEADING,
                  retryAction: ordinaryPlannerRetryAction(operation),
                }).map((message) => (
                  <Typography variant="body2" key={message}>{message}</Typography>
                ))}
                <Typography variant="body2" className="tabular-nums">
                  {createPlannerCompletedTargetsText(result.termination)}
                </Typography>
              </Stack>
            </Alert>
          )}
          {ownSave?.status === 'saving' && (
            <Box role="status" aria-live="polite">
              <Typography variant="body2">{PLAN_CREATION_SAVING_MESSAGE}</Typography>
              <LinearProgress aria-label={PLAN_CREATION_SAVING_MESSAGE} sx={{ mt: 1 }} />
            </Box>
          )}
          {ownSave?.status === 'no_plan' && <Alert severity="info">{PLAN_CREATION_NO_PLAN_MESSAGE}</Alert>}
          {ownSave?.status === 'failed' && <Alert severity="error">{ownSave.message}</Alert>}
          {result.warnings.length > 0 && (
            <Alert severity="warning">
              <AlertTitle>Planner警告</AlertTitle>
              <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
                {result.warnings.map((warning, index) => (
                  <li key={`${warning.kind}:${index}`}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {plannerWarningLabels[warning.kind]}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {warning.message}
                    </Typography>
                  </li>
                ))}
              </Box>
            </Alert>
          )}
        </Stack>
      )
    }
  }
}

/** What one operation's latest press shows below the primary operation (the optimization's own display aside). */
function PressDisplay({
  operation,
  slot,
  save,
  onCancel,
}: {
  operation: PlanCreationOperation
  slot: PrimaryPlanCreationState
  save: OrdinaryPlannerSaveState | null
  onCancel(): void
}) {
  switch (slot.status) {
    case 'preparing':
      return <IndeterminateStatus title={PLAN_CREATION_PREPARING_TITLE} progressLabel="作成リストの確認中" onCancel={onCancel} />
    case 'cancelled':
      return slot.reason === 'cancelled' ? <Alert severity="info">{PLAN_CREATION_CANCELLED_MESSAGE}</Alert> : null
    case 'not_started': {
      const notice = presentPlanCreationNotStarted(operation, slot.reason)
      return <Alert severity={notice.severity}>{notice.message}</Alert>
    }
    case 'ordinary_planner':
      return <OrdinaryPlannerRunDisplay operation={operation} runId={slot.runId} run={slot.run} save={save} onCancel={onCancel} />
    case 'idle':
    case 'disposed':
    case 'build_list_optimization':
      return null
  }
}

/**
 * 「生産計画の作成」 of the Build List (`docs/UI_FLOW.md` 10.2 / 10.4, `docs/PLANNER_SPEC.md` 17.2, Issue #260 PR-6C): the one primary
 * operation 「生産計画を作成」, the pre-start body that says which method it runs for the judged state (and why it cannot start), the
 * ordinary Planner detail settings, and below them the running state, the typed results, the unsaved Preview, the ordinary Planner
 * auxiliary operation where a reason or a result offers it, and the adoption confirmation.
 *
 * It renders the controller's typed state and decides nothing: the method, the support and the auxiliary offer are the Domain's and
 * the Application's, the adoption contents the Persistence inspection's.
 */
export function BuildListPlanCreationSection({
  controller,
  master,
  debugMode,
  plannerOptions,
  currentDraft,
  detailSettings,
}: {
  controller: BuildListPlanCreationController
  master: MasterDataRoot
  debugMode: boolean
  /** The ordinary Planner setting, or null while it is invalid (U7: only the ordinary Planner operations read it). */
  plannerOptions: PlannerOptions | null
  currentDraft: ProductionPlan | null
  detailSettings: ReactNode
}) {
  const descriptionId = useId()
  const invalidOptionsId = useId()
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const adoptButtonRef = useRef<HTMLButtonElement>(null)
  // Where focus returns once the change that removed its place is committed: 「この計画を採用」 after the confirmation closed, the
  // primary operation after the result was dropped. Applied in an effect (after the commit, the Dialog's own restore included), so it
  // depends neither on the press's focus events nor on animation frames.
  const pendingFocusRef = useRef<'adopt' | 'primary' | null>(null)
  const refusalRef = useRef<HTMLDivElement>(null)
  const { state, preStart, adoption, adoptionRefusal, busy } = controller
  const { primary, auxiliary } = state

  // A refused adoption dropped the Preview the focus was in: the focus moves to the notice that says why.
  useEffect(() => {
    if (adoptionRefusal !== null) refusalRef.current?.focus()
  }, [adoptionRefusal])

  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null) return
    const target = pending === 'adopt' ? adoptButtonRef.current : primaryButtonRef.current
    if (target === null) return
    pendingFocusRef.current = null
    target.focus()
  })

  const preparation = preStart.status === 'ready' ? preStart.preparation : null
  const selection = preparation?.kind === 'judged' ? preparation.selection : null
  const method = selection === null ? null : planCreationMethodOf(selection)
  const ordinaryOptionsInvalid = method === 'ordinary_planner' && plannerOptions === null
  const primaryDisabled = !controller.available || busy || method === null || ordinaryOptionsInvalid

  const auxiliaryInProgress = auxiliary.status === 'preparing' || (auxiliary.status === 'ordinary_planner' && auxiliary.run.status === 'running')
  const ordinarySaving = controller.ordinarySave?.status === 'saving'
  const auxiliaryAction = (onStart: () => void): OrdinaryPlannerAuxiliaryAction => {
    const optionsInvalid = plannerOptions === null
    const disabled = optionsInvalid || busy
    return {
      onStart,
      disabled,
      disabledReason: optionsInvalid ? ORDINARY_PLANNER_AUXILIARY_OPTIONS_INVALID_MESSAGE : busy ? PLAN_CREATION_BUSY_MESSAGE : null,
    }
  }

  // The confirmation closed without saving: focus returns to 「この計画を採用」 explicitly. The Dialog's own restore depends on the
  // focus events of the press (a click that does not focus a button, or a window without focus, records nothing to return to).
  const cancelAdoption = () => {
    pendingFocusRef.current = 'adopt'
    controller.cancelAdoption()
  }

  const discardResult = () => {
    // The result the focus was in is gone: back to the operation that starts a new calculation.
    pendingFocusRef.current = 'primary'
    controller.discardResult()
  }

  let preStartBody: ReactNode
  if (preStart.status === 'loading') {
    preStartBody = (
      <Typography id={descriptionId} role="status" variant="body2" color="text.secondary">
        {PLAN_CREATION_JUDGING_MESSAGE}
      </Typography>
    )
  } else if (preparation === null || preparation.kind !== 'judged') {
    const message = preparation?.kind === 'running_plan_exists'
      ? PLAN_CREATION_RUNNING_PLAN_MESSAGE
      : preparation?.kind === 'judgement_failed' ? PLAN_CREATION_JUDGEMENT_FAILED_MESSAGE : PLAN_CREATION_READ_FAILED_MESSAGE
    preStartBody = (
      <Alert severity={preparation?.kind === 'running_plan_exists' ? 'info' : 'error'} id={descriptionId}>
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2">{message}</Typography>
          {preparation?.kind !== 'running_plan_exists' && (
            <Button variant="outlined" color="inherit" onClick={controller.refreshPreStart} sx={{ minHeight: 44 }}>
              もう一度確認する
            </Button>
          )}
        </Stack>
      </Alert>
    )
  } else {
    const judged = preparation.selection
    switch (judged.kind) {
      case 'invalid_planner_input':
        preStartBody = (
          <Alert severity="warning" id={descriptionId}>
            <Typography variant="body2">{PLAN_CREATION_INVALID_INPUT_MESSAGE}</Typography>
            {debugMode && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                {judged.validation.issues.map(({ path, code }) => `${path} ${code}`).join(', ')}
              </Typography>
            )}
          </Alert>
        )
        break
      case 'no_valid_build_list_entry':
        preStartBody = (
          <Alert severity="info" id={descriptionId}>
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2">{PLAN_CREATION_NO_VALID_ENTRY_MESSAGE}</Typography>
              <Button component={RouterLink} to="/search" variant="outlined" color="inherit" sx={{ minHeight: 44 }}>
                候補検索へ
              </Button>
            </Stack>
          </Alert>
        )
        break
      case 'ordinary_planner':
        preStartBody = (
          <Stack id={descriptionId} spacing={0.5}>
            {PLAN_CREATION_ORDINARY_LINES.map((line) => (
              <Typography variant="body2" color="text.secondary" key={line}>{line}</Typography>
            ))}
          </Stack>
        )
        break
      case 'build_list_optimization':
        preStartBody = (
          <Stack id={descriptionId} spacing={0.5}>
            {planCreationOptimizationLines(planCreationValidEntryCount(judged)).map((line) => (
              <Typography variant="body2" color="text.secondary" key={line}>{line}</Typography>
            ))}
          </Stack>
        )
        break
      case 'build_list_optimization_unsupported':
        preStartBody = (
          <Typography id={descriptionId} variant="body2">
            {planCreationUnsupportedLead(planCreationValidEntryCount(judged))}
          </Typography>
        )
        break
    }
  }

  // The reasons the pre-start judgement gives, with the auxiliary operation where they offer it (never a standing second button).
  const preStartReasons = preparation?.kind === 'judged' && preparation.selection.kind === 'build_list_optimization_unsupported' ? (
    <Stack spacing={1.5}>
      <BuildListOptimizationUnsupportedReasonList
        reasons={preparation.selection.reasons}
        targetWeapons={preparation.plannerInput.targetWeapons}
        master={master}
        debugMode={debugMode}
      />
      {isOrdinaryPlannerAuxiliaryOfferedForPreparation(preparation) && (
        <OrdinaryPlannerAuxiliaryBlock action={auxiliaryAction(() => controller.startAuxiliaryPreStart(plannerOptions))} />
      )}
    </Stack>
  ) : null

  const optimization = primary.status === 'build_list_optimization' ? primary : null
  const optimizationOutcome = optimization === null ? null : buildListOptimizationOutcomeOf(optimization.optimization)

  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={{ xs: 1.5, md: 3 }}
        sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', md: 'flex-start' } }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>{preStartBody}</Box>
        <Button
          ref={primaryButtonRef}
          variant="contained"
          disabled={primaryDisabled}
          aria-describedby={ordinaryOptionsInvalid ? `${descriptionId} ${invalidOptionsId}` : descriptionId}
          onClick={() => controller.startPrimary(plannerOptions)}
          sx={{ minHeight: 44, px: 3, flexShrink: 0 }}
        >
          {PLAN_CREATION_PRIMARY_LABEL}
        </Button>
      </Stack>
      {ordinaryOptionsInvalid && (
        <Alert severity="warning" id={invalidOptionsId}>
          {productionPlannerOptionsInvalidMessage}
        </Alert>
      )}
      {preStartReasons}
      {currentDraft !== null && (
        <Typography variant="body2" color="text.secondary">{PLAN_CREATION_DRAFT_REPLACED_NOTE}</Typography>
      )}
      {detailSettings}

      {adoptionRefusal !== null && (
        <Alert
          ref={refusalRef}
          tabIndex={-1}
          severity={adoptionRefusal.cause === 'save_failed' || adoptionRefusal.cause === 'unknown' ? 'error' : 'warning'}
          onClose={controller.dismissAdoptionRefusal}
          slotProps={{ closeButton: { sx: { minWidth: 44, minHeight: 44 } } }}
        >
          <AlertTitle>{adoptionRefusal.title}</AlertTitle>
          <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
            {adoptionRefusal.messages.map((message) => (
              <Typography variant="body2" key={message}>{message}</Typography>
            ))}
            <Button
              variant="outlined"
              color="inherit"
              disabled={primaryDisabled}
              onClick={() => controller.startPrimary(plannerOptions)}
              sx={{ minHeight: 44 }}
            >
              もう一度計算する
            </Button>
          </Stack>
        </Alert>
      )}

      <PressDisplay operation="primary" slot={primary} save={controller.ordinarySave} onCancel={controller.cancel} />
      {optimization !== null && optimizationOutcome === null && optimization.optimization.status !== 'disposed' && (
        <BuildListOptimizationRunningPanel
          runKey={optimization.runId}
          stage={optimization.optimization.status === 'running' ? optimization.optimization.stage : null}
          onCancel={controller.cancel}
        />
      )}
      {optimization !== null && optimizationOutcome !== null && (
        <BuildListOptimizationResultPanel
          outcome={optimizationOutcome}
          startContext={optimization.startContext}
          currentDraft={currentDraft}
          master={master}
          debugMode={debugMode}
          ordinaryPlannerAuxiliary={
            isOrdinaryPlannerAuxiliaryOffered(state) ? auxiliaryAction(() => controller.startAuxiliaryFromResult(plannerOptions)) : null
          }
          onDiscard={discardResult}
          onRetry={() => controller.startPrimary(plannerOptions)}
          onAdopt={controller.requestAdoption}
          actionsDisabled={adoption.status === 'saving' || auxiliaryInProgress || ordinarySaving}
          focusHeadingOnMount
          adoptButtonRef={adoptButtonRef}
        />
      )}
      {adoption.status === 'inspecting' && (
        <Box role="status" aria-live="polite">
          <Typography variant="body2">{ADOPTION_INSPECTING_MESSAGE}</Typography>
          <LinearProgress aria-label={ADOPTION_INSPECTING_MESSAGE} sx={{ mt: 1 }} />
        </Box>
      )}
      <PressDisplay operation="ordinary_planner_auxiliary" slot={auxiliary} save={controller.ordinarySave} onCancel={controller.cancel} />

      <BuildListOptimizationAdoptionDialog
        inspection={adoption.status === 'confirming' || adoption.status === 'saving' ? adoption.inspection : null}
        startContext={optimization?.startContext ?? null}
        master={master}
        submitting={adoption.status === 'saving'}
        onCancel={cancelAdoption}
        onConfirm={controller.confirmAdoption}
      />
    </Stack>
  )
}
