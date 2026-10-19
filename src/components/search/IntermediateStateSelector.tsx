import { useId } from 'react'
import {
  Alert,
  Box,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material'
import { DisclosureAccordion, type DisclosureHeadingLevel } from '../DisclosureAccordion'
import { hasDeeperHeadingLevel, nextHeadingLevel } from '../headingLevel'
import { RestorationBonusSlots } from '../RestorationBonusSlots'
import { StatusChip } from '../StatusChip'
import { SearchDefinitionItem, SearchDefinitionList } from './SearchDefinitionList'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildCandidate,
  ImprovementPreference,
  IntermediateBonusStateGroup,
  IntermediateSkillStateGroup,
  IntermediateStateAxis,
  IntermediateStateOpportunity,
  IntermediateStateSelection,
} from '../../domain/models/publicTypes'
import { improvementPreferences } from '../../domain/models/publicTypes'
import {
  compromiseBonusMatchLabels,
  compromiseSkillMatchLabels,
  improvementPreferenceLabels,
  restorationBonusScopeFieldLabel,
  restorationBonusScopeLabels,
} from '../../presentation/labels'
import { groupSkillLabel, intermediateOpportunityLabel, seriesSkillLabel } from './searchPresentation'

/**
 * Where an editable selector is shown.
 *
 * The selection semantics are identical in both places - at most one state
 * per lane, a hard Planner constraint, plus a soft improvement preference -
 * but the explanatory sentence differs: on the Search screen the selection
 * is *registered* together with the Candidate, while on the Build List the
 * Candidate is already registered and a change makes the existing Plan a
 * recalculation target.
 */
export type IntermediateStateSelectionContext = 'search' | 'build_list'

const selectionDescriptions: Record<IntermediateStateSelectionContext, string> = {
  search:
    'スキル側と復元ボーナス側で、途中で採用したい状態をそれぞれ1つまで選べます。選んだ状態は作成途中で必ず経由する条件として作成リストへ登録され、両方の条件を満たした瞬間が妥協品として利用できる時点になります。何も選ばなければ理想品まで進みます。',
  build_list:
    '選択中の途中採用状態は、この候補を作成する途中で必ず経由する条件としてPlannerに渡されます。変更すると既存の生産計画は再計算が必要です。スキル側・復元ボーナス側それぞれ1つまで選べます。',
}

const axisSectionTitles: Record<IntermediateStateAxis, string> = {
  skill: 'スキル候補',
  bonus: '復元ボーナス候補',
}

const axisEmptyMessages: Record<IntermediateStateAxis, string> = {
  skill: 'このルートのスキル進行の途中に、スキル条件を満たす状態はありません。',
  bonus: 'このルートの復元ボーナス進行の途中に、復元ボーナス条件を満たす状態はありません。',
}

export interface IntermediateStateSelectorProps {
  candidate: BuildCandidate
  weaponTypeId: string
  master: MasterDataRoot
  selection: IntermediateStateSelection
  /**
   * Omitted where the selection is read-only. Supplying it makes every
   * opportunity selectable, including the ones behind the disclosures:
   * nothing shown here is ever unavailable, only tidied away.
   */
  onChange?: (selection: IntermediateStateSelection) => void
  /**
   * The controls stay visible but cannot be changed: a save of this selection
   * is in flight or waiting for the user's confirmation.
   */
  disabled?: boolean
  /**
   * Heading level of the section heading. Lane headings, group headings and
   * the disclosures take the following levels, so the page outline stays
   * sequential wherever the selector is embedded.
   */
  headingLevel?: DisclosureHeadingLevel
  /** Which screen the editable explanation is written for. Defaults to Search. */
  selectionContext?: IntermediateStateSelectionContext
}

function laneLength(candidate: BuildCandidate, axis: IntermediateStateAxis): number {
  return candidate.route.operations.filter(({ type }) =>
    axis === 'skill'
      ? type === 'reset_skills'
      : type === 'reset_bonuses' || type === 'keep_bonuses',
  ).length
}

function hasConversion(candidate: BuildCandidate): boolean {
  return candidate.route.operations.some(({ type }) => type === 'convert_normal_to_gogma')
}

