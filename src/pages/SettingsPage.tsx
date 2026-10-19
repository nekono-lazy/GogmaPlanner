import {
  Alert,
  Box,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { PageShell } from '../components/PageShell'
import {
  CandidateSearchDefaultsSetting,
  type CandidateSearchDefaultsFeedback,
} from '../components/settings/CandidateSearchDefaultsSetting'
import { ClearAllDataDialog } from '../components/settings/ClearAllDataDialog'
import { DataTransferFeedbackAlert } from '../components/settings/DataTransferFeedbackAlert'
import { ExportDataDialog, type ExportSnapshot } from '../components/settings/ExportDataDialog'
import { ImportConfirmDialog } from '../components/settings/ImportConfirmDialog'
import { ImportDataDialog } from '../components/settings/ImportDataDialog'
import {
  backupFilename,
  clearFailedFeedback,
  clearSucceededFeedback,
  defaultDataTransferBrowserAdapter,
  exportFailedFeedback,
  importApplyFailedFeedback,
  importFileReadFailedFeedback,
  importPreparationFailedFeedback,
  importPreparationThrewFeedback,
  importSucceededFeedback,
  type DataTransferBrowserAdapter,
  type DataTransferFeedback,
  type DataTransferOperation,
  type ImportTextSource,
} from '../components/settings/dataTransferPresentation'
import { loadMasterData } from '../domain/master/loadMasterData'
import {
  APP_SETTINGS_SCHEMA_VERSION,
  type AppSettings,
  type CandidateSearchDefaults,
  type ExportRoot,
} from '../domain/models/publicTypes'
import { productionRngRuntime } from '../domain/rng/production/productionRngRuntime'
import {
  createImportExportService,
  type ImportPreparationResult,
} from '../services/dataTransfer/importExportService'
import {
  getProductionIdentificationAvailability,
  productionIdentificationUnavailableReasonLabels,
} from '../services/rngIdentification/productionIdentificationAvailability'
import { settingsRepository } from '../db/settingsRepository'
import { formatAppBuildIdForDisplay } from '../services/appVersion/appBuildId'
import { currentAppBuildId } from '../services/appVersion/appVersionChecker'
import { isThemeMode } from '../app/themeModePreference'
import { useAppearanceStore } from '../stores/appearanceStore'
import { useSettingsStore } from '../stores/settingsStore'

const masterData = loadMasterData()

/**
 * The Application boundary of the Settings screen. Export / Import / clear are
 * the `ImportExportService` methods as they are (`docs/DATA_MODEL.md` 15.3):
 * the screen re-implements no validation, no migration and no write, and
 * `prepareImportJson()` alone decides whether a file is importable.
 */
export interface SettingsPageDependencies {
  serializeExport(): Promise<string>
  prepareImportJson(json: string): ImportPreparationResult
  applyImport(root: ExportRoot): Promise<void>
  clearAllData(): Promise<AppSettings>
  saveDebugMode(enabled: boolean): Promise<unknown>
  /** The persisted Candidate Search defaults (`docs/DATA_MODEL.md` 13). */
  loadCandidateSearchDefaults(): Promise<CandidateSearchDefaults>
  /** Saves them and returns the settings as persisted. */
  saveCandidateSearchDefaults(defaults: CandidateSearchDefaults): Promise<AppSettings>
}

type CandidateSearchDefaultsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; saved: CandidateSearchDefaults; revision: number }

function currentRevision(state: CandidateSearchDefaultsState): number {
  return state.status === 'loaded' ? state.revision : 0
}

/** A titled, border-based settings section (the Dashboard / RNG Setup pattern). */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Typography id={headingId} component="h2" variant="h2" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  )
}

/** One titled group inside the data management section. */
function DataManagementGroup({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ minWidth: 0 }}>
      <Typography id={headingId} component="h3" variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

/**
 * One label / value row of the version information. Values are shown exactly
 * as their authorities report them; a long Engine version wraps instead of
 * overflowing a narrow screen.
 */
