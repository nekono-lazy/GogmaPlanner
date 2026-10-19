import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildListEntry,
  BuildListEntryId,
  PlanConflict,
  ProductionPlan,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import type { PlannerWarningKind } from '../../domain/planner'
import {
  productionPlanRejectionCauseBreakdownOf,
  summarizeProductionPlanCompletion,
  type ProductionPlanRejectionCauseBreakdown,
} from '../../domain/planner/productionPlanCompletionSummary'
import {
  plannerWarningLabels,
  rejectedBuildListEntryReasonLabels,
  routeKindLabels,
} from '../../presentation/labels'
import type {
  ProductionPlanConflictViewModel,
  ProductionPlanInteractionViewModel,
  ProductionPlanParticipantUnavailableReason,
  ProductionPlanParticipantViewModel,
} from '../../services/planner/prepareProductionPlanInteraction'
import { CHECKPOINT_CONFLICT_MESSAGE } from '../../services/planner/prepareProductionPlanInteraction'
import type { PlannerInteractionPreparationResult } from '../../workers/plannerWorkerContracts'
import type { StatusTone } from '../StatusChip'
import {
  conflictPreferenceExplanation,
  UNRESOLVED_CONFLICT_PARTICIPANT_NAME,
} from './productionPlanConflictPreferencePresentation'
import { hasPlanTargetCompletionAuthority } from './productionPlanPresentation'

/**
 * The 「競合と解決」 section of the Production Plan screen as plain display data
 * (Issue #278 PR-3, `docs/UI_FLOW.md` 11.6.2 - 11.6.5, `docs/PLANNER_SPEC.md`
 * 9.6.9).
 *
 * Every text is chosen from typed data only: the persisted `PlanConflict.kind`,
 * selection and recommendation, `rejectedBuildListEntries.reason`, the Plan's
 * `executionEffects.targetCompletions`, and the current interaction
 * preparation's typed codes. No `PlanConflict.reason` / `resolutionNote`,
 * warning or issue message, Conflict ID hash or Counter value is read for the
 * normal display, nothing is parsed, and no ID is ever a fallback name; those
 * raw values are kept apart in `debug` for Debug Mode only.
 *
 * It decides nothing: whether a participant may be preferred is the Application
 * view model's `isAvailable` (the current preparation and the Domain decision
 * set), and this module only says why not.
 */

/** Where the section's current judgement comes from. */
export type ConflictSectionSource =
  | {
      status: 'ready'
      viewModel: ProductionPlanInteractionViewModel
      preparation: PlannerInteractionPreparationResult
    }
  /** The current preparation is still running. */
  | { status: 'preparing' }
  /** The current preparation failed; nothing current is known. */
  | { status: 'preparation_failed' }
  /** A stale or calculation-context-incompatible Plan: no preparation runs at all. */
  | { status: 'stale' }

/**
 * The current persisted Build List Entries and Targets the names are read from
 * (`docs/UI_FLOW.md` 11.6.3): the preparation's own fresh input when it is
 * ready, the page's independent reads otherwise.
 */
export type ConflictNameSource =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'loaded'
      buildListEntries: readonly BuildListEntry[]
      targetWeapons: readonly TargetWeapon[]
    }

export type ConflictDisplayStatus =
  /** No decision, a current initial Conflict, no effective checkpoint participant: choose here. */
  | 'pending'
  /** A persisted explicit decision. */
  | 'selected'
  /** An effective checkpoint participant: the Build List selection must change (11.1). */
  | 'checkpoint_change_required'
  /** Found while planning; never choosable, and recalculating the same input finds it again (9.6.7). */
  | 'dynamic'
  /** The input changed since the Plan was calculated; this Conflict cannot be reproduced now. */
  | 'input_changed'
  /** Current, but its novelty could not be judged safely: nothing is offered. */
  | 'not_compared'
  /** Nothing current is known (preparing, failed, stale, or a non-draft Plan): the persisted decision state only. */
  | 'undecided'

export interface ConflictStatusChip {
  label: string
  tone: StatusTone
}

export interface ConflictParticipantDisplay {
  /** React key and the action's argument only; never rendered as text. */
  buildListEntryId: BuildListEntryId
  /** The Target's name, `確認中`, or the "cannot be confirmed" label - never an ID. */
  name: string
  nameResolved: boolean
  /** `武器種 / 属性` from the Master, beside the name to tell equal names apart. */
  weaponLabel: string | null
  /** The registered Route as a judgement aid: its kind and its operation count estimate. */
  routeSummary: string | null
  chips: ConflictStatusChip[]
  /** Participant-specific sentences: why it cannot be preferred, how this Plan treats it. */
  notes: string[]
  isSelected: boolean
  /** Its Entry or Target cannot be read, or it cannot be preferred for a reason of its own: the Build List is the way on. */
  needsBuildListReview: boolean
  /**
   * 「この候補を優先」 is offered: the current preparation allows it (11.1 / 11.6.6).
   * The already selected participant keeps it too - pressing it recalculates
   * the same decision over the current state.
   */
  canPrefer: boolean
  /** The static meaning of preferring it (11.6.6), only when `canPrefer`. */
  preferExplanation: string | null
  /**
   * 「この候補を優先」 is shown disabled with this reason beside it (11.6.6): an
   * effective explicit decision of another Conflict leaves the participant
   * out, and the user changes that choice first. `null` when the action is
   * offered, or absent for a reason that offers no action at all.
   */
  preferDisabledReason: string | null
}

export interface ConflictDebugDetails {
  id: string
  kind: string
  buildListEntryIds: readonly string[]
  recommendedBuildListEntryId: string | null
  selectedBuildListEntryId: string | null
  reason: string
  resolutionNote: string | null
}

export interface ConflictCardDisplay {
  id: string
  /** 1-based display number; presentation only, never an identity. */
  number: number
  heading: string
  explanation: string
  status: ConflictDisplayStatus
  statusChip: ConflictStatusChip
  guidance: string[]
  /** A link to the Build List: to change a checkpoint selection, or to review the Entries. */
  buildListAction: 'change_checkpoint' | 'review' | null
  participants: ConflictParticipantDisplay[]
  debug: ConflictDebugDetails
}

