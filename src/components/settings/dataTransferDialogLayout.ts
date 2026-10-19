/*
 * Layout shared by the Export / Import Dialogs (`docs/UI_FLOW.md` 14 / 3.1).
 * The JSON is never truncated: it scrolls inside a fixed-height field that
 * wraps long tokens, so neither the Dialog nor the page scrolls sideways on a
 * 375px screen.
 */

/** A little more width for the JSON on a phone than the MUI default 32px margins give. */
export const dataTransferDialogPaperSx = {
  m: { xs: 1.5, sm: 4 },
  width: { xs: 'calc(100% - 24px)', sm: 'calc(100% - 64px)' },
  maxHeight: { xs: 'calc(100% - 24px)', sm: 'calc(100% - 64px)' },
} as const

/**
 * The fixed row count of the JSON field. MUI 9 sizes even a fixed-`rows`
 * multiline field through an inline height, so the rows, not a CSS height,
 * decide how tall it is; the JSON scrolls inside it.
 */
export const JSON_TEXT_FIELD_ROWS = 14

/**
 * A monospace multiline field with internal scroll. `fontSize` differs per
 * Dialog: the editable Import field keeps 16px on a phone so iOS does not zoom
 * on focus.
 */
export function jsonTextFieldSx(fontSize: string | { xs: string; sm: string }) {
  return {
    // MUI 9 gives the multiline textarea no `inputMultiline` class; match the element.
    '& textarea.MuiInputBase-input': {
      overflowY: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
  } as const
}

/** 44px touch targets; full-width and stacked on a phone, side by side from `sm`. */
export const dataTransferDialogActionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * `disableSpacing` drops the MUI sibling margin, which would push a full-width
 * stacked button 8px past the Dialog edge; the gap spaces them instead.
 */
export const dataTransferDialogActionsSx = {
  flexWrap: 'wrap',
  gap: 1,
  px: { xs: 2, sm: 3 },
  pb: 2,
} as const
