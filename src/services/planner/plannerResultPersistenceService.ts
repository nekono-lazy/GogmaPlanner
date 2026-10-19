import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  BuildListEntryRepository,
  NormalArtianCounterRepository,
  OwnedWeaponRepository,
  ProductionPlanRepository,
  RngStateRepository,
  TargetWeaponRepository,
} from '../../db/repositories'
import {
  assertRepositoryValidation,
  RepositoryError,
} from '../../db/repositoryError'
import type { BuildListEntryReplacement } from '../../domain/buildList'
import {
  ExecutionRuntimeError,
  unchangedMutableState,
  type PlanBreakingChangeApproval,
  type PlanGuardedMutation,
  type PlanGuardedMutationBase,
} from '../../domain/execution'
import type {
  BuildListEntry,
  CalculationContext,
  ExpectedPlanState,
  ImprovementPreference,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  ProductionPlan,
  ProductionPlanId,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import {
  createExpectedPlanState,
  isCalculationContextCompatible,
  validateRngState,
} from '../../domain/models/publicTypes'
import {
  checkGeneratedBuildListEntriesFresh,
  checkPersistableConflictPreferenceResultShape,
  checkPersistableOrdinaryPlannerResultShape,
  checkPlannerRunTerminationPersistable,
  checkPreferredBuildListEntriesCompleted,
  checkProductionPlanBuildListEntryReferences,
  checkRejectedBuildListEntryTargets,
  collectProductionPlanDependentTargetWeaponIds,
  createPlanningBuildListEntriesHash,
  createPlanningTargetWeaponsHash,
  entryImprovementPreference,
  prepareFinalReplacementBuildList,
  type PlannerConflictResolution,
  type PlannerResult,
  type PlannerResultPersistenceIssue,
} from '../../domain/planner'
import {
  checkBuildListOptimizationExclusionsInBuildList,
  checkBuildListOptimizationFinalSelection,
  checkPersistableBuildListOptimizationArtifact,
} from '../../domain/planner/buildListOptimization/buildListOptimizationAdoption'
import type {
  BuildListOptimizationInputExclusion,
  BuildListOptimizationInputToken,
} from '../../domain/planner/buildListOptimization/buildListOptimizationResult'
import { PlanBreakingChangeGuard } from '../execution/planBreakingChangeGuard'
import { buildListOptimizationResultIssues } from './buildListOptimizationResultCheck'
import type { BuildListOptimizationAdoptionSource } from './buildListOptimizationService'

/**
 * The save-time boundary of PLANNER_SPEC 9.2.15 / 9.2.18 / 9.6.6 / 17.11. Three
 * Planner results are saved, each through its own entry points (the
 * optimization since Issue #260 PR-6A, the conflict preference since Issue #278
 * PR-2):
 *
 * - The ordinary Planner result (`createPlan()`, Phase 6-A) is saved through
 *   `savePlannerResult()`: it carries no generated BuildListEntry and no
 *   replacement, so the save re-validates the Plan against the current Build
 *   List exactly as it is, replaces the previous Draft with the new one, and
 *   never writes a BuildListEntry.
 * - The ordinary Planner result of the Production Plan screen's 「この候補を
 *   優先」 (Issue #278, `docs/PLANNER_SPEC.md` 9.6.6) is saved through
 *   `savePlannerConflictPreferenceResult()`: the ordinary boundary plus the
 *   explicit decisions it was calculated from (honoured, recorded, every
 *   preferred Entry completed) and the source Draft CAS. It writes no
 *   BuildListEntry either.
 * - The Build List global optimization (`docs/PLANNER_SPEC.md` 17.11, Issue
 *   #260 PR-6A) is adopted through `inspectBuildListOptimizationAdoptionSave()`
 *   / `saveBuildListOptimizationAdoption()`. Its artifact replaces the Entry of
 *   every planning Target whose Route changed in one all-or-nothing save; the
 *   artifact is never converted into an ordinary result. On top of the shared
 *   boundary it re-checks the start state of its calculation (no running Plan,
 *   the observed Draft) and the whole input token (the input Build List
 *   included), and its Draft starts a new chain.
 *
 * All of them are pure calculations over the snapshot their Worker was handed.
 * Persisting one therefore re-reads the current state *inside* the same Dexie
 * read-write transaction that writes, re-validates the Plan against that state
 * with the existing snapshot authorities, and only then deletes the previous
 * Draft, replaces each Entry the optimization replaced with its generated
 * BuildListEntry and adds the new Draft together. There is no window between
 * the check and the write, and no partial save: either the previous Draft is
 * gone, every replaced Entry is gone, every generated Entry and the new Plan
 * are stored, or nothing changed and the previous Draft survives.
 *
 * A generated Entry replaces the persisted Entry `O` of its Target
 * (`docs/PLANNER_SPEC.md` 9.2.18). The transaction deletes that `O` only after
 * confirming it is still the Target's one persisted Entry, never whatever Entry
 * the Target holds now. Every save is one guarded mutation of the existing
 * Plan-breaking guard (16.6), but none of them breaks a running Plan: the
 * ordinary and conflict preference results replace no Entry, and a Build List
 * optimization is adopted only while no Plan runs. An approval given anyway is
 * refused as not required before anything is written.
 *
 * The Planner Alternative actual repair save (`inspectPlannerAlternativeRepairSave()`
 * / `savePlannerAlternativeRepair()`), which could replace an Entry the `active`
 * Plan depends on and therefore needed the approval and the guard's
 * restore-instead-of-change branch, lost its last caller with Issue #278 PR-2
 * and was removed in Issue #278 PR-5 (`docs/PLANNER_SPEC.md` 9.6.11).
 *
 * The Draft replacement (`docs/DATA_MODEL.md` 11.1, `docs/PLANNER_SPEC.md`
 * 9.2.15) deletes only `draft` ProductionPlan records - never an `active` /
 * `stale` / `completed` / `abandoned` Plan, and never the BuildListEntries,
 * BuildCandidates or Targets the previous Draft referenced, because a Draft
 * owns no Entry and no persisted authority could say which Entry belonged to
 * it alone. It is never done in a separate transaction ahead of the save, and it
 * never replaces a Plan under its ID: the new Plan's ID is checked against the
 * whole collection in the same transaction before any Draft is deleted
 * (`production_plan_id_conflict`).
 *
 * It re-runs nothing. The full Planner run, Trace Replay and the Build List
 * optimization's Stage 0 - D' stay the Workers' authority, so no `RngEngine` is
 * created on the main thread. Save time only compares the finished Plan against
 * current persisted state.
 *
 * The legacy B8 orchestration save shared this boundary until Phase 6-B2b
 * removed it; its "every generated Entry is selected" check went with it.
 */

/** The repositories the save-time transaction reads and writes through. */
export interface PlannerResultPersistenceRepositories {
  rngState: RngStateRepository
  normalCounters: NormalArtianCounterRepository
  ownedWeapons: OwnedWeaponRepository
  targetWeapons: TargetWeaponRepository
  buildListEntries: BuildListEntryRepository
  productionPlans: ProductionPlanRepository
}

export function createPlannerResultPersistenceRepositories(
  database: AppDatabase,
): PlannerResultPersistenceRepositories {
  return {
    rngState: new RngStateRepository(database),
    normalCounters: new NormalArtianCounterRepository(database),
    ownedWeapons: new OwnedWeaponRepository(database),
    targetWeapons: new TargetWeaponRepository(database),
    buildListEntries: new BuildListEntryRepository(database),
    productionPlans: new ProductionPlanRepository(database),
  }
}

export interface PlannerResultPersistenceOptions {
  /** The time an approved breaking change ends the `active` Plan at. */
  clock?: { now(): ISODateTimeString }
}

const systemClock = { now: (): ISODateTimeString => new Date().toISOString() }

/**
 * How one ordinary or conflict preference Planner result save ended
 * (`docs/PLANNER_SPEC.md` 9.2.15 / 9.6.6). Every refusal throws and writes
 * nothing.
 *
 * - `saved`: the new Draft is stored and the previous Draft is gone
 * - `no_plan`: the calculation produced no Plan; nothing was written and the
 *   previous Draft is kept
 *
 * Neither save writes the Build List, so no Plan-breaking approval - and no
 * save point restore - ever applies. (The outcome
 * `save_point_restored_recalculation_required` of the Planner Alternative repair
 * save went with that save in Issue #278 PR-5.)
 */
export type PlannerResultSaveOutcome =
  | { kind: 'saved'; plan: ProductionPlan }
  | { kind: 'no_plan' }

/**
 * How one Build List optimization adoption ended (`docs/PLANNER_SPEC.md`
 * 17.11): the replacements, the previous Draft's removal and the new Draft are
 * stored. An adoption is refused while a Plan runs, so no Plan-breaking
 * approval - and no save point restore - ever applies to it: every refusal
 * throws and writes nothing.
 */
export type BuildListOptimizationAdoptionSaveOutcome = Extract<
  PlannerResultSaveOutcome,
  { kind: 'saved' }
>

/** One Entry the adoption replaces, with the improvement preference its replacement does not carry over (17.5). */
export interface BuildListOptimizationAdoptionReplacementInspection extends BuildListEntryReplacement {
  /** The persisted `O`'s `improvementPreference`; the generated `G` starts at `planner`. */
  replacedImprovementPreference: ImprovementPreference
}

/**
 * What adopting one Build List optimization would write, read in the same
 * snapshot that validated it (`docs/UI_FLOW.md` 10.4 adoption confirmation).
 * It is never write authority: the save validates everything again in its own
 * transaction.
 */
export interface BuildListOptimizationAdoptionInspection {
  /** The current Draft the adoption deletes - the one observed when the calculation started - or `null` when there is none. */
  replacedDraftPlanId: ProductionPlanId | null
  /** In the artifact's order. Empty when every planning Target keeps its Entry: only the Draft is saved. */
  replacements: BuildListOptimizationAdoptionReplacementInspection[]
  /** The planning Targets whose current Entry is kept with its settings. */
  unchangedTargetWeaponIds: TargetWeaponId[]
}

/**
 * Current persisted state diverged from the Plan's own snapshot. Nothing was
 * written; re-running the Planner over the current state is the recovery.
 */
function stateChanged(message: string): RepositoryError {
  return new RepositoryError('planner_state_changed', message)
}

/**
 * The Planner result itself is not persistable. Re-running the Planner over
 * unchanged state would fail the same way, so this is not retryable.
 */
function resultInvalid(message: string): RepositoryError {
  return new RepositoryError('planner_result_invalid', message)
}

/**
 * Maps a shared save-time issue onto this service's `RepositoryError`
 * boundary; `null` passes.
 */
function throwIssue(issue: PlannerResultPersistenceIssue | null): void {
  if (issue === null) return
  switch (issue.kind) {
    case 'result_invalid':
      throw resultInvalid(issue.message)
    case 'state_changed':
      throw stateChanged(issue.message)
    case 'entity_invalid':
      assertRepositoryValidation(issue.entityName, issue.validation)
      return
  }
}

function sameExpectedPlanState(
  left: ExpectedPlanState,
  right: ExpectedPlanState,
): boolean {
  return (
    left.rngStateHash === right.rngStateHash &&
    left.normalCountersHash === right.normalCountersHash &&
    left.ownedWeaponsHash === right.ownedWeaponsHash &&
    // Calculation schema 12 state includes the Plan-dependent Target execution
    // state; a stored Plan is always of the current schema here, because an
    // incompatible CalculationContext fails closed before this comparison.
    left.targetExecutionStateHash === right.targetExecutionStateHash
  )
}

interface PlannerSaveCurrentState {
  rngState: RngState
  normalCounters: readonly NormalArtianCounter[]
  ownedWeapons: readonly OwnedWeapon[]
  targetWeapons: readonly TargetWeapon[]
  buildListEntries: readonly BuildListEntry[]
}

/** One persistable Planner result, its shape already checked. */
interface PersistablePlannerResult {
  plan: ProductionPlan
  generatedEntries: readonly BuildListEntry[]
  replacements: readonly BuildListEntryReplacement[]
  /**
   * The Draft a conflict preference result was calculated from: the one Draft
   * the save must still find current (`docs/PLANNER_SPEC.md` 9.6.6). `null`
   * for an ordinary result of the Build List and for a Build List optimization
   * adoption, which start a new chain and inherit nothing from the displayed
   * Draft (the adoption checks its own observed Draft instead).
   */
  expectedSourceDraftId: ProductionPlanId | null
  /**
   * The explicit decisions a conflict preference result was calculated from;
   * empty for every other result. The save requires each preferred Entry to be
   * completed by the Plan over the current Build List (9.6.6).
   */
  conflictResolutions: readonly PlannerConflictResolution[]
  /**
   * The start state and the input token a Build List optimization adoption
   * re-checks (`docs/PLANNER_SPEC.md` 17.10 / 17.11 T2); `null` for the
   * ordinary and conflict preference results.
   */
  buildListOptimization: BuildListOptimizationAdoptionPremises | null
}

/** What a Build List optimization adoption re-checks against the current state, beside the shared boundary. */
interface BuildListOptimizationAdoptionPremises {
  /** The Application's start snapshot: the Draft current when the calculation started, or `null`. */
  observedDraftPlanId: ProductionPlanId | null
  /** The Worker-side input token items (17.10). */
  inputToken: BuildListOptimizationInputToken
  planningTargetWeaponIds: readonly TargetWeaponId[]
  unchangedTargetWeaponIds: readonly TargetWeaponId[]
  /** Stage 0's excluded Entries with their Targets, re-checked against the Build List they were taken from. */
  inputExclusions: readonly BuildListOptimizationInputExclusion[]
}

/** Receives the post-validation view of one adoption (the inspection only). */
type BuildListOptimizationAdoptionObserver = (inspection: BuildListOptimizationAdoptionInspection) => void

export class PlannerResultPersistenceService {
  private readonly database: AppDatabase
  private readonly repositories: PlannerResultPersistenceRepositories
  private readonly clock: { now(): ISODateTimeString }

  constructor(
    database: AppDatabase = appDatabase,
    repositories: PlannerResultPersistenceRepositories =
      createPlannerResultPersistenceRepositories(database),
    options: PlannerResultPersistenceOptions = {},
  ) {
    this.database = database
    this.repositories = repositories
    this.clock = options.clock ?? systemClock
  }

  /**
   * Saves one ordinary Planner result (`PlannerWorkerClient.createPlan()`,
   * `docs/PLANNER_SPEC.md` 9.2.15, Phase 6-A) as the new Draft, replacing the
   * previous Draft in the same transaction.
   *
   * An `incomplete` run is refused (`planner_result_invalid`) whether or not it
   * carries a partial Plan, and nothing is written. A finished run with no
   * Plan returns `no_plan` and keeps the previous Draft. Otherwise the Plan
   * must be a draft without a repair lineage that passes Domain validation,
   * and inside one transaction it is re-validated against the current state
   * with the shared snapshot authorities - CalculationContext,
   * `initialExecutionState`, the Target and Build List hashes, every
   * BuildListEntry reference and a free Plan ID - before the previous Draft is
   * deleted and the new one added. The Build List is read, never written: an
   * ordinary result replaces no Entry, so the save never breaks a running Plan
   * and needs no approval (an approval given anyway is refused by the guard as
   * not required).
   */
  async savePlannerResult(
    result: PlannerResult,
    currentCalculationContext: CalculationContext,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<PlannerResultSaveOutcome> {
    const persistable = this.persistableOrdinaryResult(result)
    if (persistable === null) return { kind: 'no_plan' }
    return this.applyGuarded(persistable, currentCalculationContext, approval)
  }

  /**
   * Saves the ordinary Planner result of 「この候補を優先」
   * (`docs/PLANNER_SPEC.md` 9.6.6) as the new Draft, replacing the Draft it was
   * calculated from in the same transaction.
   *
   * Beside every check of `savePlannerResult()` it refuses a result that did
   * not honour an explicit decision (`invalid_conflict_resolution`), whose
   * `conflicts` and `plan.conflicts` differ, whose Conflicts do not record
   * exactly `context.conflictResolutions` as their selections, or whose Plan
   * does not complete every Entry those decisions prefer (its
   * `selectedBuildListEntryIds` and a `targetCompletions` record of its Target,
   * read from the current Build List). Inside the transaction the one current
   * Draft must still be `context.expectedSourceDraftId` - the Draft the user
   * acted on - or nothing is written (`planner_state_changed`; two Drafts:
   * `draft_plan_conflict`). An `incomplete` run is `planner_result_invalid` and
   * a finished run without a Plan is `no_plan`; both keep the previous Draft.
   *
   * The Build List is read, never written, so no running Plan is broken and no
   * Plan-breaking approval or save point choice ever applies. The saved Draft
   * carries no repair lineage.
   */
  async savePlannerConflictPreferenceResult(
    result: PlannerResult,
    context: {
      conflictResolutions: readonly PlannerConflictResolution[]
      expectedSourceDraftId: ProductionPlanId
    },
    currentCalculationContext: CalculationContext,
  ): Promise<PlannerResultSaveOutcome> {
    throwIssue(checkPlannerRunTerminationPersistable(result.termination))
    const { plan } = result
    if (plan === null) return { kind: 'no_plan' }
    throwIssue(checkPersistableConflictPreferenceResultShape(plan, result, context.conflictResolutions))
    return this.applyGuarded(
      {
        plan,
        generatedEntries: [],
        replacements: [],
        expectedSourceDraftId: context.expectedSourceDraftId,
        conflictResolutions: context.conflictResolutions.map((resolution) => ({ ...resolution })),
        buildListOptimization: null,
      },
      currentCalculationContext,
      null,
    )
  }

  /**
   * Reads whether one Build List optimization can be adopted now
   * (`docs/PLANNER_SPEC.md` 17.11) and what the adoption would write, in one
   * read-only transaction over the same guarded mutation the save runs. It
   * writes nothing and refuses exactly what the save would refuse. Its success
   * is no write authority: the save checks everything again.
   */
  async inspectBuildListOptimizationAdoptionSave(
    source: BuildListOptimizationAdoptionSource,
    currentCalculationContext: CalculationContext,
  ): Promise<BuildListOptimizationAdoptionInspection> {
    const persistable = this.persistableBuildListOptimization(source)
    const observed: { inspection: BuildListOptimizationAdoptionInspection | null } = { inspection: null }
    const guarded = await this.guard(currentCalculationContext).inspect(
      this.saveMutation(persistable, currentCalculationContext, (inspection) => {
        observed.inspection = inspection
      }),
    )
    if (guarded.approvalRequired || observed.inspection === null) {
      // Unreachable: the mutation refuses any running Plan before the guard judges one.
      throw new Error('A Build List optimization adoption never breaks a running Plan.')
    }
    return observed.inspection
  }

  /**
   * Adopts one Build List optimization (`docs/PLANNER_SPEC.md` 17.11, O5): in
   * one transaction every replacement deletes its Target's `O` and adds its
   * generated `G`, the previous Draft is deleted, and the final Plan is added
   * as the new Draft (`conflictRepairLineage = null`, no provenance). A
   * replacement-free adoption writes the Draft alone.
   *
   * The artifact is checked first ([P1]: the shared shape helpers and the
   * optimization's own conditions), then inside the transaction: no running
   * Plan and the Draft observed when the calculation started (T2), the current
   * state against the whole input token (T2), each `O` still its Target's one
   * Entry and the replaced Build List (T3 / T4), the generated Entries' freshness
   * recomputed from the current state (T5), and the Plan's snapshot and
   * references against the replaced Build List (T6). Every failure throws and
   * writes nothing - the Build List, the previous Draft and every other table
   * stay as they were: `planner_state_changed` (the state moved after the
   * calculation started), `planner_result_invalid` (the artifact is not
   * persistable), `draft_plan_conflict`, `production_plan_id_conflict`,
   * `validation_failed` or `transaction_failed`.
   *
   * No Plan runs while an optimization is adopted, so no Plan-breaking approval
   * applies: an approval given anyway is refused
   * (`plan_breaking_change_approval_not_required`) before anything is read.
   */
  async saveBuildListOptimizationAdoption(
    source: BuildListOptimizationAdoptionSource,
    currentCalculationContext: CalculationContext,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<BuildListOptimizationAdoptionSaveOutcome> {
    const persistable = this.persistableBuildListOptimization(source)
    if (approval !== null) {
      throw new ExecutionRuntimeError(
        'plan_breaking_change_approval_not_required',
        'A Build List optimization is adopted only while no Plan runs, so no Plan-breaking approval applies; review the adoption again.',
      )
    }
    return this.applyGuarded(persistable, currentCalculationContext, null)
  }

  /**
   * The guarded write every Planner result kind shares: the save mutation's
   * Build List post-state (each `O` deleted, each `G` added), then the new
   * Plan ID check and the Draft replacement, in one transaction. None of the
   * saves breaks a running Plan, so the guard refuses any approval it is given
   * (`plan_breaking_change_approval_not_required`, or
   * `plan_breaking_change_state_changed` without an `active` Plan) before
   * anything is written, whatever save point decision it carries.
   */
  private async applyGuarded(
    persistable: PersistablePlannerResult,
    currentCalculationContext: CalculationContext,
    approval: PlanBreakingChangeApproval | null,
  ): Promise<Extract<PlannerResultSaveOutcome, { kind: 'saved' }>> {
    const { plan } = persistable
    const outcome = await this.guard(currentCalculationContext).apply(
      this.saveMutation(persistable, currentCalculationContext),
      approval,
      {
        afterWrite: async () => {
          // A newly calculated Plan carries a fresh ID: an ID the collection
          // already holds - whatever that Plan's status, the previous Draft
          // included - is a different Plan and is refused here, inside the
          // transaction and before the Draft replacement, so a Draft holding
          // the same ID is never deleted and re-added under it.
          await this.repositories.productionPlans.assertProductionPlanIdFree(plan.id)
          // The new Draft replaces the previous one (DATA_MODEL 11.1): only
          // Draft records are deleted, their referenced Entries stay, and any
          // failure below rolls this deletion back with the rest of the
          // transaction - the Entry replacements and any Plan termination
          // included.
          await this.repositories.productionPlans.deleteDraftProductionPlans()
          await this.repositories.productionPlans.addProductionPlan(plan)
        },
      },
    )
    return { kind: 'saved', plan: outcome.result }
  }

  /**
   * The result-shape invariants of an ordinary Planner result, or `null` for a
   * finished run with no Plan. It carries no generated Entry and no
   * replacement, so the shared save boundary runs with empty sets.
   */
  private persistableOrdinaryResult(result: PlannerResult): PersistablePlannerResult | null {
    // An incomplete run is refused before `plan === null` is read: a
    // truncated run is never reported as an ordinary "no Plan" result.
    throwIssue(checkPlannerRunTerminationPersistable(result.termination))
    const { plan } = result
    if (plan === null) return null
    throwIssue(checkPersistableOrdinaryPlannerResultShape(plan, result.termination))
    return {
      plan,
      generatedEntries: [],
      replacements: [],
      expectedSourceDraftId: null,
      conflictResolutions: [],
      buildListOptimization: null,
    }
  }

  /**
   * [P1] of a Build List optimization adoption (`docs/PLANNER_SPEC.md` 17.11):
   * the runtime-only source is untrusted until it passes the main thread's
   * structural check of an `optimized` Worker result, and its start snapshot is
   * the Application's. Then the Domain's artifact checks. An ordinary
   * `PlannerResult` or a repair artifact is not an optimization artifact and is
   * refused here.
   */
  private persistableBuildListOptimization(source: BuildListOptimizationAdoptionSource): PersistablePlannerResult {
    const candidate: unknown = source
    if (typeof candidate !== 'object' || candidate === null) {
      throw resultInvalid('A Build List optimization adoption needs the optimized artifact and its start snapshot.')
    }
    const { artifact, startSnapshot } = candidate as Partial<BuildListOptimizationAdoptionSource>
    const issues = buildListOptimizationResultIssues({ status: 'optimized', artifact })
    if (issues.length > 0 || artifact === undefined) {
      throw resultInvalid(`The Build List optimization artifact is malformed: ${issues.join(' ')}`)
    }
    const observedDraftPlanId: unknown = startSnapshot?.observedDraftPlanId
    if (
      typeof startSnapshot !== 'object' || startSnapshot === null || startSnapshot.runningPlanAbsent !== true ||
      !(observedDraftPlanId === null || (typeof observedDraftPlanId === 'string' && observedDraftPlanId.length > 0))
    ) {
      throw resultInvalid('The Build List optimization start snapshot must name the observed Draft (or none) and the absence of a running Plan.')
    }
    const checked = checkPersistableBuildListOptimizationArtifact(artifact)
    if (checked.issue !== null) {
      throwIssue(checked.issue)
      throw resultInvalid('The Build List optimization artifact is not persistable.')
    }
    return {
      ...checked.adoption,
      expectedSourceDraftId: null,
      conflictResolutions: [],
      buildListOptimization: {
        observedDraftPlanId: startSnapshot.observedDraftPlanId,
        inputToken: artifact.inputToken,
        planningTargetWeaponIds: artifact.planningTargetWeaponIds,
        unchangedTargetWeaponIds: artifact.unchangedTargetWeaponIds,
        inputExclusions: artifact.inputExclusions,
      },
    }
  }

  private guard(currentCalculationContext: CalculationContext): PlanBreakingChangeGuard {
    return new PlanBreakingChangeGuard({
      database: this.database,
      currentCalculationContext,
      clock: this.clock,
    })
  }

  /**
   * The whole save as one pure guarded mutation: from the persisted state it
   * is given it re-validates the Plan and returns the final Build List (the
   * replacement set) as the post-state the Plan-breaking guard judges. No
   * Planner result save breaks a running Plan, so the guard never applies it
   * to a restored state.
   *
   * A Build List optimization adoption adds its own premises around the shared
   * checks: the start state and the input token before them (17.11 T2), the
   * final selection after them, and - for the inspection only - `observe`
   * receives what the adoption would write once everything passed.
   */
  private saveMutation(
    persistable: PersistablePlannerResult,
    currentCalculationContext: CalculationContext,
    observe?: BuildListOptimizationAdoptionObserver,
  ): PlanGuardedMutation<ProductionPlan> {
    return (base: PlanGuardedMutationBase) => {
      const { plan, buildListOptimization } = persistable
      if (persistable.expectedSourceDraftId !== null) {
        this.assertSourceDraftCurrent(base, persistable.expectedSourceDraftId)
      }
      if (buildListOptimization !== null) {
        this.assertBuildListOptimizationStartState(base, buildListOptimization.observedDraftPlanId)
      }
      const current = this.currentState(base)
      if (buildListOptimization !== null) {
        this.assertBuildListOptimizationInputToken(persistable, buildListOptimization, current, currentCalculationContext)
      }
      const finalEntries = this.assertCurrentStateMatchesPlan(
        persistable,
        current,
        currentCalculationContext,
      )
      this.assertPlanReferences(persistable, finalEntries)
      if (persistable.conflictResolutions.length > 0) {
        throwIssue(checkPreferredBuildListEntriesCompleted(plan, persistable.conflictResolutions, finalEntries))
      }
      if (buildListOptimization !== null) {
        throwIssue(checkBuildListOptimizationFinalSelection(plan, finalEntries, buildListOptimization.planningTargetWeaponIds))
        throwIssue(checkBuildListOptimizationExclusionsInBuildList(buildListOptimization.inputExclusions, finalEntries))
        observe?.(this.buildListOptimizationInspection(persistable, buildListOptimization, current))
      }
      return {
        state: { ...unchangedMutableState(base), buildListEntries: finalEntries },
        result: plan,
      }
    }
  }

  /** The Draft records the mutation's base holds; two or more break the Draft invariant (`docs/DATA_MODEL.md` 11.1). */
  private currentDrafts(base: PlanGuardedMutationBase): ProductionPlan[] {
    const drafts = base.productionPlans.filter(({ status }) => status === 'draft')
    if (drafts.length > 1) {
      throw new RepositoryError(
        'draft_plan_conflict',
        `ProductionPlan draft invariant violated: ${drafts.length} draft ProductionPlans are stored.`,
      )
    }
    return drafts
  }

  /**
   * T2 of a Build List optimization adoption (`docs/PLANNER_SPEC.md` 17.11):
   * the calculation started with no running Plan and with the Draft it observed
   * (or none), and the adoption replaces exactly that Draft. A Plan started,
   * a Draft created, deleted or replaced meanwhile moved the state on. The
   * Draft's ID is the authority - never a body comparison. (Two running Plans
   * are refused by the guard before this mutation runs.)
   */
  private assertBuildListOptimizationStartState(base: PlanGuardedMutationBase, observedDraftPlanId: ProductionPlanId | null) {
    const running = base.productionPlans.find(({ status }) => status === 'active' || status === 'stale')
    if (running !== undefined) {
      throw stateChanged(
        `ProductionPlan '${running.id}' is running (${running.status}); a Build List optimization is adopted only while no Plan is active or stale.`,
      )
    }
    const drafts = this.currentDrafts(base)
    const currentDraftId = drafts[0]?.id ?? null
    if (currentDraftId !== observedDraftPlanId) {
      const describe = (id: ProductionPlanId | null) => (id === null ? 'no Draft' : `Draft '${id}'`)
      throw stateChanged(
        `The Build List optimization started with ${describe(observedDraftPlanId)}, but ${describe(currentDraftId)} is current now; the Drafts changed after the calculation started.`,
      )
    }
  }

  /**
   * T2 of a Build List optimization adoption (`docs/PLANNER_SPEC.md` 17.10 /
   * 17.11): the current state is the input the calculation assigned every
   * planning Target over - the whole Build List before any replacement, every
   * Target, the RNG state, Normal Counters, OwnedWeapons and Plan-dependent
   * Targets, and the CalculationContext. This is stricter than the shared
   * replaced-Entry check and never stands in for the generated Entries'
   * freshness, which the shared checks recompute afterwards (T5).
   */
  private assertBuildListOptimizationInputToken(
    persistable: PersistablePlannerResult,
    premises: BuildListOptimizationAdoptionPremises,
    current: PlannerSaveCurrentState,
    currentCalculationContext: CalculationContext,
  ) {
    const { inputToken } = premises
    if (!isCalculationContextCompatible(currentCalculationContext, inputToken.calculationContext)) {
      throw stateChanged('The current CalculationContext differs from the Build List optimization input token.')
    }
    if (createPlanningBuildListEntriesHash([...current.buildListEntries]) !== inputToken.inputBuildListEntriesHash) {
      throw stateChanged(
        'The current Build List differs from the Build List the optimization was calculated over (input token inputBuildListEntriesHash).',
      )
    }
    if (createPlanningTargetWeaponsHash([...current.targetWeapons]) !== inputToken.targetWeaponsHash) {
      throw stateChanged('Current TargetWeapons differ from the Build List optimization input token (targetWeaponsHash).')
    }
    // The token's state is the final Plan's own (checked in [P1]), so its Plan-dependent Targets are the Plan's. The Plan selects the
    // replaced Build List; adding the generated Entries to the current ones names the same Targets, because an `O` and its `G` share
    // their Target.
    const executionState = this.currentExecutionState(persistable.plan, current, [...current.buildListEntries, ...persistable.generatedEntries])
    if (!sameExpectedPlanState(executionState, inputToken.initialExecutionState)) {
      throw stateChanged(
        'Current RngState, Normal Artian counters, OwnedWeapons or Plan-dependent Target execution state differ from the Build List optimization input token (initialExecutionState).',
      )
    }
  }

  /** What the adoption writes, read from the validated state (the inspection's view). */
  private buildListOptimizationInspection(
    persistable: PersistablePlannerResult,
    premises: BuildListOptimizationAdoptionPremises,
    current: PlannerSaveCurrentState,
  ): BuildListOptimizationAdoptionInspection {
    const currentById = new Map(current.buildListEntries.map((entry) => [entry.id, entry]))
    return {
      replacedDraftPlanId: premises.observedDraftPlanId,
      replacements: persistable.replacements.map((replacement) => ({
        ...replacement,
        // Each `O` is its Target's current Entry (checked by the shared replacement set above).
        replacedImprovementPreference: entryImprovementPreference(
          currentById.get(replacement.replacedBuildListEntryId) as BuildListEntry,
        ),
      })),
      unchangedTargetWeaponIds: [...premises.unchangedTargetWeaponIds],
    }
  }

  /**
   * The source Draft CAS of a conflict preference result
   * (`docs/PLANNER_SPEC.md` 9.6.6; the same meaning the removed Planner
   * Alternative repair save gave it, 9.2.15): the result continues the
   * decisions of the Draft it was calculated from, so the one current Draft
   * must still be that Draft. Its ID is the authority - never a body
   * comparison; the rest of the state is re-validated by the snapshot
   * authorities below. Two Drafts break the Draft invariant.
   */
  private assertSourceDraftCurrent(base: PlanGuardedMutationBase, expectedSourceDraftId: ProductionPlanId) {
    const drafts = this.currentDrafts(base)
    if (drafts.length === 0 || drafts[0].id !== expectedSourceDraftId) {
      throw stateChanged(
        `The result was calculated from Draft '${expectedSourceDraftId}', but the current Draft is ${drafts.length === 0 ? 'missing' : `'${drafts[0].id}'`}; another change replaced, started or deleted that Draft after the calculation.`,
      )
    }
  }

  private currentState(base: PlanGuardedMutationBase): PlannerSaveCurrentState {
    // Read inside the write transaction. A missing or invalid RngState fails
    // closed: save time never creates an initial state and never repairs one.
    const { rngState } = base
    if (rngState === null) {
      throw stateChanged(
        'No RngState is stored, so the Planner result cannot be validated against current state.',
      )
    }
    assertRepositoryValidation('RngState', validateRngState(rngState))
    return {
      rngState,
      normalCounters: base.normalCounters,
      ownedWeapons: base.ownedWeapons,
      targetWeapons: base.targetWeapons,
      buildListEntries: base.buildListEntries,
    }
  }

  /**
   * Compares current state against the Plan's own `PlanningInputSnapshot` with
   * the existing snapshot authorities only, and returns the final replacement
   * set the Plan was calculated over: the current Entries with each replaced
   * Entry removed and each generated Entry added.
   */
  private assertCurrentStateMatchesPlan(
    persistable: PersistablePlannerResult,
    current: PlannerSaveCurrentState,
    currentCalculationContext: CalculationContext,
  ): BuildListEntry[] {
    const { plan, generatedEntries, replacements } = persistable
    if (
      !isCalculationContextCompatible(
        currentCalculationContext,
        plan.calculationContext,
      ) ||
      !isCalculationContextCompatible(
        currentCalculationContext,
        plan.baseSnapshot.calculationContext,
      )
    ) {
      throw stateChanged(
        'The current CalculationContext is no longer compatible with the calculated Plan.',
      )
    }

    // A generated ID already persisted, or a Target whose persisted Entry is
    // no longer exactly the one the Planner replaced, refuses before anything
    // is compared further: nothing is deleted or overwritten on a guess.
    const finalBuildList = prepareFinalReplacementBuildList(
      [...current.buildListEntries],
      generatedEntries,
      replacements,
    )
    throwIssue(finalBuildList.issue)
    const finalEntries = finalBuildList.finalEntries as BuildListEntry[]

    if (
      !sameExpectedPlanState(
        this.currentExecutionState(plan, current, finalEntries),
        plan.baseSnapshot.initialExecutionState,
      )
    ) {
      throw stateChanged(
        'Current RngState, Normal Artian counters, OwnedWeapons or Plan-dependent Target execution state differ from PlanningInputSnapshot.initialExecutionState.',
      )
    }

    if (
      createPlanningTargetWeaponsHash([...current.targetWeapons]) !==
      plan.baseSnapshot.targetWeaponsHash
    ) {
      throw stateChanged(
        'Current TargetWeapons differ from PlanningInputSnapshot.targetWeaponsHash.',
      )
    }

    if (
      createPlanningBuildListEntriesHash(finalEntries) !==
      plan.baseSnapshot.buildListEntriesHash
    ) {
      throw stateChanged(
        'The current BuildListEntry set with the generated replacements applied differs from PlanningInputSnapshot.buildListEntriesHash.',
      )
    }

    throwIssue(
      checkGeneratedBuildListEntriesFresh(generatedEntries, current, currentCalculationContext),
    )

    return finalEntries
  }

  /**
   * The current state's `ExpectedPlanState` over the Plan's dependent Targets,
   * named through `entries`. A freshly calculated Draft has no confirmed Step
   * yet, so no observation binding applies and the current state hashes with
   * its real values.
   */
  private currentExecutionState(
    plan: ProductionPlan,
    current: PlannerSaveCurrentState,
    entries: readonly BuildListEntry[],
  ): ExpectedPlanState {
    return createExpectedPlanState(
      current.rngState,
      [...current.normalCounters],
      [...current.ownedWeapons],
      {
        targetWeapons: [...current.targetWeapons],
        dependentTargetWeaponIds: collectProductionPlanDependentTargetWeaponIds(
          plan,
          entries,
        ),
      },
    )
  }

  /**
   * Every BuildListEntry the Plan references must exist in the final set - for
   * an ordinary or conflict preference result, the current Build List itself;
   * for a Build List optimization adoption, the replacement set. Whether every
   * generated Entry is selected is the adoption's own check
   * (`checkBuildListOptimizationFinalSelection()`), not this one.
   */
  private assertPlanReferences(
    persistable: PersistablePlannerResult,
    finalEntries: readonly BuildListEntry[],
  ) {
    throwIssue(checkProductionPlanBuildListEntryReferences(persistable.plan, finalEntries))
    // The final set matches the Plan's own input Build List
    // (`buildListEntriesHash`), so each rejected Entry's Target there is the
    // one the calculation copied (`docs/DATA_MODEL.md` 11.9).
    throwIssue(checkRejectedBuildListEntryTargets(persistable.plan, finalEntries))
  }
}

export const plannerResultPersistenceService =
  new PlannerResultPersistenceService()
