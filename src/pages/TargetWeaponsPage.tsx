import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import { DialogFormError } from '../components/DialogFormError'
import { DisclosureAccordion } from '../components/DisclosureAccordion'
import { OwnedIdealCompletionDialog } from '../components/target/OwnedIdealCompletionDialog'
import { OwnedIdealWeaponNotice } from '../components/target/OwnedIdealWeaponNotice'
import { TargetCompletionOverlapDialog } from '../components/target/TargetCompletionOverlapDialog'
import type { CompletionOverlapSaveMode } from '../components/target/completionOverlapPresentation'
import {
  COMPLETED_TARGETS_HEADING,
  formatCompletedAt,
  REOPEN_TARGET_LABEL,
  REOPEN_TARGET_LINES,
  reopenTargetCompletionWeaponLine,
  REOPEN_TARGET_PLAN_BREAKING_NOTE,
  REOPEN_TARGET_TITLE,
  targetLifecycleErrorMessage,
} from '../components/target/ownedIdealPresentation'
import { useOwnedIdealCompletion, type OwnedIdealCompletionApi } from '../components/target/useOwnedIdealCompletion'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import {
  runningPlanReplanExclusionRequest,
  runningPlanReplanNavigationState,
} from '../components/execution/runningPlanReplanRequest'
import {
  usePlanBreakingChangeApproval,
  type PlanBreakingReplanExclusionRequest,
} from '../components/execution/usePlanBreakingChangeApproval'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../domain/execution'
import { PageShell } from '../components/PageShell'
import { StatusChip } from '../components/StatusChip'
import { ManagementListItem } from '../components/ManagementListItem'
import { CompletionBonusVariantsEditor } from '../components/forms/CompletionBonusVariantsEditor'
import {
  CompletionConditionReviewStatus,
  CompletionConditionSummary,
} from '../components/target/CompletionConditionSummary'
import {
  COMPLETION_CONDITION_REVIEW_DIALOG_LEAD,
  COMPLETION_CONDITION_REVIEW_DIALOG_TITLE,
  COMPLETION_CONDITION_REVIEW_FILTER_LABEL,
  COMPLETION_CONDITION_REVIEW_SAVE_NOTE,
  completionConditionReviewGuidance,
  completionConditionReviewListNotice,
  completionConditionReviewReasonLabels,
  completionConditionReviewSectionNotes,
  targetFormValidationIssuesText,
} from '../components/target/completionConditionPresentation'
import {
  collectCompletionAssignedOwnedWeaponIds,
  completionBonusVariantFromBonuses,
  findOwnedIdealWeaponsForTarget,
  isCompatiblePreferredOwnedWeapon,
  isEligiblePreferredOwnedWeapon,
  type TargetCompletionOverlapConfirmation,
} from '../domain/target'
import { SkillConditionEditor } from '../components/forms/SkillConditionEditor'
import { MasterDataStatusAlert } from '../components/MasterDataStatusAlert'
import { loadMasterData } from '../domain/master/loadMasterData'
import {
  getEnabledElements,
  getEnabledWeaponTypes,
} from '../domain/master/masterSelectors'
import {
  createDefaultBonusSet,
  createTargetWeaponDraft,
  MasterOptionsUnavailableError,
} from '../domain/forms/entityDrafts'
import type {
  OwnedGogmaArtianWeapon,
  OwnedWeapon,
  TargetWeapon,
} from '../domain/models/publicTypes'
import { ownedWeaponRepository } from '../db/repositories'
import { artianWeaponKindLabels, ownedWeaponStatusLabels } from '../presentation/labels'
import { compareByRegistrationOrder, sortByRegistrationOrder, upsertPreservingOrder } from '../presentation/managementListOrder'
import {
  emptyWeaponListFilter,
  matchesWeaponListFilter,
  type WeaponListFilter,
} from '../presentation/weaponListFilter'
import { WeaponListFilterBar, WeaponListFilterEmpty } from '../components/WeaponListFilterBar'
import {
  EntityFormValidationError,
  ReferencedEntityDeleteError,
  TargetWeaponCrudService,
  type TargetWeaponDraft,
} from '../services/crud/entityCrudServices'
import { getPersistenceReferenceKindLabel } from '../presentation/labels'
import {
  TargetWeaponLifecycleService,
  type TargetOwnedIdealCompletion,
} from '../services/crud/targetWeaponLifecycleService'
import {
  createRunningPlanReplanGuidanceReader,
  type RunningPlanReplanGuidanceReader,
} from '../services/execution/runningPlanReplanGuidanceService'

const NO_PREFERRED_OWNED_WEAPON = ''

/** Whether the Target carries a completion condition review reason (`docs/UI_FLOW.md` 8.4). Display only. */
function needsCompletionConditionReview(target: Pick<TargetWeapon, 'completionConditionReview'>): boolean {
  return target.completionConditionReview.length > 0
}

/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
const TARGET_WEAPON_PLAN_BREAKING_NOTE =
  'この目標武器を変更すると、現在の生産計画の前提と一致しなくなります。'
const TARGET_WEAPON_DELETE_PLAN_BREAKING_NOTE =
  'この目標武器を削除すると、現在の生産計画の前提と一致しなくなります。'
const PLAN_ABANDONED_SUFFIX = '実行中の生産計画を破棄しました。'

/** See `OwnedWeaponsPage`: a narrower margin on smartphone, actions outside the scroll. */
const dialogPaperSx = {
  m: { xs: 1, sm: 4 },
  width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
  maxHeight: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
}

/**
 * The Target edit dropdown order of `docs/UI_FLOW.md` 8.1.
 *
 * Group 0 is the weapon this Target currently prefers, 1 an unassigned
 * unprotected weapon, 2 one another Target already prefers, and 3 a protected
 * one, which is shown but never selectable so the user can see why it is
 * unavailable. Within a group the existing stable order - display name, then ID
 * - decides, so the list never depends on load order.
 */
