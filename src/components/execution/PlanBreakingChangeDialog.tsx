import { useId, type ReactNode } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import { ExecutionSavePointRestoreDialog } from './ExecutionSavePointRestoreDialog'
import {
  formatSavePointRecordedAt,
  PLAN_BREAKING_APPROVE_LABEL,
  PLAN_BREAKING_NOT_UNDOABLE_NOTE,
  PLAN_BREAKING_REASONS_HEADING,
  PLAN_BREAKING_RESTORE_NOTE,
  PLAN_BREAKING_SAVE_POINT_CHOICE_EXPLANATION,
  PLAN_BREAKING_SAVE_POINT_CHOICE_MESSAGE,
  PLAN_BREAKING_SAVE_POINT_FALLBACK_LABEL,
  PLAN_BREAKING_WARNING_LINES,
  PLAN_BREAKING_WARNING_TITLE,
  planBreakingReasonLabels,
  type PlanBreakingChangeRequiredInspection,
} from './planBreakingChangePresentation'
import type {
  PlanBreakingChangeApprovalController,
  PlanBreakingChangePhase,
} from './usePlanBreakingChangeApproval'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

type SavePointInspection = Extract<PlanBreakingChangeRequiredInspection, { savePointChoiceRequired: true }>

export interface PlanBreakingChangeDialogProps {
  controller: PlanBreakingChangeApprovalController
  /**
   * Where the save point was recorded, e.g. 「Step 12完了時点」, when the screen
   * can resolve it from the Plan it holds; `null` falls back to the recorded
   * time alone. Display only: the decision token is the inspection's.
   */
  savePointPositionLabel?(inspection: SavePointInspection): string | null
}

/**
 * Where the save point sits: the Step the screen resolved plus the recorded
 * time, or the recorded time alone. The shared restore dialog prefixes it with
 * 「最後のゲーム内セーブ地点: 」 itself, so the choice phase adds the same prefix.
 */
function savePointPositionText(
  inspection: SavePointInspection,
  resolve: PlanBreakingChangeDialogProps['savePointPositionLabel'],
): string {
  const label = resolve?.(inspection) ?? null
  const recordedAt = `記録日時 ${formatSavePointRecordedAt(inspection.savePointRecordedAt)}`
  return label === null ? recordedAt : `${label}（${recordedAt}）`
}

/**
 * The breaking-change warning (`docs/UI_FLOW.md` 16.3) with the 16.2 save point
 * choice, shared by every guarded screen. Everything shown comes from the
 * controller's inspection: the reasons, whether the choice is asked and which
 * save point it names. 「キャンセル」 at any phase saves nothing. The game-side
 * restore confirmation is the same dialog the Navigator and the replan adoption
 * use; confirming it submits the restore decision to the one guarded save,
 * never a separate restore.
 */
export function PlanBreakingChangeDialog({ controller, savePointPositionLabel }: PlanBreakingChangeDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const { state } = controller
  if (state.status === 'idle') return null
  const submitting = state.status === 'submitting'
  const phase: PlanBreakingChangePhase = state.status === 'submitting' ? state.phase : state.status
  const { inspection, note } = state

  if (phase === 'confirming_restore') {
    return (
      <ExecutionSavePointRestoreDialog
        open
        submitting={submitting}
        positionLabel={inspection.savePointChoiceRequired ? savePointPositionText(inspection, savePointPositionLabel) : null}
        note={PLAN_BREAKING_RESTORE_NOTE}
        // 「キャンセル」 ends the whole change, not only the restore step.
        onCancel={controller.cancel}
        onConfirm={controller.confirmRestore}
      />
    )
  }

  let content: ReactNode
  let actions: ReactNode
  if (phase === 'warning') {
    content = (
      <>
        {PLAN_BREAKING_WARNING_LINES.map((line, index) => (
          <Typography component="p" variant="body2" key={line} sx={{ mt: index === 0 ? 0 : 1 }}>
            {line}
          </Typography>
        ))}
        {note !== null && (
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            {note}
          </Typography>
        )}
        <Typography component="p" variant="subtitle2" sx={{ mt: 1.5 }}>
          {PLAN_BREAKING_REASONS_HEADING}
        </Typography>
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {inspection.reasons.map((reason) => (
            <Typography component="li" variant="body2" key={reason}>
              {planBreakingReasonLabels[reason]}
            </Typography>
          ))}
        </Box>
        <Typography component="p" variant="body2" sx={{ mt: 1.5 }}>
          {PLAN_BREAKING_NOT_UNDOABLE_NOTE}
        </Typography>
      </>
    )
    actions = (
      <>
        <Button onClick={controller.cancel} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" color="error" disabled={submitting} onClick={controller.approve} sx={actionSx}>
          {PLAN_BREAKING_APPROVE_LABEL}
        </Button>
      </>
    )
  } else {
    content = (
      <>
        <Typography component="p" variant="body2">
          {PLAN_BREAKING_SAVE_POINT_CHOICE_MESSAGE}
        </Typography>
        {inspection.savePointChoiceRequired && (
          <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
            {PLAN_BREAKING_SAVE_POINT_FALLBACK_LABEL}: {savePointPositionText(inspection, savePointPositionLabel)}
          </Typography>
        )}
        <Typography component="p" variant="body2" sx={{ mt: 1 }}>
          {PLAN_BREAKING_SAVE_POINT_CHOICE_EXPLANATION}
        </Typography>
      </>
    )
    actions = (
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Button variant="contained" color="error" disabled={submitting} onClick={controller.keepCurrent} sx={{ minHeight: 44 }}>
          現在地点を維持
        </Button>
        <Button variant="outlined" color="warning" disabled={submitting} onClick={controller.chooseRestore} sx={{ minHeight: 44 }}>
          最後のゲーム内セーブ地点へ戻す
        </Button>
        <Button onClick={controller.cancel} disabled={submitting} sx={{ minHeight: 44 }}>
          キャンセル
        </Button>
      </Stack>
    )
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!submitting) controller.cancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>{PLAN_BREAKING_WARNING_TITLE}</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          {content}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>{actions}</DialogActions>
    </Dialog>
  )
}
