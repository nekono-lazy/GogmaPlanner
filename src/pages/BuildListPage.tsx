import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import { DisclosureAccordion } from '../components/DisclosureAccordion'
import { PageShell } from '../components/PageShell'
import { StatusChip } from '../components/StatusChip'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import { savePointPositionLabel } from '../components/execution/executionStepPresentation'
import { RunningPlanReplanPanel } from '../components/execution/RunningPlanReplanPanel'
import { CompletionAssignmentConflictAlert } from '../components/execution/CompletionAssignmentConflictAlert'
import { COMPLETION_ASSIGNMENT_REPLAN_NOTE, completionAssignmentNamesOf } from '../components/execution/completionAssignmentConflictPresentation'
import {
  RUNNING_PLAN_IN_USE_STALE_GROUP_CHIP,
  RUNNING_PLAN_IN_USE_STALE_LINES,
  RUNNING_PLAN_IN_USE_STALE_REASONS_LABEL,
  RUNNING_PLAN_IN_USE_STALE_TITLE,
  RUNNING_PLAN_REPLAN_REQUEST_NO_RUNNING_PLAN_MESSAGE,
  runningPlanReplanAdditionalCandidateCountText,
} from '../components/execution/runningPlanReplanGuidancePresentation'
import {
  runningPlanReplanExclusionRequest,
  useRunningPlanReplanNavigationRequest,
  type RunningPlanReplanOpenRequest,
} from '../components/execution/runningPlanReplanRequest'
import { usePlanBreakingChangeApproval } from '../components/execution/usePlanBreakingChangeApproval'
import {
  deriveRunningPlanInUseStaleBuildListEntryIds,
  evaluateProductionPlanContinuation,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
} from '../domain/execution'
import { useRunningPlanReplan } from '../components/execution/useRunningPlanReplan'
import { CandidateCard } from '../components/search/CandidateCard'
import { BuildListPlanCreationSection } from '../components/planner/BuildListPlanCreationSection'
import { PLAN_CREATION_BUILD_LIST_LOCKED_NOTE } from '../components/planner/planCreationPresentation'
import {
  plannerOptionInvalidMessage,
  productionPlannerDetailSettingsDescriptionLines,
  productionPlannerDetailSettingsTitle,
  productionPlannerMaxPlanStepsField,
} from '../components/planner/productionPlannerSettingsPresentation'
import { useBuildListPlanCreation } from '../components/planner/useBuildListPlanCreation'
import { loadMasterData } from '../domain/master/loadMasterData'
import type { MasterDataRoot } from '../domain/master/masterTypes'
import type {
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  OwnedWeapon,
  ProductionPlan,
  ProductionPlanId,
  TargetWeapon,
  TargetWeaponId,
} from '../domain/models/publicTypes'
import type { PlannerOptions, PlannerResult } from '../domain/planner'
import { findBuildListTargetDuplicates } from '../domain/buildList'
import { productionPlanStatusLabels, staleReasonLabels } from '../presentation/labels'
import {
  createProductionRunningPlanReplanDependencies,
  type RunningPlanReplanDependencies,
} from '../services/execution/runningPlanReplanDependencies'
import {
  createRunningPlanReplanGuidanceReader,
  type RunningPlanReplanGuidanceReader,
} from '../services/execution/runningPlanReplanGuidanceService'
import { compareByRegistrationOrder, sortByRegistrationOrder } from '../presentation/managementListOrder'
import {
  emptyWeaponListFilter,
  isWeaponListFilterActive,
  matchesWeaponListFilter,
  type WeaponListFilter,
} from '../presentation/weaponListFilter'
import { WeaponListFilterBar, WeaponListFilterEmpty } from '../components/WeaponListFilterBar'
import { getEnabledElements, getEnabledWeaponTypes } from '../domain/master/masterSelectors'
import { productionPlanRepository } from '../db/repositories/productionPlanRepository'
import { useSettingsStore } from '../stores/settingsStore'
import { buildListService } from '../services/buildList/buildListService'
import { createBuildListCalculationContext } from '../services/buildList/createBuildListCalculationContext'
import type { BuildListOptimizationAdoptionSource } from '../services/planner/buildListOptimizationService'
import {
  createProductionPlanCreationSession,
  type PlanCreationSession,
} from '../services/planner/planCreationService'
import {
  plannerResultPersistenceService,
  type BuildListOptimizationAdoptionInspection,
} from '../services/planner/plannerResultPersistenceService'
import { recommendedBuildListMaxPlanSteps } from '../services/planner/plannerRuntimeOptions'
import {
  createProductionPlanReplanDependencies,
  type ProductionPlanReplanDependencies,
} from '../services/execution/productionPlanReplanDependencies'
import {
  createProductionPlannerWorkerClient,
  type PlannerWorkerClient,
} from '../services/planner/plannerWorkerClient'

const loadedMaster = loadMasterData()
const defaultMaster = loadedMaster.ok ? loadedMaster.data : null

