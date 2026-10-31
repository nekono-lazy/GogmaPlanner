import { useEffect, useId, useMemo, useRef, type ReactNode, type Ref } from 'react'
import {
  Alert,
  Box,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { ProductionPlan } from '../../domain/models/publicTypes'
import type { BuildListOptimizationArtifact } from '../../domain/planner/buildListOptimization'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { PreviewAdoptionActions } from '../PreviewAdoptionActions'
import { StatusChip } from '../StatusChip'
import { useKeepFocusAboveAdoptionActions } from '../useKeepFocusAboveAdoptionActions'
import { BuildListOptimizationDiagnosticsDetails } from './BuildListOptimizationDiagnostics'
import {
  ADOPTION_INSPECTING_MESSAGE,
  BUILD_LIST_OPTIMIZATION_ADOPTION_ACTIONS_LABEL,
  BUILD_LIST_OPTIMIZATION_ADOPTION_ACTIONS_LEAD,
  BUILD_LIST_OPTIMIZATION_DRAFT_NOT_COMPARABLE_DETAIL,
  BUILD_LIST_OPTIMIZATION_NO_COMPARABLE_DRAFT_MESSAGE,
  BUILD_LIST_OPTIMIZATION_PREVIEW_DESCRIPTION,
  BUILD_LIST_OPTIMIZATION_PREVIEW_DRAFT_REPLACED_MESSAGE,
  BUILD_LIST_OPTIMIZATION_PREVIEW_TITLE,
  BUILD_LIST_OPTIMIZATION_PREVIEW_UNCHANGED_MESSAGE,
  PLANNED_COMPLETION_PREDICTION_GUIDE,
  PLANNED_COMPLETION_PREDICTION_LEAD,
  PLANNED_COMPLETION_PREDICTION_UNREADABLE,
  PLANNED_COMPLETION_VARIANTS_DESCRIPTION,
  PLANNED_COMPLETION_VARIANTS_EMPTY,
  PLANNED_COMPLETION_VARIANTS_TITLE,
  UNRESOLVED_TARGET_LABEL,
  plannedCompletionPredictionUnavailableText,
  buildListOptimizationAdoptionCheckItems,
  buildListOptimizationCompletionDetail,
  buildListOptimizationRouteBaseLabel,
  compareBuildListOptimizationWithDraft,
  createBuildListOptimizationPreviewModel,
  type BuildListOptimizationDraftComparison,
  type BuildListOptimizationPreviewModel,
  type BuildListOptimizationPreviewStartContext,
  type BuildListOptimizationReplacementView,
  type BuildListOptimizationTargetDisplay,
  type BuildListOptimizationTargetList,
  type PlannedCompletionPrediction,
  type PlannedCompletionVariantsRow,
} from './buildListOptimizationPresentation'
import { RestorationBonusSlots } from '../RestorationBonusSlots'
import { SearchDefinitionItem, SearchDefinitionList } from '../search/SearchDefinitionList'
import { groupSkillLabel, seriesSkillLabel } from '../search/searchPresentation'
import { AchievedCompletionVariants } from '../target/AchievedCompletionVariants'
import { ProductionPlanContent } from './ProductionPlanContent'
import { SummaryFigure } from './ProductionPlanSummary'

/** A titled sub-section of the Preview (one level below the Preview heading). Shared with the running Plan replan Preview. */
export function PreviewSection({ title, chip, children }: { title: string; chip?: ReactNode; children: ReactNode }) {
  const headingId = useId()
  return (
    <Paper component="section" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component="h3" variant="h3">
            {title}
          </Typography>
          {chip}
        </Stack>
        {children}
      </Stack>
    </Paper>
  )
}

/** A Target's name with its weapon type and element (never its ID). */
export function TargetName({ target }: { target: BuildListOptimizationTargetDisplay | null }) {
  if (target === null) return <>{UNRESOLVED_TARGET_LABEL}</>
  return (
    <>
      {target.name}
      <Typography component="span" variant="body2" color="text.secondary">
        （{target.weaponLabel}）
      </Typography>
    </>
  )
}

/** A list of Targets by name, with the unresolved ones counted instead of shown as IDs. */
export function TargetNameList({ list, label }: { list: BuildListOptimizationTargetList; label: string }) {
  return (
    <Box component="ul" aria-label={label} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
      {list.targets.map((target) => (
        <Typography component="li" variant="body2" key={target.key} sx={{ overflowWrap: 'anywhere' }}>
          <TargetName target={target} />
        </Typography>
      ))}
      {list.unresolvedCount > 0 && (
        <Typography component="li" variant="body2">
          {UNRESOLVED_TARGET_LABEL}（{list.unresolvedCount}件）
        </Typography>
      )}
    </Box>
  )
}

/**
 * What one planned Target finishes with (Issue #360): the completing Entry's Candidate Snapshot as the row recorded it - its five slots
 * in their stored order with their actual ranks, and its Series / Group Skills - never the Target's registered condition. A part the
 * Snapshot does not hold readably, or whose Master references do not resolve, says so instead of showing a partial name, and a
 * missing Target, Entry or Snapshot shows no prediction at all.
 */
function PlannedCompletionPredictionDetails({ prediction, master }: { prediction: PlannedCompletionPrediction; master: MasterDataRoot }) {
  if (prediction.kind === 'unavailable') {
    return (
      <Typography variant="body2" color="text.secondary">
        完成時の予測：{plannedCompletionPredictionUnavailableText(prediction.reason)}
      </Typography>
    )
  }
  const unreadable = (
    <Typography variant="body2" color="text.secondary">{PLANNED_COMPLETION_PREDICTION_UNREADABLE}</Typography>
  )
  const { bonuses, seriesSkillId, groupSkillId } = prediction
  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">{PLANNED_COMPLETION_PREDICTION_LEAD}</Typography>
      <SearchDefinitionList>
        <SearchDefinitionItem label="完成時の復元ボーナス（5枠）" span>
          {bonuses.kind === 'readable' ? (
            <RestorationBonusSlots
              bonuses={bonuses.value.slots}
              weaponTypeId={prediction.weaponTypeId}
              master={master}
              scope={bonuses.value.scope}
              label="完成時の復元ボーナス5枠"
            />
          ) : unreadable}
        </SearchDefinitionItem>
        <SearchDefinitionItem label="完成時のシリーズスキル">
          {seriesSkillId.kind === 'readable'
            ? <Typography variant="body2">{seriesSkillLabel(seriesSkillId.value, master)}</Typography>
            : unreadable}
        </SearchDefinitionItem>
        <SearchDefinitionItem label="完成時のグループスキル">
          {groupSkillId.kind === 'readable'
            ? <Typography variant="body2">{groupSkillLabel(groupSkillId.value, master)}</Typography>
            : unreadable}
        </SearchDefinitionItem>
      </SearchDefinitionList>
    </Stack>
  )
}

