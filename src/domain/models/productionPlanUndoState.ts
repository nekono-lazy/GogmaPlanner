import type {
  ISODateTimeString,
  PlanStepId,
  ProductionPlanAbandonmentReason,
  ProductionPlanStatus,
  RecalculationReason,
} from './common'
import { hashStableValue } from './hashing'
import type { PersistedJsonObject, PersistedJsonValue } from './persistedJson'
import {
  isPersistedJsonObject,
  normalizePersistedJsonValue,
  PersistedJsonNormalizationError,
  persistedJsonValuesEqual,
} from './persistedJson'
import type { ProductionPlan } from './planning'
import type { DomainValidationIssue } from './validation'
import { validateProductionPlanUndoState } from './validation'

/**
 * The Plan fields an Execution record rewrites (`docs/DATA_MODEL.md` 12.2). The
 * rest of the Plan body, apart from each Step's `isCompleted` / `completedAt`,
 * is its content, which never changes after the Plan starts.
 */
export const PRODUCTION_PLAN_EXECUTION_FIELDS = [
  'status',
  'currentStepId',
  'recalculationReasons',
  'abandonmentReason',
  'abandonedAt',
  'completedAt',
  'updatedAt',
] as const

/** The PlanStep fields an Execution record rewrites. */
export const PLAN_STEP_EXECUTION_FIELDS = ['isCompleted', 'completedAt'] as const

export interface ProductionPlanExecutionFields {
  status: ProductionPlanStatus
  currentStepId: PlanStepId | null
  recalculationReasons: RecalculationReason[]
  abandonmentReason: ProductionPlanAbandonmentReason | null
  abandonedAt: ISODateTimeString | null
  completedAt: ISODateTimeString | null
  updatedAt: ISODateTimeString
}

export interface PlanStepExecutionFields {
  stepId: PlanStepId
  isCompleted: boolean
  completedAt: ISODateTimeString | null
}

/**
 * The Plan state an Undo returns to (`docs/DATA_MODEL.md` 12.2,
 * `docs/PLANNER_SPEC.md` 19.3 / 19.5): the Plan just before the record, kept as
 * its execution fields, the before values of the Steps whose completion the
 * record changed, and the two hashes that prove the rest of the Plan is the
 * same. It never holds the Plan body itself, so its size does not depend on the
 * number of PlanSteps.
 */
export interface ProductionPlanUndoState {
  /** The content hash of the Plan just before the record. */
  planContentHash: string
  /** The execution state hash of the Plan just before the record. */
  executionStateHash: string
  /** The execution fields of the Plan just before the record. */
  plan: ProductionPlanExecutionFields
  /** The before values of the Steps whose completion the record changed, in Plan order. */
  changedSteps: PlanStepExecutionFields[]
}

export interface ProductionPlanUndoHashes {
  planContentHash: string
  executionStateHash: string
}

/**
 * The completion of each PlanStep in Plan order, as its persisted JSON stands
 * for it: an absent or `undefined` field is `undefined`.
 */
export type ProductionPlanStepCompletionProjection = readonly {
  id: PlanStepId
  isCompleted: PersistedJsonValue | undefined
  completedAt: PersistedJsonValue | undefined
}[]

export type ProductionPlanUndoStateErrorCode =
  /** The Plan has no persisted JSON form the hashes can be taken from. */
  | 'plan_not_hashable'
  /** The Plan after a record differs from the Plan before it outside the execution fields. */
  | 'plan_content_changed'
  /** The Plan undo state fails its structural validation. */
  | 'undo_state_invalid'
  /** The current Plan's content is not the content of the Plan before the record. */
  | 'plan_content_hash_mismatch'
  /** A changed Step is not exactly one Step of the current Plan. */
  | 'changed_step_not_in_plan'
  /** The changed Steps are not in the current Plan's order. */
  | 'changed_steps_out_of_order'
  /** The reconstructed Plan's execution state is not the one before the record. */
  | 'execution_state_hash_mismatch'

export class ProductionPlanUndoStateError extends Error {
  readonly code: ProductionPlanUndoStateErrorCode
  readonly issues: DomainValidationIssue[]