export interface ConflictTargetDisplay {
  key: string
  /** The Target's name, or 「名前を確認できない目標武器」 - never an ID. */
  name: string
  weaponLabel: string | null
  /** `false` for a Target the Plan names but the current Targets no longer hold. */
  nameResolved: boolean
}

export interface ConflictNotCreatedTargetDisplay extends ConflictTargetDisplay {
  reason: string
}

/**
 * The not-made Targets by cause (Issue #121, `docs/UI_FLOW.md` 11.6.5), when
 * every rejection is recorded with its cause (`docs/PLANNER_SPEC.md` 9.6.9.1
 * conditions 1 - 4). The counts come from the shared Domain summary, never
 * from the rows, so they stay the same while the names load or fail and agree
 * with the overview.
 */
export interface ConflictTargetCauseGroups {
  /** `M`: the Targets a conflict with another Target leaves out (`R \ C`). */
  conflictCount: number
  /** `K`: the Targets of a stuck drop beside other pending Routes. */
  unestablishedCount: number
  /** Condition 5 holds: the overview shows the ratio. */
  ratioDetermined: boolean
  /** The rows of each group, disjoint, one per Target; empty until the names are loaded. */
  conflict: ConflictNotCreatedTargetDisplay[]
  unestablished: ConflictNotCreatedTargetDisplay[]
  other: ConflictNotCreatedTargetDisplay[]
}

export interface ConflictTargetOutcome {
  /** `false` for a legacy Plan without `executionEffects`: nothing is said about what it makes. */
  hasCompletionAuthority: boolean
  /** Whether the Build List / Target names could be read; nothing per Target is listed until they are. */
  namesStatus: 'loading' | 'failed' | 'loaded'
  /**
   * The distinct Targets of `steps[].executionEffects.targetCompletions` (the
   * 11.0 completion authority), known without any name; `null` for a legacy Plan.
   */
  createdCount: number | null
  created: ConflictTargetDisplay[]
  /** Completed Targets whose name cannot be read now (never shown as IDs). */
  createdUnresolvedCount: number
  /** Every not-made Target row; in the cause form, the three groups together. */
  notCreated: ConflictNotCreatedTargetDisplay[]
  /**
   * Participants or rejected Entries whose Target cannot be read now (in the
   * cause form: whose Target ID neither the Plan nor the current Entries name).
   */
  notCreatedUnresolvedCount: number
  /** The cause groups; `null` keeps the former single list (a Plan whose rejections are not recorded with causes). */
  causeGroups: ConflictTargetCauseGroups | null
}

export interface ConflictSectionDisplay {
  /** Persisted Conflict records; never a Target or weapon count. */
  conflictCount: number
  /** Records without a persisted selection. */
  undecidedCount: number
  /** Records with a persisted selection. */
  selectedCount: number
  /** Undecided records that can be decided here now (status `pending`); 0 while nothing current is known. */
  pendingCount: number
  /** `判断待ち` for a draft (it can be decided here), `未選択` otherwise. */
  undecidedLabel: string
  /**
   * The breakdown under the Conflict count: 判断待ち / 選択済み, plus the
   * undecided records that cannot be chosen here (a Build List checkpoint
   * change, a dynamic or no longer reproducible Conflict) when the current
   * judgement is known; 未選択 / 選択済み otherwise.
   */
  countDetail: string
  /** 「まだ判断が必要な競合があります（N件）」 for a draft, counting the 判断待ち Conflicts only. */
  pendingDecisionNotice: string | null
  /** Why nothing can be preferred now, when that holds for the whole section. */
  sectionNotices: string[]
  /** The Japanese labels of a whole-input fail closed (`preparation.status === 'invalid'`), by warning kind. */
  invalidPreparationReasons: string[] | null
  conflicts: ConflictCardDisplay[]
  targets: ConflictTargetOutcome
  showBuildListLink: boolean
}

// ------------------------------------------------------------------------------------------------ kind

/**
 * The heading and explanation of one Conflict from its persisted typed `kind`
 * alone (`docs/UI_FLOW.md` 11.6.2). Nothing a kind cannot say - which side
 * needs which operation, which owned weapon - is claimed. An unknown kind (an
 * old or broken record) gets the generic wording and is never hidden.
 */
export function conflictKindPresentation(
  kind: string,
  participantCount: number,
): { heading: string; explanation: string } {
  const conclusion = participantCount >= 3 ? 'これらを同時には作成できません。' : '同時には作成できません。'
  switch (kind) {
    case 'same_gogma_counter':
      return {
        heading: '復元ボーナスの抽選位置の競合',
        explanation: `復元ボーナスの抽選はすべての武器で共通の順番で進みます。同じ抽選位置を、それぞれの武器の復元ボーナスの再抽選で別々に使う必要があるため、${conclusion}`,
      }
    case 'same_skill_counter':
      return {
        heading: 'スキルの抽選位置の競合',
        explanation: `スキルの抽選はすべての武器で共通の順番で進みます。同じ抽選位置を、それぞれの武器の巨戟化またはスキル再付与で使う必要があるため、${conclusion}`,
      }
    case 'same_normal_counter':
      return {
        heading: '通常アーティアの作成位置の競合',
        explanation: '同じ武器種の通常アーティアは共通の順番で作成されるため、同じ作成位置をそれぞれの作成手順で同時には使えません。',
      }
    case 'same_owned_weapon_consumed':
      return {
        heading: '所持武器の競合',
        explanation: `同じ所持武器を、それぞれの作成手順で使う必要があるため、${conclusion}`,
      }
    default:
      return {
        heading: '作成手順の競合',
        explanation: participantCount >= 3
          ? 'これらの作成手順は同時に実行できません。'
          : 'この2件の作成手順は同時に実行できません。',
      }
  }
}

// ------------------------------------------------------------------------------------------------ participant reasons

export const UNRESOLVED_PARTICIPANT_NOTE =
  'この候補の目標武器を確認できません。作成リストを確認するか、画面を再読み込みしてください。'

