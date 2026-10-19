import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Alert, Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { PageShell } from '../components/PageShell'
import { PersistentReidentificationReminderAlert } from '../components/execution/PersistentReidentificationReminderAlert'
import { usePersistentReidentificationReminder } from '../components/execution/usePersistentReidentificationReminder'
import { StatusChip, type StatusTone } from '../components/StatusChip'
import {
  createDashboardSummary,
  type DashboardCapability,
  type DashboardNextAction,
  type DashboardRngItemKey,
  type DashboardSnapshot,
  type DashboardSummary,
  type KnownValueStatus,
} from '../components/dashboard/dashboardSummary'
import { loadMasterData } from '../domain/master/loadMasterData'
import type { MasterDataRoot } from '../domain/master/masterTypes'
import { productionRngEngine } from '../domain/rng/production/productionRngRuntime'
import { PRODUCTION_RNG_ENGINE_VERSION } from '../domain/rng/production/productionRngEngine'
import {
  buildListEntryRepository,
  normalArtianCounterRepository,
  ownedWeaponRepository,
  productionPlanRepository,
  rngStateRepository,
  targetWeaponRepository,
} from '../db/repositories'
import { getRngMissingRequirementLabel } from '../presentation/labels'
import { createBuildListCalculationContext } from '../services/buildList/createBuildListCalculationContext'
import {
  loadPersistentReidentificationReminder,
  type PersistentReidentificationReminder,
} from '../services/execution/persistentReidentificationReminderService'
import { createPlannerCalculationContext } from '../services/planner/createPlannerInput'

const loadedMaster = loadMasterData()
const defaultMaster = loadedMaster.ok ? loadedMaster.data : null

export interface DashboardPageDependencies {
  master: MasterDataRoot
  /** Read-only: never creates the initial RngState. */
  getRngState(): Promise<DashboardSnapshot['rngState'] | undefined>
  /**
   * The persistent re-identification reminder over every Plan
   * (`docs/PLANNER_SPEC.md` 16.15). Read-only, derived on every load; a failed
   * read is shown as such, never as "nothing to re-identify".
   */
  getReidentificationReminder(): Promise<PersistentReidentificationReminder>
  getNormalCounters(): Promise<DashboardSnapshot['normalCounters']>
  getOwnedWeapons(): Promise<DashboardSnapshot['ownedWeapons']>
  getTargetWeapons(): Promise<DashboardSnapshot['targetWeapons']>
  getBuildListEntries(): Promise<DashboardSnapshot['buildListEntries']>
  /** The unique Active Plan authority; never inferred from other Plans. */
  getActivePlan(): Promise<DashboardSnapshot['activePlan'] | undefined>
}

const defaultDependencies: DashboardPageDependencies | null = defaultMaster
  ? {
      master: defaultMaster,
      getRngState: () => rngStateRepository.getCurrentRngState(),
      getNormalCounters: () => normalArtianCounterRepository.getAllNormalArtianCounters(),
      getOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
      getTargetWeapons: () => targetWeaponRepository.getAllTargetWeapons(),
      getBuildListEntries: () => buildListEntryRepository.getAllBuildListEntries(),
      getActivePlan: () => productionPlanRepository.getActiveProductionPlan(),
      getReidentificationReminder: () => loadPersistentReidentificationReminder(),
    }
  : null

const rngItemLabels: Record<DashboardRngItemKey, string> = {
  baseSeed: 'Base Seed（基準シード）',
  gogmaCounter: '巨戟カウンター',
  skillCounter: 'スキルカウンター',
}

const knownValueStatusChips: Record<KnownValueStatus, { label: string; tone: StatusTone }> = {
  confirmed: { label: '確定', tone: 'positive' },
  needs_confirmation: { label: '要確認', tone: 'caution' },
  unset: { label: '未設定', tone: 'neutral' },
}

interface NextActionPresentation {
  title: string
  description: string
  primary: { label: string; to: string }
  secondary?: { label: string; to: string }
}