  constructor(code: ProductionPlanUndoStateErrorCode, message: string, issues: DomainValidationIssue[] = []) {
    super(message)
    this.name = 'ProductionPlanUndoStateError'
    this.code = code
    this.issues = issues
  }
}

/** A ProductionPlan body normalized to its persisted JSON form. */
type NormalizedProductionPlanBody = PersistedJsonObject & { steps: PersistedJsonObject[] }

function normalizeProductionPlanBody(plan: unknown): NormalizedProductionPlanBody {
  const normalized = normalizePersistedJsonValue(plan)
  if (!isPersistedJsonObject(normalized)) {
    throw new PersistedJsonNormalizationError('invalid_plan_shape', '', 'A ProductionPlan body must be a plain object.')
  }
  const steps = normalized.steps
  if (!Array.isArray(steps)) {
    throw new PersistedJsonNormalizationError('invalid_plan_shape', 'steps', 'A ProductionPlan body must hold a PlanStep array.')
  }
  const invalidStep = steps.findIndex((step) => !isPersistedJsonObject(step))
  if (invalidStep >= 0) {
    throw new PersistedJsonNormalizationError('invalid_plan_shape', `steps[${invalidStep}]`, 'A PlanStep must be a plain object.')
  }
  return normalized as NormalizedProductionPlanBody
}

function omitKeys(object: PersistedJsonObject, keys: readonly string[]): PersistedJsonObject {
  const result: PersistedJsonObject = {}
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) result[key] = object[key]
  }
  return result
}

/** The listed keys the object holds; an absent key stays absent. */
function pickKeys(object: PersistedJsonObject, keys: readonly string[]): PersistedJsonObject {
  const result: PersistedJsonObject = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) result[key] = object[key]
  }
  return result
}

/** `contentProjection(plan)` of `docs/DATA_MODEL.md` 12.2. */
function contentProjection(plan: NormalizedProductionPlanBody): PersistedJsonObject {
  return {
    ...omitKeys(plan, PRODUCTION_PLAN_EXECUTION_FIELDS),
    steps: plan.steps.map((step) => omitKeys(step, PLAN_STEP_EXECUTION_FIELDS)),
  }
}

/** `executionStateProjection(plan)` of `docs/DATA_MODEL.md` 12.2. */
function executionStateProjection(plan: NormalizedProductionPlanBody): PersistedJsonObject {
  return {
    plan: pickKeys(plan, PRODUCTION_PLAN_EXECUTION_FIELDS),
    steps: plan.steps.map((step) => pickKeys(step, ['id', ...PLAN_STEP_EXECUTION_FIELDS])),
  }
}

function contentHashOf(plan: NormalizedProductionPlanBody): string {
  return hashStableValue(contentProjection(plan))
}

function executionStateHashOf(plan: NormalizedProductionPlanBody): string {
  return hashStableValue(executionStateProjection(plan))
}

/**
 * `planContentHash` and `executionStateHash` of one ProductionPlan body
 * (`docs/DATA_MODEL.md` 12.2): the body is normalized to its persisted JSON
 * form first, so an `undefined`-valued property and an Export / Import round
 * trip never change them, and both are the existing `hashStableValue()` of a
 * projection of that form. Accepts the body as read (untrusted) and throws
 * `PersistedJsonNormalizationError` when it has no such form.
 */
export function createProductionPlanUndoHashes(plan: unknown): ProductionPlanUndoHashes {
  const normalized = normalizeProductionPlanBody(plan)
  return { planContentHash: contentHashOf(normalized), executionStateHash: executionStateHashOf(normalized) }
}

function stepCompletionOf(step: PersistedJsonObject): ProductionPlanStepCompletionProjection[number] | null {
  if (typeof step.id !== 'string') return null
  return { id: step.id as PlanStepId, isCompleted: step.isCompleted, completedAt: step.completedAt }
}

/**
 * The Step completion projection of a Plan body as read (untrusted): `null`
 * when the body is not a plain object, `steps` is not an array of plain objects
 * with a string `id`, or a completion value has no persisted JSON form. Only
 * the Step fields are read, so a reference Plan of any size costs one pass over
 * its Steps.
 */