/** Why the current validation excluded an Entry, in the user's words, by its typed warning kind. */
export function plannerExclusionText(kind: PlannerWarningKind | null): string {
  switch (kind) {
    case 'build_list_entry_stale':
      return 'この候補は、作成時から目標武器（有効・無効を含む）・所持武器・RNG状態などが変わったため、今回の計画には使えません。作成リストで候補を確認し、必要なら候補を検索し直してください。'
    case 'completed_target_excluded':
      return 'この目標武器は完了済みのため、生産計画の対象外です。'
    case 'calculation_context_incompatible':
      return 'この候補は以前の計算方式で作成されたため、今回の計画には使えません。候補を検索し直してください。'
    case 'protected_weapon_required':
      return 'この候補は保護中の所持武器を変更する必要があるため、今回の計画には使えません。'
    case 'rng_state_missing':
      return 'この候補に必要なRNG状態が確定していないため、今回の計画には使えません。'
    case 'rng_prediction_unsupported':
      return 'この候補の作成手順は予測に対応していないため、今回の計画には使えません。'
    default:
      return 'この候補は現在の計画対象から外れているため、優先できません。'
  }
}

/**
 * The participant-specific reason a participant cannot be preferred, or `null`
 * when the reason belongs to the whole section (not a draft, an invalid
 * preparation) or to the whole Conflict (not current, an effective checkpoint),
 * which say it once instead.
 */
export function participantUnavailableText(
  reason: ProductionPlanParticipantUnavailableReason | null,
  exclusionKind: PlannerWarningKind | null,
  conflictInvolvesCheckpoint: boolean,
): string | null {
  // `excluded_by_other_decision` is said with the other Conflict's number and
  // preferred name instead (`excludedByOtherDecisionText()`).
  switch (reason) {
    case null:
    case 'plan_not_draft':
    case 'preparation_invalid':
    case 'current_conflict_not_found':
    case 'excluded_by_other_decision':
      return null
    case 'entry_not_found':
    case 'target_not_found':
      return UNRESOLVED_PARTICIPANT_NOTE
    case 'planner_validation_excluded':
      return plannerExclusionText(exclusionKind)
    case 'not_current_conflict_participant':
      return '現在の作成リストでは、この候補はこの競合に含まれません。'
    case 'checkpoint_conflict':
      return conflictInvolvesCheckpoint
        ? null
        : 'この候補を優先すると、この候補の途中採用する状態の選択がこの競合に関係するため、ここでは優先できません。作成リストで途中採用する状態を変更または解除してください。'
  }
}

/** One effective decision of another Conflict that leaves a participant out, as the screen names it. */
export interface ConflictExcludingDecisionDisplay {
  /** The other Conflict's display number (`競合 N`), or `null` when it is not listed. */
  conflictNumber: number | null
  /** The Target name of the Entry that Conflict prefers, or `null` when it cannot be read. */
  preferredName: string | null
}

/**
 * Why a participant another Conflict's effective decision leaves out cannot
 * be preferred here, and what to do instead (`docs/UI_FLOW.md` 11.6.6): which
 * Conflict preferred which Target, and that the choice there changes first.
 * A name or number that cannot be read is never guessed; the sentence falls
 * back to 「別の競合」 / 「別の候補」.
 */
export function excludedByOtherDecisionText(
  participantName: string | null,
  decisions: readonly ConflictExcludingDecisionDisplay[],
): string {
  const subject = participantName === null ? 'この候補' : `「${participantName}」`
  const causes = decisions.map(({ conflictNumber, preferredName }) =>
    `${conflictNumber === null ? '別の競合' : `競合${conflictNumber}`}で${preferredName === null ? '別の候補' : `「${preferredName}」`}`)
  const numbers = decisions.map(({ conflictNumber }) => conflictNumber)
  const where =
    numbers.length === 0 || numbers.some((number) => number === null)
      ? 'その競合の選択'
      : numbers.length === 1
        ? `競合${numbers[0]}の選択`
        : `${numbers.map((number) => `競合${number}`).join('・')}のいずれかの選択`
  return `${subject}は、${causes.length === 0 ? '別の競合で別の候補' : causes.join('を、')}を優先したため、今回は作成しません。` +
    `この競合では優先できません。${subject}を優先したい場合は、先に${where}を変更してください。`
}

// ------------------------------------------------------------------------------------------------ names

interface NameLookup {
  status: ConflictNameSource['status']
  pending: boolean
  entry(buildListEntryId: BuildListEntryId): BuildListEntry | null
  target(targetWeaponId: TargetWeaponId): ConflictTargetDisplay | null
}

/**
 * Entries and Targets from the given collections only; an ID they do not hold
 * resolves to `null`, never to the ID. A Target reads as its name plus the
 * Master `武器種 / 属性` (the same form the Build List optimization Preview uses).
 */
function createNameLookup(names: ConflictNameSource, master: MasterDataRoot): NameLookup {
  if (names.status !== 'loaded') {
    return { status: names.status, pending: names.status === 'loading', entry: () => null, target: () => null }
  }
  const entries = new Map(names.buildListEntries.map((entry) => [entry.id, entry]))
  const targets = new Map(names.targetWeapons.map((target) => [target.id, target]))
  const weaponTypeNames = new Map(master.weaponTypes.map((type) => [type.id, type.displayNameJa]))
  const elementNames = new Map(master.elements.map((element) => [element.id, element.displayNameJa]))
  return {
    status: 'loaded',
    pending: false,
    entry: (id) => entries.get(id) ?? null,
    target: (id) => {
      const target = targets.get(id)
      if (target === undefined) return null
      return {
        key: target.id,
        name: target.name,
        weaponLabel: `${weaponTypeNames.get(target.weaponTypeId) ?? '不明な武器種'} / ${elementNames.get(target.elementId) ?? '不明な属性'}`,
        nameResolved: true,
      }
    },
  }
}

const PENDING_NAME = '確認中'

function joinNames(names: readonly string[]): string {
  return names.map((name) => `「${name}」`).join('、')
}

function routeSummaryOf(entry: BuildListEntry | null): string | null {
  if (entry === null) return null
  const kind = routeKindLabels[entry.candidateSnapshot.route.kind] ?? '作成ルート'
  return `${kind}・操作数の目安 ${entry.candidateSnapshot.estimatedOperationCount.toLocaleString('ja-JP')}回`
}

// ------------------------------------------------------------------------------------------------ target outcome

interface EntryNotCreatedReason {
  rank: 1 | 2 | 3 | 4
  text: string
  winners: string[]
}