export interface BuildListPageDependencies {
  master: MasterDataRoot
  /**
   * The Production Planner Worker Client of the 16.8 replan Preview. The plan
   * creation's own Planner runs belong to its session (`createPlanCreationSession`).
   */
  createWorkerClient(): PlannerWorkerClient
  refresh(calculationContext: CalculationContext): Promise<{ entries: BuildListEntry[]; targets: TargetWeapon[]; ownedWeapons: OwnedWeapon[] }>
  /**
   * The plan creation boundary of 「生産計画を作成」 (`docs/PLANNER_SPEC.md` 17.2,
   * Issue #260 PR-6C): one session per page mount, which reads and judges at
   * every press and runs the ordinary Planner or the Build List global
   * optimization. The page disposes it on unmount; a re-read of the page's
   * data never recreates it.
   */
  createPlanCreationSession(): PlanCreationSession
  /**
   * The read-only adoption inspection of an `optimized` result
   * (`docs/PLANNER_SPEC.md` 17.11): what the adoption would replace. Never
   * write authority.
   */
  inspectBuildListOptimizationAdoption(
    source: BuildListOptimizationAdoptionSource,
    currentCalculationContext: CalculationContext,
  ): Promise<BuildListOptimizationAdoptionInspection>
  /**
   * Adopts an `optimized` result in one transaction (the Entry replacements
   * and the new Draft) and returns the stored Draft (17.11). Every refusal
   * throws and writes nothing.
   */
  saveBuildListOptimizationAdoption(
    source: BuildListOptimizationAdoptionSource,
    currentCalculationContext: CalculationContext,
  ): Promise<ProductionPlan>
  /**
   * Persists the ordinary Planner result as the new Draft through the atomic
   * Draft save (PLANNER_SPEC 9.2.15, Phase 6-A): the previous Draft is
   * replaced in the same transaction and the Build List is not written.
   *
   * The complete result is passed, never only its Plan, so the typed
   * termination and the Plan are judged by that service alone. It returns the
   * stored Plan, or `null` when the calculation produced no Plan.
   */
  savePlannerResult(
    result: PlannerResult,
    currentCalculationContext: CalculationContext,
  ): Promise<ProductionPlan | null>
  /** `approval` is the breaking-change approval when the inspection required one (`docs/UI_FLOW.md` 16.3). */
  deleteEntry(id: BuildListEntryId, approval?: PlanBreakingChangeApproval | null): Promise<void>
  /** The read-only breaking-change inspection of that very delete. */
  inspectEntryDelete(id: BuildListEntryId): Promise<PlanBreakingChangeInspection>
  /**
   * The one running (`active` / `stale`) Plan, or `undefined`
   * (`docs/PLANNER_SPEC.md` 16.2). It decides which Planner entry the page
   * offers: the ordinary Draft creation, or the 16.8 replan Preview. More than
   * one running Plan is a persistence invariant violation the repository
   * reports, never something the page resolves.
   */
  getRunningProductionPlan(): Promise<ProductionPlan | undefined>
  /**
   * The one not-yet-started Draft, or `undefined` (`docs/DATA_MODEL.md` 11.1).
   * Display only (`docs/UI_FLOW.md` 10.3): the page links to it and says that
   * the next Planner save replaces it. It never decides which Planner entry is
   * offered - that stays with the running Plan - and a Draft beside a running
   * Plan is legal, so it is never read away because a Plan runs. More than one
   * Draft is a persistence invariant violation the repository reports, never
   * something the page resolves or reads as "no Draft".
   */
  getDraftProductionPlan(): Promise<ProductionPlan | undefined>
  /**
   * The ordinary Planner replan (16.8, `docs/UI_FLOW.md` 16.4). Since Issue #276 PR-6A it is reached only as the running Plan
   * replan's explicit auxiliary 「登録済みの候補で再計画を試算」 (its Preview and adoption; its input comes from `runningPlanReplan`).
   */
  replan: ProductionPlanReplanDependencies
  /**
   * 「現在地点からの再計画」 (`docs/PLANNER_SPEC.md` 18, `docs/UI_FLOW.md` 16.5, Issue #276 PR-6A): the target confirmation, the
   * re-optimization session, its adoption and the auxiliary's press-time input.
   */
  runningPlanReplan: RunningPlanReplanDependencies
  /**
   * The read-only replan guidance (`docs/PLANNER_SPEC.md` 18.3, Issue #276
   * PR-6B): the passive additional candidate count of the running Plan, and
   * whether the breaking-change warning of a Plan-dependent Entry may offer to
   * exclude its Target in a replan instead.
   */
  replanGuidance: RunningPlanReplanGuidanceReader
}

function createDefaultDependencies(master: MasterDataRoot): BuildListPageDependencies {
  return {
    master,
    createWorkerClient: createProductionPlannerWorkerClient,
    refresh: (calculationContext) =>
      buildListService.refreshStaleness(calculationContext),
    createPlanCreationSession: () => createProductionPlanCreationSession(master),
    inspectBuildListOptimizationAdoption: (source, currentCalculationContext) =>
      plannerResultPersistenceService.inspectBuildListOptimizationAdoptionSave(source, currentCalculationContext),
    // No approval: an adoption never runs beside a running Plan (17.11).
    saveBuildListOptimizationAdoption: async (source, currentCalculationContext) =>
      (await plannerResultPersistenceService.saveBuildListOptimizationAdoption(source, currentCalculationContext)).plan,
    // The ordinary Draft creation writes no Build List, so it passes no
    // approval and never breaks a running Plan.
    savePlannerResult: async (result, currentCalculationContext) => {
      const outcome = await plannerResultPersistenceService.savePlannerResult(
        result,
        currentCalculationContext,
      )
      return outcome.kind === 'saved' ? outcome.plan : null
    },
    deleteEntry: (id, approval) => buildListService.deleteEntry(id, approval ?? null),
    inspectEntryDelete: (id) => buildListService.inspectEntryDelete(id),
    getRunningProductionPlan: () => productionPlanRepository.getRunningProductionPlan(),
    getDraftProductionPlan: () => productionPlanRepository.getDraftProductionPlan(),
    replan: createProductionPlanReplanDependencies(master),
    runningPlanReplan: createProductionRunningPlanReplanDependencies(master),
    replanGuidance: createRunningPlanReplanGuidanceReader(),
  }
}

const defaultDependencies: BuildListPageDependencies | null = defaultMaster
  ? createDefaultDependencies(defaultMaster)
  : null

/**
 * The replan runtime of a page without Master Data: it never runs, because the
 * page renders no replan control then, and it rejects rather than guesses.
 */
const unavailableReplanDependencies: ProductionPlanReplanDependencies = {
  prepareProductionPlanReplanPreview: () => Promise.reject(new Error('マスターデータを読み込めません。')),
  createProductionPlanReplanPreview: () => {
    throw new Error('マスターデータを読み込めません。')
  },
  inspectProductionPlanReplanAdoption: () => Promise.reject(new Error('マスターデータを読み込めません。')),
  adoptProductionPlanReplanPreview: () => Promise.reject(new Error('マスターデータを読み込めません。')),
}

/**
 * The Build List detail settings hold the raw `maxPlanSteps` string, so an
 * in-progress or invalid entry stays visible instead of being silently coerced.
 *
 * `maxPlanSteps` is the only Production Planner bound the user edits (Issue
 * #103 Phase D-1). A `PlannerOptions` value is only produced when it is a
 * positive integer, so `NaN`, `0`, a negative number, a fraction and an empty
 * field can never reach `PlannerInput.options` (UI_FLOW 10.0). It is the whole
 * Production `PlannerOptions` (Phase D-2a), so nothing else is filled in.
 */
interface PlannerOptionInputs {
  maxPlanSteps: string
}

function createPlannerOptionInputs(options: PlannerOptions): PlannerOptionInputs {
  return { maxPlanSteps: String(options.maxPlanSteps) }
}

function parsePlannerOptionValue(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 1 ? value : null
}

function parsePlannerOptions(inputs: PlannerOptionInputs): PlannerOptions | null {
  const maxPlanSteps = parsePlannerOptionValue(inputs.maxPlanSteps)
  return maxPlanSteps === null ? null : { maxPlanSteps }
}

/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
const BUILD_LIST_DELETE_PLAN_BREAKING_NOTE =
  'この作成リスト項目を削除すると、現在の生産計画の前提と一致しなくなります。'
