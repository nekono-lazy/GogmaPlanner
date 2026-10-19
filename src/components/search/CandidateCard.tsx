import { useId, type ReactNode } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Stack,
  Typography,
} from '@mui/material'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { nextHeadingLevel } from '../headingLevel'
import { RestorationBonusSlots } from '../RestorationBonusSlots'
import { StatusChip } from '../StatusChip'
import {
  IntermediateStateSelector,
  type IntermediateStateSelectionContext,
} from './IntermediateStateSelector'
import { SearchDefinitionItem, SearchDefinitionList } from './SearchDefinitionList'
import {
  candidateRouteOriginLabel,
  describePreferredOwnedWeaponNotice,
  preferredOwnedWeaponNoticeExplanation,
  preferredOwnedWeaponNoticeTitle,
} from './preferredOwnedWeaponNotice'
import {
  describePreferredOwnedWeaponExclusion,
  type SearchSourceExclusionDisplay,
} from './sourceExclusionPresentation'
import { CostEstimateSummary } from '../cost/CostEstimateSummary'
import { estimateCandidateCost } from '../../domain/cost'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildCandidate,
  IntermediateStateSelection,
  OwnedWeapon,
  SkillAmendmentResult,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import { restorationBonusScopeFieldLabel, restorationBonusScopeLabels } from '../../presentation/labels'
import {
  bonusLabel,
  groupSkillLabel,
  operationLabel,
  routeKindLabels,
  seriesSkillLabel,
} from './searchPresentation'

interface CandidateCardProps {
  candidate: BuildCandidate
  target: TargetWeapon | null
  master: MasterDataRoot
  ownedWeapons?: readonly OwnedWeapon[]
  debugMode?: boolean
  onAdd?: (candidate: BuildCandidate) => void
  addDisabled?: boolean
  /**
   * Feedback about the last Build List addition, rendered next to the button
   * that caused it so its relation to this Candidate is unambiguous.
   */
  addFeedback?: ReactNode
  /**
   * Whether an equivalent Candidate is already in the Build List
   * (`docs/UI_FLOW.md` 9 「作成リスト追加状態」).
   *
   * Decided by the owner with the Build List Domain authority
   * (`isSameBuildListCandidate()`), never here and never by Candidate ID. An
   * `added` Candidate disables the add button as a convenience only: the
   * Build List Service keeps its own duplicate protection.
   */
  buildListStatus?: 'added' | 'not_added'
  /**
   * The intermediate states and improvement preference the user has chosen.
   *
   * They are a BuildListEntry input, never part of the Candidate, so the owner
   * of the selection passes it in rather than the card holding it
   * (`docs/DATA_MODEL.md` 9.4). Omitted means nothing is selected and the
   * selector is read-only.
   */
  intermediateStateSelection?: IntermediateStateSelection
  onIntermediateStateSelectionChange?: (selection: IntermediateStateSelection) => void
  /**
   * The selection controls stay visible but cannot be changed while a save of
   * a selection is in flight or waits for the user's confirmation.
   */
  intermediateStateSelectionDisabled?: boolean
  /**
   * Which screen the editable selection explanation is written for. The
   * Search screen is the default; the Build List, where the Candidate is
   * already registered, passes `build_list`.
   */
  intermediateStateSelectionContext?: IntermediateStateSelectionContext
  /**
   * Heading level of the card heading. Detail and selection sections take
   * the following levels, so the outline stays sequential where the card is
   * embedded under a Target group heading (Build List) or directly under a
   * section heading (Search).
   */
  headingLevel?: 'h3' | 'h4'
  /**
   * Whether to say so when the Route does not start from the Target's preferred
   * owned weapon (Issue #128, `docs/UI_FLOW.md` 9). The Search screen compares
   * a fresh result with the Target it was searched for. The Build List leaves
   * it off: an Entry keeps its Candidate snapshot while Execution later links
   * the Target to the weapon the Plan registers, so the comparison would no
   * longer describe the choice the Search made.
   */
  showPreferredOwnedWeaponNotice?: boolean
  /**
   * What the search that produced this Candidate excluded with 「他の目標武器で使用する所持武器を除外する」
   * (Issue #157, `docs/UI_FLOW.md` 9 / 9.2). Only the Search screen passes it, and only to add to the Issue #128
   * notice why the preferred owned weapon was not a starting point of that search. Display-only.
   */
  searchSourceExclusion?: SearchSourceExclusionDisplay | null
}

