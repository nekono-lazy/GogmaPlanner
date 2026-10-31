import { useId, useRef, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '@mui/material'
import type { ExportSummary } from '../../services/dataTransfer/importExportService'
import { DataTransferFeedbackAlert } from './DataTransferFeedbackAlert'
import {
  dataTransferDialogActionsSx,
  dataTransferDialogActionSx,
  dataTransferDialogPaperSx,
} from './dataTransferDialogLayout'
import {
  downloadJsonFile,
  exportCopiedFeedback,
  exportCopyFailedFeedback,
  exportFileSavedFeedback,
  exportFileSaveFailedFeedback,
  exportSummaryRows,
  type DataTransferFeedback,
} from './dataTransferPresentation'

/** One Export: the JSON the Dialog saves and copies, and what it shows instead. */
export interface ExportSnapshot {
  json: string
  filename: string
  summary: ExportSummary
}

/**
 * The summary of the backup as a description list: one label / value row
 * each, two columns from the narrowest screen, with long values wrapping.
 */
function ExportSummaryList({ summary, labelledBy }: { summary: ExportSummary; labelledBy: string }) {
  return (
    <Box
      component="dl"
      aria-labelledby={labelledBy}
      sx={{
        m: 0,
        px: 2,
        py: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
      }}
    >
      {exportSummaryRows(summary).map(({ label, value }, index) => (
        <Box
          key={label}
          sx={{
            display: 'contents',
            '& > *': { py: 1, borderTop: index === 0 ? 0 : 1, borderColor: 'divider' },
          }}
        >
          <Typography component="dt" variant="body2" sx={{ color: 'text.secondary', pr: 3 }}>
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body2"
            sx={{ m: 0, minWidth: 0, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}
          >
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}

/**
 * The Export Dialog (`docs/UI_FLOW.md` 14, `docs/PLANNER_SPEC.md` 19.9). It
 * never renders the JSON text, not even a part of it: it shows the backup's
 * summary and saves or copies the one string the Export produced, so neither
 * action serializes again and the saved and copied JSON are one snapshot.
 * 「ファイルに保存」 is the primary action, 「コピー」 the secondary one. Their
 * outcome is reported inside the Dialog. Nothing here reads or writes saved
 * data.
 *
 * The parent remounts it (by `key`) for every new snapshot, which clears the
 * previous feedback, and drops the snapshot once it has closed (`onExited`).
 */
export function ExportDataDialog({
  open,
  snapshot,
  writeClipboardText,
  onClose,
  onExited,
}: {
  open: boolean
  snapshot: ExportSnapshot | null
  writeClipboardText(text: string): Promise<void>
  onClose(): void
  /** The close transition finished; the parent may release the snapshot. */
  onExited?(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const summaryHeadingId = useId()
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
      maxWidth="sm"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      slotProps={{ paper: { sx: dataTransferDialogPaperSx }, transition: { onExited } }}
    >
      <DialogTitle id={titleId}>バックアップデータ</DialogTitle>
      <DialogContent sx={{ px: { xs: 2, sm: 3 } }}>
        <DialogContentText id={descriptionId} variant="body2" sx={{ mb: 2 }}>
          このバックアップにはアプリの全ユーザーデータが含まれています。「ファイルに保存」でJSONファイルとして保存し、保管してください。必要な場合はクリップボードへコピーすることもできます。
        </DialogContentText>
        {snapshot !== null && (
          <Box component="section" aria-labelledby={summaryHeadingId}>
            <Typography id={summaryHeadingId} component="h3" variant="subtitle2" sx={{ mb: 1 }}>
              バックアップの概要
            </Typography>
            <ExportSummaryList summary={snapshot.summary} labelledBy={summaryHeadingId} />
          </Box>
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
        <Button variant="outlined" disabled={copying} onClick={handleCopy} sx={dataTransferDialogActionSx}>
          {copying ? 'コピー中…' : 'コピー'}
        </Button>
        <Button variant="contained" onClick={handleFileSave} sx={dataTransferDialogActionSx}>
          ファイルに保存
        </Button>
      </DialogActions>
    </Dialog>
  )
}