function OpportunityRow({
  candidate,
  opportunity,
  selected,
  onToggle,
  disabled = false,
}: {
  candidate: BuildCandidate
  opportunity: IntermediateStateOpportunity
  selected: boolean
  onToggle?: (opportunity: IntermediateStateOpportunity, selected: boolean) => void
  disabled?: boolean
}) {
  const label = intermediateOpportunityLabel(candidate, opportunity)
  if (!onToggle) {
    return (
      <Typography variant="body2">
        {selected ? '採用する: ' : ''}
        {label}
      </Typography>
    )
  }
  return (
    <FormControlLabel
      sx={{ m: 0, minHeight: 44, alignItems: 'center', maxWidth: '100%' }}
      control={
        <Checkbox
          checked={selected}
          disabled={disabled}
          onChange={(event) => onToggle(opportunity, event.target.checked)}
          slotProps={{ input: { 'aria-label': `この途中状態を採用する: ${label}` } }}
        />
      }
      label={
        <Typography component="span" variant="body2" className="tabular-nums">
          この途中状態を採用する（{label}）
        </Typography>
      }
    />
  )
}

function GroupCard({
  candidate,
  group,
  index,
  weaponTypeId,
  master,
  selectedOpportunityId,
  onToggle,
  disabled,
  headingLevel,
}: {
  candidate: BuildCandidate
  group: IntermediateSkillStateGroup | IntermediateBonusStateGroup
  /** 1-based display number; presentation only, never an identity. */
  index: number
  weaponTypeId: string
  master: MasterDataRoot
  selectedOpportunityId: string | null
  onToggle?: (opportunity: IntermediateStateOpportunity, selected: boolean) => void
  disabled: boolean
  /**
   * Heading level of the group title, or `null` when the group sits below an
   * `h6` and its title is therefore labelled text rather than a heading.
   */
  headingLevel: DisclosureHeadingLevel | null
}) {
  const headingId = useId()
  const laterArrivalsLevel =
    headingLevel !== null && hasDeeperHeadingLevel(headingLevel)
      ? nextHeadingLevel(headingLevel)
      : 'none'
  // Ascending by lane position, so the first entry is the earliest arrival.
  const [primary, ...later] = group.opportunities
  const badge =
    group.axis === 'skill'
      ? compromiseSkillMatchLabels[group.match]
      : compromiseBonusMatchLabels[group.match]
  return (
    <Paper
      component="section"
      aria-labelledby={headingId}
      variant="outlined"
      sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}
    >
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component={headingLevel ?? 'div'} variant="subtitle2">
            {axisSectionTitles[group.axis]} {index}
          </Typography>
          <StatusChip
            label={`判定: ${badge}`}
            tone={group.axis === 'bonus' && group.match === 'alternative' ? 'caution' : 'info'}
          />
        </Stack>
        <SearchDefinitionList>
          {group.axis === 'skill' ? (
            <>
              <SearchDefinitionItem label="シリーズスキル">
                {seriesSkillLabel(group.seriesSkillId, master)}
              </SearchDefinitionItem>
              <SearchDefinitionItem label="グループスキル">
                {groupSkillLabel(group.groupSkillId, master)}
              </SearchDefinitionItem>
            </>
          ) : (
            <>
              <SearchDefinitionItem label="復元ボーナス（5枠・判定は順不同）" span>
                <RestorationBonusSlots
                  bonuses={group.restorationBonuses}
                  weaponTypeId={weaponTypeId}
                  master={master}
                  scope={group.restorationBonusScope}
                  variant="outlined"
                  label={`復元ボーナス候補 ${index} の復元ボーナス5枠`}
                />
              </SearchDefinitionItem>
              <SearchDefinitionItem label={restorationBonusScopeFieldLabel}>
                {restorationBonusScopeLabels[group.restorationBonusScope]}
              </SearchDefinitionItem>
            </>
          )}
        </SearchDefinitionList>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            最短の到達点
          </Typography>
          <OpportunityRow
            candidate={candidate}
            opportunity={primary}
            selected={selectedOpportunityId === primary.id}
            onToggle={onToggle}
            disabled={disabled}
          />
        </Box>
        {later.length > 0 && (
          // Later arrivals at the very same state are kept, never deduplicated
          // away: a Counter conflict can make a later one the only usable
          // arrival (`docs/SEARCH_SPEC.md` 5.8.3).
          <DisclosureAccordion
            title={`その他の到達点（${later.length}）`}
            headingLevel={laterArrivalsLevel}
          >
            <Stack>
              {later.map((opportunity) => (
                <OpportunityRow
                  key={opportunity.id}
                  candidate={candidate}
                  opportunity={opportunity}
                  selected={selectedOpportunityId === opportunity.id}
                  onToggle={onToggle}
                  disabled={disabled}
                />
              ))}
            </Stack>
          </DisclosureAccordion>
        )}
      </Stack>
    </Paper>
  )
}

