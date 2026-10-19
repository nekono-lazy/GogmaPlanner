import { useEffect, useMemo } from 'react'
import { Alert, Box, CssBaseline, Typography } from '@mui/material'
import { ThemeProvider } from '@mui/material/styles'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { createAppTheme } from './app/theme'
import { loadMasterData } from './domain/master/loadMasterData'
import { settingsRepository } from './db/settingsRepository'
import { useAppearanceStore } from './stores/appearanceStore'
import { useSettingsStore } from './stores/settingsStore'
import { DashboardPage } from './pages/DashboardPage'
import { DebugPage } from './pages/DebugPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { SettingsPage } from './pages/SettingsPage'
import { SearchPage } from './pages/SearchPage'
import { BuildListPage } from './pages/BuildListPage'
import { RngSetupPage } from './pages/RngSetupPage'
import { NormalCountersPage } from './pages/NormalCountersPage'
import { OwnedWeaponsPage } from './pages/OwnedWeaponsPage'
import { TargetWeaponsPage } from './pages/TargetWeaponsPage'
import { ExecutionNavigatorPage } from './pages/ExecutionNavigatorPage'
import { ProductionPlanPage } from './pages/ProductionPlanPage'
import { ProductionPlansPage } from './pages/ProductionPlansPage'
import { GuidePage } from './pages/GuidePage'

const masterData = loadMasterData()

function SettingsBootstrap() {
  const hydrate = useSettingsStore((state) => state.hydrate)

  useEffect(() => {
    let active = true
    void settingsRepository
      .getOrCreateDefault()
      .then((settings) => {
        if (active) hydrate(settings)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [hydrate])

  return null
}

function ApplicationRoutes() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="rng" element={<RngSetupPage />} />
          <Route path="normal-counters" element={<NormalCountersPage />} />
          <Route path="owned-weapons" element={<OwnedWeaponsPage />} />
          <Route path="target-weapons" element={<TargetWeaponsPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="build-list" element={<BuildListPage />} />
          <Route path="plans" element={<ProductionPlansPage />} />
          <Route path="plans/:planId" element={<ProductionPlanPage />} />
          <Route path="plans/:planId/run" element={<ExecutionNavigatorPage />} />
          <Route path="guide" element={<GuidePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="debug" element={<DebugPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

function App() {
  // The theme follows the device-local mode (`docs/UI_FLOW.md` 3.5). It is
  // rebuilt only when the mode changes, and only the ThemeProvider value
  // changes: the routes below keep their tree, so a switch loses no page state.
  const themeMode = useAppearanceStore((state) => state.themeMode)
  const theme = useMemo(() => createAppTheme(themeMode), [themeMode])
  return (
    <ThemeProvider theme={theme}>
      {/* `enableColorScheme` sets the CSS `color-scheme` from the palette mode,
          so native controls and scrollbars follow Light / Dark as well. */}
      <CssBaseline enableColorScheme />
      {masterData.ok ? (
        <>
          <SettingsBootstrap />
          <ApplicationRoutes />
        </>
      ) : (
        <Box sx={{ maxWidth: 720, mx: 'auto', p: 4 }}>
          <Typography component="h1" variant="h1" gutterBottom>
            起動エラー
          </Typography>
          <Alert severity="error">
            マスターデータの検証に失敗しました:{' '}
            {masterData.issues.map((issue) => issue.message).join(' / ')}
          </Alert>
        </Box>
      )}
    </ThemeProvider>
  )
}

export default App