function presentNextAction(
  action: DashboardNextAction,
  summary: DashboardSummary,
): NextActionPresentation {
  switch (action.kind) {
    case 'resume_execution':
      return {
        title: '実行中の作成プランがあります',
        description: '実行ナビから、作成プランの操作を1つずつ進めます。',
        primary: { label: '実行ナビを再開する', to: `/plans/${action.planId}/run` },
        secondary: { label: '作成プランを見る', to: `/plans/${action.planId}` },
      }
    case 'review_incompatible_plan':
      return {
        title: '実行中の作成プランは再計算が必要です',
        description:
          'この作成プランは現在の計算契約と互換性がないため、そのまま実行できません。作成プランを確認し、ビルドリストから再計算してください。',
        primary: { label: '作成プランを見る', to: `/plans/${action.planId}` },
        secondary: { label: 'ビルドリストで再計算する', to: '/build-list' },
      }
    case 'setup_rng':
      return {
        title: 'RNG状態を設定してください',
        description:
          '巨戟アーティア予測とスキル予測のどちらも、現在のRNG状態では利用できません。',
        primary: { label: 'RNGを設定する', to: '/rng' },
      }
    case 'register_target':
      return {
        title: '目標武器を登録してください',
        description:
          summary.targetWeapons.total === 0
            ? '候補検索の対象になる目標武器がまだありません。'
            : '検索対象がONの目標武器がありません。',
        primary: { label: '目標武器を登録する', to: '/target-weapons' },
      }
    case 'start_search':
      return {
        title: '候補検索を開始してください',
        description: 'ビルドリストは空です。候補検索の結果からビルドリストへ候補を追加します。',
        primary: { label: '候補検索を開始する', to: '/search' },
      }
    case 'search_again_for_stale_build_list':
      return {
        title: 'ビルドリストの候補は再検索が必要です',
        description: `ビルドリストの候補${summary.buildList.total}件はすべて再検索が必要です。候補検索をやり直してください。理由はビルドリストで確認できます。`,
        primary: { label: '候補検索を開始する', to: '/search' },
        secondary: { label: 'ビルドリストを開く', to: '/build-list' },
      }
    case 'review_build_list':
      // Only facts the Dashboard knows are stated here. Whether the Planner
      // can use an Entry is decided on the Build List by the Planner's own
      // validation, so no "a Plan can be created" claim is made.
      return {
        title: 'ビルドリストを確認してください',
        description:
          summary.buildList.stale > 0
            ? `ビルドリストの候補${summary.buildList.total}件のうち、${summary.buildList.stale}件は再検索が必要です。`
            : `ビルドリストに候補が${summary.buildList.total}件あります。`,
        primary: { label: 'ビルドリストを開く', to: '/build-list' },
        secondary: { label: '候補検索を開始する', to: '/search' },
      }
  }
}

/** A titled, border-based dashboard section. */
function SectionCard({ title, children }: { title: string; children: ReactNode }) {
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

/** One label / status row inside a definition list. */
function StatusRow({
  label,
  status,
  children,
}: {
  label: string
  status: { label: string; tone: StatusTone }
  children?: ReactNode
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        columnGap: 1.5,
        alignItems: 'center',
        py: 1,
        borderTop: 1,
        borderColor: 'divider',
        '&:first-of-type': { borderTop: 0, pt: 0 },
      }}
    >
      <Typography component="dt" variant="body2" sx={{ fontWeight: 500, minWidth: 0 }}>
        {label}
      </Typography>
      <Box component="dd" sx={{ m: 0 }}>
        <StatusChip label={status.label} tone={status.tone} />
      </Box>
      {children && (
        <Box component="dd" sx={{ m: 0, gridColumn: '1 / -1', mt: 0.5 }}>
          {children}
        </Box>
      )}
    </Box>
  )
}

function CapabilityRow({ label, capability, extra }: {
  label: string
  capability: DashboardCapability
  extra?: string[]
}) {
  const messages = capability.available
    ? []
    : [...capability.missingRequirements.map(getRngMissingRequirementLabel), ...(extra ?? [])]
  return (
    <StatusRow
      label={label}
      status={capability.available
        ? { label: '利用可能', tone: 'positive' }
        : { label: '利用不可', tone: 'caution' }}
    >
      {messages.length > 0 && (
        <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
          {messages.map((message) => (
            <Typography component="li" variant="body2" color="text.secondary" key={message}>
              {message}
            </Typography>
          ))}
        </Stack>
      )}
    </StatusRow>
  )
}

function StatTile({ label, children, note, sx }: {
  label: string
  children: ReactNode
  note?: ReactNode
  sx?: object
}) {
  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        ...sx,
      }}
    >
      <Typography component="h3" variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      <Box className="tabular-nums">{children}</Box>
      {note && (
        <Typography variant="caption" color="text.secondary" component="div">
          {note}
        </Typography>
      )}
    </Box>
  )
}

function StatValue({ children }: { children: ReactNode }) {
  return (
    <Typography component="p" sx={{ fontSize: '1.375rem', fontWeight: 600, lineHeight: 1.3 }}>
      {children}
    </Typography>
  )
}

const actionButtonSx = { justifyContent: 'flex-start', minHeight: 44, textAlign: 'left' } as const

function ActionLink({ label, to }: { label: string; to: string }) {
  return (
    <Button component={RouterLink} to={to} variant="outlined" fullWidth sx={actionButtonSx}>
      {label}
    </Button>
  )
}

