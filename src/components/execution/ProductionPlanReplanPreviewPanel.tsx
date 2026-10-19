import { useId } from 'react'
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
import type { ProductionPlan, TargetWeapon } from '../../domain/models/publicTypes'
import { conflictKindLabels, plannerWarningLabels } from '../../presentation/labels'
import { StatusChip } from '../StatusChip'
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
import type { ProductionPlanReplanPreviewController } from './useProductionPlanReplanPreview'

export const REPLAN_PREVIEW_TITLE = '再計画の試算（未採用）'
export const REPLAN_PREVIEW_UNCHANGED_MESSAGE =
  'まだ現在の生産計画は変更されていません。この試算は保存されておらず、画面を離れると消えます。'
export const REPLAN_NO_PLAN_MESSAGE =
  '現在の状態から作成できる生産計画はありませんでした。現在の生産計画は変更されていません。'
export const REPLAN_INCOMPLETE_NOT_ADOPTABLE_MESSAGE =
  '探索が完了していないため、この試算は採用できません。'
export const REPLAN_INVALID_RESULT_MESSAGE =
  'この試算結果は採用できません。もう一度、現在地点から再計画を試算してください。'

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
 */
function PreviewConflicts({ plan }: { plan: ProductionPlan }) {
  const headingId = useId()
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
            {plan.conflicts.map((conflict, index) => (
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
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{conflict.reason}</Typography>
                  <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
                    {conflict.buildListEntryIds.map((buildListEntryId) => (
                      <Typography component="li" variant="body2" key={buildListEntryId} sx={{ overflowWrap: 'anywhere' }}>
                        BuildListEntry ID: {buildListEntryId}
                        {conflict.recommendedBuildListEntryId === buildListEntryId && '（Planner推奨）'}
                        {conflict.selectedBuildListEntryId === buildListEntryId && '（選択中）'}
                      </Typography>
                    ))}
                  </Box>
                </Stack>
              </Box>
            ))}
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
  master,
  debugMode,
}: {
  preview: ProductionPlanReplanPreview
  runningPlan: ProductionPlan | null
  targetWeapons: readonly TargetWeapon[]
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
      {warnings.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Planner警告</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
            {warnings.map((warning, index) => (
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
            conflictSection={<PreviewConflicts plan={plan} />}
          />
        </>
      )}
    </Stack>
  )
}

/**
 * 「現在地点から再計画を試算」 and its Preview (`docs/UI_FLOW.md` 16.4), shared
 * by the Build List and the Production Plan page. The controller owns the
 * state machine; this component only renders it and the adoption dialog.
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
  master,
  debugMode,
  startDisabled = false,
  onStart,
}: {
  controller: ProductionPlanReplanPreviewController
  runningPlan: ProductionPlan | null
  targetWeapons: readonly TargetWeapon[]
  master: MasterDataRoot
  debugMode: boolean
  /** The caller cannot start a Preview now (for example invalid detail settings). */
  startDisabled?: boolean
  onStart(): void
}) {
  const { preview, adoption } = controller
  const progressHeadingId = useId()
  const previewHeadingId = useId()
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
              {productionPlannerRunningTitles.replanPreview}
            </Typography>
            {/* Indeterminate like the ordinary Planner (UI_FLOW 10.0 / 16.4). */}
            <LinearProgress aria-label="再計画の試算中" variant="indeterminate" />
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
      {adoption.status === 'failure' && <Alert severity="error">{adoption.message}</Alert>}

      {preview.status === 'completed' && (
        <Paper
          component="section"
          variant="outlined"
          aria-labelledby={previewHeadingId}
          sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0, borderLeftWidth: 4, borderLeftColor: 'info.main' }}
        >
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography id={previewHeadingId} component="h2" variant="h2">
                {REPLAN_PREVIEW_TITLE}
              </Typography>
              <StatusChip label="未採用" tone="caution" />
            </Stack>
            <Alert severity="info">{REPLAN_PREVIEW_UNCHANGED_MESSAGE}</Alert>
            <PreviewResult
              preview={preview.preview}
              runningPlan={runningPlan}
              targetWeapons={targetWeapons}
              master={master}
              debugMode={debugMode}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              {adoptable && (
                <Button
                  variant="contained"
                  disabled={controller.busy}
                  onClick={controller.requestAdoption}
                  sx={actionSx}
                >
                  この再計画を採用
                </Button>
              )}
              <Button variant="outlined" disabled={controller.busy} onClick={controller.discard} sx={actionSx}>
                この試算を破棄
              </Button>
            </Stack>
            {adoption.status === 'inspecting' && (
              <Typography variant="body2" role="status">採用の条件を確認しています。</Typography>
            )}
            {adoption.status === 'submitting' && (
              <Typography variant="body2" role="status">再計画を採用しています。</Typography>
            )}
          </Stack>
        </Paper>
      )}

      {/* Mounted only while an inspection result exists: the caller may re-read
          its Plan right after the runtime answered, and a dialog unmounted in
          the middle of its exit transition would leave the page aria-hidden. */}
      {adoptionOptions !== null && (
        <ProductionPlanReplanAdoptionDialog
          options={adoptionOptions}
          savePointPositionLabel={adoptionSavePointLabel}
          submitting={adoption.status === 'submitting'}
          onCancel={controller.cancelAdoption}
          onConfirm={controller.adopt}
        />
      )}
    </Stack>
  )
}
