import { Alert, Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { getGroupSkillOptions, getSeriesSkillOptions } from '../../domain/master/masterSelectors'
import type { SkillCondition } from '../../domain/models/publicTypes'

interface SkillConditionEditorProps {
  label: string
  master: MasterDataRoot
  value: SkillCondition
  onChange(value: SkillCondition): void
  /** What the completion condition review asks of this section (`docs/UI_FLOW.md` 8.4), if anything. */
  reviewNote?: string | null
}

/**
 * The completion Skill condition (`docs/UI_FLOW.md` 8): the Series and the
 * Group Skill are each fully specified or left unspecified. Every specified
 * Skill must match (`all`), so there is no match-mode Select.
 */
export function SkillConditionEditor({ label, master, value, onChange, reviewNote = null }: SkillConditionEditorProps) {
  return <Stack spacing={1}>
    <Typography component="h3" variant="h3">{label}</Typography>
    {reviewNote !== null && <Alert severity="warning" variant="outlined">{reviewNote}</Alert>}
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
      <FormControl fullWidth><InputLabel id={`${label}-series`}>シリーズスキル</InputLabel><Select labelId={`${label}-series`} label="シリーズスキル" value={value.seriesSkillId ?? ''} onChange={(event) => onChange({ ...value, seriesSkillId: event.target.value || null, matchMode: 'all' })}><MenuItem value="">指定なし</MenuItem>{getSeriesSkillOptions(master).map((skill) => <MenuItem key={skill.id} value={skill.id}>{skill.displayNameJa}</MenuItem>)}</Select></FormControl>
      <FormControl fullWidth><InputLabel id={`${label}-group`}>グループスキル</InputLabel><Select labelId={`${label}-group`} label="グループスキル" value={value.groupSkillId ?? ''} onChange={(event) => onChange({ ...value, groupSkillId: event.target.value || null, matchMode: 'all' })}><MenuItem value="">指定なし</MenuItem>{getGroupSkillOptions(master).map((skill) => <MenuItem key={skill.id} value={skill.id}>{skill.displayNameJa}</MenuItem>)}</Select></FormControl>
    </Box>
    <Typography variant="body2" color="text.secondary">指定したスキルはすべて一致する必要があります。指定なしの項目は条件にしません。</Typography>
  </Stack>
}
