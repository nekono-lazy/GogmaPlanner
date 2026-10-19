import { appDatabase, type AppDatabase } from '../../db/AppDatabase'
import {
  BuildListEntryRepository,
  NormalArtianCounterRepository,
  OwnedWeaponRepository,
  ProductionPlanRepository,
  TargetWeaponRepository,
} from '../../db/repositories'
import { RepositoryError } from '../../db/repositoryError'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CalculationContext, ProductionPlanId } from '../../domain/models/publicTypes'
import type { PlannerInput } from '../../domain/planner'
import type {
  BuildListOptimizationArtifact,
  BuildListOptimizationResult,
  BuildListOptimizationStage,
} from '../../domain/planner/buildListOptimization'
import { createBuildListCalculationContext } from '../buildList/createBuildListCalculationContext'
import {
  createProductionBuildListOptimizationWorkerClient,
  type BuildListOptimizationCancelReason,
  type BuildListOptimizationRunFailure,
  type BuildListOptimizationRunHandle,
  type BuildListOptimizationWorkerClient,
} from './buildListOptimizationWorkerClient'
import { createPlannerInput, type PlannerInputRepositories } from './createPlannerInput'

/**
 * The Application boundary of the Build List global optimization (`docs/PLANNER_SPEC.md` 17.4 / 17.6 / 17.9 / 17.10 / 17.16, Issue
 * #260 PR-4): reading the fresh input and the start state, running the dedicated Worker, and holding the runtime-only result.
 *
 * It writes nothing. The start read is one read-only transaction, the calculation runs in the Worker, and the result and the start
 * snapshot stay in memory until they are discarded; the adoption (Entry replacement and Draft save) is a separate Persistence API
 * (Issue #260 PR-6). It never falls back to the ordinary Planner: no outcome of the optimization runs `createPlan()`.
 */

/**
 * The main-thread items of the input token (`docs/PLANNER_SPEC.md` 17.10), read in the same transaction as the PlannerInput. The
 * Worker-side items (`initialExecutionState`, `targetWeaponsHash`, `inputBuildListEntriesHash`, `calculationContext`) are the
 * artifact's `inputToken`, derived by the Domain; the Application never re-derives them. Runtime-only: never persisted.
 */
export interface BuildListOptimizationStartSnapshot {
  /** The current Draft's ID when the calculation started, or null when there was none. */
  observedDraftPlanId: ProductionPlanId | null
  /** No `active` / `stale` Plan existed when the calculation started (a running Plan refuses the start instead). */
  runningPlanAbsent: true
}

export type BuildListOptimizationStartPreparation =
  /** The fresh input (`conflictResolutions = []`) and the start snapshot, read together. */
  | { status: 'ready'; plannerInput: PlannerInput; startSnapshot: BuildListOptimizationStartSnapshot }
  /** A running Plan exists: the optimization is not offered (17.4 `running_plan_exists`) and no input is read for it. */
  | { status: 'running_plan_exists'; runningPlanId: ProductionPlanId }

export interface BuildListOptimizationStartReader {
  /**
   * Reads the start state. A read failure, a missing RngState, two or more running Plans or two or more Drafts throws (fail closed:
   * an unknown state is never read as "no running Plan" or "no Draft").
   */
  read(): Promise<BuildListOptimizationStartPreparation>
}

/** The ordinary `createPlannerInput()` repositories inside a read-only transaction; a missing RngState is never created here. */
function readOnlyPlannerInputRepositories(database: AppDatabase): PlannerInputRepositories {
  const normalCounters = new NormalArtianCounterRepository(database)
  const ownedWeapons = new OwnedWeaponRepository(database)
  const targetWeapons = new TargetWeaponRepository(database)
  const buildListEntries = new BuildListEntryRepository(database)
  return {
    ensureInitialRngState: async () => {
      const rngState = await database.rngState.get('current')
      if (!rngState) {
        throw new RepositoryError('not_found', 'No RngState is stored, so no Build List optimization input can be read.')
      }
      return rngState
    },
    getAllNormalArtianCounters: () => normalCounters.getAllNormalArtianCounters(),
    getAllOwnedWeapons: () => ownedWeapons.getAllOwnedWeapons(),
    getAllTargetWeapons: () => targetWeapons.getAllTargetWeapons(),
    getAllBuildListEntries: () => buildListEntries.getAllBuildListEntries(),
  }
}

/**
 * Reads the running Plan, the current Draft and the fresh PlannerInput in one read-only transaction (one snapshot of the persisted
 * state), through the existing repository authorities (`getRunningProductionPlan()` / `getDraftProductionPlan()`, which fail closed
 * on two running Plans or two Drafts) and the ordinary `createPlannerInput()`.
 */
