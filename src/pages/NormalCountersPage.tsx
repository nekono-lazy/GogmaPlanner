import { useEffect, useId, useMemo, useState } from 'react'
import { Alert, Box, Button, Checkbox, FormControlLabel, LinearProgress, Paper, Stack, TextField, Typography } from '@mui/material'
import type { Theme } from '@mui/material/styles'
import { PageShell } from '../components/PageShell'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import { usePlanBreakingChangeApproval } from '../components/execution/usePlanBreakingChangeApproval'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../domain/execution'
import { StatusChip, type StatusTone } from '../components/StatusChip'
import {
  NormalCounterIdentificationDialog,
  type NormalCounterIdentificationConfirmation,
} from '../components/rng/NormalCounterIdentificationDialog'
import { loadMasterData } from '../domain/master/loadMasterData'
import { getEnabledWeaponTypes } from '../domain/master/masterSelectors'
import type { AppSettings, NormalArtianCounter, RngState, WeaponTypeId } from '../domain/models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../domain/models/publicTypes'
import { validateNormalArtianCounter } from '../domain/models/validation'
import {
  getNormalArtianCounterIdentificationSupport,
  MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER,
} from '../domain/rng/identification'
import { productionRngEngine } from '../domain/rng/production/productionRngRuntime'
import type { NormalizedSeed } from '../domain/rng/rngEngine'
import { normalArtianCounterId, normalArtianCounterRepository, rngStateRepository, settingsRepository } from '../db/repositories'
import {
  rngStatePersistenceService,
  type NormalArtianCounterIdentificationAdoption,
} from '../services/rngState/rngStatePersistenceService'
import { normalCounterIdentificationUnsupportedLabel } from '../presentation/normalCounterIdentification'
import {
  createProductionNormalArtianCounterIdentificationWorkerClient,
  type NormalArtianCounterIdentificationWorkerClient,
} from '../services/rngIdentification/normalArtianCounterIdentificationWorkerClient'
import { useSettingsStore } from '../stores/settingsStore'

const masterResult = loadMasterData()

const BASE_SEED_REQUIRED_MESSAGE = '先にRNG状態設定でBase Seedを確定してください。Base Seedが確定するまでCounter検索を開始できません。'
const BASE_SEED_NOT_CANONICAL_MESSAGE = '保存済みのBase Seedが予測用の形式ではありません。RNG状態設定でBase Seedを保存し直してからCounter検索を開始してください。'
/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
const NORMAL_COUNTER_PLAN_BREAKING_NOTE =
  '通常アーティアカウンターを変更すると、現在の生産計画で使用している予測位置と一致しなくなります。'
const PLAN_ABANDONED_SUFFIX = '実行中の生産計画を破棄しました。'

export interface NormalCountersPageDependencies {
  getAll(): Promise<NormalArtianCounter[]>
  /**
   * `basis` is the stored record the edit started from, if any. `approval` is
   * the breaking-change approval when the inspection required one
   * (`docs/UI_FLOW.md` 16.3).
   */
  save(
    value: NormalArtianCounter,
    basis?: NormalArtianCounter,
    approval?: PlanBreakingChangeApproval | null,
  ): Promise<NormalArtianCounter>
  /** The read-only breaking-change inspection of that very save. */
  inspectSave(value: NormalArtianCounter, basis?: NormalArtianCounter): Promise<PlanBreakingChangeInspection>
  /** The unique Identification result adoption: the only path that records `lastIdentifiedAt`. */
  adoptIdentification(
    adoption: NormalArtianCounterIdentificationAdoption,
    approval?: PlanBreakingChangeApproval | null,
  ): Promise<NormalArtianCounter>
  /** The read-only breaking-change inspection of that very adoption. */
  inspectIdentificationAdoption(
    adoption: NormalArtianCounterIdentificationAdoption,
  ): Promise<PlanBreakingChangeInspection>
  ensureRngState(): Promise<RngState>
  ensureSettings(): Promise<AppSettings>
  createIdentificationClient(): NormalArtianCounterIdentificationWorkerClient
  now?(): string
  requestId?(): string
}
const defaultDependencies: NormalCountersPageDependencies = {
  getAll: () => normalArtianCounterRepository.getAllNormalArtianCounters(),
  save: (value, basis, approval) =>
    rngStatePersistenceService.saveNormalArtianCounter(value, basis ?? null, approval ?? null),
  inspectSave: (value, basis) => rngStatePersistenceService.inspectNormalArtianCounterSave(value, basis ?? null),
  adoptIdentification: (adoption, approval) =>
    rngStatePersistenceService.adoptNormalArtianCounterIdentification(adoption, approval ?? null),
  inspectIdentificationAdoption: (adoption) =>
    rngStatePersistenceService.inspectNormalArtianCounterIdentificationAdoption(adoption),
  ensureRngState: () => rngStateRepository.ensureInitialRngState(),
  ensureSettings: () => settingsRepository.ensureSettings(),
  createIdentificationClient: createProductionNormalArtianCounterIdentificationWorkerClient,
}

