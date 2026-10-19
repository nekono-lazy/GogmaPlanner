import { useId, useRef, type ChangeEvent, type CSSProperties } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
} from '@mui/material'
import { DataTransferFeedbackAlert } from './DataTransferFeedbackAlert'
import {
  dataTransferDialogActionsSx,
  dataTransferDialogActionSx,
  dataTransferDialogPaperSx,
  JSON_TEXT_FIELD_ROWS,
  jsonTextFieldSx,
} from './dataTransferDialogLayout'
import type { DataTransferFeedback } from './dataTransferPresentation'

/** The file input stays in the accessibility tree; 「ファイルから読み込む」 is its visible control. */
const visuallyHiddenInputStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

/**
 * The Import input Dialog (`docs/UI_FLOW.md` 14, `docs/REQUIREMENTS.md` 30):
 * paste the backup JSON and read it, or pick a JSON file, which is read at
 * once. It only collects text: the page hands both to the same
 * `prepareImportJson()` path, and a refusal comes back as `feedback` shown here
 * with the draft kept, so the user can fix it and read again. The draft is
 * never re-formatted.
 */
export function ImportDataDialog({
  open,
  draft,
  feedback,
  preparing,
  disabled,
  onDraftChange,
  onReadDraft,
  onFileSelected,
  onClose,
}: {
  open: boolean
  draft: string
  feedback: DataTransferFeedback | null
  /** `prepareImportJson()` (and a file read) is running. */
  preparing: boolean
  /** Another Data Transfer or a Debug Mode save blocks a new preparation. */
  disabled: boolean
  onDraftChange(draft: string): void
  onReadDraft(): void
  onFileSelected(event: ChangeEvent<HTMLInputElement>): void
  onClose(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const blocked = disabled || preparing
  const draftEmpty = draft.trim() === ''

  return (
    <Dialog
      open={open}
      onClose={(_, reason) => {
        // A backdrop tap must not throw away a pasted draft; Escape and
        // 「閉じる」 are the explicit ways out.
        if (reason === 'backdropClick' || preparing) return
        onClose()
      }}
      fullWidth
      maxWidth="md"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      slotProps={{ paper: { sx: dataTransferDialogPaperSx } }}
    >
      <DialogTitle id={titleId}>バックアップデータを読み込む</DialogTitle>
      <DialogContent sx={{ px: { xs: 2, sm: 3 } }}>
        <DialogContentText id={descriptionId} variant="body2" sx={{ mb: 2 }}>
          バックアップJSONを貼り付けて「貼り付けた内容を読み込む」を押すか、「ファイルから読み込む」からJSONファイルを選択してください。読み込んだ内容は検証し、現在のデータを置き換える前に確認します。
        </DialogContentText>
        <TextField
          label="バックアップJSON"
          placeholder="ここにバックアップJSONを貼り付け"
          multiline
          rows={JSON_TEXT_FIELD_ROWS}
          fullWidth
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          slotProps={{
            htmlInput: {
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
              autoComplete: 'off',
            },
          }}
          sx={jsonTextFieldSx({ xs: '16px', sm: '0.8125rem' })}
        />
        {feedback !== null && (
          <Box sx={{ mt: 2 }}>
            <DataTransferFeedbackAlert feedback={feedback} />
          </Box>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          aria-label="バックアップファイルを選択"
          disabled={blocked}
          onChange={onFileSelected}
          style={visuallyHiddenInputStyle}
        />
      </DialogContent>
      <DialogActions disableSpacing sx={dataTransferDialogActionsSx}>
        <Button onClick={onClose} disabled={preparing} sx={dataTransferDialogActionSx}>
          閉じる
        </Button>
        <Button
          variant="outlined"
          disabled={blocked}
          onClick={() => fileInputRef.current?.click()}
          sx={dataTransferDialogActionSx}
        >
          ファイルから読み込む
        </Button>
        <Button
          variant="contained"
          disabled={blocked || draftEmpty}
          onClick={() => {
            if (!blocked && !draftEmpty) onReadDraft()
          }}
          sx={dataTransferDialogActionSx}
        >
          {preparing ? '確認中…' : '貼り付けた内容を読み込む'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
