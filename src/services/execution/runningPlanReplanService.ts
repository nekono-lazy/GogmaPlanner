import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import { ExecutionHistoryRepository, ProductionPlanRepository } from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import {
  createReplanRunningPlanToken,
  deriveReplanTargetSet,
  deriveRunningPlanReplanAvailability,
  emptyReplanTargetSelection,
  ExecutionRuntimeError,
  runningProductionPlanIdOf,
  type ReplanRunningPlanToken,
  type ReplanTargetClassification,
  type ReplanTargetSelection,
  type ReplanTargetSelectionIssue,
  type RunningPlanReplanUnavailableReason,
} from '../../domain/execution'
import type { RunningPlanReplanAdoptionPreview } from '../../domain/execution/runningPlanReplanAdoption'
import {
  deriveRunningPlanReplanAuxiliaryOffer,
  type RunningPlanReplanAuxiliaryNotOfferedReason,
} from '../../domain/execution/runningPlanReplanAuxiliary'
import type {
  RunningPlanReplanOptimizationArtifact,
  RunningPlanReplanOptimizationResult,
} from '../../domain/execution/runningPlanReplanOptimization'
import {
  deriveRunningPlanReplanStartTargetLinkChanges,
  RunningPlanReplanEntryChangeError,
  type RunningPlanReplanStartTargetLinkChange,
} from '../../domain/execution/runningPlanReplanPreview'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CalculationContext, ProductionPlan, ProductionPlanId } from '../../domain/models/publicTypes'
import type { PlannerInput } from '../../domain/planner'
import type { BuildListOptimizationStage } from '../../domain/planner/buildListOptimization'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import { createPlannerInput } from '../planner/createPlannerInput'
import type { OneRunWorkerCancelReason } from '../planner/oneRunWorkerClient'
import { createReadOnlyPlannerInputRepositories } from '../planner/readOnlyPlannerInputRepositories'
import {
  createProductionRunningPlanReplanWorkerClient,
  type RunningPlanReplanRunFailure,
  type RunningPlanReplanRunHandle,
  type RunningPlanReplanWorkerClient,
} from './runningPlanReplanWorkerClient'

/**
 * The Application boundary of the running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.2 / 18.5 / 18.6 / 18.7, Issue #276
 * PR-4): reading the running Plan, its availability, the replan target set and the fresh input as one snapshot, running the dedicated
 * Worker, and holding the runtime-only result with the run it belongs to.
 *
 * It writes nothing. The start read is one read-only transaction, the calculation runs in the Worker, and the result stays in memory
 * until it is discarded or superseded; the old Plan, its Steps, the Build List, the Draft, the OwnedWeapons, the TargetWeapons (their
 * `preferredOwnedWeaponId` included), the RngState and the Normal Counters are never changed. The adoption (old Plan ended, Entries
 * replaced and added, new Plan started) is a separate Persistence API (Issue #276 PR-5) that re-validates everything against the then
 * current state; nothing here decides adoptability. It never falls back to the ordinary Planner. The screens reach it only through the
 * shared replan controller (`src/components/execution/useRunningPlanReplan.ts`, Issue #276 PR-6A).
 */

/** What one start is calculated from: read together in one transaction, never re-read while the run lasts. Runtime-only. */
export interface RunningPlanReplanStart {
  /** The old Plan when the read happened (16.8 / 18.6: `planId`, `status`, `currentStepId`; never `updatedAt`). */
  runningPlanToken: ReplanRunningPlanToken
  /**
   * The old Plan's persisted body of the same read (Issue #276 PR-6A): what the Preview compares the new Plan with and reads the
   * in-progress weapons' Targets from (18.7). Display only: the adoption re-reads the Plan and checks the token, never this body.
   */
  runningPlan: ProductionPlan
  /**
   * Every `draft` Plan of the same read, in ID order (0..1 by the Draft invariant, never picked from). Display only: the Preview says
   * when one names an Entry the adoption would replace (18.7); the adoption never changes a Draft.
   */
  draftPlans: readonly ProductionPlan[]
  /** The user's runtime-only selection this start applied (never persisted). */
  selection: ReplanTargetSelection
  /** PR-2's classification of the same read, the selection applied: the replan target set is its `replanTargetWeaponIds`. */
  replanTargets: ReplanTargetClassification
  /**
   * The fresh `createPlannerInput()` value of the same read (`conflictResolutions = []`; every Target and Entry), exactly what the
   * Worker calculates from. A read-only start context: the Preview reads its Targets and Entries, nothing re-reads them later.
   */
  plannerInput: PlannerInput
}