/** One figure of the operation summary. */
function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.25, py: 1, minWidth: 0 }}>
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography component="dd" variant="subtitle1" className="tabular-nums" sx={{ m: 0 }}>
        {value}
      </Typography>
    </Box>
  )
}

export function CandidateCard({
  candidate,
  target,
  master,
  ownedWeapons = [],
  debugMode = false,
  onAdd,
  addDisabled = false,
  addFeedback,
  buildListStatus,
  intermediateStateSelection = {
    skillOpportunityId: null,
    bonusOpportunityId: null,
    improvementPreference: 'planner',
  },
  onIntermediateStateSelectionChange,
  intermediateStateSelectionDisabled = false,
  intermediateStateSelectionContext = 'search',
  headingLevel = 'h3',
  showPreferredOwnedWeaponNotice = false,
  searchSourceExclusion = null,
}: CandidateCardProps) {
  const headingId = useId()
  const sectionLevel = nextHeadingLevel(headingLevel)
  const detailLevel = nextHeadingLevel(sectionLevel)
  const weaponTypeId = target?.weaponTypeId ?? candidate.route.operations.find(
    (operation) => 'weaponTypeId' in operation,
  )?.weaponTypeId ?? ''
  // Keyed by the operation's own index, so a run of identical Reset or Keep
  // operations can never be shifted by one against its predicted result.
  const amendmentByOperationIndex = new Map(
    (candidate.bonusAmendmentTrace ?? []).map((step) => [step.operationIndex, step]),
  )
  const missingAmendmentTrace =
    candidate.bonusAmendmentTrace === undefined &&
    candidate.route.operations.some(
      (operation) =>
        operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses',
    )
  // Same binding rule for every Skill prediction: consecutive Reset Skills
  // operations are told apart by their own operation index, never by their
  // position among the Reset Skills alone. The conversion's initial Skill
  // assignment is a separate observational contract, but it describes the same
  // kind of result and renders identically, so both share one lookup keyed by
  // the operation they belong to. The two can never collide: one describes
  // `reset_skills`, the other `convert_normal_to_gogma`.
  const skillPredictionByOperationIndex = new Map<number, SkillAmendmentResult>([
    ...(candidate.skillAmendmentTrace ?? []).map(
      (step) => [step.operationIndex, step] as const,
    ),
    ...(candidate.conversionSkillTrace === undefined
      ? []
      : [[candidate.conversionSkillTrace.operationIndex, candidate.conversionSkillTrace] as const]),
  ])
  const missingSkillAmendmentTrace =
    candidate.skillAmendmentTrace === undefined &&
    candidate.route.operations.some((operation) => operation.type === 'reset_skills')
  const sourceName = candidate.route.sourceOwnedWeaponId === null
    ? null
    : ownedWeapons.find(({ id }) => id === candidate.route.sourceOwnedWeaponId)?.name ??
      '参照元の所持武器が見つかりません'
  const preferredOwnedWeaponNotice = showPreferredOwnedWeaponNotice
    ? describePreferredOwnedWeaponNotice(candidate, target, ownedWeapons)
    : null
  const preferredOwnedWeaponExclusion = preferredOwnedWeaponNotice
    ? describePreferredOwnedWeaponExclusion(candidate, target, searchSourceExclusion)
    : null
  const scope = candidate.restorationBonusScope
  // Display-only, derived from the saved Route at render time: never persisted,
  // never a Search or Planner input (`docs/SEARCH_SPEC.md` 4.3).
  const costEstimate = estimateCandidateCost(candidate)

  return (
    <Card component="section" aria-labelledby={headingId} variant="outlined">
      <CardContent sx={{ p: { xs: 2, md: 2.5 }, '&:last-child': { pb: { xs: 2, md: 2.5 } } }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography id={headingId} component={headingLevel} variant="h3">
              理想候補
            </Typography>
            <StatusChip label={routeKindLabels[candidate.route.kind]} tone="info" />
            {buildListStatus === 'added' && <StatusChip label="作成リスト: 追加済み" tone="positive" />}
            {buildListStatus === 'not_added' && <StatusChip label="作成リスト: 未追加" tone="neutral" />}
          </Stack>

          {/* The finished weapon. The five slots keep their stored order and the
              scope says whether they are still the normal-tier slots inherited
              at conversion or Gogma-tier slots after an amendment
              (`docs/UI_FLOW.md` 9). */}
          <SearchDefinitionList>
            <SearchDefinitionItem label="完成時の復元ボーナス（5枠・判定は順不同）" span>
              <RestorationBonusSlots
                bonuses={candidate.finalBonuses}
                weaponTypeId={weaponTypeId}
                master={master}
                scope={scope}
                label="完成時の復元ボーナス5枠"
              />
            </SearchDefinitionItem>
            <SearchDefinitionItem label={restorationBonusScopeFieldLabel}>
              <StatusChip
                label={restorationBonusScopeLabels[scope]}
                tone={scope === 'gogma_artian' ? 'info' : 'caution'}
              />
            </SearchDefinitionItem>
            <SearchDefinitionItem label="シリーズスキル / グループスキル">
              シリーズ: {seriesSkillLabel(candidate.seriesSkillId, master)} ／ グループ:{' '}
              {groupSkillLabel(candidate.groupSkillId, master)}
            </SearchDefinitionItem>
          </SearchDefinitionList>

          <Box
            component="dl"
            aria-label="操作量の概要"
            sx={{
              m: 0,
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
              gap: 1,
            }}
          >
            <SummaryTile label="操作回数" value={`${candidate.estimatedOperationCount}回`} />
            <SummaryTile label="通常進行" value={candidate.estimatedNormalAdvance === null ? '—' : `${candidate.estimatedNormalAdvance}`} />
            <SummaryTile label="復元ボーナス進行" value={`${candidate.estimatedGogmaAdvance}`} />
            <SummaryTile label="スキル進行" value={`${candidate.estimatedSkillAdvance}`} />
          </Box>

          {/* The notice names the Route's own origin too, so it takes the
              plain origin Alert's place rather than stacking beside it. */}
          {preferredOwnedWeaponNotice ? (
            <Alert severity="warning">
              <AlertTitle>{preferredOwnedWeaponNoticeTitle}</AlertTitle>
              <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  優先する所持武器: {preferredOwnedWeaponNotice.preferredWeaponName}
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  このルートの起点: {candidateRouteOriginLabel(preferredOwnedWeaponNotice.routeOrigin)}
                </Typography>
                <Typography variant="body2">{preferredOwnedWeaponNoticeExplanation}</Typography>
                {preferredOwnedWeaponExclusion && (
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {preferredOwnedWeaponExclusion}
                  </Typography>
                )}
              </Stack>
            </Alert>
          ) : sourceName && (
            <Alert severity={sourceName.startsWith('参照元') ? 'warning' : 'info'}>
              起点武器: {sourceName}
            </Alert>
          )}

          {/* Long Routes reach well over a hundred amendments, so the detail
              content is mounted only while the panel is open. */}
          <DisclosureAccordion title="候補詳細・作成ルート" headingLevel={sectionLevel} unmountOnExit>
            <Stack spacing={2}>
              <Box>
                <Typography component={detailLevel} variant="subtitle2" sx={{ mb: 1 }}>
                  理想との差分
                </Typography>
                <SearchDefinitionList>
                  <SearchDefinitionItem label="ボーナス一致">
                    {candidate.idealDifference.matchedBonusCount}/5
                  </SearchDefinitionItem>
                  <SearchDefinitionItem label="スキル一致">
                    シリーズ{candidate.idealDifference.seriesSkillMatches ? '一致' : '不一致'} ／ グループ
                    {candidate.idealDifference.groupSkillMatches ? '一致' : '不一致'}
                  </SearchDefinitionItem>
                  <SearchDefinitionItem label="不足">
                    {candidate.idealDifference.missingBonuses
                      .map((bonus) => bonusLabel(bonus, weaponTypeId, master, 'gogma_artian'))
                      .join('、') || 'なし'}
                  </SearchDefinitionItem>
                  <SearchDefinitionItem label="余剰">
                    {candidate.idealDifference.extraBonuses
                      .map((bonus) => bonusLabel(bonus, weaponTypeId, master, scope))
                      .join('、') || 'なし'}
                  </SearchDefinitionItem>
                </SearchDefinitionList>
              </Box>
              <Divider />
              <Box>
                <Typography component={detailLevel} variant="subtitle2" sx={{ mb: 1 }}>
                  作成ルート（実行順）
                </Typography>
                {missingAmendmentTrace && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    この候補には各復元ボーナス操作後の予測結果が記録されていません。
                  </Typography>
                )}
                {missingSkillAmendmentTrace && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    この候補には各スキルリセット後の予測結果が記録されていません。
                  </Typography>
                )}
                <Box component="ol" sx={{ m: 0, pl: 3, display: 'grid', gap: 0.75 }}>
                  {candidate.route.operations.map((operation, index) => {
                    const amendment = amendmentByOperationIndex.get(index)
                    const skillPrediction = skillPredictionByOperationIndex.get(index)
                    return (
                      <Box component="li" key={`${operation.type}:${index}`} sx={{ minWidth: 0 }}>
                        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                          <Typography variant="body2">{operationLabel(operation)}</Typography>
                          {amendment && (
                            <Stack
                              direction="row"
                              spacing={0.5}
                              useFlexGap
                              sx={{ flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}
                            >
                              <Typography variant="caption" color="text.secondary">
                                予測結果:
                              </Typography>
                              <RestorationBonusSlots
                                bonuses={amendment.restorationBonuses}
                                weaponTypeId={weaponTypeId}
                                master={master}
                                scope={amendment.restorationBonusScope}
                                variant="outlined"
                                label={`${index + 1}番目の操作後の復元ボーナス5枠`}
                              />
                            </Stack>
                          )}
                          {skillPrediction && (
                            <Stack
                              direction="row"
                              spacing={0.5}
                              useFlexGap
                              sx={{ flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}
                            >
                              <Typography variant="caption" color="text.secondary">
                                予測結果:
                              </Typography>
                              <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                                シリーズ: {seriesSkillLabel(skillPrediction.seriesSkillId, master)} ／ グループ:{' '}
                                {groupSkillLabel(skillPrediction.groupSkillId, master)}
                              </Typography>
                            </Stack>
                          )}
                        </Stack>
                      </Box>
                    )
                  })}
                </Box>
              </Box>
              {/* The persisted `requiredMaterials` (Master-priced, empty under the
                  bundled all-disabled cost Master) is not shown here; the
                  estimate below is the user-facing figure (`docs/UI_FLOW.md` 9). */}
              <CostEstimateSummary summary={costEstimate} headingLevel={detailLevel} />
              {debugMode && (
                <Alert severity="info">
                  Candidate ID: {candidate.id}<br />searchRunId: {candidate.searchRunId}<br />
                  searchStateHash: {candidate.searchStateHash}<br />referencedOwnedWeaponsHash: {candidate.referencedOwnedWeaponsHash ?? 'null'}<br />
                  RouteKind: {candidate.route.kind}
                </Alert>
              )}
            </Stack>
          </DisclosureAccordion>

          {/* An intermediate state belongs to this very Route, so it is shown
              on the Candidate that owns it rather than as a separate result
              (`docs/UI_FLOW.md` 9). */}
          <IntermediateStateSelector
            candidate={candidate}
            weaponTypeId={weaponTypeId}
            master={master}
            selection={intermediateStateSelection}
            onChange={onIntermediateStateSelectionChange}
            disabled={intermediateStateSelectionDisabled}
            headingLevel={sectionLevel}
            selectionContext={intermediateStateSelectionContext}
          />

          <Divider />
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary" className="tabular-nums">
              理想品の完成: {candidate.estimatedOperationCount}手目（この候補の最終状態）
            </Typography>
            {/* State-derived, permanent guidance for an already-added Candidate
                (`docs/UI_FLOW.md` 9): the Build List owns its selection, and
                this screen's draft never overwrites it. */}
            {buildListStatus === 'added' && (
              <Alert severity="info">
                この候補は作成リストに追加済みです。途中採用する状態と改善優先は作成リストで変更してください。
              </Alert>
            )}
            {onAdd && (
              <Button
                variant="contained"
                onClick={() => onAdd(candidate)}
                disabled={addDisabled || buildListStatus === 'added'}
                sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
              >
                ビルドリストへ追加
              </Button>
            )}
            {addFeedback}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}
