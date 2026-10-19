import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { OwnedWeapon } from '../../domain/models/publicTypes'
import { ExecutionEntityName } from './ExecutionWeaponDetailDialog'

/**
 * The presentation-only weapon switch guidance (`docs/UI_FLOW.md` 12.6).
 *
 * It is an interstitial: the caller renders it *instead of* the current Step
 * card, so the only thing this screen asks for is the weapon switch. 「武器を
 * 切り替えました」 only reveals the current Step: it confirms no Step, changes
 * no Counter, weapon or ExecutionHistory, and is never persisted, so a reload
 * shows it again.
 *
 * The weapon name is the read-only lookup of that weapon's current registered
 * content (Issue #76), so the user can tell two similarly named weapons apart
 * before picking one up in the game. That is identification of the weapon to
 * switch to and nothing more: the current Step's operation, its instruction,
 * the Target and the expected result stay out of the DOM until 「武器を切り替
 * えました」, and opening or closing the lookup is never the acknowledgement.
 */
export function WeaponSwitchPrompt({
  weaponLabel,
  weapon,
  master,
  onAcknowledge,
}: {
  weaponLabel: string
  /** The exact persisted weapon `weaponLabel` names, or `null` when it cannot be resolved. */
  weapon: OwnedWeapon | null
  master: MasterDataRoot
  onAcknowledge(): void
}) {
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
        <Button
          variant="contained"
          size="large"
          onClick={onAcknowledge}
          sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }}
        >
          武器を切り替えました
        </Button>
      </Stack>
    </Alert>
  )
}