function bestReason(current: EntryNotCreatedReason | undefined, next: EntryNotCreatedReason): EntryNotCreatedReason {
  if (current === undefined || next.rank < current.rank) return next
  if (next.rank === 1 && current.rank === 1) {
    return { ...current, winners: [...new Set([...current.winners, ...next.winners])] }
  }
  return current
}

function reasonOneText(winners: readonly string[]): string {
  return winners.length === 0
    ? '別の候補を優先したため、今回は作成しません。'
    : `${joinNames(winners)}を優先したため、今回は作成しません。`
}

/**
 * Why an Entry is not made by this Plan (`docs/UI_FLOW.md` 11.6.5), in the
 * fixed order of typed authorities: 1. a decided Conflict that preferred
 * another participant, 2. an undecided Conflict it takes part in, 3. its
 * `rejectedBuildListEntries.reason` label, 4. nothing more specific.
 */
function entryNotCreatedReason(
  plan: ProductionPlan,
  buildListEntryId: BuildListEntryId,
  isDraft: boolean,
  statusByConflictId: ReadonlyMap<string, ConflictDisplayStatus>,
  winnerName: (buildListEntryId: BuildListEntryId) => string | null,
): EntryNotCreatedReason {
  let best: EntryNotCreatedReason | undefined
  for (const conflict of plan.conflicts) {
    if (!conflict.buildListEntryIds.includes(buildListEntryId)) continue
    const selected = conflict.selectedBuildListEntryId
    if (selected !== null && selected !== buildListEntryId) {
      const name = winnerName(selected)
      best = bestReason(best, { rank: 1, text: '', winners: name === null ? [] : [name] })
    } else if (selected === null) {
      const status = statusByConflictId.get(conflict.id)
      const text = !isDraft
        ? '競合があるため、この計画では作成しません。'
        : status === 'dynamic'
          ? '計画の途中で生じた競合のため、今回は作成しません。'
          : status === 'checkpoint_change_required'
            ? '途中採用する状態の選択が関係する競合のため、今回は作成しません。'
            : '競合の選択待ちのため、今回は作成しません。'
      best = bestReason(best, { rank: 2, text, winners: [] })
    }
  }
  if (best?.rank === 1) return { ...best, text: reasonOneText(best.winners) }
  if (best !== undefined) return best
  const rejected = plan.rejectedBuildListEntries.find((entry) => entry.buildListEntryId === buildListEntryId)
  if (rejected !== undefined) {
    const label = rejectedBuildListEntryReasonLabels[rejected.reason]
    if (label !== undefined) return { rank: 3, text: `${label}。`, winners: [] }
  }
  return { rank: 4, text: 'この計画では作成しません。', winners: [] }
}

function completedTargetIds(plan: ProductionPlan): Set<TargetWeaponId> {
  return new Set(plan.steps.flatMap((step) =>
    (step.executionEffects?.targetCompletions ?? []).map(({ targetWeaponId }) => targetWeaponId)))
}

/** A Target the Plan names whose current record is gone: a row of its own, never its ID. */
export const UNNAMED_TARGET_NAME = '名前を確認できない目標武器'

export const UNESTABLISHED_NOT_CREATED_TEXT =
  '計画の途中で作成手順が行き詰まったため、今回は作成しません。ほかの目標武器との競合によるものかは確認できません。'

export const STUCK_ALONE_NOT_CREATED_TEXT =
  '計画の途中で、この候補の作成手順を先へ進められなくなったため、今回は作成しません。'

const GENERIC_NOT_CREATED_TEXT = 'この計画では作成しません。'

/**
 * The cause form of 「今回作成しない目標武器」 (`docs/UI_FLOW.md` 11.6.5): rows by
 * Target ID, in three disjoint groups, from the shared Domain summary.
 *
 * - 競合のため: `R \ C`, with the reason of the decided / undecided Conflicts
 *   the Target's own rejected Entries took part in, else the
 *   `resource_conflict` label
 * - 確認できない: the `stuck_drop_with_other_routes` Targets outside `C` and `R`
 * - その他: every other rejected or participating Target outside `C` and the
 *   two groups - by its record's own label (a lone stuck drop said as such),
 *   or 「この計画では作成しません。」 when it has none. Taking part in a Conflict
 *   is never a reason by itself here
 *
 * A Target ID comes from the Plan's own records first (a rejection's
 * `targetWeaponId`, a completion's Entry), then the current Entry; a Target
 * that is known but gone reads as unnamed and still counts, and only an Entry
 * whose Target nobody names is counted apart.
 */
