import type { RngState } from '../../domain/models/publicTypes'
import {
  SkillIdentificationCancelledError,
  SkillIdentificationDuplicateRequestError,
  SkillIdentificationWorkerError,
  SkillIdentificationWorkerUnavailableError,
  type SkillIdentificationWorkerClient,
} from './skillIdentificationWorkerClient'
import { createProductionMultiWorkerSkillIdentificationClient } from './multiWorkerSkillIdentificationClient'
import type {
  SkillIdentificationInput,
  SkillIdentificationProgress,
  SkillIdentificationResult,
} from '../../domain/rng/identification/skillIdentificationTypes'
import {
  createProductionGogmaCounterIdentificationWorkerClient,
  GogmaCounterIdentificationCancelledError,
  GogmaCounterIdentificationDuplicateRequestError,
  GogmaCounterIdentificationWorkerError,
  GogmaCounterIdentificationWorkerUnavailableError,
  type GogmaCounterIdentificationWorkerClient,
} from './gogmaCounterIdentificationWorkerClient'
import type {
  GogmaCounterIdentificationInput,
  GogmaCounterIdentificationProgress,
  GogmaCounterIdentificationResult,
} from '../../domain/rng/identification/gogmaCounterIdentificationTypes'
import {
  identificationAdoptionService,
  type IdentificationAdoptionInput,
} from './identificationAdoptionService'
import {
  PlanBreakingChangeApprovalRequiredError,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
} from '../../domain/execution'

export type IdentificationResultClassification =
  | 'zero'
  | 'multiple'
  | 'incomplete'
  | 'unique'

export type IdentificationWizardErrorKind =
  | 'cancelled'
  | 'invalid_input'
  | 'unsupported_input'
  | 'incomplete_parallel_chunk'
  | 'worker_unavailable'
  | 'duplicate_request'
  | 'unexpected_error'
  | 'adoption_error'

export interface IdentificationWizardErrorState {
  readonly kind: IdentificationWizardErrorKind
  readonly error: unknown
}

export interface IdentifiedSkillStartingState {
  readonly baseSeed: string
  readonly startingSkillCounter: number
}

export interface IdentificationReview extends IdentifiedSkillStartingState {
  readonly startingGogmaCounter: number
}

export type IdentificationStepStatus =
  | 'idle'
  | 'searching'
  | 'completed'
  | 'cancelled'
  | 'error'

export interface SkillIdentificationWizardStepState {
  readonly status: IdentificationStepStatus
  readonly requestId: string | null
  readonly input: SkillIdentificationInput | null
  readonly progress: SkillIdentificationProgress | null
  readonly result: SkillIdentificationResult | null
  readonly classification: IdentificationResultClassification | null
  readonly identified: IdentifiedSkillStartingState | null
  readonly error: IdentificationWizardErrorState | null
}

export type GogmaIdentificationWizardInput = Omit<
  GogmaCounterIdentificationInput,
  'baseSeed'
>

export interface GogmaIdentificationWizardStepState {
  readonly status: IdentificationStepStatus
  readonly requestId: string | null
  readonly input: GogmaCounterIdentificationInput | null
  readonly progress: GogmaCounterIdentificationProgress | null
  readonly result: GogmaCounterIdentificationResult | null
  readonly classification: IdentificationResultClassification | null
  readonly startingGogmaCounter: number | null
  readonly error: IdentificationWizardErrorState | null
}

export type IdentificationAdoptionStatus =
  | 'idle'
  | 'adopting'
  | 'adopted'
  | 'error'

export interface IdentificationWizardAdoptionState {
  readonly status: IdentificationAdoptionStatus
  readonly savedRngState: RngState | null
  readonly error: IdentificationWizardErrorState | null
}

export interface IdentificationWizardState {
  readonly skill: SkillIdentificationWizardStepState
  readonly gogma: GogmaIdentificationWizardStepState
  readonly review: IdentificationReview | null
  readonly gameRestoredConfirmed: boolean
  readonly adoption: IdentificationWizardAdoptionState
  readonly disposed: boolean
}

