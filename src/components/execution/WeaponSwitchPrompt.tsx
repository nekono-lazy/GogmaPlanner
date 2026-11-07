import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { OwnedWeapon } from '../../domain/models/publicTypes'
import { ExecutionEntityName } from './ExecutionWeaponDetailDialog'

const primarySx = { minHeight: 48, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The presentation-only weapon switch guidance (`docs/UI_FLOW.md` 12.6).
 *
 * It is an interstitial: the caller renders it *instead of* the current Step
 * card, so the only thing this screen asks for is the weapon switch. 「武器を
 * 切り替えました」 only reveals the current Step: it confirms no Step, changes
 * no Counter, weapon or ExecutionHistory, and is never persisted, so a reload
 * shows it again.
 *
 * A Skill Counter-advance-only Reset Skills Step reaches this guidance only when
 * the user chose 「案内された武器で実行する」 (Issue #381, `docs/UI_FLOW.md`
 * 12.12). The caller then passes `onReturnToCounterAdvance`: 「不要な武器で進める」
 * beside the switch confirmation goes back to the Step's default view without
 * confirming any switch. Neither button changes a Counter or a record.
 *
 * The weapon name is the read-only lookup of that weapon's current registered
 * content (Issue #76), so the user can tell two similarly named weapons apart
 * before picking one up in the game. That is identification of the weapon to
 * switch to and nothing more: the current Step's operation, its instruction,
 * the Target and the expected result stay out of the DOM until an
 * acknowledgement, and opening or closing the lookup is never one.
 */
export function WeaponSwitchPrompt({
  weaponLabel,
  weapon,
  master,
  disabled = false,
  onAcknowledge,
  onReturnToCounterAdvance,
}: {
  weaponLabel: string
  /** The exact persisted weapon `weaponLabel` names, or `null` when it cannot be resolved. */
  weapon: OwnedWeapon | null
  master: MasterDataRoot
  disabled?: boolean
  onAcknowledge(): void
  /** Present only on a Counter-advance-only Step: 「不要な武器で進める」. */
  onReturnToCounterAdvance?: () => void
}) {
  const counterAdvance = onReturnToCounterAdvance !== undefined
  return (
    <Alert severity="info" icon={false} role="region" aria-label="武器切替案内">
      <AlertTitle component="h2">武器の切替</AlertTitle>
      <Stack spacing={1.5}>
        <Typography component="p" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
          作業する武器を「
          <ExecutionEntityName
            label={weaponLabel}
            detail={weapon === null ? null : { kind: 'owned_weapon', weapon }}
            master={master}
            bold
          />
          」へ切り替えてください
        </Typography>
        <Typography variant="body2">
          ここでは武器の切替だけを行います。次の操作内容は、下のボタンを押すと表示されます。
        </Typography>
        {counterAdvance && (
          <Typography variant="body2">
            不要な巨戟アーティアで行う場合は、切り替えずに「不要な武器で進める」で戻れます。
          </Typography>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            size="large"
            disabled={disabled}
            onClick={onAcknowledge}
            sx={{ ...primarySx, alignSelf: { sm: 'flex-start' } }}
          >
            {counterAdvance ? '案内された武器に切り替えました' : '武器を切り替えました'}
          </Button>
          {counterAdvance && (
            <Button variant="outlined" size="large" disabled={disabled} onClick={onReturnToCounterAdvance} sx={primarySx}>
              不要な武器で進める
            </Button>
          )}
        </Stack>
      </Stack>
    </Alert>
  )
}
