import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { PageShell } from '../components/PageShell'
import {
  debugTimestampLabel,
  debugUnsetValueLabel,
  debugWeaponTypeLabel,
  knownValueDebugView,
  orderNormalArtianCountersForDebug,
} from '../components/debug/debugStatePresentation'
import { PlanStepDebugDetails } from '../components/debug/PlanStepDebugDetails'
import { loadMasterData } from '../domain/master/loadMasterData'
import {
  CURRENT_CALCULATION_APP_SCHEMA_VERSION,
  type CalculationContext,
  type KnownValue,
  type NormalArtianCounter,
  type ProductionPlan,
  type RngState,
} from '../domain/models/publicTypes'
import { productionRngRuntime } from '../domain/rng/production/productionRngRuntime'
import {
  productionPlanRecalculationReasonLabels,
  productionPlanStatusLabels,
} from '../presentation/labels'
import {
  createDebugPageDependencies,
  type DebugPageDependencies,
} from '../services/debug/debugPageDependencies'
import { getProductionIdentificationAvailability } from '../services/rngIdentification/productionIdentificationAvailability'
import { useSettingsStore } from '../stores/settingsStore'

const loadedMaster = loadMasterData()

const capabilityRows = [
  ['supportsNormalArtianPrediction', productionRngRuntime.capabilities.supportsNormalArtianPrediction],
  ['supportsSkillPrediction', productionRngRuntime.capabilities.supportsSkillPrediction],
  ['supportsGogmaPrediction', productionRngRuntime.capabilities.supportsGogmaPrediction],
  ['supportsKeepBonusesPrediction', productionRngRuntime.capabilities.supportsKeepBonusesPrediction],
] as const

/**
 * Application-level Production Identification availability. It is decided at the
 * Worker / application level and never by an RngEngine capability flag.
 */
function identificationAvailabilityValue(): string {
  const availability = getProductionIdentificationAvailability()
  return availability.isAvailable
    ? 'available（利用可能）'
    : `unavailable: ${availability.reason}（利用不可）`
}

/** The raw flag plus its meaning, so a row never reads as a bare `true` / `false`. */
function capabilityValue(supported: boolean): string {
  return `${String(supported)}（${supported ? '対応' : '未対応'}）`
}

/** A titled, border-based developer section. Internal English names are allowed here. */
function DebugSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Typography id={headingId} component="h2" variant="h2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  )
}

/** Long identifiers and versions wrap inside the list instead of overflowing. */
const wrappingTextProps = {
  primary: { sx: { overflowWrap: 'anywhere' } },
  secondary: { sx: { overflowWrap: 'anywhere' } },
} as const

/** One label / value pair of a Debug definition list. */
function DebugRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      <Box component="dd" sx={{ m: 0, minWidth: 0 }}>
        {children}
      </Box>
    </>
  )
}

function DebugList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      component="dl"
      // `dl` carries no implicit ARIA role, so the labelled key / value set is
      // exposed as a named group instead of an unnamed run of text.
      role="group"
      aria-label={label}
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'auto minmax(0, 1fr)' },
        columnGap: 1.5,
        rowGap: 0.5,
        minWidth: 0,
      }}
    >
      {children}
    </Box>
  )
}

function DebugValue({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
      {children}
    </Typography>
  )
}

/** A persisted `KnownValue`: the stored value, its confirmation and its source. */
function KnownValueRows({ known }: { known: KnownValue<string> | KnownValue<number> }) {
  const view = knownValueDebugView(known)
  return (
    <>
      <DebugValue>value: {view.value}</DebugValue>
      <DebugValue>confirmed: {view.confirmed}</DebugValue>
      <DebugValue>source: {view.source}</DebugValue>
    </>
  )
}

/** One read that either produced a value or failed; a failure is never an empty result. */
type ReadResult<T> = { ok: true; value: T } | { ok: false }

interface DebugSnapshot {
  rngState: ReadResult<RngState | undefined>
  normalCounters: ReadResult<NormalArtianCounter[]>
  runningPlan: ReadResult<ProductionPlan | undefined>
}

type DebugLoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; snapshot: DebugSnapshot }

async function readOr<T>(read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() }
  } catch {
    // A Repository invariant failure (two running Plans, an invalid record)
    // must never be reported as "no value": it is a read error of its own.
    return { ok: false }
  }
}

const defaultDependencies = createDebugPageDependencies()

