import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material'
import { useId, useState } from 'react'
import {
  recommendedCandidateSearchDefaults,
  type CandidateSearchDefaults,
} from '../../domain/models/publicTypes'
import {
  CANDIDATE_SEARCH_LIMIT_INVALID_MESSAGE,
  candidateSearchLimitDraft,
  candidateSearchLimitFields,
  parseCandidateSearchLimit,
  parseCandidateSearchLimitDraft,
  sameCandidateSearchDefaults,
  type CandidateSearchLimitDraft,
} from '../search/candidateSearchLimitPresentation'

export type CandidateSearchDefaultsFeedback = 'saved' | 'save_failed' | null

const actionButtonSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The saved Candidate Search defaults (`docs/UI_FLOW.md` 14): the three bounds
 * the Search screen starts from. The draft is local until 「保存」; 「推奨値に
 * 戻す」 only refills the draft. The parent remounts this component (by `key`)
 * whenever the persisted defaults change - a save, an Import, a clear - so the
 * draft always starts from what is stored.
 */
export function CandidateSearchDefaultsSetting({
  saved,
  saving,
  disabled,
  feedback,
  onSave,
  onDraftChange,
}: {
  saved: CandidateSearchDefaults
  saving: boolean
  /** A Data Transfer operation or an unavailable Application boundary. */
  disabled: boolean
  feedback: CandidateSearchDefaultsFeedback
  onSave: (defaults: CandidateSearchDefaults) => void
  /** Any edit of the draft, so an earlier save result stops being shown. */
  onDraftChange: () => void
}) {
  const helpId = useId()
  const [draft, setDraft] = useState<CandidateSearchLimitDraft>(() => candidateSearchLimitDraft(saved))
  const parsed = parseCandidateSearchLimitDraft(draft)
  const unchanged = parsed !== null && sameCandidateSearchDefaults(parsed, saved)
  const draftIsRecommended = parsed !== null && sameCandidateSearchDefaults(parsed, recommendedCandidateSearchDefaults)
  const locked = disabled || saving
  const changeDraft = (next: CandidateSearchLimitDraft) => {
    setDraft(next)
    onDraftChange()
  }

  return (
    <Stack spacing={1.5}>
      <Typography id={helpId} variant="body2" color="text.secondary">
        候補検索画面を開いたときに使う探索量の上限です。候補検索画面で値を変えても、その変更は今回の検索（未登録の一括検索・追加を含む）だけに使われ、ここに保存した既定値は変わりません。
      </Typography>
      <Typography variant="body2" color="text.secondary">
        推奨の初期値は通常アーティア {recommendedCandidateSearchDefaults.maxNormalAdvance}・復元ボーナス {recommendedCandidateSearchDefaults.maxGogmaAdvance}・スキル {recommendedCandidateSearchDefaults.maxSkillAdvance} です。通常アーティアの進行は武器種ごとに別ですが、復元ボーナスの進行は複数の武器で共有され、別の武器の作成でも進められるため、復元ボーナスを高めにしています。大小関係は自由に設定できます。
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' },
          gap: 1.5,
        }}
      >
        {candidateSearchLimitFields.map((field) => {
          const invalid = parseCandidateSearchLimit(draft[field.key]) === null
          return (
            <TextField
              key={field.key}
              fullWidth
              label={field.label}
              type="number"
              value={draft[field.key]}
              error={invalid}
              helperText={invalid ? CANDIDATE_SEARCH_LIMIT_INVALID_MESSAGE : field.helperText}
              disabled={locked}
              onChange={(event) => changeDraft({ ...draft, [field.key]: event.target.value })}
              slotProps={{ htmlInput: { min: 1, step: 1, inputMode: 'numeric' } }}
            />
          )
        })}
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} useFlexGap>
        <Button
          variant="contained"
          disabled={locked || parsed === null || unchanged}
          onClick={() => {
            if (parsed !== null) onSave(parsed)
          }}
          aria-describedby={helpId}
          sx={actionButtonSx}
        >
          {saving ? '保存中…' : '既定値を保存'}
        </Button>
        <Button
          variant="outlined"
          disabled={locked || draftIsRecommended}
          onClick={() => changeDraft(candidateSearchLimitDraft(recommendedCandidateSearchDefaults))}
          sx={actionButtonSx}
        >
          推奨値に戻す
        </Button>
      </Stack>
      {!unchanged && parsed !== null && !saving && (
        <Typography variant="body2" color="text.secondary">
          変更はまだ保存されていません。「既定値を保存」で保存します。
        </Typography>
      )}
      {feedback === 'saved' && (
        <Alert severity="success">
          探索量の既定値を保存しました。次に候補検索画面を開いたときから使用されます。
        </Alert>
      )}
      {feedback === 'save_failed' && (
        <Alert severity="warning">
          探索量の既定値を保存できませんでした。保存済みの既定値は変更されていません。再度お試しください。
        </Alert>
      )}
    </Stack>
  )
}
