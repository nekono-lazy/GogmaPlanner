import { useId, useMemo, type ReactNode } from 'react'
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
} from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  CalculationContext,
  ProductionPlan,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { materialLabel } from '../search/searchPresentation'
import {
  createTargetWeaponLookup,
  groupPlanStepsByTargetWeapon,
  isLegacyProductionPlan,
  orderPlanSteps,
} from './productionPlanPresentation'
import { rejectedBuildListEntryLabel } from './productionPlanCompletionPresentation'
import { ProductionPlanCostEstimate } from './ProductionPlanCostEstimate'
import { ProductionPlanSummary } from './ProductionPlanSummary'
import { ProductionPlanStepList } from './ProductionPlanStepList'

/**
 * What the read-only view shows.
 *
 * - `persisted` (the default): an exact persisted Plan, exactly as before.
 * - `unsaved_preview`: a runtime-only Plan no screen has saved (the Build List
 *   global optimization Preview, `docs/PLANNER_SPEC.md` 17.9). Presentation
 *   only: the caller shows its own overview from its own authority, so the
 *   persisted overview (status, Plan ID, creation time) is left out; the
 *   sections sit one heading level below the caller's Preview heading; the
 *   timeline does not call the order "saved"; and an unresolved reference reads
 *   as unresolved without its raw ID. The Plan, its Steps and every derivation
 *   are the same.
 */
export type ProductionPlanContentVariant = 'persisted' | 'unsaved_preview'

interface ProductionPlanContentProps {
  plan: ProductionPlan
  targetWeapons: readonly TargetWeapon[]
  master: MasterDataRoot
  /** Debug Mode only adds raw identifiers to Step details; it changes nothing else. */
  debugMode?: boolean
  /**
   * The caller's Conflict section, placed after the material sections and
   * before the Target routes (UI_FLOW 11.0). Presentation only: the caller
   * keeps rendering and owning it - its Worker preparation, what-if and repair
   * state never move into this read-only view.
   */
  conflictSection?: ReactNode
  variant?: ProductionPlanContentVariant
  /**
   * The persisted overview's provisional wording only (`docs/UI_FLOW.md`
   * 11.0): a draft whose CalculationContext is compatible, where a Conflict
   * participant can still be preferred. Absent everywhere else.
   */
  conflictPreferenceAvailable?: boolean
}

/** A titled, border-based section of the read-only Plan view. */
function PlanSection({
  title,
  headingLevel = 'h2',
  children,
}: {
  title: string
  headingLevel?: 'h2' | 'h3'
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Typography id={headingId} component={headingLevel} variant={headingLevel}>
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  )
}

/**
 * The read-only confirmation view of an already persisted ProductionPlan.
 *
 * The exact persisted Plan is the only authority (UI_FLOW 11): no Active or
 * latest Plan fallback, no Worker result, no PlanStep rebuilt from a
 * BuildCandidate, and no RNG prediction. It renders independently of the
 * what-if / replan preparation lifecycle, so a stale Plan or a failed Worker
 * preparation still shows the stored contents.
 *
 * The order is the one UI_FLOW 11.0 fixes (Issue #121): overview, global
 * timeline, the whole-Plan cost estimate derived from the persisted physical
 * Steps, the persisted item material totals (only when any were recorded), the
 * caller's Conflict section, the Target routes, and the rejected Entries as a
 * supplementary section last.
 *
 * A Plan reaches a few hundred steps, so both step sections are disclosures
 * whose contents are unmounted while collapsed, and the grouping is computed
 * once per Plan rather than per render.
 */
