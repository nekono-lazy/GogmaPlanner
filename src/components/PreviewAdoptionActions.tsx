import { useId, type ReactNode, type Ref } from 'react'
import { Box, Button, LinearProgress, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'

/** One operation of the adoption operations, as the Preview's caller offers it. */
export interface PreviewAdoptionAction {
  label: string
  onClick(): void
  disabled: boolean
}

/**
 * The one pair of adoption operations of an unsaved Preview (Issue #319 for the Build List optimization, Issue #324 for the running
 * Plan replan; `docs/UI_FLOW.md` 10.4 / 16.4 / 16.5). It sits at the end of the Preview and sticks to the bottom of the viewport while
 * the Preview is scrolled, so the adoption stays reachable after reading a long Plan. The Preview is its containing block, so it never
 * sticks outside it and leaves with it; on a short viewport (a phone held sideways) it stays at the end of the Preview instead.
 *
 * Presentation only: what it says and offers comes from its caller. `lead` names the trial and that it is checked before adopting,
 * `checkItems` repeat the Preview's own figures (never recounted here) and `attention` points at what the body asks to check; the body
 * keeps every detail. The primary operation is described by all three. `statusMessage` is the caller's running check, shown beside the
 * press in a status region that is always present (so the change is announced); `alert` is the caller's own failure shown there too.
 * Adopting still goes through the caller's check and confirmation: pressing never adopts by itself, and no scroll position or reading
 * time enables it.
 *
 * It is the last child of a Preview `Paper` with the padding `{ xs: 2, md: 2.5 }`, a 4 px left border and the theme's 6 px radius,
 * whose edges it lines up with.
 */
export function PreviewAdoptionActions({
  ref,
  label,
  lead,
  checkItems,
  attention = null,
  primaryAction,
  primaryActionRef,
  secondaryAction,
  statusMessage,
  alert = null,
}: {
  ref: Ref<HTMLDivElement>
  /** The accessible name of the operations. */
  label: string
  lead: string
  /** The Preview's figures to check, joined into one line; null when the trial has none to show. */
  checkItems: readonly string[] | null
  /** One line pointing at the details of the body to check; null for none. */
  attention?: string | null
  /** The adoption, or null when the caller offers none for this trial. */
  primaryAction: PreviewAdoptionAction | null
  /** Lets the caller return focus to the primary operation (after its confirmation closes). */
  primaryActionRef?: Ref<HTMLButtonElement>
  secondaryAction: PreviewAdoptionAction
  /** The caller's running check (an indeterminate progress below it), or null. */
  statusMessage: string | null
  alert?: ReactNode
}) {
  const leadId = useId()
  const checkItemsId = useId()
  const attentionId = useId()
  // On a narrow viewport a long label wraps to two lines (at a phrase, see below); the tighter line height keeps such a button compact.
  const buttonSx = { minHeight: 44, flex: { xs: 1, sm: 'none' }, minWidth: { sm: 120 }, lineHeight: 1.4 } as const
  const describedBy = [leadId, checkItems === null ? null : checkItemsId, attention === null ? null : attentionId]
    .filter((id) => id !== null)
    .join(' ')
  return (
    <Box
      ref={ref}
      role="group"
      aria-label={label}
      sx={{
        position: 'sticky',
        bottom: 0,
        // Above the Preview body it covers while stuck; below the AppBar, the Drawer and every Dialog.
        zIndex: 2,
        // Edge to edge inside the Preview's padding and flush with its bottom edge, so nothing of the body shows beside or below it.
        mx: { xs: -2, md: -2.5 },
        mb: { xs: -2, md: -2.5 },
        mt: 2,
        px: { xs: 2, md: 2.5 },
        py: 1.25,
        // The page tone, not the Preview's surface: a band that reads apart from the body it covers in Light and Dark alike.
        bgcolor: 'background.default',
        borderTop: 1,
        borderColor: 'divider',
        // The Preview's inner bottom corners (its 4 px left border and 1 px right border inside a 6 px radius).
        borderBottomLeftRadius: '2px',
        borderBottomRightRadius: '5px',
        boxShadow: (theme) => (theme.palette.mode === 'light' ? `0 -4px 12px ${alpha(theme.palette.text.primary, 0.08)}` : 'none'),
        '@media (max-height: 480px)': { position: 'static', boxShadow: 'none' },
        // Japanese wraps at a phrase (「この再計画を／採用」, never 「この再計画を採／用」) where the browser supports it; elsewhere as before.
        wordBreak: 'auto-phrase',
      }}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1, sm: 2 }} sx={{ alignItems: { sm: 'center' } }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography id={leadId} component="p" variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
            {lead}
          </Typography>
          {checkItems !== null && (
            <Typography id={checkItemsId} component="p" variant="body2" className="tabular-nums" sx={{ overflowWrap: 'anywhere' }}>
              {checkItems.join('・')}
            </Typography>
          )}
          {attention !== null && (
            <Typography id={attentionId} component="p" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {attention}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          {primaryAction !== null && (
            <Button
              ref={primaryActionRef}
              variant="contained"
              disabled={primaryAction.disabled}
              onClick={primaryAction.onClick}
              aria-describedby={describedBy}
              sx={buttonSx}
            >
              {primaryAction.label}
            </Button>
          )}
          <Button variant="outlined" disabled={secondaryAction.disabled} onClick={secondaryAction.onClick} sx={buttonSx}>
            {secondaryAction.label}
          </Button>
        </Stack>
      </Stack>
      <Box role="status" aria-live="polite">
        {statusMessage !== null && (
          <Box sx={{ pt: 1 }}>
            <Typography variant="body2">{statusMessage}</Typography>
            <LinearProgress aria-label={statusMessage} sx={{ mt: 0.5 }} />
          </Box>
        )}
      </Box>
      {alert !== null && alert !== undefined && alert !== false && <Box sx={{ pt: 1 }}>{alert}</Box>}
    </Box>
  )
}
