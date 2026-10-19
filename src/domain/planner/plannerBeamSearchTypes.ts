import type { DomainValidationIssue, DomainValidationResult } from '../models/publicTypes'
import {
  plannerPositiveIntegerOptionIssue,
  validatePlannerOptions,
} from './plannerValidation'
import type {
  PlannerExecutionOptions,
  PlannerInput,
  PlannerOptions,
  PlannerRunLimitKind,
  PlannerRunResultOf,
  PlannerTerminationOf,
} from './plannerTypes'

/**
 * The Beam Search oracle's own contract (Issue #103 Phase D-2a).
 *
 * The bounded Beam Search stopped being the Production Planner in Phase C and
 * stays a test / parity regression oracle only. Everything it needs beyond the
 * Production contract - its two extra bounds, its limit kind and its
 * termination - lives here, so none of it can reach a Production
 * `PlannerInput`, `PlannerResult`, Worker request, Worker response or UI.
 * Production code never imports this module. Issue #103 Phase D-2b removed
 * its numeric progress and its PR #107 search instrumentation with the
 * Phase B benchmark harness; a bound it reaches is reported by
 * `PlannerBeamSearchTermination.reachedLimits` alone, never by a warning.
 */

/** The Beam Search oracle bounds: the Production bound plus its own two. */
export interface PlannerBeamSearchOptions extends PlannerOptions {
  /** How many ranked states survive each depth. */
  beamWidth: number
  /** The oracle's bound on the successors it constructs. */
  maxExpandedStates: number
}

/**
 * The oracle's own defaults, independent of `defaultPlannerOptions`: a test or
 * the parity harness that runs the Beam Search states its bounds from here, and no
 * Production module reads them.
 */
export const defaultPlannerBeamSearchOptions: Readonly<PlannerBeamSearchOptions> = {
  maxPlanSteps: 1000,
  beamWidth: 50,
  maxExpandedStates: 10_000,
}

/** A Planner input whose options carry the Beam Search oracle bounds. */
export type PlannerBeamSearchInput = Omit<PlannerInput, 'options'> & {
  options: PlannerBeamSearchOptions
}

/** Which oracle bound a Beam Search touched. */
export type PlannerBeamSearchLimitKind = PlannerRunLimitKind | 'max_expanded_states'

export const plannerBeamSearchLimitKinds: readonly PlannerBeamSearchLimitKind[] = [
  'max_expanded_states',
  'max_plan_steps',
]

/** The Beam Search oracle termination; same status meaning, oracle bounds. */
export type PlannerBeamSearchTermination = PlannerTerminationOf<
  PlannerBeamSearchLimitKind,
  PlannerBeamSearchOptions
>

/** The Beam Search oracle result; the fields are the Production run's. */
export type PlannerBeamSearchResult = PlannerRunResultOf<PlannerBeamSearchTermination>

/**
 * The Beam Search oracle's execution hooks: exactly the Production ones
 * (`shouldCancel` / `yieldControl`).
 */
export type PlannerBeamSearchExecutionOptions = PlannerExecutionOptions

/**
 * The Beam Search oracle options: the Production `validatePlannerOptions()`
 * plus the oracle's own two bounds, each a positive integer. The Beam Search
 * validates its input with this, never with the Production validation alone,
 * so an invalid `beamWidth` or `maxExpandedStates` is never missed.
 */
export function validatePlannerBeamSearchOptions(
  options: PlannerBeamSearchOptions,
): DomainValidationResult {
  const issues = [
    ...validatePlannerOptions(options).issues,
    ...[
      plannerPositiveIntegerOptionIssue(options.beamWidth, 'beamWidth'),
      plannerPositiveIntegerOptionIssue(options.maxExpandedStates, 'maxExpandedStates'),
    ].filter((entry): entry is DomainValidationIssue => entry !== null),
  ]
  return { isValid: issues.length === 0, issues }
}

/** The oracle bounds as a termination records them. */
export function plannerBeamSearchLimits(options: PlannerBeamSearchOptions): PlannerBeamSearchOptions {
  return {
    maxPlanSteps: options.maxPlanSteps,
    beamWidth: options.beamWidth,
    maxExpandedStates: options.maxExpandedStates,
  }
}

/** The Production view of an oracle input: the same input, `maxPlanSteps` only. */
export function plannerRunInputOf(input: PlannerBeamSearchInput): PlannerInput {
  return { ...input, options: { maxPlanSteps: input.options.maxPlanSteps } }
}

/**
 * A Beam Search oracle input over a Production `PlannerInput`: the same
 * input, with the oracle's two bounds added (the defaults unless given).
 */
export function createPlannerBeamSearchInput(
  input: PlannerInput,
  beamOptions: Partial<Pick<PlannerBeamSearchOptions, 'beamWidth' | 'maxExpandedStates'>> = {},
): PlannerBeamSearchInput {
  return {
    ...input,
    options: {
      maxPlanSteps: input.options.maxPlanSteps,
      beamWidth: beamOptions.beamWidth ?? defaultPlannerBeamSearchOptions.beamWidth,
      maxExpandedStates:
        beamOptions.maxExpandedStates ?? defaultPlannerBeamSearchOptions.maxExpandedStates,
    },
  }
}
