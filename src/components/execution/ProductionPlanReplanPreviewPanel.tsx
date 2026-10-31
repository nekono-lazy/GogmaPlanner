import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { describeReplanPreviewAdoptability, type ProductionPlanReplanPreview } from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { BuildListEntry, OwnedWeapon, ProductionPlan, TargetWeapon } from '../../domain/models/publicTypes'
import { conflictKindLabels, plannerWarningLabels } from '../../presentation/labels'
import { PreviewAdoptionActions } from '../PreviewAdoptionActions'
import { StatusChip } from '../StatusChip'
import { useKeepFocusAboveAdoptionActions } from '../useKeepFocusAboveAdoptionActions'
import { ProductionPlanContent } from '../planner/ProductionPlanContent'
import {
  createPlannerCompletedTargetsText,
  createPlannerReachedLimitMessages,
  plannerIncompleteSearchTitle,
} from '../planner/plannerSearchLimitPresentation'
import {
  productionPlannerRunningNote,
  productionPlannerRunningTitles,
} from '../planner/productionPlannerSettingsPresentation'
import { createProductionPlanSummary } from '../planner/productionPlanPresentation'
import { savePointPositionLabel } from './executionStepPresentation'
import { ProductionPlanReplanAdoptionDialog } from './ProductionPlanReplanAdoptionDialog'
import { CompletionAssignmentConflictAlert } from './CompletionAssignmentConflictAlert'
import { completionAssignmentNamesOf } from './completionAssignmentConflictPresentation'
import type { ProductionPlanReplanPreviewController, ReplanAdoptionState } from './useProductionPlanReplanPreview'

export const REPLAN_PREVIEW_TITLE = '再計画の試算（未採用）'
export const REPLAN_PREVIEW_UNCHANGED_MESSAGE =
  'まだ現在の生産計画は変更されていません。この試算は保存されておらず、画面を離れると消えます。'
export const REPLAN_NO_PLAN_MESSAGE =
  '現在の状態から作成できる生産計画はありませんでした。現在の生産計画は変更されていません。'
export const REPLAN_INCOMPLETE_NOT_ADOPTABLE_MESSAGE =
  '探索が完了していないため、この試算は採用できません。'
export const REPLAN_INVALID_RESULT_MESSAGE =
  'この試算結果は採用できません。もう一度、現在地点から再計画を試算してください。'
/** The accessible name of the Preview's sticky adoption operations (Issue #324). */
export const REPLAN_ADOPTION_ACTIONS_LABEL = '再計画の試算の採用'
export const REPLAN_ADOPTION_INSPECTING_MESSAGE = '採用の条件を確認しています。'
export const REPLAN_ADOPTION_SUBMITTING_MESSAGE = '再計画を採用しています。'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/** One figure of the current-Plan / Preview comparison (`docs/UI_FLOW.md` 16.4). */
function comparisonValue(value: number | null): string {
  return value === null ? '不明' : String(value)
}

/**
 * The optional comparison UI_FLOW 16.4 allows: the three counts side by side,
 * derived from the two Plans exactly as the overview derives them. No score
 * and no judgement: the user decides which Plan to follow.
 */
function PlanComparison({ runningPlan, previewPlan }: { runningPlan: ProductionPlan; previewPlan: ProductionPlan }) {
  const current = createProductionPlanSummary(runningPlan)
  const next = createProductionPlanSummary(previewPlan)
  const rows: readonly { label: string; current: string; next: string }[] = [
    { label: '全ステップ数', current: String(current.totalStepCount), next: String(next.totalStepCount) },
    { label: '目標武器数', current: String(current.targetWeaponCount), next: String(next.targetWeaponCount) },
    {
      label: '完成予定の目標武器数',
      current: comparisonValue(current.plannedCompletionTargetCount),
      next: comparisonValue(next.plannedCompletionTargetCount),
    },
  ]
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table
        size="small"
        aria-label="現在の生産計画と再計画の試算の比較"
        sx={{ tableLayout: 'fixed', '& th, & td': { overflowWrap: 'anywhere' } }}
      >
        <TableHead>
          <TableRow>
            <TableCell>項目</TableCell>
            <TableCell>現在の生産計画</TableCell>
            <TableCell>再計画の試算</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell component="th" scope="row">{row.label}</TableCell>
              <TableCell className="tabular-nums">{row.current}</TableCell>
              <TableCell className="tabular-nums">{row.next}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  )
}