function emptyCounter(weaponTypeId: string, now: string): NormalArtianCounter {
  return { id: normalArtianCounterId(weaponTypeId, V1_NORMAL_ARTIAN_RARITY), weaponTypeId, rarity: V1_NORMAL_ARTIAN_RARITY, counter: null, isConfirmed: false, observationCount: 0, lastObservedAt: null, candidateCount: null, lastIdentifiedAt: null, createdAt: now, updatedAt: now }
}

/**
 * Status shown per row (`docs/UI_FLOW.md` 6: 未設定 / 候補複数 / 確定). It only
 * restates `isConfirmed`, whether a value is held, and the persisted candidate
 * count.
 */
function counterStatus(row: NormalArtianCounter): { label: string; tone: StatusTone } {
  if (row.isConfirmed) return { label: '確定・検索に使用', tone: 'positive' }
  if (row.candidateCount !== null && row.candidateCount > 1) return { label: '候補複数・検索に未使用', tone: 'caution' }
  if (row.counter === null) return { label: '未設定・検索に未使用', tone: 'neutral' }
  return { label: '未確定・検索に未使用', tone: 'caution' }
}

/**
 * The confirmed canonical Base Seed the identification may use, or the reason
 * it cannot start. Only `baseSeed` is read: Skill / Gogma Counter and the
 * legacy Counter Gate are not requirements of this search.
 */
function identificationBaseSeed(state: RngState | null): { seed: NormalizedSeed; issue: null } | { seed: null; issue: string } {
  if (state === null || state.baseSeed.value === null || !state.baseSeed.isConfirmed) {
    return { seed: null, issue: BASE_SEED_REQUIRED_MESSAGE }
  }
  try {
    if (productionRngEngine.normalizeSeed(state.baseSeed.value) !== state.baseSeed.value) {
      return { seed: null, issue: BASE_SEED_NOT_CANONICAL_MESSAGE }
    }
  } catch {
    return { seed: null, issue: BASE_SEED_NOT_CANONICAL_MESSAGE }
  }
  return { seed: state.baseSeed.value, issue: null }
}

/**
 * The カウンター値 cell (`docs/UI_FLOW.md` 6): the one normal-UI exception to
 * "no Counter values" (`docs/UI_FLOW.md` 3), limited to a confirmed Counter.
 * A value merely retained while unconfirmed (after 確定解除 or a Debug save)
 * is never shown as if it were current; Debug Mode shows it in its editor.
 */
function displayedCounterValue(row: NormalArtianCounter): string {
  return row.isConfirmed && row.counter !== null ? String(row.counter) : '—'
}

/** Visually hidden from `md` up, where the column header row names the cell. */
const inlineCellLabelSx = (theme: Theme) => ({
  color: 'text.secondary',
  mr: 0.75,
  [theme.breakpoints.up('md')]: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    m: 0,
  },
})

/**
 * PC: one table-like row per weapon type. Smartphone: the same row stacked as a card.
 * The status and action columns' fixed minimums keep the longest status chip
 * and 観測・検索 + 確定解除 on one line, and every row's columns aligned
 * whichever chip and buttons the row has.
 */
const rowGridSx = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', md: 'minmax(0, 1fr) minmax(11rem, 1.3fr) minmax(0, 0.8fr) minmax(10.5rem, 1fr)' },
  gridTemplateAreas: {
    xs: '"name status" "counter counter" "actions actions"',
    md: '"name status counter actions"',
  },
  columnGap: 2,
  rowGap: 0.75,
  alignItems: 'center',
} as const

interface RowIdentification {
  /** Null when the search may start; otherwise the sentence explaining why not. */
  readonly blockedReason: string | null
  /** True when the block is this weapon type's own Production support, shown in the row. */
  readonly unsupported: boolean
}

