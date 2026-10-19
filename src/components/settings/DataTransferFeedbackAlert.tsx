import { Alert, Box, Typography } from '@mui/material'
import type { DataTransferFeedback } from './dataTransferPresentation'

/**
 * The one outcome of the last data management operation, on the Settings page
 * or inside the Export / Import Dialog that performed it. Success and failure
 * never show at once. A long validation issue list scrolls inside a bounded
 * region so the actions below stay reachable (`docs/UI_FLOW.md` 3.1); nothing
 * is truncated.
 */
export function DataTransferFeedbackAlert({ feedback }: { feedback: DataTransferFeedback }) {
  return (
    <Alert severity={feedback.severity} sx={{ '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
      {feedback.message}
      {feedback.issues.length > 0 && (
        <Box
          component="ul"
          aria-label="検出された問題"
          tabIndex={0}
          sx={{ m: 0, mt: 1, pl: 2.5, maxHeight: { xs: 'min(24vh, 160px)', sm: 'min(28vh, 220px)' }, overflowY: 'auto' }}
        >
          {feedback.issues.map((issue, index) => (
            <Typography component="li" variant="body2" key={`${index}-${issue}`}>
              {issue}
            </Typography>
          ))}
        </Box>
      )}
    </Alert>
  )
}