export function ProductionPlanContent({
  plan,
  targetWeapons,
  master,
  debugMode = false,
  conflictSection,
  variant = 'persisted',
  conflictPreferenceAvailable = false,
}: ProductionPlanContentProps) {
  const orderedSteps = useMemo(() => orderPlanSteps(plan), [plan])
  const targetGroups = useMemo(() => groupPlanStepsByTargetWeapon(plan), [plan])
  const isLegacy = useMemo(() => isLegacyProductionPlan(plan), [plan])
  const lookup = useMemo(
    () => createTargetWeaponLookup(targetWeapons),
    [targetWeapons],
  )
  const preview = variant === 'unsaved_preview'
  const sectionHeadingLevel = preview ? 'h3' : 'h2'
  const disclosureHeadingLevel = preview ? 'h4' : 'h3'
  const stepHeadingLevel = preview ? 'h5' : 'h4'

  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      {!preview && (
        <ProductionPlanSummary plan={plan} conflictPreferenceAvailable={conflictPreferenceAvailable} />
      )}

      <PlanSection title="計画全体の実行順" headingLevel={sectionHeadingLevel}>
        <Typography variant="body2" color="text.secondary">
          {preview
            ? '計画の順番のとおりに表示します。他の目標武器と共有する操作も、ここでは1回だけ現れます。'
            : '保存された順番のとおりに表示します。他の目標武器と共有する操作も、ここでは1回だけ現れます。'}
        </Typography>
        <DisclosureAccordion
          title={`全${orderedSteps.length}ステップを表示`}
          headingLevel={disclosureHeadingLevel}
          unmountOnExit
        >
          {/* One physical Step appears exactly once here, even when it
              advanced several Target Routes. */}
          <ProductionPlanStepList
            steps={orderedSteps}
            lookup={lookup}
            master={master}
            label="計画全体の実行順"
            debugMode={debugMode}
            hideUnresolvedTargetIds={preview}
            headingLevel={stepHeadingLevel}
          />
        </DisclosureAccordion>
      </PlanSection>

      <PlanSection title="必要素材・費用の目安" headingLevel={sectionHeadingLevel}>
        <ProductionPlanCostEstimate plan={plan} targetWeapons={targetWeapons} />
      </PlanSection>

      {/* The Master-priced persisted totals, shown as stored only when the Plan
          recorded any: nothing is re-summed, and the estimate above is the
          user-facing figure (`docs/UI_FLOW.md` 11.0). */}
      {plan.requiredMaterials.length > 0 && (
        <PlanSection title="必要素材（アイテム）合計" headingLevel={sectionHeadingLevel}>
          <Box
            component="ul"
            aria-label="必要素材（アイテム）合計"
            sx={{ m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 1 }}
          >
            {plan.requiredMaterials.map((item) => (
              <Box
                component="li"
                key={item.materialId}
                sx={{
                  listStyle: 'none',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 0.75,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  px: 1.25,
                  py: 0.75,
                  minWidth: 0,
                  maxWidth: '100%',
                }}
              >
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {materialLabel(item.materialId, master)}
                </Typography>
                <Typography variant="body2" className="tabular-nums" sx={{ fontWeight: 600 }}>
                  × {item.quantity}
                </Typography>
              </Box>
            ))}
          </Box>
        </PlanSection>
      )}

      {conflictSection}

      <PlanSection title="目標武器ごとの作成ルート" headingLevel={sectionHeadingLevel}>
        {isLegacy && (
          <Alert severity="info">
            この計画は共有Target進行情報の保存機能追加前に作成されたため、
            目標武器ごとのルートでは一部の共有操作が表示されない可能性があります。
            計画全体の実行順を確認してください。
          </Alert>
        )}
        {targetGroups.length === 0 ? (
          <Typography variant="body2">
            目標武器に紐づく手順はありません。
          </Typography>
        ) : (
          <Stack spacing={1}>
            {targetGroups.map((group) => {
              const target = lookup.byId(group.targetWeaponId)
              const name = target
                ? target.name
                : preview
                  ? '参照できない目標武器'
                  : `削除済みまたは参照できない目標武器（${group.targetWeaponId}）`
              return (
                <DisclosureAccordion
                  key={group.targetWeaponId}
                  title={`${name}（${group.steps.length}ステップ）`}
                  headingLevel={disclosureHeadingLevel}
                  unmountOnExit
                >
                  <ProductionPlanStepList
                    steps={group.steps}
                    lookup={lookup}
                    master={master}
                    showSharedBadge
                    label={`${name}の作成ルート`}
                    debugMode={debugMode}
                    hideUnresolvedTargetIds={preview}
                    headingLevel={stepHeadingLevel}
                  />
                </DisclosureAccordion>
              )
            })}
          </Stack>
        )}
      </PlanSection>

      {plan.rejectedBuildListEntries.length === 0 ? (
        <PlanSection title="採用されなかった候補" headingLevel={sectionHeadingLevel}>
          <Typography variant="body2" color="text.secondary">
            採用されなかった候補はありません。
          </Typography>
        </PlanSection>
      ) : (
        <DisclosureAccordion
          title={`採用されなかった候補（${plan.rejectedBuildListEntries.length}件）`}
          headingLevel={sectionHeadingLevel}
          unmountOnExit
        >
          <Stack
            component="ul"
            spacing={1}
            aria-label="採用されなかった候補"
            sx={{ m: 0, p: 0, listStyle: 'none' }}
          >
            {plan.rejectedBuildListEntries.map((rejected, index) => (
              <Box
                component="li"
                key={`${rejected.buildListEntryId}:${index}`}
                sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 0 }}
              >
                <Stack spacing={0.5}>
                  {/* The typed reason's label only - by its recorded cause for a
                      `resource_conflict` record, so a stuck drop is never called
                      a conflict; an unknown reason or cause (an old or broken
                      record) is not explained by a guess. */}
                  <Typography component="p" variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                    {rejectedBuildListEntryLabel(rejected)}
                  </Typography>
                  {/* The internal detail (it names BuildListEntry and other
                      implementation terms) and the internal ID are Debug Mode
                      only, in the persisted view too (`docs/UI_FLOW.md` 11.6.4). */}
                  {debugMode && (
                    <>
                      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                        detail: {rejected.detail}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                        BuildListEntry ID: {rejected.buildListEntryId}
                      </Typography>
                    </>
                  )}
                </Stack>
              </Box>
            ))}
          </Stack>
        </DisclosureAccordion>
      )}
    </Stack>
  )
}

