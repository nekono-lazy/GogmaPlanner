import { isTargetWeaponPlanningEligible, targetCompletionConditionNeedsReview } from '../domain/models/domainRules'
import { COMPLETION_CONDITION_REVIEW_CHIP_LABEL } from '../components/target/completionConditionPresentation'
import { CURRENT_CALCULATION_APP_SCHEMA_VERSION } from '../domain/models/publicTypes'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { DisclosureAccordion } from '../components/DisclosureAccordion'
import { PageShell } from '../components/PageShell'
import { PersistentReidentificationReminderAlert } from '../components/execution/PersistentReidentificationReminderAlert'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import { RunningPlanReplanProposalNotice } from '../components/execution/RunningPlanReplanProposalNotice'
import { RUNNING_PLAN_REPLAN_UNNAMED_TARGET } from '../components/execution/runningPlanReplanGuidancePresentation'
import {
  runningPlanReplanExclusionRequest,
  runningPlanReplanInclusionRequest,
  runningPlanReplanNavigationState,
  type RunningPlanReplanOpenRequest,
} from '../components/execution/runningPlanReplanRequest'
import { usePersistentReidentificationReminder } from '../components/execution/usePersistentReidentificationReminder'
import {
  usePlanBreakingChangeApproval,
  type PlanBreakingReplanExclusionRequest,
} from '../components/execution/usePlanBreakingChangeApproval'
import type { ReplanProposalBuildListChange } from '../domain/execution'
import { OwnedIdealCompletionDialog } from '../components/target/OwnedIdealCompletionDialog'
import { OwnedIdealWeaponNotice } from '../components/target/OwnedIdealWeaponNotice'
import { useOwnedIdealCompletion, type OwnedIdealCompletionApi } from '../components/target/useOwnedIdealCompletion'
import { StatusChip } from '../components/StatusChip'
import { CandidateCard } from '../components/search/CandidateCard'
import {
  BatchCandidateResearchSummaryPanel,
  BatchCandidateSearchProgressPanel,
  BatchCandidateSearchSummaryPanel,
} from '../components/search/BatchCandidateSearchPanels'
import { BatchCandidateResearchDialog } from '../components/search/BatchStaleCandidateReplacementDialog'
import { BatchCandidateResearchExclusionDisclosure } from '../components/search/BatchStaleCandidateReplacementExclusionDisclosure'
import {
  BATCH_RESEARCH_CANCEL_LABEL,
  BATCH_RESEARCH_DESCRIPTION,
  BATCH_RESEARCH_NONE_NOTE,
  BATCH_RESEARCH_PROGRESS_TITLE,
  batchResearchButtonLabel,
  batchResearchCountsNote,
  batchResearchExcludedDisclosureTitle,
  batchResearchExcludedOnlyNote,
} from '../components/search/batchStaleCandidateReplacementPresentation'
import {
  useBatchCandidateResearch,
  type BatchCandidateResearchApi,
  type BatchCandidateResearchRunContext,
} from '../components/search/useBatchStaleCandidateReplacement'
import { BuildListReplacementDialog } from '../components/search/BuildListReplacementDialog'
import {
  BUILD_LIST_CHECK_LINK_LABEL,
  BUILD_LIST_LEGACY_DUPLICATE_LINK_LABEL,
  BUILD_LIST_LEGACY_DUPLICATE_MESSAGE,
  BUILD_LIST_REPLACED_MESSAGE,
  BUILD_LIST_REPLACED_PLAN_ABANDONED_MESSAGE,
} from '../components/search/buildListReplacementPresentation'
import {
  useBuildListCandidateReplacement,
  type BuildListCandidateReplacementApi,
} from '../components/search/useBuildListCandidateReplacement'
import { MasterDataStatusAlert } from '../components/MasterDataStatusAlert'
import { loadMasterData } from '../domain/master/loadMasterData'
import type { MasterDataRoot } from '../domain/master/masterTypes'
import type {
  BuildCandidate,
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  CandidateSearchDefaults,
  OwnedGogmaArtianWeapon,
  OwnedWeapon,
  ProductionPlanId,
  TargetWeapon,
  TargetWeaponId,
} from '../domain/models/publicTypes'
import { findOwnedIdealWeaponsForTarget } from '../domain/target'
import type {
  CandidateRouteFilter,
  CandidateSearchNoticeSeverity,
  CandidateSearchProgress,
  CandidateSearchResult,
  CandidateSearchSettings,
} from '../domain/search'
import { defaultCandidateSearchSettings } from '../domain/search'
import {
  findBuildListRegisteredTargetIds,
  isSameBuildListCandidate,
} from '../domain/buildList'
import {
  buildCandidateRepository,
  buildListEntryRepository,
  ownedWeaponRepository,
  targetWeaponRepository,
} from '../db/repositories'
import { settingsRepository } from '../db/settingsRepository'
import { useSettingsStore } from '../stores/settingsStore'
import { candidateSearchLimitFields } from '../components/search/candidateSearchLimitPresentation'
import {
  buildListService,
  type AddBuildListCandidateResult,
} from '../services/buildList/buildListService'
import { createBuildListCalculationContext } from '../services/buildList/createBuildListCalculationContext'
import {
  createBuildListResearchSelectionReader,
  type BatchCandidateResearchSummary,
} from '../services/search/batchStaleCandidateReplacement'
import {
  TargetWeaponLifecycleService,
  type TargetOwnedIdealCompletion,
} from '../services/crud/targetWeaponLifecycleService'
import {
  loadPersistentReidentificationReminder,
  type PersistentReidentificationReminder,
} from '../services/execution/persistentReidentificationReminderService'
import {
  createRunningPlanReplanGuidanceReader,
  type RunningPlanReplanGuidanceReader,
} from '../services/execution/runningPlanReplanGuidanceService'
import {
  runBatchCandidateSearch,
  selectBatchCandidateSearchTargets,
  type BatchCandidateSearchProgress,
  type BatchCandidateSearchRun,
  type BatchCandidateSearchSummary,
} from '../services/search/batchCandidateSearch'
import {
  prepareCandidateSearchInput,
  preparedCandidateSearchInputIssue,
  type CandidateSearchSourceExclusionSnapshot,
  type PrepareCandidateSearchInputOptions,
  type PreparedCandidateSearchInput,
} from '../services/search/prepareCandidateSearchInput'
import {
  SourceExclusionConditionCheckbox,
  SourceExclusionResultAlert,
} from '../components/search/SearchSourceExclusion'
import {
  createSearchSourceExclusionDisplay,
  SOURCE_EXCLUSION_NOTHING_EXCLUDED_NOTE,
  sourceExclusionConditionLabel,
  sourceExclusionNotFoundNote,
} from '../components/search/sourceExclusionPresentation'
import {
  createProductionSearchWorkerClient,
  SearchCancelledError,
  type SearchWorkerClient,
} from '../services/search/searchWorkerClient'
import {
  candidateSearchNoticeSeverityLabels,
  candidateSearchProgressPhaseLabels,
  routeKindLabels,
  skippedRouteReasonLabels,
} from '../presentation/labels'
import { sortByRegistrationOrder } from '../presentation/managementListOrder'

const loadedMaster = loadMasterData()
const defaultMaster = loadedMaster.ok ? loadedMaster.data : null
const defaultLifecycleService = defaultMaster ? new TargetWeaponLifecycleService(defaultMaster) : null

/** Notices are rendered info-first, so the successful-search case reads first. */
const noticeSeverities: readonly CandidateSearchNoticeSeverity[] = ['info', 'warning']

function createSearchRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `search-${Date.now()}`
}

