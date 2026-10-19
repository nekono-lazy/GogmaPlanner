import type { PlannerInput } from '../domain/planner'
import type {
  BuildListOptimizationResult,
  BuildListOptimizationStage,
} from '../domain/planner/buildListOptimization'

/**
 * The dedicated Build List global optimization Worker protocol (`docs/PLANNER_SPEC.md` 17.6 / 17.16, Issue #260 PR-4).
 *
 * It is its own protocol beside the Production Planner Worker protocol (`plannerWorkerContracts.ts`, PLANNER_SPEC 14), which it
 * neither extends nor changes: the Planner Worker is long-lived, cancels through its task generation and has no progress response,
 * while this Worker serves exactly one run, is terminated by the main thread to cancel, and reports the stage names of the run.
 *
 * A run request carries the fresh PlannerInput alone. No window, search bound, step bound, expected hash, input token, observed
 * Draft ID or condition crosses the wire: the search bounds are supplied inside the Worker by its Production adapter, the final
 * verification's `maxPlanSteps` is derived by the Domain, and the Application keeps the main-thread items of the input token.
 * Everything here is structured-clone plain data (no Engine instance, no function).
 */

export const BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION = 'build-list-optimization:1' as const

/** The run request keys, exactly (a test ties them to the request type). */
export const BUILD_LIST_OPTIMIZATION_RUN_REQUEST_KEYS = ['type', 'protocolVersion', 'requestId', 'input'] as const

export interface BuildListOptimizationWorkerRunRequest {
  type: 'blo_run'
  protocolVersion: typeof BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION
  /** Non-empty, minted by the Client for each run. */
  requestId: string
  /** The fresh `createPlannerInput()` value with `conflictResolutions = []`. */
  input: PlannerInput
}

export type BuildListOptimizationWorkerRequest = BuildListOptimizationWorkerRunRequest

/** The stage names of one run, in the order the calculation enters them (PLANNER_SPEC 17.16: names only, never a rate). */
export const BUILD_LIST_OPTIMIZATION_STAGES = [
  'input_check',
  'reach_table',
  'assignment_search',
  'route_generation',
  'plan_verification',
] as const satisfies readonly BuildListOptimizationStage[]

/** A progress message: the stage name and nothing else (no count, ratio, elapsed or remaining time). */
export interface BuildListOptimizationWorkerProgressResponse {
  type: 'blo_progress'
  requestId: string
  stage: BuildListOptimizationStage
}

/** The terminal message of a calculation that returned a typed result. */
export interface BuildListOptimizationWorkerResultResponse {
  type: 'blo_result'
  requestId: string
  result: BuildListOptimizationResult
}

/**
 * Why a run ended without a result. None of them is a result: a broken contract is never reported as `unsupported` / `not_found` /
 * `search_bound_reached`, and no code claims the Worker ran out of memory.
 */
export type BuildListOptimizationWorkerErrorCode =
  /** The request broke this protocol (shape, version, requestId). */
  | 'invalid_request'
  /** A one-run Worker received a second request. */
  | 'worker_already_used'
  /** The Production search bounds are not decided yet (PLANNER_SPEC 17.13 / 17.19 U2): nothing is guessed in their place. */
  | 'search_bounds_unavailable'
  /** `BuildListOptimizationInvariantError`: an internal inconsistency (`domainCode` names it). */
  | 'invariant_violation'
  /** `BuildListOptimizationMaterializationError`: a fail-closed stop of the route generation (`domainCode` names it). */
  | 'materialization_failed'
  /** Any other error, including a Planner error and a result that could not be sent. */
  | 'calculation_failed'

export const BUILD_LIST_OPTIMIZATION_WORKER_ERROR_CODES = [
  'invalid_request',
  'worker_already_used',
  'search_bounds_unavailable',
  'invariant_violation',
  'materialization_failed',
  'calculation_failed',
] as const satisfies readonly BuildListOptimizationWorkerErrorCode[]

/** The terminal message of a run that ended without a result. */
export interface BuildListOptimizationWorkerErrorResponse {
  type: 'blo_error'
  requestId: string
  /** The stage the calculation was in, or null when none had started (an invalid request, unavailable bounds). */
  stage: BuildListOptimizationStage | null
  code: BuildListOptimizationWorkerErrorCode
  /** The Domain error's own code (e.g. `objective_mismatch`), or null. Diagnostics only; never parsed into a result. */
  domainCode: string | null
  message: string
}