export type IdentificationWizardStateListener = (
  state: IdentificationWizardState,
) => void

export type IdentificationWizardCoordinatorErrorCode =
  | 'disposed'
  | 'invalid_state'
  | 'confirmation_required'
  | 'adoption_in_progress'
  | 'already_adopted'
  | 'stale_request'

export class IdentificationWizardCoordinatorError extends Error {
  readonly code: IdentificationWizardCoordinatorErrorCode

  constructor(code: IdentificationWizardCoordinatorErrorCode, message: string) {
    super(message)
    this.name = 'IdentificationWizardCoordinatorError'
    this.code = code
  }
}

export interface IdentificationAdoptionPort {
  /**
   * Whether adopting these values needs the breaking-change approval
   * (`docs/PLANNER_SPEC.md` 16.6, `docs/UI_FLOW.md` 16.3). Read-only.
   */
  inspectAdoption(input: IdentificationAdoptionInput): Promise<PlanBreakingChangeInspection>
  /** Saves the values; on an `active` Plan only with the user's approval. */
  adopt(input: IdentificationAdoptionInput, approval?: PlanBreakingChangeApproval | null): Promise<RngState>
}

export interface IdentificationWizardCoordinatorDependencies {
  /** The Coordinator owns these clients and disposes both on dispose(). */
  readonly skillClient: SkillIdentificationWorkerClient
  readonly gogmaClient: GogmaCounterIdentificationWorkerClient
  readonly adoptionService: IdentificationAdoptionPort
}

export interface IdentificationWizardCoordinator {
  getState(): IdentificationWizardState
  subscribe(listener: IdentificationWizardStateListener): () => void
  identifySkill(
    input: SkillIdentificationInput,
  ): Promise<IdentificationResultClassification>
  cancelSkill(): void
  identifyGogma(
    input: GogmaIdentificationWizardInput,
  ): Promise<IdentificationResultClassification>
  cancelGogma(): void
  setGameRestoredConfirmed(value: boolean): void
  /**
   * The read-only breaking-change inspection of adopting the reviewed values.
   * The values are the Coordinator's own review, exactly as `adopt()` saves
   * them; it changes no Wizard state and writes nothing.
   */
  inspectAdoption(): Promise<PlanBreakingChangeInspection>
  /**
   * Adopts the reviewed values. `approval` is the breaking-change approval
   * when the inspection required one; without it a save that breaks the
   * `active` Plan is refused with `PlanBreakingChangeApprovalRequiredError`,
   * and the Wizard keeps its review and confirmation for the warning.
   */
  adopt(approval?: PlanBreakingChangeApproval | null): Promise<RngState>
  restart(): void
  dispose(): void
}

function createIdleSkillState(): SkillIdentificationWizardStepState {
  return {
    status: 'idle',
    requestId: null,
    input: null,
    progress: null,
    result: null,
    classification: null,
    identified: null,
    error: null,
  }
}

function createIdleGogmaState(): GogmaIdentificationWizardStepState {
  return {
    status: 'idle',
    requestId: null,
    input: null,
    progress: null,
    result: null,
    classification: null,
    startingGogmaCounter: null,
    error: null,
  }
}

function createIdleAdoptionState(): IdentificationWizardAdoptionState {
  return {
    status: 'idle',
    savedRngState: null,
    error: null,
  }
}

function createInitialState(): IdentificationWizardState {
  return {
    skill: createIdleSkillState(),
    gogma: createIdleGogmaState(),
    review: null,
    gameRestoredConfirmed: false,
    adoption: createIdleAdoptionState(),
    disposed: false,
  }
}

function classifyResult(result: {
  readonly matches: readonly unknown[]
  readonly isTruncated: boolean
}): IdentificationResultClassification {
  if (result.isTruncated) {
    return 'incomplete'
  }
  if (result.matches.length === 0) {
    return 'zero'
  }
  if (result.matches.length === 1) {
    return 'unique'
  }
  return 'multiple'
}