/**
 * Debug Details (`docs/REQUIREMENTS.md` 33, `docs/UI_FLOW.md` 15).
 *
 * Shown only while Debug Mode is on. Debug Mode is an observation feature: it
 * changes no RNG prediction, Candidate Search, Planner, Execution, validation
 * or persistence semantics, and this screen adds no save or edit of its own.
 * Every value below is the persisted record or a static Engine / Master
 * authority, read once; nothing is predicted, replanned or recomputed here.
 *
 * While Debug Mode is off the reading component is not mounted at all, so no
 * internal value is read from IndexedDB and none reaches the DOM.
 */
export function DebugPage({
  dependencies = defaultDependencies,
}: {
  dependencies?: DebugPageDependencies
} = {}) {
  const debugMode = useSettingsStore((state) => state.debugMode)

  if (!debugMode) {
    return (
      <PageShell title="Debug Details" description="内部状態を確認する開発者向け画面です。">
        <Alert severity="info">Debug Modeが無効です。「設定」画面のデバッグモードから有効にしてください。</Alert>
      </PageShell>
    )
  }

  return (
    <PageShell title="Debug Details" description="内部状態を確認する開発者向け画面です。">
      <DebugDetails dependencies={dependencies} />
    </PageShell>
  )
}

function DebugDetails({ dependencies }: { dependencies: DebugPageDependencies }) {
  const [load, setLoad] = useState<DebugLoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [rngState, normalCounters, runningPlan] = await Promise.all([
          readOr(() => dependencies.getRngState()),
          readOr(() => dependencies.getNormalCounters()),
          readOr(() => dependencies.getRunningProductionPlan()),
        ])
        if (!cancelled) {
          setLoad({ status: 'loaded', snapshot: { rngState, normalCounters, runningPlan } })
        }
      } catch {
        if (!cancelled) setLoad({ status: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dependencies])

  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      {load.status === 'loading' && (
        <Stack spacing={1} role="status" aria-live="polite">
          <LinearProgress aria-label="保存済みの内部状態を読み込み中" />
          <Typography variant="body2">保存済みの内部状態を読み込んでいます。</Typography>
        </Stack>
      )}
      {load.status === 'error' && (
        <Alert severity="error">保存済みの内部状態を読み込めませんでした。</Alert>
      )}
      {load.status === 'loaded' && (
        <>
          <CurrentRngStateSection result={load.snapshot.rngState} />
          <NormalArtianCountersSection result={load.snapshot.normalCounters} />
          <RunningProductionPlanSection result={load.snapshot.runningPlan} />
        </>
      )}
      <RngEngineSection />
      <MasterVersionSection />
    </Stack>
  )
}

/** The persisted `RngState` (`docs/DATA_MODEL.md` 6.1), exactly as stored. */
function CurrentRngStateSection({ result }: { result: ReadResult<RngState | undefined> }) {
  return (
    <DebugSection title="現在のRNG状態">
      {!result.ok ? (
        <Alert severity="error">現在のRNG状態を読み込めませんでした。</Alert>
      ) : result.value === undefined ? (
        <Typography variant="body2">保存済みのRNG状態はありません。</Typography>
      ) : (
        <DebugList label="現在のRNG状態">
          <DebugRow label="Base Seed">
            <KnownValueRows known={result.value.baseSeed} />
          </DebugRow>
          <DebugRow label="Gogma Counter">
            <KnownValueRows known={result.value.gogmaCounter} />
          </DebugRow>
          <DebugRow label="Skill Counter">
            <KnownValueRows known={result.value.skillCounter} />
          </DebugRow>
          <DebugRow label="Counter Gate">
            <KnownValueRows known={result.value.counterGate} />
            {/* Persisted Counter Gate is legacy / diagnostic / compatibility
                data. Production active Prediction supplies its own
                active-branch representatives and never reads this value
                (`docs/UI_FLOW.md` 15, AGENTS.md Partial RNG State). */}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              診断・互換用の保存値です。Production Predictionではpersisted Counter
              Gateをauthorityとして使用しません。
            </Typography>
          </DebugRow>
          <DebugRow label="lastIdentifiedAt">
            <DebugValue>{debugTimestampLabel(result.value.lastIdentifiedAt)}</DebugValue>
          </DebugRow>
          <DebugRow label="updatedAt">
            <DebugValue>{result.value.updatedAt}</DebugValue>
          </DebugRow>
          <DebugRow label="schemaVersion">
            <DebugValue>{String(result.value.schemaVersion)}</DebugValue>
          </DebugRow>
        </DebugList>
      )}
    </DebugSection>
  )
}

/**
 * Every persisted `NormalArtianCounter` (`docs/DATA_MODEL.md` 6.2), in a stable
 * order that does not depend on what order the repository returned.
 */