export type BuildListOptimizationWorkerTerminalResponse =
  | BuildListOptimizationWorkerResultResponse
  | BuildListOptimizationWorkerErrorResponse

export type BuildListOptimizationWorkerResponse =
  | BuildListOptimizationWorkerProgressResponse
  | BuildListOptimizationWorkerTerminalResponse

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isStage = (value: unknown): value is BuildListOptimizationStage =>
  typeof value === 'string' && (BUILD_LIST_OPTIMIZATION_STAGES as readonly string[]).includes(value)

const isErrorCode = (value: unknown): value is BuildListOptimizationWorkerErrorCode =>
  typeof value === 'string' && (BUILD_LIST_OPTIMIZATION_WORKER_ERROR_CODES as readonly string[]).includes(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function exactKeyIssues(value: Record<string, unknown>, keys: readonly string[], path: string): string[] {
  return Object.keys(value).filter(key => !keys.includes(key)).map(key => `${path}.${key} is not a protocol field.`)
}

/** The PlannerInput fields a run needs to start; the content itself is the Domain's Stage 0 validation. */
const PLANNER_INPUT_RECORD_FIELDS = ['rngState', 'calculationContext', 'options', 'master'] as const
const PLANNER_INPUT_ARRAY_FIELDS = ['normalCounters', 'ownedWeapons', 'targetWeapons', 'buildListEntries', 'conflictResolutions'] as const

/**
 * The issues of one received run request (empty when it is a well-formed request of this protocol). The PlannerInput is checked
 * for its shape only: its content is validated by the calculation's own Stage 0 (`validatePlannerInput()`).
 */
export function buildListOptimizationRunRequestIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['request must be an object.']
  const issues = exactKeyIssues(value, BUILD_LIST_OPTIMIZATION_RUN_REQUEST_KEYS, 'request')
  if (value.type !== 'blo_run') issues.push('request.type must be blo_run.')
  if (value.protocolVersion !== BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION) {
    issues.push(`request.protocolVersion must be ${BUILD_LIST_OPTIMIZATION_WORKER_PROTOCOL_VERSION}.`)
  }
  if (!isNonEmptyString(value.requestId)) issues.push('request.requestId must be a non-empty string.')
  const input = value.input
  if (!isRecord(input)) {
    issues.push('request.input must be a PlannerInput object.')
  } else {
    for (const field of PLANNER_INPUT_RECORD_FIELDS) if (!isRecord(input[field])) issues.push(`request.input.${field} must be an object.`)
    for (const field of PLANNER_INPUT_ARRAY_FIELDS) if (!Array.isArray(input[field])) issues.push(`request.input.${field} must be an array.`)
  }
  return issues
}

/**
 * The requestId a message validly names (an object with a non-empty string `requestId`), or null when it names none. The Worker
 * answers a malformed request under it; the Client ignores a response naming another request and fails on one naming none.
 */
export function addressableBuildListOptimizationRequestId(value: unknown): string | null {
  return isRecord(value) && isNonEmptyString(value.requestId) ? value.requestId : null
}

/**
 * The envelope issues of one received response (empty when it is a well-formed message of this protocol). A result's body is
 * checked separately by the main thread before it is used (`buildListOptimizationResultIssues()`).
 */
export function buildListOptimizationWorkerResponseIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['response must be an object.']
  if (!isNonEmptyString(value.requestId)) return ['response.requestId must be a non-empty string.']
  switch (value.type) {
    case 'blo_progress': {
      const issues = exactKeyIssues(value, ['type', 'requestId', 'stage'], 'progress')
      if (!isStage(value.stage)) issues.push('progress.stage must be a stage name.')
      return issues
    }
    case 'blo_result': {
      const issues = exactKeyIssues(value, ['type', 'requestId', 'result'], 'result')
      if (!isRecord(value.result)) issues.push('result.result must be an object.')
      return issues
    }
    case 'blo_error': {
      const issues = exactKeyIssues(value, ['type', 'requestId', 'stage', 'code', 'domainCode', 'message'], 'error')
      if (!(value.stage === null || isStage(value.stage))) issues.push('error.stage must be a stage name or null.')
      if (!isErrorCode(value.code)) issues.push('error.code must be a protocol error code.')
      if (!(value.domainCode === null || typeof value.domainCode === 'string')) issues.push('error.domainCode must be a string or null.')
      if (typeof value.message !== 'string') issues.push('error.message must be a string.')
      return issues
    }
    default:
      return ['response.type must be blo_progress, blo_result or blo_error.']
  }
}
