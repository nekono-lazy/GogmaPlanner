import { Alert, Button, Stack, Typography } from '@mui/material'
import type { ExecutionActualResultObservation } from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { actualResultFromDraft, type ActualResultDraft } from './actualResultDraft'
import type { ActualResultInputKind } from './executionStepPresentation'
import { GameResultFields } from './GameResultFields'

/**
 * 「結果が違う」 actual result input (`docs/UI_FLOW.md` 12.4).
 *
 * The five slots reuse the Owned Weapon editor and its Production availability
 * with the scope the operation's result contract fixes; the Skills come from
 * the enabled Series / Group Skill Master options. Nothing is copied from the
 * expected result, and recording stays disabled until every field is entered.
 * The runtime still validates the record and refuses a result equal to the
 * prediction.
 */
export function ActualResultDifferentForm({
  master,
  kind,
  weaponTypeId,
  elementId,
  draft,
  disabled,
  onChange,
  onSubmit,
  onCancel,
}: {
  master: MasterDataRoot
  kind: ActualResultInputKind
  weaponTypeId: string
  elementId: string
  draft: ActualResultDraft
  disabled: boolean
  onChange(draft: ActualResultDraft): void
  onSubmit(actualResult: ExecutionActualResultObservation): void
  onCancel(): void
}) {
  const actualResult = actualResultFromDraft(kind, draft)
  return (
    <Stack spacing={1.5} role="region" aria-label="実際の結果の入力">
      <Alert severity="warning" role="note">
        案内どおりの操作を1回だけ行い、結果だけが想定と違った場合に記録します。
        記録すると、この操作のCounter消費と実際の結果を保存し、生産計画を停止します。
      </Alert>
      <Typography variant="body2">ゲーム画面に表示された実際の結果を入力してください。</Typography>
      <GameResultFields
        master={master}
        kind={kind}
        weaponTypeId={weaponTypeId}
        elementId={elementId}
        draft={draft}
        bonusLabel="実際の復元ボーナス5枠"
        onChange={onChange}
      />
      {actualResult === null && (
        <Typography variant="body2" color="text.secondary">
          {kind.kind === 'restoration_bonuses'
            ? '5枠すべてのボーナス種別とランクを入力すると記録できます。'
            : 'シリーズスキルとグループスキルを両方選ぶと記録できます（無い場合は「スキルなし」）。'}
        </Typography>
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap>
        <Button
          variant="contained"
          color="warning"
          size="large"
          disabled={disabled || actualResult === null}
          onClick={() => {
            if (actualResult !== null) onSubmit(actualResult)
          }}
          sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' } }}
        >
          実際の結果を記録して計画を停止
        </Button>
        <Button
          variant="outlined"
          color="inherit"
          disabled={disabled}
          onClick={onCancel}
          sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
        >
          入力をやめて戻る
        </Button>
      </Stack>
    </Stack>
  )
}
