import type { ReactNode } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type { PlanStep } from '../../domain/models/publicTypes'
import { DisclosureAccordion, type DisclosureHeadingLevel } from '../DisclosureAccordion'
import {
  createPlanStepDebugView,
  debugMissingValueLabel,
  debugTextLabel,
  expectedPlanStateHashRows,
} from './planStepDebugPresentation'

/** A label / value pair inside a Debug block; long values wrap instead of scrolling. */
function DebugRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </>
  )
}

function DebugList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      component="dl"
      // `dl` carries no implicit ARIA role, so the labelled key / value set is
      // exposed as a named group instead of an unnamed run of text.
      role="group"
      aria-label={label}
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'auto minmax(0, 1fr)' },
        columnGap: 1.5,
        rowGap: 0.25,
        minWidth: 0,
      }}
    >
      {children}
    </Box>
  )
}

function DebugBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <Typography component="p" variant="subtitle2">
        {title}
      </Typography>
      {children}
    </Stack>
  )
}

/**
 * The persisted internal information of one PlanStep, shown only in Debug Mode
 * (`docs/REQUIREMENTS.md` 33, `docs/UI_FLOW.md` 15, `docs/DATA_MODEL.md` 11.7).
 *
 * The one shared Debug presentation of a Step, used by the Production Plan
 * detail, the Execution Navigator and the Debug Details screen, so none of them
 * grows its own copy. Everything comes from the Step as it is persisted:
 * `PlanStep.debug`, `PlanStep.rngAdvance`, `PlanStep.expectedResult` and the two
 * `ExpectedPlanState`s. No value is recomputed here, no RNG prediction runs,
 * the Planner is never re-run, and a missing record is reported as 記録なし
 * instead of being reconstructed from a Candidate or the current Counter.
 *
 * It is a disclosure: a Plan reaches a few hundred Steps, so the contents stay
 * out of the DOM until the reader opens one.
 */
export function PlanStepDebugDetails({
  step,
  headingLevel,
  title = 'PlanStep Debug',
  note = null,
}: {
  step: PlanStep
  headingLevel: DisclosureHeadingLevel | 'none'
  /** Overridden where one screen shows exactly one Step's block. */
  title?: string
  /** A caveat shown above the values, e.g. that the Plan is stale. */
  note?: ReactNode
}) {
  const view = createPlanStepDebugView(step)
  const expected = step.expectedResult
  return (
    <DisclosureAccordion title={title} headingLevel={headingLevel} unmountOnExit>
      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        {note}
        {!view.hasDebugInfo && (
          <Typography variant="body2" color="text.secondary">
            PlanStepDebugInfo: {debugMissingValueLabel}
          </Typography>
        )}
        <DebugBlock title="Base Seed / Planner">
          <DebugList label={`ステップ ${step.order} のPlanStepDebugInfo`}>
            <DebugRow label="startBaseSeed">{view.startBaseSeed}</DebugRow>
            <DebugRow label="plannerReason">
              {view.plannerReason === null ? debugMissingValueLabel : view.plannerReason}
            </DebugRow>
          </DebugList>
        </DebugBlock>
        <DebugBlock title="Counter（このStepの計画上の開始→終了）">
          {/* The two persisted records side by side: the before / after pair
              comes from `PlanStep.debug` and the delta from
              `PlanStep.rngAdvance`. Neither is derived from the other. */}
          <DebugList label={`ステップ ${step.order} のCounter開始終了`}>
            {view.counters.map((row) => (
              <DebugRow key={row.stream} label={row.stream}>
                <span className="tabular-nums">
                  開始 {row.before} → 終了 {row.after}（delta {row.delta}）
                </span>
              </DebugRow>
            ))}
            <DebugRow label="affectedNormalCounterId">{view.affectedNormalCounterId}</DebugRow>
          </DebugList>
        </DebugBlock>
        <DebugBlock title="expectedResult（保存済み予測）">
          {expected === null ? (
            <Typography variant="body2" color="text.secondary">
              expectedResult: {debugMissingValueLabel}
            </Typography>
          ) : (
            <DebugList label={`ステップ ${step.order} のexpectedResult`}>
              <DebugRow label="restorationBonusScope">
                {debugTextLabel(expected.restorationBonusScope)}
              </DebugRow>
              <DebugRow label="restorationBonuses">
                {expected.restorationBonuses === null
                  ? debugMissingValueLabel
                  : expected.restorationBonuses
                      .map(({ bonusTypeId, bonusRankId }) => `${bonusTypeId} / ${bonusRankId}`)
                      .join('、')}
              </DebugRow>
              <DebugRow label="seriesSkillId">{debugTextLabel(expected.seriesSkillId)}</DebugRow>
              <DebugRow label="groupSkillId">{debugTextLabel(expected.groupSkillId)}</DebugRow>
            </DebugList>
          )}
        </DebugBlock>
        <DebugBlock title="ExpectedPlanState（保存済みhash）">
          <DebugList label={`ステップ ${step.order} のexpectedStateBefore`}>
            {expectedPlanStateHashRows(step.expectedStateBefore).map((row) => (
              <DebugRow key={row.label} label={`before ${row.label}`}>
                {row.value}
              </DebugRow>
            ))}
          </DebugList>
          <DebugList label={`ステップ ${step.order} のexpectedStateAfter`}>
            {expectedPlanStateHashRows(step.expectedStateAfter).map((row) => (
              <DebugRow key={row.label} label={`after ${row.label}`}>
                {row.value}
              </DebugRow>
            ))}
          </DebugList>
        </DebugBlock>
      </Stack>
    </DisclosureAccordion>
  )
}