/** Why a replan did not start: the running Plan or the selection allows none (18.5 per old Plan, 18.2). No Worker starts. */
export type RunningPlanReplanRefusal =
  | { kind: 'no_running_plan' }
  /** Two or more `active` / `stale` Plans: none is picked by guessing. */
  | { kind: 'multiple_running_plans'; runningPlanIds: ProductionPlanId[] }
  /** Every 18.5 per-old-Plan reason that holds (`running_plan_targets_unknown`, `operation_uncertain_unresolved`, `reidentification_required`). */
  | { kind: 'unavailable'; planId: ProductionPlanId; reasons: RunningPlanReplanUnavailableReason[] }
  /** A selected ID the selection cannot apply to (18.2): the whole selection is refused, never partly applied. */
  | { kind: 'invalid_selection'; planId: ProductionPlanId; issues: ReplanTargetSelectionIssue[] }
  /**
   * The one running Plan is not the Plan the replan was opened for (Issue #276 PR-6A review): another Plan runs now. Its availability,
   * classification and input are never used for the replan opened for `expectedPlanId`, and nothing switches to it by itself.
   */
  | { kind: 'running_plan_changed'; expectedPlanId: ProductionPlanId; runningPlanId: ProductionPlanId }

export type RunningPlanReplanStartPreparation =
  | { status: 'refused'; refusal: RunningPlanReplanRefusal }
  | { status: 'ready'; start: RunningPlanReplanStart }

export interface RunningPlanReplanStartReader {
  /**
   * Reads the start state for `selection`. A read failure or a missing RngState throws (fail closed: an unknown state is never read
   * as "no running Plan"); a running Plan or a selection that allows no replan is a typed refusal.
   *
   * `expectedPlanId` is the Plan the replan was opened for (the screen's displayed running Plan). When it is given, the one running
   * Plan of this very read must be that Plan: another running Plan is `running_plan_changed`, judged before its availability,
   * classification or input is used. The same Plan having moved on (its status, current Step or `updatedAt`) is no refusal: the
   * replan is derived again from the latest state.
   */
  read(selection: ReplanTargetSelection, expectedPlanId?: ProductionPlanId): Promise<RunningPlanReplanStartPreparation>
}

/**
 * Reads every ProductionPlan, every ExecutionHistory record and the fresh PlannerInput in one read-only transaction (one snapshot of
 * the persisted state), then applies the Domain authorities to that snapshot only: `deriveRunningPlanReplanAvailability()` finds the
 * one running Plan and its 18.5 reasons, `deriveReplanTargetSet()` classifies the Targets with the selection, and
 * `createReplanRunningPlanToken()` takes the old Plan's token. The input is the ordinary `createPlannerInput()` over the shared
 * read-only repositories, so a missing RngState is a read failure and is never created.
 */
