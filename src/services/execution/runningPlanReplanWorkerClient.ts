import type {
  RunningPlanReplanOptimizationInput,
  RunningPlanReplanOptimizationResult,
} from '../../domain/execution/runningPlanReplanOptimization'
import type { BuildListOptimizationStage } from '../../domain/planner/buildListOptimization'
import { addressableBuildListOptimizationRequestId } from '../../workers/buildListOptimizationWorkerContracts'
import {
  RUNNING_PLAN_REPLAN_WORKER_PROTOCOL_VERSION,
  runningPlanReplanWorkerResponseIssues,
  type RunningPlanReplanWorkerErrorCode,
  type RunningPlanReplanWorkerResponse,
  type RunningPlanReplanWorkerRunRequest,
} from '../../workers/runningPlanReplanWorkerContracts'
import { createBuildListOptimizationEntryWorker } from '../planner/buildListOptimizationWorkerClient'
import {
  createOneRunWorkerClient,
  type OneRunWorkerClient,
  type OneRunWorkerClientOptions,
  type OneRunWorkerLike,
  type OneRunWorkerProtocol,
  type OneRunWorkerReading,
  type OneRunWorkerRunFailure,
  type OneRunWorkerRunHandle,
  type OneRunWorkerRunObserver,
  type OneRunWorkerRunOutcome,
} from '../planner/oneRunWorkerClient'
import { runningPlanReplanResultIssues } from './runningPlanReplanResultCheck'

/**
 * The main-thread Client of the running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.6 / 17.16, Issue #276 PR-4) on the
 * dedicated Build List optimization Worker.
 *
 * It shares the one-run Client lifecycle of the Build List optimization Client (`oneRunWorkerClient.ts`): one new Worker per run, a
 * requestId per run, progress as stage names only, settled exactly once, the Worker terminated at once on completion, failure,
 * cancellation, supersession, dispose and `pagehide`, a message validly naming another requestId ignored, `error` / `messageerror` /
 * a protocol violation / an unchecked result each a typed failure, no timeout, nothing persisted. It sends only `blo_replan_run`
 * and reads only the `blo_replan_*` responses; a result reaches the caller only after `runningPlanReplanResultIssues()` passed it
 * against the very input the run was started with. No failure is turned into `not_found` or `unsupported`.
 */

/** Why a replan run ended without a result. */
export type RunningPlanReplanRunFailure = OneRunWorkerRunFailure<RunningPlanReplanWorkerErrorCode, BuildListOptimizationStage>

export type RunningPlanReplanRunOutcome = OneRunWorkerRunOutcome<RunningPlanReplanOptimizationResult, RunningPlanReplanRunFailure>

export type RunningPlanReplanRunObserver = OneRunWorkerRunObserver<BuildListOptimizationStage>

export type RunningPlanReplanRunHandle = OneRunWorkerRunHandle<RunningPlanReplanRunOutcome>

export type RunningPlanReplanWorkerClient = OneRunWorkerClient<RunningPlanReplanOptimizationInput, BuildListOptimizationStage, RunningPlanReplanRunOutcome>

export type RunningPlanReplanWorkerLike = OneRunWorkerLike<RunningPlanReplanWorkerRunRequest>

/** `createWorker()` throwing `RunningPlanReplanWorkerUnavailableError` reports `worker_unavailable`. */
export type RunningPlanReplanWorkerClientOptions = OneRunWorkerClientOptions<RunningPlanReplanWorkerRunRequest>

export class RunningPlanReplanWorkerUnavailableError extends Error {
  constructor() {
    super('この環境ではWeb Workerを利用できないため、現在地点からの再計画を計算できません。')
    this.name = 'RunningPlanReplanWorkerUnavailableError'
  }
}

export class RunningPlanReplanWorkerClientDisposedError extends Error {
  constructor() {
    super('The running Plan replan Worker Client is disposed.')
    this.name = 'RunningPlanReplanWorkerClientDisposedError'
  }
}

let requestSequence = 0

/** Reads one `blo_replan_*` message: its envelope, then a result's body against the run's own input. */
function readRunningPlanReplanMessage(
  data: unknown,
  input: RunningPlanReplanOptimizationInput,
): OneRunWorkerReading<RunningPlanReplanOptimizationResult, RunningPlanReplanWorkerErrorCode, BuildListOptimizationStage> {
  const issues = runningPlanReplanWorkerResponseIssues(data)
  if (issues.length > 0) return { kind: 'protocol_violation', issues }
  const response = data as RunningPlanReplanWorkerResponse
  switch (response.type) {
    case 'blo_replan_progress':
      return { kind: 'progress', stage: response.stage }
    case 'blo_replan_result': {
      const resultIssues = runningPlanReplanResultIssues(response.result, input)
      return resultIssues.length > 0 ? { kind: 'invalid_result', issues: resultIssues } : { kind: 'result', result: response.result }
    }
    case 'blo_replan_error':
      return { kind: 'calculation_error', code: response.code, domainCode: response.domainCode, stage: response.stage, message: response.message }
  }
}

const RUNNING_PLAN_REPLAN_CLIENT_PROTOCOL: OneRunWorkerProtocol<RunningPlanReplanOptimizationInput, RunningPlanReplanWorkerRunRequest, RunningPlanReplanOptimizationResult, RunningPlanReplanWorkerErrorCode, BuildListOptimizationStage> = {
  createRequest: (requestId, input) => ({
    type: 'blo_replan_run',
    protocolVersion: RUNNING_PLAN_REPLAN_WORKER_PROTOCOL_VERSION,
    requestId,
    input: input.plannerInput,
    replanTargets: input.replanTargets,
  }),
  addresseeOf: addressableBuildListOptimizationRequestId,
  read: readRunningPlanReplanMessage,
  defaultRequestId: () => {
    requestSequence += 1
    return `running-plan-replan-run-${requestSequence}`
  },
  isWorkerUnavailableError: (error): error is Error => error instanceof RunningPlanReplanWorkerUnavailableError,
  disposedError: () => new RunningPlanReplanWorkerClientDisposedError(),
}

export function createRunningPlanReplanWorkerClient(options: RunningPlanReplanWorkerClientOptions): RunningPlanReplanWorkerClient {
  return createOneRunWorkerClient(options, RUNNING_PLAN_REPLAN_CLIENT_PROTOCOL)
}

/** The Production Client: one module Worker per run from the Build List optimization Production entry, or `worker_unavailable`. */
export function createProductionRunningPlanReplanWorkerClient(): RunningPlanReplanWorkerClient {
  return createRunningPlanReplanWorkerClient({
    createWorker: () => createBuildListOptimizationEntryWorker(() => new RunningPlanReplanWorkerUnavailableError()),
  })
}