/**
 * The Preview Plan's Conflicts, read-only. The Preview is not a persisted Plan,
 * so no participant can be compared, preferred or otherwise acted on here;
 * changing a Conflict resolution belongs to a saved Draft only.
 *
 * Normal UI names a Conflict by its typed kind and its participants by Target
 * name (`docs/UI_FLOW.md` 11.6): the recorded `reason` text and the internal
 * BuildListEntry IDs are Debug Mode only, and a participant whose Target the
 * Preview input does not name is counted, never shown as an ID.
 */
function PreviewConflicts({
  plan,
  targetWeapons,
  buildListEntries,
  debugMode,
}: {
  plan: ProductionPlan
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[] | null
  debugMode: boolean
}) {
  const headingId = useId()
  const targetNameOf = (buildListEntryId: string): string | null => {
    const targetWeaponId = buildListEntries?.find(({ id }) => id === buildListEntryId)?.targetWeaponId
    return targetWeapons.find(({ id }) => id === targetWeaponId)?.name ?? null
  }
  return (
    <Paper component="section" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Typography id={headingId} component="h3" variant="h3">
          競合（試算）
        </Typography>
        {plan.conflicts.length === 0 ? (
          <Typography variant="body2" color="text.secondary">この試算に競合はありません。</Typography>
        ) : (
          <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {plan.conflicts.map((conflict, index) => {
              const names = conflict.buildListEntryIds.map(targetNameOf)
              const unresolved = names.filter((name) => name === null).length
              return (
                <Box
                  component="li"
                  key={conflict.id}
                  sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0 }}
                >
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                      <Typography component="h4" variant="subtitle1">競合 {index + 1}</Typography>
                      <StatusChip label={conflictKindLabels[conflict.kind]} tone="info" />
                    </Stack>
                    <Box component="ul" aria-label={`競合 ${index + 1} の目標武器`} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
                      {names.map((name, nameIndex) => name !== null && (
                        <Typography component="li" variant="body2" key={`${conflict.buildListEntryIds[nameIndex]}`} sx={{ overflowWrap: 'anywhere' }}>
                          {name}
                        </Typography>
                      ))}
                      {unresolved > 0 && (
                        <Typography component="li" variant="body2">名前を確認できない目標武器（{unresolved}件）</Typography>
                      )}
                    </Box>
                    {debugMode && (
                      <Box component="ul" aria-label={`競合 ${index + 1} の詳細（Debug）`} sx={{ m: 0, pl: 2.5 }}>
                        <Typography component="li" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          {conflict.reason}
                        </Typography>
                        {conflict.buildListEntryIds.map((buildListEntryId) => (
                          <Typography component="li" variant="caption" color="text.secondary" key={buildListEntryId} sx={{ overflowWrap: 'anywhere' }}>
                            BuildListEntry ID: {buildListEntryId}
                            {conflict.recommendedBuildListEntryId === buildListEntryId && '（Planner推奨）'}
                            {conflict.selectedBuildListEntryId === buildListEntryId && '（選択中）'}
                          </Typography>
                        ))}
                      </Box>
                    )}
                  </Stack>
                </Box>
              )
            })}
          </Stack>
        )}
        <Typography variant="body2" color="text.secondary">
          試算の競合はここでは変更できません。Plannerが選択したこの試算内容を確認したうえで採用してください。
        </Typography>
      </Stack>
    </Paper>
  )
}

