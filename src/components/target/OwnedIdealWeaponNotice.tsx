import { useId } from 'react'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { OwnedGogmaArtianWeapon, TargetWeapon } from '../../domain/models/publicTypes'
import {
  COMPLETE_WITH_OWNED_IDEAL_LABEL,
  OWNED_IDEAL_NOTICE_GUIDANCE,
  OWNED_IDEAL_NOTICE_MESSAGE,
  ownedIdealWeaponSummary,
} from './ownedIdealPresentation'

export interface OwnedIdealWeaponNoticeProps {
  target: TargetWeapon
  /** The owned Ideal weapons of the Target, already in their stable order. */
  weapons: readonly OwnedGogmaArtianWeapon[]
  master: MasterDataRoot
  onComplete(weapon: OwnedGogmaArtianWeapon): void
  disabled?: boolean
}

/**
 * The owned Ideal notice of `docs/UI_FLOW.md` 8.2 / `docs/SEARCH_SPEC.md` 5.5.5,
 * shared by the Target Weapons and Search screens: every owned Gogma that
 * already performs as the Target's Ideal, each with 「この武器で目標を完了にする」
 * as the preferred path. Several weapons are listed as they are - the user
 * picks one, the screen never does - and each button is described by its
 * weapon's name so assistive technology can tell them apart. The notice is
 * derived from the Target and the owned weapons alone; it runs no search.
 */
export function OwnedIdealWeaponNotice({ target, weapons, master, onComplete, disabled = false }: OwnedIdealWeaponNoticeProps) {
  const baseId = useId()
  if (weapons.length === 0) return null
  return (
    <Alert severity="info" sx={{ minWidth: 0, '& .MuiAlert-message': { minWidth: 0, width: '100%' } }}>
      <Typography component="p" variant="body2" sx={{ fontWeight: 500 }}>
        {OWNED_IDEAL_NOTICE_MESSAGE}
      </Typography>
      <Typography component="p" variant="body2" sx={{ mt: 0.5 }}>
        {OWNED_IDEAL_NOTICE_GUIDANCE}
      </Typography>
      <Box component="ul" aria-label={`${target.name}の理想条件を満たす所持武器`} sx={{ m: 0, mt: 1, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
        {weapons.map((weapon) => {
          const nameId = `${baseId}-${weapon.id}`
          return (
            <Stack
              component="li"
              key={weapon.id}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', minWidth: 0 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography id={nameId} component="p" variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                  {weapon.name}
                </Typography>
                <Typography component="p" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {ownedIdealWeaponSummary(weapon, master)}
                </Typography>
              </Box>
              <Button
                variant="contained"
                size="small"
                onClick={() => onComplete(weapon)}
                disabled={disabled}
                aria-describedby={nameId}
                sx={{ minHeight: 44, flexShrink: 0 }}
              >
                {COMPLETE_WITH_OWNED_IDEAL_LABEL}
              </Button>
            </Stack>
          )
        })}
      </Box>
    </Alert>
  )
}