function causeGroupsOf(
  plan: ProductionPlan,
  breakdown: ProductionPlanRejectionCauseBreakdown,
  ratioDetermined: boolean,
  completed: ReadonlySet<TargetWeaponId>,
  lookup: NameLookup,
  isDraft: boolean,
  statusByConflictId: ReadonlyMap<string, ConflictDisplayStatus>,
): { groups: ConflictTargetCauseGroups; unresolvedCount: number } {
  const groups: ConflictTargetCauseGroups = {
    conflictCount: breakdown.conflictNotCreatedTargetWeaponIds.length,
    unestablishedCount: breakdown.unestablishedNotCreatedTargetWeaponIds.length,
    ratioDetermined,
    conflict: [],
    unestablished: [],
    other: [],
  }
  if (lookup.status !== 'loaded') return { groups, unresolvedCount: 0 }

  const recordedTargetByEntry = new Map<BuildListEntryId, TargetWeaponId>()
  for (const step of plan.steps) {
    for (const { buildListEntryId, targetWeaponId } of step.executionEffects?.targetCompletions ?? []) {
      recordedTargetByEntry.set(buildListEntryId, targetWeaponId)
    }
  }
  for (const { buildListEntryId, targetWeaponId } of plan.rejectedBuildListEntries) {
    if (targetWeaponId !== undefined) recordedTargetByEntry.set(buildListEntryId, targetWeaponId)
  }
  const targetOfEntry = (buildListEntryId: BuildListEntryId): TargetWeaponId | null =>
    recordedTargetByEntry.get(buildListEntryId) ?? lookup.entry(buildListEntryId)?.targetWeaponId ?? null
  const rowOf = (targetWeaponId: TargetWeaponId): ConflictTargetDisplay =>
    lookup.target(targetWeaponId) ?? { key: targetWeaponId, name: UNNAMED_TARGET_NAME, weaponLabel: null, nameResolved: false }
  const winnerName = (buildListEntryId: BuildListEntryId): string | null => {
    const targetWeaponId = targetOfEntry(buildListEntryId)
    return targetWeaponId === null ? null : lookup.target(targetWeaponId)?.name ?? null
  }

  const conflictIds = new Set(breakdown.conflictNotCreatedTargetWeaponIds)
  const unestablishedIds = new Set(breakdown.unestablishedNotCreatedTargetWeaponIds)
  for (const targetWeaponId of breakdown.conflictNotCreatedTargetWeaponIds) {
    let reason: EntryNotCreatedReason | undefined
    for (const record of plan.rejectedBuildListEntries) {
      if (record.targetWeaponId !== targetWeaponId || record.reason !== 'resource_conflict') continue
      if (record.resourceConflictCause !== 'explicit_resolution_not_selected' &&
        record.resourceConflictCause !== 'provisional_outcome_not_committed') continue
      reason = bestReason(reason, entryNotCreatedReason(plan, record.buildListEntryId, isDraft, statusByConflictId, winnerName))
    }
    const text = reason === undefined
      ? GENERIC_NOT_CREATED_TEXT
      : reason.rank === 1 ? reasonOneText(reason.winners) : reason.text
    groups.conflict.push({ ...rowOf(targetWeaponId), reason: text })
  }
  for (const targetWeaponId of breakdown.unestablishedNotCreatedTargetWeaponIds) {
    groups.unestablished.push({ ...rowOf(targetWeaponId), reason: UNESTABLISHED_NOT_CREATED_TEXT })
  }

  // その他: a record's own label (rank 3) outranks taking part with no record (rank 4).
  const others = new Map<TargetWeaponId, { rank: 3 | 4; text: string }>()
  const unresolved = new Set<BuildListEntryId>()
  const addOther = (buildListEntryId: BuildListEntryId, rank: 3 | 4, text: string) => {
    const targetWeaponId = targetOfEntry(buildListEntryId)
    if (targetWeaponId === null) {
      unresolved.add(buildListEntryId)
      return
    }
    if (completed.has(targetWeaponId) || conflictIds.has(targetWeaponId) || unestablishedIds.has(targetWeaponId)) return
    const existing = others.get(targetWeaponId)
    if (existing === undefined || rank < existing.rank) others.set(targetWeaponId, { rank, text })
  }
  for (const buildListEntryId of new Set(plan.conflicts.flatMap(({ buildListEntryIds }) => buildListEntryIds))) {
    addOther(buildListEntryId, 4, GENERIC_NOT_CREATED_TEXT)
  }
  for (const record of plan.rejectedBuildListEntries) {
    const cause = record.resourceConflictCause
    // Its Target (always recorded, condition 4) is in `C` or one of the two
    // groups above by construction.
    if (cause === 'explicit_resolution_not_selected' || cause === 'provisional_outcome_not_committed' ||
      cause === 'stuck_drop_with_other_routes') continue
    const label = rejectedBuildListEntryReasonLabels[record.reason]
    addOther(
      record.buildListEntryId,
      3,
      cause === 'stuck_drop_without_other_routes'
        ? STUCK_ALONE_NOT_CREATED_TEXT
        : label === undefined ? GENERIC_NOT_CREATED_TEXT : `${label}。`,
    )
  }
  for (const [targetWeaponId, { text }] of others) {
    groups.other.push({ ...rowOf(targetWeaponId), reason: text })
  }
  return { groups, unresolvedCount: unresolved.size }
}

function createTargetOutcome(
  plan: ProductionPlan,
  lookup: NameLookup,
  isDraft: boolean,
  statusByConflictId: ReadonlyMap<string, ConflictDisplayStatus>,
): ConflictTargetOutcome {
  // The one Domain authority the overview reads too (PLANNER_SPEC 9.6.9.1).
  const summary = summarizeProductionPlanCompletion(plan)
  const hasCompletionAuthority = summary.status !== 'completion_unknown'
  const completed = completedTargetIds(plan)
  const createdCount = summary.status === 'completion_unknown' ? null : summary.completedCount
  const breakdown = productionPlanRejectionCauseBreakdownOf(summary)
  const cause = breakdown === null
    ? null
    : causeGroupsOf(plan, breakdown, summary.status === 'ratio_determined', completed, lookup, isDraft, statusByConflictId)
  if (!hasCompletionAuthority || lookup.status !== 'loaded') {
    return {
      hasCompletionAuthority,
      namesStatus: lookup.status,
      createdCount,
      created: [],
      createdUnresolvedCount: 0,
      notCreated: [],
      notCreatedUnresolvedCount: 0,
      causeGroups: cause?.groups ?? null,
    }
  }

  const created: ConflictTargetDisplay[] = []
  let createdUnresolvedCount = 0
  for (const targetWeaponId of completed) {
    const target = lookup.target(targetWeaponId)
    if (target === null) createdUnresolvedCount += 1
    else created.push(target)
  }

  if (cause !== null) {
    const { groups, unresolvedCount } = cause
    return {
      hasCompletionAuthority,
      namesStatus: 'loaded',
      createdCount,
      created,
      createdUnresolvedCount,
      notCreated: [...groups.conflict, ...groups.unestablished, ...groups.other],
      notCreatedUnresolvedCount: unresolvedCount,
      causeGroups: groups,
    }
  }

  // A Plan whose rejections are not recorded with their causes keeps the
  // former single list, its order and reasons (11.6.5).
  const candidateEntryIds = [
    ...new Set([
      ...plan.conflicts.flatMap(({ buildListEntryIds }) => buildListEntryIds),
      ...plan.rejectedBuildListEntries.map(({ buildListEntryId }) => buildListEntryId),
    ]),
  ]
  const winnerName = (buildListEntryId: BuildListEntryId): string | null => {
    const entry = lookup.entry(buildListEntryId)
    return entry === null ? null : lookup.target(entry.targetWeaponId)?.name ?? null
  }
  const reasonsByTarget = new Map<TargetWeaponId, { target: ConflictTargetDisplay; reason: EntryNotCreatedReason }>()
  const unresolved = new Set<string>()
  for (const buildListEntryId of candidateEntryIds) {
    const entry = lookup.entry(buildListEntryId)
    if (entry === null) {
      unresolved.add(`entry:${buildListEntryId}`)
      continue
    }
    if (completed.has(entry.targetWeaponId)) continue
    const target = lookup.target(entry.targetWeaponId)
    if (target === null) {
      unresolved.add(`target:${entry.targetWeaponId}`)
      continue
    }
    const reason = entryNotCreatedReason(plan, buildListEntryId, isDraft, statusByConflictId, winnerName)
    // One Target may take part through several Entries or Conflicts: it is
    // listed once, with the highest-ranked reason (and every preferred name).
    const existing = reasonsByTarget.get(entry.targetWeaponId)
    const merged = existing === undefined ? reason : bestReason(existing.reason, reason)
    reasonsByTarget.set(entry.targetWeaponId, {
      target,
      reason: merged.rank === 1 ? { ...merged, text: reasonOneText(merged.winners) } : merged,
    })
  }
  return {
    hasCompletionAuthority,
    namesStatus: 'loaded',
    createdCount,
    created,
    createdUnresolvedCount,
    notCreated: [...reasonsByTarget.values()].map(({ target, reason }) => ({ ...target, reason: reason.text })),
    notCreatedUnresolvedCount: unresolved.size,
    causeGroups: null,
  }
}

