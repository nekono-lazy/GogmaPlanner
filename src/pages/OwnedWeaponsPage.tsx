import { useEffect, useId, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { DialogFormError } from '../components/DialogFormError'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import { usePlanBreakingChangeApproval } from '../components/execution/usePlanBreakingChangeApproval'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../domain/execution'
import { PageShell } from '../components/PageShell'
import { StatusChip } from '../components/StatusChip'
import { BonusSlotList, ManagementListItem } from '../components/ManagementListItem'
import { BonusSetEditor } from '../components/forms/BonusSetEditor'
import { MasterDataStatusAlert } from '../components/MasterDataStatusAlert'
import { loadMasterData } from '../domain/master/loadMasterData'
import type { ArtianBonusScope } from '../domain/master/masterTypes'
import {
  getEnabledElements,
  getEnabledWeaponTypes,
  getGroupSkillOptions,
  getSeriesSkillOptions,
} from '../domain/master/masterSelectors'
import {
  createDefaultBonusSet,
  createOwnedWeaponDraft,
  MasterOptionsUnavailableError,
} from '../domain/forms/entityDrafts'
import type {
  OwnedWeapon,
  OwnedWeaponStatus,
  TargetWeapon,
} from '../domain/models/publicTypes'
import { targetWeaponRepository } from '../db/repositories'
import {
  EntityFormValidationError,
  OwnedWeaponCrudService,
  ReferencedEntityDeleteError,
  type OwnedWeaponDraft,
} from '../services/crud/entityCrudServices'
import {
  artianWeaponKindLabels,
  getPersistenceReferenceKindLabel,
  ownedWeaponStatusLabels,
  restorationBonusScopeFieldLabel,
  restorationBonusScopeGogmaHelpText,
  restorationBonusScopeLabels,
} from '../presentation/labels'
import { sortByRegistrationOrder, upsertPreservingOrder } from '../presentation/managementListOrder'
import {
  emptyWeaponListFilter,
  matchesWeaponListFilter,
  type WeaponListFilter,
} from '../presentation/weaponListFilter'
import { WeaponListFilterBar, WeaponListFilterEmpty } from '../components/WeaponListFilterBar'

const masterResult = loadMasterData()

/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
const OWNED_WEAPON_PLAN_BREAKING_NOTE =
  'この所持武器を変更すると、現在の生産計画の前提と一致しなくなります。'
const OWNED_WEAPON_DELETE_PLAN_BREAKING_NOTE =
  'この所持武器を削除すると、現在の生産計画の前提と一致しなくなります。'
const PLAN_ABANDONED_SUFFIX = '実行中の生産計画を破棄しました。'

/**
 * Smartphone: a narrower outer margin so the form keeps a usable width.
 * The title and actions stay outside the scrolling content (MUI `scroll="paper"`),
 * so 保存 / キャンセル remain reachable however long the form is.
 */
const dialogPaperSx = {
  m: { xs: 1, sm: 4 },
  width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
  maxHeight: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
}

export interface OwnedWeaponsPageDependencies {
  getAll(): Promise<OwnedWeapon[]>
  /**
   * Read-only here. Editing the relation belongs to the Target Weapons screen;
   * this screen reads it to show which Target prefers a weapon, and to confirm
   * before a change would break that link (`docs/UI_FLOW.md` 7.1).
   */
  getTargets(): Promise<TargetWeapon[]>
  /** `approval` is the breaking-change approval when the inspection required one (`docs/UI_FLOW.md` 16.3). */
  save(
    draft: OwnedWeaponDraft,
    existing: OwnedWeapon | null,
    approval?: PlanBreakingChangeApproval | null,
  ): Promise<OwnedWeapon>
  /** The read-only breaking-change inspection of that very save. */
  inspectSave(draft: OwnedWeaponDraft, existing: OwnedWeapon | null): Promise<PlanBreakingChangeInspection>
  delete(id: OwnedWeapon['id'], approval?: PlanBreakingChangeApproval | null): Promise<void>
  /** The read-only breaking-change inspection of that very delete. */
  inspectDelete(id: OwnedWeapon['id']): Promise<PlanBreakingChangeInspection>
}

function referenceMessage(error: ReferencedEntityDeleteError): string {
  return `参照中のため削除できません: ${error.references
    .map(
      (reference) =>
        `${getPersistenceReferenceKindLabel(reference.kind)}（${reference.entityId}）`,
    )
    .join(' / ')}`
}

export function OwnedWeaponsPage({
  dependencies,
}: {
  dependencies?: OwnedWeaponsPageDependencies
}) {
  const defaultService = useMemo(
    () => (masterResult.ok ? new OwnedWeaponCrudService(masterResult.data) : null),
    [],
  )
  const api = useMemo<OwnedWeaponsPageDependencies | null>(
    () =>
      dependencies ??
      (defaultService
        ? {
            getAll: () => defaultService.getAll(),
            getTargets: () => targetWeaponRepository.getAllTargetWeapons(),
            save: (draft, existing, approval) => defaultService.save(draft, existing, undefined, approval ?? null),
            inspectSave: (draft, existing) => defaultService.inspectSave(draft, existing),
            delete: (id, approval) => defaultService.delete(id, approval ?? null),
            inspectDelete: (id) => defaultService.inspectDelete(id),
          }
        : null),
    [defaultService, dependencies],
  )
  const [weapons, setWeapons] = useState<OwnedWeapon[]>([])
  const [targets, setTargets] = useState<TargetWeapon[]>([])
  const [loading, setLoading] = useState(api !== null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState<OwnedWeapon | null>(null)
  const [draft, setDraft] = useState<OwnedWeaponDraft | null>(null)
  const [error, setError] = useState<string | null>(
    api ? null : 'マスターデータが利用できません。',
  )
  // Page-level `error` covers load / delete. An add / edit failure belongs to
  // the open Dialog, where the modal keeps it reachable next to 保存.
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // An approved breaking change ends the `active` Plan, which clears the
  // in-progress marks the list shows: the list is re-read afterwards.
  const [loadSequence, setLoadSequence] = useState(0)
  // The breaking-change warning of every save and delete (`docs/UI_FLOW.md` 16.3).
  const planGuard = usePlanBreakingChangeApproval()
  const listHeadingId = useId()
  const kindHelpId = useId()
  // Display-only (`docs/UI_FLOW.md` 3.2 / 7): never persisted, never a query.
  const [filter, setFilter] = useState<WeaponListFilter>(emptyWeaponListFilter)
  const shownWeapons = useMemo(
    () => weapons.filter((weapon) => matchesWeaponListFilter(weapon, filter)),
    [filter, weapons],
  )

  useEffect(() => {
    if (!api) return
    let active = true
    void Promise.all([api.getAll(), api.getTargets()])
      .then(([loaded, loadedTargets]) => {
        if (active) {
          // Loaded in registration order; later saves keep the in-place /
          // append contract through `upsertPreservingOrder` (UI_FLOW 3.2).
          setWeapons(sortByRegistrationOrder(loaded))
          setTargets(loadedTargets)
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setLoadFailed(true)
          setError(
            caught instanceof Error
              ? caught.message
              : '所持武器を読み込めません。',
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
      <PageShell
        title="所持武器"
        description="所持している通常／巨戟アーティアを管理します。"
      >
        <Alert severity="error">マスターデータが利用できません。</Alert>
      </PageShell>
    )
  }

  const master = masterResult.data
  const weaponTypes = getEnabledWeaponTypes(master)
  const elements = getEnabledElements(master)
  // The stored scope is the authority: a Gogma weapon may still hold the
  // `normal_artian` slots it inherited at conversion (`docs/DATA_MODEL.md` 7.1).
  const scopeFor = (value: OwnedWeaponDraft) => value.restorationBonusScope

  const openNew = () => {
    try {
      setEditing(null)
      setDraft(createOwnedWeaponDraft(master))
      setFormError(null)
      setError(null)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '入力選択肢がありません。',
      )
    }
  }

  const openEdit = (weapon: OwnedWeapon) => {
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...value
    } = weapon
    void _id
    void _createdAt
    void _updatedAt
    setEditing(weapon)
    setDraft(structuredClone(value))
    setFormError(null)
  }

  const closeDialog = () => {
    setDraft(null)
    setFormError(null)
  }

  const save = async () => {
    if (!api || !draft) return
    // Protecting, or re-typing, a weapon a Target prefers as its Route origin
    // would leave that Target holding a preference the Domain rejects. Confirm
    // first, then let the Service release the link in the same transaction as
    // the save (`docs/UI_FLOW.md` 7.1).
    const releasedTargets = editing
      ? targets.filter(
          (target) =>
            target.preferredOwnedWeaponId === editing.id &&
            (draft.isProtected ||
              draft.weaponTypeId !== target.weaponTypeId ||
              draft.elementId !== target.elementId),
        )
      : []
    if (releasedTargets.length > 0) {
      const names = releasedTargets.map(({ name }) => name).join('、')
      const reason = draft.isProtected
        ? '保護すると生産計画でこの武器を変更できなくなるため、'
        : '武器種または属性が一致しなくなるため、'
      if (
        !window.confirm(
          `この武器は「${names}」の優先起点に設定されています。\n` +
            `${reason}「${names}」との紐づけを解除します。\n` +
            'よろしいですか？',
        )
      ) {
        return
      }
    }
    try {
      // The inspection and the save close over the same draft against the same
      // shown weapon; the runtime alone judges the whole post-state, the
      // Target releases included.
      const outcome = await planGuard.run({
        inspect: () => api.inspectSave(draft, editing),
        apply: (approval) => api.save(draft, editing, approval),
        note: OWNED_WEAPON_PLAN_BREAKING_NOTE,
      })
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'refused') {
        setFormError(outcome.message)
        return
      }
      const saved = outcome.result
      // A new weapon is appended; an edited one stays where it was
      // (`docs/UI_FLOW.md` 3.2).
      setWeapons((current) => upsertPreservingOrder(current, saved))
      const releasedIds = new Set(releasedTargets.map(({ id }) => id))
      if (releasedIds.size > 0) {
        setTargets((current) =>
          current.map((target) =>
            releasedIds.has(target.id)
              ? { ...target, preferredOwnedWeaponId: null }
              : target,
          ),
        )
      }
      setDraft(null)
      setEditing(null)
      setFormError(null)
      setNotice(outcome.planAbandoned ? `所持武器を保存し、${PLAN_ABANDONED_SUFFIX}` : '所持武器を保存しました。')
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

  const remove = async (weapon: OwnedWeapon) => {
    if (!api || planGuard.busy || !window.confirm(`${weapon.name}を削除しますか？`)) return
    try {
      // The existing reference protection refuses inside the inspection, so a
      // referenced weapon is reported as before and never warned about.
      const outcome = await planGuard.run({
        inspect: () => api.inspectDelete(weapon.id),
        apply: (approval) => api.delete(weapon.id, approval),
        note: OWNED_WEAPON_DELETE_PLAN_BREAKING_NOTE,
      })
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'refused') {
        setError(outcome.message)
        return
      }
      setWeapons((current) => current.filter(({ id }) => id !== weapon.id))
      setNotice(outcome.planAbandoned ? `所持武器を削除し、${PLAN_ABANDONED_SUFFIX}` : '所持武器を削除しました。')
      setError(null)
      if (outcome.planAbandoned) setLoadSequence((sequence) => sequence + 1)
    } catch (caught: unknown) {
      setError(
        caught instanceof ReferencedEntityDeleteError
          ? referenceMessage(caught)
          : caught instanceof Error
            ? caught.message
            : '削除できません。',
      )
    }
  }

  const resetBonuses = (
    value: OwnedWeaponDraft,
    weaponTypeId: string,
    elementId: string,
  ): OwnedWeaponDraft => ({
    ...value,
    weaponTypeId,
    elementId,
    restorationBonuses: createDefaultBonusSet(
      master,
      weaponTypeId,
      elementId,
      scopeFor(value),
    ),
  })

  // The five slots always follow scope + weapon type + element. The new set is
  // built before the draft is replaced, so a Master failure leaves the draft
  // exactly as it was and reports inside the Dialog.
  const changeScope = (value: OwnedWeaponDraft, scope: ArtianBonusScope) => {
    if (value.kind !== 'gogma' || value.restorationBonusScope === scope) return
    try {
      const restorationBonuses = createDefaultBonusSet(
        master,
        value.weaponTypeId,
        value.elementId,
        scope,
      )
      setDraft({ ...value, restorationBonusScope: scope, restorationBonuses })
    } catch (caught) {
      if (caught instanceof MasterOptionsUnavailableError) {
        setFormError(caught.message)
      } else {
        throw caught
      }
    }
  }

  return (
    <PageShell
      title="所持武器"
      description="所持している通常／巨戟アーティアを1本ずつ管理します。"
      actions={
        <Button variant="contained" onClick={openNew} sx={{ minHeight: 44 }}>
          所持武器を追加
        </Button>
      }
    >
      <Stack spacing={2}>
        <MasterDataStatusAlert master={master} />
        {error && <Alert severity="error">{error}</Alert>}
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
              登録済みの所持武器
            </Typography>
            {!loading && !loadFailed && (
              <Typography variant="body2" color="text.secondary" className="tabular-nums">
                {weapons.length}本
              </Typography>
            )}
          </Stack>
          {!loading && !loadFailed && weapons.length > 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, pb: 2 }}>
              <WeaponListFilterBar
                label="所持武器の絞り込み"
                filter={filter}
                onChange={setFilter}
                weaponTypes={weaponTypes}
                elements={elements}
                totalCount={weapons.length}
                shownCount={shownWeapons.length}
                unit="本"
              />
            </Box>
          )}
          {loading && <LinearProgress aria-label="所持武器を読み込み中" />}
          {!loading && !loadFailed && weapons.length === 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, py: 3, borderTop: 1, borderColor: 'divider' }}>
              <Typography>所持武器は未登録です。</Typography>
              <Typography variant="body2" color="text.secondary">
                「所持武器を追加」から、通常アーティアまたは巨戟アーティアを1本ずつ登録します。
              </Typography>
            </Box>
          )}
          {!loading && weapons.length > 0 && shownWeapons.length === 0 && (
            <Box sx={{ px: { xs: 2, md: 2.5 }, py: 3, borderTop: 1, borderColor: 'divider' }}>
              <WeaponListFilterEmpty
                message="条件に一致する所持武器はありません。"
                onClear={() => setFilter(emptyWeaponListFilter)}
              />
            </Box>
          )}
          {!loading && shownWeapons.length > 0 && (
            <Box component="ul" sx={{ m: 0, p: 0 }}>
              {shownWeapons.map((weapon) => (
                <ManagementListItem
                  key={weapon.id}
                  title={weapon.name}
                  badges={
                    <Chip size="small" variant="outlined" label={artianWeaponKindLabels[weapon.kind]} />
                  }
                  summary={
                    <Typography variant="body2" color="text.secondary">
                      {weaponTypes.find(({ id }) => id === weapon.weaponTypeId)?.displayNameJa}
                      {' / '}
                      {elements.find(({ id }) => id === weapon.elementId)?.displayNameJa}
                    </Typography>
                  }
                  detail={
                    <Stack spacing={1}>
                      <Typography variant="body2">
                        {restorationBonusScopeFieldLabel}: {restorationBonusScopeLabels[weapon.restorationBonusScope]}
                      </Typography>
                      <BonusSlotList
                        heading="復元ボーナス"
                        bonuses={weapon.restorationBonuses}
                        weaponTypeId={weapon.weaponTypeId}
                        master={master}
                        scope={weapon.restorationBonusScope}
                      />
                      {weapon.kind === 'gogma' && (
                        <Typography variant="body2">
                          シリーズスキル:{' '}
                          {master.seriesSkills.find(({ id }) => id === weapon.seriesSkillId)?.displayNameJa ?? 'なし'}
                          {' ／ '}グループスキル:{' '}
                          {master.groupSkills.find(({ id }) => id === weapon.groupSkillId)?.displayNameJa ?? 'なし'}
                        </Typography>
                      )}
                    </Stack>
                  }
                  status={
                    <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
                      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <StatusChip
                          label={`状態: ${weapon.kind === 'gogma' ? ownedWeaponStatusLabels[weapon.status] : '—'}`}
                          tone={weapon.kind === 'gogma' ? 'info' : 'neutral'}
                        />
                        <StatusChip
                          label={weapon.isProtected ? '保護中' : '未保護'}
                          tone={weapon.isProtected ? 'positive' : 'neutral'}
                        />
                      </Stack>
                      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        優先起点:{' '}
                        {targets.find((target) => target.preferredOwnedWeaponId === weapon.id)?.name ?? 'なし'}
                      </Typography>
                    </Stack>
                  }
                  onEdit={() => openEdit(weapon)}
                  onDelete={() => void remove(weapon)}
                />
              ))}
            </Box>
          )}
        </Paper>
        <Dialog
          open={draft !== null}
          onClose={closeDialog}
          fullWidth
          maxWidth="md"
          slotProps={{ paper: { sx: dialogPaperSx } }}
        >
          <DialogTitle sx={{ px: { xs: 2, sm: 3 } }}>
            {editing ? '所持武器を編集' : '所持武器を追加'}
          </DialogTitle>
          {draft && (
            <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
              <Stack spacing={3}>
                <Stack component="section" spacing={1.5}>
                  <Typography component="h3" variant="h3">基本情報</Typography>
                  <Box>
                    <FormControlLabel
                      sx={{ minHeight: 44 }}
                      control={
                        <Checkbox
                          checked={draft.kind === 'normal'}
                          disabled={editing !== null}
                          slotProps={editing ? { input: { 'aria-describedby': kindHelpId } } : undefined}
                          onChange={(event) => {
                            try {
                              setDraft(
                                createOwnedWeaponDraft(
                                  master,
                                  event.target.checked ? 'normal' : 'gogma',
                                ),
                              )
                            } catch (caught) {
                              if (caught instanceof Error) setFormError(caught.message)
                            }
                          }}
                        />
                      }
                      label="通常アーティアとして登録"
                    />
                    {editing && (
                      <Typography id={kindHelpId} variant="caption" color="text.secondary" component="p">
                        登録済み武器の種類は変更できません。
                      </Typography>
                    )}
                  </Box>
                  <TextField
                    label="名前"
                    value={draft.name}
                    required
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
                    <FormControl fullWidth>
                      <InputLabel id="owned-weapon-type">武器種</InputLabel>
                      <Select
                        labelId="owned-weapon-type"
                        label="武器種"
                        value={draft.weaponTypeId}
                        onChange={(event) => {
                          try {
                            setDraft(
                              resetBonuses(
                                draft,
                                event.target.value,
                                draft.elementId,
                              ),
                            )
                          } catch (caught) {
                            if (caught instanceof MasterOptionsUnavailableError) {
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
                      <InputLabel id="owned-element">属性</InputLabel>
                      <Select
                        labelId="owned-element"
                        label="属性"
                        value={draft.elementId}
                        onChange={(event) => {
                          try {
                            setDraft(
                              resetBonuses(
                                draft,
                                draft.weaponTypeId,
                                event.target.value,
                              ),
                            )
                          } catch (caught) {
                            if (caught instanceof MasterOptionsUnavailableError) {
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
                  </Box>
                </Stack>
                {draft.kind === 'gogma' ? (
                  // A Gogma weapon may hold either scope (`docs/UI_FLOW.md` 7):
                  // inherited normal-tier slots before its first bonus amendment,
                  // or Gogma-tier slots after one.
                  <FormControl fullWidth>
                    <InputLabel id="owned-bonus-scope">{restorationBonusScopeFieldLabel}</InputLabel>
                    <Select
                      labelId="owned-bonus-scope"
                      label={restorationBonusScopeFieldLabel}
                      value={draft.restorationBonusScope}
                      onChange={(event) =>
                        changeScope(draft, event.target.value as ArtianBonusScope)
                      }
                      slotProps={{ input: { 'aria-describedby': 'owned-bonus-scope-help' } }}
                    >
                      {(Object.keys(restorationBonusScopeLabels) as ArtianBonusScope[]).map((scope) => (
                        <MenuItem
                          key={scope}
                          value={scope}
                          sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                        >
                          {restorationBonusScopeLabels[scope]}
                        </MenuItem>
                      ))}
                    </Select>
                    <FormHelperText id="owned-bonus-scope-help">
                      {restorationBonusScopeGogmaHelpText}
                    </FormHelperText>
                  </FormControl>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    {restorationBonusScopeFieldLabel}: {restorationBonusScopeLabels[draft.restorationBonusScope]}
                  </Typography>
                )}
                <BonusSetEditor
                  label="復元ボーナス5枠"
                  master={master}
                  weaponTypeId={draft.weaponTypeId}
                  elementId={draft.elementId}
                  scope={scopeFor(draft)}
                  value={draft.restorationBonuses}
                  onChange={(restorationBonuses) =>
                    setDraft({ ...draft, restorationBonuses })
                  }
                />
                {draft.kind === 'gogma' && (
                  <Stack component="section" spacing={1.5}>
                    <Typography component="h3" variant="h3">スキル・状態</Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
                      <FormControl fullWidth>
                        <InputLabel id="owned-series">
                          シリーズスキル
                        </InputLabel>
                        <Select
                          labelId="owned-series"
                          label="シリーズスキル"
                          value={draft.seriesSkillId ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              seriesSkillId: event.target.value || null,
                            })
                          }
                        >
                          <MenuItem value="">なし</MenuItem>
                          {getSeriesSkillOptions(master).map((skill) => (
                            <MenuItem key={skill.id} value={skill.id}>
                              {skill.displayNameJa}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl fullWidth>
                        <InputLabel id="owned-group">
                          グループスキル
                        </InputLabel>
                        <Select
                          labelId="owned-group"
                          label="グループスキル"
                          value={draft.groupSkillId ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              groupSkillId: event.target.value || null,
                            })
                          }
                        >
                          <MenuItem value="">なし</MenuItem>
                          {getGroupSkillOptions(master).map((skill) => (
                            <MenuItem key={skill.id} value={skill.id}>
                              {skill.displayNameJa}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl fullWidth>
                        <InputLabel id="owned-status">状態</InputLabel>
                        <Select
                          labelId="owned-status"
                          label="状態"
                          value={draft.status}
                          onChange={(event) => {
                            const status = event.target.value as OwnedWeaponStatus
                            setDraft({
                              ...draft,
                              status,
                              ...(editing === null
                                ? { isProtected: status === 'ideal' }
                                : {}),
                            })
                          }}
                        >
                          {Object.entries(ownedWeaponStatusLabels).map(
                            ([value, label]) => (
                              <MenuItem key={value} value={value}>
                                {label}
                              </MenuItem>
                            ),
                          )}
                        </Select>
                      </FormControl>
                    </Box>
                  </Stack>
                )}
                <Stack component="section" spacing={1.5}>
                  <Typography component="h3" variant="h3">保護・メモ</Typography>
                  <FormControlLabel
                    sx={{ minHeight: 44, alignSelf: 'flex-start' }}
                    control={
                      <Checkbox
                        checked={draft.isProtected}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            isProtected: event.target.checked,
                          })
                        }
                      />
                    }
                    label="保護する"
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
        <PlanBreakingChangeDialog controller={planGuard} />
      </Stack>
    </PageShell>
  )
}
