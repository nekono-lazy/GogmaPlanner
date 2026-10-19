import { Alert } from '@mui/material'

/**
 * A form error reported by a Dialog's save action.
 *
 * It renders between the scrolling `DialogContent` and the `DialogActions`,
 * so a failure reported after saving from the bottom of a long form is in
 * view next to 保存 without scrolling back to the top. The region itself is
 * bounded: a very long message (a joined list of validation issues, a
 * persistence error with an identifier) scrolls inside the Alert instead of
 * growing the fixed title + error + actions area until 保存 / キャンセル
 * leave a short viewport (`docs/UI_FLOW.md` 3.1). Nothing is truncated: the
 * full text stays in the DOM and is reachable by scrolling the region.
 *
 * MUI's own message slot is the scroll container (it already has
 * `overflow: auto`), so the error icon stays put while the text scrolls; the
 * root keeps `overflowY: auto` as the fallback bound. The message slot is
 * keyboard focusable so a keyboard user can scroll a long error too, and the
 * MUI Alert keeps its `severity="error"` role / live semantics. No focus
 * trap or focus move is added: Tab continues to キャンセル / 保存.
 */
export function DialogFormError({ message }: { message: string }) {
  return (
    <Alert
      severity="error"
      slotProps={{ message: { tabIndex: 0 } }}
      sx={(theme) => ({
        flexShrink: 0,
        minHeight: 0,
        mx: { xs: 2, sm: 3 },
        mt: 1.5,
        // Bounded on every screen; smaller on a phone, where a software
        // keyboard or 200% zoom leaves little height for the Dialog.
        maxHeight: { xs: 'min(24vh, 160px)', sm: 'min(20vh, 180px)' },
        overflowY: 'auto',
        '& .MuiAlert-message': {
          minWidth: 0,
          overflowWrap: 'anywhere',
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.error.main}`,
            outlineOffset: -2,
          },
        },
      })}
    >
      {message}
    </Alert>
  )
}