export function createRunningPlanReplanStartReader(
  database: AppDatabase,
  master: MasterDataRoot,
  calculationContext: CalculationContext,
): RunningPlanReplanStartReader {
  return {
    read: async (selection, expectedPlanId) => {
      try {
        return await database.transaction(
          'r',
          [database.productionPlans, database.executionHistory, database.rngState, database.normalArtianCounters, database.ownedWeapons, database.targetWeapons, database.buildListEntries],
          async (): Promise<RunningPlanReplanStartPreparation> => {
            const productionPlans = await new ProductionPlanRepository(database).getAllProductionPlans()
            // The metadata only (14.6), judged for the one running Plan.
            const executionHistory = await new ExecutionHistoryRepository(database).getAllExecutionHistory({
              kind: 'plan',
              planId: runningProductionPlanIdOf(productionPlans),
            })
            const plannerInput = await createPlannerInput(master, calculationContext,
              createReadOnlyPlannerInputRepositories(database, 'No RngState is stored, so no running Plan replan input can be read.'))
            const availability = deriveRunningPlanReplanAvailability({
              productionPlans,
              executionHistory,
              rngState: plannerInput.rngState,
              normalCounters: plannerInput.normalCounters,
            })
            if (availability.kind === 'no_running_plan') return { status: 'refused', refusal: { kind: 'no_running_plan' } }
            if (availability.kind === 'multiple_running_plans') {
              return { status: 'refused', refusal: { kind: 'multiple_running_plans', runningPlanIds: availability.runningPlanIds } }
            }
            // Plan identity first: another running Plan's reasons, Targets and input never answer the expected Plan's replan.
            if (expectedPlanId !== undefined && availability.plan.id !== expectedPlanId) {
              return { status: 'refused', refusal: runningPlanChangedRefusal(expectedPlanId, availability.plan.id) }
            }
            if (availability.kind === 'unavailable') {
              return { status: 'refused', refusal: { kind: 'unavailable', planId: availability.plan.id, reasons: availability.reasons } }
            }
            const plan = availability.plan
            const derivation = deriveReplanTargetSet({
              plan,
              targetWeapons: plannerInput.targetWeapons,
              buildListEntries: plannerInput.buildListEntries,
              selection,
            })
            switch (derivation.kind) {
              case 'invalid_selection':
                return { status: 'refused', refusal: { kind: 'invalid_selection', planId: plan.id, issues: derivation.issues } }
              case 'running_plan_targets_unknown':
                // The availability already refuses a Plan whose planned Targets cannot be told; reaching this is a broken invariant.
                throw new Error(`The available running Plan ${plan.id} has no planned Target authority.`)
              case 'derived':
                break
            }
            return {
              status: 'ready',
              start: {
                runningPlanToken: createReplanRunningPlanToken(plan),
                runningPlan: plan,
                draftPlans: productionPlans.filter(({ status }) => status === 'draft').sort((left, right) => compareIds(left.id, right.id)),
                selection,
                replanTargets: derivation.classification,
                plannerInput: { ...plannerInput, conflictResolutions: [] },
              },
            }
          },
        )
      } catch (error: unknown) {
        if (error instanceof RepositoryError || error instanceof ExecutionRuntimeError) throw error
        throw new RepositoryError('transaction_failed', 'Reading the running Plan replan input failed.', { cause: error })
      }
    },
  }
}

/**
 * The runtime-only Preview data of one `optimized` run (`docs/PLANNER_SPEC.md` 18.7), bound to that run: never persisted, exported or
 * put in a URL. Everything the adoption re-validates against the then current state comes with it - the old Plan's token, the
 * classification and selection, the artifact (the new Plan, the Entry replacements / additions / unchanged Targets, the input token) -
 * and the Plan start effect's preference changes it showed. It is what `ProductionPlanExecutionService.inspectRunningPlanReplanAdoption()`
 * / `adoptRunningPlanReplanPreview()` take (Issue #276 PR-5, 18.8).
 */
export interface RunningPlanReplanPreview extends RunningPlanReplanAdoptionPreview {
  runningPlanToken: ReplanRunningPlanToken
  selection: ReplanTargetSelection
  replanTargets: ReplanTargetClassification
  artifact: RunningPlanReplanOptimizationArtifact
  /**
   * 「Previewで確認したPlan開始effectの変更内容」 (18.7 / 18.8): `deriveRunningPlanReplanStartTargetLinkChanges()` over the start's
   * Targets and Build List. Read-only: no Target was changed to derive it.
   */
  startTargetLinkChanges: RunningPlanReplanStartTargetLinkChange[]
}

/**
 * What a finished start holds.
 *
 * - `refused`: no calculation was started (18.5 per old Plan, an invalid selection).
 * - `calculated` with `decidedBy: 'application'`: the replan target set is empty, so the result is Stage 0R's own first rule
 *   (`unsupported` / `no_replan_target`, 18.5) and no Worker was started for nothing to make.
 * - `calculated` with `decidedBy: 'calculation'`: the Worker's typed result over `start`; `preview` is non-null exactly for `optimized`.
 *   An `optimized` result whose Entry changes do not fit the start's whole Build List is never `calculated`: the start fails
 *   (`invalid_result`) and holds no Preview.
 */
export type RunningPlanReplanCompletion =
  | { kind: 'refused'; refusal: RunningPlanReplanRefusal }
  | {
      kind: 'calculated'
      decidedBy: 'application' | 'calculation'
      start: RunningPlanReplanStart
      result: RunningPlanReplanOptimizationResult
      preview: RunningPlanReplanPreview | null
    }

