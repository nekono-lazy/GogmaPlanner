import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'

/**
 * A compact label / value list for a Candidate or checkpoint summary.
 *
 * One column on smartphone, two on `sm` and up. Every value cell may shrink
 * and wraps long tokens, so a long bonus or skill label never forces
 * horizontal scrolling at 375px.
 */
export function SearchDefinitionList({
  children,
  columns = 2,
}: {
  children: ReactNode
  columns?: 1 | 2
}) {
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: columns === 2 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
        },
        columnGap: 2,
        rowGap: 1,
      }}
    >
      {children}
    </Box>
  )
}

export function SearchDefinitionItem({
  label,
  children,
  span = false,
}: {
  label: string
  children: ReactNode
  /** Take the full row on every breakpoint (for the five-slot list). */
  span?: boolean
}) {
  return (
    <Box sx={{ minWidth: 0, gridColumn: span ? '1 / -1' : undefined }}>
      <Typography component="dt" variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
        {label}
      </Typography>
      <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Box>
    </Box>
  )
}
