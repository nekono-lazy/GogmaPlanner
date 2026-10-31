import type { RunningPlanReplanOptimizationResult } from '../domain/execution/runningPlanReplanOptimization'
import type {
  ReplanTargetCategory,
  ReplanTargetClassification,
  ReplanTargetNotEligibleReason,
} from '../domain/execution/runningPlanReplanTargets'
import type { PlannerInput } from '../domain/planner'
import type { BuildListOptimizationStage } from '../domain/planner/buildListOptimization'
import {
  BUILD_LIST_OPTIMIZATION_STAGES,
  BUILD_LIST_OPTIMIZATION_WORKER_ERROR_CODES,
  plannerInputShapeIssues,
  type BuildListOptimizationWorkerErrorCode,
} from './buildListOptimizationWorkerContracts'

/**
 * The running Plan replan run request of the dedicated Build List optimization Worker (`docs/PLANNER_SPEC.md` 18.6, Issue #276
 * PR-4).
 *
 * The replan re-optimization runs in the same one-run Worker as the Build List global optimization (17.6: no IndexedDB access, one
 * run per Worker, cancelled by termination, stage names only), as its own request with its own protocol version and its own response
 * types. The Build List optimization's `blo_run` request, its `build-list-optimization:1` version and its `blo_progress` /
 * `blo_result` / `blo_error` responses keep their meaning: a `blo_run` is never answered with a message of this protocol, and a
 * request of this protocol never with a `blo_*` response of the other.
 *
 * A run request carries the fresh PlannerInput and PR-2's replan target classification of the same read, nothing else: no running
 * Plan (its `baseSnapshot`, Steps or token), no ExecutionHistory, no search or step bound, no screen state. The search bounds are the
 * Worker's Production adapter's (17.13, shared until 18.12 R5), the final verification's `maxPlanSteps` is the Domain's derivation,
 * and the old Plan's token stays on the main thread with the run it belongs to. Everything here is structured-clone plain data.
 */

export const RUNNING_PLAN_REPLAN_WORKER_PROTOCOL_VERSION = 'build-list-optimization-replan:1' as const

/** The run request keys, exactly (a test ties them to the request type). */
export const RUNNING_PLAN_REPLAN_RUN_REQUEST_KEYS = ['type', 'protocolVersion', 'requestId', 'input', 'replanTargets'] as const

export interface RunningPlanReplanWorkerRunRequest {
  type: 'blo_replan_run'
  protocolVersion: typeof RUNNING_PLAN_REPLAN_WORKER_PROTOCOL_VERSION
  /** Non-empty, minted by the Client for each run. */
  requestId: string
  /** The fresh `createPlannerInput()` value with `conflictResolutions = []`: every Target and every Entry. */
  input: PlannerInput
  /** PR-2's `deriveReplanTargetSet()` over the same read, with the user's runtime-only selection applied. */
  replanTargets: ReplanTargetClassification
}

/** A progress message: the stage name and nothing else (`docs/PLANNER_SPEC.md` 17.16). */
export interface RunningPlanReplanWorkerProgressResponse {
  type: 'blo_replan_progress'
  requestId: string
  stage: BuildListOptimizationStage
}

/** The terminal message of a calculation that returned a typed result. */
export interface RunningPlanReplanWorkerResultResponse {
  type: 'blo_replan_result'
  requestId: string
  result: RunningPlanReplanOptimizationResult
}

/**
 * Why a replan run ended without a result: the Build List optimization Worker's codes, plus the replan input contract. None of them
 * is a result, and none is turned into `unsupported` / `not_found` / `search_bound_reached`.
 */
export type RunningPlanReplanWorkerErrorCode =
  | BuildListOptimizationWorkerErrorCode
  /**
   * `RunningPlanReplanOptimizationInputError`: the classification is not PR-2's derivation over the very input it came with
   * (`domainCode` names it: `replan_target_set_inconsistent` / `replan_target_not_usable`). Never corrected or guessed.
   */
  | 'input_contract_violation'

export const RUNNING_PLAN_REPLAN_WORKER_ERROR_CODES = [
  ...BUILD_LIST_OPTIMIZATION_WORKER_ERROR_CODES,
  'input_contract_violation',
] as const satisfies readonly RunningPlanReplanWorkerErrorCode[]

/** The terminal message of a run that ended without a result. */
export interface RunningPlanReplanWorkerErrorResponse {
  type: 'blo_replan_error'
  requestId: string
  /** The stage the calculation was in, or null when none had started (an invalid request, unavailable bounds). */
  stage: BuildListOptimizationStage | null
  code: RunningPlanReplanWorkerErrorCode
  /** The Domain error's own code, or null. Diagnostics only; never parsed into a result. */
  domainCode: string | null
  message: string
}

export type RunningPlanReplanWorkerTerminalResponse =
  | RunningPlanReplanWorkerResultResponse
  | RunningPlanReplanWorkerErrorResponse

export type RunningPlanReplanWorkerResponse =
  | RunningPlanReplanWorkerProgressResponse
  | RunningPlanReplanWorkerTerminalResponse

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isStage = (value: unknown): value is BuildListOptimizationStage =>
  typeof value === 'string' && (BUILD_LIST_OPTIMIZATION_STAGES as readonly string[]).includes(value)

const isErrorCode = (value: unknown): value is RunningPlanReplanWorkerErrorCode =>
  typeof value === 'string' && (RUNNING_PLAN_REPLAN_WORKER_ERROR_CODES as readonly string[]).includes(value)

function exactKeyIssues(value: Record<string, unknown>, keys: readonly string[], path: string): string[] {
  return Object.keys(value).filter(key => !keys.includes(key)).map(key => `${path}.${key} is not a protocol field.`)
}