export interface SearchPageDependencies extends OwnedIdealCompletionApi, BuildListCandidateReplacementApi, BatchCandidateResearchApi {
  master: MasterDataRoot
  getTargets(): Promise<TargetWeapon[]>
  getOwnedWeapons(): Promise<OwnedWeapon[]>
  /**
   * Read-only Build List entries, used only to show whether an equivalent
   * Candidate is already added (`docs/UI_FLOW.md` 9 「作成リスト追加状態」).
   */
  getBuildListEntries(): Promise<BuildListEntry[]>
  /**
   * The persistent re-identification reminder over every Plan
   * (`docs/PLANNER_SPEC.md` 16.15): a warning above the search conditions,
   * never a gate on the search. Read-only.
   */
  getReidentificationReminder(): Promise<PersistentReidentificationReminder>
  /**
   * The user's saved Candidate Search defaults (`docs/UI_FLOW.md` 9 / 14): the
   * starting values of this screen's search bounds. Read-only - a change made
   * on this screen applies to this screen's searches only and is never saved.
   */
  getCandidateSearchDefaults(): Promise<CandidateSearchDefaults>
  createWorkerClient(): SearchWorkerClient
  /**
   * One Candidate Search input, built from the persisted state when the search
   * (or a batch Target's search) starts, with 「他の目標武器で使用する所持武器を
   * 除外する」 on or off (`prepareCandidateSearchInput()`, `docs/SEARCH_SPEC.md`
   * 3.3). With it on, the derived exclusion and the records it names come back
   * beside the input, from the same read.
   */
  prepareInput(options: PrepareCandidateSearchInputOptions): Promise<PreparedCandidateSearchInput>
  saveCandidates(targetId: TargetWeapon['id'], candidates: BuildCandidate[]): Promise<unknown>
  /**
   * 「作成リストに追加」 (`docs/DATA_MODEL.md` 9.4.1): only `added` wrote
   * anything. `replacement_required` opens the replacement confirmation, whose
   * confirmed save is `replaceCandidate()` after `inspectCandidateReplacement()`
   * (`BuildListCandidateReplacementApi`); `legacy_duplicate` asks the user to
   * tidy the Build List and never picks an Entry. The new Entry carries no
   * intermediate state selection (Issue #100).
   */
  addCandidate(candidate: BuildCandidate, target: TargetWeapon): Promise<AddBuildListCandidateResult>
  /**
   * The read-only running Plan replan guidance (`docs/PLANNER_SPEC.md` 18.3,
   * Issue #276 PR-6B): the proposal after an addition, a replacement or a
   * batch, and whether the breaking-change warning may offer to exclude the
   * Target in a replan. It never writes and never starts a replan.
   */
  replanGuidance: RunningPlanReplanGuidanceReader
}

const defaultDependencies: SearchPageDependencies | null = defaultMaster && defaultLifecycleService
  ? {
      master: defaultMaster,
      // 「この武器で目標を完了にする」 from the owned Ideal notice (`docs/UI_FLOW.md` 8.2).
      inspectCompleteWithOwnedIdeal: (targetId, weaponId) =>
        defaultLifecycleService.inspectCompleteWithOwnedIdeal(targetId, weaponId),
      completeWithOwnedIdeal: (targetId, weaponId, approval) =>
        defaultLifecycleService.completeWithOwnedIdeal(targetId, weaponId, undefined, approval ?? null),
      getTargets: () => targetWeaponRepository.getAllTargetWeapons(),
      getOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
      getBuildListEntries: () => buildListEntryRepository.getAllBuildListEntries(),
      getReidentificationReminder: () => loadPersistentReidentificationReminder(),
      getCandidateSearchDefaults: () =>
        settingsRepository.ensureSettings().then((settings) => settings.candidateSearchDefaults),
      createWorkerClient: createProductionSearchWorkerClient,
      prepareInput: (options) => prepareCandidateSearchInput(options),
      saveCandidates: (targetId, candidates) =>
        buildCandidateRepository.replaceBuildCandidatesForTarget(targetId, candidates),
      // The Service result is passed through unchanged: the Build List
      // cardinality and duplicate decisions stay its authority.
      addCandidate: (candidate, target) => buildListService.addCandidate(candidate, target),
      inspectCandidateReplacement: (request) => buildListService.inspectCandidateReplacement(request),
      replaceCandidate: (request, approval) => buildListService.replaceCandidate(request, approval ?? null),
      // 「再検索が必要な候補を一括再検索・置換」 (`docs/UI_FLOW.md` 9.3): the
      // selection is the Domain's over one read, and the replacement never
      // carries an approval - a breaking one is refused and the Entry kept.
      readResearchSelection: () => createBuildListResearchSelectionReader(defaultMaster).read(),
      replaceStaleCandidate: (request) =>
        buildListService.replaceStaleCandidate(request, createBuildListCalculationContext(defaultMaster)),
      replanGuidance: createRunningPlanReplanGuidanceReader(),
    }
  : null

interface SearchPageProps {
  dependencies?: SearchPageDependencies
}

/**
 * Feedback about the last Build List addition or replacement, shown beside the
 * Candidate. `buildListLinkLabel` offers the Build List, where a legacy duplicate is
 * tidied or a changed Entry is checked.
 */
interface AddFeedback {
  severity: 'info' | 'warning' | 'error'
  message: string
  buildListLinkLabel?: string
}

/**
 * The replan proposal of the last Build List save on this screen (`docs/UI_FLOW.md`
 * 9 / 16.5, `docs/PLANNER_SPEC.md` 18.3, Issue #276 PR-6B): the Domain's
 * `propose` answer and where it belongs - the single Candidate's add area or the
 * batch summary. Screen memory only: dismissed, replaced by the next operation,
 * and gone when the screen is left or reloaded; nothing is persisted.
 */
interface SearchReplanProposal {
  source: 'single' | 'batch'
  planId: ProductionPlanId
  targetWeaponIds: readonly TargetWeaponId[]
}

/** The Build List read before an operation started (null when it could not be read: that operation proposes nothing). */
type BuildListBefore = readonly Pick<BuildListEntry, 'id'>[] | null

/**
 * A finished single search as the screen shows it: the Worker result together
 * with the exclusion condition it ran with and the derivation recorded when its
 * input was prepared (`docs/UI_FLOW.md` 9.2). The three are fixed when the
 * search starts and land together, so a later Checkbox change, a later search
 * or a later read never relabels a result already shown.
 */
interface DisplayedSearchResult {
  result: CandidateSearchResult
  excludeOtherTargetSources: boolean
  sourceExclusion: CandidateSearchSourceExclusionSnapshot | null
}

/**
 * The Targets the Select offers (`docs/UI_FLOW.md` 9): eligible ones only
 * (enabled, not completed - 8.2), in registration order like the Target
 * Weapons list (3.2). The first one is the default selection. Display order
 * only: the batch keeps its own Target order.
 */
function selectableSearchTargets(targets: readonly TargetWeapon[]): TargetWeapon[] {
  return sortByRegistrationOrder(targets.filter(isTargetWeaponPlanningEligible))
}

/**
 * Enabled, active Targets whose completion condition still needs the user's
 * review (`docs/UI_FLOW.md` 8.4 / 9): shown in the Select as options that
 * cannot be chosen, with the reason, so their absence from the search is
 * explained. The judgement is the Domain's `isTargetWeaponPlanningEligible()`.
 */
function reviewRequiredSearchTargets(targets: readonly TargetWeapon[]): TargetWeapon[] {
  return sortByRegistrationOrder(
    targets.filter((target) =>
      target.isEnabled &&
      target.lifecycleStatus === 'active' &&
      targetCompletionConditionNeedsReview(target)),
  )
}

/** A Target's name with 「登録済み」 when the Build List already holds its Entry. */
function TargetOptionLabel({ name, registered }: { name: string; registered: boolean }) {
  return (
    <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, width: '100%' }}>
      <Box component="span" sx={{ minWidth: 0, flex: '1 1 auto', overflowWrap: 'anywhere' }}>
        {name}
      </Box>
      {registered && (
        <Box component="span" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
          <StatusChip label="登録済み" tone="info" component="span" />
        </Box>
      )}
    </Box>
  )
}