/**
 * One planned Target as its own disclosure (Issue #360): closed, it names the Target, its weapon type / element and the Variants it
 * achieves, as the list always showed; opened, the completion prediction. The summary is phrasing content only, because the toggle is a
 * native button.
 */
function PlannedCompletionVariantsItem({ row, master }: { row: PlannedCompletionVariantsRow; master: MasterDataRoot }) {
  return (
    <DisclosureAccordion
      title={row.target?.name ?? UNRESOLVED_TARGET_LABEL}
      headingLevel="h5"
      unmountOnExit
      summary={
        <Stack component="span" spacing={0.25} sx={{ minWidth: 0 }}>
          {row.target !== null && (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
              {row.target.weaponLabel}
            </Typography>
          )}
          <AchievedCompletionVariants achieved={row.achieved} skill={row.skillAchieved} layout="line" component="span" />
        </Stack>
      }
    >
      <PlannedCompletionPredictionDetails prediction={row.prediction} master={master} />
    </DisclosureAccordion>
  )
}

/**
 * Each Target the Plan completes with the completion Variants it achieves, judged at display time from the completing Entry's
 * Candidate Snapshot and the start-time Target (`docs/REQUIREMENTS.md` 13.2 / 19.1, `docs/UI_FLOW.md` 10.4), each opening on what that
 * Snapshot finishes with (Issue #360). Shared with the running Plan replan Preview. Nothing is persisted.
 */
