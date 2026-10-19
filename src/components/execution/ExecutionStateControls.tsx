import { useId, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import type {
  ExecutionSavePointRestoreAvailability,
  ExecutionUndoAvailability,
  PlanAbandonSavePointDecision,
  ProductionPlanAbandonmentOptions,
} from '../../domain/execution'
import type { ExecutionHistoryId, ExecutionSavePoint, ProductionPlan } from '../../domain/models/publicTypes'
import { ExecutionSavePointRestoreDialog } from './ExecutionSavePointRestoreDialog'
import {
  executionUndoControlPresentation,
  executionUndoTargetLabel,
  SAVE_POINT_UNSAFE_MESSAGE,
  savePointPositionLabel,
  type ExecutionUndoControlPresentation,
} from './executionStepPresentation'
import { ProductionPlanAbandonDialog } from './ProductionPlanAbandonDialog'

const buttonSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

function formatRecordedAt(recordedAt: string): string {
  const date = new Date(recordedAt)
  return Number.isNaN(date.getTime()) ? recordedAt : date.toLocaleString('ja-JP')
}

/** 「ゲーム内セーブ済みとして記録」 and its overwrite confirmation (UI_FLOW 12.8). */
function RecordSavePointDialog({
  open,
  overwrite,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean
  overwrite: boolean
  submitting: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>
        {overwrite ? '最後のゲーム内セーブ地点を更新します' : 'ゲーム内セーブ地点を記録します'}
      </DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          {overwrite && (
            <Typography component="p" variant="body2" sx={{ mb: 1 }}>
              現在記録されているセーブ地点は上書きされます。
            </Typography>
          )}
          <Typography component="p" variant="body2">
            ゲーム側で現在の地点を保存したことを確認してください。アプリはゲームのセーブを自動では判別しません。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            記録しても作成手順は進みません。
          </Typography>
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={{ minHeight: 44 }}>
          キャンセル
        </Button>
        <Button variant="contained" disabled={submitting} onClick={onConfirm} sx={{ minHeight: 44 }}>
          {overwrite ? '現在地点で上書き' : 'ゲーム内セーブ済みとして記録'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * Undo of the latest ExecutionHistory (UI_FLOW 12.7, PLANNER_SPEC 16.16).
 *
 * The title, the confirm label and the record-specific notes come from the
 * shared presentation, so an `operation_uncertain` record is confirmed in its
 * own words. The runtime call is the same one every other record uses.
 */
function UndoDialog({
  open,
  presentation,
  targetLabel,
  deletesSavePoint,
  terminal,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean
  presentation: ExecutionUndoControlPresentation
  targetLabel: string
  deletesSavePoint: boolean
  terminal: boolean
  submitting: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>{presentation.dialogTitle}</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2" sx={{ fontWeight: 700 }}>
            Undoはツール上の状態だけを戻します。ゲーム内で行った操作は元に戻りません。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
            戻す操作: {targetLabel}
          </Typography>
          {presentation.notes.map((note) => (
            <Typography key={note} component="p" variant="body2" sx={{ mt: 1 }}>
              {note}
            </Typography>
          ))}
          {terminal && (
            <Typography component="p" variant="body2" sx={{ mt: 1 }}>
              終了した生産計画は、この操作の前の状態に戻ります。
            </Typography>
          )}
          {deletesSavePoint && (
            <Typography component="p" variant="body2" sx={{ mt: 1 }}>
              この操作をUndoすると、ゲーム内セーブ地点の記録も削除されます。
            </Typography>
          )}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={{ minHeight: 44 }}>
          キャンセル
        </Button>
        <Button variant="contained" color="warning" disabled={submitting} onClick={onConfirm} sx={{ minHeight: 44 }}>
          {presentation.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * 「実行状態の管理」: Undo, the game save point and the ordinary Plan
 * abandonment (`docs/UI_FLOW.md` 12.7 / 12.8 / 16.2), kept in their own section
 * below the Step's game actions so none of them is tapped by mistake.
 *
 * Every availability shown here is display only, from the Navigator's read.
 * Each runtime re-derives its own premises inside its transaction and is the
 * authority that accepts or refuses the request.
 */
export function ExecutionStateControls({
  plan,
  savePoint,
  undo,
  savePointRestore,
  canRecordSavePoint,
  showsSavePoint,
  showsSavePointRestore,
  showsAbandon,
  submitting,
  onRecordSavePoint,
  onRestoreSavePoint,
  onUndo,
  onInspectAbandonment,
  onAbandon,
}: {
  plan: ProductionPlan
  savePoint: ExecutionSavePoint | null
  undo: ExecutionUndoAvailability
  savePointRestore: ExecutionSavePointRestoreAvailability
  /** 「ゲーム内セーブ済みとして記録」 is enabled: an active, executable Plan. */
  canRecordSavePoint: boolean
  /** The save point status and record control are shown (a running Plan). */
  showsSavePoint: boolean
  /** The ordinary restore control is shown; the `operation_uncertain` recovery owns its own. */
  showsSavePointRestore: boolean
  showsAbandon: boolean
  submitting: boolean
  onRecordSavePoint(): void
  onRestoreSavePoint(recordedAt: string): void
  onUndo(executionHistoryId: ExecutionHistoryId): void
  /** The read-only abandonment inspection; `null` when it failed (the page shows why). */
  onInspectAbandonment(): Promise<ProductionPlanAbandonmentOptions | null>
  onAbandon(options: ProductionPlanAbandonmentOptions, decision: PlanAbandonSavePointDecision): void
}) {
  const [recordOpen, setRecordOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [undoOpen, setUndoOpen] = useState(false)
  const [abandonOptions, setAbandonOptions] = useState<ProductionPlanAbandonmentOptions | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const busy = submitting || inspecting

  const savePointLabel = savePoint === null
    ? null
    : savePointPositionLabel(plan, savePoint.productionPlan.currentStepId)
  const abandonSavePointLabel = abandonOptions !== null && abandonOptions.savePointChoiceRequired
    ? savePointPositionLabel(plan, abandonOptions.savePointCurrentStepId)
    : null
  const showsUndo = undo.kind === 'available'
  // The record itself decides how the control introduces itself; every other
  // record keeps the generic wording.
  const undoPresentation = undo.kind === 'available'
    ? executionUndoControlPresentation(undo.history)
    : null
  if (!showsSavePoint && !showsUndo && !showsAbandon) return null

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label="実行状態の管理"
      sx={{ p: { xs: 1.5, sm: 2 }, bgcolor: 'background.default' }}
    >
      <Stack spacing={1.5}>
        <Typography variant="subtitle2" component="h2" color="text.secondary">
          実行状態の管理
        </Typography>

        {showsSavePoint && (
          <Box role="group" aria-label="ゲーム内セーブ地点">
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                アプリはゲームのセーブを自動判別しません。ゲーム側でセーブしたことを確認してから記録してください。
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                最後のゲーム内セーブ地点: {savePointLabel ?? '記録なし'}
              </Typography>
              {savePoint !== null && (
                <Typography variant="caption" color="text.secondary">
                  記録日時: {formatRecordedAt(savePoint.recordedAt)}
                </Typography>
              )}
              {showsSavePointRestore && savePointRestore.kind === 'invalid' && (
                <Alert severity="warning">{SAVE_POINT_UNSAFE_MESSAGE}</Alert>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Button
                  variant="outlined"
                  color="inherit"
                  disabled={busy || !canRecordSavePoint}
                  onClick={() => setRecordOpen(true)}
                  sx={buttonSx}
                >
                  ゲーム内セーブ済みとして記録
                </Button>
                {showsSavePointRestore && savePointRestore.kind === 'available' && (
                  <Button
                    variant="outlined"
                    color="warning"
                    disabled={busy}
                    onClick={() => setRestoreOpen(true)}
                    sx={buttonSx}
                  >
                    最後のゲーム内セーブ地点へ戻す
                  </Button>
                )}
              </Stack>
              {!canRecordSavePoint && plan.status === 'stale' && (
                <Typography variant="caption" color="text.secondary">
                  作成プランが停止しているため、ゲーム内セーブ地点は記録できません。
                </Typography>
              )}
              {showsSavePointRestore && savePointRestore.kind === 'at_current_position' && (
                <Typography variant="caption" color="text.secondary">
                  現在地点がセーブ地点のため、戻す操作はありません。
                </Typography>
              )}
            </Stack>
          </Box>
        )}

        {showsUndo && undoPresentation !== null && (
          <>
            {showsSavePoint && <Divider />}
            <Box role="group" aria-label="Undo">
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  {undoPresentation.description}
                </Typography>
                <Button
                  variant="outlined"
                  color="inherit"
                  disabled={busy}
                  onClick={() => setUndoOpen(true)}
                  sx={{ ...buttonSx, alignSelf: { sm: 'flex-start' } }}
                >
                  {undoPresentation.buttonLabel}
                </Button>
              </Stack>
            </Box>
          </>
        )}

        {showsAbandon && (
          <>
            {(showsSavePoint || showsUndo) && <Divider />}
            <Box>
              <Button
                variant="text"
                color="error"
                disabled={busy}
                onClick={() => {
                  setInspecting(true)
                  void onInspectAbandonment().then((options) => {
                    setInspecting(false)
                    if (options !== null) setAbandonOptions(options)
                  })
                }}
                sx={buttonSx}
              >
                現在Planを破棄する
              </Button>
            </Box>
          </>
        )}
      </Stack>

      <RecordSavePointDialog
        open={recordOpen}
        overwrite={savePoint !== null}
        submitting={submitting}
        onCancel={() => setRecordOpen(false)}
        onConfirm={() => {
          setRecordOpen(false)
          onRecordSavePoint()
        }}
      />
      <ExecutionSavePointRestoreDialog
        open={restoreOpen}
        submitting={submitting}
        positionLabel={savePointLabel}
        onCancel={() => setRestoreOpen(false)}
        onConfirm={() => {
          setRestoreOpen(false)
          if (savePointRestore.kind === 'available') onRestoreSavePoint(savePointRestore.savePoint.recordedAt)
        }}
      />
      {undo.kind === 'available' && undoPresentation !== null && (
        <UndoDialog
          open={undoOpen}
          presentation={undoPresentation}
          targetLabel={executionUndoTargetLabel(plan, undo.history)}
          deletesSavePoint={undo.deletesExecutionSavePoint}
          terminal={undo.terminal}
          submitting={submitting}
          onCancel={() => setUndoOpen(false)}
          onConfirm={() => {
            setUndoOpen(false)
            onUndo(undo.history.id)
          }}
        />
      )}
      <ProductionPlanAbandonDialog
        options={abandonOptions}
        savePointPositionLabel={abandonSavePointLabel}
        submitting={submitting}
        onCancel={() => setAbandonOptions(null)}
        onConfirm={(options, decision) => {
          setAbandonOptions(null)
          onAbandon(options, decision)
        }}
      />
    </Paper>
  )
}