function VersionRow({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(0, 1.4fr)' },
        columnGap: 2,
        rowGap: 0.25,
        py: 1,
        borderTop: 1,
        borderColor: 'divider',
        '&:first-of-type': { borderTop: 0, pt: 0 },
      }}
    >
      <Typography component="dt" variant="body2" sx={{ fontWeight: 500, minWidth: 0 }}>
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Box>
  )
}

const actionButtonSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The Light / Dark choice (`docs/UI_FLOW.md` 3.5). It is a device-local
 * Presentation preference held by `useAppearanceStore`, never an
 * `AppSettings` field: it applies at once without a reload, and the Data
 * Transfer operations below neither read nor change it.
 */
function ThemeModeSetting() {
  const themeMode = useAppearanceStore((state) => state.themeMode)
  const persistFailed = useAppearanceStore((state) => state.themeModePersistFailed)
  const setThemeMode = useAppearanceStore((state) => state.setThemeMode)
  const labelId = useId()
  const helpId = useId()
  return (
    <FormControl component="fieldset" sx={{ display: 'block', minWidth: 0 }}>
      <FormLabel id={labelId} component="legend" sx={{ fontWeight: 500, color: 'text.primary', '&.Mui-focused': { color: 'text.primary' } }}>
        テーマ
      </FormLabel>
      <RadioGroup
        row
        aria-labelledby={labelId}
        aria-describedby={helpId}
        name="theme-mode"
        value={themeMode}
        onChange={(_, value) => {
          if (isThemeMode(value)) setThemeMode(value)
        }}
        sx={{ columnGap: 2 }}
      >
        <FormControlLabel value="light" control={<Radio />} label="ライト" sx={{ m: 0, minHeight: 44, pr: 1 }} />
        <FormControlLabel value="dark" control={<Radio />} label="ダーク" sx={{ m: 0, minHeight: 44, pr: 1 }} />
      </RadioGroup>
      <Typography id={helpId} variant="body2" sx={{ color: 'text.secondary' }}>
        テーマはこの端末・ブラウザの表示設定として保存され、データのエクスポート / インポートや全データ削除の対象にはなりません。
      </Typography>
      {persistFailed && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          テーマ設定を保存できませんでした。選択したテーマは今の表示にだけ反映され、再読み込み後は以前のテーマ（保存がない場合はライト）に戻る場合があります。
        </Alert>
      )}
    </FormControl>
  )
}

