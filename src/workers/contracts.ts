export interface WorkerTaskRequest<TType extends string, TInput> {
  type: TType
  requestId: string
  input: TInput
}

export interface WorkerCancelRequest {
  type: 'cancel'
  requestId: string
}

export interface WorkerProgressResponse<TProgress> {
  type: 'progress'
  requestId: string
  progress: TProgress
}

export interface WorkerResultResponse<TType extends string, TResult> {
  type: TType
  requestId: string
  result: TResult
}

export interface WorkerErrorResponse {
  type: 'error'
  requestId: string
  message: string
}

export type RngSearchWorkerRequest<TInput> =
  | WorkerTaskRequest<'rng_search', TInput>
  | WorkerCancelRequest

export type RngSearchWorkerResponse<TResult, TProgress> =
  | WorkerResultResponse<'rng_search_result', TResult>
  | WorkerProgressResponse<TProgress>
  | WorkerErrorResponse

export type CandidateSearchWorkerRequest<TInput> =
  | WorkerTaskRequest<'candidate_search', TInput>
  | WorkerCancelRequest

export type CandidateSearchWorkerResponse<TResult, TProgress> =
  | WorkerResultResponse<'candidate_search_result', TResult>
  | WorkerProgressResponse<TProgress>
  | WorkerErrorResponse

export type PlannerWorkerRequest<TInput> =
  | WorkerTaskRequest<'create_plan', TInput>
  | WorkerCancelRequest

export type PlannerWorkerResponse<TResult, TProgress> =
  | WorkerResultResponse<'create_plan_result', TResult>
  | WorkerProgressResponse<TProgress>
  | WorkerErrorResponse