function classifySkillError(error: unknown): IdentificationWizardErrorState {
  if (error instanceof SkillIdentificationCancelledError) {
    return { kind: 'cancelled', error }
  }
  if (error instanceof SkillIdentificationDuplicateRequestError) {
    return { kind: 'duplicate_request', error }
  }
  if (error instanceof SkillIdentificationWorkerUnavailableError) {
    return { kind: 'worker_unavailable', error }
  }
  if (error instanceof SkillIdentificationWorkerError) {
    switch (error.code) {
      case 'cancelled':
        return { kind: 'cancelled', error }
      case 'invalid_input':
        return { kind: 'invalid_input', error }
      case 'unsupported_input':
        return { kind: 'unsupported_input', error }
      case 'incomplete_parallel_chunk':
        return { kind: 'incomplete_parallel_chunk', error }
      case 'unexpected_error':
        return { kind: 'unexpected_error', error }
    }
  }
  return { kind: 'unexpected_error', error }
}

function classifyGogmaError(error: unknown): IdentificationWizardErrorState {
  if (error instanceof GogmaCounterIdentificationCancelledError) {
    return { kind: 'cancelled', error }
  }
  if (error instanceof GogmaCounterIdentificationDuplicateRequestError) {
    return { kind: 'duplicate_request', error }
  }
  if (error instanceof GogmaCounterIdentificationWorkerUnavailableError) {
    return { kind: 'worker_unavailable', error }
  }
  if (error instanceof GogmaCounterIdentificationWorkerError) {
    switch (error.code) {
      case 'cancelled':
        return { kind: 'cancelled', error }
      case 'invalid_input':
        return { kind: 'invalid_input', error }
      case 'unsupported_input':
        return { kind: 'unsupported_input', error }
      case 'unexpected_error':
        return { kind: 'unexpected_error', error }
    }
  }
  return { kind: 'unexpected_error', error }
}

