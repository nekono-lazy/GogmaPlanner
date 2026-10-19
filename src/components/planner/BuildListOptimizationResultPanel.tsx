import { useEffect, useId, useMemo, useRef, type Ref } from 'react'
import { Alert, Box, Button, Paper, Stack, Typography, type AlertColor } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlan, TargetWeapon } from '../../domain/models/publicTypes'
import {
  isOrdinaryPlannerAuxiliaryOfferedForResult,
  type BuildListOptimizationUnsupportedReason,
} from '../../domain/planner/buildListOptimization'
import type { BuildListOptimizationSessionFailure } from '../../services/planner/buildListOptimizationService'
import { BuildListOptimizationDiagnosticsDetails } from './BuildListOptimizationDiagnostics'
import { BuildListOptimizationPreviewPanel } from './BuildListOptimizationPreviewPanel'
import {
  BUILD_LIST_OPTIMIZATION_CONTRACT_VIOLATION_NOTE,
  BUILD_LIST_OPTIMIZATION_FAILURE_TITLE,
  BUILD_LIST_OPTIMIZATION_NOT_FOUND_MESSAGE,
  BUILD_LIST_OPTIMIZATION_NOT_FOUND_NOTE,
  BUILD_LIST_OPTIMIZATION_NOT_FOUND_TITLE,
  BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_MESSAGE,
  BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_NOTE,
  BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_TITLE,
  BUILD_LIST_OPTIMIZATION_UNCHANGED_MESSAGE,
  BUILD_LIST_OPTIMIZATION_UNSUPPORTED_INTRO,
  BUILD_LIST_OPTIMIZATION_UNSUPPORTED_TITLE,
  ORDINARY_PLANNER_AUXILIARY_LABEL,
  ORDINARY_PLANNER_AUXILIARY_NOTES,
  UNRESOLVED_TARGET_LABEL,
  buildListOptimizationCancelMessages,
  createBuildListOptimizationTargetResolver,
  presentBuildListOptimizationFailure,
  presentBuildListOptimizationUnsupportedReason,
  type BuildListOptimizationOutcome,
  type BuildListOptimizationPreviewStartContext,
} from './buildListOptimizationPresentation'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The ordinary Planner auxiliary operation the caller connects (`docs/PLANNER_SPEC.md` 17.2 「通常Plannerの補助導線」).
 *
 * Pass it only while the Application offers the operation: `isOrdinaryPlannerAuxiliaryOffered()` for an optimization result or a
 * primary press that started nothing, `isOrdinaryPlannerAuxiliaryOfferedForPreparation()` for a pre-start judgement. `onStart` is
 * the caller's press (`startOrdinaryPlanner()` / `startOrdinaryPlannerForPreStartUnsupported()`); nothing here calls it on its own.
 */
export interface OrdinaryPlannerAuxiliaryAction {
  onStart(): void
  /** The operation cannot start now (for example U7: the ordinary Planner setting is invalid, or a run is in progress). */
  disabled?: boolean
  /** Why it cannot start, shown next to it (never only as a tooltip). */
  disabledReason?: string | null
}

/**
 * The ordinary Planner auxiliary operation inside the reason or result that offers it - never a standing second button beside the
 * primary operation, and never instead of the reason or result it sits in.
 */