/** The Ideal end of one lane: the final goal, never selectable. */
function IdealEndCard({
  candidate,
  axis,
  weaponTypeId,
  master,
  headingLevel,
}: {
  candidate: BuildCandidate
  axis: IntermediateStateAxis
  weaponTypeId: string
  master: MasterDataRoot
  headingLevel: DisclosureHeadingLevel | null
}) {
  const headingId = useId()
  const length = laneLength(candidate, axis)
  const arrival =
    axis === 'skill'
      ? length === 0
        ? hasConversion(candidate)
          ? '巨戟化直後のスキルで到達（スキルリセット0回）'
          : '現在のスキルで到達（スキルリセット0回）'
        : `スキルリセット${length}回目で到達`
      : length === 0
        ? '現在の復元ボーナスで到達（復元ボーナス操作0回）'
        : `復元ボーナス操作${length}回目で到達`
  return (
    <Paper
      component="section"
      aria-labelledby={headingId}
      variant="outlined"
      sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}
    >
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component={headingLevel ?? 'div'} variant="subtitle2">
            {axisSectionTitles[axis]}（理想）
          </Typography>
          <StatusChip label="判定: 理想" tone="positive" />
          <StatusChip label="最終目標" tone="positive" />
        </Stack>
        <SearchDefinitionList>
          {axis === 'skill' ? (
            <>
              <SearchDefinitionItem label="シリーズスキル">
                {seriesSkillLabel(candidate.seriesSkillId, master)}
              </SearchDefinitionItem>
              <SearchDefinitionItem label="グループスキル">
                {groupSkillLabel(candidate.groupSkillId, master)}
              </SearchDefinitionItem>
            </>
          ) : (
            <SearchDefinitionItem label="復元ボーナス（5枠・判定は順不同）" span>
              <RestorationBonusSlots
                bonuses={candidate.finalBonuses}
                weaponTypeId={weaponTypeId}
                master={master}
                scope={candidate.restorationBonusScope}
                variant="outlined"
                label="理想の復元ボーナス5枠"
              />
            </SearchDefinitionItem>
          )}
        </SearchDefinitionList>
        <Typography variant="body2" color="text.secondary">
          {arrival}。理想品の最終状態なので途中採用の対象ではありません。
        </Typography>
      </Stack>
    </Paper>
  )
}

function AxisSection({
  candidate,
  axis,
  weaponTypeId,
  master,
  selection,
  onChange,
  disabled = false,
  headingLevel,
}: Omit<IntermediateStateSelectorProps, 'headingLevel' | 'selectionContext'> & {
  axis: IntermediateStateAxis
  headingLevel: DisclosureHeadingLevel
}) {
  const headingId = useId()
  const groups = (candidate.intermediateStateGroups ?? []).filter((group) => group.axis === axis)
  const primary = groups.filter((group) => group.axis === 'skill' || !group.isDisplaySecondary)
  const secondary = groups.filter((group) => group.axis === 'bonus' && group.isDisplaySecondary)
  const selectedOpportunityId =
    axis === 'skill' ? selection.skillOpportunityId : selection.bonusOpportunityId
  const groupLevel = hasDeeperHeadingLevel(headingLevel) ? nextHeadingLevel(headingLevel) : null
  const secondaryGroupLevel =
    groupLevel !== null && hasDeeperHeadingLevel(groupLevel) ? nextHeadingLevel(groupLevel) : null
  // At most one state per lane: choosing another state of the same lane
  // replaces the previous one rather than adding a second.
  const onToggle = onChange
    ? (opportunity: IntermediateStateOpportunity, selected: boolean) =>
        onChange({
          ...selection,
          [axis === 'skill' ? 'skillOpportunityId' : 'bonusOpportunityId']: selected
            ? opportunity.id
            : null,
        })
    : undefined
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Stack spacing={1}>
        <Typography id={headingId} component={headingLevel} variant="subtitle1">
          {axisSectionTitles[axis]}
        </Typography>
        {groups.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {axisEmptyMessages[axis]}
          </Typography>
        )}
        {primary.map((group, position) => (
          <GroupCard
            key={group.id}
            candidate={candidate}
            group={group}
            index={position + 1}
            weaponTypeId={weaponTypeId}
            master={master}
            selectedOpportunityId={selectedOpportunityId}
            onToggle={onToggle}
            disabled={disabled}
            headingLevel={groupLevel}
          />
        ))}
        {secondary.length > 0 && (
          <DisclosureAccordion
            title={`その他の候補（${secondary.length}）`}
            headingLevel={groupLevel ?? 'none'}
          >
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                同じ区分で、より良い復元ボーナスへ同じ操作回数以内に到達できる候補があるため折りたたんでいます。選択は可能です。
              </Typography>
              {secondary.map((group, position) => (
                <GroupCard
                  key={group.id}
                  candidate={candidate}
                  group={group}
                  index={primary.length + position + 1}
                  weaponTypeId={weaponTypeId}
                  master={master}
                  selectedOpportunityId={selectedOpportunityId}
                  onToggle={onToggle}
                  disabled={disabled}
                  headingLevel={secondaryGroupLevel}
                />
              ))}
            </Stack>
          </DisclosureAccordion>
        )}
        <IdealEndCard
          candidate={candidate}
          axis={axis}
          weaponTypeId={weaponTypeId}
          master={master}
          headingLevel={groupLevel}
        />
      </Stack>
    </Box>
  )
}