const ENTRY_DELETED_PLAN_ABANDONED_MESSAGE = 'ビルドリストから削除し、実行中の生産計画を破棄しました。'
/**
 * A Target holding two or more Entries - a legacy duplicate of the Build List
 * cardinality (`docs/DATA_MODEL.md` 9.4.1, `docs/UI_FLOW.md` 10). The guidance
 * names no Entry to keep: the user decides and deletes the others with the
 * ordinary guarded delete.
 */
const LEGACY_DUPLICATE_CHIP_LABEL = '要整理'
const LEGACY_DUPLICATE_TITLE = '候補が複数登録されています'
const LEGACY_DUPLICATE_LINES: readonly string[] = [
  'この目標武器には作成リストの候補が複数登録されています。生産計画の作成と再計画の試算には、使用する候補を1件にする必要があります。',
  '残す候補を確認し、不要な候補を「ビルドリストから削除」で削除してください。どの候補を残すかは自動では決めません。',
]

/**
 * Whether a Plan is running now. `error` means the read failed or the running
 * Plan invariant is broken: neither Planner entry is offered then, because the
 * page cannot tell which one applies.
 */
type RunningPlanState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'running'; plan: ProductionPlan }
  | { status: 'error' }

/**
 * Whether the current Draft exists. `error` means the read failed or the Draft
 * invariant is broken (two Drafts): the state is reported, never guessed as
 * "no Draft", and the ordinary Draft creation is withheld exactly as it is
 * when the running Plan cannot be read, because the page cannot say what the
 * save would replace. The replan Preview of a running Plan is untouched.
 */
type DraftPlanState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'draft'; plan: ProductionPlan }
  | { status: 'error' }

/**
 * Entries grouped by the Target they belong to (`docs/UI_FLOW.md` 3.2 / 10).
 *
 * Presentation only. The groups follow the Targets' registration order - the
 * order of the Target Weapons list and the Search Select - and the Entries of
 * one group follow their own registration order; neither uses priority or any
 * other new meaning. The Target is the current persisted one; a Target that no
 * longer exists still keeps its Entries together under its ID, after every
 * existing Target's group.
 */
interface BuildListTargetGroup {
  targetWeaponId: TargetWeaponId
  target: TargetWeapon | null
  entries: BuildListEntry[]
}

function groupEntriesByTarget(
  entries: readonly BuildListEntry[],
  targets: readonly TargetWeapon[],
): BuildListTargetGroup[] {
  const targetById = new Map(targets.map((target) => [target.id, target]))
  const groups = new Map<TargetWeaponId, BuildListTargetGroup>()
  for (const entry of sortByRegistrationOrder(entries)) {
    const group = groups.get(entry.targetWeaponId)
    if (group) group.entries.push(entry)
    else {
      groups.set(entry.targetWeaponId, {
        targetWeaponId: entry.targetWeaponId,
        target: targetById.get(entry.targetWeaponId) ?? null,
        entries: [entry],
      })
    }
  }
  // A stable sort: the missing-Target groups keep their first-Entry order.
  return [...groups.values()].sort((left, right) => {
    if (left.target === null || right.target === null) {
      return Number(left.target === null) - Number(right.target === null)
    }
    return compareByRegistrationOrder(left.target, right.target)
  })
}

/** One figure of the page summary. Display only, never a Planner authority. */
function SummaryTile({ label, value, note }: { label: string; value: number; note?: string }) {
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
        gap: 0.25,
      }}
    >
      <Typography component="h3" variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="p" className="tabular-nums" sx={{ fontSize: '1.375rem', fontWeight: 600, lineHeight: 1.3 }}>
        {value}
      </Typography>
      {note && (
        <Typography variant="caption" color="text.secondary">
          {note}
        </Typography>
      )}
    </Box>
  )
}

/**
 * A titled, border-based page section. `headingRef` makes the heading a focus
 * target (`tabIndex={-1}`), for a section the user explicitly asked to open.
 */
function PageSection({
  title,
  children,
  accent = false,
  headingRef,
}: {
  title: string
  children: ReactNode
  accent?: boolean
  headingRef?: Ref<HTMLHeadingElement>
}) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{
        p: { xs: 2, md: 2.5 },
        minWidth: 0,
        ...(accent ? { borderLeftWidth: 4, borderLeftColor: 'primary.main' } : {}),
      }}
    >
      <Stack spacing={2}>
        <Typography
          id={headingId}
          component="h2"
          variant="h2"
          ref={headingRef}
          {...(headingRef === undefined ? {} : { tabIndex: -1 })}
        >
          {title}
        </Typography>
        {children}
      </Stack>
    </Paper>
  )
}

const MISSING_TARGET_NAME = '削除済みの目標武器'
const MISSING_TARGET_WEAPON_LABEL = '武器種・属性: 目標武器が見つかりません'

/**
 * One Target's Entries as a disclosure (`docs/UI_FLOW.md` 10, Issue #124).
 *
 * Closed, the group still names its Target - the name, the weapon type and the
 * element - with the priority, the Entry count and every state that needs the
 * user's attention as text chips: the legacy duplicate 「要整理」 and the stale
 * Entries. Open, it shows the legacy duplicate guidance and the Entries
 * exactly as before. The open state is the
 * page's runtime UI state, keyed by the Target ID; it is never persisted and
 * decides nothing the Planner reads.
 *
 * The Target name, its priority and the Entry count come from the current
 * persisted Target and from the Entries themselves. The priority is shown for
 * orientation only: changing it belongs to the Target Weapons screen's full
 * edit path, and no Target write happens here. A Target that no longer exists
 * keeps its own group, which still opens.
 */
