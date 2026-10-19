import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert, AlertTitle, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControl, FormControlLabel, FormLabel, InputLabel, LinearProgress, MenuItem, Radio,
  RadioGroup, Select, Stack, TextField, Typography,
} from '@mui/material'
import { StatusChip, type StatusTone } from '../StatusChip'
import type { BonusTypeMaster, ElementMaster } from '../../domain/master/masterTypes'
import type { BonusTypeId, RestorationBonus, RestorationBonusSet, WeaponTypeId } from '../../domain/models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../../domain/models/publicTypes'
import {
  MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER,
  normalArtianCounterObservationBonusOptions,
  type InclusiveNumberRange,
  type NormalArtianCounterIdentificationInput,
  type NormalArtianCounterIdentificationProgress,
  type NormalArtianCounterIdentificationResult,
  type NormalArtianCounterObservation,
  type NormalArtianLotteryTableClass,
} from '../../domain/rng/identification'
import type { NormalizedSeed, RngPredictionUnsupportedReason } from '../../domain/rng/rngEngine'
import {
  classifyNormalCounterIdentificationResult,
  normalCounterIdentificationTableClassOptions,
  normalCounterIdentificationSharedPoolNote,
  normalCounterIdentificationUnsupportedLabel,
  type NormalCounterIdentificationTableClassOption,
} from '../../presentation/normalCounterIdentification'
import {
  NormalArtianCounterIdentificationCancelledError,
  NormalArtianCounterIdentificationDuplicateRequestError,
  NormalArtianCounterIdentificationWorkerError,
  NormalArtianCounterIdentificationWorkerUnavailableError,
  type NormalArtianCounterIdentificationWorkerClient,
} from '../../services/rngIdentification/normalArtianCounterIdentificationWorkerClient'

const SLOT_COUNT = 5

/**
 * The safety notice shown at least twice (`docs/UI_FLOW.md` 6): before the
 * search starts and again right before the Counter is confirmed. It asks the
 * user to confirm the restore; it never asserts anything about the game's own
 * save behaviour.
 */
const SAFETY_NOTICE_LINES = [
  '観測後はゲームを保存しないでください。',
  '調査前の状態へ戻ったことを確認してからCounterを確定してください。',
] as const

type SlotDraft = BonusTypeId | null
type SlotDrafts = readonly [SlotDraft, SlotDraft, SlotDraft, SlotDraft, SlotDraft]

/** One forged weapon as typed so far: the lottery table it drew from and five ordered slots. */
interface ObservationDraft {
  readonly tableClass: NormalArtianLotteryTableClass
  readonly slots: SlotDrafts
}

/** The Production pool options of each lottery table for the session's weapon type. */
type OptionsByTableClass = Readonly<Record<NormalArtianLotteryTableClass, readonly RestorationBonus[]>>

function emptyObservation(): ObservationDraft {
  return { tableClass: 'table_a', slots: [null, null, null, null, null] }
}

/** The Domain error kinds the ordinary UI distinguishes; never a raw enum on screen. */
type IdentificationErrorKind =
  | 'invalid_input'
  | 'unsupported_input'
  | 'unexpected_error'
  | 'worker_unavailable'
  | 'duplicate_request'
  | 'unknown'

interface IdentificationErrorState {
  readonly kind: IdentificationErrorKind
  readonly unsupportedReason: RngPredictionUnsupportedReason | null
  /** Diagnostic text for Debug Mode only. */
  readonly message: string
}

type SearchPhase =
  | { readonly status: 'idle' }
  | {
      readonly status: 'searching'
      readonly requestId: string
      readonly progress: NormalArtianCounterIdentificationProgress | null
    }
  | {
      readonly status: 'result'
      readonly input: NormalArtianCounterIdentificationInput
      readonly result: NormalArtianCounterIdentificationResult
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: IdentificationErrorState }

