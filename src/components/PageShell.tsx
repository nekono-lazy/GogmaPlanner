import type { ReactNode } from 'react'
import { Paper, Stack, Typography } from '@mui/material'

interface PageShellProps {
  title: string
  description: string
  /**
   * Page-level actions (usually one or two Buttons).
   *
   * They sit beside the title/description on PC and wrap onto their own row
   * on smartphone; they never become a fixed or sticky bottom bar. A screen
   * that genuinely needs a fixed action bar (for example a future Execution
   * Navigator) is expected to build that as its own explicit layout rather
   * than getting it implicitly from PageShell.
   */
  actions?: ReactNode
  children?: ReactNode
}

export function PageShell({ title, description, actions, children }: PageShellProps) {
  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      <Stack
        component="header"
        direction={{ xs: 'column', md: 'row' }}
        spacing={{ xs: 1.5, md: 2 }}
        sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', md: 'flex-start' } }}
      >
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography component="h1" variant="h1">
            {title}
          </Typography>
          <Typography color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {description}
          </Typography>
        </Stack>
        {actions && (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}
          >
            {actions}
          </Stack>
        )}
      </Stack>
      {children ?? (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography color="text.secondary">
            この画面の機能は、今後の実装タスクで追加します。
          </Typography>
        </Paper>
      )}
    </Stack>
  )
}
