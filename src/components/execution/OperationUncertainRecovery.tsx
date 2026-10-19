import { useId, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material'
import {
  matchOperationCountRecovery,
  recoveryResumeStep,
  type OperationCountRecoveryAvailability,
  type OperationCountRecoveryMatch,
  type OperationCountRecoveryObservation,
  type OperationCountRecoveryWindow,
} from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ExecutionSavePoint, ProductionPlan } from '../../domain/models/publicTypes'
import { planStepOperationLabels } from '../../presentation/labels'
import { actualResultFromDraft, emptyActualResultDraft, type ActualResultDraft } from './actualResultDraft'
import { ExecutionSavePointRestoreDialog } from './ExecutionSavePointRestoreDialog'
import { planStepPositionLabel, savePointPositionLabel } from './executionStepPresentation'
import { GameResultFields } from './GameResultFields'

const buttonSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const
const primarySx = { minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } } as const

type Mode = 'choose' | 'same_operation' | 'wrong_operation'

function safeMatch(
  recoveryWindow: OperationCountRecoveryWindow,
  observations: readonly OperationCountRecoveryObservation[],
): OperationCountRecoveryMatch | null {
  if (observations.length === 0) return null
  try {
    return matchOperationCountRecovery(recoveryWindow, observations)
  } catch {
    return { kind: 'unrecoverable', candidates: [], reason: 'no_match' }
  }
}