function toErrorState(error: unknown): IdentificationErrorState {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof NormalArtianCounterIdentificationWorkerError) {
    if (error.code === 'invalid_input') return { kind: 'invalid_input', unsupportedReason: null, message }
    if (error.code === 'unsupported_input') {
      return { kind: 'unsupported_input', unsupportedReason: error.unsupportedReason, message }
    }
    return { kind: 'unexpected_error', unsupportedReason: null, message }
  }
  if (error instanceof NormalArtianCounterIdentificationWorkerUnavailableError) {
    return { kind: 'worker_unavailable', unsupportedReason: null, message }
  }
  if (error instanceof NormalArtianCounterIdentificationDuplicateRequestError) {
    return { kind: 'duplicate_request', unsupportedReason: null, message }
  }
  return { kind: 'unknown', unsupportedReason: null, message }
}

function errorLabel(error: IdentificationErrorState): { title: string; body: string } {
  switch (error.kind) {
    case 'invalid_input':
      return {
        title: '入力エラー',
        body: '入力内容がCounter検索の条件を満たしていません。各観測の属性区分と復元ボーナス1〜5、検索範囲を確認してください。',
      }
    case 'unsupported_input':
      return { title: '未対応の入力', body: normalCounterIdentificationUnsupportedLabel(error.unsupportedReason) }
    case 'worker_unavailable':
      return {
        title: 'Workerを利用できません',
        body: 'この環境ではCounter検索用のWorkerを利用できません。ページを再読み込みしてから再試行してください。',
      }
    case 'duplicate_request':
      return { title: '検索リクエストエラー', body: '検索リクエストの識別子が重複しました。もう一度検索してください。' }
    case 'unexpected_error':
    case 'unknown':
      return { title: '検索処理エラー', body: '検索処理でエラーが発生しました。入力を保持しています。再試行してください。' }
  }
}

