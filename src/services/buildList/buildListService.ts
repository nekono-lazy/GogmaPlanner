import {
  applyBuildListEntryStaleness,
  buildListEntriesForTarget,
  classifyBuildListCandidateAddition,
  createBuildListEntry,
  defaultIntermediateStateSelection,
  evaluateBuildListEntryStaleness,
  isSameBuildListCandidate,
  validateBuildListCardinality,
  withIntermediateStateSelection,
} from '../../domain/buildList'
import {
  unchangedMutableState,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanGuardedMutation,
} from '../../domain/execution'
import { validateBuildListEntry } from '../../domain/models/publicTypes'
import type {
  BuildCandidate,
  BuildListEntry,
  BuildListEntryId,
  CalculationContext,
  IntermediateStateSelection,
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
   * `active` Plan: changing a selected Entry's intermediate state selection or
   * improvement preference, deleting a selected Entry, and replacing the Entry
   * of a Target.
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
 *   is returned untouched - its selection and improvement preference are never
 *   overwritten by a re-add
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
 * `intermediateStateSelection` is the Search screen's own selection; nothing of
 * the replaced Entry is carried over.
 */
export interface BuildListCandidateReplacementRequest {
  candidate: BuildCandidate
  target: TargetWeapon
  intermediateStateSelection: IntermediateStateSelection
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
    'この候補は作成リストに追加済みです。途中採用する状態と改善優先は作成リストで変更してください。',
}

export class BuildListCardinalityError extends Error {
  readonly code: BuildListCardinalityErrorCode

  constructor(code: BuildListCardinalityErrorCode) {
    super(cardinalityErrorMessages[code])
    this.name = 'BuildListCardinalityError'
    this.code = code
  }
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
 * must not be that Entry's own - a re-add never overwrites a selection. The new
 * Entry comes from the Candidate and the request's own selection alone, with a
 * fresh ID; the replaced Entry's selection and improvement preference are not
 * carried over, and no record referring to it is touched. The replaced Target
 * must satisfy the Build List cardinality contract afterwards. Any refusal
 * throws before anything is written.
 */
export function buildListEntryReplacementMutation(
  request: BuildListCandidateReplacementRequest,
  createdAt: ISODateTimeString,
): PlanGuardedMutation<BuildListEntry> {
  return (base) => {
    const { candidate, target, intermediateStateSelection, expectedExistingEntryId } = request
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
    const entry = createBuildListEntry(candidate, target, { intermediateStateSelection, createdAt })
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
 * One intermediate state selection change as a guarded mutation. The Domain
 * validation is the authority for at most one state per lane and for every id
 * existing on its own lane of the Candidate Snapshot, so an invalid selection
 * fails closed here rather than reaching the Planner.
 */
export function intermediateStateSelectionMutation(
  id: BuildListEntryId,
  intermediateStateSelection: IntermediateStateSelection,
): PlanGuardedMutation<BuildListEntry> {
  return (base) => {
    const existing = base.buildListEntries.find((entry) => entry.id === id)
    if (!existing) {
      throw new Error(`BuildListEntry '${id}' does not exist.`)
    }
    const updated = withIntermediateStateSelection(existing, intermediateStateSelection)
    assertValidEntry(updated)
    return {
      result: updated,
      state: {
        ...unchangedMutableState(base),
        buildListEntries: base.buildListEntries.map((entry) => (entry.id === id ? updated : entry)),
      },
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
   * returned untouched: its intermediate state selection and improvement
   * preference are the user's Build List input, and the Search screen's current
   * selection must never silently overwrite them (`docs/UI_FLOW.md` 9). The
   * decision and the addition run in one transaction.
   */
  async addCandidate(
    candidate: BuildCandidate,
    target: TargetWeapon,
    intermediateStateSelection: IntermediateStateSelection = defaultIntermediateStateSelection(),
  ): Promise<AddBuildListCandidateResult> {
    const entry = createBuildListEntry(candidate, target, {
      intermediateStateSelection,
    })
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
   * Replaces one Entry's intermediate state selection and improvement
   * preference.
   *
   * The Domain validation is the authority for at most one state per lane
   * and for every id existing on its own lane of the Candidate Snapshot, so
   * an invalid selection fails closed here rather than reaching the Planner.
   * A lane start (position 0) is a legal selection: for an existing Gogma,
   * both lane starts - or one start beside a lane that is already Ideal - is
   * the weapon the user holds now, and the Planner treats that compromise
   * checkpoint as reached at its start; a conversion Route's lane start is
   * reached once the conversion ran (`docs/PLANNER_SPEC.md` 7.5.2).
   */
  async updateIntermediateStateSelection(
    id: BuildListEntryId,
    intermediateStateSelection: IntermediateStateSelection,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<BuildListEntry> {
    const mutation = intermediateStateSelectionMutation(id, intermediateStateSelection)
    return (await this.repositories.persistence.apply(mutation, approval)).result
  }

  /** Whether the selection change needs the breaking-change approval (`docs/UI_FLOW.md` 16.3). Writes nothing. */
  inspectIntermediateStateSelectionUpdate(
    id: BuildListEntryId,
    intermediateStateSelection: IntermediateStateSelection,
  ): Promise<PlanBreakingChangeInspection> {
    return this.repositories.persistence.inspect(intermediateStateSelectionMutation(id, intermediateStateSelection))
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
