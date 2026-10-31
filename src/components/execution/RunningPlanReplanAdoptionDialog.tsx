import { useId, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import type { PlanAbandonSavePointDecision } from '../../domain/execution'
import type { RunningPlanReplanAdoptionInspection } from '../../domain/execution/runningPlanReplanAdoption'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { RunningPlanReplanStart } from '../../services/execution/runningPlanReplanService'
import { savePointPositionLabel } from './executionStepPresentation'
import { ExecutionSavePointRestoreDialog } from './ExecutionSavePointRestoreDialog'
import { REPLAN_RESTORE_NOTE } from './ProductionPlanReplanAdoptionDialog'
import { SAVE_POINT_RESTORE_UNAVAILABLE_GUIDANCE } from './savePointRestoreUnavailablePresentation'
import { SavePointRestoreUnavailableNotice } from './SavePointRestoreUnavailableNotice'
import { ReplanLinkChangeItem } from './RunningPlanReplanPreviewView'
import { createReplanAdoptionConfirmationModel, RUNNING_PLAN_REPLAN_ADOPT_LABEL } from './runningPlanReplanPresentation'

type Phase = 'decide' | 'restore_confirm'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

export const RUNNING_PLAN_REPLAN_ADOPTION_DIALOG_TITLE = 'この再計画を採用しますか？'

/**
 * 「この再計画を採用」 of the running Plan replan re-optimization (`docs/UI_FLOW.md` 16.5 「5. 採用」 / 16.2, `docs/PLANNER_SPEC.md`
 * 18.8 / 16.10). Everything it states comes from the read-only adoption inspection taken when the button was pressed - the Entries
 * replaced and added, the in-progress weapons' handling, the re-derived start effect changes and whether the save point choice is
 * asked - never from the Preview. Names come from the start the result belongs to.
 *
 * - No choice: the plain confirmation, then one `adopt(null)`.
 * - Choice: 「現在地点を維持」 / 「最後のゲーム内セーブ地点へ戻す」 / 「キャンセル」. The restore first needs the game-side confirmation (the
 *   shared save point dialog); the runtime then restores only and adopts nothing. When the inspection says the restore cannot run for the
 *   old Plan - one a calculation version boundary made incompatible (Issue #335) - that choice is disabled with its reason and
 *   「現在地点を維持」 stays the decision.
 * 「キャンセル」, Escape and the backdrop write nothing, and are inert while the adoption runs. It is never the Plan-breaking warning.
 */
export function RunningPlanReplanAdoptionDialog({
  inspection,
  start,
  master,
  submitting,
  onCancel,
  onConfirm,
}: {
  inspection: RunningPlanReplanAdoptionInspection
  start: RunningPlanReplanStart
  master: MasterDataRoot
  submitting: boolean
  onCancel(): void
  onConfirm(decision: PlanAbandonSavePointDecision): void
}) {
  const [phase, setPhase] = useState<Phase>('decide')
  const titleId = useId()
  const descriptionId = useId()
  const restoreUnavailableId = useId()
  const model = useMemo(() => createReplanAdoptionConfirmationModel(inspection, start, master), [inspection, start, master])
  const close = () => {
    if (submitting) return
    setPhase('decide')
    onCancel()
  }
  const confirm = (decision: PlanAbandonSavePointDecision) => {
    setPhase('decide')
    onConfirm(decision)
  }
  const positionLabel = inspection.savePointChoiceRequired
    ? savePointPositionLabel(start.runningPlan, inspection.savePointCurrentStepId)
    : null
  const restoreUnavailable = inspection.savePointChoiceRequired && !inspection.savePointRestore.restorable
    ? inspection.savePointRestore.reason
    : null

  if (inspection.savePointChoiceRequired && inspection.savePointRestore.restorable && phase === 'restore_confirm') {
    return (
      <ExecutionSavePointRestoreDialog
        open
        submitting={submitting}
        positionLabel={positionLabel}
        note={REPLAN_RESTORE_NOTE}
        // 「キャンセル」 ends the whole adoption, not only the restore step.
        onCancel={close}
        onConfirm={() => confirm({ kind: 'restore_save_point', recordedAt: inspection.savePointRecordedAt })}
      />
    )
  }

  return (
    <Dialog open onClose={close} aria-labelledby={titleId} aria-describedby={descriptionId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>{RUNNING_PLAN_REPLAN_ADOPTION_DIALOG_TITLE}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Box id={descriptionId}>
            <Typography component="p" variant="body2">
              現在の生産計画を終了し、この計画を実行中にします。
            </Typography>
            <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5, display: 'grid', gap: 0.5 }}>
              <Typography component="li" variant="body2">現在の計画の実行履歴は残りますが、元に戻す（Undo）ことはできません。</Typography>
              <Typography component="li" variant="body2" className="tabular-nums">
                {`作成リストの候補を${model.replacementCount}件置き換え、${model.additionCount}件追加します（今回作らない目標武器の候補は変更しません）。`}
              </Typography>
              <Typography component="li" variant="body2">
                {model.linkChanges.length === 0
                  ? '目標武器の優先起点の紐付けは変わりません。'
                  : '試算で示したとおり、目標武器の優先起点の紐付けを変更・解除します。'}
              </Typography>
              <Typography component="li" variant="body2">最後のゲーム内セーブ地点の記録は新しい計画へ引き継がれません。</Typography>
            </Box>
          </Box>
          {model.inProgressWeapons.length > 0 && (
            <Box>
              <Typography component="p" variant="subtitle2">作成途中の武器</Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
                {model.inProgressWeapons.map((weapon) => (
                  <Typography component="li" variant="body2" key={weapon.key} sx={{ overflowWrap: 'anywhere' }}>
                    {weapon.name}：{weapon.moved ? '新しい計画で作成を続けます' : '作成中の状態を解除します（所持武器は削除しません）'}
                  </Typography>
                ))}
              </Box>
            </Box>
          )}
          {model.linkChanges.length > 0 && (
            <Box>
              <Typography component="p" variant="subtitle2">変わる優先起点の紐付け</Typography>
              <Stack component="ul" spacing={1} sx={{ m: 0, p: 0 }}>
                {model.linkChanges.map((change) => <ReplanLinkChangeItem key={change.key} change={change} />)}
              </Stack>
            </Box>
          )}
          {inspection.savePointChoiceRequired && (
            <Box>
              <Typography component="p" variant="body2">
                現在の生産計画は、最後のゲーム内セーブ地点より先まで進んでいます。ゲーム側の状態に合わせて選んでください。
              </Typography>
              {positionLabel !== null && (
                <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
                  最後のゲーム内セーブ地点: {positionLabel}
                </Typography>
              )}
              {restoreUnavailable === null ? (
                <Typography component="p" variant="body2" sx={{ mt: 1 }}>
                  「現在地点を維持」は現在のアプリ状態のままこの再計画を採用します。「最後のゲーム内セーブ地点へ戻す」はアプリ側をセーブ地点へ戻すだけで、この試算は採用せず、復元後にもう一度試算します。
                </Typography>
              ) : (
                <SavePointRestoreUnavailableNotice
                  id={restoreUnavailableId}
                  reason={restoreUnavailable}
                  guidance={SAVE_POINT_RESTORE_UNAVAILABLE_GUIDANCE.replanAdoption}
                />
              )}
            </Box>
          )}
          {submitting && <LinearProgress aria-label="再計画を採用中" />}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {inspection.savePointChoiceRequired ? (
          <Stack spacing={1} sx={{ width: '100%' }}>
            <Button
              variant="contained"
              disabled={submitting}
              onClick={() => {
                if (inspection.savePointChoiceRequired) confirm({ kind: 'keep_current', recordedAt: inspection.savePointRecordedAt })
              }}
              sx={{ minHeight: 44 }}
            >
              現在地点を維持
            </Button>
            <Button
              variant="outlined"
              color="warning"
              disabled={submitting || restoreUnavailable !== null}
              aria-describedby={restoreUnavailable === null ? undefined : restoreUnavailableId}
              onClick={() => {
                if (restoreUnavailable === null) setPhase('restore_confirm')
              }}
              sx={{ minHeight: 44 }}
            >
              最後のゲーム内セーブ地点へ戻す
            </Button>
            <Button onClick={close} disabled={submitting} sx={{ minHeight: 44 }}>
              キャンセル
            </Button>
          </Stack>
        ) : (
          <>
            <Button onClick={close} disabled={submitting} sx={actionSx}>
              キャンセル
            </Button>
            <Button variant="contained" disabled={submitting} onClick={() => confirm(null)} sx={actionSx}>
              {RUNNING_PLAN_REPLAN_ADOPT_LABEL}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}
