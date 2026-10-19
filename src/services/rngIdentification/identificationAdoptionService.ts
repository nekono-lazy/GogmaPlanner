import {
  unchangedMutableState,
  type PlanBreakingChangeApproval,
  type PlanBreakingChangeInspection,
  type PlanGuardedMutation,
} from '../../domain/execution'
import type {
  DomainValidationIssue,
  ISODateTimeString,
  RngState,
} from '../../domain/models/publicTypes'
import { createInitialRngState } from '../../domain/models/factories'
import { validateRngState } from '../../domain/models/validation'
import { productionRngEngine } from '../../domain/rng/production/productionRngRuntime'
import type { RngEngine } from '../../domain/rng/rngEngine'
import { rngStateRepository } from '../../db/repositories'
import {
  defaultPlanGuardedPersistence,
  type PlanGuardedPersistence,
} from '../execution/planBreakingChangeGuard'

export interface IdentificationAdoptionInput {
  readonly baseSeed: string
  readonly startingSkillCounter: number
  readonly startingGogmaCounter: number
}

export interface IdentificationAdoptionRepository {
  ensureInitialRngState(): Promise<RngState>
}

export interface IdentificationAdoptionClock {
  now(): ISODateTimeString
}

export interface IdentificationAdoptionDependencies {
  readonly repository: IdentificationAdoptionRepository
  /**
   * The breaking-change guard the adopted RngState is saved through: on an
   * `active` Plan the adoption is a Plan-breaking change (`docs/PLANNER_SPEC.md`
   * 16.6) and is refused without the user's approval.
   */
  readonly persistence: PlanGuardedPersistence
  readonly seedNormalizer: Pick<RngEngine, 'normalizeSeed'>
  readonly clock: IdentificationAdoptionClock
}

export type IdentificationAdoptionErrorCode =
  | 'invalid_input'
  | 'persistent_state_unavailable'
  | 'invalid_persistent_state'

export class IdentificationAdoptionError extends Error {
  readonly code: IdentificationAdoptionErrorCode
  readonly validationIssues: readonly DomainValidationIssue[]

  constructor(
    code: IdentificationAdoptionErrorCode,
    message: string,
    options?: {
      cause?: unknown
      validationIssues?: readonly DomainValidationIssue[]
    },
  ) {
    super(message, { cause: options?.cause })
    this.name = 'IdentificationAdoptionError'
    this.code = code
    this.validationIssues = options?.validationIssues ?? []
  }
}

const INPUT_VALIDATION_TIME = '1970-01-01T00:00:00.000Z'

const defaultDependencies: IdentificationAdoptionDependencies = {
  repository: {
    ensureInitialRngState: () => rngStateRepository.ensureInitialRngState(),
  },
  persistence: defaultPlanGuardedPersistence,
  seedNormalizer: productionRngEngine,
  clock: { now: () => new Date().toISOString() },
}

function normalizeAdoptionSeed(
  input: string,
  seedNormalizer: Pick<RngEngine, 'normalizeSeed'>,
): string {
  try {
    return seedNormalizer.normalizeSeed(input)
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) throw error
    throw new IdentificationAdoptionError(
      'invalid_input',
      'Identification Base Seed is invalid.',
      { cause: error },
    )
  }
}

function assertValidAdoptionInput(
  input: IdentificationAdoptionInput,
  canonicalBaseSeed: string,
): void {
  const validationState: RngState = {
    ...createInitialRngState(INPUT_VALIDATION_TIME),
    baseSeed: {
      value: canonicalBaseSeed,
      isConfirmed: true,
      source: 'observation',
    },
    skillCounter: {
      value: input.startingSkillCounter,
      isConfirmed: true,
      source: 'observation',
    },
    gogmaCounter: {
      value: input.startingGogmaCounter,
      isConfirmed: true,
      source: 'observation',
    },
  }
  const validation = validateRngState(validationState)
  if (!validation.isValid) {
    throw new IdentificationAdoptionError(
      'invalid_input',
      'Identification adoption input failed Domain validation.',
      { validationIssues: validation.issues },
    )
  }
}

function assertValidPersistentState(state: RngState): void {
  const validation = validateRngState(state)
  if (!validation.isValid) {
    throw new IdentificationAdoptionError(
      'invalid_persistent_state',
      'The persisted RngState failed Domain validation.',
      { validationIssues: validation.issues },
    )
  }
}

/**
 * Adopts reviewed exact Identification values only. Unique/non-truncated result
 * selection and confirmation that the game was restored belong to the Wizard
 * Coordinator. Observation counts never advance the starting counters here.
 */
export class IdentificationAdoptionService {
  private readonly dependencies: IdentificationAdoptionDependencies

  constructor(
    dependencies: IdentificationAdoptionDependencies = defaultDependencies,
  ) {
    this.dependencies = dependencies
  }

  /**
   * Saves the adopted values. On an `active` Plan this breaks the Plan and is
   * refused unless `approval` names that Plan and the save point decision; with
   * it the Plan is abandoned (`breaking_change_approved`) in the same
   * transaction. A `stale` Plan is never asked about.
   */
  async adopt(
    input: IdentificationAdoptionInput,
    approval: PlanBreakingChangeApproval | null = null,
  ): Promise<RngState> {
    const mutation = await this.prepareAdoption(input)
    return (await this.dependencies.persistence.apply(mutation, approval)).result
  }

  /** Whether adopting needs the breaking-change approval (`docs/UI_FLOW.md` 16.3). Writes nothing. */
  async inspectAdoption(input: IdentificationAdoptionInput): Promise<PlanBreakingChangeInspection> {
    return this.dependencies.persistence.inspect(await this.prepareAdoption(input))
  }

  private async prepareAdoption(input: IdentificationAdoptionInput): Promise<PlanGuardedMutation<RngState>> {
    const canonicalBaseSeed = normalizeAdoptionSeed(
      input.baseSeed,
      this.dependencies.seedNormalizer,
    )
    assertValidAdoptionInput(input, canonicalBaseSeed)

    const ensured = await this.dependencies.repository.ensureInitialRngState()
    if (!ensured) {
      throw new IdentificationAdoptionError(
        'persistent_state_unavailable',
        'The current RngState is unavailable.',
      )
    }
    const now = this.dependencies.clock.now()
    // The adopted values are applied over the RngState of the state the save
    // runs on, so a save point restore before it is never overwritten by a
    // body read earlier, and every unrelated field is preserved.
    return (base) => {
      const current = base.rngState
      if (!current) {
        throw new IdentificationAdoptionError(
          'persistent_state_unavailable',
          'The current RngState is unavailable.',
        )
      }
      assertValidPersistentState(current)
      const next: RngState = {
        ...current,
        baseSeed: {
          value: canonicalBaseSeed,
          isConfirmed: true,
          source: 'observation',
        },
        skillCounter: {
          value: input.startingSkillCounter,
          isConfirmed: true,
          source: 'observation',
        },
        gogmaCounter: {
          value: input.startingGogmaCounter,
          isConfirmed: true,
          source: 'observation',
        },
        // The Identification provenance (`docs/DATA_MODEL.md` 6.1): this
        // adoption is its only writer.
        lastIdentifiedAt: now,
        updatedAt: now,
      }
      assertValidPersistentState(next)
      return { result: next, state: { ...unchangedMutableState(base), rngState: next } }
    }
  }
}

export const identificationAdoptionService = new IdentificationAdoptionService()
