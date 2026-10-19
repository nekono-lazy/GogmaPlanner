import type {
  BuildListEntryId,
  DomainValidationIssue,
  PlanConflictCheckpointParticipant,
} from '../domain/models/publicTypes'
import type {
  PlannerInput,
  PlannerWarning,
  PlannerWarningKind,
  PlannerWorkerRequest,
  PlannerWorkerResponse,
} from '../domain/planner'
import type { WorkerResultResponse, WorkerTaskRequest } from './contracts'

/**
 * The Worker-layer Planner protocol beside the ordinary `PlannerWorkerRequest`
 * (PLANNER_SPEC 14).
 *
 * It lives in the Worker layer and reuses the Domain request/response shapes,
 * so the dependency only ever points Worker -> Domain: the Domain never imports
 * a Worker module.
 *
 * The calculation request kinds are `create_plan` and `prepare_interaction`,
 * and `cancel` and `error` stay shared between them. The legacy B8 constrained
 * re-search and B9 what-if request kinds were removed in Phase 6-B1
 * (`docs/PLANNER_SPEC.md` 9.2.19.16), and the Planner Alternative what-if /
 * actual repair request kinds in Issue #278 PR-4 (9.6.12), each once no
 * Production consumer sent them. No request kind has a progress response
 * (Issue #103 Phase D-2a): the Production UI shows an indeterminate running
 * state. The Domain request/response shapes are reused verbatim and only
 * extended with the wire-level task generation below.
 */

/**
 * The task instance a wire message belongs to.
 *
 * `requestId` stays the *logical* id, shared by every request kind exactly as
 * before. It cannot identify a running calculation on its own:
 * `postMessage()` is asynchronous, so re-using an id replaces the Client's
 * pending Promise while the Worker may still be running - and may still finish
 * - the calculation the replaced Promise belonged to. Its result would then
 * arrive for a live pending request of the other kind and be mistaken for a
 * protocol violation.
 *
 * Every task therefore carries a Client-minted monotonic generation, every
 * response echoes it, and both sides compare it: the Worker to decide what to
 * post, the Client to decide what to accept. A mismatch is a stale message, not
 * an error.
 *
 * It is runtime-only wire metadata: a plain number, never part of
 * `PlannerInput`, `PlannerResult`, the interaction preparation result, any
 * Domain entity, or persistence.
 */
export interface PlannerTaskGeneration {
  generation: number
}

/**
 * One Entry the current Planner input validation excluded. `kind` is the typed
 * exclusion code - the warning kind `validatePlannerInput()` recorded for it -
 * and the only field a screen may read to explain the exclusion in its own
 * words (`docs/UI_FLOW.md` 11.6.4). `reason` is the internal English detail,
 * kept for Debug Mode only; never parse it, and never show it in the normal UI.
 */
export interface PlannerInteractionExcludedEntry {
  buildListEntryId: BuildListEntryId
  kind: PlannerWarningKind
  reason: string
}

/** Current initial Conflict identity and membership, without recommendation. */
export interface PlannerInteractionConflict {
  id: string
  buildListEntryIds: BuildListEntryId[]
  /**
   * The selected compromise checkpoints taking part in this *current*
   * conflict. Typed Domain metadata, projected unchanged: the Application uses
   * it to refuse the winner-picking controls on such a conflict
   * (`docs/PLANNER_SPEC.md` 9.5, `docs/UI_FLOW.md` 11.1).
   */
  checkpointParticipants: PlanConflictCheckpointParticipant[]
}

/** Minimal B10 wire projection; no PlannerInitialContext or internal state. */
export type PlannerInteractionPreparationResult =
  | {
      status: 'ready'
      validBuildListEntryIds: BuildListEntryId[]
      excludedBuildListEntries: PlannerInteractionExcludedEntry[]
      currentConflicts: PlannerInteractionConflict[]
    }
  | {
      status: 'invalid'
      issues: DomainValidationIssue[]
      warnings: PlannerWarning[]
      excludedBuildListEntries: PlannerInteractionExcludedEntry[]
    }

/** Preparation performs no search and accepts only the fresh PlannerInput. */
export type PlannerInteractionWorkerRequest = WorkerTaskRequest<
  'prepare_interaction',
  PlannerInput
> &
  PlannerTaskGeneration

export type PlannerInteractionWorkerResultResponse = WorkerResultResponse<
  'prepare_interaction_result',
  PlannerInteractionPreparationResult
> &
  PlannerTaskGeneration

export type PlannerOrdinaryWorkerRequest = Extract<
  PlannerWorkerRequest,
  { type: 'create_plan' }
> &
  PlannerTaskGeneration

/** Cancels one task instance, never merely a logical request id. */
export type PlannerWorkerCancelRequest = Extract<
  PlannerWorkerRequest,
  { type: 'cancel' }
> &
  PlannerTaskGeneration

export type PlannerOrdinaryWorkerResultResponse = Extract<
  PlannerWorkerResponse,
  { type: 'create_plan_result' }
> &
  PlannerTaskGeneration

export type PlannerWorkerErrorResponse = Extract<
  PlannerWorkerResponse,
  { type: 'error' }
> &
  PlannerTaskGeneration

/** The two Planner calculation request kinds and `cancel` share one task namespace. */
export type PlannerWorkerProtocolRequest =
  | PlannerOrdinaryWorkerRequest
  | PlannerInteractionWorkerRequest
  | PlannerWorkerCancelRequest

/** All Planner results share the existing `error` response; there is no progress response. */
export type PlannerWorkerProtocolResponse =
  | PlannerOrdinaryWorkerResultResponse
  | PlannerInteractionWorkerResultResponse
  | PlannerWorkerErrorResponse