function PreviewResult({
  preview,
  runningPlan,
  targetWeapons,
  ownedWeapons,
  buildListEntries,
  master,
  debugMode,
}: {
  preview: ProductionPlanReplanPreview
  runningPlan: ProductionPlan | null
  targetWeapons: readonly TargetWeapon[]
  ownedWeapons: readonly Pick<OwnedWeapon, 'id' | 'name'>[]
  buildListEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[] | null
  master: MasterDataRoot
  debugMode: boolean
}) {
  const { plan, warnings, termination } = preview.result
  // The Domain classification is the only display authority: the typed
  // termination first, then the ordinary no-Plan result, then an invalid
  // result. The three never show together, and no message text is parsed.
  const adoptability = describeReplanPreviewAdoptability(preview)
  const reason = adoptability.adoptable ? null : adoptability.reason
  const incomplete = reason === 'incomplete_search'
  return (
    <Stack spacing={2}>
      {reason === 'no_plan' && <Alert severity="info">{REPLAN_NO_PLAN_MESSAGE}</Alert>}
      {incomplete && (
        // The same typed termination display as the Build List (UI_FLOW 10.1):
        // the partial result is neither shown as a Plan nor adoptable.
        <Alert severity="warning">
          <AlertTitle>{plannerIncompleteSearchTitle}</AlertTitle>
          <Stack spacing={0.5}>
            {createPlannerReachedLimitMessages(termination).map((message) => (
              <Typography variant="body2" key={message}>{message}</Typography>
            ))}
            <Typography variant="body2" className="tabular-nums">
              {createPlannerCompletedTargetsText(termination)}
            </Typography>
            <Typography variant="body2">{REPLAN_INCOMPLETE_NOT_ADOPTABLE_MESSAGE}</Typography>
          </Stack>
        </Alert>
      )}
      {reason === 'invalid_result' && (
        <Alert severity="warning">{REPLAN_INVALID_RESULT_MESSAGE}</Alert>
      )}
      {!adoptability.adoptable && adoptability.reason === 'completion_assignment_conflict' && (
        // Issue #334 (`docs/UI_FLOW.md` 12.11): the new Plan itself would make one
        // weapon the completion of two Targets, so it is never adopted.
        <CompletionAssignmentConflictAlert
          title="この再計画は採用できません"
          issues={adoptability.issues}
          names={completionAssignmentNamesOf(targetWeapons, ownedWeapons)}
          debugMode={debugMode}
        />
      )}
      {warnings.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Planner警告</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
            {warnings.map((warning, index) => (
              <li key={`${warning.kind}:${index}`}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {plannerWarningLabels[warning.kind]}
                </Typography>
                {/* The Planner's own message text is Debug Mode only; normal UI names the typed kind. */}
                {debugMode && (
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {warning.message}
                  </Typography>
                )}
              </li>
            ))}
          </Box>
        </Alert>
      )}
      {/* A partial Plan of an incomplete search is never shown as a Plan (7.2.1). */}
      {plan !== null && !incomplete && (
        <>
          {runningPlan !== null && <PlanComparison runningPlan={runningPlan} previewPlan={plan} />}
          {/* The same read-only view as a persisted Plan (UI_FLOW 11.0), over
              the transient Preview Plan. Its status reads 下書き because the
              Preview is a draft-equivalent that no runtime has started. Its
              read-only Conflict list takes the same place as the persisted
              Plan's Conflict section: before the Target routes. */}
          <ProductionPlanContent
            plan={plan}
            targetWeapons={targetWeapons}
            master={master}
            debugMode={debugMode}
            conflictSection={<PreviewConflicts plan={plan} targetWeapons={targetWeapons} buildListEntries={buildListEntries} debugMode={debugMode} />}
          />
        </>
      )}
    </Stack>
  )
}

function adoptionStatusMessage(adoption: ReplanAdoptionState): string | null {
  if (adoption.status === 'inspecting') return REPLAN_ADOPTION_INSPECTING_MESSAGE
  if (adoption.status === 'submitting') return REPLAN_ADOPTION_SUBMITTING_MESSAGE
  return null
}

/**
 * One finished Preview (`docs/UI_FLOW.md` 16.4 「Preview」). An adoptable trial - by `describeReplanPreviewAdoptability()` alone - ends
 * with the one pair of adoption operations stuck to the bottom of the viewport while it is scrolled (Issue #324): its title as the lead,
 * the caller's figures and its own Conflict count to check, the running check and saving beside the press, and a failed adoption there
 * too. A trial that cannot be adopted (an incomplete search, no Plan, an invalid result) keeps its reasons and only 「この試算を破棄」 at
 * its end, with nothing stuck and no figure that would read as a finished Plan.
 */
