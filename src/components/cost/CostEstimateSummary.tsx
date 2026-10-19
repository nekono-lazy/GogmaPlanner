import { useId, type ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import type { CostEstimateSummary as CostEstimateSummaryData } from '../../domain/cost'
import type { SectionHeadingLevel } from '../headingLevel'
import {
  artianPartLabels,
  costEstimateGroupLabels,
  costEstimateItemLabels,
  costEstimateNotes,
  costEstimateSectionTitle,
  formatOperationCount,
  formatQuantity,
  formatZenny,
} from './costEstimatePresentation'

interface CostEstimateSummaryProps {
  summary: CostEstimateSummaryData
  /**
   * Renders the section heading at this level. Omitted, the caller owns the
   * heading (the Production Plan page wraps it in its own section) and only
   * the body is rendered.
   */
  headingLevel?: SectionHeadingLevel
  /** Supplementary explanation shown under the heading. */
  note?: ReactNode
}

/** One item line: the name wraps, the quantity never breaks away from its `×`. */
function CostLine({
  name,
  quantity,
  prefix,
}: {
  name: string
  quantity: number
  prefix?: string
}) {
  return (
    <Typography component="li" variant="body2" sx={{ minWidth: 0 }}>
      {prefix !== undefined && (
        <>
          <Box component="span" sx={{ color: 'text.secondary' }}>{prefix}</Box>{' '}
        </>
      )}
      <Box component="span" sx={{ overflowWrap: 'anywhere' }}>{name}</Box>{' '}
      <Box
        component="span"
        className="tabular-nums"
        sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}
      >
        ×{formatQuantity(quantity)}
      </Box>
    </Typography>
  )
}

/** A supplementary line (count, note) of one group. */
function CostText({ children, secondary = false }: { children: ReactNode; secondary?: boolean }) {
  return (
    <Typography
      component="li"
      variant="body2"
      color={secondary ? 'text.secondary' : undefined}
      className="tabular-nums"
      sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
    >
      {children}
    </Typography>
  )
}

/** One cost group: the label as `dt`, its lines as a labelled list inside `dd`. */
function CostGroup({
  label,
  span = false,
  children,
}: {
  label: string
  span?: boolean
  children: ReactNode
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 1,
        minWidth: 0,
        gridColumn: span ? '1 / -1' : undefined,
      }}
    >
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
        {label}
      </Typography>
      <Box component="dd" sx={{ m: 0, minWidth: 0 }}>
        <Box
          component="ul"
          aria-label={label}
          sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 0.25, minWidth: 0 }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  )
}

/**
 * The display-only cost estimate of one Candidate Route or one whole
 * ProductionPlan (`docs/UI_FLOW.md` 9 / 11.0).
 *
 * Groups a Route does not contain are omitted. ナナイロカネ and 歴戦錬磨の証 are
 * shown as an alternative, never as a sum; the Skill reassignment shows the
 * different-type device count as the figure and the same-type count as a
 * note. Nothing here is a shortage judgement.
 */
export function CostEstimateSummary({ summary, headingLevel, note }: CostEstimateSummaryProps) {
  const headingId = useId()
  const body = summary.isEmpty ? (
    <Typography variant="body2">{costEstimateNotes.empty}</Typography>
  ) : (
    <Box
      component="dl"
      role="group"
      aria-label={costEstimateSectionTitle}
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
        gap: 1,
        minWidth: 0,
      }}
    >
      {summary.normalForgeCount > 0 && (
        <CostGroup label={costEstimateGroupLabels.artianParts}>
          {summary.artianParts.map((part) => (
            <CostLine key={part.partId} name={artianPartLabels[part.partId]} quantity={part.quantity} />
          ))}
          {summary.unpricedForgeCount > 0 && (
            <CostText secondary>{costEstimateNotes.unpricedForges(summary.unpricedForgeCount)}</CostText>
          )}
        </CostGroup>
      )}
      {summary.normalFullRestorationCount > 0 && (
        <CostGroup label={costEstimateGroupLabels.normalFullRestoration}>
          <CostLine
            name={costEstimateItemLabels.nanairoKane}
            quantity={summary.normalFullRestorationNanairoKane}
          />
        </CostGroup>
      )}
      {summary.conversionCount > 0 && (
        <CostGroup label={costEstimateGroupLabels.conversion}>
          <CostLine name={costEstimateItemLabels.oilyDevice} quantity={summary.conversionDeviceCount} />
          <CostText secondary>{costEstimateNotes.conversionSameType}</CostText>
        </CostGroup>
      )}
      {summary.gogmaRestorationCount > 0 && (
        <CostGroup label={costEstimateGroupLabels.gogmaRestoration}>
          <CostText>{formatOperationCount(summary.gogmaRestorationCount)}</CostText>
          <CostLine
            name={costEstimateItemLabels.nanairoKane}
            quantity={summary.gogmaRestorationNanairoKane}
          />
          <CostLine
            prefix={costEstimateNotes.alternative}
            name={costEstimateItemLabels.veteranTicket}
            quantity={summary.gogmaRestorationTicketCount}
          />
        </CostGroup>
      )}
      {summary.skillReassignmentCount > 0 && (
        <CostGroup label={costEstimateGroupLabels.skillReassignment}>
          <CostText>{formatOperationCount(summary.skillReassignmentCount)}</CostText>
          <CostLine
            name={costEstimateItemLabels.oilyDevice}
            quantity={summary.skillReassignmentDeviceCountDifferentType}
          />
          <CostText secondary>
            {costEstimateNotes.skillSameType(summary.skillReassignmentDeviceCountSameType)}
          </CostText>
        </CostGroup>
      )}
      <CostGroup label={costEstimateGroupLabels.zenny} span>
        <CostText>{formatZenny(summary.zenny)}</CostText>
      </CostGroup>
    </Box>
  )

  if (headingLevel === undefined) {
    return (
      <Box sx={{ display: 'grid', gap: 1, minWidth: 0 }}>
        {note !== undefined && (
          <Typography variant="body2" color="text.secondary">{note}</Typography>
        )}
        {body}
      </Box>
    )
  }
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ minWidth: 0 }}>
      <Typography id={headingId} component={headingLevel} variant="subtitle2" sx={{ mb: 1 }}>
        {costEstimateSectionTitle}
      </Typography>
      {note !== undefined && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{note}</Typography>
      )}
      {body}
    </Box>
  )
}