export function PlannedCompletionVariantsSection({ rows, master }: { rows: readonly PlannedCompletionVariantsRow[]; master: MasterDataRoot }) {
  return (
    <PreviewSection title={PLANNED_COMPLETION_VARIANTS_TITLE}>
      <Typography variant="body2" color="text.secondary">{PLANNED_COMPLETION_VARIANTS_DESCRIPTION}</Typography>
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{PLANNED_COMPLETION_VARIANTS_EMPTY}</Typography>
      ) : (
        <DisclosureAccordion title={`目標武器ごとの達成する完成構成（${rows.length}本）`} headingLevel="h4" unmountOnExit>
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">{PLANNED_COMPLETION_PREDICTION_GUIDE}</Typography>
            <Box component="ul" aria-label="目標武器ごとの達成する完成構成" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
              {rows.map((row) => (
                <Box component="li" key={row.key} sx={{ minWidth: 0 }}>
                  <PlannedCompletionVariantsItem row={row} master={master} />
                </Box>
              ))}
            </Box>
          </Stack>
        </DisclosureAccordion>
      )}
    </PreviewSection>
  )
}

/** The overview of the 17.9 items, each figure from its own authority (the artifact summary or the final Plan). */
function PreviewOverview({ model }: { model: BuildListOptimizationPreviewModel }) {
  const completion = model.plannedCompletionTargetCount
  const completionDetail = buildListOptimizationCompletionDetail(model) ?? undefined
  const outOfScopeRows = model.outOfScopeRows.filter(({ count }) => count > 0)
  const hasConflicts = model.conflictCount > 0
  return (
    <PreviewSection
      title="試算の概要"
      chip={<StatusChip label={hasConflicts ? `競合あり（${model.conflictCount}件）` : '競合なし'} tone={hasConflicts ? 'caution' : 'neutral'} />}
    >
      <Box
        component="dl"
        sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}
      >
        <SummaryFigure
          label="完成予定の目標武器"
          value={completion === null ? '不明' : `${completion} / ${model.planningTargetCount}`}
          numeric={completion !== null}
          detail={completionDetail}
        />
        <SummaryFigure
          label="今回の計画対象の目標武器"
          value={model.planningTargetCount}
          numeric
          detail="作成リストに有効な候補がある目標武器"
        />
        <SummaryFigure
          label="対象外の目標武器"
          value={model.outOfScopeTotal}
          numeric
          detail="計画対象の数には含めません"
        />
        <SummaryFigure
          label="競合"
          value={hasConflicts ? `${model.conflictCount}件` : '競合なし'}
          numeric={hasConflicts}
        />
        <SummaryFigure label="ゲーム内の操作回数" value={model.physicalOperationCount} numeric detail="物理操作の回数" />
        <SummaryFigure
          label="計画ステップ数"
          value={model.planStepCount}
          numeric
          detail={`確認ステップ${model.nonPhysicalStepCount}件を含む`}
        />
        <SummaryFigure label="置き換わる候補" value={`${model.replacements.length}件`} numeric />
        <SummaryFigure label="変更なしの目標武器" value={`${model.unchangedTargets.targets.length + model.unchangedTargets.unresolvedCount}件`} numeric />
      </Box>
      <Box>
        <Typography component="p" variant="subtitle2">対象外の目標武器の内訳</Typography>
        {outOfScopeRows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">対象外の目標武器はありません。</Typography>
        ) : (
          <Box component="ul" aria-label="対象外の目標武器の内訳" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
            {outOfScopeRows.map((row) => (
              <Typography component="li" variant="body2" key={row.key} className="tabular-nums">
                {row.label}：{row.count}件
              </Typography>
            ))}
          </Box>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary">
        ゲーム内の操作回数は、所持している理想品の確認など、ゲーム内の操作を伴わない確認ステップを含みません。
      </Typography>
    </PreviewSection>
  )
}

