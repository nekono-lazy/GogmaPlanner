import { useId, type ReactNode } from 'react'
import { Box, Button, Stack, Typography } from '@mui/material'
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
 * One registered entity (an owned weapon or a Target weapon) in a management
 * list.
 *
 * A single DOM structure serves both devices (`docs/UI_FLOW.md` 3.1): the grid
 * stacks into a card on a smartphone, uses two columns from `md`, and becomes a
 * table-like row from `lg` where the content column is wide enough. Nothing is
 * rendered twice and hidden with CSS, so every control is exposed exactly once
 * to assistive technology. The edit / delete buttons keep their short visible
 * names and are described by the entity heading, so a screen reader can tell
 * which entity they act on.
 */
export function ManagementListItem({
  title,
  badges,
  summary,
  detail,
  status,
  muted = false,
  onEdit,
  onDelete,
}: {
  title: string
  badges?: ReactNode
  summary?: ReactNode
  detail: ReactNode
  status: ReactNode
  muted?: boolean
  onEdit(): void
  onDelete(): void
}) {
  const headingId = useId()
  return (
    <Box
      component="li"
      aria-labelledby={headingId}
      sx={{
        listStyle: 'none',
        px: { xs: 2, md: 2.5 },
        py: 2,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: muted ? 'background.default' : 'background.paper',
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          md: 'repeat(2, minmax(0, 1fr))',
          lg: 'minmax(0, 1.05fr) minmax(0, 1.9fr) minmax(0, 1.25fr) auto',
        },
        gridTemplateAreas: {
          xs: '"identity" "detail" "status" "actions"',
          md: '"identity status" "detail detail" "actions actions"',
          lg: '"identity detail status actions"',
        },
        columnGap: 3,
        rowGap: 1.5,
        alignItems: 'start',
      }}
    >
      <Stack spacing={0.75} sx={{ gridArea: 'identity', minWidth: 0 }}>
        <Typography id={headingId} component="h3" variant="h3" sx={{ overflowWrap: 'anywhere' }}>
          {title}
        </Typography>
        {badges && (
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {badges}
          </Stack>
        )}
        {summary}
      </Stack>
      <Box sx={{ gridArea: 'detail', minWidth: 0 }}>{detail}</Box>
      <Box sx={{ gridArea: 'status', minWidth: 0 }}>{status}</Box>
      <Stack
        direction={{ xs: 'row', lg: 'column' }}
        spacing={1}
        sx={{ gridArea: 'actions', justifyContent: { md: 'flex-end' } }}
      >
        <Button
          variant="outlined"
          onClick={onEdit}
          aria-describedby={headingId}
          sx={{ minHeight: 44, flex: { xs: 1, md: 'none' }, minWidth: 88 }}
        >
          編集
        </Button>
        <Button
          color="error"
          onClick={onDelete}
          aria-describedby={headingId}
          sx={{ minHeight: 44, flex: { xs: 1, md: 'none' }, minWidth: 88 }}
        >
          削除
        </Button>
      </Stack>
    </Box>
  )
}

/**
 * Five restoration bonus slots as a numbered list in stored slot order.
 *
 * The slots are never sorted or grouped, and the key is the slot index because
 * two slots may legitimately hold the identical bonus. The list stays an
 * `<ol>` of `<li>` items, so slot 1..5 reaches assistive technology as an
 * ordered list, and the visible slot number is kept beside each label.
 *
 * `scope` is the caller's authority - an owned weapon's stored
 * `restorationBonusScope`, the Gogma-side definition for a Target's Ideal
 * bonuses - and is never inferred here from the weapon kind or an ID pattern.
 * The label is the scope-aware Master definition name through `bonusLabel`.
 *
 * Each slot is colour-coded by its Bonus Type family and set apart by a
 * slightly stronger tint when its rank is EX, through the same
 * `restorationBonusPresentation.ts` authority `RestorationBonusSlots` uses
 * (`docs/UI_FLOW.md` 3.4): the family comes from the stable `bonusTypeId`,
 * never from the label text, and a Bonus Type without a known family keeps
 * the standard bordered style. The slot number is an index, not a Bonus Type,
 * so it keeps the neutral secondary text colour rather than the family colour;
 * only the label, the border and the background carry the family cue, and the
 * text label (type, rank and `EX`) stays the primary information. The family
 * and the EX flag are exposed as `data-bonus-tone` / `data-bonus-ex` so tests
 * can read the applied category without depending on colour values.
 */
export function BonusSlotList({
  heading,
  bonuses,
  weaponTypeId,
  master,
  scope,
}: {
  heading: string
  bonuses: RestorationBonusSet
  weaponTypeId: string
  master: MasterDataRoot
  scope: ArtianBonusScope
}) {
  const headingId = useId()
  const theme = useTheme()
  return (
    <Stack spacing={0.5}>
      <Typography id={headingId} variant="caption" color="text.secondary">
        {heading}
      </Typography>
      <Box
        component="ol"
        aria-labelledby={headingId}
        sx={{ m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}
      >
        {bonuses.map((bonus, index) => {
          const tone = resolveRestorationBonusTone(bonus.bonusTypeId)
          const isEx = tone === null ? false : isRestorationBonusExRank(master, bonus.bonusRankId)
          return (
            <Box
              component="li"
              key={`slot-${index}`}
              data-bonus-tone={tone ?? undefined}
              data-bonus-ex={tone === null ? undefined : String(isEx)}
              sx={{
                listStyle: 'none',
                display: 'flex',
                alignItems: 'baseline',
                gap: 0.5,
                minWidth: 0,
                maxWidth: '100%',
                px: 0.75,
                py: 0.25,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                ...(tone === null ? {} : restorationBonusChipSx(tone, isEx, 'outlined', theme.palette.mode)),
              }}
            >
              <Typography
                component="span"
                variant="caption"
                className="tabular-nums"
                sx={{ color: 'text.secondary' }}
              >
                {index + 1}
              </Typography>
              <Typography component="span" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {bonusLabel(bonus, weaponTypeId, master, scope)}
              </Typography>
            </Box>
          )
        })}
      </Box>
    </Stack>
  )
}