export function OrdinaryPlannerAuxiliaryBlock({ action }: { action: OrdinaryPlannerAuxiliaryAction }) {
  const notesId = useId()
  const reasonId = useId()
  const showReason = action.disabled === true && action.disabledReason !== undefined && action.disabledReason !== null
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0 }}>
      <Stack spacing={1}>
        <Typography component="p" variant="subtitle2">登録済みの候補のルートで生産計画を作る場合</Typography>
        <Box component="ul" id={notesId} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
          {ORDINARY_PLANNER_AUXILIARY_NOTES.map((note) => (
            <Typography component="li" variant="body2" color="text.secondary" key={note} sx={{ overflowWrap: 'anywhere' }}>
              {note}
            </Typography>
          ))}
        </Box>
        {showReason && (
          <Typography id={reasonId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {action.disabledReason}
          </Typography>
        )}
        <Button
          variant="outlined"
          onClick={action.onStart}
          disabled={action.disabled === true}
          aria-describedby={showReason ? `${notesId} ${reasonId}` : notesId}
          sx={{ ...actionSx, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          {ORDINARY_PLANNER_AUXILIARY_LABEL}
        </Button>
      </Stack>
    </Box>
  )
}

/**
 * The typed unsupported reasons (`docs/PLANNER_SPEC.md` 17.4): each with what it means, the Targets it names (by name, weapon type
 * and element - never by ID), what is missing and where to resolve it. Shared by a calculated `unsupported` result and the pre-start
 * judgement body (`selectPlanCreationMethod()`'s reasons). Nothing is judged here: the reasons are the Domain's, as they are.
 */
export function BuildListOptimizationUnsupportedReasonList({
  reasons,
  targetWeapons,
  master,
  debugMode = false,
}: {
  reasons: readonly BuildListOptimizationUnsupportedReason[]
  /** The Targets of the input the reasons were judged on; null when they are unknown (the Targets are then not named). */
  targetWeapons: readonly TargetWeapon[] | null
  master: MasterDataRoot
  debugMode?: boolean
}) {
  const presentations = useMemo(() => {
    const resolve = createBuildListOptimizationTargetResolver(targetWeapons, master)
    return reasons.map((reason) => ({ reason, presentation: presentBuildListOptimizationUnsupportedReason(reason, resolve) }))
  }, [reasons, targetWeapons, master])
  return (
    <Stack component="ul" spacing={1} aria-label="全体最適化を使えない理由" sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {presentations.map(({ reason, presentation }, index) => (
        <Box
          component="li"
          key={`${presentation.kind}:${index}`}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0 }}
        >
          <Stack spacing={0.75}>
            <Typography component="p" variant="subtitle1" sx={{ overflowWrap: 'anywhere' }}>
              {presentation.title}
            </Typography>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{presentation.description}</Typography>
            {presentation.missingItems.length > 0 && (
              <Box component="ul" aria-label="確定が必要な値" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
                {presentation.missingItems.map((item) => (
                  <Typography component="li" variant="body2" key={item}>{item}</Typography>
                ))}
              </Box>
            )}
            {(presentation.targets.targets.length > 0 || presentation.targets.unresolvedCount > 0) && (
              <Box>
                <Typography component="p" variant="body2" color="text.secondary">該当する目標武器</Typography>
                <Box component="ul" aria-label={`${presentation.title}（該当する目標武器）`} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
                  {presentation.targets.targets.map((target) => (
                    <Typography component="li" variant="body2" key={target.key} sx={{ overflowWrap: 'anywhere' }}>
                      {target.name}
                      <Typography component="span" variant="body2" color="text.secondary">（{target.weaponLabel}）</Typography>
                    </Typography>
                  ))}
                  {presentation.targets.unresolvedCount > 0 && (
                    <Typography component="li" variant="body2">
                      {UNRESOLVED_TARGET_LABEL}（{presentation.targets.unresolvedCount}件）
                    </Typography>
                  )}
                </Box>
              </Box>
            )}
            {presentation.links.length > 0 && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {presentation.links.map((link) => (
                  <Button key={link.to} component={RouterLink} to={link.to} variant="text" sx={{ minHeight: 44 }}>
                    {link.label}
                  </Button>
                ))}
              </Stack>
            )}
            {debugMode && (
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {reason.kind === 'invalid_planner_input'
                  ? `${reason.kind}: ${reason.issues.map(({ path, code }) => `${path} ${code}`).join(', ')}`
                  : reason.kind}
              </Typography>
            )}
          </Stack>
        </Box>
      ))}
    </Stack>
  )
}