function DashboardContent({ summary }: { summary: DashboardSummary }) {
  const next = presentNextAction(summary.nextAction, summary)
  const nextHeadingId = useId()
  const hasNeedsConfirmation = summary.rngItems.some(
    ({ status }) => status === 'needs_confirmation',
  )
  const activePlan = summary.activePlan

  return (
    <Stack spacing={{ xs: 2, md: 3 }}>
      <Paper
        component="section"
        variant="outlined"
        aria-labelledby={nextHeadingId}
        sx={{
          p: { xs: 2, md: 2.5 },
          borderLeftWidth: 4,
          borderLeftColor: 'primary.main',
        }}
      >
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={{ xs: 1.5, md: 3 }}
          sx={{ alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}
        >
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Typography id={nextHeadingId} component="h2" variant="subtitle2" color="primary">
              次の操作
            </Typography>
            <Typography component="p" variant="h2">
              {next.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {next.description}
            </Typography>
          </Stack>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ flexShrink: 0 }}
          >
            <Button
              component={RouterLink}
              to={next.primary.to}
              variant="contained"
              sx={{ minHeight: 44 }}
            >
              {next.primary.label}
            </Button>
            {next.secondary && (
              <Button
                component={RouterLink}
                to={next.secondary.to}
                variant="outlined"
                sx={{ minHeight: 44 }}
              >
                {next.secondary.label}
              </Button>
            )}
          </Stack>
        </Stack>
      </Paper>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          gap: { xs: 2, md: 3 },
          alignItems: 'start',
        }}
      >
        <SectionCard title="RNG状態">
          <Box component="dl" sx={{ m: 0 }}>
            {summary.rngItems.map((item) => (
              <StatusRow
                key={item.key}
                label={rngItemLabels[item.key]}
                status={knownValueStatusChips[item.status]}
              />
            ))}
          </Box>
          {hasNeedsConfirmation && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              要確認: 値は入力済みですが、検索・予測に使用する設定になっていません。
            </Typography>
          )}
        </SectionCard>

        <SectionCard title="利用可能な機能">
          <Box component="dl" sx={{ m: 0 }}>
            <CapabilityRow label="巨戟アーティア予測" capability={summary.gogmaPrediction} />
            <CapabilityRow label="スキル予測" capability={summary.skillPrediction} />
            <CapabilityRow
              label="通常アーティア検索"
              capability={summary.normalArtianSearch}
              extra={summary.normalArtianSearch.hasConfirmedNormalCounter
                ? []
                : ['検索に使用できる通常アーティアカウンターがありません']}
            />
            <StatusRow label="生産計画（Planner）" status={{ label: '作成ルート依存', tone: 'info' }}>
              <Typography variant="body2" color="text.secondary">
                必要な確定値は、ビルドリスト内の候補の作成ルートにより異なります。
              </Typography>
            </StatusRow>
          </Box>
        </SectionCard>
      </Box>

      <SectionCard title="現在のデータ">
        <Box
          component="ul"
          sx={{
            m: 0,
            p: 0,
            display: 'grid',
            gridTemplateColumns: {
              xs: 'repeat(2, minmax(0, 1fr))',
              md: 'repeat(3, minmax(0, 1fr))',
              lg: 'repeat(5, minmax(0, 1fr))',
            },
            gap: 1.5,
          }}
        >
          <StatTile label="通常アーティアカウンター" note="確定済みの武器種数">
            <StatValue>
              {summary.normalCounters.confirmed} / {summary.normalCounters.total}
            </StatValue>
          </StatTile>
          <StatTile label="所持アーティア">
            <Typography component="p" sx={{ fontWeight: 600 }}>
              通常 {summary.ownedWeapons.normal}本
            </Typography>
            <Typography component="p" sx={{ fontWeight: 600 }}>
              巨戟 {summary.ownedWeapons.gogma}本
            </Typography>
          </StatTile>
          <StatTile label="有効な目標武器" note={`登録済み ${summary.targetWeapons.total}件`}>
            <StatValue>{summary.targetWeapons.enabled}件</StatValue>
          </StatTile>
          <StatTile
            label="ビルドリスト候補"
            note={summary.buildList.stale > 0
              ? `うち再検索が必要 ${summary.buildList.stale}件`
              : '再検索が必要な候補はありません'}
          >
            <StatValue>{summary.buildList.total}件</StatValue>
          </StatTile>
          <StatTile
            label="実行中の作成プラン"
            sx={{ gridColumn: { xs: '1 / -1', lg: 'auto' } }}
            note={activePlan === null
              ? 'Active Planはありません'
              : activePlan.isCalculationCompatible
                ? '実行ナビから再開できます'
                : '現在の計算契約と互換性がありません'}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }} useFlexGap>
              <StatValue>{activePlan === null ? 'なし' : 'あり'}</StatValue>
              {activePlan && !activePlan.isCalculationCompatible && (
                <StatusChip label="再計算が必要" tone="caution" />
              )}
            </Stack>
          </StatTile>
        </Box>
      </SectionCard>

      <SectionCard title="主要アクション">
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: { xs: 2, md: 3 },
          }}
        >
          <Stack spacing={1}>
            <Typography component="h3" variant="subtitle2" color="text.secondary">
              準備
            </Typography>
            <ActionLink label="RNGを設定する" to="/rng" />
            <ActionLink label="通常Counterを特定する" to="/normal-counters" />
            <ActionLink label="所持武器を登録する" to="/owned-weapons" />
            <ActionLink label="目標武器を登録する" to="/target-weapons" />
          </Stack>
          <Stack spacing={1}>
            <Typography component="h3" variant="subtitle2" color="text.secondary">
              計画・実行
            </Typography>
            <ActionLink label="候補検索を開始する" to="/search" />
            <ActionLink label="生産計画一覧を見る" to="/plans" />
            {activePlan ? (
              <ActionLink label="作成プランを見る" to={`/plans/${activePlan.id}`} />
            ) : (
              <Button variant="outlined" fullWidth disabled sx={actionButtonSx}>
                作成プランを見る
              </Button>
            )}
            {activePlan?.isCalculationCompatible ? (
              <ActionLink label="実行ナビを再開する" to={`/plans/${activePlan.id}/run`} />
            ) : (
              <Button variant="outlined" fullWidth disabled sx={actionButtonSx}>
                実行ナビを再開する
              </Button>
            )}
            {!activePlan?.isCalculationCompatible && (
              <Typography variant="body2" color="text.secondary">
                {activePlan === null
                  ? '作成プランの確認と実行ナビは、実行中の作成プランがある場合に利用できます。'
                  : '実行中の作成プランは現在の計算契約と互換性がないため、実行ナビを再開できません。'}
              </Typography>
            )}
          </Stack>
        </Box>
      </SectionCard>
    </Stack>
  )
}

