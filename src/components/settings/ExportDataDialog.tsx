import { useId, useRef, useState } from 'react'
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
import {
  downloadJsonFile,
  exportCopiedFeedback,
  exportCopyFailedFeedback,
  exportFileSavedFeedback,
  exportFileSaveFailedFeedback,
  type DataTransferFeedback,
} from './dataTransferPresentation'

/** One `serializeExport()` result: what the Dialog shows, copies and saves. */
export interface ExportSnapshot {
  json: string
  filename: string
}

/**
 * The Export Dialog (`docs/UI_FLOW.md` 14, `docs/REQUIREMENTS.md` 30). It shows
 * the Service's JSON exactly as returned, read-only and never re-formatted, and
 * copies or saves that very string: neither action serializes again, so the
 * shown, copied and saved JSON are one snapshot. Its outcome is reported inside
 * the Dialog. Nothing here reads or writes saved data.
 *
 * The parent remounts it (by `key`) for every new snapshot, which clears the
 * previous feedback.
 */
export function ExportDataDialog({
  open,
  snapshot,
  writeClipboardText,
  onClose,
}: {
  open: boolean
  snapshot: ExportSnapshot | null
  writeClipboardText(text: string): Promise<void>
  onClose(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const [feedback, setFeedback] = useState<DataTransferFeedback | null>(null)
  const [copying, setCopying] = useState(false)
  const copyingRef = useRef(false)

  const handleCopy = () => {
    if (snapshot === null || copyingRef.current) return
    copyingRef.current = true
    setCopying(true)
    setFeedback(null)
    // Called before any await, so the browser still sees the user's click.
    let written: Promise<void>
    try {
      written = writeClipboardText(snapshot.json)
    } catch (error: unknown) {
      written = Promise.reject(error)
    }
    void written
      .then(
        () => setFeedback(exportCopiedFeedback()),
        () => setFeedback(exportCopyFailedFeedback()),
      )
      .finally(() => {
        copyingRef.current = false
        setCopying(false)
      })
  }

  const handleFileSave = () => {
    if (snapshot === null) return
    try {
      downloadJsonFile(snapshot.json, snapshot.filename)
      setFeedback(exportFileSavedFeedback())
    } catch {
      setFeedback(exportFileSaveFailedFeedback())
    }
  }

  return (
    <Dialog
      open={open && snapshot !== null}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      slotProps={{ paper: { sx: dataTransferDialogPaperSx } }}
    >
      <DialogTitle id={titleId}>バックアップデータ</DialogTitle>
      <DialogContent sx={{ px: { xs: 2, sm: 3 } }}>
        <DialogContentText id={descriptionId} variant="body2" sx={{ mb: 2 }}>
          このJSONにはアプリのユーザーデータが含まれています。クリップボードへコピーするか、JSONファイルとして保存できます。
        </DialogContentText>
        {snapshot !== null && (
          <TextField
            label="バックアップJSON"
            multiline
            rows={JSON_TEXT_FIELD_ROWS}
            fullWidth
            value={snapshot.json}
            slotProps={{ htmlInput: { readOnly: true, spellCheck: false } }}
            sx={jsonTextFieldSx('0.8125rem')}
          />
        )}
        {feedback !== null && (
          <Box sx={{ mt: 2 }}>
            <DataTransferFeedbackAlert feedback={feedback} />
          </Box>
        )}
      </DialogContent>
      <DialogActions disableSpacing sx={dataTransferDialogActionsSx}>
        <Button onClick={onClose} sx={dataTransferDialogActionSx}>
          閉じる
        </Button>
        <Button variant="outlined" onClick={handleFileSave} sx={dataTransferDialogActionSx}>
          ファイル出力
        </Button>
        <Button variant="contained" disabled={copying} onClick={handleCopy} sx={dataTransferDialogActionSx}>
          {copying ? 'コピー中…' : 'コピー'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