function ImprovementPreferenceControl({
  value,
  onChange,
  disabled = false,
}: {
  value: ImprovementPreference
  onChange?: (value: ImprovementPreference) => void
  disabled?: boolean
}) {
  const labelId = useId()
  if (!onChange) {
    return (
      <Typography variant="body2">
        理想品までの改善優先: {improvementPreferenceLabels[value]}
      </Typography>
    )
  }
  return (
    <FormControl component="fieldset">
      <FormLabel id={labelId} component="legend">
        理想品までの改善優先
      </FormLabel>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        妥協品として利用できる状態に到達した後、スキルと復元ボーナスのどちらを先に理想へ近づけるかの希望です。生産計画全体の成立を優先するため、他の目標武器との兼ね合いで別の順序になることがあります。
      </Typography>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onChange={(event) => onChange(event.target.value as ImprovementPreference)}
      >
        {improvementPreferences.map((preference) => (
          <FormControlLabel
            key={preference}
            value={preference}
            control={<Radio />}
            disabled={disabled}
            label={improvementPreferenceLabels[preference]}
            sx={{ minHeight: 44 }}
          />
        ))}
      </RadioGroup>
    </FormControl>
  )
}

/**
 * The intermediate states of one canonical Ideal Route, one lane at a time,
 * plus the improvement preference (`docs/UI_FLOW.md` 9).
 *
 * Nothing here is a separate Candidate: every entry is a state of the same
 * physical Route. The user never picks a Skill × Bonus combination; the
 * Planner treats the moment both selected states are held as the compromise
 * checkpoint, and the Route continues to the Ideal afterwards.
 */
export function IntermediateStateSelector(props: IntermediateStateSelectorProps) {
  const { candidate, selection, onChange, disabled = false, headingLevel = 'h4', selectionContext = 'search' } = props
  const sectionHeadingId = useId()
  const axisLevel = hasDeeperHeadingLevel(headingLevel) ? nextHeadingLevel(headingLevel) : headingLevel
  const groups = candidate.intermediateStateGroups ?? []
  return (
    <Box component="section" aria-labelledby={sectionHeadingId}>
      <Stack spacing={1.5}>
        <Typography id={sectionHeadingId} component={headingLevel} variant="subtitle1">
          途中採用できる状態と改善優先
        </Typography>
        {groups.length === 0 ? (
          <Alert severity="info">
            この理想ルートの途中に、妥協条件を満たすスキル状態・復元ボーナス状態はありません。
          </Alert>
        ) : (
          onChange && (
            <Typography variant="body2" color="text.secondary">
              {selectionDescriptions[selectionContext]}
            </Typography>
          )
        )}
        <AxisSection {...props} axis="skill" headingLevel={axisLevel} />
        <AxisSection {...props} axis="bonus" headingLevel={axisLevel} />
        <ImprovementPreferenceControl
          value={selection.improvementPreference}
          disabled={disabled}
          onChange={
            onChange
              ? (improvementPreference) => onChange({ ...selection, improvementPreference })
              : undefined
          }
        />
      </Stack>
    </Box>
  )
}
