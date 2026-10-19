import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Alert, Box, Button, Checkbox,
  FormControlLabel, LinearProgress, Paper, Stack, TextField, Typography,
} from '@mui/material'
import { DisclosureAccordion } from '../components/DisclosureAccordion'
import { PageShell } from '../components/PageShell'
import { StatusChip, type StatusTone } from '../components/StatusChip'
import { IdentificationWizardDialog } from '../components/rng/IdentificationWizardDialog'
import { PlanBreakingChangeDialog } from '../components/execution/PlanBreakingChangeDialog'
import { PersistentReidentificationReminderAlert } from '../components/execution/PersistentReidentificationReminderAlert'
import { usePersistentReidentificationReminder } from '../components/execution/usePersistentReidentificationReminder'
import { usePlanBreakingChangeApproval } from '../components/execution/usePlanBreakingChangeApproval'
import type { PlanBreakingChangeApproval, PlanBreakingChangeInspection } from '../domain/execution'
import { loadMasterData } from '../domain/master/loadMasterData'
import type { KnownValue, RngState, RngStateSource } from '../domain/models/publicTypes'
import { validateRngState } from '../domain/models/validation'
import { deriveRngCapabilities, type RngCapabilityMissingRequirement } from '../domain/rng/capabilities'
import { productionRngEngine, productionRngRuntime } from '../domain/rng/production/productionRngRuntime'
import type { RngEngine } from '../domain/rng/rngEngine'
import { normalArtianCounterRepository, rngStateRepository } from '../db/repositories'
import {
  loadPersistentReidentificationReminder,
  type PersistentReidentificationReminder,
} from '../services/execution/persistentReidentificationReminderService'
import { rngStatePersistenceService } from '../services/rngState/rngStatePersistenceService'
import { getRngMissingRequirementLabel, rngStateSourceLabels } from '../presentation/labels'
import {
  createProductionIdentificationWizardCoordinator,
  type IdentificationWizardCoordinator,
} from '../services/rngIdentification/identificationWizardCoordinator'
import {
  getProductionIdentificationAvailability,
  productionIdentificationUnavailableReasonLabels,
} from '../services/rngIdentification/productionIdentificationAvailability'

const masterResult = loadMasterData()

/**
 * The KnownValues the ordinary RNG Setup edits (`docs/UI_FLOW.md` 5.2).
 * `RngState.counterGate` is deliberately absent: it stays persisted for
 * legacy / diagnostic / import compatibility, is never Production Prediction
 * authority, and is neither shown nor edited here.
 */
type KnownKey = 'baseSeed' | 'gogmaCounter' | 'skillCounter'
type FormKnown = { value: string; isConfirmed: boolean; source: RngStateSource | null }
type RngForm = Record<KnownKey, FormKnown> & { notes: string }
const knownKeys: readonly KnownKey[] = ['baseSeed', 'gogmaCounter', 'skillCounter']

const UNSAVED_WIZARD_MESSAGE =
  'RNG状態の特定を開始する前に、RNG状態設定の変更を保存するか元に戻してください。'
/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
const RNG_SETUP_PLAN_BREAKING_NOTE =
  'RNG状態を変更すると、現在の生産計画で使用している予測位置と一致しなくなります。'
const RNG_SAVED_MESSAGE = 'RNG状態を保存しました。'
const RNG_SAVED_PLAN_ABANDONED_MESSAGE = 'RNG状態を保存し、実行中の生産計画を破棄しました。'
const IDENTIFICATION_ADOPTED_MESSAGE = '特定結果をRNG状態へ採用しました。'
const IDENTIFICATION_ADOPTED_PLAN_ABANDONED_MESSAGE =
  '特定結果をRNG状態へ採用し、実行中の生産計画を破棄しました。'

const knownLabels: Record<KnownKey, string> = {
  baseSeed: 'Base Seed（基準シード）',
  gogmaCounter: '巨戟カウンター',
  skillCounter: 'スキルカウンター',
}

function toForm(state: RngState): RngForm {
  const map = <T,>(known: KnownValue<T>): FormKnown => ({ value: known.value === null ? '' : String(known.value), isConfirmed: known.isConfirmed, source: known.source })
  return { baseSeed: map(state.baseSeed), gogmaCounter: map(state.gogmaCounter), skillCounter: map(state.skillCounter), notes: state.notes ?? '' }
}

