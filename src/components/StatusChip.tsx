import { Chip } from '@mui/material'
import { alpha } from '@mui/material/styles'

/**
 * Semantic tone of a status label.
 *
 * The tone only reinforces the label: every status is readable from its text
 * alone, and `neutral` additionally uses a dashed border so an unset state is
 * distinguishable from a positive one without relying on colour.
 */
export type StatusTone = 'positive' | 'caution' | 'neutral' | 'info'

const chipColors = {
  positive: 'success',
  caution: 'warning',
  info: 'info',
} as const

interface StatusChipProps {
  label: string
  tone: StatusTone
  /**
   * The root element. `span` lets the chip sit inside phrasing content such
   * as a heading without nesting a block element there.
   */
  component?: 'div' | 'span'
}

export function StatusChip({ label, tone, component = 'div' }: StatusChipProps) {
  if (tone === 'neutral') {
    return (
      <Chip
        component={component}
        label={label}
        size="small"
        variant="outlined"
        sx={{ borderStyle: 'dashed', color: 'text.secondary' }}
      />
    )
  }
  const color = chipColors[tone]
  return (
    <Chip
      component={component}
      label={label}
      size="small"
      variant="outlined"
      color={color}
      sx={(theme) => ({ bgcolor: alpha(theme.palette[color].main, 0.08) })}
    />
  )
}
