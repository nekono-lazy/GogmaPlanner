/**
 * Heading levels a nested presentation section may take.
 *
 * `h1` is reserved for the page title (`PageShell`), so embedded sections
 * start at `h2`. `nextHeadingLevel()` lets a component that is embedded at a
 * caller-chosen level derive the level of its own sub-sections, keeping the
 * page outline sequential wherever it is placed. `h6` has no deeper level and
 * is returned unchanged.
 */
export type SectionHeadingLevel = 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/**
 * Whether a section at `level` can still give its own sub-sections a deeper
 * heading. HTML stops at `h6`, so a caller at `h6` must not create a child
 * heading of the same level: below that depth, sub-structure is expressed as
 * labelled non-heading text or a heading-less disclosure instead.
 */
export function hasDeeperHeadingLevel(level: SectionHeadingLevel): boolean {
  return level !== 'h6'
}

export function nextHeadingLevel(level: SectionHeadingLevel): SectionHeadingLevel {
  switch (level) {
    case 'h2':
      return 'h3'
    case 'h3':
      return 'h4'
    case 'h4':
      return 'h5'
    default:
      return 'h6'
  }
}