function CounterRow({ row, weaponName, debugMode, identification, disabled, onChange, onSave, onStartIdentification, onUnconfirm }: {
  row: NormalArtianCounter
  weaponName: string
  debugMode: boolean
  identification: RowIdentification
  /** A save of a Counter is in flight or waits for the user's confirmation. */
  disabled: boolean
  onChange(next: NormalArtianCounter): void
  onSave(value: NormalArtianCounter): void
  onStartIdentification(): void
  onUnconfirm(): void
}) {
  const headingId = useId()
  const unsupportedId = useId()
  const status = counterStatus(row)
  return (
    <Box
      component="li"
      aria-labelledby={headingId}
      sx={{ position: 'relative', listStyle: 'none', px: { xs: 2, md: 2.5 }, py: 1.5, borderTop: 1, borderColor: 'divider' }}
    >
      <Box sx={rowGridSx}>
        <Typography id={headingId} component="h3" variant="h3" sx={{ gridArea: 'name', minWidth: 0 }}>{weaponName}</Typography>
        <Box sx={{ gridArea: 'status', justifySelf: { xs: 'end', md: 'start' } }}><StatusChip label={status.label} tone={status.tone} /></Box>
        <Typography variant="body2" className="tabular-nums" sx={{ gridArea: 'counter', overflowWrap: 'anywhere' }}>
          <Box component="span" sx={inlineCellLabelSx}>カウンター値</Box>{displayedCounterValue(row)}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ gridArea: 'actions', flexWrap: 'wrap', justifyContent: { xs: 'flex-end', md: 'flex-start' } }}>
          <Button
            variant="outlined"
            size="small"
            sx={{ minHeight: 44 }}
            disabled={disabled || identification.blockedReason !== null}
            aria-describedby={identification.unsupported ? `${headingId} ${unsupportedId}` : headingId}
            onClick={onStartIdentification}
          >
            観測・検索
          </Button>
          {row.isConfirmed && (
            <Button variant="text" size="small" color="warning" sx={{ minHeight: 44 }} disabled={disabled} aria-describedby={headingId} onClick={onUnconfirm}>
              確定解除
            </Button>
          )}
        </Stack>
      </Box>
      {identification.unsupported && identification.blockedReason !== null && (
        <Typography id={unsupportedId} variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{identification.blockedReason}</Typography>
      )}
      {debugMode && (
        <Box
          sx={{
            mt: 1.5,
            p: 1.5,
            border: 1,
            borderStyle: 'dashed',
            borderColor: 'warning.main',
            borderRadius: 1,
            display: 'grid',
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr)) minmax(0, 1.4fr) auto auto' },
            gap: 1.5,
            alignItems: 'center',
          }}
        >
          <TextField size="small" label="Counter raw値" type="number" value={row.counter ?? ''} onChange={(event) => onChange({ ...row, counter: event.target.value === '' ? null : Number(event.target.value), isConfirmed: event.target.value === '' ? false : row.isConfirmed })} />
          <TextField size="small" label="observationCount" type="number" value={row.observationCount} onChange={(event) => onChange({ ...row, observationCount: Number(event.target.value) })} />
          <TextField size="small" label="candidateCount" type="number" value={row.candidateCount ?? ''} onChange={(event) => onChange({ ...row, candidateCount: event.target.value === '' ? null : Number(event.target.value) })} />
          <TextField size="small" label="lastObservedAt" value={row.lastObservedAt ?? ''} onChange={(event) => onChange({ ...row, lastObservedAt: event.target.value || null })} sx={{ gridColumn: { xs: '1 / -1', md: 'auto' } }} />
          <FormControlLabel sx={{ m: 0, minHeight: 44 }} control={<Checkbox checked={row.isConfirmed} disabled={row.counter === null} onChange={(event) => onChange({ ...row, isConfirmed: event.target.checked })} />} label="確定済み" />
          <Button variant="outlined" disabled={disabled} onClick={() => onSave(row)} aria-describedby={headingId} sx={{ minHeight: 44, justifySelf: { xs: 'end', md: 'stretch' } }}>デバッグ保存</Button>
        </Box>
      )}
    </Box>
  )
}

/** One open observation session: its weapon type and the Worker Client the page owns for it. */
interface IdentificationSession {
  readonly weaponTypeId: WeaponTypeId
  readonly client: NormalArtianCounterIdentificationWorkerClient
}