function TargetGroupSection({
  group,
  legacyDuplicate,
  inUseStaleEntryIds,
  weaponLabel,
  expanded,
  onExpandedChange,
  children,
}: {
  group: BuildListTargetGroup
  /** The Target holds two or more Entries, as `findBuildListTargetDuplicates()` decided. */
  legacyDuplicate: boolean
  /**
   * The stale Entries the `active` Plan keeps using, stale only from its planned progress
   * (`deriveRunningPlanInUseStaleBuildListEntryIds()`): named as in use instead of 「再検索が必要」.
   */
  inUseStaleEntryIds: ReadonlySet<BuildListEntryId>
  /** The Target's weapon type and element, or `null` when the Target no longer exists. */
  weaponLabel: string | null
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  children: ReactNode
}) {
  const inUseStaleCount = group.entries.filter(({ id }) => inUseStaleEntryIds.has(id)).length
  const staleCount = group.entries.filter(({ id, isStale }) => isStale && !inUseStaleEntryIds.has(id)).length
  const summary = (
    <Stack component="span" spacing={0.75} sx={{ minWidth: 0 }}>
      <Typography
        component="span"
        variant="body2"
        color="text.secondary"
        sx={{ display: 'block', overflowWrap: 'anywhere' }}
      >
        {weaponLabel ?? MISSING_TARGET_WEAPON_LABEL}
      </Typography>
      <Stack
        component="span"
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}
      >
        {group.target && (
          <StatusChip component="span" label={`優先度 ${group.target.priority}`} tone="info" />
        )}
        <Typography component="span" variant="body2" color="text.secondary" className="tabular-nums">
          候補 {group.entries.length}件
        </Typography>
        {legacyDuplicate && <StatusChip component="span" label={LEGACY_DUPLICATE_CHIP_LABEL} tone="caution" />}
        {staleCount > 0 && (
          <StatusChip component="span" label={`再検索が必要 ${staleCount}件`} tone="caution" />
        )}
        {inUseStaleCount > 0 && (
          <StatusChip component="span" label={`${RUNNING_PLAN_IN_USE_STALE_GROUP_CHIP} ${inUseStaleCount}件`} tone="info" />
        )}
      </Stack>
    </Stack>
  )
  return (
    <DisclosureAccordion
      title={group.target?.name ?? MISSING_TARGET_NAME}
      titleVariant="h3"
      headingLevel="h3"
      summary={summary}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      // A closed group holds no Candidate card: a long Build List keeps only
      // its headers in the DOM. Nothing is lost on close, because the Entries
      // and the warning dialog are the page's own.
      unmountOnExit
    >
      <Stack spacing={2} sx={{ minWidth: 0 }}>
        {legacyDuplicate && (
          <Alert severity="warning">
            <AlertTitle>{LEGACY_DUPLICATE_TITLE}</AlertTitle>
            <Stack spacing={0.5}>
              {LEGACY_DUPLICATE_LINES.map((line) => (
                <Typography variant="body2" key={line}>
                  {line}
                </Typography>
              ))}
            </Stack>
          </Alert>
        )}
        <Stack component="ul" spacing={2} sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {children}
        </Stack>
      </Stack>
    </DisclosureAccordion>
  )
}

interface BuildListPageProps { dependencies?: BuildListPageDependencies }