/** The current Draft beside the Preview, only when both come from the same input state (17.9). */
function DraftComparison({ comparison }: { comparison: BuildListOptimizationDraftComparison }) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  if (comparison.status !== 'comparable') {
    return (
      <PreviewSection title="現在の下書きとの比較">
        <Typography variant="body2">{BUILD_LIST_OPTIMIZATION_NO_COMPARABLE_DRAFT_MESSAGE}</Typography>
        {comparison.status === 'not_comparable' && (
          <Typography variant="body2" color="text.secondary">{BUILD_LIST_OPTIMIZATION_DRAFT_NOT_COMPARABLE_DETAIL}</Typography>
        )}
      </PreviewSection>
    )
  }
  return (
    <PreviewSection title="現在の下書きとの比較">
      <Typography variant="body2" color="text.secondary">
        現在の下書きは、この試算と同じ作成リスト・目標武器・状態から作られています。それぞれの記録をそのまま並べています。
      </Typography>
      {isDesktop ? (
        <Table size="small" aria-label="現在の下書きと全体最適化の試算の比較" sx={{ '& th, & td': { overflowWrap: 'anywhere' } }}>
          <TableHead>
            <TableRow>
              <TableCell>項目</TableCell>
              <TableCell>現在の下書き</TableCell>
              <TableCell>全体最適化の試算</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {comparison.rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell component="th" scope="row">{row.label}</TableCell>
                <TableCell className="tabular-nums">{row.draft}</TableCell>
                <TableCell className="tabular-nums">{row.preview}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        // Narrow screens: one card per item, labels and values stacked (no horizontally scrolling table).
        <Stack component="ul" aria-label="現在の下書きと全体最適化の試算の比較" spacing={1} sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {comparison.rows.map((row) => (
            <Box component="li" key={row.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 0 }}>
              <Typography component="p" variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>{row.label}</Typography>
              <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 1, rowGap: 0.25 }}>
                <Typography component="dt" variant="body2" color="text.secondary">現在の下書き</Typography>
                <Typography component="dd" variant="body2" className="tabular-nums" sx={{ m: 0 }}>{row.draft}</Typography>
                <Typography component="dt" variant="body2" color="text.secondary">全体最適化の試算</Typography>
                <Typography component="dd" variant="body2" className="tabular-nums" sx={{ m: 0 }}>{row.preview}</Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </PreviewSection>
  )
}

function sourceChangeChip(replacement: BuildListOptimizationReplacementView): ReactNode {
  if (replacement.sourceChanged === null) return null
  return replacement.sourceChanged
    ? <StatusChip component="span" label="起点が変わります" tone="caution" />
    : <StatusChip component="span" label="起点は同じ（ルートを変更）" tone="info" />
}

/** One replaced Target: its route base before and after, and its preferred weapon. */
export function ReplacementCard({ replacement }: { replacement: BuildListOptimizationReplacementView }) {
  return (
    <Box component="li" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0, listStyle: 'none' }}>
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography component="p" variant="subtitle1" sx={{ overflowWrap: 'anywhere' }}>
            <TargetName target={replacement.target} />
          </Typography>
          <StatusChip component="span" label="置換" tone="info" />
          {sourceChangeChip(replacement)}
        </Stack>
        <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'max-content minmax(0, 1fr)' }, columnGap: 1.5, rowGap: 0.25 }}>
          <Typography component="dt" variant="body2" color="text.secondary">置き換え前の起点</Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>{buildListOptimizationRouteBaseLabel(replacement.before)}</Typography>
          <Typography component="dt" variant="body2" color="text.secondary">新しい候補の起点</Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>{buildListOptimizationRouteBaseLabel(replacement.after)}</Typography>
        </Box>
        {replacement.preferredSourceNotUsed !== null && (
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            優先する所持武器「{replacement.preferredSourceNotUsed.preferredName}」とは異なる起点で作成します。
          </Typography>
        )}
      </Stack>
    </Box>
  )
}

