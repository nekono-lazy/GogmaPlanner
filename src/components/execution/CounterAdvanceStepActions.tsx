import { useId } from 'react'
import { Alert, AlertTitle, Box, Button, Divider, Stack, Typography } from '@mui/material'
import { COUNTER_ADVANCE_CONFIRM_LABEL } from './executionStepPresentation'

const primarySx = { minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } } as const
const secondarySx = { minHeight: 44, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } } as const

/**
 * The actions of a Skill Counter-advance-only Step on its default view
 * (`docs/UI_FLOW.md` 12.12, Issue #381).
 *
 * Performing the Step on an unneeded weapon is the main way through, because
 * these Steps repeat by the hundred: one press confirms it, with no dialog. That
 * press is safe to make only after the game operation, so the note above it
 * separates what is done in the game from what is done here, and keeps the
 * caution short enough to stay out of the way on every repetition.
 *
 * The guided weapon is a subordinate way through, kept apart below a divider so
 * the two are not pressed by mistake. Its button confirms nothing: it only asks
 * for the weapon switch, which the caller's guidance then confirms.
 */
export function CounterAdvanceStepActions({
  weaponLabel,
  disabled,
  onConfirm,
  onRequestGuidedWeapon,
}: {
  /** The weapon the Plan tracks, whose Skills stay as they are. */
  weaponLabel: string
  disabled: boolean
  onConfirm(): void
  onRequestGuidedWeapon(): void
}) {
  const noteId = useId()
  return (
    <>
      <Alert id={noteId} severity="info" role="note">
        <AlertTitle sx={{ fontWeight: 700 }}>スキルカウンターを進める操作です</AlertTitle>
        <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
          <li>ゲーム内：不要な巨戟アーティアにスキル再付与を1回行う</li>
          <li>アプリ：終わったら「{COUNTER_ADVANCE_CONFIRM_LABEL}」を押す</li>
        </Box>
        <Typography variant="body2" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
          計画で使う武器や完成品には行わないでください。確定しても「{weaponLabel}」のスキルは変更しません。
        </Typography>
      </Alert>
      <Button
        variant="contained"
        size="large"
        disabled={disabled}
        aria-describedby={noteId}
        onClick={onConfirm}
        sx={primarySx}
      >
        {COUNTER_ADVANCE_CONFIRM_LABEL}
      </Button>
      <Divider sx={{ pt: 2 }} />
      <Box role="group" aria-label="案内された武器で実行する場合" sx={{ pt: 1 }}>
        <Stack spacing={1}>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            計画上の武器「{weaponLabel}」でスキル再付与を行う場合
          </Typography>
          <Button variant="outlined" disabled={disabled} onClick={onRequestGuidedWeapon} sx={secondarySx}>
            案内された武器で実行する
          </Button>
        </Stack>
      </Box>
    </>
  )
}