export function SearchPage({ dependencies = defaultDependencies ?? undefined }: SearchPageProps) {
  const debugMode = useSettingsStore((state) => state.debugMode)
  const conditionsHeadingId = useId()
  const progressHeadingId = useId()
  const resultHeadingId = useId()
  const [targets, setTargets] = useState<TargetWeapon[]>([])
  const [ownedWeapons, setOwnedWeapons] = useState<OwnedWeapon[]>([])
  // Read-only mirror of the Build List, kept only to show the add state of
  // the displayed Candidate.
  const [buildListEntries, setBuildListEntries] = useState<BuildListEntry[]>([])
  const [targetWeaponId, setTargetWeaponId] = useState<TargetWeapon['id'] | ''>('')
  const [routeFilter, setRouteFilter] = useState<CandidateRouteFilter>('all')
  // This screen's search bounds: they start from the saved AppSettings
  // defaults once loaded (the recommendation until then, and when the read
  // fails), and an edit here applies to this screen's single and batch
  // searches only - it is never written back (`docs/UI_FLOW.md` 9).
  const [settings, setSettings] = useState<CandidateSearchSettings>({ ...defaultCandidateSearchSettings })
  const [defaultsLoadFailed, setDefaultsLoadFailed] = useState(false)
  // 「他の目標武器で使用する所持武器を除外する」 (`docs/UI_FLOW.md` 9.2): the
  // single search's condition only, independent of every other condition,
  // starting OFF on every visit and never persisted. The single search reads
  // it once, when it starts; the batch never reads it (Issue #290).
  const [singleExcludeOtherTargetSources, setSingleExcludeOtherTargetSources] = useState(false)
  // The condition of the single search running now, for its progress display.
  const [searchingExcludeOtherTargetSources, setSearchingExcludeOtherTargetSources] = useState(false)
  const [result, setResult] = useState<DisplayedSearchResult | null>(null)
  // Read once on mount from the persisted provenance; a search changes no
  // provenance, so the reminder stays whatever the search returns (16.15).
  const loadReminder = useMemo(
    () => (dependencies ? () => dependencies.getReidentificationReminder() : undefined),
    [dependencies],
  )
  const reminder = usePersistentReidentificationReminder(loadReminder)
  const [progress, setProgress] = useState<CandidateSearchProgress | null>(null)
  const [loading, setLoading] = useState(dependencies !== undefined)
  const [searching, setSearching] = useState(false)
  // The three failure sources stay separate so a load failure is never read as
  // "no Targets", and a search or Build List failure stays next to its action.
  const [loadError, setLoadError] = useState<string | null>(
    dependencies ? null : 'マスターデータを読み込めません。',
  )
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchNotice, setSearchNotice] = useState<string | null>(null)
  const [addFeedback, setAddFeedback] = useState<AddFeedback | null>(null)
  const clientRef = useRef<SearchWorkerClient | null>(null)
  const activeRequestRef = useRef<string | null>(null)
  // 「未登録を一括検索・追加」 (`docs/UI_FLOW.md` 9.1): one batch at a time,
  // never beside a single search. The token identifies the batch whose
  // progress and summary may still land on this screen.
  const batchRunRef = useRef<BatchCandidateSearchRun | null>(null)
  const batchTokenRef = useRef<object | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchCancelling, setBatchCancelling] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BatchCandidateSearchProgress | null>(null)
  const [batchSummary, setBatchSummary] = useState<BatchCandidateSearchSummary | null>(null)
  const navigate = useNavigate()
  const replanGuidance = dependencies?.replanGuidance
  // The owned Ideal notice and 「この武器で目標を完了にする」 (`docs/UI_FLOW.md` 8.2):
  // a preferred path beside the search, never a gate on it. The warning may
  // offer to exclude a Plan-dependent Target in a replan instead (Issue #276
  // PR-6B); its judgement, approval and save are the guard's as before.
  const planGuard = usePlanBreakingChangeApproval({
    replanExclusion: replanGuidance === undefined
      ? undefined
      : (planId, targetWeaponId) => replanGuidance.canExcludeInReplan(planId, targetWeaponId),
  })
  // The replan proposal after a Build List save on this screen (18.3). A newer
  // operation, search or batch drops it, and a late answer for an older one
  // never lands (the sequence).
  const [replanProposal, setReplanProposal] = useState<SearchReplanProposal | null>(null)
  const proposalSequenceRef = useRef(0)
  const clearReplanProposal = useCallback(() => {
    proposalSequenceRef.current += 1
    setReplanProposal(null)
  }, [])
  /** The Build List right before an operation starts, as persisted; null on a read failure (that operation then proposes nothing). */
  const readBuildListBefore = useCallback(async (): Promise<BuildListBefore> => {
    if (replanGuidance === undefined) return null
    try {
      return (await replanGuidance.readBuildListEntryIds()).map((id) => ({ id }))
    } catch {
      return null
    }
  }, [replanGuidance])
  /**
   * Asks the Domain whether the save just made proposes a replan, from the
   * state persisted after it. A read failure proposes nothing (no guess).
   */
  const proposeReplan = useCallback((source: SearchReplanProposal['source'], change: ReplanProposalBuildListChange, before: BuildListBefore) => {
    proposalSequenceRef.current += 1
    const sequence = proposalSequenceRef.current
    setReplanProposal(null)
    if (replanGuidance === undefined || before === null || change.persistedBuildListEntries.length === 0) return
    void replanGuidance.proposeAfterBuildListChange(change, before).then(
      (proposal) => {
        if (proposalSequenceRef.current !== sequence || proposal.kind !== 'propose') return
        setReplanProposal({ source, planId: proposal.planId, targetWeaponIds: proposal.targetWeaponIds })
      },
      () => undefined,
    )
  }, [replanGuidance])
  /** Leaves for the Build List's replan with a runtime-only initial selection; nothing is calculated there by itself. */
  const openBuildListReplan = useCallback((request: RunningPlanReplanOpenRequest) => {
    void navigate('/build-list', { state: runningPlanReplanNavigationState(request) })
  }, [navigate])
  const openReplanExclusion = useCallback((request: PlanBreakingReplanExclusionRequest) => {
    openBuildListReplan(runningPlanReplanExclusionRequest(request.planId, request.targetWeaponId))
  }, [openBuildListReplan])
  const [completionNotice, setCompletionNotice] = useState<string | null>(null)
  const onCompletionApplied = useCallback((result: TargetOwnedIdealCompletion, planAbandoned: boolean) => {
    // A search still running was started for a Target that is now completed:
    // its result must never land, and no stale result stays operable.
    const requestId = activeRequestRef.current
    if (requestId !== null) {
      activeRequestRef.current = null
      clientRef.current?.cancelSearch(requestId)
      setSearching(false)
    }
    setProgress(null)
    setResult(null)
    setAddFeedback(null)
    clearReplanProposal()
    setSearchError(null)
    setSearchNotice(null)
    setCompletionNotice(
      planAbandoned
        ? `目標武器「${result.target.name}」を完了にし、実行中の生産計画を破棄しました。`
        : `目標武器「${result.target.name}」を完了にしました。`,
    )
    if (!dependencies) return
    // Re-read the persisted Targets and weapons: the completed Target leaves
    // the Select, and the next eligible Target (if any) is selected.
    void Promise.all([dependencies.getTargets(), dependencies.getOwnedWeapons()])
      .then(([loadedTargets, loadedWeapons]) => {
        setTargets(loadedTargets)
        setOwnedWeapons(loadedWeapons)
        setTargetWeaponId((current) => {
          const eligible = selectableSearchTargets(loadedTargets)
          return eligible.some(({ id }) => id === current) ? current : (eligible[0]?.id ?? '')
        })
      })
      .catch((caught: unknown) => {
        setLoadError(caught instanceof Error ? caught.message : '検索データの読み込みに失敗しました。')
      })
  }, [clearReplanProposal, dependencies])
  const completion = useOwnedIdealCompletion({
    api: dependencies ?? null,
    planGuard,
    targets,
    master: dependencies?.master ?? defaultMaster,
    onApplied: onCompletionApplied,
    onReplanExclusion: openReplanExclusion,
  })
  // An addition in flight: the add button waits, so one click is one decision.
  const [adding, setAdding] = useState(false)
  // Re-reads the Build List mirror after the Service refused a replacement:
  // the Entry the screen showed is no longer the Target's one Entry, so the
  // add state is taken from the persisted Build List again, never guessed.
  const reloadBuildListEntries = useCallback(() => {
    if (!dependencies) return
    void dependencies.getBuildListEntries()
      .then(setBuildListEntries)
      .catch((caught: unknown) => {
        setLoadError(caught instanceof Error ? caught.message : '作成リストの読み込みに失敗しました。')
      })
  }, [dependencies])
  // The Build List read when the add press that turned into a replacement
  // started: the replacement's "before" for its proposal (18.3).
  const replacementBeforeRef = useRef<{ targetWeaponId: TargetWeaponId; before: BuildListBefore } | null>(null)
  const onReplacementApplied = useCallback(
    (entry: BuildListEntry, replacedEntryId: BuildListEntryId, planAbandoned: boolean) => {
      // The replaced Entry leaves the mirror in the same update the new one
      // joins it, so the two are never shown side by side.
      setBuildListEntries((current) => [
        ...current.filter(({ id }) => id !== replacedEntryId && id !== entry.id),
        entry,
      ])
      setAddFeedback({
        severity: 'info',
        message: planAbandoned ? BUILD_LIST_REPLACED_PLAN_ABANDONED_MESSAGE : BUILD_LIST_REPLACED_MESSAGE,
      })
      const tracked = replacementBeforeRef.current
      replacementBeforeRef.current = null
      // A replacement of an Entry the Plan does not depend on can propose; an
      // approved breaking replacement ended the Plan, so the Domain says none.
      proposeReplan(
        'single',
        { operation: 'candidate_replacement', persistedBuildListEntries: [entry] },
        tracked !== null && tracked.targetWeaponId === entry.targetWeaponId ? tracked.before : null,
      )
    },
    [proposeReplan],
  )
  const onReplacementRefused = useCallback((message: string) => {
    replacementBeforeRef.current = null
    setAddFeedback({ severity: 'error', message, buildListLinkLabel: BUILD_LIST_CHECK_LINK_LABEL })
    reloadBuildListEntries()
  }, [reloadBuildListEntries])
  // 「作成リストの候補を置き換えますか？」 (`docs/UI_FLOW.md` 9): confirmed on its
  // own first, then saved through the same breaking-change controller.
  const replacement = useBuildListCandidateReplacement({
    api: dependencies ?? null,
    planGuard,
    onApplied: onReplacementApplied,
    onRefused: onReplacementRefused,
    onReplanExclusion: openReplanExclusion,
  })
  // 「再検索が必要な候補を一括再検索・置換」 (`docs/UI_FLOW.md` 9.3, Issue #347):
  // the 9.1 search loop over the Targets whose one Entry is stale, replacing
  // each Entry only when its re-search found a Candidate. One batch at a time,
  // never beside a single search or the 9.1 batch.
  const researchBeforeRef = useRef<Promise<BuildListBefore> | null>(null)
  const researchRunContext = useCallback((): BatchCandidateResearchRunContext | null => {
    const client = clientRef.current
    if (!dependencies || !client) return null
    return {
      loop: {
        client,
        createSearchRunId,
        // Each Target's input and exclusion are read from the persisted state
        // right before its search, so an Entry an earlier Target really
        // replaced is counted; the loop refuses an input ignoring the condition.
        prepareInput: (options) => dependencies.prepareInput(options),
        saveCandidates: (targetId, candidates) => dependencies.saveCandidates(targetId, candidates),
      },
      request: {
        // The conditions the screen shows now apply to every Target.
        routeFilter,
        settings: { ...settings },
        master: dependencies.master,
        calculationContext: {
          gameVersion: dependencies.master.manifest.gameVersion,
          masterDataVersion: dependencies.master.manifest.dataVersion,
          rngEngineVersion: client.engineVersion,
          appSchemaVersion: CURRENT_CALCULATION_APP_SCHEMA_VERSION,
        },
        // Always on, exactly like the 9.1 batch (Issue #290): a replaced
        // Entry's source is never used by a later Target of this batch.
        excludeOtherTargetSources: true,
      },
    }
  }, [dependencies, routeFilter, settings])
  const onResearchStart = useCallback((): Promise<BuildListBefore> => {
    setBatchSummary(null)
    setResult(null)
    setProgress(null)
    setAddFeedback(null)
    clearReplanProposal()
    setSearchError(null)
    setSearchNotice(null)
    // The Build List before the batch's first replacement (18.3): returned to
    // the batch, which replaces nothing before this read settled, so an Entry
    // the batch replaces is never in it (a failed read is `null` and proposes
    // nothing, as for the 9.1 batch).
    const beforeRead = readBuildListBefore()
    researchBeforeRef.current = beforeRead
    return beforeRead
  }, [clearReplanProposal, readBuildListBefore])
  const onResearchFinish = useCallback((summary: BatchCandidateResearchSummary | null, failure: string | null) => {
    if (failure) setSearchError(failure)
    // The mirror, the 登録済み labels, both batch counts and the selection
    // follow the persisted Build List.
    reloadBuildListEntries()
    const beforeRead = researchBeforeRef.current
    researchBeforeRef.current = null
    // Only the Entries the batch really replaced can propose - a cancelled or
    // aborted batch keeps the ones saved before it stopped (18.3).
    if (summary !== null && beforeRead !== null) {
      const persisted = summary.outcomes.flatMap((outcome) => (outcome.status === 'replaced' ? [outcome.entry] : []))
      const sequenceAtFinish = proposalSequenceRef.current
      void beforeRead.then((before) => {
        if (proposalSequenceRef.current === sequenceAtFinish) {
          proposeReplan('batch', { operation: 'batch_replacement', persistedBuildListEntries: persisted }, before)
        }
      })
    }
  }, [proposeReplan, reloadBuildListEntries])
  const research = useBatchCandidateResearch({
    api: dependencies ?? null,
    runContext: researchRunContext,
    blocked: searching || batchRunning || adding || replacement.pending !== null || planGuard.busy || completion.pending !== null,
    onStart: onResearchStart,
    onFinish: onResearchFinish,
  })
  const anyBatchRunning = batchRunning || research.running
  const researchTargetCount = research.selection?.targets.length ?? 0
  const researchExcludedCount = research.selection?.excluded.length ?? 0
  const { reloadSelection: reloadResearchSelection } = research

  useEffect(() => {
    if (!dependencies) {
      return
    }
    clientRef.current = dependencies.createWorkerClient()
    let active = true
    // The Build List is part of the screen's base data: the add state is a
    // formal display item, so a failure to read it is a load failure like any
    // other rather than a silent "not added".
    // The saved defaults are read beside the base data, so the conditions
    // appear already filled in. Failing to read them is reported and falls
    // back to the recommendation; it never blocks the search.
    const defaultsRead = dependencies
      .getCandidateSearchDefaults()
      .then((defaults): CandidateSearchDefaults | null => defaults)
      .catch(() => null)
    void Promise.all([
      dependencies.getTargets(),
      dependencies.getOwnedWeapons(),
      dependencies.getBuildListEntries(),
      defaultsRead,
    ])
      .then(([loadedTargets, loadedWeapons, loadedEntries, loadedDefaults]) => {
        if (!active) return
        if (loadedDefaults === null) {
          setDefaultsLoadFailed(true)
        } else {
          setSettings({
            maxNormalAdvance: loadedDefaults.maxNormalAdvance,
            maxGogmaAdvance: loadedDefaults.maxGogmaAdvance,
            maxSkillAdvance: loadedDefaults.maxSkillAdvance,
          })
        }
        setTargets(loadedTargets)
        setOwnedWeapons(loadedWeapons)
        setBuildListEntries(loadedEntries)
        setTargetWeaponId(selectableSearchTargets(loadedTargets)[0]?.id ?? '')
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(caught instanceof Error ? caught.message : '検索データの読み込みに失敗しました。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      activeRequestRef.current = null
      batchTokenRef.current = null
      batchRunRef.current?.cancel()
      batchRunRef.current = null
      clientRef.current?.dispose()
      clientRef.current = null
    }
  }, [dependencies])

  // The re-search selection follows the persisted state the screen mirrors:
  // read once the base data is loaded, and again after every change of the
  // Build List mirror, the Targets or the weapons (a save, a batch, a
  // completion). The read is the Domain's judgement, never the screen's.
  useEffect(() => {
    if (loading) return
    reloadResearchSelection()
  }, [buildListEntries, loading, ownedWeapons, reloadResearchSelection, targets])

  // Completed Targets are not offered for a new search (`docs/UI_FLOW.md` 8.2).
  const enabledTargets = useMemo(() => selectableSearchTargets(targets), [targets])
  const reviewRequiredTargets = useMemo(() => reviewRequiredSearchTargets(targets), [targets])
  const targetById = useMemo(() => new Map(targets.map((target) => [target.id, target])), [targets])
  // Registered means the Build List holds an Entry for the Target - stale and
  // legacy duplicates included - and never forbids a single re-search.
  const registeredTargetIds = useMemo(() => findBuildListRegisteredTargetIds(buildListEntries), [buildListEntries])
  const batchTargets = useMemo(
    () => selectBatchCandidateSearchTargets(targets, buildListEntries),
    [buildListEntries, targets],
  )
  const masterForDisplay = dependencies?.master ?? defaultMaster
  const selectedTarget = targetWeaponId === '' ? null : (targetById.get(targetWeaponId) ?? null)
  // Judged by the shared Domain authority from the loaded Target and weapons
  // (`docs/SEARCH_SPEC.md` 5.5.5); it runs no search and no RNG prediction. A
  // judgement failure is reported, never read as "no owned Ideal".
  const ownedIdeal = useMemo<{ weapons: OwnedGogmaArtianWeapon[]; error: string | null }>(() => {
    if (!selectedTarget || !masterForDisplay || selectedTarget.lifecycleStatus !== 'active') return { weapons: [], error: null }
    try {
      return { weapons: findOwnedIdealWeaponsForTarget(selectedTarget, ownedWeapons, masterForDisplay, targets), error: null }
    } catch (caught: unknown) {
      return { weapons: [], error: `既所持の理想武器を判定できませんでした: ${caught instanceof Error ? caught.message : String(caught)}` }
    }
  }, [masterForDisplay, ownedWeapons, selectedTarget, targets])

  const updateSetting = (key: keyof CandidateSearchSettings, raw: string) => {
    const value = Number(raw)
    setSettings((current) => ({ ...current, [key]: value }))
  }

  const startSearch = async () => {
    if (!dependencies || !clientRef.current || targetWeaponId === '' || anyBatchRunning) return
    const requestId = createSearchRunId()
    const client = clientRef.current
    // Fixed at the press: a Checkbox change while this search runs, or after
    // its result is shown, applies to the next search only.
    const excludeOtherTargetSources = singleExcludeOtherTargetSources
    activeRequestRef.current = requestId
    setSearchingExcludeOtherTargetSources(excludeOtherTargetSources)
    setSearching(true)
    setBatchSummary(null)
    research.clearSummary()
    setSearchError(null)
    setSearchNotice(null)
    setAddFeedback(null)
    // A search itself never proposes a replan; the last save's proposal goes with its result.
    clearReplanProposal()
    setResult(null)
    setProgress({
      targetWeaponId,
      phase: 'preparing',
      processedWorkItems: 0,
    })
    try {
      const calculationContext: CalculationContext = {
        gameVersion: dependencies.master.manifest.gameVersion,
        masterDataVersion: dependencies.master.manifest.dataVersion,
        rngEngineVersion: client.engineVersion,
        appSchemaVersion: CURRENT_CALCULATION_APP_SCHEMA_VERSION,
      }
      const prepared = await dependencies.prepareInput({
        searchRunId: requestId,
        targetWeaponId,
        routeFilter,
        settings,
        master: dependencies.master,
        calculationContext,
        excludeOtherTargetSources,
      })
      if (activeRequestRef.current !== requestId) return
      // An input that does not say what the condition asks for is never
      // searched as if it did (`preparedCandidateSearchInputIssue()`).
      if (preparedCandidateSearchInputIssue(prepared, excludeOtherTargetSources) !== null) {
        setSearchError('検索条件（他の目標武器で使用する所持武器の除外）を検索入力へ反映できなかったため、検索を開始しませんでした。もう一度検索してください。')
        return
      }
      const completed = await client.startSearch(prepared.input, {
        onProgress: (nextProgress) => {
          if (activeRequestRef.current === requestId) setProgress(nextProgress)
        },
      })
      if (activeRequestRef.current !== requestId) return
      await dependencies.saveCandidates(
        completed.targetResult.targetWeaponId,
        completed.targetResult.candidate === null ? [] : [completed.targetResult.candidate],
      )
      if (activeRequestRef.current !== requestId) return
      // The names and reasons stay those of the read this input was built
      // from; nothing is re-derived from a later read (`docs/UI_FLOW.md` 9.2).
      setResult({ result: completed, excludeOtherTargetSources, sourceExclusion: prepared.sourceExclusion })
    } catch (caught: unknown) {
      if (activeRequestRef.current !== requestId || caught instanceof SearchCancelledError) return
      setSearchError(caught instanceof Error ? caught.message : '検索に失敗しました。')
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null
        setSearching(false)
      }
    }
  }

  const cancelSearch = () => {
    const requestId = activeRequestRef.current
    if (!requestId) return
    activeRequestRef.current = null
    clientRef.current?.cancelSearch(requestId)
    setSearching(false)
    setSearchNotice('検索をキャンセルしました。')
  }

  const batchBlocked =
    searching || anyBatchRunning || adding || replacement.pending !== null || planGuard.busy || completion.pending !== null

  const startBatch = () => {
    if (!dependencies || !clientRef.current || batchBlocked || batchTargets.length === 0) return
    const client = clientRef.current
    const token = {}
    batchTokenRef.current = token
    setBatchRunning(true)
    setBatchCancelling(false)
    setBatchSummary(null)
    research.clearSummary()
    setBatchProgress(null)
    setResult(null)
    setProgress(null)
    setAddFeedback(null)
    clearReplanProposal()
    setSearchError(null)
    setSearchNotice(null)
    // The Build List before the batch's first addition (18.3): every addition
    // waits for this read, so an Entry the batch adds is never in it.
    const beforeRead = readBuildListBefore()
    const run = runBatchCandidateSearch(
      {
        targets: batchTargets,
        // The conditions the screen shows now apply to every Target.
        routeFilter,
        settings: { ...settings },
        master: dependencies.master,
        calculationContext: {
          gameVersion: dependencies.master.manifest.gameVersion,
          masterDataVersion: dependencies.master.manifest.dataVersion,
          rngEngineVersion: client.engineVersion,
          appSchemaVersion: CURRENT_CALCULATION_APP_SCHEMA_VERSION,
        },
        // Always on for the batch from this screen, whatever the single
        // search's Checkbox says (Issue #290, `docs/UI_FLOW.md` 9.1 / 9.2).
        excludeOtherTargetSources: true,
      },
      {
        client,
        createSearchRunId,
        // Each Target's input and exclusion are read from the persisted state
        // right before its search, so an Entry an earlier Target really added
        // is counted; the batch refuses an input that ignores the condition.
        prepareInput: (options) => dependencies.prepareInput(options),
        saveCandidates: (targetId, candidates) => dependencies.saveCandidates(targetId, candidates),
        addCandidate: async (candidate, target) => {
          await beforeRead
          return dependencies.addCandidate(candidate, target)
        },
      },
      (nextProgress) => {
        if (batchTokenRef.current === token) setBatchProgress(nextProgress)
      },
    )
    batchRunRef.current = run
    const finish = (summary: BatchCandidateSearchSummary | null, failure: string | null) => {
      if (batchTokenRef.current !== token) return
      batchTokenRef.current = null
      batchRunRef.current = null
      setBatchRunning(false)
      setBatchCancelling(false)
      setBatchProgress(null)
      setBatchSummary(summary)
      if (failure) setSearchError(failure)
      // The 登録済み labels and the batch count follow the persisted Build List.
      reloadBuildListEntries()
      // Only the Entries the batch really added can propose - a cancelled or
      // aborted batch keeps the ones saved before it stopped (18.3).
      if (summary !== null) {
        const persisted = summary.outcomes.flatMap((outcome) => (outcome.status === 'added' ? [outcome.entry] : []))
        const sequenceAtFinish = proposalSequenceRef.current
        void beforeRead.then((before) => {
          // Another operation started meanwhile: this batch's proposal no longer belongs on screen.
          if (proposalSequenceRef.current === sequenceAtFinish) {
            proposeReplan('batch', { operation: 'batch_addition', persistedBuildListEntries: persisted }, before)
          }
        })
      }
    }
    void run.promise.then(
      (summary) => finish(summary, null),
      (caught: unknown) => finish(null, caught instanceof Error ? caught.message : '一括検索に失敗しました。'),
    )
  }

  const cancelBatch = () => {
    if (!batchRunRef.current) return
    setBatchCancelling(true)
    batchRunRef.current.cancel()
  }

  const addToBuildList = async (candidate: BuildCandidate) => {
    const target = targetById.get(candidate.targetWeaponId)
    if (!dependencies || !target) {
      setAddFeedback({ severity: 'error', message: '候補に対応する目標武器が見つかりません。' })
      return
    }
    if (adding || replacement.pending !== null || planGuard.busy) return
    setAdding(true)
    setAddFeedback(null)
    clearReplanProposal()
    replacementBeforeRef.current = null
    try {
      // The Build List before this press's save, for its replan proposal (18.3).
      const before = await readBuildListBefore()
      const result = await dependencies.addCandidate(candidate, target)
      switch (result.status) {
        case 'added':
          setBuildListEntries((current) =>
            current.some(({ id }) => id === result.entry.id) ? current : [...current, result.entry],
          )
          setAddFeedback({ severity: 'info', message: 'ビルドリストへ追加しました。' })
          proposeReplan('single', { operation: 'candidate_addition', persistedBuildListEntries: [result.entry] }, before)
          return
        case 'duplicate':
          // An equivalent Candidate already in the Build List is kept as it
          // is: nothing was written (`docs/UI_FLOW.md` 9). The mirrored Entry
          // turns the Candidate's state to "added", whose permanent guidance
          // already carries the duplicate sentence, so no second copy of it is
          // shown as feedback.
          setBuildListEntries((current) =>
            current.some(({ id }) => id === result.entry.id) ? current : [...current, result.entry],
          )
          return
        case 'replacement_required':
          // Nothing was written: the user confirms the replacement first.
          replacementBeforeRef.current = { targetWeaponId: target.id, before }
          replacement.begin({
            request: {
              candidate,
              target,
              expectedExistingEntryId: result.existingEntry.id,
            },
            existingEntry: result.existingEntry,
          })
          return
        case 'legacy_duplicate':
          // Which Entry is the Target's current one is unknown, so the screen
          // neither adds nor replaces and never picks one: the user keeps one
          // in the Build List (`docs/DATA_MODEL.md` 9.4.1).
          setAddFeedback({
            severity: 'warning',
            message: BUILD_LIST_LEGACY_DUPLICATE_MESSAGE,
            buildListLinkLabel: BUILD_LIST_LEGACY_DUPLICATE_LINK_LABEL,
          })
          return
      }
    } catch (caught: unknown) {
      setAddFeedback({
        severity: 'error',
        message: caught instanceof Error ? caught.message : 'ビルドリストへの追加に失敗しました。',
      })
    } finally {
      setAdding(false)
    }
  }

  const progressTarget = progress ? targetById.get(progress.targetWeaponId) : undefined
  /** The proposal of the last save, where it belongs (the single add area or the batch summary); named, never by ID. */
  const replanProposalNotice = (source: SearchReplanProposal['source']): ReactNode => {
    if (replanProposal === null || replanProposal.source !== source) return null
    const { planId, targetWeaponIds } = replanProposal
    return (
      <RunningPlanReplanProposalNotice
        targetNames={targetWeaponIds.map((id) => targetById.get(id)?.name ?? RUNNING_PLAN_REPLAN_UNNAMED_TARGET)}
        onOpen={() => openBuildListReplan(runningPlanReplanInclusionRequest(planId, targetWeaponIds))}
        onDismiss={clearReplanProposal}
      />
    )
  }

  return (
    <PageShell title="候補検索" description="目標武器ごとに、理想品へ到達する作成ルートを検索して作成リストへ追加します。">
      <Stack spacing={{ xs: 2, md: 3 }}>
        {masterForDisplay && <MasterDataStatusAlert master={masterForDisplay} />}
        {dependencies && (
          <PersistentReidentificationReminderAlert state={reminder.state} master={dependencies.master} surface="search" />
        )}
        {loading && <LinearProgress aria-label="検索データを読み込み中" />}
        {/* A failed load shows only the failure: no synthetic data, and no
            "register a Target" empty state that would read as empty data. */}
        {loadError && <Alert severity="error">{loadError}</Alert>}
        {completionNotice && (
          <Alert severity="success" onClose={() => setCompletionNotice(null)}>
            {completionNotice}
          </Alert>
        )}
        {!loading && !loadError && enabledTargets.length === 0 && reviewRequiredTargets.length === 0 && (
          <Alert severity="info">目標武器を登録してください。</Alert>
        )}
        {!loading && !loadError && enabledTargets.length === 0 && reviewRequiredTargets.length > 0 && (
          <Alert severity="warning">
            検索できる目標武器がありません。完成条件の再設定が必要な目標武器は、目標武器画面で内容を確認して保存すると検索できるようになります。
          </Alert>
        )}
        {!loadError && enabledTargets.length > 0 && (
          <Paper
            component="section"
            variant="outlined"
            aria-labelledby={conditionsHeadingId}
            sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
          >
            <Stack spacing={2}>
              <Box>
                <Typography id={conditionsHeadingId} component="h2" variant="h2">
                  検索条件
                </Typography>
                {/* One Target per search: reconciling several Targets is the
                    Production Planner's job (`docs/UI_FLOW.md` 9). */}
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  1回の検索は目標武器1件が対象です。目標武器の完成条件（いずれかの完成ボーナス構成と完成スキル条件）を満たす作成ルートを探します。作成リストに登録済みの目標武器には「登録済み」を表示します。
                </Typography>
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
                  gap: 2,
                }}
              >
                <FormControl fullWidth sx={{ minWidth: 0 }}>
                  <InputLabel id="target-weapon-label">検索対象の目標武器</InputLabel>
                  <Select
                    labelId="target-weapon-label"
                    label="検索対象の目標武器"
                    value={targetWeaponId}
                    onChange={(event) => setTargetWeaponId(event.target.value as TargetWeapon['id'])}
                    renderValue={(value) => {
                      const target = targetById.get(value as TargetWeapon['id'])
                      return target ? <TargetOptionLabel name={target.name} registered={registeredTargetIds.has(target.id)} /> : ''
                    }}
                    // A long Target name wraps inside the control instead of
                    // being clipped or widening the page.
                    sx={{ '& .MuiSelect-select': { whiteSpace: 'normal', overflowWrap: 'anywhere' } }}
                  >
                    {/* A registered Target stays selectable: re-searching it is
                        an ordinary single search (`docs/UI_FLOW.md` 9). */}
                    {enabledTargets.map((target) => (
                      <MenuItem value={target.id} key={target.id} sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        <TargetOptionLabel name={target.name} registered={registeredTargetIds.has(target.id)} />
                      </MenuItem>
                    ))}
                    {/* Not selectable until the user reviews and saves the
                        completion condition (`docs/UI_FLOW.md` 8.4 / 9). */}
                    {reviewRequiredTargets.map((target) => (
                      <MenuItem value={target.id} key={target.id} disabled sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        {`${target.name}（${COMPLETION_CONDITION_REVIEW_CHIP_LABEL}・選択不可）`}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl fullWidth sx={{ minWidth: 0 }}>
                  <InputLabel id="route-filter-label">作成ルート</InputLabel>
                  <Select
                    labelId="route-filter-label"
                    label="作成ルート"
                    value={routeFilter}
                    onChange={(event) => setRouteFilter(event.target.value as CandidateRouteFilter)}
                  >
                    <MenuItem value="all">すべて</MenuItem>
                    <MenuItem value="normal_artian">通常アーティア経由</MenuItem>
                    <MenuItem value="existing_gogma">所持巨戟アーティア経由</MenuItem>
                  </Select>
                </FormControl>
              </Box>
              {ownedIdeal.error && <Alert severity="error">{ownedIdeal.error}</Alert>}
              {selectedTarget && masterForDisplay && ownedIdeal.weapons.length > 0 && (
                <OwnedIdealWeaponNotice
                  target={selectedTarget}
                  weapons={ownedIdeal.weapons}
                  master={masterForDisplay}
                  onComplete={(weapon) => completion.begin(selectedTarget, weapon)}
                  disabled={planGuard.busy || completion.pending !== null || anyBatchRunning}
                />
              )}
              {defaultsLoadFailed && (
                <Alert severity="warning">
                  保存済みの探索量の既定値を読み込めなかったため、推奨の初期値で検索します。詳細設定（探索量の上限）で値を確認してください。
                </Alert>
              )}
              <DisclosureAccordion title="詳細設定（探索量の上限）" headingLevel="h3">
                <Stack spacing={1.5}>
                  <Typography variant="body2" color="text.secondary">
                    探索する進行量の上限です。上限を上げると見つかる候補が増える場合がありますが、検索に時間がかかります。初期値は設定画面で保存した既定値です。ここでの変更はこの画面での検索（未登録の一括検索・追加を含む）だけに使われ、既定値は変わりません。
                  </Typography>
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' },
                      gap: 1.5,
                    }}
                  >
                    {candidateSearchLimitFields.map((field) => (
                      <TextField
                        key={field.key}
                        fullWidth
                        label={field.label}
                        helperText={field.helperText}
                        type="number"
                        value={settings[field.key]}
                        onChange={(event) => updateSetting(field.key, event.target.value)}
                        slotProps={{ htmlInput: { min: 1, step: 1 } }}
                      />
                    ))}
                  </Box>
                </Stack>
              </DisclosureAccordion>
              {/* Between the search bounds and the buttons (`docs/UI_FLOW.md`
                  9.2). Never disabled: a change while a search or a batch runs
                  applies to the next single search only. */}
              <SourceExclusionConditionCheckbox
                checked={singleExcludeOtherTargetSources}
                onChange={setSingleExcludeOtherTargetSources}
              />
              <Stack spacing={1}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1.5}
                  useFlexGap
                  sx={{ alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
                >
                  <Button
                    variant="contained"
                    onClick={() => void startSearch()}
                    disabled={searching || anyBatchRunning || targetWeaponId === ''}
                    sx={{ minHeight: 44, px: 3 }}
                  >
                    検索開始
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={startBatch}
                    disabled={batchBlocked || batchTargets.length === 0}
                    sx={{ minHeight: 44, px: 3 }}
                  >
                    未登録を一括検索・追加（{batchTargets.length}件）
                  </Button>
                  {/* A separate operation from the 9.1 batch (`docs/UI_FLOW.md`
                      9.3): the count is the Domain's selection, and a failed
                      selection read withholds it instead of showing 0. */}
                  <Button
                    variant="outlined"
                    onClick={research.openConfirmation}
                    disabled={batchBlocked || research.selection === null || researchTargetCount === 0}
                    sx={{ minHeight: 44, px: 3 }}
                  >
                    {batchResearchButtonLabel(researchTargetCount)}
                  </Button>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  検索中は進捗を表示し、いつでもキャンセルできます。
                </Typography>
                {/* The batch runs the same single search once per Target
                    (`docs/UI_FLOW.md` 9.1); it is no multi-Target search. */}
                <Typography variant="body2" color="text.secondary">
                  {batchTargets.length === 0
                    ? '作成リストに未登録の目標武器はありません。'
                    : '一括検索・追加では、作成リストに未登録の目標武器を現在の作成ルートと探索量の上限で1件ずつ順に検索し、見つかった完成条件を満たす候補を作成リストへ追加します。'}
                </Typography>
                {/* The counts are the Domain selection's: Targets to re-search
                    and stale candidates left alone are told apart, the reasons
                    can be read even with nothing to re-search, and only no
                    stale candidate at all reads as "nothing to re-search". */}
                {research.selectionError !== null ? (
                  <Alert severity="warning">{research.selectionError}</Alert>
                ) : research.selection !== null && researchTargetCount === 0 && researchExcludedCount > 0 ? (
                  <Alert severity="info">{batchResearchExcludedOnlyNote(researchExcludedCount)}</Alert>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    {research.selection !== null && researchTargetCount === 0 ? BATCH_RESEARCH_NONE_NOTE : BATCH_RESEARCH_DESCRIPTION}
                  </Typography>
                )}
                {research.selection !== null && researchTargetCount > 0 && researchExcludedCount > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    {batchResearchCountsNote(researchTargetCount, researchExcludedCount)}
                  </Typography>
                )}
                {research.selection !== null && researchExcludedCount > 0 && (
                  <BatchCandidateResearchExclusionDisclosure
                    excluded={research.selection.excluded}
                    title={batchResearchExcludedDisclosureTitle(researchExcludedCount)}
                    headingLevel="h3"
                  />
                )}
              </Stack>
              {searchNotice && <Alert severity="info">{searchNotice}</Alert>}
              {searchError && <Alert severity="error">{searchError}</Alert>}
            </Stack>
          </Paper>
        )}
        {batchRunning && batchProgress && (
          <BatchCandidateSearchProgressPanel progress={batchProgress} cancelling={batchCancelling} onCancel={cancelBatch} />
        )}
        {!batchRunning && batchSummary && (
          <BatchCandidateSearchSummaryPanel summary={batchSummary} supplement={replanProposalNotice('batch')} />
        )}
        {research.running && research.progress && (
          <BatchCandidateSearchProgressPanel
            progress={research.progress}
            cancelling={research.cancelling}
            onCancel={research.cancel}
            title={BATCH_RESEARCH_PROGRESS_TITLE}
            cancelLabel={BATCH_RESEARCH_CANCEL_LABEL}
          />
        )}
        {!research.running && research.summary && (
          <BatchCandidateResearchSummaryPanel summary={research.summary} supplement={replanProposalNotice('batch')} />
        )}
        {searching && progress && (
          <Paper
            component="section"
            variant="outlined"
            role="status"
            aria-live="polite"
            aria-labelledby={progressHeadingId}
            sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
          >
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography id={progressHeadingId} component="h2" variant="h2">
                  検索中
                </Typography>
                <StatusChip label={candidateSearchProgressPhaseLabels[progress.phase]} tone="info" />
              </Stack>
              {/* Work inside one Target is discovered while searching, so it is
                  never converted into a percent. */}
              <LinearProgress aria-label="候補検索の進捗" />
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0.5, sm: 3 }}
                useFlexGap
                sx={{ flexWrap: 'wrap' }}
              >
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  対象: {progressTarget?.name ?? '不明'}
                </Typography>
                <Typography variant="body2" className="tabular-nums">
                  探索ステップ: {progress.processedWorkItems}
                </Typography>
              </Stack>
              {/* The condition this search started with, not the Checkbox now. */}
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {sourceExclusionConditionLabel(searchingExcludeOtherTargetSources)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                探索ステップの総数は検索中に増えるため、進捗率は表示しません。
              </Typography>
              <Button
                variant="outlined"
                onClick={cancelSearch}
                sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
              >
                キャンセル
              </Button>
            </Stack>
          </Paper>
        )}
        {result && masterForDisplay && (() => {
          const targetResult = result.result.targetResult
          // Only the weapons the Search Domain really excluded, named from the
          // snapshot of this search (`docs/UI_FLOW.md` 9.2).
          const sourceExclusion = createSearchSourceExclusionDisplay(
            result.excludeOtherTargetSources,
            targetResult.excludedSourceOwnedWeaponIds,
            result.sourceExclusion,
          )
          const excludedCount = sourceExclusion.excludedWeapons.length
          const target = targetById.get(targetResult.targetWeaponId) ?? null
          const displayedCandidate = targetResult.candidate
          // The Build List Domain authority decides equivalence; a Candidate
          // ID differs on every search run and is never compared here.
          const buildListStatus =
            displayedCandidate === null
              ? undefined
              : buildListEntries.some((entry) => isSameBuildListCandidate(entry, displayedCandidate))
                ? 'added'
                : 'not_added'
          return (
            <Stack component="section" aria-labelledby={resultHeadingId} spacing={2} sx={{ minWidth: 0 }}>
              <Box>
                <Typography id={resultHeadingId} component="h2" variant="h2">
                  検索結果
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
                  目標武器: {target?.name ?? '不明な目標武器'}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
                  {sourceExclusionConditionLabel(result.excludeOtherTargetSources)}
                  {result.excludeOtherTargetSources && excludedCount === 0 && SOURCE_EXCLUSION_NOTHING_EXCLUDED_NOTE}
                </Typography>
              </Box>
              <SourceExclusionResultAlert display={sourceExclusion} debugMode={debugMode} headingLevel="h3" />
              {noticeSeverities.map((severity) => {
                // Grouped by severity so a search that merely used a narrower
                // method is never read as a failed search.
                const notices = result.result.warnings.filter((warning) => warning.severity === severity)
                if (notices.length === 0) return null
                return (
                  <Alert severity={severity} key={severity}>
                    <AlertTitle>{candidateSearchNoticeSeverityLabels[severity]}</AlertTitle>
                    {notices.map((notice, index) => (
                      <Typography
                        variant="body2"
                        sx={{ whiteSpace: 'pre-line' }}
                        key={`${notice.targetWeaponId}:${index}`}
                      >
                        {notice.message}
                      </Typography>
                    ))}
                  </Alert>
                )
              })}
              {/* No Candidate inside the configured extent is never a statement
                  that none exists, and a state that does not meet the completion
                  condition is never offered on its own (`docs/SEARCH_SPEC.md` 5.7). */}
              {targetResult.candidate === null && (
                <Alert severity="info">
                  <Stack spacing={1}>
                    <Typography variant="body2">
                      現在の探索範囲では完成条件を満たす候補が見つかりませんでした。探索量の上限を上げると見つかる場合があります。詳細設定の「通常アーティア最大進行量」「復元ボーナス最大進行量」「スキル最大進行量」を見直してください。
                    </Typography>
                    {/* Said only when this search really excluded a weapon;
                        the excluded weapons are never searched again on their own. */}
                    {excludedCount > 0 && (
                      <Typography variant="body2">{sourceExclusionNotFoundNote(excludedCount)}</Typography>
                    )}
                  </Stack>
                </Alert>
              )}
              {targetResult.candidate && (
                <CandidateCard
                  candidate={targetResult.candidate}
                  target={target}
                  master={masterForDisplay}
                  ownedWeapons={ownedWeapons}
                  showPreferredOwnedWeaponNotice
                  searchSourceExclusion={sourceExclusion}
                  debugMode={debugMode}
                  buildListStatus={buildListStatus}
                  onAdd={(selected) => void addToBuildList(selected)}
                  addDisabled={adding || replacement.pending !== null || planGuard.busy}
                  addFeedback={
                    (addFeedback !== null || replanProposal?.source === 'single') && (
                      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
                        {addFeedback && (
                          <Alert severity={addFeedback.severity}>
                            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                                {addFeedback.message}
                              </Typography>
                              {addFeedback.buildListLinkLabel && (
                                <Button
                                  component={RouterLink}
                                  to="/build-list"
                                  variant="outlined"
                                  color="inherit"
                                  sx={{ minHeight: 44 }}
                                >
                                  {addFeedback.buildListLinkLabel}
                                </Button>
                              )}
                            </Stack>
                          </Alert>
                        )}
                        {replanProposalNotice('single')}
                      </Stack>
                    )
                  }
                />
              )}
              {targetResult.skippedRoutes.length > 0 && (
                <DisclosureAccordion title="実行できなかった作成ルート" headingLevel="h3">
                  <Stack spacing={1.5}>
                    <Typography variant="body2" color="text.secondary">
                      現在のRNG状態、所持武器、予測エンジンの対応状況、または検索条件により、今回の検索では対象にならなかった作成ルートです（{targetResult.skippedRoutes.length}件）。
                    </Typography>
                    <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
                      {targetResult.skippedRoutes.map((skipped, index) => (
                        <Box
                          component="li"
                          key={`${skipped.route}:${skipped.reason}:${index}`}
                          sx={{ minWidth: 0, borderTop: index === 0 ? 0 : 1, borderColor: 'divider', pt: index === 0 ? 0 : 1 }}
                        >
                          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                            {routeKindLabels[skipped.route]}
                          </Typography>
                          {skipped.reason === 'master_data_unavailable' ? (
                            <Alert severity="warning" sx={{ mt: 0.5 }}>
                              {skippedRouteReasonLabels[skipped.reason]}
                            </Alert>
                          ) : (
                            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                              {skippedRouteReasonLabels[skipped.reason]}
                            </Typography>
                          )}
                        </Box>
                      ))}
                    </Box>
                  </Stack>
                </DisclosureAccordion>
              )}
            </Stack>
          )
        })()}
        <OwnedIdealCompletionDialog
          pending={completion.pending}
          affectedTargets={completion.affectedTargets}
          otherSatisfiedTargets={completion.otherSatisfiedTargets}
          unrecordedCompletedTargets={completion.unrecordedCompletedTargets}
          submitting={completion.submitting}
          error={completion.error}
          onCancel={completion.cancel}
          onConfirm={() => void completion.confirm()}
        />
        {masterForDisplay && (
          <BuildListReplacementDialog
            pending={replacement.pending}
            master={masterForDisplay}
            ownedWeapons={ownedWeapons}
            submitting={replacement.submitting}
            error={replacement.error}
            onCancel={replacement.cancel}
            onConfirm={() => void replacement.confirm()}
          />
        )}
        <BatchCandidateResearchDialog
          selection={research.confirming}
          onCancel={research.cancelConfirmation}
          onConfirm={research.start}
        />
        <PlanBreakingChangeDialog controller={planGuard} />
      </Stack>
    </PageShell>
  )
}