/** Why a start ended without a result. The Worker failures are the Client's; the start read adds its own. */
export type RunningPlanReplanSessionFailure =
  | RunningPlanReplanRunFailure
  /** The start state could not be read (a read failure, a missing RngState, a broken invariant); nothing was calculated. */
  | { kind: 'start_read_failed'; code: string; message: string }

/** The session's state; `runId` names the start it belongs to (a later start never takes over an earlier one's state). */
export type RunningPlanReplanSessionState =
  | { status: 'idle' }
  | { status: 'preparing'; runId: number; selection: ReplanTargetSelection }
  | { status: 'running'; runId: number; requestId: string; stage: BuildListOptimizationStage | null; start: RunningPlanReplanStart }
  | { status: 'completed'; runId: number; completion: RunningPlanReplanCompletion }
  | { status: 'failed'; runId: number; failure: RunningPlanReplanSessionFailure }
  | { status: 'cancelled'; runId: number; reason: OneRunWorkerCancelReason }
  | { status: 'disposed' }

/** The Preview of the state, or null when the state holds none (a run that is not `optimized`, or no finished run). */
export function runningPlanReplanPreviewOf(state: RunningPlanReplanSessionState): RunningPlanReplanPreview | null {
  return state.status === 'completed' && state.completion.kind === 'calculated' ? state.completion.preview : null
}

/**
 * Whether the explicit auxiliary (the ordinary Planner over the registered Routes, 「登録済みの候補で再計画を試算」) is offered beside the
 * session's state (`docs/PLANNER_SPEC.md` 18.5 table). Display only: pressing it prepares its own fresh input
 * (`RunningPlanReplanAuxiliaryPreparer`), and nothing starts it by itself.
 *
 * - offered beside an `unsupported` result whose reasons are only `checkpoint_selection` / `unconfirmed_rng_state` /
 *   `target_without_source` / `blind_route_required`, a `not_found` and a `search_bound_reached`
 * - not offered for a refused start (a per-old-Plan reason - operation unknown, re-identification pending, planned Targets unknown -,
 *   no running Plan, an invalid selection), `no_replan_target`, `invalid_planner_input`, `optimized`, a cancellation, a failure (a
 *   calculation failure, a contract violation, a read failure) or a start still preparing or running. An adoption refusal drops the
 *   Preview of an `optimized` result, which offers none either.
 */
export type RunningPlanReplanSessionAuxiliaryOffer =
  | { offered: true; basis: 'unsupported_input' | 'not_found' | 'search_bound_reached' }
  | {
      offered: false
      reason:
        | RunningPlanReplanAuxiliaryNotOfferedReason
        | { kind: 'start_refused'; refusal: RunningPlanReplanRefusal }
        | { kind: 'no_result'; status: Exclude<RunningPlanReplanSessionState['status'], 'completed'> }
    }

export function runningPlanReplanAuxiliaryOfferOf(state: RunningPlanReplanSessionState): RunningPlanReplanSessionAuxiliaryOffer {
  if (state.status !== 'completed') return { offered: false, reason: { kind: 'no_result', status: state.status } }
  const { completion } = state
  if (completion.kind === 'refused') return { offered: false, reason: { kind: 'start_refused', refusal: completion.refusal } }
  return deriveRunningPlanReplanAuxiliaryOffer(completion.result)
}

export interface RunningPlanReplanSession {
  getState(): RunningPlanReplanSessionState
  /** Notified on every state change; returns the unsubscribe function. */
  subscribe(listener: (state: RunningPlanReplanSessionState) => void): () => void
  /**
   * Starts a replan from the current persisted state with the user's explicit runtime-only selection (none: every `continuing`
   * Target kept, no additional candidate taken in), cancelling any start still preparing or running and dropping the previous result.
   * Resolves with this start's final state, or with the state that superseded it.
   *
   * `expectedPlanId` is the Plan the replan was opened for: the start read refuses another running Plan (`running_plan_changed`)
   * before any Worker is started, in the same read-only transaction the input comes from.
   */
  start(selection?: ReplanTargetSelection, expectedPlanId?: ProductionPlanId): Promise<RunningPlanReplanSessionState>
  /** 再試算: `start()` again with the selection and the expected Plan of the latest start, from a fresh read (18.5 / 18.8). */
  recalculate(): Promise<RunningPlanReplanSessionState>
  /** Cancels the start preparing or running (synchronously; the Worker is terminated at once). */
  cancel(): void
  /** Drops the current result (18.7: closing the Preview, leaving, a changed target set or Build List), cancelling a running start first. */
  discard(): void
  /** Cancels and releases everything; later starts do nothing. */
  dispose(): void
}

