import { useId } from 'react'
import { Box, Button, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material'
import type { ElementMaster, WeaponTypeMaster } from '../domain/master/masterTypes'
import {
  emptyWeaponListFilter,
  isWeaponListFilterActive,
  type WeaponListFilter,
} from '../presentation/weaponListFilter'

/** Select value standing for "every value"; no Master ID takes this form. */
const allValue = '__all__'

const activeFieldSx = {
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'primary.main', borderWidth: 2 },
} as const

/**
 * The weapon type / element filter bar shared by the management lists
 * (`docs/UI_FLOW.md` 3.2). Display only: the caller filters what it already
 * loaded and never hands the filter to a repository, Search or the Planner.
 *
 * A single DOM serves both devices (`docs/UI_FLOW.md` 3.1): the two Selects
 * sit side by side from 375px, and the status line wraps below them on a
 * smartphone. The selected values stay readable in each Select, an active
 * field also gets a heavier outline, and the shown / total count is announced
 * as a whole phrase through one polite status region.
 */
export function WeaponListFilterBar({
  label,
  filter,
  onChange,
  weaponTypes,
  elements,
  totalCount,
  shownCount,
  unit,
  countLabel,
}: {
  /** Accessible name of the filter group, e.g. 「所持武器の絞り込み」. */
  label: string
  filter: WeaponListFilter
  onChange(filter: WeaponListFilter): void
  weaponTypes: readonly WeaponTypeMaster[]
  elements: readonly ElementMaster[]
  totalCount: number
  shownCount: number
  /** Counter word of the listed items, e.g. 「本」 or 「件」. */
  unit: string
  /** What is counted when it is not the list's own items, e.g. 「目標武器」. */
  countLabel?: string
}) {
  const weaponTypeLabelId = useId()
  const elementLabelId = useId()
  const active = isWeaponListFilterActive(filter)
  return (
    <Box
      role="group"
      aria-label={label}
      sx={{
        display: 'grid',
        gap: 1.5,
        alignItems: 'center',
        gridTemplateColumns: {
          xs: 'repeat(2, minmax(0, 1fr))',
          sm: 'repeat(2, minmax(0, 220px)) minmax(0, 1fr)',
        },
      }}
    >
      <FormControl size="small" fullWidth sx={filter.weaponTypeId === null ? undefined : activeFieldSx}>
        <InputLabel id={weaponTypeLabelId}>武器種で絞り込み</InputLabel>
        <Select
          labelId={weaponTypeLabelId}
          label="武器種で絞り込み"
          value={filter.weaponTypeId ?? allValue}
          onChange={(event) => {
            const value = event.target.value
            onChange({ ...filter, weaponTypeId: value === allValue ? null : value })
          }}
          sx={{ minHeight: 44 }}
        >
          <MenuItem value={allValue}>すべて</MenuItem>
          {weaponTypes.map((type) => (
            <MenuItem key={type.id} value={type.id}>
              {type.displayNameJa}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth sx={filter.elementId === null ? undefined : activeFieldSx}>
        <InputLabel id={elementLabelId}>属性で絞り込み</InputLabel>
        <Select
          labelId={elementLabelId}
          label="属性で絞り込み"
          value={filter.elementId ?? allValue}
          onChange={(event) => {
            const value = event.target.value
            onChange({ ...filter, elementId: value === allValue ? null : value })
          }}
          sx={{ minHeight: 44 }}
        >
          <MenuItem value={allValue}>すべて</MenuItem>
          {elements.map((element) => (
            <MenuItem key={element.id} value={element.id}>
              {element.displayNameJa}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{
          gridColumn: { xs: '1 / -1', sm: 'auto' },
          alignItems: 'center',
          justifyContent: { xs: 'space-between', sm: 'flex-end' },
          flexWrap: 'wrap',
          minHeight: 44,
        }}
      >
        {/* Kept mounted (empty while inactive) so a change is announced. */}
        <Typography
          role="status"
          aria-atomic="true"
          variant="body2"
          color="text.secondary"
          className="tabular-nums"
        >
          {active ? `${countLabel ?? ''}${totalCount}${unit}中 ${shownCount}${unit}を表示` : ''}
        </Typography>
        {active && (
          <Button variant="text" onClick={() => onChange(emptyWeaponListFilter)} sx={{ minHeight: 44 }}>
            絞り込みを解除
          </Button>
        )}
      </Stack>
    </Box>
  )
}

/**
 * Shown instead of the list when the filter hides every loaded item. It says
 * the items still exist and offers the way back, so an empty result is never
 * read as "nothing is registered".
 */
export function WeaponListFilterEmpty({ message, onClear }: { message: string; onClear(): void }) {
  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Typography>{message}</Typography>
      <Typography variant="body2" color="text.secondary">
        絞り込みは表示だけを変えます。登録内容は変わっていません。
      </Typography>
      <Button variant="outlined" onClick={onClear} sx={{ minHeight: 44 }}>
        絞り込みを解除
      </Button>
    </Stack>
  )
}