function AbandonPlanDialog({
  open,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean
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
      <DialogTitle id={titleId}>作成プランを破棄しますか？</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2">
            ゲーム内セーブ地点がないため、この生産計画を安全に続ける根拠がありません。
          </Typography>
          <Typography component="p" variant="body2" sx={{ mt: 1 }}>
            破棄するとこの生産計画は終了します。作成中の武器の「作成中」は解除され、目標武器の設定はそのまま残ります。
          </Typography>
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={{ minHeight: 44 }}>
          キャンセル
        </Button>
        <Button variant="contained" color="error" disabled={submitting} onClick={onConfirm} sx={{ minHeight: 44 }}>
          作成プランを破棄する
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * The recovery of a Plan stopped by 「何を何回操作したか分からない」
 * (`docs/UI_FLOW.md` 12.5, `docs/PLANNER_SPEC.md` 16.15).
 *
 * It never sends the user to the ordinary Identification. The user chooses
 * whether only the count of the same operation is unknown (Current Position
 * Recovery, matched purely against the Plan's recorded results inside the
 * Recovery Window) or another operation / weapon was used (the game save
 * point, or abandoning the Plan when there is none). The match shown here is
 * display only: the recovery transaction derives the Window and the position
 * again and refuses any difference.
 */
export function OperationUncertainRecovery({
  plan,
  availability,
  savePoint,
  undoAvailable,
  master,
  weaponTypeId,
  elementId,
  submitting,
  onRecover,
  onRestoreSavePoint,
  onAbandon,
}: {
  plan: ProductionPlan
  availability: OperationCountRecoveryAvailability
  savePoint: Pick<ExecutionSavePoint, 'recordedAt' | 'productionPlan'> | null
  /**
   * The 「操作内容不明」 record can still be undone, so 「実行状態の管理」 below
   * shows the control that takes it back. Display only: this panel never undoes
   * anything and never decides the eligibility.
   */
  undoAvailable: boolean
  master: MasterDataRoot
  weaponTypeId: string
  elementId: string
  submitting: boolean
  onRecover(observations: OperationCountRecoveryObservation[], position: number): void
  onRestoreSavePoint(recordedAt: string): void
  onAbandon(): void
}) {
  const [mode, setMode] = useState<Mode>('choose')
  const [observations, setObservations] = useState<OperationCountRecoveryObservation[]>([])
  const [draft, setDraft] = useState<ActualResultDraft>(emptyActualResultDraft)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [abandonOpen, setAbandonOpen] = useState(false)

  const recoveryWindow = availability.kind === 'available' ? availability.window : null
  const match = recoveryWindow === null ? null : safeMatch(recoveryWindow, observations)
  const operationLabel = recoveryWindow === null ? '' : planStepOperationLabels[recoveryWindow.steps[0].operationType]
  const observation = recoveryWindow === null ? null : actualResultFromDraft(recoveryWindow.resultKind, draft)
  const restart = () => {
    setObservations([])
    setDraft(emptyActualResultDraft())
  }

  const fallback = (
    <Stack spacing={1}>
      {savePoint !== null ? (
        <Button variant="contained" color="warning" disabled={submitting} onClick={() => setRestoreOpen(true)} sx={primarySx}>
          最後のゲーム内セーブ地点へ戻す
        </Button>
      ) : (
        <>
          <Typography variant="body2">
            ゲーム内セーブ地点が記録されていないため、この作成プランは破棄して、現在のゲーム状態から計画し直してください。
          </Typography>
          <Button variant="outlined" color="error" disabled={submitting} onClick={() => setAbandonOpen(true)} sx={buttonSx}>
            作成プランを破棄する
          </Button>
        </>
      )}
    </Stack>
  )

  const input = recoveryWindow !== null && (
    <Stack spacing={1.5}>
      <GameResultFields
        master={master}
        kind={recoveryWindow.resultKind}
        weaponTypeId={weaponTypeId}
        elementId={elementId}
        draft={draft}
        bonusLabel={
          recoveryWindow.resultKind.kind === 'restoration_bonuses' && recoveryWindow.resultKind.scope === 'normal_artian'
            ? '最後に作成した通常アーティアの復元ボーナス5枠'
            : '現在の復元ボーナス5枠'
        }
        onChange={setDraft}
      />
      {observation === null && (
        <Typography variant="body2" color="text.secondary">
          {recoveryWindow.resultKind.kind === 'restoration_bonuses'
            ? '5枠すべてのボーナス種別とランクを入力すると照合できます。'
            : 'シリーズスキルとグループスキルを両方選ぶと照合できます（無い場合は「スキルなし」）。'}
        </Typography>
      )}
      <Button
        variant="contained"
        size="large"
        disabled={submitting || observation === null}
        onClick={() => {
          if (observation === null) return
          setObservations((current) => [...current, observation])
          setDraft(emptyActualResultDraft())
        }}
        sx={primarySx}
      >
        作成プランと照合する
      </Button>
    </Stack>
  )

  const renderSameOperation = () => {
    if (recoveryWindow === null) {
      return (
        <Stack spacing={1.5}>
          <Alert severity="warning" role="note">
            <AlertTitle>現在位置を確認できません</AlertTitle>
            {availability.kind === 'unavailable' && availability.reason === 'no_comparable_result'
              ? 'この操作には作成プランに記録された比較できる結果がないため（予測なしで作成する通常アーティアなど）、現在のゲーム結果から現在位置を確認できません。'
              : 'この作成プランは、操作内容不明の記録だけで停止している状態ではないため、現在位置の確認で再開できません。'}
          </Alert>
          {fallback}
        </Stack>
      )
    }
    if (match === null) {
      return (
        <Stack spacing={1.5}>
          <Typography variant="body2">
            現在ゲーム画面に表示されている結果から、作成プラン内の現在位置を確認できます。
            ゲーム内では、ここで案内された操作以外を行わないでください。
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            対象の操作: 「{operationLabel}」
          </Typography>
          {input}
        </Stack>
      )
    }
    if (match.kind === 'unique') {
      const reached = match.position === 0 ? null : recoveryWindow.steps[match.position - 1]
      const resume = recoveryResumeStep(plan, recoveryWindow, match.position)
      return (
        <Stack spacing={1.5}>
          <Alert severity="success" role="note">
            <AlertTitle>現在位置を特定できました</AlertTitle>
            <Stack spacing={0.75}>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {reached === null
                  ? 'ゲームでは、ツールで確定済みの位置から操作は進んでいないと判断できます。'
                  : `${planStepPositionLabel(plan, reached.id)}まで実行済みと判断できます（ツールより${match.position}回分進んでいます）。ツールをこの位置まで追いつかせます。`}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {resume === null
                  ? 'この作成プランの操作はすべて完了します。'
                  : `次の操作: ${planStepPositionLabel(plan, resume.id)}`}
              </Typography>
            </Stack>
          </Alert>
          <Button
            variant="contained"
            size="large"
            disabled={submitting}
            onClick={() => onRecover(observations, match.position)}
            sx={primarySx}
          >
            この位置に合わせて続ける
          </Button>
          <Button variant="outlined" color="inherit" disabled={submitting} onClick={restart} sx={buttonSx}>
            入力をやり直す
          </Button>
        </Stack>
      )
    }
    if (match.kind === 'needs_next_observation') {
      return (
        <Stack spacing={1.5}>
          <Alert severity="info" role="note">
            <AlertTitle>候補を1件に絞れませんでした</AlertTitle>
            <Stack spacing={0.75}>
              <Typography variant="body2">候補: {match.candidates.length}件</Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                作成プラン上、どの候補でも次の操作は同じ「{operationLabel}」です。「{operationLabel}」を1回だけ実行し、その結果を入力してください。
              </Typography>
            </Stack>
          </Alert>
          {input}
          <Button variant="outlined" color="inherit" disabled={submitting} onClick={restart} sx={buttonSx}>
            入力をやり直す
          </Button>
        </Stack>
      )
    }
    return (
      <Stack spacing={1.5}>
        <Alert severity="warning" role="note">
          <AlertTitle>現在位置を安全に特定できません</AlertTitle>
          <Stack spacing={0.75}>
            <Typography variant="body2">この状態から作成プランを推測で続けることはできません。</Typography>
            <Typography variant="body2">
              {match.reason === 'no_match'
                ? '入力した結果は、この操作が続く範囲のどの結果とも一致しませんでした。入力に誤りがあれば、やり直してください。'
                : '候補が複数あり、次の操作を追加すると作成プランの外の操作になる可能性があるため、これ以上絞り込めません。'}
            </Typography>
          </Stack>
        </Alert>
        <Button variant="outlined" color="inherit" disabled={submitting} onClick={restart} sx={buttonSx}>
          入力をやり直す
        </Button>
        {fallback}
      </Stack>
    )
  }

  return (
    <Alert severity="warning" icon={false} role="region" aria-label="操作状況の回復">
      <AlertTitle>操作状況を確認できなくなりました</AlertTitle>
      <Stack spacing={1.5}>
        <Typography variant="body2">
          Counterや武器の状態は推測して変更していません。生産計画は停止しています。
        </Typography>
        {mode === 'choose' && (
          <>
            <Typography variant="body2">どの状況に近いですか？</Typography>
            <Button
              variant="contained"
              disabled={submitting}
              onClick={() => setMode('same_operation')}
              sx={primarySx}
            >
              同じ操作を何回行ったか分からない
            </Button>
            <Button
              variant="outlined"
              color="warning"
              disabled={submitting}
              onClick={() => setMode('wrong_operation')}
              sx={buttonSx}
            >
              別の操作・別の武器を操作してしまった
            </Button>
            {savePoint !== null && (
              <>
                <Divider />
                <Box>
                  <Button
                    variant="outlined"
                    color="inherit"
                    disabled={submitting}
                    onClick={() => setRestoreOpen(true)}
                    sx={buttonSx}
                  >
                    最後のゲーム内セーブ地点へ戻す
                  </Button>
                </Box>
              </>
            )}
            {undoAvailable && (
              <>
                <Divider />
                <Typography variant="body2" color="text.secondary">
                  「何を何回操作したか分からない」を誤って記録した場合は、下の「実行状態の管理」からこの記録を取り消して、記録前の操作へ戻せます。
                  実際にゲーム内の操作状況が分からない場合は取り消さず、上のいずれかの回復方法を選んでください。
                </Typography>
              </>
            )}
          </>
        )}
        {mode === 'same_operation' && (
          <>
            {renderSameOperation()}
            {savePoint !== null && match?.kind !== 'unrecoverable' && recoveryWindow !== null && (
              <>
                <Divider />
                <Box>
                  <Button
                    variant="outlined"
                    color="inherit"
                    disabled={submitting}
                    onClick={() => setRestoreOpen(true)}
                    sx={buttonSx}
                  >
                    最後のゲーム内セーブ地点へ戻す
                  </Button>
                </Box>
              </>
            )}
          </>
        )}
        {mode === 'wrong_operation' && (
          <Stack spacing={1.5}>
            <Typography variant="body2">
              作成プランにない操作が行われたため、Counterだけを合わせても現在の状態を説明できません。
              {savePoint !== null ? '最後のゲーム内セーブ地点へ戻すことを推奨します。' : ''}
            </Typography>
            {fallback}
          </Stack>
        )}
        {mode !== 'choose' && (
          <Button
            variant="text"
            color="inherit"
            disabled={submitting}
            onClick={() => {
              setMode('choose')
              restart()
            }}
            sx={{ ...buttonSx, alignSelf: { sm: 'flex-start' } }}
          >
            状況の選択に戻る
          </Button>
        )}
      </Stack>
      <ExecutionSavePointRestoreDialog
        open={restoreOpen}
        submitting={submitting}
        positionLabel={savePoint === null ? null : savePointPositionLabel(plan, savePoint.productionPlan.currentStepId)}
        note="セーブ地点より後の記録（操作内容不明の記録を含む）は削除されます。"
        onCancel={() => setRestoreOpen(false)}
        onConfirm={() => {
          setRestoreOpen(false)
          if (savePoint !== null) onRestoreSavePoint(savePoint.recordedAt)
        }}
      />
      <AbandonPlanDialog
        open={abandonOpen}
        submitting={submitting}
        onCancel={() => setAbandonOpen(false)}
        onConfirm={() => {
          setAbandonOpen(false)
          onAbandon()
        }}
      />
    </Alert>
  )
}