export class DefaultIdentificationWizardCoordinator
  implements IdentificationWizardCoordinator
{
  private readonly dependencies: IdentificationWizardCoordinatorDependencies
  private state = createInitialState()
  private readonly listeners = new Set<IdentificationWizardStateListener>()
  private requestSequence = 0
  private skillGeneration = 0
  private gogmaGeneration = 0
  private disposed = false

  constructor(dependencies: IdentificationWizardCoordinatorDependencies) {
    this.dependencies = dependencies
  }

  getState(): IdentificationWizardState {
    return this.state
  }

  subscribe(listener: IdentificationWizardStateListener): () => void {
    this.assertNotDisposed()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async identifySkill(
    input: SkillIdentificationInput,
  ): Promise<IdentificationResultClassification> {
    this.assertSearchAllowed()
    this.cancelActiveSkillRequest()
    this.cancelActiveGogmaRequest()

    const generation = ++this.skillGeneration
    ++this.gogmaGeneration
    const requestId = this.createRequestId('skill', generation)
    const inputSnapshot = structuredClone(input)

    this.publish({
      ...this.state,
      skill: {
        status: 'searching',
        requestId,
        input: inputSnapshot,
        progress: null,
        result: null,
        classification: null,
        identified: null,
        error: null,
      },
      gogma: createIdleGogmaState(),
      review: null,
      gameRestoredConfirmed: false,
      adoption: createIdleAdoptionState(),
    })

    try {
      const result = await this.dependencies.skillClient.identify(
        requestId,
        inputSnapshot,
        {
          onProgress: (progress) => {
            if (!this.isCurrentSkillRequest(generation, requestId)) {
              return
            }
            this.publish({
              ...this.state,
              skill: {
                ...this.state.skill,
                progress,
              },
            })
          },
        },
      )

      if (!this.isCurrentSkillRequest(generation, requestId)) {
        throw new IdentificationWizardCoordinatorError(
          'stale_request',
          'The Skill Identification response is no longer current.',
        )
      }

      const classification = classifyResult(result)
      const match = classification === 'unique' ? result.matches[0] : undefined
      const identified = match
        ? {
            baseSeed: String(match.baseSeed),
            startingSkillCounter: match.startSkillCounter,
          }
        : null

      this.publish({
        ...this.state,
        skill: {
          ...this.state.skill,
          status: 'completed',
          requestId: null,
          result,
          classification,
          identified,
          error: null,
        },
      })
      return classification
    } catch (error) {
      if (!this.isCurrentSkillRequest(generation, requestId)) {
        throw error
      }
      const classifiedError = classifySkillError(error)
      this.publish({
        ...this.state,
        skill: {
          ...this.state.skill,
          status: classifiedError.kind === 'cancelled' ? 'cancelled' : 'error',
          requestId: null,
          result: null,
          classification: null,
          identified: null,
          error: classifiedError,
        },
      })
      throw error
    }
  }

  cancelSkill(): void {
    this.assertNotDisposed()
    this.cancelActiveSkillRequest()
  }

  async identifyGogma(
    input: GogmaIdentificationWizardInput,
  ): Promise<IdentificationResultClassification> {
    this.assertSearchAllowed()
    const identifiedSkill = this.state.skill.identified
    if (
      this.state.skill.classification !== 'unique' ||
      identifiedSkill === null
    ) {
      throw new IdentificationWizardCoordinatorError(
        'invalid_state',
        'STEP 1 must have one complete, non-truncated result before STEP 2.',
      )
    }

    this.cancelActiveGogmaRequest()
    const generation = ++this.gogmaGeneration
    const requestId = this.createRequestId('gogma', generation)
    const inputSnapshot: GogmaCounterIdentificationInput = structuredClone({
      ...input,
      baseSeed: identifiedSkill.baseSeed,
    })

    this.publish({
      ...this.state,
      gogma: {
        status: 'searching',
        requestId,
        input: inputSnapshot,
        progress: null,
        result: null,
        classification: null,
        startingGogmaCounter: null,
        error: null,
      },
      review: null,
      gameRestoredConfirmed: false,
      adoption: createIdleAdoptionState(),
    })

    try {
      const result = await this.dependencies.gogmaClient.identify(
        requestId,
        inputSnapshot,
        {
          onProgress: (progress) => {
            if (!this.isCurrentGogmaRequest(generation, requestId)) {
              return
            }
            this.publish({
              ...this.state,
              gogma: {
                ...this.state.gogma,
                progress,
              },
            })
          },
        },
      )

      if (!this.isCurrentGogmaRequest(generation, requestId)) {
        throw new IdentificationWizardCoordinatorError(
          'stale_request',
          'The Gogma Counter Identification response is no longer current.',
        )
      }

      const classification = classifyResult(result)
      const match = classification === 'unique' ? result.matches[0] : undefined
      const review = match
        ? {
            ...identifiedSkill,
            startingGogmaCounter: match.startGogmaCounter,
          }
        : null

      this.publish({
        ...this.state,
        gogma: {
          ...this.state.gogma,
          status: 'completed',
          requestId: null,
          result,
          classification,
          startingGogmaCounter: match?.startGogmaCounter ?? null,
          error: null,
        },
        review,
      })
      return classification
    } catch (error) {
      if (!this.isCurrentGogmaRequest(generation, requestId)) {
        throw error
      }
      const classifiedError = classifyGogmaError(error)
      this.publish({
        ...this.state,
        gogma: {
          ...this.state.gogma,
          status: classifiedError.kind === 'cancelled' ? 'cancelled' : 'error',
          requestId: null,
          result: null,
          classification: null,
          startingGogmaCounter: null,
          error: classifiedError,
        },
        review: null,
        gameRestoredConfirmed: false,
        adoption: createIdleAdoptionState(),
      })
      throw error
    }
  }

  cancelGogma(): void {
    this.assertNotDisposed()
    this.cancelActiveGogmaRequest()
  }

  setGameRestoredConfirmed(value: boolean): void {
    this.assertNotDisposed()
    if (this.state.adoption.status === 'adopting') {
      throw new IdentificationWizardCoordinatorError(
        'adoption_in_progress',
        'Identification adoption is already in progress.',
      )
    }
    if (this.state.adoption.status === 'adopted') {
      throw new IdentificationWizardCoordinatorError(
        'already_adopted',
        'This reviewed Identification result has already been adopted.',
      )
    }
    if (value && this.state.review === null) {
      throw new IdentificationWizardCoordinatorError(
        'invalid_state',
        'A complete STEP 1 and STEP 2 review is required before confirmation.',
      )
    }
    this.publish({
      ...this.state,
      gameRestoredConfirmed: value && this.state.review !== null,
    })
  }

  /**
   * The reviewed values `adopt()` saves, after the same preconditions: a
   * complete, unique STEP 1 and STEP 2 review and the game-restored
   * confirmation. The review is the only source of the values; nothing is
   * rebuilt from the Dialog's inputs.
   */
  private reviewedAdoptionInput(): IdentificationAdoptionInput {
    this.assertNotDisposed()
    if (this.state.adoption.status === 'adopting') {
      throw new IdentificationWizardCoordinatorError(
        'adoption_in_progress',
        'Identification adoption is already in progress.',
      )
    }
    if (this.state.adoption.status === 'adopted') {
      throw new IdentificationWizardCoordinatorError(
        'already_adopted',
        'This reviewed Identification result has already been adopted.',
      )
    }
    const review = this.state.review
    if (
      review === null ||
      this.state.skill.classification !== 'unique' ||
      this.state.gogma.classification !== 'unique'
    ) {
      throw new IdentificationWizardCoordinatorError(
        'invalid_state',
        'Complete, non-truncated STEP 1 and STEP 2 results are required.',
      )
    }
    if (!this.state.gameRestoredConfirmed) {
      throw new IdentificationWizardCoordinatorError(
        'confirmation_required',
        'Confirm that the game has been restored to its pre-investigation state.',
      )
    }
    return {
      baseSeed: review.baseSeed,
      startingSkillCounter: review.startingSkillCounter,
      startingGogmaCounter: review.startingGogmaCounter,
    }
  }

  async inspectAdoption(): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.adoptionService.inspectAdoption(this.reviewedAdoptionInput())
  }

  async adopt(approval: PlanBreakingChangeApproval | null = null): Promise<RngState> {
    const input = this.reviewedAdoptionInput()

    this.publish({
      ...this.state,
      adoption: {
        status: 'adopting',
        savedRngState: null,
        error: null,
      },
    })

    try {
      const savedRngState = await this.dependencies.adoptionService.adopt(input, approval)
      if (this.disposed) {
        return savedRngState
      }
      this.publish({
        ...this.state,
        adoption: {
          status: 'adopted',
          savedRngState,
          error: null,
        },
      })
      return savedRngState
    } catch (error) {
      if (!this.disposed) {
        // A refusal for a missing approval is not a failure of the adoption:
        // the Wizard returns to its reviewed state so the breaking-change
        // warning can be shown and the adoption retried with the approval.
        this.publish({
          ...this.state,
          adoption: error instanceof PlanBreakingChangeApprovalRequiredError
            ? createIdleAdoptionState()
            : {
                status: 'error',
                savedRngState: null,
                error: { kind: 'adoption_error', error },
              },
        })
      }
      throw error
    }
  }

  restart(): void {
    this.assertNotDisposed()
    if (this.state.adoption.status === 'adopting') {
      throw new IdentificationWizardCoordinatorError(
        'adoption_in_progress',
        'The Wizard cannot restart while adoption is in progress.',
      )
    }
    this.cancelRequestsWithoutPublishing()
    ++this.skillGeneration
    ++this.gogmaGeneration
    this.publish(createInitialState())
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    ++this.skillGeneration
    ++this.gogmaGeneration
    this.cancelRequestsWithoutPublishing()
    this.dependencies.skillClient.dispose()
    this.dependencies.gogmaClient.dispose()
    this.publish({
      ...this.state,
      disposed: true,
    })
    this.listeners.clear()
  }

  private publish(state: IdentificationWizardState): void {
    this.state = state
    for (const listener of [...this.listeners]) {
      listener(state)
    }
  }

  private createRequestId(step: 'skill' | 'gogma', generation: number): string {
    this.requestSequence += 1
    return `identification-wizard.${step}.g${generation}.r${this.requestSequence}`
  }

  private isCurrentSkillRequest(generation: number, requestId: string): boolean {
    return (
      !this.disposed &&
      this.skillGeneration === generation &&
      this.state.skill.status === 'searching' &&
      this.state.skill.requestId === requestId
    )
  }

  private isCurrentGogmaRequest(generation: number, requestId: string): boolean {
    return (
      !this.disposed &&
      this.gogmaGeneration === generation &&
      this.state.gogma.status === 'searching' &&
      this.state.gogma.requestId === requestId
    )
  }

  private cancelActiveSkillRequest(): void {
    if (
      this.state.skill.status !== 'searching' ||
      this.state.skill.requestId === null
    ) {
      return
    }
    const requestId = this.state.skill.requestId
    ++this.skillGeneration
    this.dependencies.skillClient.cancel(requestId)
    const error = new SkillIdentificationCancelledError()
    this.publish({
      ...this.state,
      skill: {
        ...this.state.skill,
        status: 'cancelled',
        requestId: null,
        result: null,
        classification: null,
        identified: null,
        error: { kind: 'cancelled', error },
      },
      gogma: createIdleGogmaState(),
      review: null,
      gameRestoredConfirmed: false,
      adoption: createIdleAdoptionState(),
    })
  }

  private cancelActiveGogmaRequest(): void {
    if (
      this.state.gogma.status !== 'searching' ||
      this.state.gogma.requestId === null
    ) {
      return
    }
    const requestId = this.state.gogma.requestId
    ++this.gogmaGeneration
    this.dependencies.gogmaClient.cancel(requestId)
    const error = new GogmaCounterIdentificationCancelledError()
    this.publish({
      ...this.state,
      gogma: {
        ...this.state.gogma,
        status: 'cancelled',
        requestId: null,
        result: null,
        classification: null,
        startingGogmaCounter: null,
        error: { kind: 'cancelled', error },
      },
      review: null,
      gameRestoredConfirmed: false,
      adoption: createIdleAdoptionState(),
    })
  }

  private cancelRequestsWithoutPublishing(): void {
    if (
      this.state.skill.status === 'searching' &&
      this.state.skill.requestId !== null
    ) {
      this.dependencies.skillClient.cancel(this.state.skill.requestId)
    }
    if (
      this.state.gogma.status === 'searching' &&
      this.state.gogma.requestId !== null
    ) {
      this.dependencies.gogmaClient.cancel(this.state.gogma.requestId)
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new IdentificationWizardCoordinatorError(
        'disposed',
        'The Identification Wizard Coordinator has been disposed.',
      )
    }
  }

  private assertSearchAllowed(): void {
    this.assertNotDisposed()
    if (this.state.adoption.status === 'adopting') {
      throw new IdentificationWizardCoordinatorError(
        'adoption_in_progress',
        'Identification adoption is already in progress.',
      )
    }
    if (this.state.adoption.status === 'adopted') {
      throw new IdentificationWizardCoordinatorError(
        'already_adopted',
        'Restart the Wizard before beginning another Identification session.',
      )
    }
  }
}

export function createProductionIdentificationWizardCoordinator(): IdentificationWizardCoordinator {
  return new DefaultIdentificationWizardCoordinator({
    skillClient: createProductionMultiWorkerSkillIdentificationClient(),
    gogmaClient: createProductionGogmaCounterIdentificationWorkerClient(),
    adoptionService: identificationAdoptionService,
  })
}
