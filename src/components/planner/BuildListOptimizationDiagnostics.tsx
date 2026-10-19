import type { ReactNode } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type {
  BuildListOptimizationBound,
  BuildListOptimizationDiagnostics,
  BuildListOptimizationSummary,
} from '../../domain/planner/buildListOptimization'
import { DisclosureAccordion, type DisclosureHeadingLevel } from '../DisclosureAccordion'

/** One `name: value` line of raw diagnostic values. */
function DiagnosticLine({ name, value }: { name: string; value: string | number }) {
  return (
    <Typography component="li" variant="caption" className="tabular-nums" sx={{ overflowWrap: 'anywhere' }}>
      {name}: {value}
    </Typography>
  )
}

function DiagnosticList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography component="p" variant="subtitle2">{label}</Typography>
      <Box component="ul" aria-label={label} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
        {children}
      </Box>
    </Box>
  )
}

const formatRecord = (record: Record<string, number>): string =>
  Object.entries(record).map(([key, value]) => `${key} ${value}`).join(' / ')

/**
 * Debug Mode only (`docs/PLANNER_SPEC.md` 17.9): what the optimization did, exactly as the Domain recorded it - stage times,
 * search amounts and each structural candidate's outcome - plus the reached bounds and the summary's internal figures when the
 * caller has them. Read-only and decision-free: nothing here is a judgement input, and no Seed or Counter value appears (the
 * window is a search width, not a position). The caller renders it only while Debug Mode is on.
 */
export function BuildListOptimizationDiagnosticsDetails({
  diagnostics,
  bounds,
  summary,
  headingLevel,
}: {
  diagnostics: BuildListOptimizationDiagnostics
  bounds?: readonly BuildListOptimizationBound[]
  summary?: BuildListOptimizationSummary
  headingLevel: DisclosureHeadingLevel
}) {
  const { reachTable, structuralSearch, candidates, plannerVerifications, elapsedMs } = diagnostics
  return (
    <DisclosureAccordion title="全体最適化の診断情報（Debug）" headingLevel={headingLevel} unmountOnExit>
      <Stack spacing={1.5}>
        {summary !== undefined && (
          <DiagnosticList label="summary">
            <DiagnosticLine name="structuralObjective" value={summary.structuralObjective} />
            <DiagnosticLine name="maxPlanSteps" value={summary.maxPlanSteps} />
            <DiagnosticLine name="completedTargetCount" value={summary.completedTargetCount} />
            <DiagnosticLine name="totalTargetCount" value={summary.totalTargetCount} />
          </DiagnosticList>
        )}
        {bounds !== undefined && bounds.length > 0 && (
          <DiagnosticList label="reached bounds">
            {bounds.map((bound, index) => (
              <DiagnosticLine key={`${bound.kind}:${index}`} name={bound.kind} value={JSON.stringify(bound)} />
            ))}
          </DiagnosticList>
        )}
        <DiagnosticList label="reachTable">
          {reachTable === null ? (
            <DiagnosticLine name="reachTable" value="not built" />
          ) : (
            <>
              <DiagnosticLine name="window" value={formatRecord({ ...reachTable.window })} />
              <DiagnosticLine name="predictions" value={formatRecord({ ...reachTable.predictions })} />
              <DiagnosticLine name="memoHits" value={formatRecord({ ...reachTable.memoHits })} />
              <DiagnosticLine name="supportQueries" value={reachTable.supportQueries} />
            </>
          )}
        </DiagnosticList>
        <DiagnosticList label="structuralSearch">
          {structuralSearch === null ? (
            <DiagnosticLine name="structuralSearch" value="not run" />
          ) : (
            <>
              <DiagnosticLine name="completeness" value={structuralSearch.completeness} />
              <DiagnosticLine name="expandedNodes" value={structuralSearch.expandedNodes} />
              <DiagnosticLine name="coverageRejections" value={structuralSearch.coverageRejections} />
              <DiagnosticLine name="structuralCandidates" value={structuralSearch.structuralCandidates} />
              <DiagnosticLine name="noStructuralCandidateReason" value={structuralSearch.noStructuralCandidateReason ?? 'null'} />
            </>
          )}
        </DiagnosticList>
        <DiagnosticList label="candidates">
          <DiagnosticLine name="plannerVerifications" value={plannerVerifications} />
          {candidates.map((candidate) => (
            <DiagnosticLine
              key={candidate.ordinal}
              name={`candidate ${candidate.ordinal}`}
              value={[
                `objective ${candidate.objective}`,
                `routeGeneration ${candidate.routeGeneration.outcome} (${candidate.routeGeneration.generatedTargetCount} targets; ${formatRecord({ ...candidate.routeGeneration.methods })})`,
                candidate.verification === null
                  ? 'verification not run'
                  : `verification ${candidate.verification.outcome} (maxPlanSteps ${candidate.verification.maxPlanSteps}, fullPlannerRuns ${candidate.verification.fullPlannerRuns}${
                    candidate.verification.rejections.length > 0
                      ? `, rejections ${candidate.verification.rejections.map(({ code }) => code).join(', ')}`
                      : ''
                  })`,
              ].join(' / ')}
            />
          ))}
        </DiagnosticList>
        <DiagnosticList label="elapsedMs">
          <DiagnosticLine name="elapsedMs" value={elapsedMs === null ? 'not measured' : formatRecord(elapsedMs as Record<string, number>)} />
        </DiagnosticList>
      </Stack>
    </DisclosureAccordion>
  )
}
