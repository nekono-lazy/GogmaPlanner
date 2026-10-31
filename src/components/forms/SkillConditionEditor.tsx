import { useId } from 'react'
import { Box, FormControl, InputLabel, MenuItem, Select } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { getGroupSkillOptions, getSeriesSkillOptions } from '../../domain/master/masterSelectors'
import type { SkillCondition } from '../../domain/models/publicTypes'

interface SkillConditionFieldsProps {
  master: MasterDataRoot
  value: SkillCondition
  onChange(value: SkillCondition): void
  /** Read by a screen reader with each Select (a configuration's save error). */
  describedBy?: string
}

/**
 * The Series and Group Skill Selects of one completion Skill configuration
 * (`docs/UI_FLOW.md` 8, Issue #367): each fully specified or 「指定なし」.
 * Every specified Skill must match (AND), so there is no match-mode Select.
 * Two columns from `sm`, stacked below it.
 */
export function SkillConditionFields({ master, value, onChange, describedBy }: SkillConditionFieldsProps) {
  const id = useId()
  const displayProps = describedBy ? { 'aria-describedby': describedBy } : undefined
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
      <FormControl fullWidth>
        <InputLabel id={`${id}-series`}>シリーズスキル</InputLabel>
        <Select
          labelId={`${id}-series`}
          label="シリーズスキル"
          value={value.seriesSkillId ?? ''}
          SelectDisplayProps={displayProps}
          onChange={(event) => onChange({ ...value, seriesSkillId: event.target.value || null })}
        >
          <MenuItem value="">指定なし</MenuItem>
          {getSeriesSkillOptions(master).map((skill) => <MenuItem key={skill.id} value={skill.id}>{skill.displayNameJa}</MenuItem>)}
        </Select>
      </FormControl>
      <FormControl fullWidth>
        <InputLabel id={`${id}-group`}>グループスキル</InputLabel>
        <Select
          labelId={`${id}-group`}
          label="グループスキル"
          value={value.groupSkillId ?? ''}
          SelectDisplayProps={displayProps}
          onChange={(event) => onChange({ ...value, groupSkillId: event.target.value || null })}
        >
          <MenuItem value="">指定なし</MenuItem>
          {getGroupSkillOptions(master).map((skill) => <MenuItem key={skill.id} value={skill.id}>{skill.displayNameJa}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}
