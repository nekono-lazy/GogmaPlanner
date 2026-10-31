import type { ReactNode } from 'react'
import { useId } from 'react'
import { Box, Stack, Typography } from '@mui/material'

const frameSx = {
  minWidth: 0,
  px: 1.5,
  py: 1.25,
  border: 1,
  borderColor: 'divider',
  borderLeftWidth: 4,
  borderLeftColor: 'primary.main',
  borderRadius: 1,
  bgcolor: 'background.default',
} as const

/**
 * The frame around what the current Step asks the user to compare with, or
 * enter from, the game screen (Issue #318): the Skills a Skill lottery draws,
 * the five slots a Bonus lottery or a production-target Normal forge yields,
 * or the observed five slots of a blind production target. Everything the
 * Step only carries along stays outside it.
 *
 * One look for every Step - a divider border, a left accent line in the
 * primary colour and the page background as its surface, all theme tokens -
 * so the frames are told apart by their heading words, never by colour alone.
 * `heading` is shown at the top and names the group; a frame whose content
 * brings its own visible heading passes `label` instead, which names the
 * group without repeating that heading.
 */
export function ExecutionFocusFrame({
  heading,
  label,
  children,
}: {
  heading?: string
  label?: string
  children: ReactNode
}) {
  const headingId = useId()
  if (heading === undefined) {
    return (
      <Box role="group" aria-label={label} sx={frameSx}>
        {children}
      </Box>
    )
  }
  return (
    <Box role="group" aria-labelledby={headingId} sx={frameSx}>
      <Stack spacing={1}>
        <Typography id={headingId} component="p" variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
          {heading}
        </Typography>
        {children}
      </Stack>
    </Box>
  )
}