export function createBuildListOptimizationStartReader(
  database: AppDatabase,
  master: MasterDataRoot,
  calculationContext: CalculationContext,
): BuildListOptimizationStartReader {
  return {
    read: async () => {
      try {
        return await database.transaction(
          'r',
          [database.productionPlans, database.rngState, database.normalArtianCounters, database.ownedWeapons, database.targetWeapons, database.buildListEntries],
          async (): Promise<BuildListOptimizationStartPreparation> => {
            const plans = new ProductionPlanRepository(database)
            const running = await plans.getRunningProductionPlan()
            if (running !== undefined) return { status: 'running_plan_exists', runningPlanId: running.id }
            const draft = await plans.getDraftProductionPlan()
            const plannerInput = await createPlannerInput(master, calculationContext, readOnlyPlannerInputRepositories(database))
            return {
              status: 'ready',
              plannerInput: { ...plannerInput, conflictResolutions: [] },
              startSnapshot: { observedDraftPlanId: draft?.id ?? null, runningPlanAbsent: true },
            }
          },
        )
      } catch (error: unknown) {
        if (error instanceof RepositoryError) throw error
        throw new RepositoryError('transaction_failed', 'Reading the Build List optimization input failed.', { cause: error })
      }
    },
  }
}

/** Why a session ended without a result. The Worker failures are the Client's; the start read adds its own. */
export type BuildListOptimizationSessionFailure =
  | BuildListOptimizationRunFailure
  /** The start state could not be read (a read failure or a Persistence invariant violation); nothing was calculated. */
  | { kind: 'start_read_failed'; code: string; message: string }

/**
 * What a finished session holds.
 *
 * - `decidedBy: 'application'`: a running Plan exists, so the Application refused before any calculation (17.4); the result is the
 *   one `unsupported` reason the Domain leaves to the Application.
 * - `decidedBy: 'calculation'`: the Worker's typed result over the fresh input, with the start snapshot the adoption re-checks.
 */
export type BuildListOptimizationCompletion =
  | { decidedBy: 'application'; result: Extract<BuildListOptimizationResult, { status: 'unsupported' }> }
  | { decidedBy: 'calculation'; result: BuildListOptimizationResult; startSnapshot: BuildListOptimizationStartSnapshot }

/** The session's state; `runId` names the start it belongs to (a later start never takes over an earlier one's state). */
export type BuildListOptimizationSessionState =
  | { status: 'idle' }
  | { status: 'preparing'; runId: number }
  | { status: 'running'; runId: number; requestId: string; stage: BuildListOptimizationStage | null; startSnapshot: BuildListOptimizationStartSnapshot }
  | { status: 'completed'; runId: number; completion: BuildListOptimizationCompletion }
  | { status: 'failed'; runId: number; failure: BuildListOptimizationSessionFailure }
  | { status: 'cancelled'; runId: number; reason: BuildListOptimizationCancelReason }
  | { status: 'disposed' }

/**
 * The runtime-only pair the adoption (Issue #260 PR-6) takes: an `optimized` artifact and the start snapshot of the same run. Its
 * T2 re-check compares the current state with both (the artifact's Worker-side input token and this observed Draft ID / running Plan
 * absence); this value is never persisted.
 */
export interface BuildListOptimizationAdoptionSource {
  artifact: BuildListOptimizationArtifact
  startSnapshot: BuildListOptimizationStartSnapshot
}

export function buildListOptimizationAdoptionSourceOf(state: BuildListOptimizationSessionState): BuildListOptimizationAdoptionSource | null {
  if (state.status !== 'completed' || state.completion.decidedBy !== 'calculation' || state.completion.result.status !== 'optimized') return null
  return { artifact: state.completion.result.artifact, startSnapshot: state.completion.startSnapshot }
}

export interface BuildListOptimizationSession {
  getState(): BuildListOptimizationSessionState
  /** Notified on every state change; returns the unsubscribe function. */
  subscribe(listener: (state: BuildListOptimizationSessionState) => void): () => void
  /**
   * Starts a new optimization from the current persisted state, cancelling any start still preparing or running and dropping the
   * previous result. Resolves with this start's final state, or with the state that superseded it.
   */
  start(): Promise<BuildListOptimizationSessionState>
  /**
   * `start()` with the read replaced by a start state the caller already read through the same start reader (Issue #260 PR-6B1: the
   * plan creation boundary judged the method over this very `plannerInput`, so the calculation runs on the input that was judged and
   * the state is not read twice). Everything else is `start()`'s: the earlier start is cancelled and its result dropped, a running
   * Plan is the Application's refusal, the start snapshot is kept beside the result, and a superseded start never overwrites a later
   * one.
   */
  startPrepared(preparation: BuildListOptimizationStartPreparation): Promise<BuildListOptimizationSessionState>
  /** Cancels the start preparing or running (synchronously; the Worker is terminated at once). */
  cancel(): void
  /** Drops the current result (17.9: closing the Preview, leaving, a Build List change), cancelling a running start first. */
  discard(): void
  /** Cancels and releases everything; later starts do nothing. */
  dispose(): void
}

