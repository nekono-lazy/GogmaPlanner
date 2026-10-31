import { useId, useMemo } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { TargetWeaponId } from '../../domain/models/publicTypes'
import type { RunningPlanReplanPreStartInspection } from '../../services/execution/runningPlanReplanPreStartService'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { StatusChip } from '../StatusChip'
import { UnsupportedReasonViewList } from '../planner/BuildListOptimizationResultPanel'
import { createBuildListOptimizationTargetResolver, unsupportedReasonDebugText } from '../planner/buildListOptimizationPresentation'
import { TargetName, TargetNameList } from '../planner/BuildListOptimizationPreviewPanel'
import {
  createReplanTargetConfirmationModel,
  presentRunningPlanReplanRefusal,
  presentRunningPlanReplanUnsupportedReason,
  replanSelectionSummaryText,
  replanTargetLabel,
  RUNNING_PLAN_REPLAN_EMPTY_ABANDON_NOTE,
  RUNNING_PLAN_REPLAN_EMPTY_MESSAGE,
  RUNNING_PLAN_REPLAN_EXCLUSION_NOTE,
  RUNNING_PLAN_REPLAN_LINK_NOTE,
  RUNNING_PLAN_REPLAN_PRE_START_UNSUPPORTED_NOTE,
  RUNNING_PLAN_REPLAN_PRE_START_UNSUPPORTED_TITLE,
  RUNNING_PLAN_REPLAN_SELECTION_LOCKED_NOTE,
  RUNNING_PLAN_REPLAN_START_LABEL,
  RUNNING_PLAN_REPLAN_TARGETS_TITLE,
  type ReplanGuidance,
  type ReplanTargetItem,
} from './runningPlanReplanPresentation'
import { EXECUTION_HISTORY_UNCONVERTIBLE_MESSAGE } from './executionStepPresentation'
import type { RunningPlanReplanController } from './useRunningPlanReplan'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/** One selectable Target: the whole row is the label, at least 44px high, the name wrapping instead of overflowing. */
function TargetCheckboxRow({
  item,
  disabled,
  onChange,
}: {
  item: ReplanTargetItem
  disabled: boolean
  onChange(selected: boolean): void
}) {
  return (
    <Box component="li" sx={{ listStyle: 'none', minWidth: 0 }}>
      <FormControlLabel
        disabled={disabled}
        control={<Checkbox checked={item.selected} onChange={(event) => onChange(event.target.checked)} />}
        label={(
          <Typography component="span" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {item.target === null ? replanTargetLabel(null) : <TargetName target={item.target} />}
          </Typography>
        )}
        sx={{ m: 0, minHeight: 44, width: '100%', alignItems: 'center', '& .MuiFormControlLabel-label': { minWidth: 0, flex: 1 } }}
      />
    </Box>
  )
}

/**
 * One category of the confirmation as a `fieldset` with its `legend` (`docs/UI_FLOW.md` 16.5 「1. 目標の確認」): the name and the
 * count of the category, a short meaning, and the Targets as checkbox rows in one column at every width.
 */
function TargetFieldset({
  legend,
  description,
  items,
  disabled,
  emptyText,
  onChange,
}: {
  legend: string
  description: string
  items: readonly ReplanTargetItem[]
  disabled: boolean
  emptyText: string
  onChange(targetWeaponId: TargetWeaponId, selected: boolean): void
}) {
  const descriptionId = useId()
  return (
    <Box
      component="fieldset"
      aria-describedby={descriptionId}
      sx={{ m: 0, p: { xs: 1.5, md: 2 }, minWidth: 0, border: 1, borderColor: 'divider', borderRadius: 1 }}
    >
      <Typography component="legend" variant="subtitle1" sx={{ px: 0.5 }}>
        {legend}
      </Typography>
      <Typography id={descriptionId} variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {description}
      </Typography>
      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{emptyText}</Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, mt: 0.5, p: 0, display: 'grid' }}>
          {items.map((item) => (
            <TargetCheckboxRow key={item.key} item={item} disabled={disabled} onChange={(selected) => onChange(item.key, selected)} />
          ))}
        </Box>
      )}
    </Box>
  )
}

