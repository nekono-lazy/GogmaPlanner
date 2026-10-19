import { Box, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'
import {
  getProductionAvailableBonusTypeIds,
  getProductionAvailableRanksForBonusType,
  ProductionBonusAvailabilityError,
} from '../../domain/artian/productionBonusAvailability'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { AlternativeBonusOption, TargetWeapon } from '../../domain/models/publicTypes'
import type { TargetWeaponDraft } from '../../services/crud/entityCrudServices'
import { legacyBonusOptionLabel, missingIdealTypeOptionLabel } from './productionBonusAvailabilityText'

type Compromise = Pick<TargetWeapon, 'practicalBonusConditions' | 'alternativeBonusRules'>

/** Fields sit side by side from `sm` up and stack on a narrow screen. */
const fieldGridSx = { display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5, alignItems: 'start' } as const
const actionButtonSx = { minHeight: 44, alignSelf: 'flex-start' } as const

/**
 * The Production bonus availability of the Target's weapon type / element under
 * `gogma_artian` scope. When it cannot be decided there are no choices; the
 * ideal five-slot editor reports why, and saving fails in entity validation.
 */
function productionTypeIds(master: MasterDataRoot, target: TargetWeaponDraft): string[] {
  try {
    return getProductionAvailableBonusTypeIds(master, target.weaponTypeId, target.elementId, 'gogma_artian')
  } catch (caught) {
    if (caught instanceof ProductionBonusAvailabilityError) return []
    throw caught
  }
}

/**
 * Only the availability authority changes here: which Bonus Types a practical
 * condition or alternative rule may name, and the compromise semantics
 * themselves, are unchanged (`docs/TARGET_COMPROMISE_SEMANTICS.md`).
 */
export function TargetCompromiseEditor({ target, master, onChange }: {
  target: TargetWeaponDraft
  master: MasterDataRoot
  onChange(value: Compromise): void
}) {
  const idealTypes = [...new Set(target.idealBonuses.map((bonus) => bonus.bonusTypeId))]
  const availableTypes = productionTypeIds(master, target)
  const count = (type: string) => target.idealBonuses.filter((bonus) => bonus.bonusTypeId === type).length
  const label = (type: string) => master.bonusTypes.find((entry) => entry.id === type)?.displayNameJa ?? type
  const ranks = (type: string) => availableTypes.includes(type)
    ? getProductionAvailableRanksForBonusType(master, target.weaponTypeId, target.elementId, type, 'gogma_artian')
    : []
  // A stored rank outside the availability stays visible but disabled; it is
  // never rewritten automatically.
  const rankOptions = (type: string, current: string) => {
    const available = ranks(type)
    const legacy = current !== '' && !available.some((rank) => rank.id === current)
      ? [<MenuItem key={`legacy-${current}`} value={current} disabled>{legacyBonusOptionLabel(master.bonusRanks.find((rank) => rank.id === current)?.displayNameJa ?? current)}</MenuItem>]
      : []
    return [...legacy, ...available.map((rank) => <MenuItem key={rank.id} value={rank.id}>{rank.displayNameJa}</MenuItem>)]
  }
  const minimum = (type: string) => ranks(type)[0]?.id ?? ''
  const newOption = (type: string): AlternativeBonusOption => ({ alternativeBonusTypeId: type, minimumRankId: minimum(type), requiredExCount: 0 })
  const setPractical = (practicalBonusConditions: Compromise['practicalBonusConditions']) => onChange({ practicalBonusConditions, alternativeBonusRules: target.alternativeBonusRules })
  const setRules = (alternativeBonusRules: Compromise['alternativeBonusRules']) => onChange({ practicalBonusConditions: target.practicalBonusConditions, alternativeBonusRules })
  // A practical condition and an alternative source must name an Ideal Bonus
  // Type that the Production lottery can actually draw. A legacy Ideal type
  // outside the availability (a Bow Poison Target whose Ideal still holds
  // Element) is therefore never offered for a new selection; the stored value
  // that already names one stays visible through `typeOptions()` below.
  const availableIdealTypes = idealTypes.filter((type) => availableTypes.includes(type))
  const unusedPractical = availableIdealTypes.filter((type) => !target.practicalBonusConditions.some((condition) => condition.bonusTypeId === type))
  const unusedSources = availableIdealTypes.filter((type) => !target.alternativeBonusRules.some((rule) => rule.sourceBonusTypeId === type))
  // A stored Bonus Type the selectable set no longer contains stays visible but
  // disabled, whether it left the Production availability or the Ideal set. It
  // is never removed or rewritten automatically: the user picks an available
  // Ideal type or deletes the condition / rule.
  const typeOptions = (current: string, selectable: readonly string[]) => {
    const legacy = selectable.includes(current)
      ? []
      : [<MenuItem key={`legacy-${current}`} value={current} disabled>{availableTypes.includes(current) ? missingIdealTypeOptionLabel(label(current)) : legacyBonusOptionLabel(label(current))}</MenuItem>]
    return [...legacy, ...selectable.map((type) => <MenuItem key={type} value={type}>{label(type)}</MenuItem>)]
  }
  const number = (value: string) => value === '' ? Number.NaN : Number(value)
  const displayed = (value: number) => Number.isNaN(value) ? '' : value
  return <Stack spacing={3}>
    <Stack spacing={1.5}>
      <Typography component="h3" variant="h3">実用ボーナス条件</Typography>
      <Typography variant="body2" color="text.secondary">種類と個数は理想のまま、指定した種類のランクだけ妥協します。未登録の種類は理想のランク構成が必要です。</Typography>
      {target.practicalBonusConditions.map((condition, index) => {
        const update = (changes: Partial<typeof condition>) => setPractical(target.practicalBonusConditions.map((entry, i) => i === index ? { ...entry, ...changes } : entry))
        return <Paper key={condition.id} variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}><Stack spacing={1.5}>
          <Box sx={fieldGridSx}>
            <TextField select label="ボーナス種別" value={condition.bonusTypeId} onChange={(event) => update({ bonusTypeId: event.target.value, minimumRankId: minimum(event.target.value), requiredExCount: 0 })}>
              {typeOptions(condition.bonusTypeId, availableIdealTypes.filter((type) => type === condition.bonusTypeId || unusedPractical.includes(type)))}
            </TextField>
            <TextField select label="最低ランク" value={condition.minimumRankId} onChange={(event) => update({ minimumRankId: event.target.value })}>
              {rankOptions(condition.bonusTypeId, condition.minimumRankId)}
            </TextField>
            <TextField label="EX最低必要数" type="number" value={displayed(condition.requiredExCount)} slotProps={{ htmlInput: { min: 0, max: count(condition.bonusTypeId) } }} onChange={(event) => update({ requiredExCount: number(event.target.value) })} />
          </Box>
          <Typography variant="body2">理想での個数: {count(condition.bonusTypeId)}</Typography>
          <Button color="error" sx={actionButtonSx} onClick={() => setPractical(target.practicalBonusConditions.filter((_, i) => i !== index))}>条件を削除</Button>
        </Stack></Paper>
      })}
      <Button variant="outlined" sx={actionButtonSx} disabled={unusedPractical.length === 0} onClick={() => {
        const type = unusedPractical[0]
        if (type) setPractical([...target.practicalBonusConditions, { id: crypto.randomUUID(), bonusTypeId: type, minimumRankId: minimum(type), requiredExCount: 0 }])
      }}>実用条件を追加</Button>
    </Stack>
    <Stack spacing={1.5}>
      <Typography component="h3" variant="h3">代替ボーナス条件</Typography>
      <Typography variant="body2" color="text.secondary">代替条件は1つの元ボーナス・1つの代替候補だけを使用します。複数の代替条件を同時には使用しません。代替した枠以外は理想条件のままです。実用ボーナス条件との併用はしません。</Typography>
      {target.alternativeBonusRules.map((rule, index) => {
        const update = (changes: Partial<typeof rule>) => setRules(target.alternativeBonusRules.map((entry, i) => i === index ? { ...entry, ...changes } : entry))
        const unusedOptions = availableTypes.filter((type) => type !== rule.sourceBonusTypeId && !rule.options.some((option) => option.alternativeBonusTypeId === type))
        return <Paper key={rule.id} variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}><Stack spacing={2}>
          <Box sx={fieldGridSx}>
            <TextField select label="元ボーナス" value={rule.sourceBonusTypeId} onChange={(event) => {
              const source = event.target.value
              const alternative = availableTypes.find((type) => type !== source)
              update({ sourceBonusTypeId: source, maxReplacementCount: 1, options: alternative ? [newOption(alternative)] : [] })
            }}>
              {typeOptions(rule.sourceBonusTypeId, availableIdealTypes.filter((type) => type === rule.sourceBonusTypeId || unusedSources.includes(type)))}
            </TextField>
            <TextField label="最大置換数" type="number" value={displayed(rule.maxReplacementCount)} slotProps={{ htmlInput: { min: 1, max: count(rule.sourceBonusTypeId) } }} onChange={(event) => update({ maxReplacementCount: number(event.target.value) })} />
          </Box>
          {rule.options.map((option, optionIndex) => {
            const updateOption = (changes: Partial<AlternativeBonusOption>) => update({ options: rule.options.map((entry, i) => i === optionIndex ? { ...entry, ...changes } : entry) })
            return <Stack key={optionIndex} spacing={1.5} sx={{ pl: { xs: 1.5, sm: 2 }, borderLeft: 2, borderColor: 'divider' }}>
              <Box sx={fieldGridSx}>
                <TextField select label="代替ボーナス種別" value={option.alternativeBonusTypeId} onChange={(event) => updateOption(newOption(event.target.value))}>
                  {!availableTypes.includes(option.alternativeBonusTypeId) && <MenuItem value={option.alternativeBonusTypeId} disabled>{legacyBonusOptionLabel(label(option.alternativeBonusTypeId))}</MenuItem>}
                  {availableTypes.filter((type) => type !== rule.sourceBonusTypeId && (type === option.alternativeBonusTypeId || unusedOptions.includes(type))).map((type) => <MenuItem key={type} value={type}>{label(type)}</MenuItem>)}
                </TextField>
                <TextField select label="代替最低ランク" value={option.minimumRankId} onChange={(event) => updateOption({ minimumRankId: event.target.value })}>
                  {rankOptions(option.alternativeBonusTypeId, option.minimumRankId)}
                </TextField>
                <TextField label="代替EX最低必要数" type="number" value={displayed(option.requiredExCount)} slotProps={{ htmlInput: { min: 0, max: rule.maxReplacementCount } }} onChange={(event) => updateOption({ requiredExCount: number(event.target.value) })} />
              </Box>
              <Button color="error" sx={actionButtonSx} onClick={() => update({ options: rule.options.filter((_, i) => i !== optionIndex) })}>代替候補を削除</Button>
            </Stack>
          })}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button variant="outlined" sx={actionButtonSx} disabled={unusedOptions.length === 0} onClick={() => {
              const type = unusedOptions[0]
              if (type) update({ options: [...rule.options, newOption(type)] })
            }}>代替候補を追加</Button>
            <Button color="error" sx={actionButtonSx} onClick={() => setRules(target.alternativeBonusRules.filter((_, i) => i !== index))}>代替条件を削除</Button>
          </Stack>
        </Stack></Paper>
      })}
      <Button variant="outlined" sx={actionButtonSx} disabled={unusedSources.length === 0 || availableTypes.length < 2} onClick={() => {
        const source = unusedSources[0]
        const alternative = availableTypes.find((type) => type !== source)
        if (source && alternative) setRules([...target.alternativeBonusRules, { id: crypto.randomUUID(), sourceBonusTypeId: source, maxReplacementCount: 1, options: [newOption(alternative)] }])
      }}>代替条件を追加</Button>
    </Stack>
  </Stack>
}