// ------------------------------------------------------------------------------------------------ conflict cards

function statusChipOf(status: ConflictDisplayStatus, undecidedLabel: string): ConflictStatusChip {
  switch (status) {
    case 'pending':
      return { label: '判断待ち', tone: 'caution' }
    case 'selected':
      return { label: '選択済み', tone: 'positive' }
    case 'checkpoint_change_required':
      return { label: '途中採用状態の変更が必要', tone: 'caution' }
    case 'dynamic':
      return { label: '計画の途中で生じた競合', tone: 'neutral' }
    case 'input_changed':
      return { label: '現在の入力では再現できない', tone: 'neutral' }
    case 'not_compared':
      return { label: '確認できない', tone: 'neutral' }
    case 'undecided':
      return { label: undecidedLabel, tone: 'neutral' }
  }
}

function readyConflictStatus(
  conflict: PlanConflict,
  current: ProductionPlanConflictViewModel,
  isDraft: boolean,
  preparationReady: boolean,
): ConflictDisplayStatus {
  if (!isDraft || !preparationReady) return conflict.selectedBuildListEntryId === null ? 'undecided' : 'selected'
  if (current.currency === 'current' && current.involvesSelectedCheckpoint) return 'checkpoint_change_required'
  if (conflict.selectedBuildListEntryId !== null) return 'selected'
  switch (current.currency) {
    case 'current':
      return 'pending'
    case 'dynamic':
      return 'dynamic'
    case 'input_changed':
      return 'input_changed'
    case 'not_compared':
      return 'not_compared'
  }
}

const NEXT_STEPS_FOR_UNCHOOSABLE =
  '次にできること: 開始時点からある競合で優先する候補を選ぶ、作成リストで候補を見直す、作成リスト画面の「生産計画を作成」から作り直す。'

function guidanceOf(
  status: ConflictDisplayStatus,
  conflict: PlanConflict,
  current: ProductionPlanConflictViewModel | null,
  selectedName: string | null,
  anyOtherPreferable: boolean,
): string[] {
  switch (status) {
    case 'pending':
      return [
        `${conflict.buildListEntryIds.length >= 3 ? 'どの' : 'どちらの'}候補を今回の計画で優先するか選んでください。優先しなかった候補は今回は作成しません（作成リストの候補は残ります）。`,
        '選ぶまでは、Plannerが暫定的にいずれかを作成予定として計算しています（選択済みではありません）。',
      ]
    case 'selected': {
      const lines = [
        selectedName === null
          ? 'この競合では候補を優先済みです。'
          : `「${selectedName}」を優先しています。`,
      ]
      if (current?.decisionNotCarriedReason) {
        lines.push('作成リスト・目標武器・状態が計算時から変わったため、この選択は現在の入力では再現できず、次に優先を選び直すときは引き継がれません。')
      } else if (anyOtherPreferable) {
        lines.push('選び直す場合は、別の候補の「この候補を優先」を押してください。')
      }
      return lines
    }
    case 'checkpoint_change_required':
      return [CHECKPOINT_CONFLICT_MESSAGE]
    case 'dynamic':
      return [
        'この競合は、計画を立てる途中（候補を外した後など）で生じたもので、ここでは優先する候補を選べません。',
        '同じ作成リストと状態のまま計算し直しても、同じ結果になります。',
        NEXT_STEPS_FOR_UNCHOOSABLE,
      ]
    case 'input_changed':
      return [
        '作成リスト・目標武器・状態が計算時から変わったため、この競合は現在の入力では再現できません。ここでは優先する候補を選べません。',
        '作成リスト画面の「生産計画を作成」から作り直してください。',
      ]
    case 'not_compared':
      return [
        '計算時の状態と現在の状態を比べられなかったため、この競合では優先する候補を選べません。作成リスト画面から生産計画を作り直してください。',
      ]
    case 'undecided':
      return []
  }
}

function buildListActionOf(status: ConflictDisplayStatus): ConflictCardDisplay['buildListAction'] {
  switch (status) {
    case 'checkpoint_change_required':
      return 'change_checkpoint'
    case 'dynamic':
    case 'input_changed':
    case 'not_compared':
      return 'review'
    default:
      return null
  }
}

interface ParticipantSource {
  buildListEntryId: BuildListEntryId
  isRecommended: boolean
  isSelected: boolean
  current: ProductionPlanParticipantViewModel | null
}