/** A guidance block with its links (an availability reason, a refusal). */
export function ReplanGuidanceBlock({ guidance }: { guidance: ReplanGuidance }) {
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Typography component="p" variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>{guidance.title}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{guidance.description}</Typography>
      {guidance.links.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {guidance.links.map((link) => (
            <Button key={link.to} component={RouterLink} to={link.to} variant="outlined" color="inherit" sx={{ minHeight: 44 }}>
              {link.label}
            </Button>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

/** A refused read or start: why no confirmation or calculation is offered, and where to go (18.5 / 18.2). */
export function ReplanRefusalAlert({
  refusal,
  onResetSelection,
  debugMode,
}: {
  refusal: Extract<RunningPlanReplanPreStartInspection, { kind: 'refused' }>['refusal']
  onResetSelection?: () => void
  debugMode: boolean
}) {
  const presentation = presentRunningPlanReplanRefusal(refusal)
  return (
    <Alert severity="warning">
      <AlertTitle>{presentation.title}</AlertTitle>
      <Stack spacing={1.5}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{presentation.description}</Typography>
        {presentation.reasons.length > 0 && (
          <Stack component="ul" spacing={1.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {presentation.reasons.map((reason) => (
              <Box component="li" key={reason.title}>
                <ReplanGuidanceBlock guidance={reason} />
              </Box>
            ))}
          </Stack>
        )}
        {presentation.links.length > 0 && <ReplanGuidanceBlock guidance={{ title: '', description: '', links: presentation.links }} />}
        {refusal.kind === 'invalid_selection' && onResetSelection !== undefined && (
          <Button variant="outlined" color="inherit" onClick={onResetSelection} sx={{ minHeight: 44, alignSelf: 'flex-start' }}>
            選択をやり直す
          </Button>
        )}
        {debugMode && (
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {refusal.kind === 'unavailable' ? `unavailable: ${refusal.reasons.map(({ kind }) => kind).join(', ')}` : refusal.kind}
          </Typography>
        )}
      </Stack>
    </Alert>
  )
}

/**
 * 「1. 目標の確認」 of the running Plan replan (`docs/UI_FLOW.md` 16.5, `docs/PLANNER_SPEC.md` 18.2 / 18.5): shown only after the
 * user opened the replan. The categories, counts, reasons and the pre-start input conditions are the controller's read-only
 * inspection (PR-2's classification and Stage 0R over one read); the checkboxes edit the runtime-only selection, and every change
 * reads again. Nothing here is the start authority: 「この内容で再計画を試算」 starts the session, which reads and judges afresh.
 */
export function RunningPlanReplanTargetConfirmation({
  controller,
  master,
  debugMode,
}: {
  controller: RunningPlanReplanController
  master: MasterDataRoot
  debugMode: boolean
}) {
  const headingId = useId()
  const summaryId = useId()
  const emptyId = useId()
  const { targets } = controller
  const shown = targets.status === 'loaded'
    ? targets.inspection
    : targets.status === 'loading' ? targets.previous : null
  const ready = shown !== null && shown.kind === 'ready' ? shown : null
  const model = useMemo(() => (ready === null ? null : createReplanTargetConfirmationModel(ready.start, master)), [ready, master])
  const reasonViews = useMemo(() => {
    if (ready === null || ready.inputConditions.kind !== 'unsupported') return []
    const resolve = createBuildListOptimizationTargetResolver(ready.start.plannerInput.targetWeapons, master)
    return ready.inputConditions.reasons.map((reason, index) => ({
      key: `${reason.kind}:${index}`,
      presentation: presentRunningPlanReplanUnsupportedReason(reason, resolve),
      debugText: unsupportedReasonDebugText(reason),
    }))
  }, [ready, master])
  const loading = targets.status === 'loading'
  const selectionDisabled = controller.busy
  const empty = model !== null && model.replanTargetCount === 0
  const startDisabled = controller.busy || loading || model === null || empty

  if (targets.status === 'closed') return null
  if (targets.status === 'loading' && targets.previous === null) {
    return (
      <Typography role="status" variant="body2" color="text.secondary">
        現在の生産計画と作成リストの状態を確認しています。
      </Typography>
    )
  }
  if (targets.status === 'loaded' && targets.inspection.kind !== 'ready') {
    const { inspection } = targets
    if (inspection.kind === 'refused') {
      return <ReplanRefusalAlert refusal={inspection.refusal} onResetSelection={controller.resetSelection} debugMode={debugMode} />
    }
    return (
      <Alert severity="error">
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2">
            {inspection.kind === 'read_failed'
              ? inspection.code === 'execution_history_unconvertible'
                ? EXECUTION_HISTORY_UNCONVERTIBLE_MESSAGE
                : '現在の生産計画と作成リストの状態を読み込めなかったため、再計画する目標武器を確認できません。'
              : '再計画の条件を確認できませんでした。'}
          </Typography>
          {debugMode && (
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              {inspection.kind === 'read_failed' ? `${inspection.code}: ${inspection.message}` : inspection.message}
            </Typography>
          )}
          <Button variant="outlined" color="inherit" onClick={controller.reloadTargets} sx={{ minHeight: 44 }}>
            もう一度確認する
          </Button>
        </Stack>
      </Alert>
    )
  }
  if (model === null) return null

  return (
    <Stack component="section" aria-labelledby={headingId} spacing={1.5} sx={{ minWidth: 0 }}>
      <Typography id={headingId} component="h3" variant="h3">
        {RUNNING_PLAN_REPLAN_TARGETS_TITLE}
      </Typography>
      <TargetFieldset
        legend={`続けて作る（${model.continuing.length}）`}
        description={`現在の生産計画でまだ完成していない目標武器です。外すと、今回の再計画では作りません。${RUNNING_PLAN_REPLAN_EXCLUSION_NOTE}`}
        items={model.continuing}
        disabled={selectionDisabled}
        emptyText="続けて作る目標武器はありません。"
        onChange={(id, selected) => controller.setExcluded(id, !selected)}
      />
      <TargetFieldset
        legend={`取り込める（${model.candidates.length}）`}
        description="作成リストに候補があり、現在の生産計画では作らない目標武器です。選ぶと今回の再計画に取り込みます。"
        items={model.candidates}
        disabled={selectionDisabled}
        emptyText="取り込める目標武器はありません。"
        onChange={(id, selected) => controller.setIncluded(id, selected)}
      />
      {(model.completed.targets.length > 0 || model.completed.unresolvedCount > 0) && (
        <DisclosureAccordion title={`完成済み（${model.completed.targets.length + model.completed.unresolvedCount}）`} headingLevel="h4">
          <Typography variant="body2" color="text.secondary">現在の生産計画で完成した目標武器です（読み取り専用）。</Typography>
          <TargetNameList list={model.completed} label="完成済みの目標武器" />
        </DisclosureAccordion>
      )}
      {model.notEligible.length > 0 && (
        <DisclosureAccordion title={`対象外（${model.notEligible.length}）`} headingLevel="h4">
          <Typography variant="body2" color="text.secondary">現在の生産計画で未完成ですが、今は再計画に使えない目標武器です（読み取り専用）。</Typography>
          <Box component="ul" aria-label="対象外の目標武器" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
            {model.notEligible.map((item) => (
              <Typography component="li" variant="body2" key={item.key} sx={{ overflowWrap: 'anywhere' }}>
                {item.target === null ? replanTargetLabel(null) : <TargetName target={item.target} />}
                {' '}
                <StatusChip component="span" label={item.reasonLabel} tone="neutral" />
              </Typography>
            ))}
          </Box>
        </DisclosureAccordion>
      )}
      <Typography id={summaryId} variant="body2" role="status" className="tabular-nums" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
        {loading ? '選択内容を確認しています。' : replanSelectionSummaryText(model)}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{RUNNING_PLAN_REPLAN_LINK_NOTE}</Typography>
      {reasonViews.length > 0 && !empty && (
        <Alert severity="warning">
          <AlertTitle>{RUNNING_PLAN_REPLAN_PRE_START_UNSUPPORTED_TITLE}</AlertTitle>
          <Stack spacing={1}>
            <UnsupportedReasonViewList views={reasonViews} label="再計画を使えない理由" debugMode={debugMode} />
            <Typography variant="body2">{RUNNING_PLAN_REPLAN_PRE_START_UNSUPPORTED_NOTE}</Typography>
          </Stack>
        </Alert>
      )}
      {empty && (
        <Alert severity="info" id={emptyId}>
          <Stack spacing={1}>
            <Typography variant="body2">{RUNNING_PLAN_REPLAN_EMPTY_MESSAGE}</Typography>
            <Typography variant="body2">{RUNNING_PLAN_REPLAN_EMPTY_ABANDON_NOTE}</Typography>
            {ready !== null && (
              <Button
                component={RouterLink}
                to={`/plans/${ready.start.runningPlanToken.planId}/run`}
                variant="outlined"
                color="inherit"
                sx={{ minHeight: 44, alignSelf: 'flex-start' }}
              >
                実行ナビを開く
              </Button>
            )}
          </Stack>
        </Alert>
      )}
      {controller.calculating && (
        <Typography variant="body2" color="text.secondary">{RUNNING_PLAN_REPLAN_SELECTION_LOCKED_NOTE}</Typography>
      )}
      <Button
        variant="contained"
        disabled={startDisabled}
        onClick={controller.startCalculation}
        aria-describedby={empty ? `${summaryId} ${emptyId}` : summaryId}
        sx={{ ...actionSx, px: 3, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
      >
        {RUNNING_PLAN_REPLAN_START_LABEL}
      </Button>
    </Stack>
  )
}