export function projectProductionPlanStepCompletion(plan: unknown): ProductionPlanStepCompletionProjection | null {
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) return null
  const steps: unknown = (plan as Record<string, unknown>).steps
  if (!Array.isArray(steps)) return null
  const projection: ProductionPlanStepCompletionProjection[number][] = []
  try {
    for (let index = 0; index < steps.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(steps, index)) return null
      const step = normalizePersistedJsonValue(pickStepCompletionFields(steps[index]))
      const completion = isPersistedJsonObject(step) ? stepCompletionOf(step) : null
      if (completion === null) return null
      projection.push(completion)
    }
  } catch (error) {
    if (error instanceof PersistedJsonNormalizationError) return null
    throw error
  }
  return projection
}

function pickStepCompletionFields(step: unknown): unknown {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return step
  const prototype = Object.getPrototypeOf(step)
  if (prototype !== Object.prototype && prototype !== null) return step
  const record = step as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of ['id', ...PLAN_STEP_EXECUTION_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) picked[key] = record[key]
  }
  return picked
}

function projectNormalizedStepCompletion(plan: NormalizedProductionPlanBody): ProductionPlanStepCompletionProjection | null {
  const projection: ProductionPlanStepCompletionProjection[number][] = []
  for (const step of plan.steps) {
    const completion = stepCompletionOf(step)
    if (completion === null) return null
    projection.push(completion)
  }
  return projection
}

function sameStepIds(
  left: ProductionPlanStepCompletionProjection,
  right: ProductionPlanStepCompletionProjection,
): boolean {
  return left.length === right.length && left.every(({ id }, index) => id === right[index].id)
}

function undoStateOfNormalized(
  before: NormalizedProductionPlanBody,
  beforeSteps: ProductionPlanStepCompletionProjection,
  reference: ProductionPlanStepCompletionProjection,
): ProductionPlanUndoState {
  const changedSteps: PlanStepExecutionFields[] = []
  before.steps.forEach((step, index) => {
    const completion = beforeSteps[index]
    const after = reference[index]
    if (
      persistedJsonValuesEqual(completion.isCompleted, after.isCompleted) &&
      persistedJsonValuesEqual(completion.completedAt, after.completedAt)
    ) {
      return
    }
    // The before value as persisted; an absent field stays absent and fails
    // the undo state validation rather than being filled in.
    changedSteps.push({ stepId: completion.id, ...pickKeys(step, PLAN_STEP_EXECUTION_FIELDS) } as unknown as PlanStepExecutionFields)
  })
  return {
    planContentHash: contentHashOf(before),
    executionStateHash: executionStateHashOf(before),
    plan: pickKeys(before, PRODUCTION_PLAN_EXECUTION_FIELDS) as unknown as ProductionPlanExecutionFields,
    changedSteps,
  }
}

export type ProductionPlanUndoStateAgainstReference =
  | { kind: 'created'; state: ProductionPlanUndoState }
  /** The Plan before the record and the reference Plan do not hold the same Step IDs in the same order. */
  | { kind: 'step_ids_mismatch' }

/**
 * The undo state of a record from the Plan just before it and the Step
 * completion of the Plan the record left (`docs/DATA_MODEL.md` 14.2): the
 * `changedSteps` are the Steps whose `isCompleted` / `completedAt` differ, with
 * their before values in Plan order, and both hashes are taken from `before`.
 * The reference must hold exactly the Step IDs of `before` in the same order.
 *
 * Shared by the record creation (`deriveProductionPlanUndoState()`) and the
 * conversion of an existing record. Accepts `before` as read (untrusted) and
 * throws `PersistedJsonNormalizationError` when it has no persisted JSON Plan
 * form; it never changes its inputs.
 */
export function createProductionPlanUndoStateAgainstReference(
  before: unknown,
  reference: ProductionPlanStepCompletionProjection | null,
): ProductionPlanUndoStateAgainstReference {
  const normalized = normalizeProductionPlanBody(before)
  const beforeSteps = projectNormalizedStepCompletion(normalized)
  if (reference === null || beforeSteps === null || !sameStepIds(beforeSteps, reference)) {
    return { kind: 'step_ids_mismatch' }
  }
  return { kind: 'created', state: undoStateOfNormalized(normalized, beforeSteps, reference) }
}