export interface RunningPlanReplanSessionDependencies {
  startReader: RunningPlanReplanStartReader
  createClient(): RunningPlanReplanWorkerClient
}

/**
 * The run-bound Preview of an `optimized` result over `start` (the session's one construction): the start effect's preference changes
 * over the start's own Targets and Build List. Throws `RunningPlanReplanEntryChangeError` when the artifact's Entry changes do not fit
 * that Build List.
 */
export function createRunningPlanReplanPreview(start: RunningPlanReplanStart, artifact: RunningPlanReplanOptimizationArtifact): RunningPlanReplanPreview {
  return {
    runningPlanToken: start.runningPlanToken,
    selection: start.selection,
    replanTargets: start.replanTargets,
    artifact,
    startTargetLinkChanges: deriveRunningPlanReplanStartTargetLinkChanges(start.plannerInput.targetWeapons, start.plannerInput.buildListEntries, artifact),
  }
}

/** The refusal of a read or start whose running Plan is not the expected one. */
export function runningPlanChangedRefusal(expectedPlanId: ProductionPlanId, runningPlanId: ProductionPlanId): RunningPlanReplanRefusal {
  return { kind: 'running_plan_changed', expectedPlanId, runningPlanId }
}

/**
 * The start of a ready read whose running Plan is not `expectedPlanId`, as a refusal; null when it is the expected Plan or none is
 * expected. A defence beside the reader's own check: a start is never used for another Plan than the one the replan was opened for.
 */
