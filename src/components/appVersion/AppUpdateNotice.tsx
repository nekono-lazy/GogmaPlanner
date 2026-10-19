import { useEffect, useSyncExternalStore } from 'react'
import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material'
import {
  defaultAppVersionChecker,
  reloadPage,
  startAppVersionMonitor,
  type AppVersionChecker,
} from '../../services/appVersion/appVersionChecker'

/** The checker and the reload action of the notice; injectable for tests. */
export interface AppUpdateNoticeDependencies {
  checker: AppVersionChecker
  reload(): void
}

const defaultDependencies: AppUpdateNoticeDependencies = {
  checker: defaultAppVersionChecker,
  reload: reloadPage,
}

/**
 * The global "a newer version is published" notice (`docs/UI_FLOW.md` 3.6).
 *
 * It runs the check lifecycle while mounted and shows a persistent, non-modal
 * info Alert once the checker reports a newer build. It never reloads by
 * itself and cannot be dismissed: only 「再読み込み」 reloads, and the current
 * screen stays usable meanwhile. A build without a production build ID renders
 * nothing and requests nothing.
 */
export function AppUpdateNotice({
  dependencies = defaultDependencies,
}: {
  dependencies?: AppUpdateNoticeDependencies
}) {
  const { checker, reload } = dependencies
  const updateAvailable = useSyncExternalStore(checker.subscribe, checker.isUpdateAvailable)

  useEffect(() => startAppVersionMonitor(checker), [checker])

  if (!updateAvailable) return null

  return (
    <Alert
      severity="info"
      // A polite status, not an assertive alert: nothing is wrong and the user
      // may finish what they are doing first.
      role="status"
      sx={{ mb: { xs: 2, md: 3 }, '& .MuiAlert-message': { flex: 1, minWidth: 0 } }}
    >
      <AlertTitle>新しいバージョンが公開されています</AlertTitle>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
      >
        <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          最新版を使用するため、ページを再読み込みしてください。入力中の内容がある場合は、保存してから再読み込みしてください。
        </Typography>
        <Button
          variant="outlined"
          color="info"
          onClick={() => reload()}
          sx={{ minHeight: 44, flexShrink: 0, width: { xs: '100%', sm: 'auto' }, whiteSpace: 'nowrap' }}
        >
          再読み込み
        </Button>
      </Stack>
    </Alert>
  )
}