function participantDisplays(
  plan: ProductionPlan,
  conflict: PlanConflict,
  status: ConflictDisplayStatus,
  current: ProductionPlanConflictViewModel | null,
  lookup: NameLookup,
  completed: ReadonlySet<TargetWeaponId>,
  hasCompletionAuthority: boolean,
  excludedBy: ReadonlyMap<BuildListEntryId, string[]>,
  conflictNumbers: ReadonlyMap<string, number>,
): ConflictParticipantDisplay[] {
  // The Entries another Conflict of this Plan explicitly prefers: their
  // completion is a decision, not the Planner's provisional outcome.
  const preferredElsewhere = new Set(
    plan.conflicts.flatMap(({ id, selectedBuildListEntryId }) =>
      id !== conflict.id && selectedBuildListEntryId !== null ? [selectedBuildListEntryId] : []),
  )
  const sources: ParticipantSource[] = conflict.buildListEntryIds.map((buildListEntryId) => ({
    buildListEntryId,
    isRecommended: conflict.recommendedBuildListEntryId === buildListEntryId,
    isSelected: conflict.selectedBuildListEntryId === buildListEntryId,
    current: current?.participants.find((participant) => participant.buildListEntryId === buildListEntryId) ?? null,
  }))
  const resolved = sources.map((source) => {
    const entry = lookup.entry(source.buildListEntryId)
    const target = entry === null ? null : lookup.target(entry.targetWeaponId)
    return { source, entry, target }
  })
  const nameOf = (index: number): string =>
    resolved[index].target?.name ?? (lookup.pending ? PENDING_NAME : UNRESOLVED_CONFLICT_PARTICIPANT_NAME)
  const decided = conflict.selectedBuildListEntryId !== null
  const interactive = status === 'pending' || status === 'selected'

  return resolved.map(({ source, entry, target }, index) => {
    const chips: ConflictStatusChip[] = []
    const notes: string[] = []
    // Another Conflict's effective decision leaves it out (the Application's
    // typed attribution): said once, with that Conflict's number, below.
    const excludedByOther =
      source.current !== null && source.current.unavailableReason === 'excluded_by_other_decision'
    if (decided) {
      chips.push(source.isSelected
        ? { label: '優先（選択済み）', tone: 'positive' }
        : { label: '今回は作成しない', tone: 'neutral' })
    } else if (target !== null && entry !== null) {
      // An undecided Conflict: how this Plan treats the participant. Another
      // Conflict's explicit decision is a fact; anything else is only the
      // Planner's provisional outcome and is labelled as such (11.6.5).
      const winners = excludedBy.get(source.buildListEntryId)
      if (winners !== undefined) {
        chips.push({ label: '今回は作成しない', tone: 'neutral' })
        if (!excludedByOther) {
          notes.push(winners.length === 0
            ? '別の競合で別の候補を優先したため、今回は作成しません。'
            : `別の競合で${joinNames(winners)}を優先したため、今回は作成しません。`)
        }
      } else if (excludedByOther) {
        chips.push({ label: '今回は作成しない', tone: 'neutral' })
      } else if (hasCompletionAuthority && preferredElsewhere.has(source.buildListEntryId) && completed.has(entry.targetWeaponId)) {
        chips.push({ label: 'この計画で作成予定（別の競合で優先）', tone: 'positive' })
      } else if (hasCompletionAuthority) {
        chips.push(completed.has(entry.targetWeaponId)
          ? { label: '暫定：この計画で作成予定', tone: 'info' }
          : { label: '暫定：この計画では作成しない', tone: 'neutral' })
      }
    }
    if (source.isRecommended) chips.push({ label: 'Planner推奨（参考）', tone: 'info' })

    let needsBuildListReview = false
    if (target === null) {
      if (!lookup.pending) {
        notes.push(UNRESOLVED_PARTICIPANT_NOTE)
        needsBuildListReview = true
      }
    } else if (source.current !== null && !source.current.isAvailable) {
      const text = participantUnavailableText(
        source.current.unavailableReason,
        source.current.exclusionKind,
        current?.involvesSelectedCheckpoint ?? false,
      )
      if (text !== null && text !== UNRESOLVED_PARTICIPANT_NOTE) {
        notes.push(text)
        needsBuildListReview = true
      }
    }
    if (source.current?.checkpointOpportunityId != null) {
      notes.push('この候補の途中採用する状態の選択が、この競合に関係しています。')
    }

    // Only a participant the current preparation allows gets the action
    // (11.6.6); an unavailable one keeps its reason instead of a button. One
    // another Conflict's decision leaves out keeps the button, disabled, with
    // its reason beside it: the way on is that other Conflict's choice.
    const canPrefer =
      interactive &&
      source.current !== null &&
      source.current.isAvailable &&
      target !== null
    let preferDisabledReason: string | null = null
    if (excludedByOther && target !== null && source.current !== null) {
      const reason = excludedByOtherDecisionText(
        target.name,
        source.current.excludingDecisions.map(({ conflictKey, selectedBuildListEntryId }) => {
          const preferredEntry = lookup.entry(selectedBuildListEntryId)
          return {
            conflictNumber: conflictNumbers.get(conflictKey) ?? null,
            preferredName: preferredEntry === null ? null : lookup.target(preferredEntry.targetWeaponId)?.name ?? null,
          }
        }),
      )
      if (interactive) preferDisabledReason = reason
      else notes.push(reason)
    }
    return {
      buildListEntryId: source.buildListEntryId,
      name: nameOf(index),
      nameResolved: target !== null,
      weaponLabel: target?.weaponLabel ?? null,
      routeSummary: routeSummaryOf(entry),
      chips,
      notes,
      isSelected: source.isSelected,
      needsBuildListReview,
      canPrefer,
      preferExplanation: !canPrefer
        ? null
        : source.isSelected
          ? 'この候補を優先しています。押すと、同じ選択のまま、現在の作成リストと状態から生産計画を計算し直します。'
          : conflictPreferenceExplanation(resolved.flatMap((_, otherIndex) => (otherIndex === index ? [] : [nameOf(otherIndex)]))),
      preferDisabledReason,
    }
  })
}

/**
 * The Entries a decided Conflict of the displayed Plan excludes, each with the
 * names of the participants preferred over it: the persisted decisions only
 * (9.6.2), so it reads the same in every page state.
 */
function excludedByDecisions(plan: ProductionPlan, lookup: NameLookup): Map<BuildListEntryId, string[]> {
  const excluded = new Map<BuildListEntryId, string[]>()
  for (const conflict of plan.conflicts) {
    const selected = conflict.selectedBuildListEntryId
    if (selected === null) continue
    const selectedEntry = lookup.entry(selected)
    const name = selectedEntry === null ? null : lookup.target(selectedEntry.targetWeaponId)?.name ?? null
    for (const buildListEntryId of conflict.buildListEntryIds) {
      if (buildListEntryId === selected) continue
      const names = excluded.get(buildListEntryId) ?? []
      if (name !== null && !names.includes(name)) names.push(name)
      excluded.set(buildListEntryId, names)
    }
  }
  return excluded
}