/** What adopting would change in the Build List (17.5 / 17.9 / 17.14). Details sit in disclosures, unmounted while closed. */
function BuildListChanges({ model }: { model: BuildListOptimizationPreviewModel }) {
  const replacementCount = model.replacements.length
  const unchangedCount = model.unchangedTargets.targets.length + model.unchangedTargets.unresolvedCount
  return (
    <PreviewSection title="作成リストの変更内容">
      {!model.startContextAvailable && (
        <Alert severity="info">
          計算開始時の作成リストの情報が無いため、置き換え前の起点と、目標武器の名前・優先する所持武器は表示できません。
        </Alert>
      )}
      {replacementCount === 0 ? (
        <Typography variant="body2">
          置き換える候補はありません（すべての目標武器が変更なし）。作成リストの置き換えは不要で、採用すると生産計画だけを作成します。
        </Typography>
      ) : (
        <>
          <Typography variant="body2" className="tabular-nums">
            {`採用すると、作成リストの候補${replacementCount}件が新しい候補に置き換わります。`}
          </Typography>
          <Box>
            <Typography component="h4" variant="subtitle2">優先する所持武器と異なる起点で作成する目標武器</Typography>
            {model.preferredSourceDifferences.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {model.startContextAvailable ? 'ありません。' : '確認できません。'}
              </Typography>
            ) : (
              <Box component="ul" aria-label="優先する所持武器と異なる起点で作成する目標武器" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
                {model.preferredSourceDifferences.map((replacement) => (
                  <Typography component="li" variant="body2" key={replacement.key} sx={{ overflowWrap: 'anywhere' }}>
                    <TargetName target={replacement.target} />：優先する所持武器「{replacement.preferredSourceNotUsed?.preferredName}」ではなく、
                    {buildListOptimizationRouteBaseLabel(replacement.after)}から作成します
                  </Typography>
                ))}
              </Box>
            )}
          </Box>
          <DisclosureAccordion title={`置き換わる候補の内訳（${replacementCount}件）`} headingLevel="h4" unmountOnExit>
            <Stack component="ul" spacing={1} aria-label="置き換わる候補" sx={{ m: 0, p: 0 }}>
              {model.replacements.map((replacement) => (
                <ReplacementCard key={replacement.key} replacement={replacement} />
              ))}
            </Stack>
          </DisclosureAccordion>
        </>
      )}
      {unchangedCount === 0 ? (
        <Typography variant="body2" color="text.secondary">変更なしの目標武器はありません。</Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            変更なしの目標武器は、現在の候補をそのまま使います。
          </Typography>
          <DisclosureAccordion title={`変更なしの目標武器（${unchangedCount}件）`} headingLevel="h4" unmountOnExit>
            <TargetNameList list={model.unchangedTargets} label="変更なしの目標武器" />
          </DisclosureAccordion>
        </>
      )}
    </PreviewSection>
  )
}

/** The Preview's Conflict section in the read-only Plan view (17.7: an `optimized` Plan records none). */
function PreviewConflicts({ plan }: { plan: ProductionPlan }) {
  return (
    <PreviewSection title="競合">
      <Typography variant="body2">
        {plan.conflicts.length === 0
          ? '競合なし：この試算に競合はありません。'
          : `この試算には競合が${plan.conflicts.length}件記録されています。`}
      </Typography>
    </PreviewSection>
  )
}

/**
 * The Preview's one pair of adoption operations (Issue #319, `docs/UI_FLOW.md` 10.4 「採用」): the shared sticky operations with the
 * Build List optimization's lead and the Preview model's own figures. Adopting still goes through the caller's check and confirmation,
 * whose running check is shown there, beside the press.
 */
function BuildListOptimizationAdoptionActions({
  ref,
  model,
  onDiscard,
  onAdopt,
  actionsDisabled,
  adoptionInspecting,
  adoptButtonRef,
}: {
  ref: Ref<HTMLDivElement>
  model: BuildListOptimizationPreviewModel | null
  onDiscard(): void
  onAdopt?: () => void
  actionsDisabled: boolean
  adoptionInspecting: boolean
  adoptButtonRef?: Ref<HTMLButtonElement>
}) {
  return (
    <PreviewAdoptionActions
      ref={ref}
      label={BUILD_LIST_OPTIMIZATION_ADOPTION_ACTIONS_LABEL}
      lead={BUILD_LIST_OPTIMIZATION_ADOPTION_ACTIONS_LEAD}
      checkItems={model === null ? null : buildListOptimizationAdoptionCheckItems(model)}
      primaryAction={onAdopt === undefined ? null : { label: 'この計画を採用', onClick: onAdopt, disabled: actionsDisabled }}
      primaryActionRef={adoptButtonRef}
      secondaryAction={{ label: '戻る', onClick: onDiscard, disabled: actionsDisabled }}
      statusMessage={adoptionInspecting ? ADOPTION_INSPECTING_MESSAGE : null}
    />
  )
}

