import { Alert, Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material'
import {
  getProductionAvailableBonusTypeIds,
  getProductionAvailableRanksForBonusType,
  ProductionBonusAvailabilityError,
} from '../../domain/artian/productionBonusAvailability'
import type { ArtianBonusScope, MasterDataRoot } from '../../domain/master/masterTypes'
import type { RestorationBonusSet } from '../../domain/models/publicTypes'
import { legacyBonusOptionLabel, productionBonusAvailabilityErrorMessage } from './productionBonusAvailabilityText'

interface BonusSetEditorProps {
  label: string
  master: MasterDataRoot
  weaponTypeId: string
  elementId: string
  scope: ArtianBonusScope
  value: RestorationBonusSet
  onChange(value: RestorationBonusSet): void
}

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
export function BonusSetEditor({ label, master, weaponTypeId, elementId, scope, value, onChange }: BonusSetEditorProps) {
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
    <Typography component="h3" variant="h3">{label}</Typography>
    {hasLegacy && <Alert severity="warning">この武器種・属性ではProductionで抽選されない現在値があります。保存する前に選択肢から選び直してください。</Alert>}
    {slots.map(({ bonus, ranks, legacyType, legacyRank }, index) => {
      // One slot per row, type and rank side by side at every width, so a
      // rank always reads as belonging to its slot on a narrow screen too.
      return <Box key={index} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 1 }}>
        <FormControl fullWidth><InputLabel id={`${label}-${index}-type`}>枠{index + 1} ボーナス種別</InputLabel><Select labelId={`${label}-${index}-type`} label={`枠${index + 1} ボーナス種別`} value={bonus.bonusTypeId} onChange={(event) => update(index, event.target.value)}>
          {legacyType && <MenuItem value={bonus.bonusTypeId} disabled>{legacyBonusOptionLabel(typeName(bonus.bonusTypeId))}</MenuItem>}
          {typeIds.map((id) => <MenuItem key={id} value={id}>{typeName(id)}</MenuItem>)}
        </Select></FormControl>
        <FormControl fullWidth><InputLabel id={`${label}-${index}-rank`}>枠{index + 1} ランク</InputLabel><Select labelId={`${label}-${index}-rank`} label={`枠${index + 1} ランク`} value={bonus.bonusRankId} onChange={(event) => update(index, bonus.bonusTypeId, event.target.value)}>
          {legacyRank && <MenuItem value={bonus.bonusRankId} disabled>{legacyBonusOptionLabel(rankName(bonus.bonusRankId))}</MenuItem>}
          {ranks.map((rank) => <MenuItem key={rank.id} value={rank.id}>{rank.displayNameJa}</MenuItem>)}
        </Select></FormControl>
      </Box>
    })}
  </Stack>
}
