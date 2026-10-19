import { useCallback, useEffect, useId, useMemo, useState } from 'react'
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
import { Link as RouterLink } from 'react-router-dom'
import { DialogFormError } from '../components/DialogFormError'
import { DisclosureAccordion } from '../components/DisclosureAccordion'
import { OwnedIdealCompletionDialog } from '../components/target/OwnedIdealCompletionDialog'
import { OwnedIdealWeaponNotice } from '../components/target/OwnedIdealWeaponNotice'
import {
  COMPLETED_TARGETS_HEADING,
  formatCompletedAt,
  REOPEN_TARGET_LABEL,
  REOPEN_TARGET_LINES,
  REOPEN_TARGET_PLAN_BREAKING_NOTE,
  REOPEN_TARGET_TITLE,
  targetLifecycleErrorMessage,
} from '../components/target/ownedIdealPresentation'
import { useOwnedIdealCompletion, type OwnedIdealCompletionApi } from '../components/target/useOwnedIdealCompletion'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import { usePlanBreakingChangeApproval } from '../components/execution/usePlanBreakingChangeApproval'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../domain/execution'
import { PageShell } from '../components/PageShell'
import { StatusChip } from '../components/StatusChip'
import { BonusSlotList, ManagementListItem } from '../components/ManagementListItem'
import { BonusSetEditor } from '../components/forms/BonusSetEditor'
import { TargetCompromiseEditor } from '../components/forms/TargetCompromiseEditor'
import {
  findOwnedIdealWeaponsForTarget,
  hasTargetCompromise,
  isCompatiblePreferredOwnedWeapon,
  isEligiblePreferredOwnedWeapon,
} from '../domain/target'
import { SkillConditionEditor } from '../components/forms/SkillConditionEditor'
import { skillConditionSummary } from '../components/search/searchPresentation'
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
import { sortByRegistrationOrder, upsertPreservingOrder } from '../presentation/managementListOrder'
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

const NO_PREFERRED_OWNED_WEAPON = ''

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
): number {
  if (weapon.id === currentPreferredId) return 0
  if (weapon.isProtected) return 3
  return claimedByOtherTarget ? 2 : 1
}

