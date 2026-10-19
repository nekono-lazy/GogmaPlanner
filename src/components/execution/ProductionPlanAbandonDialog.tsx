import { useId, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material'
import type {
  PlanAbandonSavePointDecision,
  ProductionPlanAbandonmentOptions,
} from '../../domain/execution'

type Phase = 'decide' | 'restore_confirm'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * 「現在Planを破棄する」 (`docs/UI_FLOW.md` 16.2, `docs/PLANNER_SPEC.md` 16.2 /
 * 16.10). The options come from the read-only inspection taken when the user
 * pressed the button, never from the displayed snapshot: they decide whether the
 * save point choice is asked and are echoed back as the request tokens.
 *
 * - No choice: the plain confirmation, then `savePointDecision = null`.
 * - Choice: 「現在地点を維持」 / 「最後のゲーム内セーブ地点へ戻す」 / 「キャンセル」.
 *   The restore first needs the user's confirmation that the game itself went
 *   back; the restore and the abandonment are then one runtime call.
 * 「キャンセル」 never calls anything.
 */
export function ProductionPlanAbandonDialog({
  options,
  savePointPositionLabel,
  submitting,
  onCancel,
  onConfirm,
}: {
  /** `null` keeps the dialog closed. */
  options: ProductionPlanAbandonmentOptions | null
  /** Where the save point was recorded, when the choice applies. */
  savePointPositionLabel: string | null
  submitting: boolean
  onCancel(): void
  onConfirm(options: ProductionPlanAbandonmentOptions, decision: PlanAbandonSavePointDecision): void
}) {
  const [phase, setPhase] = useState<Phase>('decide')
  const [gameRestored, setGameRestored] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const reset = () => {
    setPhase('decide')
    setGameRestored(false)
  }
  const close = () => {
    if (submitting) return
    reset()
    onCancel()
  }
  const confirm = (decision: PlanAbandonSavePointDecision) => {
    if (options === null) return
    reset()
    onConfirm(options, decision)
  }

  const explanation = (
    <>
      <Typography component="p" variant="body2">
        残りの作成手順は実行されません。作成途中の武器の「作成中」は解除されます。目標武器の優先起点の紐付けは残ります。
      </Typography>
      <Typography component="p" variant="body2" sx={{ mt: 1 }}>
        破棄した作成プランは元に戻せません。
      </Typography>
    </>
  )

  let content: ReactNode = null
  let actions: ReactNode = null
  if (options !== null && !options.savePointChoiceRequired) {
    content = explanation
    actions = (
      <>
        <Button onClick={close} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" color="error" disabled={submitting} onClick={() => confirm(null)} sx={actionSx}>
          作成プランを破棄する
        </Button>
      </>
    )
  } else if (options !== null && phase === 'decide') {
    content = (
      <>
        <Typography component="p" variant="body2">
          この生産計画は、最後のゲーム内セーブ地点より先まで進んでいます。ゲーム側の状態に合わせて選んでください。
        </Typography>
        {savePointPositionLabel !== null && (
          <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
            最後のゲーム内セーブ地点: {savePointPositionLabel}
          </Typography>
        )}
        <Typography component="p" variant="body2" sx={{ mt: 1 }}>
          「現在地点を維持」は現在のアプリ状態のまま、「最後のゲーム内セーブ地点へ戻す」はアプリ側もセーブ地点へ戻してから、作成プランを破棄します。
        </Typography>
        <Box sx={{ mt: 1 }}>{explanation}</Box>
      </>
    )
    actions = (
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Button
          variant="contained"
          color="error"
          disabled={submitting}
          onClick={() => {
            if (options.savePointChoiceRequired) confirm({ kind: 'keep_current', recordedAt: options.savePointRecordedAt })
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
    )
  } else if (options !== null) {
    content = (
      <>
        <Typography component="p" variant="body2">
          先にゲームを最後のゲーム内セーブ地点から読み込み直してください。
        </Typography>
        {savePointPositionLabel !== null && (
          <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
            最後のゲーム内セーブ地点: {savePointPositionLabel}
          </Typography>
        )}
        <Typography component="p" variant="body2" sx={{ mt: 1 }}>
          アプリ側では、RNG状態・通常アーティアCounter・この計画で作成・加工した武器・関係する目標武器・計画の進行を記録地点へ戻し、そのうえで作成プランを破棄します。その後に追加した目標武器や作成リストなど、ゲーム進行と無関係なデータは戻しません。
        </Typography>
      </>
    )
    actions = (
      <>
        <Button onClick={() => { setPhase('decide'); setGameRestored(false) }} disabled={submitting} sx={actionSx}>
          戻る
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={submitting || !gameRestored}
          onClick={() => {
            if (options.savePointChoiceRequired) {
              confirm({ kind: 'restore_save_point', recordedAt: options.savePointRecordedAt })
            }
          }}
          sx={actionSx}
        >
          セーブ地点へ戻して破棄する
        </Button>
      </>
    )
  }

  return (
    <Dialog open={options !== null} onClose={close} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <DialogTitle id={titleId}>現在の生産計画を破棄します</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          {content}
        </DialogContentText>
        {options !== null && options.savePointChoiceRequired && phase === 'restore_confirm' && (
          <FormControlLabel
            sx={{ mt: 1.5, alignItems: 'flex-start' }}
            control={
              <Checkbox
                checked={gameRestored}
                onChange={(event) => setGameRestored(event.target.checked)}
                disabled={submitting}
                sx={{ mt: -0.5 }}
              />
            }
            label="ゲーム側を最後のゲーム内セーブ地点まで戻しました"
          />
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>{actions}</DialogActions>
    </Dialog>
  )
}