export interface BuildListOptimizationSessionDependencies {
  startReader: BuildListOptimizationStartReader
  createClient(): BuildListOptimizationWorkerClient
}

export function createBuildListOptimizationSession(
  dependencies: BuildListOptimizationSessionDependencies,
): BuildListOptimizationSession {
  let state: BuildListOptimizationSessionState = { status: 'idle' }
  let latestRunId = 0
  let client: BuildListOptimizationWorkerClient | null = null
  let handle: BuildListOptimizationRunHandle | null = null
  const listeners = new Set<(state: BuildListOptimizationSessionState) => void>()

  const publish = (next: BuildListOptimizationSessionState) => {
    state = next
    for (const listener of [...listeners]) listener(next)
  }
  /** True while `runId` is still the start the session is following. */
  const isCurrent = (runId: number) => runId === latestRunId && state.status !== 'disposed' && (state.status === 'preparing' || state.status === 'running') && state.runId === runId

  /** Ends the start preparing or running, if any, as cancelled. */
  const cancelActive = (reason: BuildListOptimizationCancelReason) => {
    if (state.status !== 'preparing' && state.status !== 'running') return
    const runId = state.runId
    const active = handle
    handle = null
    publish({ status: 'cancelled', runId, reason })
    active?.cancel()
  }

  /** One start: `read` is the start reader, or the preparation the caller already read. */
  const begin = async (read: () => Promise<BuildListOptimizationStartPreparation>): Promise<BuildListOptimizationSessionState> => {
    if (state.status === 'disposed') return state
    cancelActive('superseded')
    latestRunId += 1
    const runId = latestRunId
    publish({ status: 'preparing', runId })
    let preparation: BuildListOptimizationStartPreparation
    try {
      preparation = await read()
    } catch (error: unknown) {
      if (!isCurrent(runId)) return state
      publish({
        status: 'failed',
        runId,
        failure: {
          kind: 'start_read_failed',
          code: error instanceof RepositoryError ? error.code : 'transaction_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })
      return state
    }
    if (!isCurrent(runId)) return state
    if (preparation.status === 'running_plan_exists') {
      publish({ status: 'completed', runId, completion: { decidedBy: 'application', result: { status: 'unsupported', reasons: [{ kind: 'running_plan_exists' }] } } })
      return state
    }
    const { plannerInput, startSnapshot } = preparation
    let current: BuildListOptimizationRunHandle
    try {
      client ??= dependencies.createClient()
      current = client.run(plannerInput, {
        onStage: (stage) => {
          if (isCurrent(runId) && state.status === 'running') publish({ ...state, stage })
        },
      })
    } catch (error: unknown) {
      // The Client could not be created or refused the run (it starts no Worker then): the start failed, never stays
      // `preparing`. A Client that threw is released and dropped, so the next start creates a new one.
      const broken = client
      client = null
      try {
        broken?.dispose()
      } catch {
        // Releasing a Client that already failed must not hide the start failure itself.
      }
      if (!isCurrent(runId)) return state
      publish({ status: 'failed', runId, failure: { kind: 'worker_start_failed', message: error instanceof Error ? error.message : String(error) } })
      return state
    }
    if (!isCurrent(runId)) {
      // Superseded while the run was being started: that run is never followed.
      current.cancel()
      return state
    }
    handle = current
    publish({ status: 'running', runId, requestId: current.requestId, stage: null, startSnapshot })
    const outcome = await current.outcome
    if (!isCurrent(runId)) return state
    handle = null
    switch (outcome.status) {
      case 'completed':
        publish({ status: 'completed', runId, completion: { decidedBy: 'calculation', result: outcome.result, startSnapshot } })
        break
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
    start: () => begin(() => dependencies.startReader.read()),
    startPrepared: (preparation) => begin(async () => preparation),
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

/** The Production session over the loaded Master Data: the persisted state of `database` and the Production Worker Client. */
export function createProductionBuildListOptimizationSession(
  master: MasterDataRoot,
  database: AppDatabase = appDatabase,
): BuildListOptimizationSession {
  return createBuildListOptimizationSession({
    startReader: createBuildListOptimizationStartReader(database, master, createBuildListCalculationContext(master)),
    createClient: createProductionBuildListOptimizationWorkerClient,
  })
}