/** The classification keys, exactly (a test ties them to `ReplanTargetClassification`). */
export const REPLAN_TARGET_CLASSIFICATION_KEYS = ['planId', 'plannedTargetWeaponIds', 'rows', 'replanTargetWeaponIds', 'additionalCandidateTargetWeaponIds'] as const

const REPLAN_TARGET_CATEGORIES = ['continuing', 'excluded', 'added', 'additional_candidate', 'completed', 'not_eligible'] as const satisfies readonly ReplanTargetCategory[]
const REPLAN_TARGET_NOT_ELIGIBLE_REASONS = [
  'deleted', 'completed_elsewhere', 'disabled', 'completion_condition_review_required',
] as const satisfies readonly ReplanTargetNotEligibleReason[]

function idArrayIssues(value: unknown, path: string): string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) ? [] : [`${path} must be an array of non-empty IDs.`]
}

/**
 * The shape issues of the replan target classification at `path`. Its content - that it is PR-2's derivation over the request's own
 * input - is the calculation's `assertRunningPlanReplanOptimizationInput()`, never re-judged here.
 */
function replanTargetsShapeIssues(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be a replan target classification object.`]
  const issues = exactKeyIssues(value, REPLAN_TARGET_CLASSIFICATION_KEYS, path)
  if (!isNonEmptyString(value.planId)) issues.push(`${path}.planId must be a non-empty string.`)
  for (const key of ['plannedTargetWeaponIds', 'replanTargetWeaponIds', 'additionalCandidateTargetWeaponIds'] as const) {
    issues.push(...idArrayIssues(value[key], `${path}.${key}`))
  }
  if (!Array.isArray(value.rows)) {
    issues.push(`${path}.rows must be an array.`)
  } else {
    value.rows.forEach((row: unknown, index) => {
      const rowPath = `${path}.rows[${index}]`
      if (!isRecord(row)) {
        issues.push(`${rowPath} must be an object.`)
        return
      }
      const notEligible = row.category === 'not_eligible'
      issues.push(...exactKeyIssues(row, notEligible ? ['targetWeaponId', 'category', 'reason'] : ['targetWeaponId', 'category'], rowPath))
      if (!isNonEmptyString(row.targetWeaponId)) issues.push(`${rowPath}.targetWeaponId must be a non-empty string.`)
      if (!(REPLAN_TARGET_CATEGORIES as readonly unknown[]).includes(row.category)) issues.push(`${rowPath}.category must be a replan target category.`)
      if (notEligible && !(REPLAN_TARGET_NOT_ELIGIBLE_REASONS as readonly unknown[]).includes(row.reason)) {
        issues.push(`${rowPath}.reason must be deleted, completed_elsewhere, disabled or completion_condition_review_required.`)
      }
    })
  }
  return issues
}

/** True for a message that is a replan run request by its type (the Worker routes it here; its shape is checked below). */
export function isRunningPlanReplanRunMessage(value: unknown): boolean {
  return isRecord(value) && value.type === 'blo_replan_run'
}

/**
 * The issues of one received replan run request (empty when it is a well-formed request of this protocol). The PlannerInput and the
 * classification are checked for their shape only.
 */
export function runningPlanReplanRunRequestIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['request must be an object.']
  const issues = exactKeyIssues(value, RUNNING_PLAN_REPLAN_RUN_REQUEST_KEYS, 'request')
  if (value.type !== 'blo_replan_run') issues.push('request.type must be blo_replan_run.')
  if (value.protocolVersion !== RUNNING_PLAN_REPLAN_WORKER_PROTOCOL_VERSION) {
    issues.push(`request.protocolVersion must be ${RUNNING_PLAN_REPLAN_WORKER_PROTOCOL_VERSION}.`)
  }
  if (!isNonEmptyString(value.requestId)) issues.push('request.requestId must be a non-empty string.')
  issues.push(...plannerInputShapeIssues(value.input, 'request.input'))
  issues.push(...replanTargetsShapeIssues(value.replanTargets, 'request.replanTargets'))
  return issues
}

/**
 * The envelope issues of one received replan response (empty when it is a well-formed message of this protocol). A result's body is
 * checked separately by the main thread before it is used (`runningPlanReplanResultIssues()`).
 */
export function runningPlanReplanWorkerResponseIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['response must be an object.']
  if (!isNonEmptyString(value.requestId)) return ['response.requestId must be a non-empty string.']
  switch (value.type) {
    case 'blo_replan_progress': {
      const issues = exactKeyIssues(value, ['type', 'requestId', 'stage'], 'progress')
      if (!isStage(value.stage)) issues.push('progress.stage must be a stage name.')
      return issues
    }
    case 'blo_replan_result': {
      const issues = exactKeyIssues(value, ['type', 'requestId', 'result'], 'result')
      if (!isRecord(value.result)) issues.push('result.result must be an object.')
      return issues
    }
    case 'blo_replan_error': {
      const issues = exactKeyIssues(value, ['type', 'requestId', 'stage', 'code', 'domainCode', 'message'], 'error')
      if (!(value.stage === null || isStage(value.stage))) issues.push('error.stage must be a stage name or null.')
      if (!isErrorCode(value.code)) issues.push('error.code must be a protocol error code.')
      if (!(value.domainCode === null || typeof value.domainCode === 'string')) issues.push('error.domainCode must be a string or null.')
      if (typeof value.message !== 'string') issues.push('error.message must be a string.')
      return issues
    }
    default:
      return ['response.type must be blo_replan_progress, blo_replan_result or blo_replan_error.']
  }
}