const calculationContextRows: readonly { key: keyof CalculationContext; label: string }[] = [
  { key: 'gameVersion', label: 'gameVersion' },
  { key: 'masterDataVersion', label: 'masterDataVersion' },
  { key: 'rngEngineVersion', label: 'rngEngineVersion' },
  { key: 'appSchemaVersion', label: 'appSchemaVersion' },
]

/**
 * Debug Mode only: the CalculationContext the Plan was generated with, the one
 * its input snapshot recorded, and the current runtime one side by side.
 *
 * All three are version identifiers, never Seed or Counter values, and the
 * persisted ones are shown exactly as stored.
 */
export function ProductionPlanCalculationContextDetails({
  plan,
  current,
}: {
  plan: ProductionPlan
  current: CalculationContext
}) {
  const columns: readonly { label: string; context: CalculationContext }[] = [
    { label: '計画', context: plan.calculationContext },
    { label: '入力Snapshot', context: plan.baseSnapshot.calculationContext },
    { label: '現在', context: current },
  ]
  return (
    <DisclosureAccordion title="生成時CalculationContext（Debug）" headingLevel="h2" unmountOnExit>
      <Stack spacing={1.5}>
        {/* Fixed column widths on a narrow screen: long version strings wrap
            inside their cell instead of pushing the table into a horizontal
            scroll; from `md` the natural column widths are used. */}
        <Box sx={{ overflowX: 'auto' }}>
          <Table
            size="small"
            aria-label="生成時CalculationContext"
            sx={{ tableLayout: { xs: 'fixed', md: 'auto' }, '& th, & td': { overflowWrap: 'anywhere' } }}
          >
            <TableHead>
              <TableRow>
                <TableCell>項目</TableCell>
                {columns.map(({ label }) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {calculationContextRows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell component="th" scope="row">{row.label}</TableCell>
                  {columns.map(({ label, context }) => (
                    <TableCell key={label} sx={{ overflowWrap: 'anywhere' }}>
                      {String(context[row.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          採用BuildListEntry ID:{' '}
          {plan.selectedBuildListEntryIds.length === 0
            ? 'なし'
            : plan.selectedBuildListEntryIds.join(', ')}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          再計算理由:{' '}
          {plan.recalculationReasons.length === 0 ? 'なし' : plan.recalculationReasons.join(', ')}
        </Typography>
      </Stack>
    </DisclosureAccordion>
  )
}