function hasUnsavedRngFormChanges(form: RngForm, state: RngState): boolean {
  const persisted = toForm(state)
  return form.notes !== persisted.notes || knownKeys.some((key) => (
    form[key].value !== persisted[key].value ||
    form[key].isConfirmed !== persisted[key].isConfirmed ||
    form[key].source !== persisted[key].source
  ))
}

function parseCounter(value: string, label: string): number | null {
  if (value === '') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label}は0以上の整数で入力してください。`)
  return parsed
}

function toState(
  form: RngForm,
  current: RngState,
  modifiedKeys: ReadonlySet<KnownKey>,
  now: string,
  engine: Pick<RngEngine, 'normalizeSeed'>,
): RngState {
  const updateKnown = <T,>(
    key: KnownKey,
    input: FormKnown,
    existing: KnownValue<T>,
    parse: (value: string) => T,
  ): KnownValue<T> => {
    if (!modifiedKeys.has(key) || input.value === '') return existing
    return {
      value: parse(input.value),
      isConfirmed: input.isConfirmed,
      source: input.source ?? 'manual',
    }
  }
  return {
    ...current,
    baseSeed: updateKnown('baseSeed', form.baseSeed, current.baseSeed, (value) => engine.normalizeSeed(value)),
    gogmaCounter: updateKnown('gogmaCounter', form.gogmaCounter, current.gogmaCounter, (value) => parseCounter(value, '巨戟カウンター') as number),
    skillCounter: updateKnown('skillCounter', form.skillCounter, current.skillCounter, (value) => parseCounter(value, 'スキルカウンター') as number),
    // The ordinary UI never edits Counter Gate: the persisted KnownValue is
    // carried over exactly (value, confirmation, and source), never nulled,
    // and never replaced by the Production representatives 54 / 35.
    counterGate: current.counterGate,
    notes: form.notes || null,
    updatedAt: now,
  }
}

/**
 * The status word of one KnownValue. It restates only whether a value is held
 * and whether it is confirmed; the value itself is never shown here.
 */
function knownStatus(isEmpty: boolean, isConfirmed: boolean): { label: string; tone: StatusTone } {
  if (isEmpty) return { label: '未入力', tone: 'neutral' }
  return isConfirmed ? { label: '使用中', tone: 'positive' } : { label: '未確認', tone: 'caution' }
}

/** A titled, border-based page section (the Dashboard pattern). */
function SectionCard({ title, children, sx }: { title: string; children: ReactNode; sx?: object }) {
  const headingId = useId()
  return (
    <Paper component="section" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0, ...sx }}>
      <Typography id={headingId} component="h2" variant="h2" sx={{ mb: 1.5 }}>{title}</Typography>
      {children}
    </Paper>
  )
}

/** One label / value row inside a definition list. */
function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 1.5, alignItems: 'center', py: 1, borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0, pt: 0 } }}>
      <Typography component="dt" variant="body2" sx={{ fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{label}</Typography>
      <Box component="dd" sx={{ m: 0, textAlign: 'right', overflowWrap: 'anywhere' }}>{children}</Box>
    </Box>
  )
}

interface KnownFieldProps { fieldId: string; label: string; description: string; numeric?: boolean; value: FormKnown; onChange(value: FormKnown): void }
function KnownField({ fieldId, label, description, numeric = false, value, onChange }: KnownFieldProps) {
  const status = knownStatus(value.value === '', value.isConfirmed)
  return <Box data-known-field={fieldId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
    <TextField id={fieldId} fullWidth label={label} helperText={description} value={value.value} type={numeric ? 'number' : 'text'} onChange={(event) => onChange({ ...value, value: event.target.value, isConfirmed: event.target.value === '' ? false : value.isConfirmed, source: event.target.value === '' ? value.source : 'manual' })} slotProps={numeric ? { htmlInput: { min: 0, step: 1 } } : undefined} />
    <FormControlLabel sx={{ m: 0, minHeight: 44, alignItems: 'center' }} control={<Checkbox checked={value.isConfirmed} disabled={value.value === ''} onChange={(event) => onChange({ ...value, isConfirmed: event.target.checked })} slotProps={{ input: { 'aria-describedby': `${fieldId}-label` } }} />} label="この値を検索・予測に使用する" />
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <StatusChip label={`状態: ${status.label}`} tone={status.tone} />
      <Typography variant="body2" color="text.secondary" id={`${fieldId}-source`}>
        取得方法: {value.source === null ? '指定なし' : rngStateSourceLabels[value.source]}
      </Typography>
    </Stack>
  </Box>
}

export interface RngSetupPageDependencies {
  ensure(): Promise<RngState>
  /**
   * `basis` is the RngState the edit started from, so only changed fields are
   * saved. `approval` is the breaking-change approval when the inspection
   * required one (`docs/UI_FLOW.md` 16.3).
   */
  save(state: RngState, basis?: RngState, approval?: PlanBreakingChangeApproval | null): Promise<RngState>
  /** The read-only breaking-change inspection of that very save. */
  inspectSave(state: RngState, basis?: RngState): Promise<PlanBreakingChangeInspection>
  getNormalCounters(): ReturnType<typeof normalArtianCounterRepository.getAllNormalArtianCounters>
  /**
   * The persistent re-identification reminder over every Plan
   * (`docs/PLANNER_SPEC.md` 16.15), re-read after a direct save and after an
   * Identification adoption. Read-only.
   */
  getReidentificationReminder(): Promise<PersistentReidentificationReminder>
  createIdentificationCoordinator?(): IdentificationWizardCoordinator
}
const defaultDependencies: RngSetupPageDependencies = {
  ensure: () => rngStateRepository.ensureInitialRngState(),
  save: (state, basis, approval) => rngStatePersistenceService.saveRngState(state, basis ?? null, approval ?? null),
  inspectSave: (state, basis) => rngStatePersistenceService.inspectRngStateSave(state, basis ?? null),
  getNormalCounters: () => normalArtianCounterRepository.getAllNormalArtianCounters(),
  getReidentificationReminder: () => loadPersistentReidentificationReminder(),
  createIdentificationCoordinator: createProductionIdentificationWizardCoordinator,
}

export function RngSetupPage({ dependencies = defaultDependencies }: { dependencies?: RngSetupPageDependencies }) {
  const [state, setState] = useState<RngState | null>(null)
  const [form, setForm] = useState<RngForm | null>(null)
  const [normalCounters, setNormalCounters] = useState<Awaited<ReturnType<RngSetupPageDependencies['getNormalCounters']>>>([])
  const [modifiedKeys, setModifiedKeys] = useState<Set<KnownKey>>(new Set())
  // Each failure is shown next to the action it belongs to.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [wizardError, setWizardError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [adoptionNotice, setAdoptionNotice] = useState<string | null>(null)
  const [identificationCoordinator, setIdentificationCoordinator] =
    useState<IdentificationWizardCoordinator | null>(null)
  // The breaking-change warning of the direct save (`docs/UI_FLOW.md` 16.3).
  // The Wizard's adoption runs its own, inside the Wizard Dialog.
  const planGuard = usePlanBreakingChangeApproval()
  // The reminder is derived from the persisted provenance alone; a save or an
  // adoption may resolve or re-open it, so both re-read it (16.15).
  const loadReminder = useMemo(() => () => dependencies.getReidentificationReminder(), [dependencies])
  const reminder = usePersistentReidentificationReminder(loadReminder)
  useEffect(() => { let active = true; void Promise.all([dependencies.ensure(), dependencies.getNormalCounters()]).then(([loaded, counters]) => { if (active) { setState(loaded); setForm(toForm(loaded)); setNormalCounters(counters) } }).catch((caught: unknown) => { if (active) setLoadError(caught instanceof Error ? caught.message : 'RNG状態を読み込めません。') }); return () => { active = false } }, [dependencies])

  // The page owns Coordinator lifetime: the Wizard session ends only when the
  // Coordinator is cleared by a real Close or when this page unmounts.
  useEffect(() => {
    if (!identificationCoordinator) return
    return () => { identificationCoordinator.dispose() }
  }, [identificationCoordinator])

  const updateField = (key: KnownKey, value: FormKnown) => {
    setForm((current) => current ? { ...current, [key]: value } : current)
    setModifiedKeys((current) => new Set(current).add(key))
  }

  // The capability preview is either built from the current draft or reported as
  // undeterminable. An invalid draft never falls back to the saved state, which
  // would present saved availability as the current input's result.
  const draftPreview = useMemo<{ state: RngState; invalid: false } | { state: null; invalid: true } | null>(() => { if (!state || !form) return null; try { return { state: toState(form, state, modifiedKeys, state.updatedAt, productionRngEngine), invalid: false } } catch { return { state: null, invalid: true } } }, [form, modifiedKeys, state])
  const preview = draftPreview?.state ?? null
  const previewInvalid = draftPreview?.invalid === true
  const hasUnsavedChanges = useMemo(
    () => state !== null && form !== null && hasUnsavedRngFormChanges(form, state),
    [form, state],
  )
  const capabilities = preview ? deriveRngCapabilities(preview, normalCounters, [], productionRngEngine.capabilities) : null
  const displayedRequirements = useMemo(() => {
    if (!preview) return []
    const gogma = deriveRngCapabilities(preview, normalCounters, [{ type: 'reset_bonuses', sourceOwnedWeaponId: null, gogmaCounterBefore: 0, gogmaCounterAfter: 0 }], productionRngEngine.capabilities)
    const skills = deriveRngCapabilities(preview, normalCounters, [{ type: 'reset_skills', sourceOwnedWeaponId: null, skillCounterBefore: 0, skillCounterAfter: 0 }], productionRngEngine.capabilities)
    return [...new Set<RngCapabilityMissingRequirement>([
      ...gogma.missingRequirements as RngCapabilityMissingRequirement[],
      ...skills.missingRequirements as RngCapabilityMissingRequirement[],
    ])]
  }, [normalCounters, preview])

  const save = async () => {
    if (!state || !form) return
    setSaveError(null); setSaveNotice(null); setAdoptionNotice(null)
    try {
      const next = toState(form, state, modifiedKeys, new Date().toISOString(), productionRngEngine)
      const validation = validateRngState(next)
      if (!validation.isValid) throw new Error(validation.issues.map(({ message }) => message).join(' / '))
      // The inspection and the save close over the same edit against the same
      // basis; the runtime alone decides whether the warning is shown.
      const outcome = await planGuard.run({
        inspect: () => dependencies.inspectSave(next, state),
        apply: (approval) => dependencies.save(next, state, approval),
        note: RNG_SETUP_PLAN_BREAKING_NOTE,
      })
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'refused') { setSaveError(outcome.message); return }
      const saved = outcome.result
      setState(saved); setForm(toForm(saved)); setModifiedKeys(new Set())
      setSaveNotice(outcome.planAbandoned ? RNG_SAVED_PLAN_ABANDONED_MESSAGE : RNG_SAVED_MESSAGE)
      reminder.reload()
    } catch (caught: unknown) { setSaveError(caught instanceof Error ? caught.message : 'RNG状態を保存できません。') }
  }

  // Application-level Wizard availability (`docs/UI_FLOW.md` 5): never derived
  // from an RngEngine capability flag. It is the single authority for both the
  // status shown and the start guard.
  const identificationAvailability = getProductionIdentificationAvailability()

  const startIdentification = () => {
    setWizardError(null)
    setAdoptionNotice(null)
    // Fail closed: the disabled button is not the only guard, so a start that
    // bypasses it (a programmatic call) still never opens a Wizard whose
    // Identification would end in `worker_unavailable`.
    if (!identificationAvailability.isAvailable) {
      setWizardError(
        productionIdentificationUnavailableReasonLabels[identificationAvailability.reason],
      )
      return
    }
    if (hasUnsavedChanges) {
      setWizardError(UNSAVED_WIZARD_MESSAGE)
      return
    }
    try {
      setIdentificationCoordinator(
        (dependencies.createIdentificationCoordinator ??
          createProductionIdentificationWizardCoordinator)(),
      )
    } catch (caught: unknown) {
      setWizardError(caught instanceof Error ? caught.message : 'RNG状態の特定を開始できません。')
    }
  }

  const handleIdentificationAdopted = (saved: RngState, adoption: { planAbandoned: boolean }) => {
    setState(saved)
    setForm(toForm(saved))
    setModifiedKeys(new Set())
    setSaveNotice(null)
    setAdoptionNotice(adoption.planAbandoned ? IDENTIFICATION_ADOPTED_PLAN_ABANDONED_MESSAGE : IDENTIFICATION_ADOPTED_MESSAGE)
    reminder.reload()
  }

  const engineCapabilities = productionRngRuntime.capabilities

  return <PageShell title="RNG状態設定" description="検索や予測に使うRNG状態を項目ごとに設定します。"><Stack spacing={{ xs: 2, md: 3 }}>
    {!form && !loadError && <LinearProgress aria-label="RNG状態を読み込み中" />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    <PersistentReidentificationReminderAlert state={reminder.state} master={masterResult.ok ? masterResult.data : null} surface="rng_setup" />
    {form && state && <>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: { xs: 2, md: 3 }, alignItems: 'start' }}>
        <SectionCard title="保存済みのRNG状態">
          <Box component="dl" sx={{ m: 0 }}>
            {(['baseSeed', 'gogmaCounter', 'skillCounter'] as const).map((key) => {
              const status = knownStatus(state[key].value === null, state[key].isConfirmed)
              return <DefinitionRow key={key} label={knownLabels[key]}><StatusChip label={status.label} tone={status.tone} /></DefinitionRow>
            })}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {hasUnsavedChanges ? '未保存の変更があります。保存するとこの表示に反映されます。' : '使用中: 検索・予測に使用する値です。未確認: 値はありますが使用しません。'}
          </Typography>
        </SectionCard>

        <SectionCard title="値が分からない場合" sx={{ borderLeftWidth: 4, borderLeftColor: 'primary.main' }}>
          <Stack spacing={1.5}>
            <Box component="dl" sx={{ m: 0 }}>
              <DefinitionRow label="RNG状態の特定"><StatusChip label={identificationAvailability.isAvailable ? '利用可能' : '利用不可'} tone={identificationAvailability.isAvailable ? 'positive' : 'caution'} /></DefinitionRow>
            </Box>
            {!identificationAvailability.isAvailable && <Alert severity="warning">{productionIdentificationUnavailableReasonLabels[identificationAvailability.reason]}</Alert>}
            <Typography>連続したスキル抽選結果と復元ボーナスのリセット結果を観測し、次の値を特定します。</Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              <Typography component="li" variant="body2">Base Seed（基準シード）</Typography>
              <Typography component="li" variant="body2">調査開始前のスキルカウンター</Typography>
              <Typography component="li" variant="body2">調査開始前の巨戟カウンター</Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">開始条件: RNG状態設定に未保存の変更がなく、マスターデータを利用できること。手動入力は引き続き利用できます。</Typography>
            {hasUnsavedChanges && <Alert severity="warning">{UNSAVED_WIZARD_MESSAGE}</Alert>}
            {!masterResult.ok && <Alert severity="error">マスターデータが利用できないため、RNG状態の特定を開始できません。</Alert>}
            {wizardError && wizardError !== UNSAVED_WIZARD_MESSAGE && <Alert severity="error">{wizardError}</Alert>}
            {adoptionNotice && <Alert severity="success" onClose={() => setAdoptionNotice(null)}>{adoptionNotice}</Alert>}
            <Box>
              <Button variant="contained" sx={{ minHeight: 44 }} disabled={!masterResult.ok || !identificationAvailability.isAvailable || identificationCoordinator !== null || hasUnsavedChanges} onClick={startIdentification}>RNG状態の特定を開始</Button>
            </Box>
          </Stack>
        </SectionCard>
      </Box>

      <SectionCard title="手動入力">
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">正しいことを確認できた値だけ「この値を検索・予測に使用する」を選択してください。直接入力した値の取得方法は「手動入力」になります。空欄は既存値を変更しません。</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }, gap: { xs: 1.5, md: 2 }, alignItems: 'start' }}>
            <KnownField fieldId="base-seed" label={knownLabels.baseSeed} description="10進数または0xで始まる16進数を入力します。保存時に予測用の10進文字列へ正規化します。" value={form.baseSeed} onChange={(value) => updateField('baseSeed', value)} />
            <KnownField fieldId="gogma-counter" label={knownLabels.gogmaCounter} description="巨戟アーティアの復元ボーナス予測に使う位置です。" numeric value={form.gogmaCounter} onChange={(value) => updateField('gogmaCounter', value)} />
            <KnownField fieldId="skill-counter" label={knownLabels.skillCounter} description="シリーズ・グループスキル予測に使う位置です。" numeric value={form.skillCounter} onChange={(value) => updateField('skillCounter', value)} />
          </Box>
          <TextField label="メモ" multiline minRows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          {saveError && <Alert severity="error">{saveError}</Alert>}
          {saveNotice && <Alert severity="success" onClose={() => setSaveNotice(null)}>{saveNotice}</Alert>}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'flex-end' }}>
            {hasUnsavedChanges && <Typography variant="body2" color="text.secondary">未保存の変更があります。</Typography>}
            <Button variant="contained" sx={{ minHeight: 44, minWidth: 120 }} disabled={planGuard.busy} onClick={() => void save()}>保存</Button>
          </Stack>
        </Stack>
      </SectionCard>
    </>}

    {previewInvalid && <SectionCard title="現在の入力内容で利用可能な機能">
      <Alert severity="info">現在の入力内容にエラーがあるため、利用可能な機能を判定できません。入力内容を修正すると判定結果を表示します。</Alert>
    </SectionCard>}

    {capabilities && <SectionCard title="現在の入力内容で利用可能な機能">
      <Box component="dl" sx={{ m: 0 }}>
        <DefinitionRow label="巨戟アーティア予測"><StatusChip label={capabilities.canPredictGogma ? '利用可能' : '利用不可'} tone={capabilities.canPredictGogma ? 'positive' : 'caution'} /></DefinitionRow>
        <DefinitionRow label="スキル予測"><StatusChip label={capabilities.canPredictSkills ? '利用可能' : '利用不可'} tone={capabilities.canPredictSkills ? 'positive' : 'caution'} /></DefinitionRow>
        <DefinitionRow label="通常アーティア検索"><StatusChip label={capabilities.canSearchNormalArtian ? '利用可能' : '利用不可'} tone={capabilities.canSearchNormalArtian ? 'positive' : 'caution'} /></DefinitionRow>
        <DefinitionRow label="生産計画作成"><StatusChip label="作成ルート依存" tone="info" /></DefinitionRow>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        生産計画作成: Production Engine有効（必要項目は作成ルートにより異なります）
        {hasUnsavedChanges ? ' 判定には未保存の入力内容を含みます。' : ''}
      </Typography>
      {displayedRequirements.length > 0 && <Alert severity="warning" sx={{ mt: 1.5 }}><Typography variant="subtitle2" component="p">現在不足している項目</Typography><Box component="ul" sx={{ m: 0, pl: 2.5 }}>{displayedRequirements.map((requirement) => <Typography component="li" variant="body2" key={requirement}>{getRngMissingRequirementLabel(requirement)}</Typography>)}</Box></Alert>}
    </SectionCard>}

    <DisclosureAccordion title="Production RNG Engine（技術情報）" headingLevel="h2">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Engine自体が対応している機能です。現在の入力内容で使えるかどうかは「現在の入力内容で利用可能な機能」を確認してください。</Typography>
      <Box component="dl" sx={{ m: 0 }}>
        <DefinitionRow label="Engine mode"><Typography variant="body2" component="span" className="tabular-nums">{productionRngRuntime.mode}</Typography></DefinitionRow>
        <DefinitionRow label="Engine version"><Typography variant="body2" component="span" className="tabular-nums">{productionRngRuntime.version}</Typography></DefinitionRow>
        <DefinitionRow label="通常アーティア予測"><StatusChip label={engineCapabilities.supportsNormalArtianPrediction ? '対応' : '未対応'} tone={engineCapabilities.supportsNormalArtianPrediction ? 'positive' : 'neutral'} /></DefinitionRow>
        <DefinitionRow label="スキル予測"><StatusChip label={engineCapabilities.supportsSkillPrediction ? '対応' : '未対応'} tone={engineCapabilities.supportsSkillPrediction ? 'positive' : 'neutral'} /></DefinitionRow>
        <DefinitionRow label="巨戟アーティア予測"><StatusChip label={engineCapabilities.supportsGogmaPrediction ? '対応' : '未対応'} tone={engineCapabilities.supportsGogmaPrediction ? 'positive' : 'neutral'} /></DefinitionRow>
        <DefinitionRow label="Keep Bonuses予測"><StatusChip label={engineCapabilities.supportsKeepBonusesPrediction ? '対応' : '未対応'} tone={engineCapabilities.supportsKeepBonusesPrediction ? 'positive' : 'neutral'} /></DefinitionRow>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>RNG状態の特定を利用できるかどうかは、上の予測機能の対応状況ではなくアプリ側で判定します。現在の状態は「値が分からない場合」の表示を確認してください。</Typography>
    </DisclosureAccordion>

    <PlanBreakingChangeDialog controller={planGuard} />
    {identificationCoordinator && state && masterResult.ok && <IdentificationWizardDialog coordinator={identificationCoordinator} initialRngState={state} master={masterResult.data} onAdopted={handleIdentificationAdopted} onClose={() => setIdentificationCoordinator(null)} />}
  </Stack></PageShell>
}
