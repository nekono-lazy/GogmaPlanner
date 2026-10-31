import {
  applyBuildListEntryStaleness,
  buildListEntriesForTarget,
  classifyBuildListCandidateAddition,
  createBuildListEntry,
  evaluateBuildListEntryStaleness,
  isSameBuildListCandidate,
  validateBuildListCardinality,
} from '../../domain/buildList'
import {
  unchangedMutableState,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanGuardedMutation,
} from '../../domain/execution'
import {
  targetWeaponPlanningIneligibilityCause,
  type TargetWeaponPlanningIneligibilityCause,
} from '../../domain/models/domainRules'
import { validateBuildListEntry } from '../../domain/models/publicTypes'
import type {
  BuildCandidate,
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  RngState,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import {
  buildListEntryRepository,
  normalArtianCounterRepository,
  ownedWeaponRepository,
  rngStateRepository,
  targetWeaponRepository,
  type BuildListEntryAdditionDecision,
} from '../../db/repositories'
import {
  defaultPlanGuardedPersistence,
  type PlanGuardedPersistence,
} from '../execution/planBreakingChangeGuard'

export interface BuildListServiceRepositories {
  getAllEntries(): Promise<BuildListEntry[]>
  /**
   * Refreshes an Entry's derived staleness flags. That cannot break a
   * ProductionPlan (`docs/PLANNER_SPEC.md` 16.6), so it is not guarded.
   */
  putEntry(entry: BuildListEntry): Promise<BuildListEntry>
  /**
   * Decides one Candidate addition over the persisted Build List and adds the
   * Entry the decision returns, in one read-write transaction
   * (`BuildListEntryRepository.decideAndAddBuildListEntry()`). An addition to a
   * Target with no Entry cannot break a ProductionPlan, so it is not guarded
   * (`docs/DATA_MODEL.md` 9.4.1).
   */
  decideAndAddEntry<R>(
    decide: (entries: BuildListEntry[]) => BuildListEntryAdditionDecision<R>,
  ): Promise<R>
  ensureRngState(): Promise<RngState>
  getNormalCounters(): Promise<NormalArtianCounter[]>
  getOwnedWeapons(): Promise<OwnedWeapon[]>
  getTargets(): Promise<TargetWeapon[]>
  /**
   * The breaking-change guard of the Build List operations that can break the
   * `active` Plan: deleting a selected Entry and replacing the Entry of a
   * Target.
   */
  persistence: PlanGuardedPersistence
  /** The `createdAt` of a replacing Entry. Defaults to the system clock. */
  clock?: { now(): ISODateTimeString }
}

export const defaultBuildListRepositories: BuildListServiceRepositories = {
  getAllEntries: () => buildListEntryRepository.getAllBuildListEntries(),
  putEntry: (entry) => buildListEntryRepository.putBuildListEntry(entry),
  decideAndAddEntry: (decide) => buildListEntryRepository.decideAndAddBuildListEntry(decide),
  ensureRngState: () => rngStateRepository.ensureInitialRngState(),
  getNormalCounters: () => normalArtianCounterRepository.getAllNormalArtianCounters(),
  getOwnedWeapons: () => ownedWeaponRepository.getAllOwnedWeapons(),
  getTargets: () => targetWeaponRepository.getAllTargetWeapons(),
  persistence: defaultPlanGuardedPersistence,
}

/**
 * The outcome of adding one Search Candidate to the persisted Build List
 * (`docs/DATA_MODEL.md` 9.4.1 「Candidate Searchからの追加と置換」). Only `added`
 * wrote anything.
 *
 * - `added`: the Target had no Entry, and the new Entry was added
 * - `duplicate`: the Target's one Entry is of the same semantic Candidate and
 *   is returned untouched - a re-add never rewrites it, a legacy Entry's
 *   persisted fields included
 * - `replacement_required`: the Target holds one Entry of another Candidate.
 *   Nothing was written; that Entry may only be replaced through
 *   `replaceCandidate()` after the user confirmed it
 * - `legacy_duplicate`: the Target already holds two or more Entries, so
 *   neither an addition nor a replacement is possible until the user kept one,
 *   even when the Candidate is the same as one of them
 */
export type AddBuildListCandidateResult =
  | { status: 'added'; entry: BuildListEntry }
  | { status: 'duplicate'; entry: BuildListEntry }
  | { status: 'replacement_required'; existingEntry: BuildListEntry }
  | { status: 'legacy_duplicate'; entries: BuildListEntry[] }

/**
 * One confirmed `replace BuildListEntry for Target` (`docs/DATA_MODEL.md` 9.4.1).
 *
 * `target` is the Target the Candidate was searched for, exactly as for an
 * addition, so the new Entry's Target definition hash describes the Candidate.
 * `expectedExistingEntryId` is the Entry the user saw and confirmed replacing:
 * the replacement is refused unless it is still that Target's only Entry.
 * The new Entry is built from the Candidate alone; nothing of the replaced
 * Entry is carried over.
 */
export interface BuildListCandidateReplacementRequest {
  candidate: BuildCandidate
  target: TargetWeapon
  expectedExistingEntryId: BuildListEntryId
}

/** Why a Build List addition or replacement was refused with nothing written. */
export type BuildListCardinalityErrorCode =
  | 'target_not_found'
  | 'replacement_target_changed'
  | 'legacy_duplicate_entries'
  | 'candidate_already_added'

const cardinalityErrorMessages: Record<BuildListCardinalityErrorCode, string> = {
  target_not_found: 'この目標武器はすでに存在しません。一覧を更新してください。',
  replacement_target_changed:
    '置き換える作成リストの候補が変更されました。作成リストを確認してから、もう一度操作してください。',
  legacy_duplicate_entries:
    'この目標武器には作成リストに複数の候補が登録されています。作成リストで使用する候補を1件にしてから、もう一度操作してください。',
  candidate_already_added:
    'この候補は作成リストに追加済みです。',
}

export class BuildListCardinalityError extends Error {
  readonly code: BuildListCardinalityErrorCode

  constructor(code: BuildListCardinalityErrorCode) {
    super(cardinalityErrorMessages[code])
    this.name = 'BuildListCardinalityError'
    this.code = code
  }
}

/**
 * Why a stale Entry's re-search replacement was refused with nothing written
 * (`docs/DATA_MODEL.md` 9.4.1 「再検索による置換」, Issue #347). The first three
 * are the cardinality refusals the confirmed replacement shares; the others
 * are the re-search's own premises re-read inside the transaction.
 */
export type BuildListStaleCandidateReplacementErrorCode =
  | 'target_not_found'
  | 'replacement_target_changed'
  | 'legacy_duplicate_entries'
  /**
   * The Target can no longer be searched by the state the save runs on
   * (`targetWeaponPlanningIneligibilityCause()`): it was completed, its search
   * was disabled, or its completion condition awaits review since the batch
   * started. A re-search never replaces the Entry of a Target the single
   * search could not search.
   */
  | 'target_completed'
  | 'target_disabled'
  | 'target_review_required'
  /** The Entry the batch set out to replace is no longer stale by the state the save runs on. */
  | 'entry_no_longer_stale'
  /** The found Candidate is already stale against the state the save runs on (the state moved after its search). */
  | 'candidate_not_current'

/** The refusal code of each cause `targetWeaponPlanningIneligibilityCause()` names. */
const staleCandidateReplacementIneligibilityCodes: Record<
  TargetWeaponPlanningIneligibilityCause,
  BuildListStaleCandidateReplacementErrorCode
> = {
  completed: 'target_completed',
  disabled: 'target_disabled',
  review_required: 'target_review_required',
}

const staleCandidateReplacementErrorMessages: Record<BuildListStaleCandidateReplacementErrorCode, string> = {
  target_not_found: cardinalityErrorMessages.target_not_found,
  replacement_target_changed: cardinalityErrorMessages.replacement_target_changed,
  legacy_duplicate_entries: cardinalityErrorMessages.legacy_duplicate_entries,
  target_completed:
    'この目標武器は完了済みになっていたため、候補を置き換えませんでした。元の候補はそのまま登録されています。',
  target_disabled:
    'この目標武器は検索対象OFFになっていたため、候補を置き換えませんでした。元の候補はそのまま登録されています。',
  target_review_required:
    'この目標武器は完成条件の再設定が必要になっていたため、候補を置き換えませんでした。元の候補はそのまま登録されています。目標武器画面で内容を確認して保存してください。',
  entry_no_longer_stale:
    'この作成リストの候補は再検索が不要になっていたため、置き換えませんでした。元の候補はそのまま登録されています。',
  candidate_not_current:
    '検索の後にRNG状態・所持武器・目標武器が変わったため、検索結果をそのまま登録できませんでした。元の候補はそのまま登録されています。もう一度検索してください。',
}

export class BuildListStaleCandidateReplacementError extends Error {
  readonly code: BuildListStaleCandidateReplacementErrorCode

  constructor(code: BuildListStaleCandidateReplacementErrorCode) {
    super(staleCandidateReplacementErrorMessages[code])
    this.name = 'BuildListStaleCandidateReplacementError'
    this.code = code
  }
}

/**
 * One replacement 「再検索が必要な候補を一括再検索・置換」 makes for a Target
 * (`docs/DATA_MODEL.md` 9.4.1 「再検索による置換」, Issue #347): the Candidate
 * its re-search found, the Target that search ran with, and the stale Entry
 * the batch set out to replace. Like the confirmed replacement, the Entry ID
 * is the premise the save re-checks; nothing of the replaced Entry is carried
 * over.
 */
export interface BuildListStaleCandidateReplacementRequest {
  candidate: BuildCandidate
  target: TargetWeapon
  expectedExistingEntryId: BuildListEntryId
}

function assertValidEntry(entry: BuildListEntry): void {
  const valid = validateBuildListEntry(entry)
  if (!valid.isValid) {
    throw new Error(
      valid.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }
}

/**
 * One confirmed `replace BuildListEntry for Target` as a guarded mutation
 * (`docs/DATA_MODEL.md` 9.4.1): the replaced Entry's removal and the new
 * Entry's addition are one change, so the breaking-change guard judges them
 * together and the persistence writes them in one transaction.
 *
 * Every premise is re-read from the state the mutation runs on, never trusted
 * from the screen: the Target must still exist and hold exactly the Entry the
 * user confirmed replacing (another tab may have changed it), and the Candidate
 * must not be that Entry's own - a re-add never rewrites the Entry. The new
 * Entry comes from the Candidate alone, with a fresh ID and no
 * `intermediateStateSelection`; nothing of the replaced Entry (a legacy
 * selection or improvement preference included) is carried over, and no record
 * referring to it is touched. The replaced Target
 * must satisfy the Build List cardinality contract afterwards. Any refusal
 * throws before anything is written.
 */
export function buildListEntryReplacementMutation(
  request: BuildListCandidateReplacementRequest,
  createdAt: ISODateTimeString,
): PlanGuardedMutation<BuildListEntry> {
  return (base) => {
    const { candidate, target, expectedExistingEntryId } = request
    if (!base.targetWeapons.some(({ id }) => id === target.id)) {
      throw new BuildListCardinalityError('target_not_found')
    }
    const current = buildListEntriesForTarget(base.buildListEntries, target.id)
    if (current.length >= 2) throw new BuildListCardinalityError('legacy_duplicate_entries')
    const [existing] = current
    if (existing === undefined || existing.id !== expectedExistingEntryId) {
      throw new BuildListCardinalityError('replacement_target_changed')
    }
    if (isSameBuildListCandidate(existing, candidate)) {
      throw new BuildListCardinalityError('candidate_already_added')
    }
    const entry = createBuildListEntry(candidate, target, { createdAt })
    assertValidEntry(entry)
    if (base.buildListEntries.some(({ id }) => id === entry.id)) {
      throw new Error(`BuildListEntry '${entry.id}' already exists and is never overwritten.`)
    }
    const buildListEntries = [
      ...base.buildListEntries.filter(({ id }) => id !== existing.id),
      entry,
    ]
    const cardinality = validateBuildListCardinality(
      buildListEntriesForTarget(buildListEntries, target.id),
    )
    if (!cardinality.isValid) {
      throw new Error(cardinality.issues.map(({ message }) => message).join('\n'))
    }
    return {
      result: entry,
      state: { ...unchangedMutableState(base), buildListEntries },
    }
  }
}

/**
 * One stale Entry's re-search replacement as a guarded mutation
 * (`docs/DATA_MODEL.md` 9.4.1 「再検索による置換」, Issue #347). It differs from
 * `buildListEntryReplacementMutation()` in exactly two premises, both re-read
 * from the state the mutation runs on:
 *
 * - the Target must still be one the single search could search
 *   (`targetWeaponPlanningIneligibilityCause()` names none): a Target completed,
 *   disabled or sent back to review since the batch started keeps its Entry
 *   (`target_completed` / `target_disabled` / `target_review_required`).
 *   `isEnabled`, the lifecycle and the review are outside the Target
 *   definition hash, so the staleness checks below would not catch them
 * - the Target's one Entry must still be stale by
 *   `evaluateBuildListEntryStaleness()` recomputed from that state (an Entry
 *   that is up to date again - the RNG state was restored, say - is kept as it
 *   is: `entry_no_longer_stale`)
 * - the new Entry built from the Candidate must be up to date against that
 *   same state (a search result the state moved past is never written:
 *   `candidate_not_current`)
 *
 * and a Candidate of the same semantic meaning as the stale Entry's is
 * allowed: the point of the re-search is a fresh Entry whose Target definition
 * hash, search state hash, referenced weapons hash and CalculationContext are
 * the current ones, so `candidate_already_added` is never raised here. The
 * replaced Entry's removal and the new Entry's addition are still one change
 * for the breaking-change guard and one transaction; the new Entry gets a
 * fresh ID, and nothing of the replaced Entry is carried over. Every other
 * premise (the Target exists, holds exactly the expected Entry, the
 * cardinality afterwards) is the confirmed replacement's.
 */
export function buildListStaleCandidateReplacementMutation(
  request: BuildListStaleCandidateReplacementRequest,
  createdAt: ISODateTimeString,
  currentCalculationContext: CalculationContext,
): PlanGuardedMutation<BuildListEntry> {
  return (base) => {
    const { candidate, target, expectedExistingEntryId } = request
    const currentTarget = base.targetWeapons.find(({ id }) => id === target.id) ?? null
    if (currentTarget === null) throw new BuildListStaleCandidateReplacementError('target_not_found')
    // The current Target, never the one the search ran with: it may have been
    // completed, disabled or sent back to review in another tab meanwhile.
    const ineligibility = targetWeaponPlanningIneligibilityCause(currentTarget)
    if (ineligibility !== null) {
      throw new BuildListStaleCandidateReplacementError(staleCandidateReplacementIneligibilityCodes[ineligibility])
    }
    const current = buildListEntriesForTarget(base.buildListEntries, target.id)
    if (current.length >= 2) throw new BuildListStaleCandidateReplacementError('legacy_duplicate_entries')
    const [existing] = current
    if (existing === undefined || existing.id !== expectedExistingEntryId) {
      throw new BuildListStaleCandidateReplacementError('replacement_target_changed')
    }
    if (base.rngState === null) {
      throw new Error('No RngState is stored, so no Build List staleness can be judged.')
    }
    const stalenessContext = {
      target: currentTarget,
      rngState: base.rngState,
      normalCounters: base.normalCounters,
      ownedWeapons: base.ownedWeapons,
      calculationContext: currentCalculationContext,
    }
    if (!evaluateBuildListEntryStaleness(existing, stalenessContext).isStale) {
      throw new BuildListStaleCandidateReplacementError('entry_no_longer_stale')
    }
    const entry = createBuildListEntry(candidate, target, { createdAt })
    assertValidEntry(entry)
    if (evaluateBuildListEntryStaleness(entry, stalenessContext).isStale) {
      throw new BuildListStaleCandidateReplacementError('candidate_not_current')
    }
    if (base.buildListEntries.some(({ id }) => id === entry.id)) {
      throw new Error(`BuildListEntry '${entry.id}' already exists and is never overwritten.`)
    }
    const buildListEntries = [
      ...base.buildListEntries.filter(({ id }) => id !== existing.id),
      entry,
    ]
    const cardinality = validateBuildListCardinality(
      buildListEntriesForTarget(buildListEntries, target.id),
    )
    if (!cardinality.isValid) {
      throw new Error(cardinality.issues.map(({ message }) => message).join('\n'))
    }
    return {
      result: entry,
      state: { ...unchangedMutableState(base), buildListEntries },
    }
  }
}

/** One Build List Entry delete as a guarded mutation. */
export function buildListEntryDeleteMutation(id: BuildListEntryId): PlanGuardedMutation<void> {
  return (base) => ({
    result: undefined,
    state: {
      ...unchangedMutableState(base),
      buildListEntries: base.buildListEntries.filter((entry) => entry.id !== id),
    },
  })
}

export class BuildListService {
  private readonly repositories: BuildListServiceRepositories

  constructor(repositories: BuildListServiceRepositories = defaultBuildListRepositories) {
    this.repositories = repositories
  }

  /**
   * Adds one Candidate to a Target that has no Entry, and otherwise reports
   * what the addition would mean without writing anything
   * (`AddBuildListCandidateResult`, `docs/DATA_MODEL.md` 9.4.1).
   *
   * The Build List holds at most one Entry per Target, so another Candidate of
   * a Target that already has an Entry is never added beside it: it needs the
   * user's confirmed `replaceCandidate()`. An existing equivalent Entry is
   * returned untouched (`docs/UI_FLOW.md` 9): a re-add never rewrites it. The
   * new Entry carries no `intermediateStateSelection` (Issue #100). The
   * decision and the addition run in one transaction.
   */
  async addCandidate(
    candidate: BuildCandidate,
    target: TargetWeapon,
  ): Promise<AddBuildListCandidateResult> {
    const entry = createBuildListEntry(candidate, target)
    assertValidEntry(entry)
    return this.repositories.decideAndAddEntry<AddBuildListCandidateResult>((entries) => {
      const state = classifyBuildListCandidateAddition(entries, candidate)
      switch (state.status) {
        case 'target_empty':
          return { entry, result: { status: 'added', entry } }
        case 'duplicate':
          return { entry: null, result: { status: 'duplicate', entry: state.entry } }
        case 'replacement_required':
          return {
            entry: null,
            result: { status: 'replacement_required', existingEntry: state.existingEntry },
          }
        case 'legacy_duplicate':
          return { entry: null, result: { status: 'legacy_duplicate', entries: state.entries } }
      }
    })
  }

  /**
   * Replaces the Target's one Entry with a new Entry of `request.candidate`,
   * after the user confirmed it (`docs/DATA_MODEL.md` 9.4.1). The replaced Entry
   * is removed and the new one added in one guarded transaction: when the
   * replaced Entry is a Plan-dependent Entry of the `active` Plan, the change
   * needs the breaking-change approval and, approved, ends that Plan in the same
   * transaction (`docs/PLANNER_SPEC.md` 16.6). A refusal writes nothing.
   */
  async replaceCandidate(
    request: BuildListCandidateReplacementRequest,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<BuildListEntry> {
    const mutation = buildListEntryReplacementMutation(request, this.now())
    return (await this.repositories.persistence.apply(mutation, approval)).result
  }

  /** Whether the replacement needs the breaking-change approval (`docs/UI_FLOW.md` 16.3). Writes nothing. */
  inspectCandidateReplacement(
    request: BuildListCandidateReplacementRequest,
  ): Promise<PlanBreakingChangeInspection> {
    return this.repositories.persistence.inspect(
      buildListEntryReplacementMutation(request, this.now()),
    )
  }

  /**
   * Replaces a Target's one stale Entry with a new Entry of the Candidate its
   * re-search found (`docs/DATA_MODEL.md` 9.4.1 「再検索による置換」, Issue #347),
   * for 「再検索が必要な候補を一括再検索・置換」 only. It takes no approval: the
   * batch never approves a breaking change, so when the replaced Entry is one
   * the `active` Plan depends on the guard refuses with
   * `PlanBreakingChangeApprovalRequiredError` and nothing is written - the
   * user replaces that Entry through the single search's confirmed replacement
   * instead. A refusal of the re-search's own premises is a typed
   * `BuildListStaleCandidateReplacementError`; either way the stale Entry stays
   * exactly as persisted.
   */
  async replaceStaleCandidate(
    request: BuildListStaleCandidateReplacementRequest,
    currentCalculationContext: CalculationContext,
  ): Promise<BuildListEntry> {
    const mutation = buildListStaleCandidateReplacementMutation(request, this.now(), currentCalculationContext)
    return (await this.repositories.persistence.apply(mutation, null)).result
  }

  async refreshStaleness(
    calculationContext: CalculationContext,
  ): Promise<{
    entries: BuildListEntry[]
    targets: TargetWeapon[]
    ownedWeapons: OwnedWeapon[]
  }> {
    const [entries, rngState, normalCounters, ownedWeapons, targets] =
      await Promise.all([
        this.repositories.getAllEntries(),
        this.repositories.ensureRngState(),
        this.repositories.getNormalCounters(),
        this.repositories.getOwnedWeapons(),
        this.repositories.getTargets(),
      ])
    const targetById = new Map(targets.map((target) => [target.id, target]))
    const refreshed = await Promise.all(
      entries.map(async (entry) => {
        const result = evaluateBuildListEntryStaleness(entry, {
          target: targetById.get(entry.targetWeaponId) ?? null,
          rngState,
          normalCounters,
          ownedWeapons,
          calculationContext,
        })
        if (
          result.isStale === entry.isStale &&
          result.staleReasons.join() === entry.staleReasons.join()
        ) {
          return entry
        }
        return this.repositories.putEntry(
          applyBuildListEntryStaleness(entry, result),
        )
      }),
    )
    return { entries: refreshed, targets, ownedWeapons }
  }

  /**
   * Deletes one Entry through the breaking-change guard. It is also how the
   * user tidies a legacy duplicate (`docs/DATA_MODEL.md` 9.4.1): deleting one
   * Entry of a Target that holds several is an ordinary delete, never refused
   * for the Target's other Entries.
   */
  async deleteEntry(id: BuildListEntryId, approval: PlanBreakingChangeApproval | null = null): Promise<void> {
    await this.repositories.persistence.apply(buildListEntryDeleteMutation(id), approval)
  }

  /** Whether deleting the Entry needs the breaking-change approval (`docs/UI_FLOW.md` 16.3). Writes nothing. */
  inspectEntryDelete(id: BuildListEntryId): Promise<PlanBreakingChangeInspection> {
    return this.repositories.persistence.inspect(buildListEntryDeleteMutation(id))
  }

  private now(): ISODateTimeString {
    return this.repositories.clock?.now() ?? new Date().toISOString()
  }
}

export const buildListService = new BuildListService()
