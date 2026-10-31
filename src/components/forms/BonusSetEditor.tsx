import { Alert, Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material'
import {
  getProductionAvailableBonusTypeIds,
  getProductionAvailableRanksForBonusType,
  ProductionBonusAvailabilityError,
} from '../../domain/artian/productionBonusAvailability'
import type { ArtianBonusScope, MasterDataRoot } from '../../domain/master/masterTypes'
import type { BonusRankId, RestorationBonusSet } from '../../domain/models/publicTypes'
import { legacyBonusOptionLabel, productionBonusAvailabilityErrorMessage } from './productionBonusAvailabilityText'

interface BonusSetEditorProps {
  label: string
  master: MasterDataRoot
  weaponTypeId: string
  elementId: string
  scope: ArtianBonusScope
  value: RestorationBonusSet
  onChange(value: RestorationBonusSet): void
  /** The rank Select's label; a completion Variant reads 「最低ランク」. */
  rankLabel?: string
  /**
   * The heading element of `label`; a Variant inside a section reads `h4`.
   * `none` renders no heading, for a caller that already shows `label` as the
   * heading of the group the slots sit in.
   */
  headingComponent?: 'h3' | 'h4' | 'none'
  /**
   * The words of one rank option, given its name and ID. A completion Variant
   * reads a rank as a minimum (「III以上」), so the chosen value never reads as
   * an exact rank, and the highest rank as itself (「EX」).
   */
  rankOptionLabel?(rankName: string, bonusRankId: BonusRankId): string
}

const identityLabel = (name: string) => name

/**
 * A long Bonus Type name wraps inside the Select instead of being cut off with
 * an ellipsis on a narrow screen (`docs/UI_FLOW.md` 3.1).
 */
const wrappingSelectSx = { '& .MuiSelect-select': { whiteSpace: 'normal', overflowWrap: 'anywhere' } } as const

/**
 * Five-slot restoration bonus input. The choices are the Production bonus
 * availability (Master weapon type / scope definitions x the Production
 * lottery), never the Master-only `getBonusDefinitionsForWeapon()`.
 *
 * A stored slot outside that availability stays visible as a disabled
 * "現在値" option: it is neither erased nor replaced, and it cannot be picked
 * again once changed. Saving still fails in entity validation until the user
 * chooses an available value.
 */
export function BonusSetEditor({ label, master, weaponTypeId, elementId, scope, value, onChange, rankLabel = 'ランク', headingComponent = 'h3', rankOptionLabel = identityLabel }: BonusSetEditorProps) {
  let typeIds: string[]
  try {
    typeIds = getProductionAvailableBonusTypeIds(master, weaponTypeId, elementId, scope)
  } catch (caught) {
    if (caught instanceof ProductionBonusAvailabilityError) {
      return <Alert severity="error">{label}: {productionBonusAvailabilityErrorMessage(caught)}</Alert>
    }
    throw caught
  }

  const ranksFor = (bonusTypeId: string) =>
    typeIds.includes(bonusTypeId)
      ? getProductionAvailableRanksForBonusType(master, weaponTypeId, elementId, bonusTypeId, scope)
      : []
  const typeName = (id: string) => master.bonusTypes.find((type) => type.id === id)?.displayNameJa ?? '不明'
  const rankName = (id: string) => master.bonusRanks.find((rank) => rank.id === id)?.displayNameJa ?? '不明'

  const update = (index: number, bonusTypeId: string, bonusRankId?: string) => {
    const ranks = ranksFor(bonusTypeId)
    const next = value.map((bonus) => ({ ...bonus })) as RestorationBonusSet
    next[index] = { bonusTypeId, bonusRankId: bonusRankId ?? ranks[0]?.id ?? '' }
    onChange(next)
  }

  const slots = value.map((bonus) => {
    const ranks = ranksFor(bonus.bonusTypeId)
    return {
      bonus,
      ranks,
      // An empty id is an unfilled slot (a blind observation starts with no
      // value at all), never a stored value outside the availability.
      legacyType: bonus.bonusTypeId !== '' && !typeIds.includes(bonus.bonusTypeId),
      legacyRank: bonus.bonusRankId !== '' && !ranks.some((rank) => rank.id === bonus.bonusRankId),
    }
  })
  const hasLegacy = slots.some(({ legacyType, legacyRank }) => legacyType || legacyRank)

  return <Stack spacing={1.5}>
    {headingComponent !== 'none' && <Typography component={headingComponent} variant={headingComponent === 'h3' ? 'h3' : 'subtitle1'}>{label}</Typography>}
    {hasLegacy && <Alert severity="warning">この武器種・属性ではProductionで抽選されない現在値があります。保存する前に選択肢から選び直してください。</Alert>}
    {slots.map(({ bonus, ranks, legacyType, legacyRank }, index) => {
      // One slot per row, type and rank side by side at every width, so a
      // rank always reads as belonging to its slot on a narrow screen too.
      return <Box key={index} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 1 }}>
        <FormControl fullWidth><InputLabel id={`${label}-${index}-type`}>枠{index + 1} ボーナス種別</InputLabel><Select labelId={`${label}-${index}-type`} label={`枠${index + 1} ボーナス種別`} value={bonus.bonusTypeId} sx={wrappingSelectSx} onChange={(event) => update(index, event.target.value)}>
          {legacyType && <MenuItem value={bonus.bonusTypeId} disabled>{legacyBonusOptionLabel(typeName(bonus.bonusTypeId))}</MenuItem>}
          {typeIds.map((id) => <MenuItem key={id} value={id}>{typeName(id)}</MenuItem>)}
        </Select></FormControl>
        <FormControl fullWidth><InputLabel id={`${label}-${index}-rank`}>枠{index + 1} {rankLabel}</InputLabel><Select labelId={`${label}-${index}-rank`} label={`枠${index + 1} ${rankLabel}`} value={bonus.bonusRankId} sx={wrappingSelectSx} onChange={(event) => update(index, bonus.bonusTypeId, event.target.value)}>
          {legacyRank && <MenuItem value={bonus.bonusRankId} disabled>{legacyBonusOptionLabel(rankOptionLabel(rankName(bonus.bonusRankId), bonus.bonusRankId))}</MenuItem>}
          {ranks.map((rank) => <MenuItem key={rank.id} value={rank.id}>{rankOptionLabel(rank.displayNameJa, rank.id)}</MenuItem>)}
        </Select></FormControl>
      </Box>
    })}
  </Stack>
}