export function SettingsPage({
  dependencies,
  browser = defaultDataTransferBrowserAdapter,
  appBuildId = currentAppBuildId,
}: {
  dependencies?: SettingsPageDependencies
  /** The clipboard and clock of the Export Dialog; injectable for tests. */
  browser?: DataTransferBrowserAdapter
  /** The running Pages build ID (`docs/UI_FLOW.md` 14); `null` for a local build. */
  appBuildId?: string | null
}) {
  const debugMode = useSettingsStore((state) => state.debugMode)
  const setDebugMode = useSettingsStore((state) => state.setDebugMode)
  const hydrate = useSettingsStore((state) => state.hydrate)
  const api = useMemo<SettingsPageDependencies | null>(() => {
    if (dependencies) return dependencies
    if (!masterData.ok) return null
    const service = createImportExportService(masterData.data)
    return {
      serializeExport: () => service.serializeExport(),
      prepareImportJson: (json) => service.prepareImportJson(json),
      applyImport: (root) => service.applyImport(root),
      clearAllData: () => service.clearAllData(),
      saveDebugMode: (enabled) => settingsRepository.setDebugMode(enabled),
      loadCandidateSearchDefaults: () =>
        settingsRepository.ensureSettings().then((settings) => settings.candidateSearchDefaults),
      saveCandidateSearchDefaults: (defaults) => settingsRepository.setCandidateSearchDefaults(defaults),
    }
  }, [dependencies])

  const [saveError, setSaveError] = useState(false)
  // The Debug Mode save and the Data Transfer operations write or replace the
  // same settings record, so a Data Transfer never starts while a Debug Mode
  // save is pending, and the toggle is disabled while a Data Transfer runs.
  // Rapid Debug Mode toggles stay allowed as before (each one is saved; the
  // count of pending saves gates the Data Transfer). The refs mirror the state
  // so a second click in the same tick is refused too.
  const [pendingSettingsSaves, setPendingSettingsSaves] = useState(0)
  const pendingSettingsSavesRef = useRef(0)
  const [operation, setOperation] = useState<DataTransferOperation>(null)
  const operationRef = useRef<DataTransferOperation>(null)
  const [pendingImport, setPendingImport] = useState<ExportRoot | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [feedback, setFeedback] = useState<DataTransferFeedback | null>(null)
  // The Export Dialog keeps the one snapshot it was opened with; `serial`
  // remounts it for the next Export so its feedback starts empty.
  const [exportSnapshot, setExportSnapshot] = useState<(ExportSnapshot & { serial: number }) | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const exportSerialRef = useRef(0)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importDraft, setImportDraft] = useState('')
  const [importFeedback, setImportFeedback] = useState<DataTransferFeedback | null>(null)
  // The saved Candidate Search defaults. `revision` remounts the form so its
  // draft restarts from whatever is persisted after a save, Import or clear.
  const [searchDefaults, setSearchDefaults] = useState<CandidateSearchDefaultsState>(
    api === null ? { status: 'error' } : { status: 'loading' },
  )
  const [searchDefaultsSaving, setSearchDefaultsSaving] = useState(false)
  const searchDefaultsSavingRef = useRef(false)
  const [searchDefaultsFeedback, setSearchDefaultsFeedback] = useState<CandidateSearchDefaultsFeedback>(null)
  const debugHelpId = useId()
  const exportHelpId = useId()
  const importHelpId = useId()
  const clearHelpId = useId()
  const identificationAvailability = getProductionIdentificationAvailability()

  const dataTransferBusy = operation !== null
  const settingsSaving = pendingSettingsSaves > 0
  const dataManagementDisabled = api === null || dataTransferBusy || settingsSaving

  const beginOperation = useCallback((next: Exclude<DataTransferOperation, null>): boolean => {
    if (operationRef.current !== null || pendingSettingsSavesRef.current > 0) return false
    operationRef.current = next
    setOperation(next)
    setFeedback(null)
    return true
  }, [])
  const endOperation = useCallback(() => {
    operationRef.current = null
    setOperation(null)
  }, [])

  useEffect(() => {
    if (api === null) return
    let active = true
    void api
      .loadCandidateSearchDefaults()
      .then((saved) => {
        if (active) setSearchDefaults((current) => ({ status: 'loaded', saved, revision: currentRevision(current) + 1 }))
      })
      .catch(() => {
        if (active) setSearchDefaults({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [api])

  /** The persisted defaults changed under the form (Import, clear). */
  const replaceSearchDefaults = (saved: CandidateSearchDefaults) => {
    setSearchDefaults((current) => ({ status: 'loaded', saved, revision: currentRevision(current) + 1 }))
    setSearchDefaultsFeedback(null)
  }

  // Shares the pending-settings-save gate with Debug Mode, so no Data Transfer
  // starts while it is being written and it never starts during one.
  const handleSaveSearchDefaults = (defaults: CandidateSearchDefaults) => {
    if (api === null || operationRef.current !== null || searchDefaultsSavingRef.current) return
    searchDefaultsSavingRef.current = true
    setSearchDefaultsSaving(true)
    pendingSettingsSavesRef.current += 1
    setPendingSettingsSaves((count) => count + 1)
    setSearchDefaultsFeedback(null)
    void api
      .saveCandidateSearchDefaults(defaults)
      .then((settings) => {
        setSearchDefaults((current) => ({
          status: 'loaded',
          saved: settings.candidateSearchDefaults,
          revision: currentRevision(current) + 1,
        }))
        setSearchDefaultsFeedback('saved')
      })
      .catch(() => setSearchDefaultsFeedback('save_failed'))
      .finally(() => {
        searchDefaultsSavingRef.current = false
        setSearchDefaultsSaving(false)
        pendingSettingsSavesRef.current -= 1
        setPendingSettingsSaves((count) => count - 1)
      })
  }

  const handleDebugMode = (enabled: boolean) => {
    if (api === null || operationRef.current !== null) return
    pendingSettingsSavesRef.current += 1
    setPendingSettingsSaves((count) => count + 1)
    setDebugMode(enabled)
    setSaveError(false)
    void api
      .saveDebugMode(enabled)
      .catch(() => setSaveError(true))
      .finally(() => {
        pendingSettingsSavesRef.current -= 1
        setPendingSettingsSaves((count) => count - 1)
      })
  }

  // Export serializes exactly once, here. The Dialog's copy and file output
  // reuse this string and never call the Service again.
  const handleExport = async () => {
    if (api === null || !beginOperation('export')) return
    try {
      const json = await api.serializeExport()
      exportSerialRef.current += 1
      setExportSnapshot({ serial: exportSerialRef.current, json, filename: backupFilename(browser.now()) })
      setExportDialogOpen(true)
    } catch (error: unknown) {
      setFeedback(exportFailedFeedback(error))
    } finally {
      endOperation()
    }
  }

  const openImportDialog = () => {
    if (dataManagementDisabled) return
    setFeedback(null)
    setImportFeedback(null)
    setImportDraft('')
    setImportDialogOpen(true)
  }

  const closeImportDialog = () => {
    if (operationRef.current === 'import_prepare') return
    setImportDialogOpen(false)
    setImportDraft('')
    setImportFeedback(null)
  }

  /**
   * The one Import preparation path for pasted and file text alike. The text
   * goes to `prepareImportJson()` exactly as given; only an accepted root
   * reaches the full-replacement confirmation, and a refusal stays in the
   * Import Dialog with the draft kept. Runs inside an `import_prepare`
   * operation the caller began.
   */
  const prepareImportText = (json: string, source: ImportTextSource) => {
    if (api === null) return
    try {
      const prepared = api.prepareImportJson(json)
      if (prepared.ok) {
        setImportDialogOpen(false)
        setImportDraft('')
        setImportFeedback(null)
        setPendingImport(prepared.root)
      } else {
        setImportFeedback(importPreparationFailedFeedback(prepared, source))
      }
    } catch {
      setImportFeedback(importPreparationThrewFeedback(source))
    }
  }

  const handleImportDraftRead = () => {
    if (api === null || importDraft.trim() === '' || !beginOperation('import_prepare')) return
    setImportFeedback(null)
    try {
      prepareImportText(importDraft, 'paste')
    } finally {
      endOperation()
    }
  }

  const handleImportFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0] ?? null
    // Reset first, so the same file can be selected again for a retry.
    input.value = ''
    if (file === null || api === null || !beginOperation('import_prepare')) return
    setImportFeedback(null)
    try {
      let text: string
      try {
        text = await file.text()
      } catch {
        // A pasted draft, if any, stays as it was.
        setImportFeedback(importFileReadFailedFeedback())
        return
      }
      prepareImportText(text, 'file')
    } finally {
      endOperation()
    }
  }

  const handleImportConfirm = async (root: ExportRoot) => {
    if (api === null || !beginOperation('import_apply')) return
    try {
      await api.applyImport(root)
      // The imported settings are the persisted ones now; never re-read a
      // default over them.
      hydrate(root.settings)
      replaceSearchDefaults(root.settings.candidateSearchDefaults)
      setSaveError(false)
      setPendingImport(null)
      setFeedback(importSucceededFeedback())
    } catch (error: unknown) {
      setPendingImport(null)
      setFeedback(importApplyFailedFeedback(error))
    } finally {
      endOperation()
    }
  }

  const handleClearConfirm = async () => {
    if (api === null || !beginOperation('clear')) return
    try {
      const settings = await api.clearAllData()
      hydrate(settings)
      replaceSearchDefaults(settings.candidateSearchDefaults)
      setSaveError(false)
      setClearDialogOpen(false)
      setFeedback(clearSucceededFeedback())
    } catch {
      setClearDialogOpen(false)
      setFeedback(clearFailedFeedback())
    } finally {
      endOperation()
    }
  }

  return (
    <PageShell title="設定" description="アプリの表示設定、データのバックアップと復元、バージョン情報を管理します。">
      <Stack spacing={{ xs: 2, md: 3 }}>
        <SettingsSection title="表示設定">
          <ThemeModeSetting />
          <Divider sx={{ my: 2 }} />
          <FormControlLabel
            sx={{ m: 0, minHeight: 44 }}
            control={(
              <Switch
                checked={debugMode}
                disabled={api === null || dataTransferBusy}
                onChange={(_, checked) => handleDebugMode(checked)}
                slotProps={{ input: { 'aria-describedby': debugHelpId } }}
              />
            )}
            label="デバッグモード"
          />
          <Typography id={debugHelpId} variant="body2" color="text.secondary">
            内部のRNG値やデバッグ画面の表示だけを切り替えます。ゲーム計算の意味には影響しません。
          </Typography>
          {saveError && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              設定を保存できませんでした。再読み込み後は保存済みの設定が使用され、現在の表示と異なる場合があります。再度お試しください。
            </Alert>
          )}
        </SettingsSection>
        <SettingsSection title="候補検索">
          {searchDefaults.status === 'loading' && (
            <Typography variant="body2" color="text.secondary">探索量の既定値を読み込み中…</Typography>
          )}
          {searchDefaults.status === 'error' && (
            <Alert severity="error">
              探索量の既定値を読み込めませんでした。再読み込みしてからもう一度お試しください。
            </Alert>
          )}
          {searchDefaults.status === 'loaded' && (
            <CandidateSearchDefaultsSetting
              key={searchDefaults.revision}
              saved={searchDefaults.saved}
              saving={searchDefaultsSaving}
              disabled={api === null || dataTransferBusy}
              feedback={searchDefaultsFeedback}
              onSave={handleSaveSearchDefaults}
              onDraftChange={() => setSearchDefaultsFeedback(null)}
            />
          )}
        </SettingsSection>
        <SettingsSection title="データ管理">
          <Stack spacing={2.5} divider={<Divider flexItem />}>
            {api === null && <Alert severity="error">マスターデータが利用できないため、データ管理は使用できません。</Alert>}
            {feedback !== null && <DataTransferFeedbackAlert feedback={feedback} />}
            <DataManagementGroup title="バックアップ">
              <Typography id={exportHelpId} variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                RNG状態、通常アーティアCounter、所持武器、目標武器、候補と作成リスト、生産計画、実行履歴、ゲーム内セーブ地点、設定を含む全ユーザーデータを1つのJSONとして表示し、クリップボードへのコピーまたはJSONファイルとして保存します。別の端末へ移行するときや、インポート・全削除の前の控えとして使用します。
              </Typography>
              <Button
                variant="contained"
                disabled={dataManagementDisabled}
                onClick={() => void handleExport()}
                aria-describedby={exportHelpId}
                sx={actionButtonSx}
              >
                {operation === 'export' ? 'エクスポート中…' : 'データをエクスポート'}
              </Button>
            </DataManagementGroup>
            <DataManagementGroup title="復元">
              <Typography id={importHelpId} variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                エクスポートしたJSONを貼り付けるか、JSONファイルを選択して復元します。インポートは全置換で、現在保存されているデータはすべてバックアップの内容に置き換わります。必要な場合は先に現在のデータをエクスポートしてください。内容は実行前に検証し、確認後にだけ置き換えます。
              </Typography>
              <Button
                variant="outlined"
                disabled={dataManagementDisabled}
                onClick={openImportDialog}
                aria-describedby={importHelpId}
                sx={actionButtonSx}
              >
                {operation === 'import_apply' ? 'インポート中…' : 'データをインポート'}
              </Button>
            </DataManagementGroup>
            <DataManagementGroup title="初期化">
              <Typography id={clearHelpId} variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                保存されているユーザーデータをすべて削除し、初期状態へ戻します。この操作は元に戻せません。必要なデータがある場合は先にエクスポートしてください。
              </Typography>
              <Button
                variant="outlined"
                color="error"
                disabled={dataManagementDisabled}
                onClick={() => setClearDialogOpen(true)}
                aria-describedby={clearHelpId}
                sx={actionButtonSx}
              >
                {operation === 'clear' ? '削除中…' : '全データを削除'}
              </Button>
            </DataManagementGroup>
          </Stack>
        </SettingsSection>
        <SettingsSection title="バージョン情報">
          {!masterData.ok && (
            <Alert severity="error" sx={{ mb: 1.5 }}>マスターデータを読み込めません。</Alert>
          )}
          <Box component="dl" aria-label="バージョン情報" sx={{ m: 0 }}>
            {masterData.ok && (
              <>
                <VersionRow
                  label="ゲームバージョン"
                  value={masterData.data.manifest.gameVersion === 'unknown-initial' ? '未確認' : masterData.data.manifest.gameVersion}
                />
                <VersionRow label="マスターデータバージョン" value={String(masterData.data.manifest.dataVersion)} />
                <VersionRow label="アプリスキーマバージョン" value={String(APP_SETTINGS_SCHEMA_VERSION)} />
              </>
            )}
            {/* The commit SHA this build was deployed from, shortened for display
                only; the stale client check compares the full ID. */}
            <VersionRow
              label="ビルドID"
              value={appBuildId === null ? 'なし（ローカル開発）' : formatAppBuildIdForDisplay(appBuildId)}
            />
            <VersionRow label="RNG予測エンジン" value={productionRngRuntime.mode} />
            <VersionRow label="Engine version" value={productionRngRuntime.version} />
            {/* RNG同定 is the Identification Wizard availability, decided at the
                application level and never by an RngEngine capability flag
                (`docs/UI_FLOW.md` 5 / 14). */}
            <VersionRow
              label="RNG状態の特定"
              value={identificationAvailability.isAvailable ? '利用可能' : `利用不可（${productionIdentificationUnavailableReasonLabels[identificationAvailability.reason]}）`}
            />
          </Box>
        </SettingsSection>
      </Stack>
      <ExportDataDialog
        key={exportSnapshot?.serial ?? 0}
        open={exportDialogOpen}
        snapshot={exportSnapshot}
        writeClipboardText={browser.writeClipboardText}
        onClose={() => setExportDialogOpen(false)}
      />
      <ImportDataDialog
        open={importDialogOpen}
        draft={importDraft}
        feedback={importFeedback}
        preparing={operation === 'import_prepare'}
        disabled={api === null || (dataTransferBusy && operation !== 'import_prepare') || settingsSaving}
        onDraftChange={setImportDraft}
        onReadDraft={handleImportDraftRead}
        onFileSelected={(event) => void handleImportFileSelected(event)}
        onClose={closeImportDialog}
      />
      <ImportConfirmDialog
        root={pendingImport}
        submitting={operation === 'import_apply'}
        onCancel={() => {
          if (operation !== 'import_apply') setPendingImport(null)
        }}
        onConfirm={(root) => void handleImportConfirm(root)}
      />
      <ClearAllDataDialog
        open={clearDialogOpen}
        submitting={operation === 'clear'}
        onCancel={() => {
          if (operation !== 'clear') setClearDialogOpen(false)
        }}
        onConfirm={() => void handleClearConfirm()}
      />
    </PageShell>
  )
}