/** Debug Mode only: the failure exactly as the session typed it (the Worker's message is shown here and nowhere else). */
function FailureDebugDetails({ failure }: { failure: BuildListOptimizationSessionFailure }) {
  const lines: string[] = [`kind: ${failure.kind}`]
  switch (failure.kind) {
    case 'calculation_error':
      lines.push(`code: ${failure.code}`, `domainCode: ${failure.domainCode ?? 'null'}`, `stage: ${failure.stage ?? 'null'}`, `message: ${failure.message}`)
      break
    case 'protocol_violation':
    case 'invalid_result':
      lines.push(`issues: ${failure.issues.join(' / ')}`)
      break
    case 'start_read_failed':
      lines.push(`code: ${failure.code}`, `message: ${failure.message}`)
      break
    case 'worker_unavailable':
    case 'worker_start_failed':
      lines.push(`message: ${failure.message}`)
      break
    case 'worker_error':
      lines.push(`message: ${failure.message ?? 'null'}`)
      break
    case 'worker_message_error':
      break
  }
  return (
    <Box component="ul" aria-label="計算失敗の詳細（Debug）" sx={{ m: 0, pl: 2.5 }}>
      {lines.map((line) => (
        <Typography component="li" variant="caption" color="text.secondary" key={line} sx={{ overflowWrap: 'anywhere' }}>
          {line}
        </Typography>
      ))}
    </Box>
  )
}

interface ResultView {
  title: string
  severity: AlertColor
  messages: string[]
}

/**
 * The result of the Build List optimization (`docs/UI_FLOW.md` 10.4 「結果別の表示」, `docs/PLANNER_SPEC.md` 17.8): `optimized`
 * is the unsaved Preview; `not_found` and `search_bound_reached` say what they mean and never that no plan exists; `unsupported`
 * lists its typed reasons; a cancellation is a notice; a calculation failure and a contract violation are errors, never turned
 * into unsupported or not found. Every outcome says the Build List and the saved Plans did not change.
 *
 * The ordinary Planner auxiliary operation appears only inside a result that offers it - `not_found`, `search_bound_reached`, and an
 * `unsupported` whose reasons all let the ordinary Planner run (the Domain's `isOrdinaryPlannerAuxiliaryOfferedForResult()`) - and
 * only when the caller passes it from the Application judgement. It never appears for `optimized`, a cancellation or a failure,
 * and nothing here starts the ordinary Planner: the operation runs only when the user presses it.
 *
 * Every operation is the caller's: `onDiscard` (closing the result or 「戻る」 of the Preview), `onRetry` (a failure that running
 * again can help), `onAdopt` (the Preview's adoption, shown only when passed). Nothing here reads or writes persisted state.
 */