export function BuildListPage({ dependencies = defaultDependencies ?? undefined }: BuildListPageProps) {
  const debugMode = useSettingsStore((state) => state.debugMode)
  const navigate = useNavigate()
  const entriesHeadingId = useId()
  const [entries, setEntries] = useState<BuildListEntry[]>([])
  const [targets, setTargets] = useState<TargetWeapon[]>([])
  const [ownedWeapons, setOwnedWeapons] = useState<OwnedWeapon[]>([])
  const [loading, setLoading] = useState(dependencies !== undefined)
  // `null` while the user has not edited the detail settings: the field then
  // shows the current Build List's recommended bound. Once the user edits it,
  // that input is the authority and no refresh, re-render or save replaces it
  // (UI_FLOW 10.0, Issue #130).
  const [editedOptionInputs, setEditedOptionInputs] =
    useState<PlannerOptionInputs | null>(null)
  // Whether the user opened 「詳細設定（通常Planner用）」. The Accordion is
  // rendered only while an ordinary Planner operation is offered or shown
  // (Issue #359), so its open state lives here: hiding and showing it again
  // keeps both the value and how the user left it. Runtime UI state only.
  const [plannerSettingsExpanded, setPlannerSettingsExpanded] = useState(false)
  // The failure and notice sources stay separate: a load failure is never
  // shown as an empty Build List, and a Planner or remove problem stays next
  // to the control that caused it (`docs/UI_FLOW.md` 10).
  const [loadError, setLoadError] = useState<string | null>(
    dependencies ? null : 'マスターデータを読み込めません。',
  )
  const [removeError, setRemoveError] = useState<string | null>(null)
  // An Entry delete that also ended the running Plan, reported at the top:
  // the Entry list may be empty afterwards.
  const [removeNotice, setRemoveNotice] = useState<string | null>(null)
  const [runningPlan, setRunningPlan] = useState<RunningPlanState>(
    dependencies ? { status: 'loading' } : { status: 'error' },
  )
  const [draftPlan, setDraftPlan] = useState<DraftPlanState>(
    dependencies ? { status: 'loading' } : { status: 'error' },
  )
  // The breaking-change warning of a selected Entry's delete
  // (`docs/UI_FLOW.md` 16.3). While it decides, no other guarded change is
  // queued: the delete buttons wait.
  // For a Plan-dependent Entry it may also offer to leave the change unsaved
  // and exclude the Target in the replan below (Issue #276 PR-6B).
  const replanGuidance = dependencies?.replanGuidance
  const planGuard = usePlanBreakingChangeApproval({
    replanExclusion: replanGuidance === undefined
      ? undefined
      : (planId, targetWeaponId) => replanGuidance.canExcludeInReplan(planId, targetWeaponId),
  })
  // A runtime change against the running Plan (a save point restore, a refused
  // adoption) re-reads the Build List and the running Plan.
  const [loadSequence, setLoadSequence] = useState(0)
  // 「生産計画を作成」 (`docs/PLANNER_SPEC.md` 17.2, Issue #260 PR-6C): one plan
  // creation session per page mount, never recreated by a re-read of the page.
  // It owns the ordinary Planner and the Build List optimization runs; the
  // replan Preview below keeps its own state machine and Worker.
  const planCreation = useBuildListPlanCreation({
    dependencies: dependencies ?? null,
    // Persistence's stored Draft (an ordinary save or an adoption) is the only
    // navigation target, never a Worker result's Plan ID.
    onSaved: (plan) => void navigate(`/plans/${plan.id}`),
    onPersistedStateChanged: () => setLoadSequence((sequence) => sequence + 1),
  })
  const { refreshPreStart } = planCreation
  const masterForDisplay = dependencies?.master ?? defaultMaster
  const recommendedMaxPlanSteps = useMemo(
    () => recommendedBuildListMaxPlanSteps(entries),
    [entries],
  )
  const optionInputs = useMemo(
    () =>
      editedOptionInputs ??
      createPlannerOptionInputs({ maxPlanSteps: recommendedMaxPlanSteps }),
    [editedOptionInputs, recommendedMaxPlanSteps],
  )
  const plannerOptions = useMemo(
    () => parsePlannerOptions(optionInputs),
    [optionInputs],
  )
  const groups = useMemo(() => groupEntriesByTarget(entries, targets), [entries, targets])
  // Display-only filter by the group's Target (`docs/UI_FLOW.md` 10): never
  // persisted, and the Planner always receives the whole Build List. A group
  // whose Target no longer exists has no weapon type to match, so it is shown
  // only while the filter is cleared.
  const [filter, setFilter] = useState<WeaponListFilter>(emptyWeaponListFilter)
  const shownGroups = useMemo(
    () =>
      isWeaponListFilterActive(filter)
        ? groups.filter(({ target }) => target !== null && matchesWeaponListFilter(target, filter))
        : groups,
    [filter, groups],
  )
  // Which Target groups are open (`docs/UI_FLOW.md` 10, Issue #124): runtime UI
  // state keyed by Target ID, never by position, so a filter change or a
  // re-read keeps every group as the user left it. Every group
  // starts closed. It is never persisted and the Planner never reads it.
  const [expandedTargetIds, setExpandedTargetIds] = useState<ReadonlySet<TargetWeaponId>>(
    () => new Set(),
  )
  const setGroupExpanded = (targetWeaponId: TargetWeaponId, expanded: boolean) =>
    setExpandedTargetIds((current) => {
      if (current.has(targetWeaponId) === expanded) return current
      const next = new Set(current)
      if (expanded) next.add(targetWeaponId)
      else next.delete(targetWeaponId)
      return next
    })
  // The bulk controls act on the groups shown now; a group the filter hides
  // keeps its own state.
  const setShownGroupsExpanded = (expanded: boolean) =>
    setExpandedTargetIds((current) => {
      const next = new Set(current)
      for (const { targetWeaponId } of shownGroups) {
        if (expanded) next.add(targetWeaponId)
        else next.delete(targetWeaponId)
      }
      return next
    })
  const weaponLabelOf = useMemo(() => {
    const weaponTypeNames = new Map(
      (masterForDisplay?.weaponTypes ?? []).map((type) => [type.id, type.displayNameJa] as const),
    )
    const elementNames = new Map(
      (masterForDisplay?.elements ?? []).map((element) => [element.id, element.displayNameJa] as const),
    )
    return (target: TargetWeapon | null): string | null =>
      target === null
        ? null
        : `${weaponTypeNames.get(target.weaponTypeId) ?? target.weaponTypeId} / ${
            elementNames.get(target.elementId) ?? target.elementId
          }`
  }, [masterForDisplay])
  // The Build List cardinality authority decides which Targets hold a legacy
  // duplicate; the page only turns its answer into a lookup for display.
  const legacyDuplicateTargetIds = useMemo(
    () => new Set(findBuildListTargetDuplicates(entries).map(({ targetWeaponId }) => targetWeaponId)),
    [entries],
  )
  // Display-only counts over the loaded data. None of them decides whether the
  // Planner may run: that stays with the Planner's own input validation.
  const staleCount = entries.filter(({ isStale }) => isStale).length

  // 「現在地点からの再計画」 while a Plan is running (`docs/UI_FLOW.md` 16.5,
  // Issue #276 PR-6A). Its session, its Worker and its auxiliary's ordinary
  // Planner Worker are its own; the ordinary Draft creation below never shares
  // them, and no Draft is saved beside a running Plan.
  const executionReplan = useRunningPlanReplan({
    dependencies: dependencies?.runningPlanReplan ?? null,
    ordinaryReplan: dependencies?.replan ?? unavailableReplanDependencies,
    createPlannerWorkerClient: () => {
      if (!dependencies) throw new Error('マスターデータを読み込めません。')
      return dependencies.createWorkerClient()
    },
    // The new Plan is `active` now: its Execution Navigator (UI_FLOW 16.5).
    onAdopted: (newPlanId) => void navigate(`/plans/${newPlanId}/run`),
    onPersistedStateChanged: () => setLoadSequence((sequence) => sequence + 1),
  })
  const { runningPlanChanged: executionReplanRunningPlanChanged } = executionReplan
  // The replan is bound to the running Plan it was opened for: when a re-read finds another (or no) running Plan, the replan
  // closes and says so, and never continues for the new Plan by itself.
  const runningPlanId = runningPlan.status === 'running' ? runningPlan.plan.id : null
  useEffect(() => {
    executionReplanRunningPlanChanged(runningPlanId)
  }, [runningPlanId, executionReplanRunningPlanChanged])

  // 18.3: the running Plan's additional candidates, re-read with the persisted
  // state the page shows (a re-read or a change of the Entries). Only a count
  // for the Plan shown here is displayed; a failed read shows none.
  const [replanCandidateCount, setReplanCandidateCount] = useState<{ planId: ProductionPlanId; count: number } | null>(null)
  useEffect(() => {
    if (!replanGuidance || runningPlanId === null) return
    let active = true
    void replanGuidance.inspectAdditionalCandidates(runningPlanId).then(
      (inspection) => {
        if (!active) return
        setReplanCandidateCount(inspection.kind === 'counted'
          ? { planId: inspection.planId, count: inspection.targetWeaponIds.length }
          : null)
      },
      () => {
        if (active) setReplanCandidateCount(null)
      },
    )
    return () => {
      active = false
    }
  }, [replanGuidance, runningPlanId, entries])
  const replanCandidateNote = replanCandidateCount !== null && replanCandidateCount.planId === runningPlanId
    ? runningPlanReplanAdditionalCandidateCountText(replanCandidateCount.count)
    : null

  // 18.3: the Entries the `active` Plan keeps using whose staleness only its
  // planned progress caused - they say the Plan continues instead of asking
  // for a new search. The staleness itself is untouched.
  const inUseStaleEntryIds = useMemo<ReadonlySet<BuildListEntryId>>(
    () => new Set(runningPlan.status === 'running'
      ? deriveRunningPlanInUseStaleBuildListEntryIds({ plan: runningPlan.plan, targetWeapons: targets, buildListEntries: entries })
      : []),
    [entries, runningPlan, targets],
  )

  // Whether the running Plan can go on (Issue #334, `docs/UI_FLOW.md` 12.11):
  // the one Domain judgement over the loaded Targets, display only - the
  // Execution runtime refuses an unsafe Plan on its own.
  const runningPlanContinuation = useMemo(
    () => runningPlan.status === 'running' && masterForDisplay
      ? evaluateProductionPlanContinuation(runningPlan.plan, targets, createBuildListCalculationContext(masterForDisplay))
      : null,
    [masterForDisplay, runningPlan, targets],
  )
  const runningPlanUnsafe = runningPlanContinuation?.kind === 'completion_assignment_conflict' ? runningPlanContinuation : null

  // Opening the replan from a proposal, a warning on another screen or this
  // page's own warning (Issue #276 PR-6B): bound to the Plan the request
  // names (another running Plan is refused by the replan's identity check),
  // with the runtime-only initial selection; nothing is calculated by itself.
  // The heading takes the focus, because the user asked for this section.
  const replanHeadingRef = useRef<HTMLHeadingElement>(null)
  const { openPanel: openExecutionReplan } = executionReplan
  const openReplanWith = useCallback((request: RunningPlanReplanOpenRequest) => {
    openExecutionReplan(request.planId, request.selection)
    window.setTimeout(() => replanHeadingRef.current?.focus(), 0)
  }, [openExecutionReplan])
  const replanNavigation = useRunningPlanReplanNavigationRequest()
  const { request: pendingReplanRequest, take: takeReplanRequest, dismiss: dismissReplanRequest } = replanNavigation

  useEffect(() => {
    let active = true
    if (!dependencies) {
      return
    }
    const calculationContext = createBuildListCalculationContext(dependencies.master)
    void dependencies.getRunningProductionPlan().then((plan) => {
      if (active) setRunningPlan(plan === undefined ? { status: 'none' } : { status: 'running', plan })
    }).catch(() => {
      if (active) setRunningPlan({ status: 'error' })
    })
    void dependencies.getDraftProductionPlan().then((plan) => {
      if (active) setDraftPlan(plan === undefined ? { status: 'none' } : { status: 'draft', plan })
    }).catch(() => {
      if (active) setDraftPlan({ status: 'error' })
    })
    void dependencies.refresh(calculationContext).then((loaded) => {
      if (!active) return
      setEntries(loaded.entries)
      setTargets(loaded.targets)
      setOwnedWeapons(loaded.ownedWeapons)
    }).catch((caught: unknown) => {
      if (active) setLoadError(caught instanceof Error ? caught.message : 'ビルドリストの読み込みに失敗しました。')
    }).finally(() => { if (active) setLoading(false) })
    return () => {
      active = false
    }
  }, [dependencies, loadSequence])

  const remove = async (entry: BuildListEntry) => {
    if (!dependencies || planGuard.deciding || planCreation.busy || executionReplan.busy) return
    const { id } = entry
    setRemoveError(null)
    setRemoveNotice(null)
    try {
      const outcome = await planGuard.run({
        inspect: () => dependencies.inspectEntryDelete(id),
        apply: (approval) => dependencies.deleteEntry(id, approval),
        note: BUILD_LIST_DELETE_PLAN_BREAKING_NOTE,
        replanExclusionTargetWeaponId: entry.targetWeaponId,
      })
      if (outcome.status === 'cancelled') {
        // Nothing was deleted; 「保存せずに再計画を開く」 opens the replan with the Target left out.
        if (outcome.replanExclusion !== undefined) {
          openReplanWith(runningPlanReplanExclusionRequest(outcome.replanExclusion.planId, outcome.replanExclusion.targetWeaponId))
        }
        return
      }
      if (outcome.status === 'refused') {
        setRemoveError(outcome.message)
        return
      }
      setEntries((current) => current.filter((entry) => entry.id !== id))
      planCreation.buildListChanged()
      executionReplan.buildListChanged()
      if (outcome.planAbandoned) {
        setRemoveNotice(ENTRY_DELETED_PLAN_ABANDONED_MESSAGE)
        setLoadSequence((sequence) => sequence + 1)
      }
    } catch (caught: unknown) {
      setRemoveError(caught instanceof Error ? caught.message : 'ビルドリストから削除できませんでした。')
    }
  }

  const loaded = !loading && loadError === null
  // A request this visit arrived with opens the replan once the page knows the
  // running Plan; without one it opens nothing (and the page says so below).
  useEffect(() => {
    if (pendingReplanRequest === null || !loaded || runningPlan.status !== 'running' || !masterForDisplay) return
    const request = takeReplanRequest()
    if (request !== null) openReplanWith(request)
  }, [loaded, masterForDisplay, openReplanWith, pendingReplanRequest, runningPlan.status, takeReplanRequest])
  // 「生産計画の作成」 is offered while no Plan runs and the Draft is known
  // (`docs/UI_FLOW.md` 10.3); its pre-start judgement follows every re-read or
  // change of the Build List. The judgement is display only: each press reads
  // and judges again.
  const creationOffered =
    loaded && runningPlan.status === 'none' && (draftPlan.status === 'none' || draftPlan.status === 'draft') && entries.length > 0
  useEffect(() => {
    if (creationOffered) refreshPreStart()
  }, [creationOffered, entries, refreshPreStart])
  // The ordinary Planner bound the user reviews (U7). It reaches the ordinary
  // Planner runs and the replan Preview as `PlannerInput.options`; the Build
  // List optimization never reads it. The one Accordion is placed by the
  // creation section or the replan, each rendering it only while an operation
  // that reads it is offered or shown (Issue #359).
  const maxPlanStepsInvalid = plannerOptions === null
  const plannerDetailSettings = (
    <DisclosureAccordion
      title={productionPlannerDetailSettingsTitle}
      headingLevel="h3"
      expanded={plannerSettingsExpanded}
      onExpandedChange={setPlannerSettingsExpanded}
    >
      <Stack spacing={1.5}>
        <Stack spacing={0.5}>
          {productionPlannerDetailSettingsDescriptionLines.map((line) => (
            <Typography variant="body2" color="text.secondary" key={line}>
              {line}
            </Typography>
          ))}
        </Stack>
        {/* One field only (Issue #103 Phase D-1): the Production scheduler's
            safety bound. Its width is capped on wide screens so the helper
            text keeps a readable line length. */}
        <TextField
          fullWidth
          label={productionPlannerMaxPlanStepsField.label}
          type="number"
          value={optionInputs.maxPlanSteps}
          error={maxPlanStepsInvalid}
          helperText={
            maxPlanStepsInvalid
              ? plannerOptionInvalidMessage
              : productionPlannerMaxPlanStepsField.helperText
          }
          onChange={(event) => setEditedOptionInputs({ maxPlanSteps: event.target.value })}
          slotProps={{ htmlInput: { min: 1, step: 1 } }}
          sx={{ maxWidth: { md: 560 } }}
        />
        {/* Back to the current Build List's recommended bound, never a fixed
            1000: the field follows the recommendation again until edited. */}
        <Button
          variant="outlined"
          onClick={() => setEditedOptionInputs(null)}
          sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          既定値に戻す
        </Button>
      </Stack>
    </DisclosureAccordion>
  )
  return (
    <PageShell
      title="ビルドリスト"
      description="生産計画（Planner）で検討する候補を確認し、生産計画を作成します。"
    >
      <Stack spacing={{ xs: 2, md: 3 }}>
        {loading && <LinearProgress aria-label="ビルドリストを読み込み中" />}
        {loadError && <Alert severity="error">{loadError}</Alert>}
        {removeError && <Alert severity="error">{removeError}</Alert>}
        {removeNotice && (
          <Alert severity="info" onClose={() => setRemoveNotice(null)}>
            {removeNotice}
          </Alert>
        )}

        {loaded && (
          <PageSection title="ページ概要">
            <Box
              component="ul"
              sx={{
                m: 0,
                p: 0,
                display: 'grid',
                gridTemplateColumns: {
                  xs: 'repeat(2, minmax(0, 1fr))',
                  sm: 'repeat(3, minmax(0, 1fr))',
                },
                gap: 1.5,
              }}
            >
              <SummaryTile label="登録候補" value={entries.length} note="件" />
              <SummaryTile label="目標武器" value={groups.length} note="件" />
              <SummaryTile
                label="再検索が必要な候補"
                value={staleCount}
                // The count keeps its meaning (every stale Entry). Entries the
                // `active` Plan keeps using are named, so 「含まれません」 never
                // reads as true of them (18.3).
                note={
                  inUseStaleEntryIds.size > 0
                    ? `うち${inUseStaleEntryIds.size}件は実行中の生産計画で使用中`
                    : staleCount > 0 ? '生産計画に含まれません' : '件'
                }
              />
            </Box>
          </PageSection>
        )}

        {loaded && entries.length === 0 && (
          // The link sits inside the message rather than in the Alert action
          // slot, so it wraps under the text at 375px with a full-height
          // touch target instead of squeezing the message beside it.
          <Alert severity="info">
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2">
                ビルドリストは空です。検索結果から候補を追加してください。
              </Typography>
              <Button
                component={RouterLink}
                to="/search"
                variant="outlined"
                color="inherit"
                sx={{ minHeight: 44 }}
              >
                候補検索へ
              </Button>
            </Stack>
          </Alert>
        )}

        {loaded && runningPlan.status === 'error' && (
          <Alert severity="error">
            実行中の生産計画を確認できないため、生産計画の作成と再計画の試算はできません。
          </Alert>
        )}

        {loaded && runningPlan.status === 'none' && pendingReplanRequest !== null && (
          <Alert severity="info" onClose={dismissReplanRequest}>
            {RUNNING_PLAN_REPLAN_REQUEST_NO_RUNNING_PLAN_MESSAGE}
          </Alert>
        )}

        {loaded && draftPlan.status === 'error' && (
          // A failed Draft read is never "no Draft": the save would replace
          // something the page cannot name, so the ordinary creation waits
          // (`docs/UI_FLOW.md` 10.3).
          <Alert severity="error">
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2">
                未開始の生産計画（下書き）を確認できないため、生産計画の作成はできません。生産計画一覧で状態を確認してください。
              </Typography>
              <Button component={RouterLink} to="/plans" variant="outlined" color="inherit" sx={{ minHeight: 44 }}>
                生産計画一覧を見る
              </Button>
            </Stack>
          </Alert>
        )}

        {loaded && draftPlan.status === 'draft' && (
          // The current Draft (`docs/DATA_MODEL.md` 11.1). Read-only guidance:
          // beside a running Plan it is still shown, and no second Draft
          // creation is offered there (`docs/UI_FLOW.md` 10.3).
          <Alert severity="info">
            <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Typography variant="body2">
                {runningPlan.status === 'running'
                  ? '未開始の下書きも保存されています。'
                  : '未開始の生産計画があります。'}
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignSelf: 'stretch' }}>
                <Button
                  component={RouterLink}
                  to={`/plans/${draftPlan.plan.id}`}
                  variant="outlined"
                  color="inherit"
                  sx={{ minHeight: 44 }}
                >
                  下書きを開く
                </Button>
                <Button component={RouterLink} to="/plans" variant="outlined" color="inherit" sx={{ minHeight: 44 }}>
                  生産計画一覧を見る
                </Button>
              </Stack>
            </Stack>
          </Alert>
        )}

        {loaded && runningPlan.status === 'running' && (
          // 16.5 / 18: while a Plan runs, the Build List offers the replan from
          // the current point instead of a second, independent Draft.
          <PageSection title="現在地点からの再計画" accent headingRef={replanHeadingRef}>
            <Alert severity="info">
              <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  実行中の生産計画（{productionPlanStatusLabels[runningPlan.plan.status]}）があります。
                  作る目標武器を見直す場合は、現在地点から再計画を試算できます。採用すると、現在の生産計画を終了し、新しい生産計画を実行中にします。
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignSelf: 'stretch' }}>
                  <Button
                    component={RouterLink}
                    to={`/plans/${runningPlan.plan.id}`}
                    variant="outlined"
                    color="inherit"
                    sx={{ minHeight: 44 }}
                  >
                    実行中の生産計画を見る
                  </Button>
                  {runningPlan.plan.status === 'active' && runningPlanUnsafe === null && (
                    <Button
                      component={RouterLink}
                      to={`/plans/${runningPlan.plan.id}/run`}
                      variant="outlined"
                      color="inherit"
                      sx={{ minHeight: 44 }}
                    >
                      実行ナビを再開する
                    </Button>
                  )}
                </Stack>
              </Stack>
            </Alert>
            {runningPlanUnsafe !== null && (
              <CompletionAssignmentConflictAlert
                title="実行中の生産計画は続行できません"
                issues={runningPlanUnsafe.issues}
                names={completionAssignmentNamesOf(targets, ownedWeapons)}
                debugMode={debugMode}
                recovery={<Typography variant="body2">{COMPLETION_ASSIGNMENT_REPLAN_NOTE}</Typography>}
              />
            )}
            {masterForDisplay && (
              <RunningPlanReplanPanel
                controller={executionReplan}
                master={masterForDisplay}
                debugMode={debugMode}
                plannerOptions={plannerOptions}
                runningPlan={runningPlan.plan}
                passiveNote={replanCandidateNote}
                // U7: the ordinary Planner's setting. Only the replan's explicit
                // auxiliary (「登録済みの候補で再計画を試算」) reads it - and says
                // beside itself when the value is invalid - so the panel shows it
                // only with that auxiliary (Issue #359); the re-optimization
                // never reads it.
                ordinaryPlannerSettings={plannerDetailSettings}
              />
            )}
          </PageSection>
        )}

        {creationOffered && masterForDisplay && (
          <PageSection title="生産計画の作成" accent>
            <BuildListPlanCreationSection
              controller={planCreation}
              master={masterForDisplay}
              debugMode={debugMode}
              plannerOptions={plannerOptions}
              currentDraft={draftPlan.status === 'draft' ? draftPlan.plan : null}
              detailSettings={plannerDetailSettings}
              completionAssignmentNames={completionAssignmentNamesOf(targets, ownedWeapons)}
            />
          </PageSection>
        )}

        {loaded && entries.length > 0 && masterForDisplay && (
          <Stack component="section" aria-labelledby={entriesHeadingId} spacing={2} sx={{ minWidth: 0 }}>
            <Typography id={entriesHeadingId} component="h2" variant="h2">
              候補一覧
            </Typography>
            {planCreation.busy && (
              <Typography variant="body2" color="text.secondary">
                {PLAN_CREATION_BUILD_LIST_LOCKED_NOTE}
              </Typography>
            )}
            <WeaponListFilterBar
              label="作成リストの絞り込み"
              filter={filter}
              onChange={setFilter}
              weaponTypes={getEnabledWeaponTypes(masterForDisplay)}
              elements={getEnabledElements(masterForDisplay)}
              totalCount={groups.length}
              shownCount={shownGroups.length}
              unit="件"
              countLabel="目標武器"
            />
            {isWeaponListFilterActive(filter) && (
              <Alert severity="info">
                目標武器の武器種・属性で表示だけを絞り込んでいます。生産計画の作成と再計画の試算は、絞り込みに関係なく作成リストのすべての候補を対象にします。
              </Alert>
            )}
            {shownGroups.length > 0 && (
              <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  role="group"
                  aria-label="候補一覧の開閉"
                  sx={{ flexWrap: 'wrap' }}
                >
                  <Button
                    variant="outlined"
                    onClick={() => setShownGroupsExpanded(true)}
                    sx={{ minHeight: 44, flex: { xs: '1 1 0', sm: '0 0 auto' } }}
                  >
                    すべて展開
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => setShownGroupsExpanded(false)}
                    sx={{ minHeight: 44, flex: { xs: '1 1 0', sm: '0 0 auto' } }}
                  >
                    すべて折りたたむ
                  </Button>
                </Stack>
                {isWeaponListFilterActive(filter) && (
                  <Typography variant="caption" color="text.secondary">
                    すべて展開・すべて折りたたむは、表示中の目標武器だけが対象です。
                  </Typography>
                )}
              </Stack>
            )}
            {shownGroups.length === 0 && (
              <WeaponListFilterEmpty
                message="条件に一致する目標武器の候補はありません。"
                onClear={() => setFilter(emptyWeaponListFilter)}
              />
            )}
            {shownGroups.map((group) => (
              <TargetGroupSection
                key={group.targetWeaponId}
                group={group}
                legacyDuplicate={legacyDuplicateTargetIds.has(group.targetWeaponId)}
                inUseStaleEntryIds={inUseStaleEntryIds}
                weaponLabel={weaponLabelOf(group.target)}
                expanded={expandedTargetIds.has(group.targetWeaponId)}
                onExpandedChange={(expanded) => setGroupExpanded(group.targetWeaponId, expanded)}
              >
                {group.entries.map((entry) => (
                  <Box
                    component="li"
                    key={entry.id}
                    sx={{
                      border: 1,
                      borderColor: entry.isStale && !inUseStaleEntryIds.has(entry.id) ? 'warning.main' : 'divider',
                      borderRadius: 1,
                      p: { xs: 1.5, md: 2 },
                      minWidth: 0,
                    }}
                  >
                    <Stack spacing={1.5}>
                      <Typography variant="caption" color="text.secondary" className="tabular-nums">
                        追加日時: {entry.createdAt}
                      </Typography>
                      {entry.isStale && inUseStaleEntryIds.has(entry.id) && (
                        // The `active` Plan keeps using this Entry and only its
                        // planned progress made it stale: the Plan continues, so
                        // no new search is asked for (18.3). The reasons stay.
                        <Alert severity="info">
                          <AlertTitle>{RUNNING_PLAN_IN_USE_STALE_TITLE}</AlertTitle>
                          <Stack spacing={0.5}>
                            {RUNNING_PLAN_IN_USE_STALE_LINES.map((line) => (
                              <Typography variant="body2" key={line} sx={{ overflowWrap: 'anywhere' }}>
                                {line}
                              </Typography>
                            ))}
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {RUNNING_PLAN_IN_USE_STALE_REASONS_LABEL}
                            </Typography>
                            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                              {entry.staleReasons.map((reason) => (
                                <Typography component="li" variant="body2" key={reason}>
                                  {staleReasonLabels[reason]}
                                </Typography>
                              ))}
                            </Box>
                          </Stack>
                        </Alert>
                      )}
                      {entry.isStale && !inUseStaleEntryIds.has(entry.id) && (
                        <Alert severity="warning">
                          <AlertTitle>再検索が必要</AlertTitle>
                          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                            {entry.staleReasons.map((reason) => (
                              <Typography component="li" variant="body2" key={reason}>
                                {staleReasonLabels[reason]}
                              </Typography>
                            ))}
                          </Box>
                          <Typography variant="body2" sx={{ mt: 0.5 }}>
                            この候補は生産計画に含まれません。候補検索をやり直して、候補を追加し直してください。内容は下で確認できます。
                          </Typography>
                        </Alert>
                      )}
                      {/* The Candidate Snapshot stored on the Entry is the
                          display authority; the current Search result is never
                          re-fetched (`docs/UI_FLOW.md` 10). */}
                      <CandidateCard
                        candidate={entry.candidateSnapshot}
                        target={group.target}
                        master={masterForDisplay}
                        ownedWeapons={ownedWeapons}
                        debugMode={debugMode}
                        headingLevel="h4"
                      />
                      {debugMode && (
                        <Alert severity="info">
                          Entry ID: {entry.id}<br />
                          targetDefinitionHash: {entry.targetDefinitionHash}<br />
                          searchStateHash: {entry.searchStateHash}<br />
                          referencedOwnedWeaponsHash: {entry.referencedOwnedWeaponsHash ?? 'null'}
                        </Alert>
                      )}
                      <Button
                        color="error"
                        variant="text"
                        disabled={planGuard.deciding || planCreation.busy}
                        onClick={() => void remove(entry)}
                        sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
                      >
                        ビルドリストから削除
                      </Button>
                    </Stack>
                  </Box>
                ))}
              </TargetGroupSection>
            ))}
          </Stack>
        )}
      </Stack>
      <PlanBreakingChangeDialog
        controller={planGuard}
        // The Plan this page holds resolves the save point's Step; display only.
        savePointPositionLabel={(inspection) =>
          runningPlan.status === 'running' && runningPlan.plan.id === inspection.observedPlan.planId
            ? savePointPositionLabel(runningPlan.plan, inspection.savePointCurrentStepId)
            : null
        }
      />
    </PageShell>
  )
}