function normalizeOrFail(plan: unknown, label: string): NormalizedProductionPlanBody {
  try {
    return normalizeProductionPlanBody(plan)
  } catch (error) {
    if (error instanceof PersistedJsonNormalizationError) {
      throw new ProductionPlanUndoStateError('plan_not_hashable', `${label} has no persisted JSON form: ${error.message}`)
    }
    throw error
  }
}

function assertUndoStateValid(state: ProductionPlanUndoState): void {
  const validation = validateProductionPlanUndoState(state)
  if (!validation.isValid) {
    throw new ProductionPlanUndoStateError('undo_state_invalid', 'The Plan undo state fails validation.', validation.issues)
  }
}

/**
 * The undo state a record keeps (`docs/PLANNER_SPEC.md` 19.4): the execution
 * fields of the Plan before the record, the before values of the Steps whose
 * completion the record changed, and both hashes of the Plan before it.
 *
 * An Execution transition rewrites the execution fields only, so the Plan after
 * the record must hold exactly the content of the Plan before it; otherwise it
 * throws `ProductionPlanUndoStateError` (`plan_content_changed`). A Plan without
 * a persisted JSON form (`plan_not_hashable`) or a result that fails the undo
 * state validation (`undo_state_invalid`) throws too, so a record is never
 * created from a value the Undo could not verify. The inputs are never changed
 * and the result holds no part of the Plan body.
 */
export function deriveProductionPlanUndoState(before: ProductionPlan, after: ProductionPlan): ProductionPlanUndoState {
  const normalizedBefore = normalizeOrFail(before, 'The Plan before the record')
  const normalizedAfter = normalizeOrFail(after, 'The Plan after the record')
  if (!persistedJsonValuesEqual(contentProjection(normalizedBefore), contentProjection(normalizedAfter))) {
    throw new ProductionPlanUndoStateError(
      'plan_content_changed',
      `ProductionPlan '${String(before.id)}' changed outside its execution fields.`,
    )
  }
  const beforeSteps = projectNormalizedStepCompletion(normalizedBefore)
  const afterSteps = projectNormalizedStepCompletion(normalizedAfter)
  if (beforeSteps === null || afterSteps === null) {
    throw new ProductionPlanUndoStateError('undo_state_invalid', `ProductionPlan '${String(before.id)}' has a PlanStep without an ID.`)
  }
  const state = undoStateOfNormalized(normalizedBefore, beforeSteps, afterSteps)
  assertUndoStateValid(state)
  return state
}

type ChangedStepLocation =
  | { kind: 'located'; indexes: number[] }
  | { kind: 'not_in_plan'; stepId: PlanStepId }
  | { kind: 'out_of_order'; stepId: PlanStepId }

/**
 * The index of each changed Step in the Plan: it must be exactly one Step of
 * the Plan, and the changed Steps must follow the Plan order.
 */
function locateChangedSteps(
  stepIds: readonly unknown[],
  changedSteps: readonly Pick<PlanStepExecutionFields, 'stepId'>[],
): ChangedStepLocation {
  const wanted = new Set<unknown>(changedSteps.map(({ stepId }) => stepId))
  const indexesById = new Map<unknown, number[]>()
  stepIds.forEach((id, index) => {
    if (!wanted.has(id)) return
    const indexes = indexesById.get(id)
    if (indexes) indexes.push(index)
    else indexesById.set(id, [index])
  })
  const located: number[] = []
  for (const { stepId } of changedSteps) {
    const indexes = indexesById.get(stepId)
    if (!indexes || indexes.length !== 1) return { kind: 'not_in_plan', stepId }
    if (located.length > 0 && indexes[0] <= located[located.length - 1]) return { kind: 'out_of_order', stepId }
    located.push(indexes[0])
  }
  return { kind: 'located', indexes: located }
}

function overlayUndoState<T extends { steps: readonly object[] }>(
  base: T,
  state: ProductionPlanUndoState,
  indexes: readonly number[],
): T {
  const steps = [...base.steps]
  state.changedSteps.forEach(({ isCompleted, completedAt }, index) => {
    const at = indexes[index]
    steps[at] = { ...steps[at], isCompleted, completedAt }
  })
  return {
    ...base,
    status: state.plan.status,
    currentStepId: state.plan.currentStepId,
    recalculationReasons: [...state.plan.recalculationReasons],
    abandonmentReason: state.plan.abandonmentReason,
    abandonedAt: state.plan.abandonedAt,
    completedAt: state.plan.completedAt,
    updatedAt: state.plan.updatedAt,
    steps,
  }
}