export function BuildListOptimizationResultPanel({
  outcome,
  startContext,
  currentDraft,
  master,
  debugMode,
  ordinaryPlannerAuxiliary = null,
  onDiscard,
  onRetry,
  onAdopt,
  actionsDisabled = false,
  focusHeadingOnMount = false,
  adoptButtonRef,
}: {
  outcome: BuildListOptimizationOutcome
  /** The state the calculation was judged and run on (see `BuildListOptimizationPreviewStartContext`); null when unknown. */
  startContext: BuildListOptimizationPreviewStartContext | null
  /** The current Draft, for the Preview's comparison under the 17.9 conditions. */
  currentDraft: ProductionPlan | null
  master: MasterDataRoot
  debugMode: boolean
  ordinaryPlannerAuxiliary?: OrdinaryPlannerAuxiliaryAction | null
  onDiscard(): void
  onRetry?: () => void
  onAdopt?: () => void
  actionsDisabled?: boolean
  focusHeadingOnMount?: boolean
  /** The Preview's 「この計画を採用」, for the caller's focus return after its confirmation. */
  adoptButtonRef?: Ref<HTMLButtonElement>
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusOnMount = useRef(focusHeadingOnMount)
  const optimized = outcome.kind === 'result' && outcome.result.status === 'optimized'

  useEffect(() => {
    // The Preview moves focus to its own heading; every other result moves it here.
    if (focusOnMount.current && !optimized) headingRef.current?.focus()
  }, [optimized])

  if (outcome.kind === 'result' && outcome.result.status === 'optimized') {
    return (
      <BuildListOptimizationPreviewPanel
        artifact={outcome.result.artifact}
        startContext={startContext}
        currentDraft={currentDraft}
        master={master}
        debugMode={debugMode}
        onDiscard={onDiscard}
        onAdopt={onAdopt}
        actionsDisabled={actionsDisabled}
        focusHeadingOnMount={focusHeadingOnMount}
        adoptButtonRef={adoptButtonRef}
      />
    )
  }

  const view = resultViewOf(outcome)
  const failure = outcome.kind === 'failed' ? presentBuildListOptimizationFailure(outcome.failure) : null
  const auxiliary = ordinaryPlannerAuxiliary !== null && outcome.kind === 'result' && isOrdinaryPlannerAuxiliaryOfferedForResult(outcome.result)
    ? ordinaryPlannerAuxiliary
    : null
  const retry = failure !== null && failure.retryable && onRetry !== undefined ? onRetry : null

  return (
    <Paper component="section" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Typography id={headingId} ref={headingRef} tabIndex={-1} component="h3" variant="h3">
          {view.title}
        </Typography>
        <Alert severity={view.severity}>
          <Stack spacing={0.5}>
            {view.messages.map((message) => (
              <Typography variant="body2" key={message} sx={{ overflowWrap: 'anywhere' }}>{message}</Typography>
            ))}
          </Stack>
        </Alert>
        {outcome.kind === 'result' && outcome.result.status === 'unsupported' && (
          <BuildListOptimizationUnsupportedReasonList
            reasons={outcome.result.reasons}
            targetWeapons={startContext?.targetWeapons ?? null}
            master={master}
            debugMode={debugMode}
          />
        )}
        <Typography variant="body2" color="text.secondary">{BUILD_LIST_OPTIMIZATION_UNCHANGED_MESSAGE}</Typography>
        {auxiliary !== null && <OrdinaryPlannerAuxiliaryBlock action={auxiliary} />}
        {debugMode && outcome.kind === 'failed' && <FailureDebugDetails failure={outcome.failure} />}
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
          {retry !== null && (
            <Button variant="contained" disabled={actionsDisabled} onClick={retry} sx={actionSx}>
              もう一度計算する
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

function resultViewOf(outcome: BuildListOptimizationOutcome): ResultView {
  switch (outcome.kind) {
    case 'cancelled':
      return { title: '計算を中止しました', severity: 'info', messages: [buildListOptimizationCancelMessages[outcome.reason]] }
    case 'failed': {
      const failure = presentBuildListOptimizationFailure(outcome.failure)
      return {
        title: BUILD_LIST_OPTIMIZATION_FAILURE_TITLE,
        severity: 'error',
        messages: failure.category === 'contract_violation'
          ? [failure.message, BUILD_LIST_OPTIMIZATION_CONTRACT_VIOLATION_NOTE]
          : [failure.message],
      }
    }
    case 'result':
      switch (outcome.result.status) {
        case 'not_found':
          return {
            title: BUILD_LIST_OPTIMIZATION_NOT_FOUND_TITLE,
            severity: 'warning',
            messages: [BUILD_LIST_OPTIMIZATION_NOT_FOUND_MESSAGE, BUILD_LIST_OPTIMIZATION_NOT_FOUND_NOTE],
          }
        case 'search_bound_reached':
          return {
            title: BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_TITLE,
            severity: 'warning',
            messages: [BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_MESSAGE, BUILD_LIST_OPTIMIZATION_SEARCH_BOUND_NOTE],
          }
        case 'unsupported':
          return { title: BUILD_LIST_OPTIMIZATION_UNSUPPORTED_TITLE, severity: 'warning', messages: [BUILD_LIST_OPTIMIZATION_UNSUPPORTED_INTRO] }
        case 'optimized':
          // Rendered as the Preview above; never reaches here.
          return { title: '', severity: 'info', messages: [] }
      }
  }
}