/** The confirmation 「未完了に戻す」 needs (`docs/UI_FLOW.md` 8.3). */
function ReopenTargetDialog({
  target,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  target: TargetWeapon | null
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
  delete(id: TargetWeapon['id'], approval?: PlanBreakingChangeApproval | null): Promise<void>
  /** The read-only breaking-change inspection of that very delete. */
  inspectDelete(id: TargetWeapon['id']): Promise<PlanBreakingChangeInspection>
  /** The preferred-origin candidates shown in the edit dialog, and the owned Ideal notice's input. */
  getOwnedWeapons(): Promise<OwnedWeapon[]>
  /** The read-only breaking-change inspection of returning that Target to active (`docs/UI_FLOW.md` 8.3). */
  inspectReopen(id: TargetWeapon['id']): Promise<PlanBreakingChangeInspection>
  reopen(id: TargetWeapon['id'], approval?: PlanBreakingChangeApproval | null): Promise<TargetWeapon>
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
            delete: (id, approval) => defaultService.delete(id, approval ?? null),
            inspectDelete: (id) => defaultService.inspectDelete(id),
            getOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
            inspectCompleteWithOwnedIdeal: (targetId, weaponId) =>
              defaultLifecycleService.inspectCompleteWithOwnedIdeal(targetId, weaponId),
            completeWithOwnedIdeal: (targetId, weaponId, approval) =>
              defaultLifecycleService.completeWithOwnedIdeal(targetId, weaponId, undefined, approval ?? null),
            inspectReopen: (id) => defaultLifecycleService.inspectReopen(id),
            reopen: (id, approval) => defaultLifecycleService.reopen(id, undefined, approval ?? null),
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
  // An approved breaking change ends the `active` Plan, which clears the
  // in-progress marks of the weapons this list offers: it is re-read afterwards.
  const [loadSequence, setLoadSequence] = useState(0)
  // The breaking-change warning of every save and delete (`docs/UI_FLOW.md` 16.3).
  const planGuard = usePlanBreakingChangeApproval()
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
  const completion = useOwnedIdealCompletion({ api, planGuard, targets, onApplied: onCompletionApplied })
  // 「未完了に戻す」 (`docs/UI_FLOW.md` 8.3), behind its own confirmation.
  const [reopening, setReopening] = useState<TargetWeapon | null>(null)
  const [reopenSubmitting, setReopenSubmitting] = useState(false)
  const [reopenError, setReopenError] = useState<string | null>(null)
  // Display-only filter of the active list (`docs/UI_FLOW.md` 3.2 / 8): never
  // persisted, and never a Search / Planner input.
  const [filter, setFilter] = useState<WeaponListFilter>(emptyWeaponListFilter)

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
  const weaponTypes = getEnabledWeaponTypes(master)
  const elements = getEnabledElements(master)
  // The ordinary list holds active Targets only; completed ones sit in their
  // own read-only section (`docs/UI_FLOW.md` 8 / 8.3).
  const activeTargets = targets.filter(({ lifecycleStatus }) => lifecycleStatus === 'active')
  const completedTargets = targets.filter(({ lifecycleStatus }) => lifecycleStatus === 'completed')
  const shownActiveTargets = activeTargets.filter((target) => matchesWeaponListFilter(target, filter))
  // The owned Ideal notice per active Target (`docs/UI_FLOW.md` 8.2), judged by
  // the shared Domain authority from the loaded Targets and weapons - after a
  // save too, with no reload. A judgement failure is reported, never read as
  // "no owned Ideal".
  const ownedIdealByTarget = new Map<string, OwnedGogmaArtianWeapon[]>()
  let ownedIdealEvaluationError: string | null = null
  if (!loading && !loadFailed) {
    for (const target of activeTargets) {
      try {
        ownedIdealByTarget.set(target.id, findOwnedIdealWeaponsForTarget(target, ownedWeapons, master))
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
    setDraft(null)
    setFormError(null)
  }

  const save = async () => {
    if (!api || !draft) return
    try {
      // The inspection and the save close over the same draft against the same
      // shown Target; the runtime alone judges the whole post-state, the
      // takeover release included.
      const outcome = await planGuard.run({
        inspect: () => api.inspectSave(draft, editing),
        apply: (approval) => api.save(draft, editing, approval),
        note: TARGET_WEAPON_PLAN_BREAKING_NOTE,
      })
      if (outcome.status === 'cancelled') return
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
          ? caught.issues.join(' / ')
          : caught instanceof Error
            ? caught.message
            : '保存できません。',
      )
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
      })
      if (outcome.status === 'cancelled') return
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
      isEligiblePreferredOwnedWeapon({ weaponTypeId, elementId }, preferred)
    return {
      ...value,
      weaponTypeId,
      elementId,
      preferredOwnedWeaponId: keepsPreferred
        ? value.preferredOwnedWeaponId
        : null,
      idealBonuses: createDefaultBonusSet(
        master,
        weaponTypeId,
        elementId,
        'gogma_artian',
      ),
      practicalBonusConditions: [],
      alternativeBonusRules: [],
    }
  }

  // Compatible weapons only, protected ones included so the user can see why
  // they cannot be chosen. Status is deliberately not a filter: a Material,
  // Practical, or Ideal weapon is equally selectable (`docs/UI_FLOW.md` 8.1).
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
          return {
            weapon,
            holder,
            selectable: !weapon.isProtected,
            group: preferredOptionGroup(
              weapon,
              draft.preferredOwnedWeaponId,
              holder !== null,
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
      description="欲しい完成武器の理想条件と実用条件を管理します。"
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
              />
            </Box>
          )}
          {loading && <LinearProgress aria-label="目標武器を読み込み中" />}
          {!loading && !loadFailed && activeTargets.length === 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, py: 3, borderTop: 1, borderColor: 'divider' }}>
              <Typography>{targets.length === 0 ? '目標武器は未登録です。' : '未完了の目標武器はありません。'}</Typography>
              <Typography variant="body2" color="text.secondary">
                「目標武器を追加」から、欲しい完成武器の理想条件を登録します。
              </Typography>
            </Box>
          )}
          {!loading && activeTargets.length > 0 && shownActiveTargets.length === 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, py: 3, borderTop: 1, borderColor: 'divider' }}>
              <WeaponListFilterEmpty
                message="条件に一致する目標武器はありません。"
                onClear={() => setFilter(emptyWeaponListFilter)}
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
                      <BonusSlotList
                        heading="理想ボーナス"
                        bonuses={target.idealBonuses}
                        weaponTypeId={target.weaponTypeId}
                        master={master}
                        scope="gogma_artian"
                      />
                      <Typography variant="body2">
                        理想スキル: {skillConditionSummary(target.idealSkillCondition, master)}
                      </Typography>
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
                      <Typography variant="caption" color="text.secondary">
                        妥協条件
                      </Typography>
                      {hasTargetCompromise(target) ? (
                        <Typography variant="body2">
                          実用ボーナス条件 {target.practicalBonusConditions.length}件
                          {' ／ '}代替ボーナス条件 {target.alternativeBonusRules.length}件
                          <br />
                          実用スキル: {skillConditionSummary(target.practicalSkillCondition, master)}
                        </Typography>
                      ) : (
                        <Typography variant="body2">妥協なし（理想のみ検索）</Typography>
                      )}
                      {target.compromiseNeedsReview && (
                        <>
                          <StatusChip label="妥協条件の再設定が必要" tone="caution" />
                          <Typography variant="body2" color="text.secondary">
                            条件の仕様変更により旧妥協条件を解除しました。理想条件を保持しています。実用・代替・実用スキルを確認して再設定してください。
                          </Typography>
                        </>
                      )}
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
                  or preference control. The weapon that completed a Target is not
                  persisted on it, so none is guessed here. */}
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
                        ({ weapon, holder, selectable }) => (
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
                            {weapon.isProtected
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
                <BonusSetEditor
                  label="理想の復元ボーナス5枠"
                  master={master}
                  weaponTypeId={draft.weaponTypeId}
                  elementId={draft.elementId}
                  scope="gogma_artian"
                  value={draft.idealBonuses}
                  onChange={(idealBonuses) =>
                    setDraft({ ...draft, idealBonuses })
                  }
                />
                <TargetCompromiseEditor target={draft} master={master} onChange={(conditions) => setDraft({ ...draft, ...conditions })} />
                <Stack spacing={2}>
                  <Typography variant="body2" color="text.secondary">実用スキルの指定がない場合、スキルは理想条件だけを許可します。ボーナスが実用・代替の場合も、実用スキルと組み合わせられます。</Typography>
                  <SkillConditionEditor
                    label="理想スキル条件"
                    master={master}
                    value={draft.idealSkillCondition}
                    onChange={(idealSkillCondition) =>
                      setDraft({ ...draft, idealSkillCondition })
                    }
                  />
                  <SkillConditionEditor
                    label="実用スキル条件"
                    master={master}
                    value={draft.practicalSkillCondition}
                    onChange={(practicalSkillCondition) =>
                      setDraft({ ...draft, practicalSkillCondition })
                    }
                  />
                </Stack>
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
            <Button onClick={closeDialog} disabled={planGuard.busy} sx={{ minHeight: 44 }}>キャンセル</Button>
            <Button variant="contained" disabled={planGuard.busy} onClick={() => void save()} sx={{ minHeight: 44, minWidth: 96 }}>
              保存
            </Button>
          </DialogActions>
        </Dialog>
        <OwnedIdealCompletionDialog
          pending={completion.pending}
          affectedTargets={completion.affectedTargets}
          submitting={completion.submitting}
          error={completion.error}
          onCancel={completion.cancel}
          onConfirm={() => void completion.confirm()}
        />
        <ReopenTargetDialog
          target={reopening}
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
        <PlanBreakingChangeDialog controller={planGuard} />
      </Stack>
    </PageShell>
  )
}
