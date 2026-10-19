import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import {
  PERSISTENT_REIDENTIFICATION_LOAD_ERROR,
  presentPersistentReidentificationReminder,
  type PersistentReidentificationSurface,
} from './persistentReidentificationPresentation'
import type { PersistentReidentificationReminderState } from './usePersistentReidentificationReminder'

/**
 * The persistent re-identification reminder of Dashboard / RNG Setup /
 * Candidate Search (`docs/PLANNER_SPEC.md` 16.15, `docs/UI_FLOW.md` 4 / 5 / 8):
 * one warning naming every unresolved prediction stream and where to
 * re-identify it. Display only - it gates nothing, and it renders nothing
 * while loading or when nothing is unresolved.
 */
export function PersistentReidentificationReminderAlert({ state, master, surface }: {
  state: PersistentReidentificationReminderState
  master: MasterDataRoot | null
  surface: PersistentReidentificationSurface
}) {
  if (state.status === 'loading') return null
  if (state.status === 'error') {
    return <Alert severity="error">{PERSISTENT_REIDENTIFICATION_LOAD_ERROR}</Alert>
  }
  const view = presentPersistentReidentificationReminder(state.reminder, master, surface)
  if (view === null) return null
  return (
    <Alert severity="warning" sx={{ '& .MuiAlert-message': { minWidth: 0, flex: 1 } }}>
      <AlertTitle>{view.title}</AlertTitle>
      <Stack spacing={1.5}>
        {view.description.map((paragraph) => (
          <Typography variant="body2" key={paragraph}>{paragraph}</Typography>
        ))}
        <Stack component="ul" spacing={1} sx={{ m: 0, pl: 2.5 }}>
          {view.items.map((item) => (
            <Box component="li" key={item.key}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>{item.text}</Typography>
              {item.guidance.length > 0 && (
                <Stack component="ul" spacing={0.25} sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                  {item.guidance.map((sentence) => (
                    <Typography component="li" variant="body2" key={sentence}>{sentence}</Typography>
                  ))}
                </Stack>
              )}
            </Box>
          ))}
        </Stack>
        {view.links.length > 0 && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {view.links.map((link) => (
              <Button
                key={link.to}
                component={RouterLink}
                to={link.to}
                variant="outlined"
                color="inherit"
                sx={{ minHeight: 44 }}
              >
                {link.label}
              </Button>
            ))}
          </Stack>
        )}
      </Stack>
    </Alert>
  )
}
