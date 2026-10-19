import { useId } from 'react'
import { FormControl, InputLabel, MenuItem, Select, Stack } from '@mui/material'
import { getGroupSkillOptions, getSeriesSkillOptions } from '../../domain/master/masterSelectors'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import { BonusSetEditor } from '../forms/BonusSetEditor'
import type { ActualResultDraft, ActualSkillChoice } from './actualResultDraft'
import type { ActualResultInputKind } from './executionStepPresentation'

const UNSET = ''
const NONE = '__none__'

function toSelectValue(choice: ActualSkillChoice): string {
  if (choice.status === 'unset') return UNSET
  return choice.status === 'none' ? NONE : choice.id
}

function fromSelectValue(value: string): ActualSkillChoice {
  if (value === UNSET) return { status: 'unset' }
  if (value === NONE) return { status: 'none' }
  return { status: 'skill', id: value }
}

function ActualSkillSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { id: string; displayNameJa: string }[]
  value: ActualSkillChoice
  onChange(value: ActualSkillChoice): void
}) {
  const labelId = useId()
  return (
    <FormControl fullWidth>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={toSelectValue(value)}
        onChange={(event) => onChange(fromSelectValue(String(event.target.value)))}
      >
        <MenuItem value={UNSET} disabled>
          未入力
        </MenuItem>
        <MenuItem value={NONE}>スキルなし</MenuItem>
        {options.map((skill) => (
          <MenuItem key={skill.id} value={skill.id}>
            {skill.displayNameJa}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}

/**
 * The fields of one game result as the screen shows it: the five slots with
 * the scope the operation fixes (the Owned Weapon editor and its Production
 * availability), or the Series / Group Skill pair from the enabled Master
 * options. The scope is never a choice, and 「未入力」 stays apart from
 * 「スキルなし」.
 */
export function GameResultFields({
  master,
  kind,
  weaponTypeId,
  elementId,
  draft,
  bonusLabel,
  onChange,
}: {
  master: MasterDataRoot
  kind: ActualResultInputKind
  weaponTypeId: string
  elementId: string
  draft: ActualResultDraft
  bonusLabel: string
  onChange(draft: ActualResultDraft): void
}) {
  if (kind.kind === 'restoration_bonuses') {
    return (
      <BonusSetEditor
        label={bonusLabel}
        master={master}
        weaponTypeId={weaponTypeId}
        elementId={elementId}
        scope={kind.scope}
        value={draft.slots}
        onChange={(slots) => onChange({ ...draft, slots })}
      />
    )
  }
  return (
    <Stack spacing={1.5}>
      <ActualSkillSelect
        label="実際のシリーズスキル"
        options={getSeriesSkillOptions(master)}
        value={draft.series}
        onChange={(series) => onChange({ ...draft, series })}
      />
      <ActualSkillSelect
        label="実際のグループスキル"
        options={getGroupSkillOptions(master)}
        value={draft.group}
        onChange={(group) => onChange({ ...draft, group })}
      />
    </Stack>
  )
}