/**
 * The current Plan with the undo state's values laid over it, without any hash
 * check: for display only (`docs/PLANNER_SPEC.md` 19.5, the Navigator's Undo
 * availability), never a write authority. `null` when the state is invalid or a
 * changed Step is not exactly one Step of the Plan in Plan order. Nested values
 * the overlay does not change are shared with `current`, which is never
 * changed.
 */
export function overlayProductionPlanUndoState(
  current: ProductionPlan,
  state: ProductionPlanUndoState,
): ProductionPlan | null {
  if (!validateProductionPlanUndoState(state).isValid) return null
  const location = locateChangedSteps(current.steps.map(({ id }) => id), state.changedSteps)
  if (location.kind !== 'located') return null
  return overlayUndoState(current, state, location.indexes)
}

/**
 * The Plan just before a record, rebuilt from the current Plan and the record's
 * undo state (`docs/PLANNER_SPEC.md` 19.5 steps 3 - 6):
 *
 * 1. the undo state passes its validation (`undo_state_invalid`)
 * 2. the current Plan's content hash is `planContentHash`
 *    (`plan_not_hashable`, `plan_content_hash_mismatch`)
 * 3. a copy of the current Plan takes the seven execution fields and the before
 *    value of each changed Step, which must be exactly one Step of the Plan in
 *    Plan order (`changed_step_not_in_plan`, `changed_steps_out_of_order`)
 * 4. the copy's execution state hash is `executionStateHash`
 *    (`execution_state_hash_mismatch`)
 *
 * Any failure throws `ProductionPlanUndoStateError`. No value is derived from an
 * RNG prediction, a Counter or a Plan transition, and no timestamp is made up.
 *
 * The hashes are taken from the persisted JSON form, but the Plan returned is a
 * deep copy of `current` as it is: every property the Undo does not restore,
 * at any depth and an `undefined`-valued one included, is kept exactly, and
 * nothing is shared with `current`, which is never changed. Whether a property
 * was absent or `undefined` before the record is not recorded, so it is never
 * guessed: the current Plan's own representation is kept.
 */
export function reconstructProductionPlanFromUndoState(
  current: ProductionPlan,
  state: ProductionPlanUndoState,
): ProductionPlan {
  assertUndoStateValid(state)
  const normalized = normalizeOrFail(current, `ProductionPlan '${String(current?.id)}'`)
  if (contentHashOf(normalized) !== state.planContentHash) {
    throw new ProductionPlanUndoStateError(
      'plan_content_hash_mismatch',
      `ProductionPlan '${String(normalized.id)}' does not hold the content of the Plan before the record.`,
    )
  }
  const location = locateChangedSteps(normalized.steps.map((step) => step.id), state.changedSteps)
  if (location.kind === 'not_in_plan') {
    throw new ProductionPlanUndoStateError(
      'changed_step_not_in_plan',
      `Changed PlanStep '${location.stepId}' is not exactly one PlanStep of ProductionPlan '${String(normalized.id)}'.`,
    )
  }
  if (location.kind === 'out_of_order') {
    throw new ProductionPlanUndoStateError(
      'changed_steps_out_of_order',
      `Changed PlanStep '${location.stepId}' is not in the Plan order of ProductionPlan '${String(normalized.id)}'.`,
    )
  }
  // The current Plan has a persisted JSON form (it was normalized above), so
  // its deep copy holds JSON values and undefined-valued properties only.
  const reconstructed = overlayUndoState(structuredClone(current), state, location.indexes)
  if (executionStateHashOf(normalizeOrFail(reconstructed, 'The rebuilt Plan')) !== state.executionStateHash) {
    throw new ProductionPlanUndoStateError(
      'execution_state_hash_mismatch',
      `The rebuilt ProductionPlan '${String(normalized.id)}' does not hold the execution state of the Plan before the record.`,
    )
  }
  return reconstructed
}