export function NormalCountersPage({ dependencies = defaultDependencies }: { dependencies?: NormalCountersPageDependencies }) {
  const debugMode = useSettingsStore((state) => state.debugMode)
  const [values, setValues] = useState<NormalArtianCounter[]>([])
  const [rngState, setRngState] = useState<RngState | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  // A failed read is not "every Counter unset": no synthetic rows are shown.
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [session, setSession] = useState<IdentificationSession | null>(null)
  // The breaking-change warning every Counter save and the Identification
  // adoption go through (`docs/UI_FLOW.md` 16.3).
  const planGuard = usePlanBreakingChangeApproval()
  const listHeadingId = useId()
  const now = dependencies.now ?? (() => new Date().toISOString())
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID())

  useEffect(() => {
    let active = true
    void Promise.all([dependencies.getAll(), dependencies.ensureRngState(), dependencies.ensureSettings()])
      .then(([loaded, loadedRngState, loadedSettings]) => { if (active) { setValues(loaded); setRngState(loadedRngState); setSettings(loadedSettings) } })
      .catch((caught: unknown) => { if (active) { setLoadFailed(true); setError(caught instanceof Error ? caught.message : 'カウンターを読み込めません。') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [dependencies])

  // The page owns the Worker Client: a session ends only when the Dialog is
  // really closed, the Counter is confirmed, or this page unmounts.
  useEffect(() => {
    if (!session) return
    return () => { session.client.dispose() }
  }, [session])

  const baseSeed = useMemo(() => identificationBaseSeed(rngState), [rngState])

  if (!masterResult.ok) return <PageShell title="通常アーティアカウンター" description="通常アーティアカウンターを確認します。"><Alert severity="error">マスターデータが利用できません。</Alert></PageShell>
  const master = masterResult.data
  const rows = getEnabledWeaponTypes(master).map((weaponType) => values.find((value) => value.weaponTypeId === weaponType.id && value.rarity === V1_NORMAL_ARTIAN_RARITY) ?? emptyCounter(weaponType.id, now()))
  const confirmedCount = rows.filter((row) => row.isConfirmed && row.counter !== null).length
  const weaponName = (weaponTypeId: WeaponTypeId) => master.weaponTypes.find(({ id }) => id === weaponTypeId)?.displayNameJa ?? weaponTypeId
  const update = (next: NormalArtianCounter) => setValues((current) => [...current.filter(({ id }) => id !== next.id), next])

  const persist = async (value: NormalArtianCounter, successNotice: string) => {
    setError(null)
    const next = { ...value, isConfirmed: value.counter === null ? false : value.isConfirmed, updatedAt: now() }
    const validation = validateNormalArtianCounter(next)
    if (!validation.isValid) throw new Error(validation.issues.map(({ message }) => message).join(' / '))
    const basis = values.find(({ id }) => id === next.id)
    // The inspection and the save close over the same record against the same
    // basis; the runtime alone decides whether the warning is shown.
    const outcome = await planGuard.run({
      inspect: () => dependencies.inspectSave(next, basis),
      apply: (approval) => dependencies.save(next, basis, approval),
      note: NORMAL_COUNTER_PLAN_BREAKING_NOTE,
    })
    if (outcome.status === 'cancelled') return
    if (outcome.status === 'refused') throw new Error(outcome.message)
    update(outcome.result)
    setNotice(outcome.planAbandoned ? `${successNotice}${PLAN_ABANDONED_SUFFIX}` : successNotice)
  }
  const save = async (value: NormalArtianCounter) => {
    try { await persist(value, 'カウンターを保存しました。') } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : '保存できません。') }
  }
  // Unconfirming keeps counter / observationCount / candidateCount /
  // lastObservedAt as they are; only `isConfirmed` changes, so Candidate Search
  // stops using the Counter while nothing observed is lost. The list then
  // shows カウンター値 — for the row: the retained value is not current.
  const unconfirm = async (row: NormalArtianCounter) => {
    try { await persist({ ...row, isConfirmed: false }, `${weaponName(row.weaponTypeId)}のカウンターの確定を解除しました。`) } catch (caught: unknown) { setError(caught instanceof Error ? caught.message : '確定を解除できません。') }
  }

  const rowIdentification = (row: NormalArtianCounter): RowIdentification => {
    const support = getNormalArtianCounterIdentificationSupport(row.weaponTypeId, row.rarity, productionRngEngine)
    if (!support.supported) return { blockedReason: normalCounterIdentificationUnsupportedLabel(support.reason), unsupported: true }
    if (baseSeed.issue !== null) return { blockedReason: baseSeed.issue, unsupported: false }
    if (settings === null) return { blockedReason: '設定を読み込み中です。', unsupported: false }
    return { blockedReason: null, unsupported: false }
  }

  const startIdentification = (row: NormalArtianCounter) => {
    setError(null); setNotice(null)
    // Fail closed: the disabled button is not the only guard.
    const identification = rowIdentification(row)
    if (identification.blockedReason !== null) { setError(identification.blockedReason); return }
    if (session !== null) return
    try {
      setSession({ weaponTypeId: row.weaponTypeId, client: dependencies.createIdentificationClient() })
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Counter検索を開始できません。')
    }
  }

  /**
   * Persists the unique result exactly as the kernel returned it:
   * `counter = startNormalCounter` (never `C + observationCount`), confirmed,
   * with the observation count and a single remaining candidate
   * (`docs/UI_FLOW.md` 6). The observation history itself is not saved.
   */
  const confirmIdentifiedCounter = async (weaponTypeId: WeaponTypeId, confirmation: NormalCounterIdentificationConfirmation) => {
    setError(null)
    const adoption: NormalArtianCounterIdentificationAdoption = {
      weaponTypeId,
      startNormalCounter: confirmation.startNormalCounter,
      observationCount: confirmation.observationCount,
    }
    // The persistence service builds the record and is the only writer of the
    // Identification provenance `lastIdentifiedAt`; the same adoption is
    // inspected and saved. A cancelled warning keeps the Dialog, its result
    // and the game-restored confirmation open for another try.
    const outcome = await planGuard.run({
      inspect: () => dependencies.inspectIdentificationAdoption(adoption),
      apply: (approval) => dependencies.adoptIdentification(adoption, approval),
      note: NORMAL_COUNTER_PLAN_BREAKING_NOTE,
    })
    if (outcome.status === 'cancelled') return
    if (outcome.status === 'refused') throw new Error(outcome.message)
    update(outcome.result)
    const notice = `${weaponName(weaponTypeId)}のカウンターを確定しました。`
    setNotice(outcome.planAbandoned ? `${notice}${PLAN_ABANDONED_SUFFIX}` : notice)
    setSession(null)
  }

  return (
    <PageShell title="通常アーティアカウンター" description="レア8通常アーティアの武器種別カウンターを確認します。">
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}
        <Alert severity="info">v1ではレア8のみを扱います。各武器種の「観測・検索」から、同じ武器種を連続して作成した通常アーティアの復元ボーナスを入力してカウンターを特定できます。直接編集はデバッグモード限定です。</Alert>
        {!loading && !loadFailed && baseSeed.issue !== null && <Alert severity="warning">{baseSeed.issue}</Alert>}
        {debugMode && <Alert severity="warning">デバッグモード: カウンターを直接編集できます。保存した値は通常アーティア経由の候補検索に使用されます。</Alert>}
        {!loadFailed && <Paper component="section" variant="outlined" aria-labelledby={listHeadingId} sx={{ overflow: 'hidden' }}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ px: { xs: 2, md: 2.5 }, pt: 2, pb: { xs: 1.5, md: 2 }, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Typography id={listHeadingId} component="h2" variant="h2">武器種別カウンター（レア8）</Typography>
            {!loading && <Typography variant="body2" color="text.secondary" className="tabular-nums">確定 {confirmedCount} / {rows.length}</Typography>}
          </Stack>
          {loading ? (
            <LinearProgress aria-label="カウンターを読み込み中" />
          ) : (
            <>
              <Box aria-hidden="true" sx={{ ...rowGridSx, display: { xs: 'none', md: 'grid' }, gridTemplateAreas: undefined, px: 2.5, py: 1, bgcolor: 'background.default', borderTop: 1, borderColor: 'divider' }}>
                {['武器種', '状態', 'カウンター値', '操作'].map((label) => <Typography key={label} variant="subtitle2" color="text.secondary">{label}</Typography>)}
              </Box>
              <Box component="ul" sx={{ m: 0, p: 0 }}>
                {rows.map((row) => (
                  <CounterRow
                    key={row.id}
                    row={row}
                    weaponName={weaponName(row.weaponTypeId)}
                    debugMode={debugMode}
                    identification={rowIdentification(row)}
                    disabled={planGuard.busy}
                    onChange={update}
                    onSave={(value) => void save(value)}
                    onStartIdentification={() => startIdentification(row)}
                    onUnconfirm={() => void unconfirm(row)}
                  />
                ))}
              </Box>
            </>
          )}
        </Paper>}
      </Stack>
      <PlanBreakingChangeDialog controller={planGuard} />
      {session && baseSeed.seed !== null && settings !== null && (
        <NormalCounterIdentificationDialog
          weaponTypeId={session.weaponTypeId}
          weaponName={weaponName(session.weaponTypeId)}
          baseSeed={baseSeed.seed}
          initialCounterRange={{ startInclusive: 0, endInclusive: Math.min(settings.defaultSearchLimit, MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER) }}
          bonusTypes={master.bonusTypes}
          elements={master.elements}
          client={session.client}
          createRequestId={requestId}
          debugMode={debugMode}
          onConfirm={(confirmation) => confirmIdentifiedCounter(session.weaponTypeId, confirmation)}
          onClose={() => setSession(null)}
        />
      )}
    </PageShell>
  )
}