function NormalArtianCountersSection({
  result,
}: {
  result: ReadResult<NormalArtianCounter[]>
}) {
  const counters = useMemo(() => {
    if (!result.ok) return []
    return loadedMaster.ok
      ? orderNormalArtianCountersForDebug(result.value, loadedMaster.data)
      : result.value
  }, [result])
  return (
    <DebugSection title="通常アーティアCounter">
      {!result.ok ? (
        <Alert severity="error">保存済みの通常アーティアCounterを読み込めませんでした。</Alert>
      ) : counters.length === 0 ? (
        <Typography variant="body2">保存済みの通常アーティアCounterはありません。</Typography>
      ) : (
        <Stack
          component="ul"
          spacing={1}
          aria-label="保存済みの通常アーティアCounter"
          sx={{ m: 0, p: 0, listStyle: 'none', minWidth: 0 }}
        >
          {counters.map((counter) => (
            <Box
              component="li"
              key={counter.id}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 0 }}
            >
              <Typography variant="subtitle2" sx={{ mb: 0.5, overflowWrap: 'anywhere' }}>
                {loadedMaster.ok
                  ? debugWeaponTypeLabel(counter.weaponTypeId, loadedMaster.data)
                  : counter.weaponTypeId}
              </Typography>
              <DebugList label={`${counter.id} の通常アーティアCounter`}>
                <DebugRow label="weaponTypeId">
                  <DebugValue>{counter.weaponTypeId}</DebugValue>
                </DebugRow>
                <DebugRow label="rarity">
                  <DebugValue>{String(counter.rarity)}</DebugValue>
                </DebugRow>
                <DebugRow label="counter">
                  <DebugValue>
                    {counter.counter === null ? debugUnsetValueLabel : String(counter.counter)}
                  </DebugValue>
                </DebugRow>
                <DebugRow label="isConfirmed">
                  <DebugValue>
                    {String(counter.isConfirmed)}（{counter.isConfirmed ? '確定' : '未確定'}）
                  </DebugValue>
                </DebugRow>
                <DebugRow label="observationCount">
                  <DebugValue>{String(counter.observationCount)}</DebugValue>
                </DebugRow>
                <DebugRow label="candidateCount">
                  <DebugValue>
                    {counter.candidateCount === null
                      ? debugUnsetValueLabel
                      : String(counter.candidateCount)}
                  </DebugValue>
                </DebugRow>
                <DebugRow label="lastObservedAt">
                  <DebugValue>{debugTimestampLabel(counter.lastObservedAt)}</DebugValue>
                </DebugRow>
                <DebugRow label="lastIdentifiedAt">
                  <DebugValue>{debugTimestampLabel(counter.lastIdentifiedAt)}</DebugValue>
                </DebugRow>
                <DebugRow label="id">
                  <DebugValue>{counter.id}</DebugValue>
                </DebugRow>
              </DebugList>
            </Box>
          ))}
        </Stack>
      )}
    </DebugSection>
  )
}

const calculationContextKeys: readonly (keyof CalculationContext)[] = [
  'gameVersion',
  'masterDataVersion',
  'rngEngineVersion',
  'appSchemaVersion',
]

/**
 * The one running (`active` / `stale`) Plan and the persisted internal
 * information of its current Step.
 *
 * A Draft is never substituted here: it is not a running Plan, and the
 * Production Plan detail screen already shows it. Nothing is re-planned and no
 * prediction runs; the Step is resolved from `currentStepId` inside the stored
 * Plan body, and an unresolvable id is reported as the anomaly it is.
 */
function RunningProductionPlanSection({
  result,
}: {
  result: ReadResult<ProductionPlan | undefined>
}) {
  return (
    <DebugSection title="実行中の生産計画">
      {!result.ok ? (
        <Alert severity="error">実行中の生産計画を読み込めませんでした。</Alert>
      ) : result.value === undefined ? (
        <Typography variant="body2">実行中または続行不可の生産計画はありません。</Typography>
      ) : (
        <RunningProductionPlanDetails plan={result.value} />
      )}
    </DebugSection>
  )
}