type DashboardLoadState =
  | { status: 'loading' }
  | { status: 'ready'; summary: DashboardSummary }
  | { status: 'error'; message: string }

export function DashboardPage({
  dependencies = defaultDependencies ?? undefined,
}: { dependencies?: DashboardPageDependencies }) {
  const [state, setState] = useState<DashboardLoadState>(
    dependencies
      ? { status: 'loading' }
      : { status: 'error', message: 'マスターデータを読み込めません。' },
  )
  // Loaded beside the summary, not inside it: the reminder changes no
  // DashboardSummary value and no next action (16.15 asks for a display).
  const loadReminder = useMemo(
    () => (dependencies ? () => dependencies.getReidentificationReminder() : undefined),
    [dependencies],
  )
  const reminder = usePersistentReidentificationReminder(loadReminder)

  useEffect(() => {
    if (!dependencies) return
    let active = true
    void Promise.all([
      dependencies.getRngState(),
      dependencies.getNormalCounters(),
      dependencies.getOwnedWeapons(),
      dependencies.getTargetWeapons(),
      dependencies.getBuildListEntries(),
      dependencies.getActivePlan(),
    ])
      .then(([rngState, normalCounters, ownedWeapons, targetWeapons, buildListEntries, activePlan]) => {
        if (!active) return
        const summary = createDashboardSummary(
          {
            rngState: rngState ?? null,
            normalCounters,
            ownedWeapons,
            targetWeapons,
            buildListEntries,
            activePlan: activePlan ?? null,
          },
          {
            master: dependencies.master,
            engineCapabilities: productionRngEngine.capabilities,
            buildListCalculationContext: createBuildListCalculationContext(dependencies.master),
            planCalculationContext: createPlannerCalculationContext(
              dependencies.master,
              PRODUCTION_RNG_ENGINE_VERSION,
            ),
          },
        )
        setState({ status: 'ready', summary })
      })
      .catch((caught: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: caught instanceof Error ? caught.message : 'ダッシュボードを読み込めません。',
          })
        }
      })
    return () => {
      active = false
    }
  }, [dependencies])

  return (
    <PageShell title="ダッシュボード" description="準備状況を確認し、次に行う操作へ進みます。">
      {dependencies && (
        <PersistentReidentificationReminderAlert state={reminder.state} master={dependencies.master} surface="dashboard" />
      )}
      {state.status === 'loading' && <LinearProgress aria-label="ダッシュボードを読み込み中" />}
      {state.status === 'error' && <Alert severity="error">{state.message}</Alert>}
      {state.status === 'ready' && <DashboardContent summary={state.summary} />}
    </PageShell>
  )
}