/**
 * The unsaved Preview of an `optimized` Build List optimization (`docs/PLANNER_SPEC.md` 17.9, `docs/UI_FLOW.md` 10.4 「Preview」).
 *
 * It renders the runtime-only artifact and stores nothing: no IndexedDB, AppSettings, Export, URL or browser storage, and no
 * persistence call. Its figures are the artifact's own (`summary`, `replacements`, `unchangedTargetWeaponIds`) and the final Plan's
 * records; the replaced Entries, Target names, preferences and owned weapon names come from `startContext` - the state the
 * calculation was judged and run on, which the caller passes explicitly - never from a later read. The current Draft is compared
 * only when it was made from the same input state; otherwise no figure is compared or guessed.
 *
 * 「戻る」 calls `onDiscard` (the caller discards the result). 「この計画を採用」 exists only when the caller passes `onAdopt` - the
 * adoption confirmation and save belong to the caller - so no unconnected adoption is ever shown. Both sit in the one pair of adoption
 * operations at the end of the Preview, stuck to the bottom of the viewport while the Preview is scrolled (Issue #319);
 * `adoptionInspecting` shows there that the caller is checking the adoption. `focusHeadingOnMount` moves focus to the Preview heading
 * once, when the calculation just finished. `adoptButtonRef` lets the caller return focus to 「この計画を採用」 after its confirmation
 * closes.
 */
export function BuildListOptimizationPreviewPanel({
  artifact,
  startContext,
  currentDraft,
  master,
  debugMode,
  onDiscard,
  onAdopt,
  actionsDisabled = false,
  adoptionInspecting = false,
  focusHeadingOnMount = false,
  adoptButtonRef,
}: {
  artifact: BuildListOptimizationArtifact
  startContext: BuildListOptimizationPreviewStartContext | null
  /** The current Draft, or null when there is none. Compared only under the 17.9 same-input conditions. */
  currentDraft: ProductionPlan | null
  master: MasterDataRoot
  debugMode: boolean
  onDiscard(): void
  onAdopt?: () => void
  actionsDisabled?: boolean
  /** True while the caller checks the adoption before its confirmation. */
  adoptionInspecting?: boolean
  focusHeadingOnMount?: boolean
  adoptButtonRef?: Ref<HTMLButtonElement>
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const focusOnMount = useRef(focusHeadingOnMount)
  const model = useMemo(() => createBuildListOptimizationPreviewModel(artifact, startContext, master), [artifact, startContext, master])
  const comparison = useMemo(() => compareBuildListOptimizationWithDraft(artifact, currentDraft), [artifact, currentDraft])
  const targetWeapons = useMemo(() => [...(startContext?.targetWeapons ?? [])], [startContext])

  // Before the heading focus below, so the heading is kept clear of the operations too.
  useKeepFocusAboveAdoptionActions(bodyRef, actionsRef)

  useEffect(() => {
    if (focusOnMount.current) headingRef.current?.focus()
  }, [])

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0, borderLeftWidth: 4, borderLeftColor: 'info.main' }}
    >
      <Stack ref={bodyRef} spacing={2}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} ref={headingRef} tabIndex={-1} component="h2" variant="h2">
            {BUILD_LIST_OPTIMIZATION_PREVIEW_TITLE}
          </Typography>
          <StatusChip label="未採用" tone="caution" />
        </Stack>
        <Alert severity="info">{BUILD_LIST_OPTIMIZATION_PREVIEW_UNCHANGED_MESSAGE}</Alert>
        <Typography variant="body2" color="text.secondary">{BUILD_LIST_OPTIMIZATION_PREVIEW_DESCRIPTION}</Typography>
        {currentDraft !== null && (
          <Typography variant="body2">{BUILD_LIST_OPTIMIZATION_PREVIEW_DRAFT_REPLACED_MESSAGE}</Typography>
        )}
        {model === null ? (
          <Alert severity="error">この試算には生産計画が含まれていないため、表示できません。</Alert>
        ) : (
          <>
            <PreviewOverview model={model} />
            <DraftComparison comparison={comparison} />
            <BuildListChanges model={model} />
            <PlannedCompletionVariantsSection rows={model.plannedCompletionVariants} master={master} />
            <ProductionPlanContent
              plan={model.plan}
              targetWeapons={targetWeapons}
              master={master}
              debugMode={debugMode}
              variant="unsaved_preview"
              conflictSection={<PreviewConflicts plan={model.plan} />}
            />
          </>
        )}
        {debugMode && (
          <BuildListOptimizationDiagnosticsDetails diagnostics={artifact.diagnostics} summary={artifact.summary} headingLevel="h3" />
        )}
      </Stack>
      <BuildListOptimizationAdoptionActions
        ref={actionsRef}
        model={model}
        onDiscard={onDiscard}
        onAdopt={onAdopt}
        actionsDisabled={actionsDisabled}
        adoptionInspecting={adoptionInspecting}
        adoptButtonRef={adoptButtonRef}
      />
    </Paper>
  )
}