function preferredOptionGroup(
  weapon: OwnedWeapon,
  currentPreferredId: string | null,
  claimedByOtherTarget: boolean,
  completionAssigned: boolean,
): number {
  if (weapon.id === currentPreferredId) return 0
  if (weapon.isProtected || completionAssigned) return 3
  return claimedByOtherTarget ? 2 : 1
}

const COMPLETION_WEAPON_NAME_UNKNOWN = '名前を確認できない所持武器'

/**
 * 「完成に使った武器」 of a completed Target (Issue #334, `docs/UI_FLOW.md` 8.3):
 * the recorded completion assignment by name, or 「記録なし」 with how to record
 * one for a Target completed before the assignment existed. No weapon is
 * guessed.
 */
function CompletionWeaponLine({ target, weaponName }: { target: TargetWeapon; weaponName: string | null }) {
  if (weaponName !== null) {
    return (
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        完成に使った武器: {weaponName}
      </Typography>
    )
  }
  return (
    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        完成に使った武器: 記録なし
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {`「${target.name}」は完成に使った武器を記録する前に完了したため、どの武器で完成したか分かりません。記録したい場合は「未完了に戻す」のあと「この武器で目標を完了にする」で完了し直してください。`}
      </Typography>
    </Stack>
  )
}

/** The confirmation 「未完了に戻す」 needs (`docs/UI_FLOW.md` 8.3). */
function ReopenTargetDialog({
  target,
  completionWeaponName,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  target: TargetWeapon | null
  /** The recorded completion weapon's name; `null` when it cannot be resolved. */
  completionWeaponName: string | null
  submitting: boolean
  error: string | null
  onCancel(): void
  onConfirm(): void
}) {
  const titleId = useId()
  const descriptionId = useId()
  if (target === null) return null
  return (
    <Dialog open onClose={onCancel} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <DialogTitle id={titleId}>{REOPEN_TARGET_TITLE}</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId} component="div">
          <Typography component="p" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            目標武器「{target.name}」を未完了に戻します。
          </Typography>
          {REOPEN_TARGET_LINES.map((line) => (
            <Typography component="p" variant="body2" key={line} sx={{ mt: 1 }}>
              {line}
            </Typography>
          ))}
          {target.completedWithOwnedWeaponId !== null && (
            <Typography component="p" variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
              {reopenTargetCompletionWeaponLine(completionWeaponName ?? COMPLETION_WEAPON_NAME_UNKNOWN)}
            </Typography>
          )}
        </DialogContentText>
      </DialogContent>
      {error !== null && <DialogFormError message={error} />}
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}>
          キャンセル
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={submitting} sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}>
          {REOPEN_TARGET_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

const masterResult = loadMasterData()

export interface TargetWeaponsPageDependencies extends OwnedIdealCompletionApi {
  getAll(): Promise<TargetWeapon[]>
  /** `approval` is the breaking-change approval when the inspection required one (`docs/UI_FLOW.md` 16.3). */
  save(
    draft: TargetWeaponDraft,
    existing: TargetWeapon | null,
    approval?: PlanBreakingChangeApproval | null,
  ): Promise<TargetWeapon>
  /** The read-only breaking-change inspection of that very save. */
  inspectSave(draft: TargetWeaponDraft, existing: TargetWeapon | null): Promise<PlanBreakingChangeInspection>
  /**
   * The read-only completion condition overlap inspection of that very save
   * (Issue #338, `docs/UI_FLOW.md` 8.5): the save's own input validation first
   * (`EntityFormValidationError`), then the other active Targets to confirm,
   * judged from the latest stored Targets. Writes nothing.
   */
  inspectCompletionOverlap(
    draft: TargetWeaponDraft,
    existing: TargetWeapon | null,
  ): Promise<TargetCompletionOverlapConfirmation[]>
  delete(id: TargetWeapon['id'], approval?: PlanBreakingChangeApproval | null): Promise<void>
  /** The read-only breaking-change inspection of that very delete. */
  inspectDelete(id: TargetWeapon['id']): Promise<PlanBreakingChangeInspection>
  /** The preferred-origin candidates shown in the edit dialog, and the owned Ideal notice's input. */
  getOwnedWeapons(): Promise<OwnedWeapon[]>
  /** The read-only breaking-change inspection of returning that Target to active (`docs/UI_FLOW.md` 8.3). */
  inspectReopen(id: TargetWeapon['id']): Promise<PlanBreakingChangeInspection>
  reopen(id: TargetWeapon['id'], approval?: PlanBreakingChangeApproval | null): Promise<TargetWeapon>
  /**
   * The read-only running Plan replan guidance (Issue #276 PR-6B): whether the
   * breaking-change warning of a Plan-dependent Target may offer to leave the
   * change unsaved and exclude the Target in a replan instead.
   */
  replanGuidance: RunningPlanReplanGuidanceReader
}

function deleteReferenceMessage(error: ReferencedEntityDeleteError) {
  return `参照中のため削除できません: ${error.references
    .map(
      (reference) =>
        `${getPersistenceReferenceKindLabel(reference.kind)}（${reference.entityId}）`,
    )
    .join(' / ')}`
}

export function TargetWeaponsPage({
  dependencies,
}: {
  dependencies?: TargetWeaponsPageDependencies
}) {
  const defaultService = useMemo(
    () => (masterResult.ok ? new TargetWeaponCrudService(masterResult.data) : null),
    [],
  )
  const defaultLifecycleService = useMemo(
    () => (masterResult.ok ? new TargetWeaponLifecycleService(masterResult.data) : null),
    [],
  )
  const api = useMemo<TargetWeaponsPageDependencies | null>(
    () =>
      dependencies ??
      (defaultService && defaultLifecycleService
        ? {
            getAll: () => defaultService.getAll(),
            save: (draft, existing, approval) => defaultService.save(draft, existing, undefined, approval ?? null),
            inspectSave: (draft, existing) => defaultService.inspectSave(draft, existing),
            inspectCompletionOverlap: (draft, existing) => defaultService.inspectSaveCompletionOverlap(draft, existing),
            delete: (id, approval) => defaultService.delete(id, approval ?? null),
            inspectDelete: (id) => defaultService.inspectDelete(id),
            getOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
            inspectCompleteWithOwnedIdeal: (targetId, weaponId) =>
              defaultLifecycleService.inspectCompleteWithOwnedIdeal(targetId, weaponId),
            completeWithOwnedIdeal: (targetId, weaponId, approval) =>
              defaultLifecycleService.completeWithOwnedIdeal(targetId, weaponId, undefined, approval ?? null),
            inspectReopen: (id) => defaultLifecycleService.inspectReopen(id),
            reopen: (id, approval) => defaultLifecycleService.reopen(id, undefined, approval ?? null),
            replanGuidance: createRunningPlanReplanGuidanceReader(),
          }
        : null),
    [defaultLifecycleService, defaultService, dependencies],
  )
  const [targets, setTargets] = useState<TargetWeapon[]>([])
  const [ownedWeapons, setOwnedWeapons] = useState<OwnedWeapon[]>([])
  const [loading, setLoading] = useState(api !== null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState<TargetWeapon | null>(null)
  const [draft, setDraft] = useState<TargetWeaponDraft | null>(null)
  const [error, setError] = useState<string | null>(
    api ? null : 'マスターデータが利用できません。',
  )
  // Page-level `error` covers load / delete. An add / edit failure belongs to
  // the open Dialog, where the modal keeps it reachable next to 保存.
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // One add / edit save at a time, from the overlap inspection to the guarded
  // save: 保存 stays disabled and a second press is ignored (Issue #338).
  const [savePending, setSavePending] = useState(false)
  const savePendingRef = useRef(false)
  // The completion condition overlap confirmation the paused save waits on
  // (`docs/UI_FLOW.md` 8.5). Never persisted.
  const [overlapPrompt, setOverlapPrompt] = useState<{
    confirmations: TargetCompletionOverlapConfirmation[]
    mode: CompletionOverlapSaveMode
    resolve(confirmed: boolean): void
  } | null>(null)
  const saveButtonRef = useRef<HTMLButtonElement>(null)
  // 「編集へ戻る」 returns focus to 保存 once the paused save has settled and 保存
  // is enabled again.
  const restoreSaveFocusRef = useRef(false)
  useEffect(() => {
    if (!savePending && restoreSaveFocusRef.current) {
      restoreSaveFocusRef.current = false
      saveButtonRef.current?.focus()
    }
  }, [savePending])
  // An approved breaking change ends the `active` Plan, which clears the
  // in-progress marks of the weapons this list offers: it is re-read afterwards.
  const [loadSequence, setLoadSequence] = useState(0)
  // The breaking-change warning of every save and delete (`docs/UI_FLOW.md` 16.3).
  // For a Plan-dependent Target it may also offer to leave the change unsaved
  // and exclude the Target in a replan (Issue #276 PR-6B); the guard's
  // judgement, approval and save are untouched.
  const replanGuidance = api?.replanGuidance
  const planGuard = usePlanBreakingChangeApproval({
    replanExclusion: replanGuidance === undefined
      ? undefined
      : (planId, targetWeaponId) => replanGuidance.canExcludeInReplan(planId, targetWeaponId),
  })
  const navigate = useNavigate()
  /** 「保存せずに再計画を開く」: nothing was saved; the Build List's replan opens with the Target left out, and calculates nothing. */
  const openReplanExclusion = useCallback((request: PlanBreakingReplanExclusionRequest) => {
    void navigate('/build-list', {
      state: runningPlanReplanNavigationState(runningPlanReplanExclusionRequest(request.planId, request.targetWeaponId)),
    })
  }, [navigate])
  const listHeadingId = useId()
  const completedHeadingId = useId()
  const preferredHelpId = useId()
  // 「この武器で目標を完了にする」 (`docs/UI_FLOW.md` 8.2): the Service result is
  // mirrored into the lists without a reload - the completed Target, the
  // protected weapon and the released preferences alike.
  const onCompletionApplied = useCallback((result: TargetOwnedIdealCompletion, planAbandoned: boolean) => {
    const released = new Set<string>(result.releasedTargetIds)
    setTargets((current) =>
      upsertPreservingOrder(current, result.target).map((target) =>
        released.has(target.id) ? { ...target, preferredOwnedWeaponId: null } : target,
      ),
    )
    setOwnedWeapons((current) => upsertPreservingOrder(current, result.ownedWeapon))
    setNotice(
      planAbandoned
        ? `目標武器「${result.target.name}」を完了にし、${PLAN_ABANDONED_SUFFIX}`
        : `目標武器「${result.target.name}」を完了にしました。`,
    )
    setError(null)
    if (planAbandoned) setLoadSequence((sequence) => sequence + 1)
  }, [])
  const completion = useOwnedIdealCompletion({
    api,
    planGuard,
    targets,
    master: masterResult.ok ? masterResult.data : null,
    onApplied: onCompletionApplied,
    onReplanExclusion: openReplanExclusion,
  })
  // 「未完了に戻す」 (`docs/UI_FLOW.md` 8.3), behind its own confirmation.
  const [reopening, setReopening] = useState<TargetWeapon | null>(null)
  const [reopenSubmitting, setReopenSubmitting] = useState(false)
  const [reopenError, setReopenError] = useState<string | null>(null)
  // Display-only filter of the active list (`docs/UI_FLOW.md` 3.2 / 8): never
  // persisted, and never a Search / Planner input.
  const [filter, setFilter] = useState<WeaponListFilter>(emptyWeaponListFilter)
  // 「完成条件の再設定が必要な目標武器だけ表示」 (`docs/UI_FLOW.md` 8.4): display
  // only too, combined with the weapon type / element filter.
  const [reviewOnly, setReviewOnly] = useState(false)
  const clearFilters = () => {
    setFilter(emptyWeaponListFilter)
    setReviewOnly(false)
  }

  useEffect(() => {
    if (!api) return
    let active = true
    void Promise.all([api.getAll(), api.getOwnedWeapons()])
      .then(([loaded, loadedWeapons]) => {
        if (active) {
          // Loaded in registration order; later saves keep the in-place /
          // append contract through `upsertPreservingOrder` (UI_FLOW 3.2).
          setTargets(sortByRegistrationOrder(loaded))
          setOwnedWeapons(loadedWeapons)
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setLoadFailed(true)
          setError(
            caught instanceof Error
              ? caught.message
              : '目標武器を読み込めません。',
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, loadSequence])

  if (!masterResult.ok) {
    return (
      <PageShell title="目標武器" description="欲しい完成武器を管理します。">
        <Alert severity="error">マスターデータが利用できません。</Alert>
      </PageShell>
    )
  }

  const master = masterResult.data
  // The completion assignments (Issue #334, `docs/DATA_MODEL.md` 8.7) through the
  // one Domain authority, for display only: the Services re-check everything.
  const completionAssignments = collectCompletionAssignedOwnedWeaponIds(targets)
  const targetById = new Map(targets.map((target) => [target.id, target]))
  const ownedWeaponById = new Map(ownedWeapons.map((weapon) => [weapon.id, weapon]))
  const weaponTypes = getEnabledWeaponTypes(master)
  const elements = getEnabledElements(master)
  // The ordinary list holds active Targets only; completed ones sit in their
  // own read-only section (`docs/UI_FLOW.md` 8 / 8.3).
  const activeTargets = targets.filter(({ lifecycleStatus }) => lifecycleStatus === 'active')
  const completedTargets = targets.filter(({ lifecycleStatus }) => lifecycleStatus === 'completed')
  const reviewTargetCount = activeTargets.filter(needsCompletionConditionReview).length
  const shownActiveTargets = activeTargets.filter(
    (target) => matchesWeaponListFilter(target, filter) && (!reviewOnly || needsCompletionConditionReview(target)),
  )
  // The owned Ideal notice per active Target (`docs/UI_FLOW.md` 8.2), judged by
  // the shared Domain authority from the loaded Targets and weapons - after a
  // save too, with no reload. A judgement failure is reported, never read as
  // "no owned Ideal".
  const ownedIdealByTarget = new Map<string, OwnedGogmaArtianWeapon[]>()
  let ownedIdealEvaluationError: string | null = null
  if (!loading && !loadFailed) {
    for (const target of activeTargets) {
      try {
        ownedIdealByTarget.set(target.id, findOwnedIdealWeaponsForTarget(target, ownedWeapons, master, targets))
      } catch (caught: unknown) {
        ownedIdealEvaluationError = `既所持の理想武器を判定できませんでした: ${caught instanceof Error ? caught.message : String(caught)}`
        break
      }
    }
  }
  const weaponTypeName = (id: string) => weaponTypes.find((type) => type.id === id)?.displayNameJa ?? id
  const elementName = (id: string) => elements.find((element) => element.id === id)?.displayNameJa ?? id
  const openNew = () => {
    try {
      setEditing(null)
      setDraft(createTargetWeaponDraft(master))
      setFormError(null)
      setError(null)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '入力選択肢がありません。',
      )
    }
  }

  const openEdit = (target: TargetWeapon) => {
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...value
    } = target
    void _id
    void _createdAt
    void _updatedAt
    setEditing(target)
    setDraft(structuredClone(value))
    setFormError(null)
  }

  const closeDialog = () => {
    // A save in progress keeps its dialog: the overlap confirmation and the
    // breaking-change warning both return to it.
    if (savePendingRef.current) return
    setDraft(null)
    setFormError(null)
  }

  const settleOverlapPrompt = (confirmed: boolean) => {
    if (overlapPrompt === null) return
    setOverlapPrompt(null)
    // A promise settles once, so a second press before the close is a no-op.
    overlapPrompt.resolve(confirmed)
  }

  const save = async () => {
    if (!api || !draft || savePendingRef.current || planGuard.busy) return
    // Every step closes over this very draft against this very shown Target,
    // so what the user confirmed is what is saved.
    const pendingDraft = draft
    const pendingEditing = editing
    savePendingRef.current = true
    setSavePending(true)
    try {
      // `docs/UI_FLOW.md` 8.5: (1) the input validation and (2) the completion
      // condition overlap confirmation come before (3) the breaking-change
      // confirmation and (4) the save. The inspection runs the save's own
      // validation first, so an invalid input is reported here and never
      // asked about; going back saves nothing and keeps the draft.
      const confirmations = await api.inspectCompletionOverlap(pendingDraft, pendingEditing)
      if (confirmations.length > 0) {
        const confirmed = await new Promise<boolean>((resolve) => {
          setOverlapPrompt({
            confirmations: [...confirmations].sort((left, right) => compareByRegistrationOrder(left.target, right.target)),
            mode: pendingEditing === null ? 'new' : 'edit',
            resolve,
          })
        })
        if (!confirmed) {
          restoreSaveFocusRef.current = true
          return
        }
      }
      // The inspection and the save close over the same draft against the same
      // shown Target; the runtime alone judges the whole post-state, the
      // takeover release included, and re-validates everything.
      const outcome = await planGuard.run({
        inspect: () => api.inspectSave(pendingDraft, pendingEditing),
        apply: (approval) => api.save(pendingDraft, pendingEditing, approval),
        note: TARGET_WEAPON_PLAN_BREAKING_NOTE,
        // Only an existing Target can be one the running Plan makes.
        ...(pendingEditing === null ? {} : { replanExclusionTargetWeaponId: pendingEditing.id }),
      })
      if (outcome.status === 'cancelled') {
        if (outcome.replanExclusion !== undefined) {
          // The edit is left unsaved: the dialog closes, then the replan opens.
          setDraft(null)
          setEditing(null)
          setFormError(null)
          openReplanExclusion(outcome.replanExclusion)
        }
        return
      }
      if (outcome.status === 'refused') {
        setFormError(outcome.message)
        return
      }
      const saved = outcome.result
      // A new Target is appended and an edited one stays where it was; the
      // released previous holder keeps its place too (`docs/UI_FLOW.md` 3.2).
      setTargets((current) =>
        upsertPreservingOrder(current, saved).map((target) =>
          // The Service released the previous holder in the same transaction,
          // so the list must show that release too (`docs/UI_FLOW.md` 8.1).
          target.id !== saved.id &&
          saved.preferredOwnedWeaponId !== null &&
          target.preferredOwnedWeaponId === saved.preferredOwnedWeaponId
            ? { ...target, preferredOwnedWeaponId: null }
            : target,
        ),
      )
      setDraft(null)
      setEditing(null)
      setFormError(null)
      setNotice(outcome.planAbandoned ? `目標武器を保存し、${PLAN_ABANDONED_SUFFIX}` : '目標武器を保存しました。')
      setError(null)
      if (outcome.planAbandoned) setLoadSequence((sequence) => sequence + 1)
    } catch (caught: unknown) {
      setFormError(
        caught instanceof EntityFormValidationError
          ? targetFormValidationIssuesText(caught.issues)
          : caught instanceof Error
            ? caught.message
            : '保存できません。',
      )
    } finally {
      savePendingRef.current = false
      setSavePending(false)
    }
  }

  const remove = async (target: TargetWeapon) => {
    if (!api || planGuard.busy || !window.confirm(`${target.name}を削除しますか？`)) return
    try {
      // The existing reference protection refuses inside the inspection, so a
      // referenced Target is reported as before and never warned about.
      const outcome = await planGuard.run({
        inspect: () => api.inspectDelete(target.id),
        apply: (approval) => api.delete(target.id, approval),
        note: TARGET_WEAPON_DELETE_PLAN_BREAKING_NOTE,
        replanExclusionTargetWeaponId: target.id,
      })
      if (outcome.status === 'cancelled') {
        // Nothing was deleted; 「保存せずに再計画を開く」 opens the replan with the Target left out.
        if (outcome.replanExclusion !== undefined) openReplanExclusion(outcome.replanExclusion)
        return
      }
      if (outcome.status === 'refused') {
        setError(outcome.message)
        return
      }
      setTargets((current) => current.filter(({ id }) => id !== target.id))
      setNotice(outcome.planAbandoned ? `目標武器を削除し、${PLAN_ABANDONED_SUFFIX}` : '目標武器を削除しました。')
      setError(null)
      if (outcome.planAbandoned) setLoadSequence((sequence) => sequence + 1)
    } catch (caught: unknown) {
      setError(
        caught instanceof ReferencedEntityDeleteError
          ? deleteReferenceMessage(caught)
          : caught instanceof Error
            ? caught.message
            : '削除できません。',
      )
    }
  }

  const reopen = async () => {
    if (!api || reopening === null || reopenSubmitting) return
    setReopenSubmitting(true)
    setReopenError(null)
    try {
      // The inspection and the save name the same Target; the runtime re-reads
      // it inside its own transaction and touches no owned weapon.
      const outcome = await planGuard.run({
        inspect: () => api.inspectReopen(reopening.id),
        apply: (approval) => api.reopen(reopening.id, approval),
        note: REOPEN_TARGET_PLAN_BREAKING_NOTE,
      })
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'refused') {
        setReopenError(outcome.message)
        return
      }
      setTargets((current) => upsertPreservingOrder(current, outcome.result))
      setReopening(null)
      setNotice(
        outcome.planAbandoned
          ? `目標武器「${outcome.result.name}」を未完了に戻し、${PLAN_ABANDONED_SUFFIX}`
          : `目標武器「${outcome.result.name}」を未完了に戻しました。`,
      )
      setError(null)
      if (outcome.planAbandoned) setLoadSequence((sequence) => sequence + 1)
    } catch (caught: unknown) {
      setReopenError(
        targetLifecycleErrorMessage(caught) ?? (caught instanceof Error ? caught.message : '未完了に戻せません。'),
      )
    } finally {
      setReopenSubmitting(false)
    }
  }

  const resetBonusConditions = (
    value: TargetWeaponDraft,
    weaponTypeId: string,
    elementId: string,
  ): TargetWeaponDraft => {
    // Changing the Target's own definition can make its preferred weapon
    // incompatible. Clearing it here touches the draft only; nothing is written
    // until save, and this is never treated as taking a weapon from another
    // Target (`docs/UI_FLOW.md` 8.1).
    const preferred = ownedWeapons.find(
      ({ id }) => id === value.preferredOwnedWeaponId,
    )
    const keepsPreferred =
      preferred !== undefined &&
      isEligiblePreferredOwnedWeapon({ weaponTypeId, elementId }, preferred, completionAssignments)
    return {
      ...value,
      weaponTypeId,
      elementId,
      preferredOwnedWeaponId: keepsPreferred
        ? value.preferredOwnedWeaponId
        : null,
      // The weapon type / element decides every slot's choices, so the
      // completion Variants restart from one default Variant
      // (`docs/UI_FLOW.md` 8).
      completionBonusVariants: [
        completionBonusVariantFromBonuses(
          createDefaultBonusSet(master, weaponTypeId, elementId, 'gogma_artian'),
          crypto.randomUUID(),
        ),
      ],
    }
  }

  // Compatible weapons only, protected ones and completion-assigned ones
  // included so the user can see why they cannot be chosen. Status is
  // deliberately not a filter: a Material, Practical, or Ideal weapon is equally
  // selectable (`docs/UI_FLOW.md` 8.1). A weapon that is the completion of a
  // Target (Issue #334, `docs/DATA_MODEL.md` 8.7) is never a preferred origin,
  // even once unprotected.
  const preferredOwnedWeaponOptions = draft
    ? ownedWeapons
        .filter((weapon) => isCompatiblePreferredOwnedWeapon(draft, weapon))
        .map((weapon) => {
          const holder =
            targets.find(
              (target) =>
                target.id !== editing?.id &&
                target.preferredOwnedWeaponId === weapon.id,
            ) ?? null
          const assignedTargetId = completionAssignments.get(weapon.id)
          const completedTarget = assignedTargetId === undefined ? null : (targetById.get(assignedTargetId) ?? null)
          return {
            weapon,
            holder,
            completedTarget,
            selectable: !weapon.isProtected && !completionAssignments.has(weapon.id),
            group: preferredOptionGroup(
              weapon,
              draft.preferredOwnedWeaponId,
              holder !== null,
              completionAssignments.has(weapon.id),
            ),
          }
        })
        .sort(
          (left, right) =>
            left.group - right.group ||
            left.weapon.name.localeCompare(right.weapon.name) ||
            left.weapon.id.localeCompare(right.weapon.id),
        )
    : []

  return (
    <PageShell
      title="目標武器"
      description="欲しい完成武器の完成条件（完成ボーナス構成と完成スキル）を管理します。"
      actions={
        <Button variant="contained" onClick={openNew} sx={{ minHeight: 44 }}>
          目標武器を追加
        </Button>
      }
    >
      <Stack spacing={2}>
        <MasterDataStatusAlert master={master} />
        {error && <Alert severity="error">{error}</Alert>}
        {ownedIdealEvaluationError && <Alert severity="error">{ownedIdealEvaluationError}</Alert>}
        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {!loading && !loadFailed && reviewTargetCount > 0 && !reviewOnly && (
          <Alert
            severity="warning"
            // A standing notice, not an interruption: read politely.
            role="status"
            action={
              <Button color="inherit" onClick={() => setReviewOnly(true)} sx={{ minHeight: 44 }}>
                該当する目標武器を表示
              </Button>
            }
            sx={{ flexWrap: { xs: 'wrap', sm: 'nowrap' }, '& .MuiAlert-action': { ml: { xs: 0, sm: 'auto' }, pl: { xs: 0, sm: 2 } } }}
          >
            {completionConditionReviewListNotice(reviewTargetCount)}
          </Alert>
        )}
        <Paper
          component="section"
          variant="outlined"
          aria-labelledby={listHeadingId}
          sx={{ overflow: 'hidden' }}
        >
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ px: { xs: 2, md: 2.5 }, py: 2, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}
          >
            <Typography id={listHeadingId} component="h2" variant="h2">
              登録済みの目標武器
            </Typography>
            {!loading && !loadFailed && (
              <Typography variant="body2" color="text.secondary" className="tabular-nums">
                {activeTargets.length}件（有効 {activeTargets.filter(({ isEnabled }) => isEnabled).length}件）
              </Typography>
            )}
          </Stack>
          {!loading && !loadFailed && activeTargets.length > 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, pb: 2 }}>
              <WeaponListFilterBar
                label="目標武器の絞り込み"
                filter={filter}
                onChange={setFilter}
                weaponTypes={weaponTypes}
                elements={elements}
                totalCount={activeTargets.length}
                shownCount={shownActiveTargets.length}
                unit="件"
                additionalFilterActive={reviewOnly}
                onClearAll={clearFilters}
              >
                {(reviewTargetCount > 0 || reviewOnly) && (
                  <FormControlLabel
                    sx={{ minHeight: 44, mr: 0 }}
                    control={
                      <Checkbox
                        checked={reviewOnly}
                        onChange={(event) => setReviewOnly(event.target.checked)}
                      />
                    }
                    label={`${COMPLETION_CONDITION_REVIEW_FILTER_LABEL}（${reviewTargetCount}件）`}
                  />
                )}
              </WeaponListFilterBar>
            </Box>
          )}
          {loading && <LinearProgress aria-label="目標武器を読み込み中" />}
          {!loading && !loadFailed && activeTargets.length === 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, py: 3, borderTop: 1, borderColor: 'divider' }}>
              <Typography>{targets.length === 0 ? '目標武器は未登録です。' : '未完了の目標武器はありません。'}</Typography>
              <Typography variant="body2" color="text.secondary">
                「目標武器を追加」から、欲しい完成武器の完成条件を登録します。
              </Typography>
            </Box>
          )}
          {!loading && activeTargets.length > 0 && shownActiveTargets.length === 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, py: 3, borderTop: 1, borderColor: 'divider' }}>
              <WeaponListFilterEmpty
                message="条件に一致する目標武器はありません。"
                onClear={clearFilters}
              />
            </Box>
          )}
          {!loading && shownActiveTargets.length > 0 && (
            <Box component="ul" aria-labelledby={listHeadingId} sx={{ m: 0, p: 0 }}>
              {shownActiveTargets.map((target) => (
                <ManagementListItem
                  key={target.id}
                  title={target.name}
                  muted={!target.isEnabled}
                  badges={
                    <>
                      <StatusChip
                        label={target.isEnabled ? '有効' : '無効'}
                        tone={target.isEnabled ? 'positive' : 'neutral'}
                      />
                      <StatusChip label={`優先度 ${target.priority}`} tone="info" />
                    </>
                  }
                  summary={
                    <Typography variant="body2" color="text.secondary">
                      {weaponTypes.find(({ id }) => id === target.weaponTypeId)?.displayNameJa}
                      {' / '}
                      {elements.find(({ id }) => id === target.elementId)?.displayNameJa}
                    </Typography>
                  }
                  detail={
                    <Stack spacing={1}>
                      <CompletionConditionSummary target={target} master={master} />
                      {(ownedIdealByTarget.get(target.id)?.length ?? 0) > 0 && (
                        <OwnedIdealWeaponNotice
                          target={target}
                          weapons={ownedIdealByTarget.get(target.id) ?? []}
                          master={master}
                          onComplete={(weapon) => completion.begin(target, weapon)}
                          disabled={planGuard.busy || completion.pending !== null}
                        />
                      )}
                    </Stack>
                  }
                  status={
                    <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
                      <CompletionConditionReviewStatus target={target} />
                      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        優先起点:{' '}
                        {ownedWeapons.find(({ id }) => id === target.preferredOwnedWeaponId)?.name ?? 'なし'}
                      </Typography>
                    </Stack>
                  }
                  onEdit={() => openEdit(target)}
                  onDelete={() => void remove(target)}
                />
              ))}
            </Box>
          )}
        </Paper>
        {!loading && !loadFailed && completedTargets.length > 0 && (
          <Paper component="section" variant="outlined" aria-labelledby={completedHeadingId} sx={{ overflow: 'hidden' }}>
            <Typography id={completedHeadingId} component="h2" variant="h2" sx={{ px: { xs: 2, md: 2.5 }, pt: 2, pb: 1 }}>
              {COMPLETED_TARGETS_HEADING}
            </Typography>
            <Box sx={{ px: { xs: 2, md: 2.5 }, pb: 2 }}>
              {/* Read-only history (`docs/UI_FLOW.md` 8.3): no edit, delete, enablement
                  or preference control. The weapon that completed a Target is its
                  recorded completion assignment (Issue #334); a Target completed
                  before the assignment existed shows 「記録なし」, never a guess. */}
              <DisclosureAccordion title={`完了済みの目標武器（${completedTargets.length}件）`} headingLevel="h3">
                <Box component="ul" aria-label={COMPLETED_TARGETS_HEADING} sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1.5 }}>
                  {completedTargets.map((target) => (
                    <Stack
                      component="li"
                      key={target.id}
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1.5}
                      sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', minWidth: 0, borderTop: 1, borderColor: 'divider', pt: 1.5 }}
                    >
                      <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                        <Typography component="h4" variant="h3" sx={{ overflowWrap: 'anywhere' }}>
                          {target.name}
                        </Typography>
                        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                          <StatusChip label="完了済み" tone="positive" />
                          <Typography variant="body2" color="text.secondary">
                            {weaponTypeName(target.weaponTypeId)} / {elementName(target.elementId)}
                          </Typography>
                        </Stack>
                        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                          完了日時: {target.completedAt === null ? '不明' : formatCompletedAt(target.completedAt)}
                        </Typography>
                        <CompletionWeaponLine
                          target={target}
                          weaponName={
                            target.completedWithOwnedWeaponId === null
                              ? null
                              : (ownedWeaponById.get(target.completedWithOwnedWeaponId)?.name ?? COMPLETION_WEAPON_NAME_UNKNOWN)
                          }
                        />
                        {target.completedByProductionPlanId !== null && (
                          <Button
                            component={RouterLink}
                            to={`/plans/${target.completedByProductionPlanId}`}
                            variant="text"
                            sx={{ minHeight: 44, alignSelf: 'flex-start', px: 0 }}
                          >
                            完成に使った生産計画を見る
                          </Button>
                        )}
                      </Stack>
                      <Button
                        variant="outlined"
                        onClick={() => {
                          setReopening(target)
                          setReopenError(null)
                        }}
                        disabled={planGuard.busy || reopening !== null}
                        aria-label={`${target.name}を${REOPEN_TARGET_LABEL}`}
                        sx={{ minHeight: 44, flexShrink: 0 }}
                      >
                        {REOPEN_TARGET_LABEL}
                      </Button>
                    </Stack>
                  ))}
                </Box>
              </DisclosureAccordion>
            </Box>
          </Paper>
        )}
        <Dialog
          open={draft !== null}
          onClose={closeDialog}
          fullWidth
          maxWidth="md"
          slotProps={{ paper: { sx: dialogPaperSx } }}
        >
          <DialogTitle sx={{ px: { xs: 2, sm: 3 } }}>
            {editing ? '目標武器を編集' : '目標武器を追加'}
          </DialogTitle>
          {draft && (
            <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
              <Stack spacing={3}>
                {draft.completionConditionReview.length > 0 && (
                  // `docs/UI_FLOW.md` 8.4: the reasons, in words, what to check
                  // for each, and that the explicit save - never closing - is
                  // what makes the Target calculable again.
                  <Alert severity="warning">
                    <Stack spacing={1}>
                      <Typography component="h3" variant="body1" sx={{ fontWeight: 700 }}>
                        {COMPLETION_CONDITION_REVIEW_DIALOG_TITLE}
                      </Typography>
                      <Typography variant="body2">{COMPLETION_CONDITION_REVIEW_DIALOG_LEAD}</Typography>
                      <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
                        {draft.completionConditionReview.map((reason) => (
                          <li key={reason}>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>
                              {completionConditionReviewReasonLabels[reason]}
                            </Typography>
                            <Typography variant="body2">{completionConditionReviewGuidance[reason]}</Typography>
                          </li>
                        ))}
                      </Box>
                      <Typography variant="body2">{COMPLETION_CONDITION_REVIEW_SAVE_NOTE}</Typography>
                    </Stack>
                  </Alert>
                )}
                <Stack component="section" spacing={1.5}>
                  <Typography component="h3" variant="h3">基本情報</Typography>
                  <TextField
                    label="名前"
                    required
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.7fr)' }, gap: 1.5 }}>
                    <FormControl fullWidth>
                      <InputLabel id="target-weapon-type">武器種</InputLabel>
                      <Select
                        labelId="target-weapon-type"
                        label="武器種"
                        value={draft.weaponTypeId}
                        onChange={(event) => {
                          try {
                            setDraft(
                              resetBonusConditions(
                                draft,
                                event.target.value,
                                draft.elementId,
                              ),
                            )
                          } catch (caught) {
                            if (
                              caught instanceof MasterOptionsUnavailableError
                            ) {
                              setFormError(caught.message)
                            }
                          }
                        }}
                      >
                        {weaponTypes.map((type) => (
                          <MenuItem key={type.id} value={type.id}>
                            {type.displayNameJa}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth>
                      <InputLabel id="target-element">属性</InputLabel>
                      <Select
                        labelId="target-element"
                        label="属性"
                        value={draft.elementId}
                        onChange={(event) => {
                          try {
                            setDraft(
                              resetBonusConditions(
                                draft,
                                draft.weaponTypeId,
                                event.target.value,
                              ),
                            )
                          } catch (caught) {
                            if (
                              caught instanceof MasterOptionsUnavailableError
                            ) {
                              setFormError(caught.message)
                            }
                          }
                        }}
                      >
                        {elements.map((element) => (
                          <MenuItem key={element.id} value={element.id}>
                            {element.displayNameJa}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth>
                      <InputLabel id="target-priority">優先度</InputLabel>
                      <Select
                        labelId="target-priority"
                        label="優先度"
                        value={draft.priority}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            priority: Number(
                              event.target.value,
                            ) as TargetWeapon['priority'],
                          })
                        }
                      >
                        {[1, 2, 3, 4, 5].map((value) => (
                          <MenuItem key={value} value={value}>
                            {value}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Box>
                  <FormControlLabel
                    sx={{ minHeight: 44, alignSelf: 'flex-start' }}
                    control={
                      <Checkbox
                        checked={draft.isEnabled}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            isEnabled: event.target.checked,
                          })
                        }
                      />
                    }
                    label="有効"
                  />
                </Stack>
                <Stack component="section" spacing={1}>
                  <Typography component="h3" variant="h3">優先する所持武器</Typography>
                  <FormControl fullWidth>
                    <InputLabel id="target-preferred-owned-weapon">
                      優先する所持武器
                    </InputLabel>
                    <Select
                      labelId="target-preferred-owned-weapon"
                      label="優先する所持武器"
                      aria-describedby={preferredHelpId}
                      value={
                        draft.preferredOwnedWeaponId ?? NO_PREFERRED_OWNED_WEAPON
                      }
                      onChange={(event) => {
                        const value = event.target.value
                        if (value === NO_PREFERRED_OWNED_WEAPON) {
                          setDraft({ ...draft, preferredOwnedWeaponId: null })
                          return
                        }
                        const holder = targets.find(
                          (target) =>
                            target.id !== editing?.id &&
                            target.preferredOwnedWeaponId === value,
                        )
                        if (
                          holder &&
                          !window.confirm(
                            `この武器は現在「${holder.name}」の優先起点に設定されています。\n` +
                              `この目標武器に変更すると、「${holder.name}」との紐づけは解除されます。\n` +
                              '変更しますか？',
                          )
                        ) {
                          return
                        }
                        setDraft({
                          ...draft,
                          preferredOwnedWeaponId:
                            value as TargetWeapon['preferredOwnedWeaponId'],
                        })
                      }}
                    >
                      <MenuItem value={NO_PREFERRED_OWNED_WEAPON}>指定なし</MenuItem>
                      {preferredOwnedWeaponOptions.map(
                        ({ weapon, holder, completedTarget, selectable }) => (
                          <MenuItem
                            key={weapon.id}
                            value={weapon.id}
                            disabled={!selectable}
                            // Long weapon / Target names wrap instead of being
                            // cut off inside a narrow menu.
                            sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                          >
                            {`${artianWeaponKindLabels[weapon.kind]} / ${weapon.name}`}
                            {weapon.kind === 'gogma'
                              ? ` / ${ownedWeaponStatusLabels[weapon.status]}`
                              : ''}
                            {completedTarget
                              ? ` [${completedTarget.name}の完成品・選択不可]`
                              : weapon.isProtected
                                ? ' [保護中・選択不可]'
                                : holder
                                  ? ` [${holder.name}に割当中]`
                                  : ''}
                          </MenuItem>
                        ),
                      )}
                    </Select>
                  </FormControl>
                  <Typography id={preferredHelpId} variant="body2" color="text.secondary">
                    この目標を作る際の起点として優先します。
                    より短い作成ルートがある場合は、そちらが選ばれることがあります。
                  </Typography>
                </Stack>
                <CompletionBonusVariantsEditor
                  master={master}
                  weaponTypeId={draft.weaponTypeId}
                  elementId={draft.elementId}
                  value={draft.completionBonusVariants}
                  onChange={(completionBonusVariants) => {
                    setDraft({ ...draft, completionBonusVariants })
                    // A save error names Variants by their former numbers;
                    // the editor's own messages follow the edit instead.
                    setFormError(null)
                  }}
                  createVariantId={() => crypto.randomUUID()}
                  reviewNote={
                    draft.completionConditionReview.includes('compromise_conditions_removed')
                      ? completionConditionReviewSectionNotes.compromise_conditions_removed
                      : null
                  }
                />
                <SkillConditionEditor
                  label="完成スキル条件"
                  master={master}
                  value={draft.completionSkillCondition}
                  onChange={(completionSkillCondition) =>
                    setDraft({ ...draft, completionSkillCondition })
                  }
                  reviewNote={
                    draft.completionConditionReview.includes('skill_condition_normalized')
                      ? completionConditionReviewSectionNotes.skill_condition_normalized
                      : null
                  }
                />
                <TextField
                  label="メモ"
                  multiline
                  minRows={2}
                  value={draft.memo ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      memo: event.target.value || null,
                    })
                  }
                />
              </Stack>
            </DialogContent>
          )}
          {/* Outside the scrolling content, directly above 保存: a failure
              reported after saving from the bottom of a long form stays in
              view instead of scrolling out at the top, and a very long one
              scrolls inside its own bounded region (`docs/UI_FLOW.md` 3.1). */}
          {formError && <DialogFormError message={formError} />}
          {/* Never shrinks: 保存 / キャンセル stay reachable however long the
              form or the error is. */}
          <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5, gap: 1, flexShrink: 0 }}>
            <Button onClick={closeDialog} disabled={planGuard.busy || savePending} sx={{ minHeight: 44 }}>キャンセル</Button>
            <Button
              ref={saveButtonRef}
              variant="contained"
              disabled={planGuard.busy || savePending}
              onClick={() => void save()}
              sx={{ minHeight: 44, minWidth: 96 }}
            >
              保存
            </Button>
          </DialogActions>
        </Dialog>
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
        <ReopenTargetDialog
          target={reopening}
          completionWeaponName={
            reopening?.completedWithOwnedWeaponId != null
              ? (ownedWeaponById.get(reopening.completedWithOwnedWeaponId)?.name ?? null)
              : null
          }
          submitting={reopenSubmitting}
          error={reopenError}
          onCancel={() => {
            if (!reopenSubmitting) {
              setReopening(null)
              setReopenError(null)
            }
          }}
          onConfirm={() => void reopen()}
        />
        <TargetCompletionOverlapDialog
          confirmations={overlapPrompt?.confirmations ?? null}
          mode={overlapPrompt?.mode ?? 'new'}
          onBack={() => settleOverlapPrompt(false)}
          onContinue={() => settleOverlapPrompt(true)}
        />
        <PlanBreakingChangeDialog controller={planGuard} />
      </Stack>
    </PageShell>
  )
}
