import { Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { getGroupSkillOptions, getSeriesSkillOptions } from '../../domain/master/masterSelectors'
import type { SkillCondition } from '../../domain/models/publicTypes'
import { skillMatchModeLabels } from '../../presentation/labels'

interface SkillConditionEditorProps {
  label: string
  master: MasterDataRoot
  value: SkillCondition
  onChange(value: SkillCondition): void
}

export function SkillConditionEditor({ label, master, value, onChange }: SkillConditionEditorProps) {
  return <Stack spacing={1}>
    <Typography component="h3" variant="h3">{label}</Typography>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
      <FormControl fullWidth><InputLabel id={`${label}-series`}>シリーズスキル</InputLabel><Select labelId={`${label}-series`} label="シリーズスキル" value={value.seriesSkillId ?? ''} onChange={(event) => onChange({ ...value, seriesSkillId: event.target.value || null })}><MenuItem value="">指定なし</MenuItem>{getSeriesSkillOptions(master).map((skill) => <MenuItem key={skill.id} value={skill.id}>{skill.displayNameJa}</MenuItem>)}</Select></FormControl>
      <FormControl fullWidth><InputLabel id={`${label}-group`}>グループスキル</InputLabel><Select labelId={`${label}-group`} label="グループスキル" value={value.groupSkillId ?? ''} onChange={(event) => onChange({ ...value, groupSkillId: event.target.value || null })}><MenuItem value="">指定なし</MenuItem>{getGroupSkillOptions(master).map((skill) => <MenuItem key={skill.id} value={skill.id}>{skill.displayNameJa}</MenuItem>)}</Select></FormControl>
      <FormControl fullWidth disabled={value.seriesSkillId === null && value.groupSkillId === null}><InputLabel id={`${label}-mode`}>一致方法</InputLabel><Select labelId={`${label}-mode`} label="一致方法" value={value.matchMode} onChange={(event) => onChange({ ...value, matchMode: event.target.value as SkillCondition['matchMode'] })}><MenuItem value="all">{skillMatchModeLabels.all}</MenuItem><MenuItem value="any">{skillMatchModeLabels.any}</MenuItem></Select></FormControl>
    </Box>
  </Stack>
}