function CompletedReplanPreview({
  controller,
  preview,
  runningPlan,
  targetWeapons,
  ownedWeapons,
  buildListEntries,
  master,
  debugMode,
  title,
  previewSupplement,
  adoptionCheckItems,
  adoptButtonRef,
}: {
  controller: ProductionPlanReplanPreviewController
  preview: ProductionPlanReplanPreview
  runningPlan: ProductionPlan | null
  targetWeapons: readonly TargetWeapon[]
  ownedWeapons: readonly Pick<OwnedWeapon, 'id' | 'name'>[]
  buildListEntries: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[] | null
  master: MasterDataRoot
  debugMode: boolean
  title: string
  previewSupplement?: ReactNode
  adoptionCheckItems: readonly string[] | null
  adoptButtonRef: Ref<HTMLButtonElement>
}) {
  const { adoption } = controller
  const headingId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  useKeepFocusAboveAdoptionActions(bodyRef, actionsRef)
  const plan = preview.result.plan
  const adoptablePlan = describeReplanPreviewAdoptability(preview).adoptable ? plan : null
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0, borderLeftWidth: 4, borderLeftColor: 'info.main' }}
    >
      <Stack ref={bodyRef} spacing={2}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component="h2" variant="h2" sx={{ overflowWrap: 'anywhere' }}>
            {title}
          </Typography>
          <StatusChip label="未採用" tone="caution" />
        </Stack>
        <Alert severity="info">{REPLAN_PREVIEW_UNCHANGED_MESSAGE}</Alert>
        {previewSupplement}
        <PreviewResult
          preview={preview}
          runningPlan={runningPlan}
          targetWeapons={targetWeapons}
          ownedWeapons={ownedWeapons}
          buildListEntries={buildListEntries}
          master={master}
          debugMode={debugMode}
        />
        {adoptablePlan === null && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="outlined" disabled={controller.busy} onClick={controller.discard} sx={actionSx}>
              この試算を破棄
            </Button>
          </Stack>
        )}
      </Stack>
      {adoptablePlan !== null && (
        <PreviewAdoptionActions
          ref={actionsRef}
          label={REPLAN_ADOPTION_ACTIONS_LABEL}
          lead={`採用前の確認：${title}`}
          checkItems={[
            ...(adoptionCheckItems ?? []),
            adoptablePlan.conflicts.length === 0 ? '競合なし' : `競合${adoptablePlan.conflicts.length}件`,
          ]}
          attention={runningPlan === null ? null : 'あわせて確認：現在の生産計画との比較'}
          primaryAction={{ label: 'この再計画を採用', onClick: controller.requestAdoption, disabled: controller.busy }}
          primaryActionRef={adoptButtonRef}
          secondaryAction={{ label: 'この試算を破棄', onClick: controller.discard, disabled: controller.busy }}
          statusMessage={adoptionStatusMessage(adoption)}
          alert={adoption.status === 'failure' ? <Alert severity="error">{adoption.message}</Alert> : null}
        />
      )}
    </Paper>
  )
}

/**
 * The ordinary Planner replan Preview and its adoption (`docs/UI_FLOW.md` 16.4).
 * Since Issue #276 PR-6A the screens reach it only as the running Plan replan's
 * explicit auxiliary 「登録済みの候補で再計画を試算」 (`docs/UI_FLOW.md` 16.5,
 * `docs/PLANNER_SPEC.md` 18.5): the caller starts it from its own press
 * (`controller.startWith()`), so `onStart` is optional and its standing start
 * button is rendered only when it is passed. The controller owns the state
 * machine; this component only renders it and the adoption dialog.
 *
 * `runningPlan` is what the caller currently displays. It is used for the
 * comparison and for the save point position label only, never as the
 * adoption authority: the inspection and the adoption re-read the persisted
 * Plan themselves.
 */