function RunningProductionPlanDetails({ plan }: { plan: ProductionPlan }) {
  const currentStep =
    plan.currentStepId === null
      ? null
      : plan.steps.find(({ id }) => id === plan.currentStepId) ?? null
  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      <DebugList label="実行中の生産計画">
        <DebugRow label="Plan ID">
          <DebugValue>{plan.id}</DebugValue>
        </DebugRow>
        <DebugRow label="status">
          <DebugValue>
            {plan.status}（{productionPlanStatusLabels[plan.status]}）
          </DebugValue>
        </DebugRow>
        <DebugRow label="currentStepId">
          <DebugValue>{plan.currentStepId ?? debugUnsetValueLabel}</DebugValue>
        </DebugRow>
        <DebugRow label="createdAt">
          <DebugValue>{plan.createdAt}</DebugValue>
        </DebugRow>
        <DebugRow label="updatedAt">
          <DebugValue>{plan.updatedAt}</DebugValue>
        </DebugRow>
        {calculationContextKeys.map((key) => (
          <DebugRow key={key} label={`CalculationContext.${key}`}>
            <DebugValue>{String(plan.calculationContext[key])}</DebugValue>
          </DebugRow>
        ))}
      </DebugList>
      <Box>
        <Typography component="p" variant="subtitle2">
          recalculationReasons
        </Typography>
        {plan.recalculationReasons.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            記録されている再計算理由はありません。
          </Typography>
        ) : (
          // Every stored reason is listed, with its typed label and the raw
          // enum beside it. No message text is parsed to derive one.
          <Box
            component="ul"
            aria-label="再計算理由"
            sx={{ m: 0, mt: 0.25, pl: 2.5, display: 'grid', gap: 0.25 }}
          >
            {plan.recalculationReasons.map((reason, index) => (
              <Typography
                component="li"
                variant="body2"
                key={`${reason}:${index}`}
                sx={{ overflowWrap: 'anywhere' }}
              >
                {productionPlanRecalculationReasonLabels[reason]}（{reason}）
              </Typography>
            ))}
          </Box>
        )}
      </Box>
      {currentStep === null ? (
        <Alert severity="warning">currentStepIdに対応するPlanStepが見つかりません。</Alert>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            以下は現在Stepの計画生成時の値です。上の「現在のRNG状態」は現在の保存値で、意味が異なります。
          </Typography>
          <PlanStepDebugDetails
            step={currentStep}
            headingLevel="h3"
            title={`現在Step（ステップ ${currentStep.order}）のPlanStep Debug`}
            note={
              plan.status === 'stale' ? (
                <Alert severity="warning">
                  この生産計画は再計算が必要な状態です。この予測は現在状態と一致しない可能性があります。
                </Alert>
              ) : null
            }
          />
        </>
      )}
    </Stack>
  )
}

function RngEngineSection() {
  return (
    <DebugSection title="RNG Engine information">
      <List aria-label="Production RNG Engine provenance" disablePadding>
        <ListItem divider disableGutters>
          <ListItemText primary="Engine mode" secondary={productionRngRuntime.mode} slotProps={wrappingTextProps} />
        </ListItem>
        <ListItem divider disableGutters>
          <ListItemText primary="Engine version" secondary={productionRngRuntime.version} slotProps={wrappingTextProps} />
        </ListItem>
        {capabilityRows.map(([name, supported]) => (
          <ListItem key={name} divider disableGutters>
            <ListItemText primary={name} secondary={capabilityValue(supported)} slotProps={wrappingTextProps} />
          </ListItem>
        ))}
        <ListItem divider disableGutters>
          <ListItemText primary="Production Identification (Identification Wizard)" secondary={identificationAvailabilityValue()} slotProps={wrappingTextProps} />
        </ListItem>
      </List>
    </DebugSection>
  )
}

/**
 * The Master and calculation version authorities.
 *
 * `gameVersion` and `dataVersion` are the same manifest values the Settings
 * screen shows. `CURRENT_CALCULATION_APP_SCHEMA_VERSION` is the calculation
 * compatibility boundary and is a different concept from the
 * `AppSettings.schemaVersion` the Settings screen calls
 * アプリスキーマバージョン, so both are named by their internal identifiers here.
 */
function MasterVersionSection() {
  return (
    <DebugSection title="Master data / calculation versions">
      {!loadedMaster.ok && (
        <Alert severity="error" sx={{ mb: 1 }}>マスターデータを読み込めません。</Alert>
      )}
      <List aria-label="Master data and calculation versions" disablePadding>
        {loadedMaster.ok && (
          <>
            <ListItem divider disableGutters>
              <ListItemText
                primary="Master gameVersion"
                secondary={loadedMaster.data.manifest.gameVersion}
                slotProps={wrappingTextProps}
              />
            </ListItem>
            <ListItem divider disableGutters>
              <ListItemText
                primary="Master dataVersion"
                secondary={String(loadedMaster.data.manifest.dataVersion)}
                slotProps={wrappingTextProps}
              />
            </ListItem>
          </>
        )}
        <ListItem divider disableGutters>
          <ListItemText
            primary="CURRENT_CALCULATION_APP_SCHEMA_VERSION"
            secondary={String(CURRENT_CALCULATION_APP_SCHEMA_VERSION)}
            slotProps={wrappingTextProps}
          />
        </ListItem>
      </List>
    </DebugSection>
  )
}