export function runningPlanIdentityRefusalOf(start: RunningPlanReplanStart, expectedPlanId: ProductionPlanId | undefined): RunningPlanReplanRefusal | null {
  return expectedPlanId === undefined || start.runningPlanToken.planId === expectedPlanId
    ? null
    : runningPlanChangedRefusal(expectedPlanId, start.runningPlanToken.planId)
}

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRunningPlanReplanSession(dependencies: RunningPlanReplanSessionDependencies): RunningPlanReplanSession {
  let state: RunningPlanReplanSessionState = { status: 'idle' }
  let latestRunId = 0
  let latestSelection: ReplanTargetSelection = emptyReplanTargetSelection
  let latestExpectedPlanId: ProductionPlanId | undefined
  let client: RunningPlanReplanWorkerClient | null = null
  let handle: RunningPlanReplanRunHandle | null = null
  const listeners = new Set<(state: RunningPlanReplanSessionState) => void>()

  const publish = (next: RunningPlanReplanSessionState) => {
    state = next
    for (const listener of [...listeners]) listener(next)
  }
  /** True while `runId` is still the start the session is following. */
  const isCurrent = (runId: number) => runId === latestRunId && (state.status === 'preparing' || state.status === 'running') && state.runId === runId

  /** Ends the start preparing or running, if any, as cancelled. */
  const cancelActive = (reason: OneRunWorkerCancelReason) => {
    if (state.status !== 'preparing' && state.status !== 'running') return
    const runId = state.runId
    const active = handle
    handle = null
    publish({ status: 'cancelled', runId, reason })
    active?.cancel()
  }

  const begin = async (requested: ReplanTargetSelection, expectedPlanId: ProductionPlanId | undefined): Promise<RunningPlanReplanSessionState> => {
    if (state.status === 'disposed') return state
    cancelActive('superseded')
    const selection: ReplanTargetSelection = {
      excludedTargetWeaponIds: [...requested.excludedTargetWeaponIds],
      includedTargetWeaponIds: [...requested.includedTargetWeaponIds],
    }
    latestSelection = selection
    latestExpectedPlanId = expectedPlanId
    latestRunId += 1
    const runId = latestRunId
    publish({ status: 'preparing', runId, selection })
    let preparation: RunningPlanReplanStartPreparation
    try {
      preparation = await dependencies.startReader.read(selection, expectedPlanId)
    } catch (error: unknown) {
      if (!isCurrent(runId)) return state
      publish({
        status: 'failed',
        runId,
        failure: {
          kind: 'start_read_failed',
          code: error instanceof RepositoryError || error instanceof ExecutionRuntimeError ? error.code : 'transaction_failed',
          message: errorMessageOf(error),
        },
      })
      return state
    }
    if (!isCurrent(runId)) return state
    if (preparation.status === 'refused') {
      publish({ status: 'completed', runId, completion: { kind: 'refused', refusal: preparation.refusal } })
      return state
    }
    const { start } = preparation
    const identityRefusal = runningPlanIdentityRefusalOf(start, expectedPlanId)
    if (identityRefusal !== null) {
      // Never calculated for another Plan than the one the replan was opened for: no Worker starts.
      publish({ status: 'completed', runId, completion: { kind: 'refused', refusal: identityRefusal } })
      return state
    }
    if (start.replanTargets.replanTargetWeaponIds.length === 0) {
      // Nothing would be made: Stage 0R's first rule, decided without a Worker (18.5 `no_replan_target`).
      publish({
        status: 'completed',
        runId,
        completion: { kind: 'calculated', decidedBy: 'application', start, result: { status: 'unsupported', reasons: [{ kind: 'no_replan_target' }] }, preview: null },
      })
      return state
    }
    let current: RunningPlanReplanRunHandle
    try {
      client ??= dependencies.createClient()
      current = client.run({ plannerInput: start.plannerInput, replanTargets: start.replanTargets }, {
        onStage: (stage) => {
          if (isCurrent(runId) && state.status === 'running') publish({ ...state, stage })
        },
      })
    } catch (error: unknown) {
      // The Client could not be created or refused the run (it starts no Worker then): the start failed, never stays `preparing`.
      // A Client that threw is released and dropped, so the next start creates a new one.
      const broken = client
      client = null
      try {
        broken?.dispose()
      } catch {
        // Releasing a Client that already failed must not hide the start failure itself.
      }
      if (!isCurrent(runId)) return state
      publish({ status: 'failed', runId, failure: { kind: 'worker_start_failed', message: errorMessageOf(error) } })
      return state
    }
    if (!isCurrent(runId)) {
      // Superseded while the run was being started: that run is never followed.
      current.cancel()
      return state
    }
    handle = current
    publish({ status: 'running', runId, requestId: current.requestId, stage: null, start })
    const outcome = await current.outcome
    if (!isCurrent(runId)) return state
    handle = null
    switch (outcome.status) {
      case 'completed': {
        const { result } = outcome
        let preview: RunningPlanReplanPreview | null = null
        if (result.status === 'optimized') {
          try {
            preview = createRunningPlanReplanPreview(start, result.artifact)
          } catch (error: unknown) {
            // Entry changes that do not fit the start's whole Build List (a generated Entry ID held by another Entry, ...), or another
            // broken invariant: never a Preview, never a guessed change set, nothing written, no other calculation started.
            const issues = error instanceof RunningPlanReplanEntryChangeError ? [...error.issues] : [errorMessageOf(error)]
            publish({ status: 'failed', runId, failure: { kind: 'invalid_result', issues } })
            return state
          }
        }
        publish({ status: 'completed', runId, completion: { kind: 'calculated', decidedBy: 'calculation', start, result, preview } })
        break
      }
      case 'failed':
        publish({ status: 'failed', runId, failure: outcome.failure })
        break
      case 'cancelled':
        publish({ status: 'cancelled', runId, reason: outcome.reason })
        break
    }
    return state
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: (selection = emptyReplanTargetSelection, expectedPlanId) => begin(selection, expectedPlanId),
    recalculate: () => begin(latestSelection, latestExpectedPlanId),
    cancel: () => cancelActive('cancelled'),
    discard: () => {
      if (state.status === 'disposed') return
      cancelActive('cancelled')
      publish({ status: 'idle' })
    },
    dispose: () => {
      if (state.status === 'disposed') return
      cancelActive('disposed')
      client?.dispose()
      client = null
      publish({ status: 'disposed' })
      listeners.clear()
    },
  }
}

/**
 * The Production session over the loaded Master Data: the persisted state of `database` and the Production replan Worker Client.
 * The Build List and the Production Plan page create one per mount through `createProductionRunningPlanReplanDependencies()`
 * (Issue #276 PR-6A).
 */
export function createProductionRunningPlanReplanSession(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
): RunningPlanReplanSession {
  return createRunningPlanReplanSession({
    startReader: createRunningPlanReplanStartReader(database, master, createBuildListCalculationContext(master)),
    createClient: createProductionRunningPlanReplanWorkerClient,
  })
}