export function ProductionPlanReplanPreviewPanel({
  controller,
  runningPlan,
  targetWeapons,
  ownedWeapons = [],
  buildListEntries = null,
  master,
  debugMode,
  startDisabled = false,
  onStart,
  title = REPLAN_PREVIEW_TITLE,
  runningTitle = productionPlannerRunningTitles.replanPreview,
  previewSupplement,
  adoptionCheckItems = null,
}: {
  controller: ProductionPlanReplanPreviewController
  runningPlan: ProductionPlan | null
  targetWeapons: readonly TargetWeapon[]
  /** The Preview input's owned weapons, to name a weapon in a refusal by name (never by ID). */
  ownedWeapons?: readonly Pick<OwnedWeapon, 'id' | 'name'>[]
  /** The Preview input's Entries, to name Conflict participants by Target (never by ID); null when unknown. */
  buildListEntries?: readonly Pick<BuildListEntry, 'id' | 'targetWeaponId'>[] | null
  master: MasterDataRoot
  debugMode: boolean
  /** The caller cannot start a Preview now (for example invalid detail settings). */
  startDisabled?: boolean
  /** The standing 「現在地点から再計画を試算」 button; omitted when the caller starts the Preview itself. */
  onStart?: () => void
  title?: string
  runningTitle?: string
  /** Shown under the 「未採用」 notice, above the result (the auxiliary's Targets the result does not make). */
  previewSupplement?: ReactNode
  /**
   * The caller's figures to check before adopting an adoptable trial (the auxiliary's completions from its shortfall, Issue #324), shown
   * in the adoption operations before the trial's own Conflict count; null for none.
   */
  adoptionCheckItems?: readonly string[] | null
}) {
  const { preview, adoption } = controller
  const progressHeadingId = useId()
  const adoptButtonRef = useRef<HTMLButtonElement>(null)
  // The adoption was checked with 「この再計画を採用」 disabled, so the dialog has no button to give the focus back to: after a cancel or a
  // failure that keeps the Preview it returns to that button in the adoption operations (Issue #324). A Preview that is gone takes none.
  const returnFocusRef = useRef(false)
  useEffect(() => {
    if (adoption.status === 'failure') returnFocusRef.current = true
  }, [adoption.status])
  useEffect(() => {
    if (!returnFocusRef.current) return
    const button = adoptButtonRef.current
    if (button === null) {
      returnFocusRef.current = false
      return
    }
    if (button.disabled) return
    returnFocusRef.current = false
    button.focus()
  })
  const cancelAdoption = () => {
    returnFocusRef.current = true
    controller.cancelAdoption()
  }
  const loading = preview.status === 'loading'
  const adoptable = preview.status === 'completed' && describeReplanPreviewAdoptability(preview.preview).adoptable
  const adoptionOptions =
    adoption.status === 'confirming' || adoption.status === 'submitting' ? adoption.options : null
  const adoptionSavePointLabel =
    adoptionOptions !== null && adoptionOptions.savePointChoiceRequired && runningPlan !== null
      ? savePointPositionLabel(runningPlan, adoptionOptions.savePointCurrentStepId)
      : null

  return (
    <Stack spacing={2}>
      {onStart !== undefined && (
        <>
          <Typography variant="body2" color="text.secondary">
            現在の確定済み状態・最新の目標武器・最新の作成リストから生産計画を試算します。試算しただけでは現在の生産計画は変更されません。
          </Typography>
          <Button
            variant="contained"
            disabled={controller.busy || startDisabled}
            onClick={onStart}
            sx={{ minHeight: 44, px: 3, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
          >
            現在地点から再計画を試算
          </Button>
        </>
      )}

      {loading && (
        <Paper
          component="section"
          variant="outlined"
          role="status"
          aria-live="polite"
          aria-labelledby={progressHeadingId}
          sx={{ p: { xs: 1.5, md: 2 }, minWidth: 0 }}
        >
          <Stack spacing={1.5}>
            <Typography id={progressHeadingId} component="h3" variant="h3">
              {runningTitle}
            </Typography>
            {/* Indeterminate like the ordinary Planner (UI_FLOW 10.0 / 16.4). */}
            <LinearProgress
              aria-label="再計画の試算中"
              variant="indeterminate"
              sx={{ '@media (prefers-reduced-motion: reduce)': { '& .MuiLinearProgress-bar': { animation: 'none' } } }}
            />
            <Typography variant="caption" color="text.secondary">
              {productionPlannerRunningNote}
            </Typography>
            <Button
              variant="outlined"
              onClick={controller.cancel}
              sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
            >
              キャンセル
            </Button>
          </Stack>
        </Paper>
      )}

      {preview.status === 'failure' && <Alert severity="error">{preview.message}</Alert>}
      {preview.status === 'notice' && <Alert severity="info">{preview.message}</Alert>}
      {/* A failed adoption is shown beside the adoption operations of the Preview it belongs to; this place is a fallback only. */}
      {adoption.status === 'failure' && !adoptable && <Alert severity="error">{adoption.message}</Alert>}

      {preview.status === 'completed' && (
        <CompletedReplanPreview
          controller={controller}
          preview={preview.preview}
          runningPlan={runningPlan}
          targetWeapons={targetWeapons}
          ownedWeapons={ownedWeapons}
          buildListEntries={buildListEntries}
          master={master}
          debugMode={debugMode}
          title={title}
          previewSupplement={previewSupplement}
          adoptionCheckItems={adoptionCheckItems}
          adoptButtonRef={adoptButtonRef}
        />
      )}

      {/* Mounted only while an inspection result exists: the caller may re-read
          its Plan right after the runtime answered, and a dialog unmounted in
          the middle of its exit transition would leave the page aria-hidden. */}
      {adoptionOptions !== null && (
        <ProductionPlanReplanAdoptionDialog
          options={adoptionOptions}
          savePointPositionLabel={adoptionSavePointLabel}
          submitting={adoption.status === 'submitting'}
          onCancel={cancelAdoption}
          onConfirm={controller.adopt}
        />
      )}
    </Stack>
  )
}
