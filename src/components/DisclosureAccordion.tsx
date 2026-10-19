import { useId, type ReactNode } from 'react'
import { Accordion, AccordionDetails, AccordionSummary, Box, SvgIcon, Typography } from '@mui/material'

export type DisclosureHeadingLevel = 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

function ExpandIcon() {
  return (
    <SvgIcon aria-hidden="true">
      <path d="M7 10l5 5 5-5z" />
    </SvgIcon>
  )
}

/**
 * A progressive-disclosure section with correct heading semantics.
 *
 * The Accordion's own heading slot is the single heading authority around the
 * toggle, at the level the caller chooses for its place in the page outline;
 * the summary text is rendered as a `span` so no nested heading is created.
 * The summary keeps a 48px minimum height as a comfortable touch target.
 *
 * ARIA wiring follows MUI's contract: the summary's `id` and `aria-controls`
 * are the authority, and the Accordion derives its content region's `id` and
 * `aria-labelledby` from them. Both ids are generated here with `useId`, so
 * every instance is unique and no id is ever placed on two elements; callers
 * never supply ids.
 *
 * `unmountOnExit` keeps heavy content (long route traces) out of the DOM while
 * the panel is closed.
 *
 * `headingLevel: 'none'` is for a disclosure nested below an `h6`: HTML has no
 * deeper heading, so the toggle keeps its full ARIA wiring but sits in a plain
 * `div` instead of repeating the parent's level as a false sibling heading.
 *
 * `expanded` / `onExpandedChange` make the open state the caller's (a list
 * that opens and closes several disclosures at once); without them the
 * disclosure keeps its own state, starting closed.
 *
 * `summary` adds orienting content below the title inside the toggle - facts a
 * reader needs while the panel is closed. The title alone stays the toggle's
 * name, the heading's name and the region's name, and the summary becomes the
 * toggle's description, so a long summary never turns into the name.
 */
export function DisclosureAccordion({
  title,
  headingLevel,
  children,
  unmountOnExit = false,
  expanded,
  onExpandedChange,
  summary,
  titleVariant = 'subtitle2',
}: {
  title: string
  headingLevel: DisclosureHeadingLevel | 'none'
  children: ReactNode
  unmountOnExit?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  summary?: ReactNode
  /** The title's type scale; the heading level stays `headingLevel`. */
  titleVariant?: 'subtitle2' | 'h3'
}) {
  const baseId = useId()
  const summaryId = `${baseId}-summary`
  const contentId = `${baseId}-content`
  const titleId = `${baseId}-title`
  const descriptionId = `${baseId}-description`
  const hasSummary = summary !== undefined && summary !== null
  return (
    <Accordion
      {...(expanded === undefined ? {} : { expanded })}
      onChange={(_event, next) => onExpandedChange?.(next)}
      slotProps={{
        heading: { component: headingLevel === 'none' ? 'div' : headingLevel },
        transition: { unmountOnExit },
        ...(hasSummary ? { region: { 'aria-labelledby': titleId } } : {}),
      }}
    >
      <AccordionSummary
        id={summaryId}
        aria-controls={contentId}
        {...(hasSummary ? { 'aria-labelledby': titleId, 'aria-describedby': descriptionId } : {})}
        expandIcon={<ExpandIcon />}
        sx={{ minHeight: 48, '& .MuiAccordionSummary-content': { minWidth: 0 } }}
      >
        {/* Phrasing content only: the summary is a native button. */}
        {hasSummary ? (
          <Box component="span" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0, flex: 1 }}>
            <Typography id={titleId} component="span" variant={titleVariant} sx={{ overflowWrap: 'anywhere' }}>
              {title}
            </Typography>
            <Box component="span" id={descriptionId} sx={{ display: 'block', minWidth: 0 }}>
              {summary}
            </Box>
          </Box>
        ) : (
          <Typography component="span" variant={titleVariant} sx={{ overflowWrap: 'anywhere' }}>
            {title}
          </Typography>
        )}
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  )
}
