import { useId, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import type {
  PlanAbandonSavePointDecision,
  ProductionPlanReplanAdoptionOptions,
} from '../../domain/execution'
import { ExecutionSavePointRestoreDialog } from './ExecutionSavePointRestoreDialog'

type Phase = 'decide' | 'restore_confirm'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

export const REPLAN_RESTORE_NOTE =
  'セーブ地点へ戻した後、この試算は採用されません。復元後の状態から、もう一度再計画を試算してください。'

/**
 * 「この再計画を採用」 (`docs/UI_FLOW.md` 16.4 / 16.2, `docs/PLANNER_SPEC.md`
 * 16.8 / 16.10). The options come from the read-only inspection taken when the
 * user pressed the button, never from the displayed Preview: they decide
 * whether the save point choice is asked and are echoed back as the decision
 * tokens.
 *
 * - No choice: the plain confirmation, then `savePointDecision = null`.
 * - Choice: 「現在地点を維持」 / 「最後のゲーム内セーブ地点へ戻す」 / 「キャンセル」.
 *   The restore first needs the user's confirmation that the game itself went
 *   back (the shared save point dialog); the runtime then restores only and
 *   adopts nothing.
 * 「キャンセル」 never calls anything.
 */
export function ProductionPlanReplanAdoptionDialog({
  options,
  savePointPositionLabel,
  submitting,
  onCancel,
  onConfirm,
}: {
  /** `null` keeps the dialog closed. */
  options: ProductionPlanReplanAdoptionOptions | null
  /** Where the save point was recorded, when the choice applies. */
  savePointPositionLabel: string | null
  submitting: boolean
  onCancel(): void
  onConfirm(decision: PlanAbandonSavePointDecision): void
}) {
  const [phase, setPhase] = useState<Phase>('decide')
  const titleId = useId()
  const descriptionId = useId()
  const close = () => {
    if (submitting) return
    setPhase('decide')
    onCancel()
  }
  const confirm = (decision: PlanAbandonSavePointDecision) => {
    if (options === null) return
    setPhase('decide')
    onConfirm(decision)
  }
  const choiceRequired = options !== null && options.savePointChoiceRequired

  if (options !== null && options.savePointChoiceRequired && phase === 'restore_confirm') {
    return (
      <ExecutionSavePointRestoreDialog
        open
        submitting={submitting}
        positionLabel={savePointPositionLabel}
        note={REPLAN_RESTORE_NOTE}
        // 「キャンセル」 ends the whole adoption, not only the restore step.
        onCancel={close}
        onConfirm={() => confirm({ kind: 'restore_save_point', recordedAt: options.savePointRecordedAt })}
      />
    )
  }

  return (
    <Dialog open={options !== null} onClose={close} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <DialogTitle id={titleId}>この再計画を採用します</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            現在の生産計画を終了し、この再計画を新しい実行中の生産計画にします。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            現在の計画の実行履歴は残ります。採用は元に戻せません。
          </Typography>
          {choiceRequired && (
            <>
              <Typography component="p" variant="body2" sx={{ mt: 1 }}>
                現在の生産計画は、最後のゲーム内セーブ地点より先まで進んでいます。ゲーム側の状態に合わせて選んでください。
              </Typography>
              {savePointPositionLabel !== null && (
                <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
                  最後のゲーム内セーブ地点: {savePointPositionLabel}
                </Typography>
              )}
              <Typography component="p" variant="body2" sx={{ mt: 1 }}>
                「現在地点を維持」は現在のアプリ状態のままこの再計画を採用します。「最後のゲーム内セーブ地点へ戻す」はアプリ側をセーブ地点へ戻すだけで、この試算は採用せず、復元後にもう一度試算します。
              </Typography>
            </>
          )}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {choiceRequired ? (
          <Stack spacing={1} sx={{ width: '100%' }}>
            <Button
              variant="contained"
              disabled={submitting}
              onClick={() => {
                if (options.savePointChoiceRequired) {
                  confirm({ kind: 'keep_current', recordedAt: options.savePointRecordedAt })
                }
              }}
              sx={{ minHeight: 44 }}
            >
              現在地点を維持
            </Button>
            <Button
              variant="outlined"
              color="warning"
              disabled={submitting}
              onClick={() => setPhase('restore_confirm')}
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
              この再計画を採用
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}
