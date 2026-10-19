import { Box, Chip } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import type { ArtianBonusScope, MasterDataRoot } from '../domain/master/masterTypes'
import type { RestorationBonusSet } from '../domain/models/publicTypes'
import {
  isRestorationBonusExRank,
  resolveRestorationBonusTone,
  restorationBonusChipSx,
} from './restorationBonusPresentation'
import { bonusLabel } from './search/searchPresentation'

/**
 * The five restoration bonus slots in their stored slot order.
 *
 * Slot order is semantic - Keep preserves the bonus family at each slot
 * position - so the slots are never sorted, grouped, or normalized to a
 * multiset for display, and the React key is the slot index because two slots
 * may legitimately hold the identical bonus.
 *
 * The slots are exposed as a labelled list, so assistive technology reads
 * five items rather than five loose chips. The wrapper is deliberately not a
 * `<ul>` / `<li>`: route step lists that contain these slots are `<ol>` items
 * of their own, and a nested `<li>` would be counted among them.
 *
 * `scope` selects the scope-specific Master definition label. Callers that
 * know the scope of what they render pass it; omitting it keeps the historical
 * lookup of `bonusLabel` for call sites that predate scope-aware display. An
 * explicit `null` - a persisted result whose scope was not recorded - uses the
 * generic Master type + rank label instead of guessing a scope.
 *
 * Each chip is colour-coded by its Bonus Type family and emphasised when its
 * rank is EX (`restorationBonusPresentation.ts`). That is a secondary cue on
 * top of the unchanged text label; a Bonus Type without a known family keeps
 * the standard Chip style. The tone table follows the current theme mode, so
 * Light and Dark share this one authority. The family and the EX flag are also exposed as
 * `data-bonus-tone` / `data-bonus-ex`, so tests can read the applied category
 * without depending on colour values.
 */
export function RestorationBonusSlots({
  bonuses,
  weaponTypeId,
  master,
  scope,
  variant = 'filled',
  label = '復元ボーナス5枠',
}: {
  bonuses: RestorationBonusSet
  weaponTypeId: string
  master: MasterDataRoot
  scope?: ArtianBonusScope | null
  variant?: 'filled' | 'outlined'
  /** Accessible name of the slot list. */
  label?: string
}) {
  const theme = useTheme()
  return (
    <Box
      role="list"
      aria-label={label}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, minWidth: 0 }}
    >
      {bonuses.map((bonus, index) => {
        const tone = resolveRestorationBonusTone(bonus.bonusTypeId)
        const isEx = tone === null ? false : isRestorationBonusExRank(master, bonus.bonusRankId)
        return (
          <Box role="listitem" key={`slot-${index}`} sx={{ minWidth: 0, maxWidth: '100%' }}>
            <Chip
              label={bonusLabel(bonus, weaponTypeId, master, scope)}
              size="small"
              variant={variant}
              data-bonus-tone={tone ?? undefined}
              data-bonus-ex={tone === null ? undefined : String(isEx)}
              sx={{
                maxWidth: '100%',
                ...(tone === null ? {} : restorationBonusChipSx(tone, isEx, variant, theme.palette.mode)),
              }}
            />
          </Box>
        )
      })}
    </Box>
  )
}
