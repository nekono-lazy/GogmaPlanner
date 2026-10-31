import { useEffect, useId, useMemo, useRef, type Ref } from 'react'
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
import type { RunningPlanReplanPreview, RunningPlanReplanStart } from '../../services/execution/runningPlanReplanService'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { PreviewAdoptionActions } from '../PreviewAdoptionActions'
import { StatusChip } from '../StatusChip'
import { useKeepFocusAboveAdoptionActions } from '../useKeepFocusAboveAdoptionActions'
import { BuildListOptimizationDiagnosticsDetails } from '../planner/BuildListOptimizationDiagnostics'
import {
  PlannedCompletionVariantsSection,
  PreviewSection,
  ReplacementCard,
  TargetName,
  TargetNameList,
} from '../planner/BuildListOptimizationPreviewPanel'
import {
  buildListOptimizationRouteBaseLabel,
  type BuildListOptimizationTargetList,
} from '../planner/buildListOptimizationPresentation'
import { ProductionPlanContent } from '../planner/ProductionPlanContent'
import { SummaryFigure } from '../planner/ProductionPlanSummary'
import {
  createRunningPlanReplanPreviewModel,
  replanInProgressHandlingLabels,
  replanLinkReleasedRelationLabels,
  replanTargetLabel,
  replanTargetListCount,
  RUNNING_PLAN_REPLAN_ADOPT_LABEL,
  RUNNING_PLAN_REPLAN_ADOPTION_ACTIONS_LABEL,
  RUNNING_PLAN_REPLAN_ADOPTION_ACTIONS_LEAD,
  RUNNING_PLAN_REPLAN_ADOPTION_INSPECTING_MESSAGE,
  RUNNING_PLAN_REPLAN_DRAFT_AFFECTED_MESSAGE,
  RUNNING_PLAN_REPLAN_LINK_CHANGE_EFFECT_NOTE,
  RUNNING_PLAN_REPLAN_PREVIEW_DESCRIPTION,
  RUNNING_PLAN_REPLAN_PREVIEW_TITLE,
  RUNNING_PLAN_REPLAN_PREVIEW_UNCHANGED_MESSAGE,
  runningPlanReplanAdoptionAttention,
  runningPlanReplanAdoptionCheckItems,
  type ReplanComparison,
  type ReplanLinkChangeView,
  type RunningPlanReplanPreviewModel,
} from './runningPlanReplanPresentation'

/** One category of the target breakdown: its count, and its Targets in a disclosure (unmounted while closed). */
function BreakdownGroup({ title, list, label }: { title: string; list: BuildListOptimizationTargetList; label: string }) {
  const count = replanTargetListCount(list)
  if (count === 0) return null
  return (
    <DisclosureAccordion title={`${title}（${count}本）`} headingLevel="h4" unmountOnExit>
      <TargetNameList list={list} label={label} />
    </DisclosureAccordion>
  )
}

/** 18.7 「目標武器の内訳」 and the completion figure: the classification's categories, the new Plan's completions. */
function PreviewOverview({ model }: { model: RunningPlanReplanPreviewModel }) {
  const completion = model.plannedCompletionTargetCount
  return (
    <PreviewSection title="試算の概要" chip={<StatusChip label={model.conflictCount === 0 ? '競合なし' : `競合あり（${model.conflictCount}件）`} tone={model.conflictCount === 0 ? 'neutral' : 'caution'} />}>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
        <SummaryFigure
          label="完成予定の目標武器"
          value={completion === null ? '不明' : `${completion} / ${model.replanTargetCount}`}
          numeric={completion !== null}
          accessibleValue={completion === null ? undefined : `今回の再計画の目標武器${model.replanTargetCount}本のうち${completion}本が完成予定`}
          detail="分母は今回の再計画の目標武器"
        />
        <SummaryFigure label="今回の再計画の目標武器" value={`${model.replanTargetCount}本`} numeric detail="続けて作る＋取り込む" />
        <SummaryFigure label="ゲーム内の操作回数" value={model.physicalOperationCount} numeric detail="物理操作の回数" />
        <SummaryFigure label="計画ステップ数" value={model.planStepCount} numeric detail={`確認ステップ${model.nonPhysicalStepCount}件を含む`} />
      </Box>
      <Typography variant="body2">
        {model.conflictCount === 0 ? '競合なし：この試算に競合はありません。' : `この試算には競合が${model.conflictCount}件記録されています。`}
      </Typography>
      <Box>
        <Typography component="p" variant="subtitle2">目標武器の内訳</Typography>
        <Box component="ul" aria-label="目標武器の内訳" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }} className="tabular-nums">
          <Typography component="li" variant="body2">続けて作る：{replanTargetListCount(model.breakdown.continuing)}本</Typography>
          <Typography component="li" variant="body2">取り込む：{replanTargetListCount(model.breakdown.added)}本</Typography>
          <Typography component="li" variant="body2">今回作らない：{replanTargetListCount(model.breakdown.excluded)}本</Typography>
          <Typography component="li" variant="body2">完成済み：{replanTargetListCount(model.breakdown.completed)}本</Typography>
          <Typography component="li" variant="body2">対象外：{model.breakdown.notEligible.length}本</Typography>
        </Box>
      </Box>
      <Stack spacing={0.5}>
        <BreakdownGroup title="続けて作る" list={model.breakdown.continuing} label="続けて作る目標武器" />
        <BreakdownGroup title="取り込む" list={model.breakdown.added} label="取り込む目標武器" />
        <BreakdownGroup title="今回作らない" list={model.breakdown.excluded} label="今回作らない目標武器" />
        <BreakdownGroup title="完成済み" list={model.breakdown.completed} label="完成済みの目標武器" />
        {model.breakdown.notEligible.length > 0 && (
          <DisclosureAccordion title={`対象外（${model.breakdown.notEligible.length}本）`} headingLevel="h4" unmountOnExit>
            <Box component="ul" aria-label="対象外の目標武器" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
              {model.breakdown.notEligible.map((item) => (
                <Typography component="li" variant="body2" key={item.key} sx={{ overflowWrap: 'anywhere' }}>
                  {item.target === null ? replanTargetLabel(null) : <TargetName target={item.target} />}：{item.reasonLabel}
                </Typography>
              ))}
            </Box>
          </DisclosureAccordion>
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        ゲーム内の操作回数は、所持している理想品の確認など、ゲーム内の操作を伴わない確認ステップを含みません。
      </Typography>
    </PreviewSection>
  )
}