function parseCounterBound(value: string, label: string): number {
  if (value.trim() === '') throw new Error(`${label}を入力してください。`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}は0以上の整数で入力してください。`)
  }
  return parsed
}

function parseCounterRange(start: string, end: string, observationCount: number): InclusiveNumberRange {
  const startInclusive = parseCounterBound(start, '検索範囲の開始')
  const endInclusive = parseCounterBound(end, '検索範囲の終了')
  if (endInclusive < startInclusive) throw new Error('検索範囲の終了は開始以上にしてください。')
  if (endInclusive > MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER) {
    throw new Error(`検索範囲の終了は${MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER}以下にしてください。`)
  }
  if (observationCount - 1 > MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER - endInclusive) {
    throw new Error('最後の観測が対応するCounterが検索可能な上限を超えます。検索範囲の終了を下げてください。')
  }
  return { startInclusive, endInclusive }
}

function completeObservations(
  drafts: readonly ObservationDraft[],
  optionsByClass: OptionsByTableClass,
): NormalArtianCounterObservation[] {
  return drafts.map((draft, observationIndex) => {
    const options = optionsByClass[draft.tableClass]
    const bonuses = draft.slots.map((bonusTypeId, slotIndex) => {
      const bonus = bonusTypeId === null ? undefined : options.find((option) => option.bonusTypeId === bonusTypeId)
      if (bonus === undefined) {
        throw new Error(`観測${observationIndex + 1}の復元ボーナス${slotIndex + 1}を入力してください。`)
      }
      return bonus
    })
    return {
      tableClass: draft.tableClass,
      bonuses: [bonuses[0]!, bonuses[1]!, bonuses[2]!, bonuses[3]!, bonuses[4]!] as RestorationBonusSet,
    }
  })
}

function SafetyNotice({ title }: { title: string }) {
  return (
    <Alert severity="warning">
      <AlertTitle>{title}</AlertTitle>
      {SAFETY_NOTICE_LINES.map((line) => <Typography key={line} variant="body2" component="p">{line}</Typography>)}
      <Typography variant="body2" component="p" color="text.secondary" sx={{ mt: 0.5 }}>
        ゲーム側の保存仕様や安全をこのアプリが保証するものではありません。
      </Typography>
    </Alert>
  )
}

function SearchProgress({ progress }: { progress: NormalArtianCounterIdentificationProgress | null }) {
  const textId = useId()
  if (progress === null) {
    return (
      <Stack spacing={0.5} role="group" aria-label="検索進捗">
        <LinearProgress aria-labelledby={textId} />
        <Typography id={textId} variant="body2">検索を開始しています…</Typography>
      </Stack>
    )
  }
  const percent = progress.totalCounters > 0
    ? Math.min(100, (progress.searchedCounters / progress.totalCounters) * 100)
    : 0
  return (
    <Stack spacing={0.5} role="group" aria-label="検索進捗">
      <LinearProgress variant="determinate" value={percent} aria-labelledby={textId} />
      <Typography id={textId} variant="body2" className="tabular-nums">
        評価済みCounter候補: {progress.searchedCounters.toLocaleString()} / {progress.totalCounters.toLocaleString()}（発見候補 {progress.matchesFound.toLocaleString()}件）
      </Typography>
    </Stack>
  )
}

function ResultAlert({ result, debugMode }: { result: NormalArtianCounterIdentificationResult; debugMode: boolean }) {
  const classification = classifyNormalCounterIdentificationResult(result)
  const count = result.matches.length
  switch (classification) {
    case 'unique':
      return (
        <Alert severity="success">
          <AlertTitle>候補が1件に絞り込まれました</AlertTitle>
          下の復元確認を行うとCounterを確定できます。
          {debugMode && (
            <Typography variant="body2" component="p" className="tabular-nums" sx={{ mt: 0.5 }}>
              デバッグ診断: startNormalCounter = {result.matches[0]!.startNormalCounter}
            </Typography>
          )}
        </Alert>
      )
    case 'multiple':
      return (
        <Alert severity="warning">
          <AlertTitle>候補が{count.toLocaleString()}件あります</AlertTitle>
          候補は手動で選択できません。次の連続forge結果（同じ武器種を続けて作成した次の1本）を「観測を追加」で末尾へ入力し、同じ範囲を再検索してください。
        </Alert>
      )
    case 'zero':
      return (
        <Alert severity="warning">
          <AlertTitle>一致する候補がありません</AlertTitle>
          観測入力、Base Seed、武器種、属性区分、検索範囲、作成順を確認してください。範囲は自動拡張されません。
        </Alert>
      )
    case 'truncated':
      return (
        <Alert severity="warning">
          <AlertTitle>探索が途中で打ち切られました</AlertTitle>
          結果は不完全なため、候補数（{count.toLocaleString()}件）に関係なく確定できません。検索範囲を見直すか観測を追加して再検索してください。
        </Alert>
      )
  }
}

function ErrorAlert({ error, debugMode }: { error: IdentificationErrorState; debugMode: boolean }) {
  const label = errorLabel(error)
  return (
    <Alert severity="error">
      <AlertTitle>{label.title}</AlertTitle>
      {label.body}
      {debugMode && (
        <Typography variant="body2" component="p" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
          デバッグ診断: {error.message}
        </Typography>
      )}
    </Alert>
  )
}

function ObservationCard({
  index, draft, isLast, optionsByClass, tableClassOptions, bonusNames, disabled, deleteDisabled, onChange, onDelete,
}: {
  index: number
  draft: ObservationDraft
  isLast: boolean
  optionsByClass: OptionsByTableClass
  tableClassOptions: readonly NormalCounterIdentificationTableClassOption[]
  bonusNames: ReadonlyMap<BonusTypeId, string>
  disabled: boolean
  deleteDisabled: boolean
  onChange(next: ObservationDraft): void
  onDelete(): void
}) {
  const number = index + 1
  const headingId = useId()
  const attributeLabelId = useId()
  const fieldIdPrefix = useId()
  const options = optionsByClass[draft.tableClass]
  const filled = draft.slots.filter((slot) => slot !== null).length
  const completion: { label: string; tone: StatusTone } = filled === SLOT_COUNT
    ? { label: '入力 5/5枠', tone: 'positive' }
    : { label: `入力 ${filled}/${SLOT_COUNT}枠`, tone: 'neutral' }

  const changeTableClass = (tableClass: NormalArtianLotteryTableClass) => {
    const allowed = new Set(optionsByClass[tableClass].map(({ bonusTypeId }) => bonusTypeId))
    // A slot whose bonus the other table's pool cannot draw is cleared, never guessed.
    const slots = draft.slots.map((slot) => (slot !== null && allowed.has(slot) ? slot : null)) as unknown as SlotDrafts
    onChange({ tableClass, slots })
  }
  const changeSlot = (slotIndex: number, bonusTypeId: SlotDraft) => {
    const slots = [...draft.slots] as [SlotDraft, SlotDraft, SlotDraft, SlotDraft, SlotDraft]
    slots[slotIndex] = bonusTypeId
    onChange({ ...draft, slots })
  }

  return (
    <Box component="li" aria-labelledby={headingId} data-normal-observation={number} sx={{ listStyle: 'none', border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography id={headingId} component="h4" variant="subtitle1" sx={{ overflowWrap: 'anywhere' }}>観測{number}</Typography>
            <Typography variant="caption" color="text.secondary" component="p">
              {index === 0 ? '最初に作成した通常アーティア' : `${number}本目に作成した通常アーティア`}
            </Typography>
          </Box>
          <StatusChip label={completion.label} tone={completion.tone} />
          {isLast && (
            <Button color="error" disabled={deleteDisabled} onClick={onDelete} sx={{ minHeight: 44, minWidth: 64 }}>
              観測{number}を削除
            </Button>
          )}
        </Stack>
        <FormControl disabled={disabled}>
          <FormLabel id={attributeLabelId}>観測{number} 属性区分</FormLabel>
          <RadioGroup
            aria-labelledby={attributeLabelId}
            value={draft.tableClass}
            onChange={(event) => changeTableClass(event.target.value as NormalArtianLotteryTableClass)}
            sx={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 3 }}
          >
            {tableClassOptions.map((option) => (
              <FormControlLabel
                key={option.tableClass}
                value={option.tableClass}
                control={<Radio />}
                label={option.label}
                sx={{ minHeight: 44, mr: 0, maxWidth: '100%', '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere' } }}
              />
            ))}
          </RadioGroup>
        </FormControl>
        <Box component="ol" aria-label={`観測${number}の復元ボーナス5枠`} sx={{ m: 0, p: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 1.25 }}>
          {draft.slots.map((slot, slotIndex) => {
            const labelId = `${fieldIdPrefix}-slot-${slotIndex}`
            const label = `観測${number} 復元ボーナス${slotIndex + 1}`
            return (
              <Box component="li" key={slotIndex} sx={{ listStyle: 'none', minWidth: 0 }}>
                <FormControl fullWidth disabled={disabled}>
                  <InputLabel shrink id={labelId}>{label}</InputLabel>
                  <Select
                    displayEmpty
                    labelId={labelId}
                    label={label}
                    value={slot ?? ''}
                    onChange={(event) => changeSlot(slotIndex, event.target.value === '' ? null : event.target.value)}
                  >
                    <MenuItem value=""><em>未入力</em></MenuItem>
                    {options.map((option) => (
                      <MenuItem key={option.bonusTypeId} value={option.bonusTypeId} sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        {bonusNames.get(option.bonusTypeId) ?? option.bonusTypeId}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            )
          })}
        </Box>
      </Stack>
    </Box>
  )
}

function SubHeading({ children }: { children: ReactNode }) {
  return <Typography component="h3" variant="h2">{children}</Typography>
}

export interface NormalCounterIdentificationConfirmation {
  /** The kernel's `startNormalCounter = C`: the Counter forged next in the restored state. */
  readonly startNormalCounter: number
  /** The number of observations the unique result was searched with; never added to `C`. */
  readonly observationCount: number
}

export interface NormalCounterIdentificationDialogProps {
  weaponTypeId: WeaponTypeId
  weaponName: string
  /** The confirmed canonical Base Seed; it is used as-is and never shown. */
  baseSeed: NormalizedSeed
  initialCounterRange: InclusiveNumberRange
  bonusTypes: readonly BonusTypeMaster[]
  /** Master elements, used only to word the lottery table options in Japanese. */
  elements: readonly ElementMaster[]
  /** Owned by the caller: created when the session opens, disposed when it ends. */
  client: NormalArtianCounterIdentificationWorkerClient
  createRequestId(): string
  debugMode: boolean
  onConfirm(confirmation: NormalCounterIdentificationConfirmation): Promise<void>
  onClose(): void
}

const dialogPaperSx = {
  m: { xs: 1, sm: 4 },
  width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
  maxHeight: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
}
const buttonSx = { minHeight: 44 } as const

/**
 * The Normal Counter Setup observation session (`docs/UI_FLOW.md` 6). The
 * observations live only in this component's memory; the caller persists the
 * confirmed Counter and nothing else.
 */
export function NormalCounterIdentificationDialog({
  weaponTypeId, weaponName, baseSeed, initialCounterRange, bonusTypes, elements, client, createRequestId,
  debugMode, onConfirm, onClose,
}: NormalCounterIdentificationDialogProps) {
  const titleId = useId()
  const [observations, setObservations] = useState<readonly ObservationDraft[]>(() => [emptyObservation()])
  const [rangeStart, setRangeStart] = useState(String(initialCounterRange.startInclusive))
  const [rangeEnd, setRangeEnd] = useState(String(initialCounterRange.endInclusive))
  const [phase, setPhase] = useState<SearchPhase>({ status: 'idle' })
  const [formError, setFormError] = useState<string | null>(null)
  const [gameRestoredConfirmed, setGameRestoredConfirmed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const activeRequestId = useRef<string | null>(null)
  const mounted = useRef(true)

  // Unmount cancels a still-running request; the caller disposes the client.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const requestId = activeRequestId.current
      if (requestId !== null) {
        activeRequestId.current = null
        client.cancel(requestId)
      }
    }
  }, [client])

  // The option authority is the Production pool itself; a weapon type without
  // one yields no options and the session fails closed instead of guessing.
  const optionsByClass = useMemo<OptionsByTableClass | null>(() => {
    try {
      return {
        table_a: normalArtianCounterObservationBonusOptions(weaponTypeId, 'table_a'),
        table_b: normalArtianCounterObservationBonusOptions(weaponTypeId, 'table_b'),
      }
    } catch {
      return null
    }
  }, [weaponTypeId])
  // The wording of the two tables follows the Domain classification of this
  // weapon type: 属性あり / 無属性 where only 無属性 draws Table B, and the
  // element lists (テーブルA / テーブルB) where an attribute draws Table B too.
  const tableClassOptions = useMemo(
    () => normalCounterIdentificationTableClassOptions(weaponTypeId, elements),
    [weaponTypeId, elements],
  )
  // Derived from the Domain pool identity, so a weapon type whose two classes
  // share one pool (Bowguns, Switch Axe) is explained without a UI-side list.
  const sharedPoolNote = useMemo(() => normalCounterIdentificationSharedPoolNote(weaponTypeId), [weaponTypeId])
  const bonusNames = useMemo(
    () => new Map(bonusTypes.map((bonusType) => [bonusType.id, bonusType.displayNameJa] as const)),
    [bonusTypes],
  )

  const searching = phase.status === 'searching'
  const editingLocked = searching || confirming
  const result = phase.status === 'result' ? phase : null
  const classification = result === null ? null : classifyNormalCounterIdentificationResult(result.result)
  const uniqueMatch = result !== null && classification === 'unique' ? result.result.matches[0]! : null

  /** Any edit that changes the meaning of a search drops its result and the restore confirmation. */
  const resetSearchOutcome = () => {
    setPhase((current) => (current.status === 'searching' ? current : { status: 'idle' }))
    setGameRestoredConfirmed(false)
    setConfirmError(null)
    setFormError(null)
  }
  const updateObservation = (index: number, next: ObservationDraft) => {
    setObservations((current) => current.map((draft, draftIndex) => (draftIndex === index ? next : draft)))
    resetSearchOutcome()
  }
  const addObservation = () => {
    setObservations((current) => [...current, emptyObservation()])
    resetSearchOutcome()
  }
  const deleteLastObservation = () => {
    setObservations((current) => (current.length > 1 ? current.slice(0, -1) : current))
    resetSearchOutcome()
  }

  const search = async () => {
    if (editingLocked || optionsByClass === null) return
    setFormError(null)
    setConfirmError(null)
    setGameRestoredConfirmed(false)
    let input: NormalArtianCounterIdentificationInput
    try {
      input = {
        baseSeed,
        weaponTypeId,
        rarity: V1_NORMAL_ARTIAN_RARITY,
        observations: completeObservations(observations, optionsByClass),
        normalCounterRange: parseCounterRange(rangeStart, rangeEnd, observations.length),
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '入力内容を確認してください。')
      return
    }
    // A fresh, non-persisted requestId per run; a late response of an older run
    // is ignored by the requestId guard below.
    const requestId = createRequestId()
    activeRequestId.current = requestId
    setPhase({ status: 'searching', requestId, progress: null })
    try {
      const searchResult = await client.identify(requestId, input, {
        onProgress: (progress) => {
          if (mounted.current && activeRequestId.current === requestId) {
            setPhase({ status: 'searching', requestId, progress })
          }
        },
      })
      if (!mounted.current || activeRequestId.current !== requestId) return
      activeRequestId.current = null
      setPhase({ status: 'result', input, result: searchResult })
    } catch (error) {
      if (!mounted.current || activeRequestId.current !== requestId) return
      activeRequestId.current = null
      setPhase(
        error instanceof NormalArtianCounterIdentificationCancelledError
          ? { status: 'cancelled' }
          : { status: 'error', error: toErrorState(error) },
      )
    }
  }

  const cancel = () => {
    const requestId = activeRequestId.current
    if (requestId === null) return
    client.cancel(requestId)
  }

  const confirm = async () => {
    if (result === null || uniqueMatch === null || !gameRestoredConfirmed || confirming) return
    setConfirming(true)
    setConfirmError(null)
    try {
      // `C` itself, from the kernel; the observation count is reported
      // separately and is never added to it (`docs/UI_FLOW.md` 6).
      await onConfirm({
        startNormalCounter: uniqueMatch.startNormalCounter,
        observationCount: result.input.observations.length,
      })
    } catch (error) {
      if (mounted.current) setConfirmError(error instanceof Error ? error.message : 'Counterを確定できません。')
    } finally {
      if (mounted.current) setConfirming(false)
    }
  }

  return (
    <Dialog
      open
      fullWidth
      maxWidth="md"
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: dialogPaperSx } }}
      onClose={(_, reason) => {
        if (!confirming && reason !== 'backdropClick') onClose()
      }}
    >
      <DialogTitle id={titleId} sx={{ px: { xs: 2, sm: 3 } }}>通常アーティアCounter検索: {weaponName}</DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
        <Stack spacing={{ xs: 2, sm: 3 }}>
          <SafetyNotice title="開始前に必ず確認してください" />
          {optionsByClass === null || tableClassOptions === null ? (
            <Alert severity="error">{normalCounterIdentificationUnsupportedLabel('normal_pool_unverified')}</Alert>
          ) : (
            <>
              <Alert severity="info">
                同じ武器種を連続して作成した結果を、作成した順に入力してください。対象はレア8の通常アーティアです。属性の種類そのものは選択せず、各観測ではその武器の属性が属する抽選テーブル区分（{tableClassOptions.map((option) => option.label).join(' / ')}）だけを選びます。どちらの区分で作成してもCounterは同じ1本を消費します。各観測の復元ボーナスは表示順（1〜5）のまま入力し、並べ替えないでください。{sharedPoolNote === null ? '' : sharedPoolNote}
              </Alert>

              <Stack spacing={1.5}>
                <SubHeading>観測（作成順）</SubHeading>
                <Box component="ol" sx={{ m: 0, p: 0, display: 'grid', gap: 1.25 }}>
                  {observations.map((draft, index) => (
                    <ObservationCard
                      key={index}
                      index={index}
                      draft={draft}
                      isLast={index === observations.length - 1}
                      optionsByClass={optionsByClass}
                      tableClassOptions={tableClassOptions}
                      bonusNames={bonusNames}
                      disabled={editingLocked}
                      deleteDisabled={editingLocked || observations.length === 1}
                      onChange={(next) => updateObservation(index, next)}
                      onDelete={deleteLastObservation}
                    />
                  ))}
                </Box>
                <Box>
                  <Button variant="outlined" sx={buttonSx} disabled={editingLocked} onClick={addObservation}>観測を追加</Button>
                </Box>
              </Stack>

              <Stack spacing={1.5}>
                <SubHeading>検索範囲</SubHeading>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
                  <TextField
                    fullWidth label="検索範囲の開始" type="number" value={rangeStart} disabled={editingLocked}
                    slotProps={{ htmlInput: { min: 0, max: MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER, step: 1, className: 'tabular-nums' } }}
                    onChange={(event) => { setRangeStart(event.target.value); resetSearchOutcome() }}
                  />
                  <TextField
                    fullWidth label="検索範囲の終了" type="number" value={rangeEnd} disabled={editingLocked}
                    slotProps={{ htmlInput: { min: 0, max: MAX_NORMAL_ARTIAN_IDENTIFICATION_COUNTER, step: 1, className: 'tabular-nums' } }}
                    onChange={(event) => { setRangeEnd(event.target.value); resetSearchOutcome() }}
                  />
                </Box>
                <Typography variant="body2" color="text.secondary">
                  初期値は0から{initialCounterRange.endInclusive.toLocaleString()}まで（両端を含む）です。範囲は自動拡張されません。
                </Typography>
              </Stack>

              {formError && <Alert severity="error">{formError}</Alert>}
              {phase.status === 'searching' && <SearchProgress progress={phase.progress} />}
              {phase.status === 'cancelled' && (
                <Alert severity="info">検索をキャンセルしました。入力内容と検索範囲を保持しています。そのまま再検索できます。</Alert>
              )}
              {phase.status === 'error' && <ErrorAlert error={phase.error} debugMode={debugMode} />}
              {result && <ResultAlert result={result.result} debugMode={debugMode} />}

              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Button variant="contained" sx={buttonSx} disabled={editingLocked} onClick={() => void search()}>検索</Button>
                <Button variant="outlined" sx={buttonSx} disabled={!searching} onClick={cancel}>キャンセル</Button>
              </Stack>

              {uniqueMatch !== null && (
                <Box component="section" aria-label="Counterの確定" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, sm: 2 } }}>
                  <Stack spacing={1.5}>
                    <SubHeading>Counterの確定</SubHeading>
                    <SafetyNotice title="確定前に必ず確認してください" />
                    <Typography variant="body2">
                      確定するのは調査前の状態で次に作成される位置です。観測のために作成した本数は加算されません。
                    </Typography>
                    <FormControlLabel
                      sx={{ m: 0, minHeight: 44, alignItems: 'flex-start' }}
                      control={(
                        <Checkbox
                          checked={gameRestoredConfirmed}
                          disabled={confirming}
                          onChange={(event) => setGameRestoredConfirmed(event.target.checked)}
                        />
                      )}
                      label="観測後にゲームを保存せず、調査前の状態へ戻ったことを確認しました"
                    />
                    {!gameRestoredConfirmed && (
                      <Typography variant="body2" color="text.secondary">上の確認にチェックするとCounterを確定できます。</Typography>
                    )}
                    {confirmError && <Alert severity="error">Counterを確定できませんでした: {confirmError}</Alert>}
                    <Box>
                      <Button variant="contained" sx={buttonSx} disabled={!gameRestoredConfirmed || confirming} onClick={() => void confirm()}>
                        {confirming ? '確定しています…' : 'Counterを確定'}
                      </Button>
                    </Box>
                  </Stack>
                </Box>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5 }}>
        <Button sx={buttonSx} disabled={confirming} onClick={onClose}>閉じる</Button>
      </DialogActions>
    </Dialog>
  )
}