function sectionNoticesOf(source: ConflictSectionSource, plan: ProductionPlan): string[] {
  switch (source.status) {
    case 'preparing':
      return ['優先する候補を選べるかどうか、現在の保存状態から確認しています。']
    case 'preparation_failed':
      return ['現在の保存状態を確認できなかったため、優先する候補を選べません。画面を再読み込みしてください。']
    case 'stale':
      return ['この生産計画は再計算が必要なため、優先する候補を選べません。']
    case 'ready':
      break
  }
  switch (plan.status) {
    case 'draft':
      return []
    case 'active':
      return ['実行中の生産計画では、優先する候補を変更できません。']
    case 'completed':
      return ['完了した生産計画では、優先する候補を変更できません。']
    case 'abandoned':
      return ['終了した生産計画では、優先する候補を変更できません。']
    case 'stale':
      return ['この生産計画は再計算が必要なため、優先する候補を選べません。']
  }
}

function invalidPreparationReasonsOf(source: ConflictSectionSource): string[] | null {
  if (source.status !== 'ready' || source.preparation.status !== 'invalid') return null
  const labels = [...new Set(source.preparation.warnings.map(({ kind }) => plannerWarningLabels[kind] ?? null))]
    .filter((label): label is string => label !== null)
  return labels
}

/** The whole section, from the exact persisted Plan and the typed current judgement. */
export function createProductionPlanConflictSectionDisplay(input: {
  plan: ProductionPlan
  source: ConflictSectionSource
  names: ConflictNameSource
  master: MasterDataRoot
}): ConflictSectionDisplay {
  const { plan, source } = input
  const lookup = createNameLookup(input.names, input.master)
  const isDraft = plan.status === 'draft'
  const viewModel = source.status === 'ready' ? source.viewModel : null
  const preparationReady = source.status === 'ready' && source.preparation.status === 'ready'
  const undecidedLabel = isDraft ? '判断待ち' : '未選択'
  const completed = completedTargetIds(plan)
  const hasCompletionAuthority = hasPlanTargetCompletionAuthority(plan)
  const excludedBy = excludedByDecisions(plan, lookup)
  const conflictNumbers = new Map(plan.conflicts.map(({ id }, index) => [id, index + 1]))

  const statusByConflictId = new Map<string, ConflictDisplayStatus>()
  const conflicts = plan.conflicts.map((conflict, index): ConflictCardDisplay => {
    const current = viewModel?.conflicts.find(({ id }) => id === conflict.id) ?? null
    const status = current === null
      ? conflict.selectedBuildListEntryId === null ? 'undecided' : 'selected'
      : readyConflictStatus(conflict, current, isDraft, preparationReady)
    statusByConflictId.set(conflict.id, status)
    const participants = participantDisplays(
      plan, conflict, status, current, lookup, completed, hasCompletionAuthority, excludedBy, conflictNumbers,
    )
    const selectedIndex = conflict.buildListEntryIds.findIndex((id) => id === conflict.selectedBuildListEntryId)
    const selected = selectedIndex < 0 ? null : participants[selectedIndex]
    const kind = conflictKindPresentation(conflict.kind, conflict.buildListEntryIds.length)
    return {
      id: conflict.id,
      number: index + 1,
      heading: kind.heading,
      explanation: kind.explanation,
      status,
      statusChip: statusChipOf(status, undecidedLabel),
      guidance: guidanceOf(
        status,
        conflict,
        current,
        selected?.nameResolved ? selected.name : null,
        participants.some(({ canPrefer, isSelected }) => canPrefer && !isSelected),
      ),
      buildListAction: buildListActionOf(status),
      participants,
      debug: {
        id: conflict.id,
        kind: String(conflict.kind),
        buildListEntryIds: [...conflict.buildListEntryIds],
        recommendedBuildListEntryId: conflict.recommendedBuildListEntryId,
        selectedBuildListEntryId: conflict.selectedBuildListEntryId,
        reason: conflict.reason,
        resolutionNote: conflict.resolutionNote,
      },
    }
  })

  const selectedCount = plan.conflicts.filter(({ selectedBuildListEntryId }) => selectedBuildListEntryId !== null).length
  const undecidedCount = plan.conflicts.length - selectedCount
  // Only a ready draft knows which undecided Conflicts can be decided here; a
  // 判断待ち count never includes one its card says cannot be chosen.
  const judged = isDraft && preparationReady
  const pendingCount = conflicts.filter(({ status }) => status === 'pending').length
  const unchoosableUndecidedCount = plan.conflicts.filter((conflict, index) =>
    conflict.selectedBuildListEntryId === null && conflicts[index].status !== 'pending').length
  const invalidPreparationReasons = invalidPreparationReasonsOf(source)
  return {
    conflictCount: plan.conflicts.length,
    undecidedCount,
    selectedCount,
    pendingCount,
    undecidedLabel,
    countDetail: judged
      ? `判断待ち ${pendingCount}件・選択済み ${selectedCount}件${unchoosableUndecidedCount > 0 ? `・ここでは選べない ${unchoosableUndecidedCount}件` : ''}`
      : `${undecidedLabel} ${undecidedCount}件・選択済み ${selectedCount}件`,
    pendingDecisionNotice: judged && pendingCount > 0
      ? `まだ判断が必要な競合があります（${pendingCount}件）。`
      : null,
    sectionNotices: sectionNoticesOf(source, plan),
    invalidPreparationReasons,
    conflicts,
    targets: createTargetOutcome(plan, lookup, isDraft, statusByConflictId),
    // A stale Plan's own page-level notice already links to the Build List.
    showBuildListLink:
      source.status === 'ready' &&
      (plan.status !== 'draft' ||
        invalidPreparationReasons !== null ||
        conflicts.some(({ buildListAction, participants }) =>
          buildListAction === 'review' || participants.some(({ needsBuildListReview }) => needsBuildListReview))),
  }
}