/** 18.7 「旧Planとの比較」: the old Plan's remaining Steps beside the new Plan, only when the old Plan was `active`. */
function PlanComparison({ comparison }: { comparison: ReplanComparison }) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  if (comparison.kind === 'stale') {
    return (
      <PreviewSection title="現在の生産計画との比較">
        <Typography variant="body2">
          現在の生産計画は再計算が必要な状態のため、そのまま続行できません。数値の比較は表示しません。
        </Typography>
        {comparison.reasonLabels.length > 0 && (
          <Box component="ul" aria-label="現在の生産計画を続行できない理由" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
            {comparison.reasonLabels.map((label) => (
              <Typography component="li" variant="body2" key={label}>{label}</Typography>
            ))}
          </Box>
        )}
      </PreviewSection>
    )
  }
  const label = '現在の生産計画（残り）と再計画の試算の比較'
  return (
    <PreviewSection title="現在の生産計画との比較">
      {comparison.targetSetDiffers && (
        <Typography variant="body2">作る目標武器が現在の生産計画と異なるため、数値は単純には比べられません。</Typography>
      )}
      {isDesktop ? (
        <Table size="small" aria-label={label} sx={{ '& th, & td': { overflowWrap: 'anywhere' } }}>
          <TableHead>
            <TableRow>
              <TableCell>項目</TableCell>
              <TableCell>現在の生産計画（残り）</TableCell>
              <TableCell>再計画の試算</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {comparison.rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell component="th" scope="row">{row.label}</TableCell>
                <TableCell className="tabular-nums">{row.current}</TableCell>
                <TableCell className="tabular-nums">{row.next}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Stack component="ul" aria-label={label} spacing={1} sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {comparison.rows.map((row) => (
            <Box component="li" key={row.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 0 }}>
              <Typography component="p" variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>{row.label}</Typography>
              <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 1, rowGap: 0.25 }}>
                <Typography component="dt" variant="body2" color="text.secondary">現在の生産計画（残り）</Typography>
                <Typography component="dd" variant="body2" className="tabular-nums" sx={{ m: 0 }}>{row.current}</Typography>
                <Typography component="dt" variant="body2" color="text.secondary">再計画の試算</Typography>
                <Typography component="dd" variant="body2" className="tabular-nums" sx={{ m: 0 }}>{row.next}</Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </PreviewSection>
  )
}

/** 18.7 「作成リストの変化」: the replaced, added and unchanged Targets. */
function BuildListChanges({ model }: { model: RunningPlanReplanPreviewModel }) {
  const unchangedCount = replanTargetListCount(model.unchanged)
  return (
    <PreviewSection title="作成リストの変更内容">
      <Typography variant="body2" className="tabular-nums">
        {`採用すると、作成リストの候補を${model.replacements.length}件置き換え、${model.additions.length}件追加します。`}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        今回作らない目標武器や、今回の再計画の対象外の目標武器の候補は変更しません。
      </Typography>
      {model.replacements.length > 0 && (
        <DisclosureAccordion title={`置き換わる候補（${model.replacements.length}件）`} headingLevel="h4" unmountOnExit>
          <Stack component="ul" spacing={1} aria-label="置き換わる候補" sx={{ m: 0, p: 0 }}>
            {model.replacements.map((replacement) => <ReplacementCard key={replacement.key} replacement={replacement} />)}
          </Stack>
        </DisclosureAccordion>
      )}
      {model.additions.length > 0 && (
        <DisclosureAccordion title={`追加される候補（${model.additions.length}件）`} headingLevel="h4" unmountOnExit>
          <Box component="ul" aria-label="追加される候補" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
            {model.additions.map((addition) => (
              <Typography component="li" variant="body2" key={addition.key} sx={{ overflowWrap: 'anywhere' }}>
                <TargetName target={addition.target} />：{buildListOptimizationRouteBaseLabel(addition.after)}から作成
              </Typography>
            ))}
          </Box>
        </DisclosureAccordion>
      )}
      {unchangedCount === 0 ? (
        <Typography variant="body2" color="text.secondary">変更なしの目標武器はありません。</Typography>
      ) : (
        <DisclosureAccordion title={`変更なしの目標武器（${unchangedCount}件）`} headingLevel="h4" unmountOnExit>
          <Typography variant="body2" color="text.secondary">現在の候補をそのまま使います。</Typography>
          <TargetNameList list={model.unchanged} label="変更なしの目標武器" />
        </DisclosureAccordion>
      )}
    </PreviewSection>
  )
}

/** 18.4 / 18.7 「作成途中の武器」: how the new Plan uses each weapon in progress for the old Plan. */
function InProgressWeapons({ model }: { model: RunningPlanReplanPreviewModel }) {
  return (
    <PreviewSection title="作成途中の武器">
      {model.inProgressWeapons.length === 0 ? (
        <Typography variant="body2" color="text.secondary">現在の生産計画で作成途中の武器はありません。</Typography>
      ) : (
        <Stack component="ul" spacing={1} aria-label="作成途中の武器の扱い" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {model.inProgressWeapons.map((weapon) => (
            <Box component="li" key={weapon.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0 }}>
              <Stack spacing={0.5}>
                <Typography component="p" variant="subtitle1" sx={{ overflowWrap: 'anywhere' }}>
                  {weapon.name}
                  <Typography component="span" variant="body2" color="text.secondary">（{weapon.kindLabel}）</Typography>
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{replanInProgressHandlingLabels[weapon.handling]}</Typography>
                {weapon.handling !== 'unused' && replanTargetListCount(weapon.newTargets) > 0 && (
                  <TargetNameList list={weapon.newTargets} label={`${weapon.name}を使う目標武器`} />
                )}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
      <Typography variant="body2" color="text.secondary">
        作成途中の武器を新しい計画で使わない場合も、所持武器は削除されません。保護と状態ラベルも変更しません。
      </Typography>
    </PreviewSection>
  )
}

/** One preference change of the new Plan's start (16.11), named. */
export function ReplanLinkChangeItem({ change }: { change: ReplanLinkChangeView }) {
  return (
    <Box component="li" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0, listStyle: 'none' }}>
      <Stack spacing={0.5}>
        <Typography component="p" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          <TargetName target={change.target} />の優先起点を「{change.weaponName}」にします
          {change.previousWeaponName !== null && `（これまでの優先起点「${change.previousWeaponName}」から変更）`}
        </Typography>
        {change.released !== null && (
          <Typography component="p" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            「{change.weaponName}」を優先起点にしていた<TargetName target={change.released.target} />（{replanLinkReleasedRelationLabels[change.released.relation]}）の紐付けを解除します
          </Typography>
        )}
      </Stack>
    </Box>
  )
}

/** 18.7 「起点と優先起点」: the preferred weapons a different Route base skips, and the start effect's link changes. */
function LinkChanges({ model }: { model: RunningPlanReplanPreviewModel }) {
  return (
    <PreviewSection title="起点と優先起点の紐付け">
      <Box>
        <Typography component="h4" variant="subtitle2">優先する所持武器と異なる起点で作成する目標武器</Typography>
        {model.preferredSourceDifferences.length === 0 ? (
          <Typography variant="body2" color="text.secondary">ありません。</Typography>
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
      <Box>
        <Typography component="h4" variant="subtitle2">採用で変わる優先起点の紐付け</Typography>
        {model.linkChanges.length === 0 ? (
          <Typography variant="body2" color="text.secondary">変わる紐付けはありません。</Typography>
        ) : (
          <Stack component="ul" spacing={1} aria-label="採用で変わる優先起点の紐付け" sx={{ m: 0, p: 0 }}>
            {model.linkChanges.map((change) => <ReplanLinkChangeItem key={change.key} change={change} />)}
          </Stack>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary">{RUNNING_PLAN_REPLAN_LINK_CHANGE_EFFECT_NOTE}</Typography>
    </PreviewSection>
  )
}

function PreviewConflicts({ plan }: { plan: ProductionPlan }) {
  return (
    <PreviewSection title="競合">
      <Typography variant="body2">
        {plan.conflicts.length === 0 ? '競合なし：この試算に競合はありません。' : `この試算には競合が${plan.conflicts.length}件記録されています。`}
      </Typography>
    </PreviewSection>
  )
}

/**
 * The unsaved Preview of an `optimized` running Plan replan (`docs/PLANNER_SPEC.md` 18.7, `docs/UI_FLOW.md` 16.5 「4. Preview」).
 * It renders the runtime-only Preview over the start it was calculated from and stores nothing. 「この再計画を採用」 exists only when the
 * caller passes `onAdopt`; the other operation closes the Preview (「現在の計画を続ける」 for an `active` old Plan, which changes nothing;
 * 「試算を閉じる」 for a `stale` one, which cannot be continued). Both sit in the one pair of adoption operations at the end of the
 * Preview, stuck to the bottom of the viewport while the Preview is scrolled (Issue #324), with the Preview model's figures to check;
 * `adoptionInspecting` shows there that the caller is checking the adoption before its confirmation.
 */
export function RunningPlanReplanPreviewView({
  preview,
  start,
  master,
  debugMode,
  onAdopt,
  onDiscard,
  actionsDisabled,
  adoptionInspecting = false,
  adoptButtonRef,
}: {
  preview: RunningPlanReplanPreview
  start: RunningPlanReplanStart
  master: MasterDataRoot
  debugMode: boolean
  onAdopt?: () => void
  onDiscard(): void
  actionsDisabled: boolean
  /** True while the caller checks the adoption before its confirmation. */
  adoptionInspecting?: boolean
  adoptButtonRef?: Ref<HTMLButtonElement>
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const model = useMemo(
    () => createRunningPlanReplanPreviewModel(start, preview.artifact, preview.startTargetLinkChanges, master),
    [start, preview, master],
  )
  const targetWeapons = useMemo(() => [...start.plannerInput.targetWeapons], [start])
  const oldPlanActive = start.runningPlanToken.status === 'active'
  // Before the heading focus below, so the heading is kept clear of the operations too.
  useKeepFocusAboveAdoptionActions(bodyRef, actionsRef)
  useEffect(() => {
    // The calculation just finished: the Preview's heading takes the focus once.
    headingRef.current?.focus()
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
            {RUNNING_PLAN_REPLAN_PREVIEW_TITLE}
          </Typography>
          <StatusChip label="未採用" tone="caution" />
        </Stack>
        <Alert severity="info">{RUNNING_PLAN_REPLAN_PREVIEW_UNCHANGED_MESSAGE}</Alert>
        <Typography variant="body2" color="text.secondary">{RUNNING_PLAN_REPLAN_PREVIEW_DESCRIPTION}</Typography>
        {oldPlanActive && (
          <Typography variant="body2">「現在の計画を続ける」を選ぶと、この試算を閉じるだけで何も変更しません。</Typography>
        )}
        {model === null ? (
          <Alert severity="error">この試算には生産計画が含まれていないため、表示できません。</Alert>
        ) : (
          <>
            {model.draftAffected && <Alert severity="warning">{RUNNING_PLAN_REPLAN_DRAFT_AFFECTED_MESSAGE}</Alert>}
            <PreviewOverview model={model} />
            <PlanComparison comparison={model.comparison} />
            <BuildListChanges model={model} />
            <PlannedCompletionVariantsSection rows={model.plannedCompletionVariants} master={master} />
            <InProgressWeapons model={model} />
            <LinkChanges model={model} />
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
          <BuildListOptimizationDiagnosticsDetails diagnostics={preview.artifact.diagnostics} headingLevel="h3" />
        )}
      </Stack>
      <PreviewAdoptionActions
        ref={actionsRef}
        label={RUNNING_PLAN_REPLAN_ADOPTION_ACTIONS_LABEL}
        lead={RUNNING_PLAN_REPLAN_ADOPTION_ACTIONS_LEAD}
        checkItems={model === null ? null : runningPlanReplanAdoptionCheckItems(model)}
        attention={model === null ? null : runningPlanReplanAdoptionAttention(model)}
        primaryAction={onAdopt === undefined || model === null
          ? null
          : { label: RUNNING_PLAN_REPLAN_ADOPT_LABEL, onClick: onAdopt, disabled: actionsDisabled }}
        primaryActionRef={adoptButtonRef}
        secondaryAction={{ label: oldPlanActive ? '現在の計画を続ける' : '試算を閉じる', onClick: onDiscard, disabled: actionsDisabled }}
        statusMessage={adoptionInspecting ? RUNNING_PLAN_REPLAN_ADOPTION_INSPECTING_MESSAGE : null}
      />
    </Paper>
  )
}
