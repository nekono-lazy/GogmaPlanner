import type { ExecutionHistoryId, ISODateTimeString, ProductionPlanId } from './common'
import { deriveExecutionUndoEligibility } from './executionUndoEligibility'
import type { LegacyExecutionHistory } from './legacyExecutionHistory'
import { PersistedJsonNormalizationError } from './persistedJson'
import type { ExecutionHistory, ExecutionUndoSnapshot, ProductionPlan } from './planning'
import { compareExecutionHistoryOrder } from './planning'
import type {
  ProductionPlanStepCompletionProjection,
  ProductionPlanUndoStateAgainstReference,
} from './productionPlanUndoState'
import {
  createProductionPlanUndoStateAgainstReference,
  projectProductionPlanStepCompletion,
} from './productionPlanUndoState'
import type { DomainValidationIssue } from './validation'
import { hasLegacyTargetWeaponField, type LegacyTargetWeapon } from './legacyTargetWeapon'
import { validateExecutionRecord, validateLegacyTargetWeapon, validateTargetWeapon } from './validation'

/**
 * The conversion of the Dexie version 10 / Export schema 13 ExecutionHistory
 * records (`LegacyExecutionHistory`) into the `docs/DATA_MODEL.md` 12.2
 * metadata and Undo body (`docs/DATA_MODEL.md` 14.2,
 * Issue #312). The one authority shared by the Dexie version(11) upgrade and
 * the Export schema 13 -> 14 migration: the order rule, the reference Plan rule
 * and the per-record rule are all here, and only how the records are gathered
 * differs. Nothing here reads or writes storage or changes its inputs.
 */

/** The three values that order one record within its Plan. */
export interface ExecutionHistoryOrderKey {
  id: ExecutionHistoryId
  planId: ProductionPlanId
  createdAt: ISODateTimeString
}

/**
 * The order values of one record as they were gathered - by key cursors over
 * the primary key and the `planId` / `createdAt` indexes, or from an Export
 * record. A value missing from an index, or not a string, is kept as it is.
 */
export interface ExecutionHistoryOrderKeyCandidate {
  id: unknown
  planId: unknown
  createdAt: unknown
}

export interface OrderedExecutionHistoryPlan<T> {
  planId: ProductionPlanId
  /** The Plan's records in `compareExecutionHistoryOrder()` order, the latest last. */
  records: (T & ExecutionHistoryOrderKey)[]
}

export interface OrderedExecutionHistoryKeys<T> {
  /** One entry per Plan, in Plan ID order. */
  plans: OrderedExecutionHistoryPlan<T>[]
  /** Records whose order cannot be decided: each is unconvertible (`invalid_order_key`). */
  unordered: T[]
}

function isOrderKey<T extends ExecutionHistoryOrderKeyCandidate>(candidate: T): candidate is T & ExecutionHistoryOrderKey {
  return typeof candidate.id === 'string' && typeof candidate.planId === 'string' && typeof candidate.createdAt === 'string'
}

/**
 * Groups records by Plan and orders each Plan's records by
 * `compareExecutionHistoryOrder()` (`createdAt`, then `id`) - never by an
 * IndexedDB key order, whose code-unit comparison can differ from
 * `localeCompare`. A record without a string `id`, `planId` and `createdAt`
 * has no order and is returned in `unordered`.
 */
export function orderExecutionHistoryKeys<T extends ExecutionHistoryOrderKeyCandidate>(
  candidates: Iterable<T>,
): OrderedExecutionHistoryKeys<T> {
  const byPlan = new Map<string, (T & ExecutionHistoryOrderKey)[]>()
  const unordered: T[] = []
  for (const candidate of candidates) {
    if (!isOrderKey(candidate)) {
      unordered.push(candidate)
      continue
    }
    const records = byPlan.get(candidate.planId)
    if (records) records.push(candidate)
    else byPlan.set(candidate.planId, [candidate])
  }
  const plans = [...byPlan.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([planId, records]) => ({
      planId: planId as ProductionPlanId,
      records: [...records].sort(compareExecutionHistoryOrder),
    }))
  return { plans, unordered }
}

/**
 * Why one record cannot be converted (`docs/DATA_MODEL.md` 14.2). The current
 * runtime never writes such a record; it is broken data, kept as it is by the
 * Dexie upgrade and refused by the Export migration.
 */
export type ExecutionHistoryConversionFailure =
  /** No string `id`, `planId` and `createdAt` to order it by, or values that differ from its order key. */
  | 'invalid_order_key'
  | 'undo_snapshot_not_object'
  | 'production_plan_before_not_object'
  /** `productionPlanBefore.id` is not the record's `planId`. */
  | 'production_plan_before_id_mismatch'
  /** The record's Plan does not exist (or is not exactly one Plan). */
  | 'production_plan_not_found'
  | 'added_owned_weapon_ids_not_array'
  /**
   * An Undo snapshot field the converted Undo body is made of is missing or has
   * the wrong structure: `rngStateBefore` is not an object,
   * `normalCountersBefore`, `affectedOwnedWeaponsBefore`,
   * `removedOwnedWeaponsBefore` or `affectedTargetWeaponsBefore` is not an array
   * of objects, or `executionSavePointBefore` is neither `null` nor an object.
   */
  | 'undo_snapshot_field_invalid'
  /** `productionPlanBefore` has no persisted JSON Plan form, so its hashes cannot be taken. */
  | 'unhashable_value'
  /** The reference Plan does not hold the Step IDs of `productionPlanBefore` in the same order. */
  | 'step_ids_mismatch'
  /**
   * The converted metadata and Undo body fail the `docs/DATA_MODEL.md` 12.2
   * validation (`validateExecutionRecord()`), such as an entity
   * whose own structure is invalid; `issues` says where.
   */
  | 'converted_record_invalid'

export interface ConvertedExecutionHistoryRecord {
  kind: 'converted'
  executionHistory: ExecutionHistory
  executionUndoSnapshot: ExecutionUndoSnapshot
}

export interface UnconvertibleExecutionHistoryRecord {
  kind: 'unconvertible'
  /** The record's `id` as it was read; it may be missing or not a string. */
  executionHistoryId: unknown
  failure: ExecutionHistoryConversionFailure
  message: string
  /** The 12.2 validation issues of `converted_record_invalid`; empty for every other failure. */
  issues: DomainValidationIssue[]
}

export type ExecutionHistoryRecordConversion =
  | ConvertedExecutionHistoryRecord
  | UnconvertibleExecutionHistoryRecord

/** The unconvertible result of a record `orderExecutionHistoryKeys()` could not order. */
export function unorderedExecutionHistoryRecord(candidate: ExecutionHistoryOrderKeyCandidate): UnconvertibleExecutionHistoryRecord {
  return {
    kind: 'unconvertible',
    executionHistoryId: candidate.id,
    failure: 'invalid_order_key',
    message: 'The ExecutionHistory record has no string id, planId and createdAt to order it by.',
    issues: [],
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The listed properties the record holds, copied; an absent property stays absent. */
function copyPresent(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copied: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) copied[key] = structuredClone(record[key])
  }
  return copied
}

const METADATA_FIELDS = [
  'id',
  'planId',
  'planStepId',
  'action',
  'actualResult',
  'wasExpected',
  'recalculationReason',
  'createdAt',
] as const

const MOVED_UNDO_SNAPSHOT_ENTITY_ARRAYS = [
  'normalCountersBefore',
  'affectedOwnedWeaponsBefore',
  'removedOwnedWeaponsBefore',
  'affectedTargetWeaponsBefore',
] as const

const MOVED_UNDO_SNAPSHOT_FIELDS = ['rngStateBefore', ...MOVED_UNDO_SNAPSHOT_ENTITY_ARRAYS] as const

interface RecordConversionContext {
  key: ExecutionHistoryOrderKey
  record: unknown
  /** The record's Plan as it is now; `undefined` when it does not exist. */
  currentPlan: unknown
  /** The Step completion of the Plan the record left, or `null` when it has none. */
  reference: ProductionPlanStepCompletionProjection | null
  /** Whether the record is the Plan's last record. */
  isLastRecord: boolean
}

interface RecordConversionOutcome {
  result: ExecutionHistoryRecordConversion
  /**
   * The Step completion of the record's `productionPlanBefore`, the reference
   * of the record before it; `undefined` when the record holds no
   * `productionPlanBefore`, so the reference stays as it was.
   */
  nextReference: ProductionPlanStepCompletionProjection | null | undefined
}

function unconvertible(
  key: ExecutionHistoryOrderKey,
  failure: ExecutionHistoryConversionFailure,
  message: string,
  issues: DomainValidationIssue[] = [],
): UnconvertibleExecutionHistoryRecord {
  return { kind: 'unconvertible', executionHistoryId: key.id, failure, message: `ExecutionHistory '${key.id}': ${message}`, issues }
}

/** Whether every index of the array holds an object; a hole is no object. */
function isObjectArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !isObjectRecord(value[index])) return false
  }
  return true
}

/**
 * The first Undo snapshot field the converted body is made of whose structure
 * is wrong, or `null`. These are the fields the current `docs/DATA_MODEL.md` 12
 * shape requires of every record, whatever its action: the Undo body moves
 * them, and the save point before the Step is kept by a terminal record.
 */
function invalidUndoSnapshotField(snapshot: Record<string, unknown>): string | null {
  if (!isObjectRecord(snapshot.rngStateBefore)) return 'rngStateBefore'
  for (const field of MOVED_UNDO_SNAPSHOT_ENTITY_ARRAYS) {
    if (!isObjectArray(snapshot[field])) return field
  }
  const savePoint = snapshot.executionSavePointBefore
  if (savePoint !== null && !isObjectRecord(savePoint)) return 'executionSavePointBefore'
  return null
}

/**
 * The record's terminal transition deleted the game save point it kept, so
 * only its Undo restores it: the record is the Plan's last record and the 16.16
 * eligibility, the authority the current Undo decides the restore with
 * (`decideSavePoint()`), judges it terminal. Every other record keeps `null`.
 */
function causedTerminalTransition(
  currentPlan: unknown,
  record: Record<string, unknown>,
  before: Record<string, unknown>,
): boolean {
  const eligibility = deriveExecutionUndoEligibility(
    currentPlan as ProductionPlan,
    record as unknown as LegacyExecutionHistory,
    before as unknown as ProductionPlan,
  )
  return eligibility.allowed && eligibility.terminal
}

function convertRecord(context: RecordConversionContext): RecordConversionOutcome {
  const { key, record, currentPlan, reference, isLastRecord } = context
  if (
    !isObjectRecord(record) ||
    record.id !== key.id ||
    record.planId !== key.planId ||
    record.createdAt !== key.createdAt
  ) {
    return {
      result: unconvertible(key, 'invalid_order_key', 'the record does not hold the id, planId and createdAt it was ordered by.'),
      nextReference: undefined,
    }
  }
  const snapshot = record.undoSnapshot
  if (!isObjectRecord(snapshot)) {
    return { result: unconvertible(key, 'undo_snapshot_not_object', 'undoSnapshot is not an object.'), nextReference: undefined }
  }
  const before = snapshot.productionPlanBefore
  if (!isObjectRecord(before)) {
    return {
      result: unconvertible(key, 'production_plan_before_not_object', 'productionPlanBefore is not an object.'),
      nextReference: undefined,
    }
  }
  // From here on the record holds its Plan before it, which is the reference
  // of the record before it whether or not this record converts.
  const nextReference = projectProductionPlanStepCompletion(before)
  const fail = (failure: ExecutionHistoryConversionFailure, message: string): RecordConversionOutcome => ({
    result: unconvertible(key, failure, message),
    nextReference,
  })
  if (before.id !== key.planId) {
    return fail('production_plan_before_id_mismatch', `productionPlanBefore is not ProductionPlan '${key.planId}'.`)
  }
  if (currentPlan === undefined || currentPlan === null) {
    return fail('production_plan_not_found', `ProductionPlan '${key.planId}' does not exist.`)
  }
  if (!Array.isArray(snapshot.addedOwnedWeaponIds)) {
    return fail('added_owned_weapon_ids_not_array', 'undoSnapshot.addedOwnedWeaponIds is not an array.')
  }
  const invalidField = invalidUndoSnapshotField(snapshot)
  if (invalidField !== null) {
    return fail('undo_snapshot_field_invalid', `undoSnapshot.${invalidField} is missing or has the wrong structure.`)
  }
  let created: ProductionPlanUndoStateAgainstReference
  try {
    created = createProductionPlanUndoStateAgainstReference(before, reference)
  } catch (error) {
    // Only a value without a persisted JSON form is an unconvertible record;
    // anything else is unexpected and propagates.
    if (error instanceof PersistedJsonNormalizationError) {
      return fail('unhashable_value', `productionPlanBefore cannot be hashed: ${error.message}`)
    }
    throw error
  }
  if (created.kind === 'step_ids_mismatch') {
    return fail('step_ids_mismatch', 'the reference Plan does not hold the PlanStep IDs of productionPlanBefore in the same order.')
  }
  const deletedExecutionSavePoint = isLastRecord && causedTerminalTransition(currentPlan, record, before)
    ? structuredClone(snapshot.executionSavePointBefore)
    : null
  const executionHistory = {
    ...copyPresent(record, METADATA_FIELDS),
    addedOwnedWeaponIds: structuredClone(snapshot.addedOwnedWeaponIds),
  } as unknown as ExecutionHistory
  const executionUndoSnapshot = {
    executionHistoryId: key.id,
    ...copyPresent(snapshot, MOVED_UNDO_SNAPSHOT_FIELDS),
    productionPlanStateBefore: created.state,
    deletedExecutionSavePoint,
  } as unknown as ExecutionUndoSnapshot
  // Only a record of the 12.2 shape converts: anything else stays as it is,
  // so no record is half converted into a shape nothing can read.
  // A version 10 / Export schema 13 record carries Target bodies of the shape
  // they were written in - the legacy one, converted by the next migration step
  // (`docs/DATA_MODEL.md` 14.2) - so each body is validated by the rule of its
  // own shape. This conversion is about the history records only and never
  // reads or changes what a Target means.
  const validation = validateExecutionRecord(executionHistory, executionUndoSnapshot, {
    validateTargetBody: (target) =>
      hasLegacyTargetWeaponField(target as unknown as Record<string, unknown>)
        ? validateLegacyTargetWeapon(target as unknown as LegacyTargetWeapon)
        : validateTargetWeapon(target),
  })
  if (!validation.isValid) {
    return {
      result: unconvertible(key, 'converted_record_invalid', 'the converted record fails the 12.2 validation.', validation.issues),
      nextReference,
    }
  }
  return { result: { kind: 'converted', executionHistory, executionUndoSnapshot }, nextReference }
}

/**
 * Converts the records of one Plan, one record at a time, from the Plan's last
 * record to its first (`docs/DATA_MODEL.md` 14.2): call `convertPrevious()`
 * once per record in reverse `compareExecutionHistoryOrder()` order, each
 * record read only for its own call. It keeps only the Plan as it is now and
 * the Step completion of the last record it converted, never a record.
 */
export interface ExecutionHistoryPlanConversion {
  convertPrevious(key: ExecutionHistoryOrderKey, record: unknown): ExecutionHistoryRecordConversion
}

/**
 * Starts the conversion of the records of Plan `planId`. `currentPlan` is the
 * Plan as it is now (`undefined` or `null` when it does not exist, which makes
 * every one of its records unconvertible); it is the reference Plan of the last
 * record and the Plan the last record's terminal transition is judged against.
 *
 * Each record's reference Plan is the `productionPlanBefore` of the nearest
 * later record holding one, or the current Plan for the last record; its
 * `changedSteps` are the Steps whose completion differs from that reference,
 * with the record's own before values. A record converts to exactly the same
 * result whether the Dexie upgrade or the Export migration gathered it.
 *
 * Calling it with another Plan's key, or out of reverse order, is a caller
 * error and throws.
 */
export function startExecutionHistoryPlanConversion(
  planId: ProductionPlanId,
  currentPlan: unknown,
): ExecutionHistoryPlanConversion {
  let reference: ProductionPlanStepCompletionProjection | null =
    currentPlan === undefined || currentPlan === null ? null : projectProductionPlanStepCompletion(currentPlan)
  let laterKey: ExecutionHistoryOrderKey | null = null
  return {
    convertPrevious(key, record) {
      if (key.planId !== planId) {
        throw new Error(`ExecutionHistory '${key.id}' is not a record of ProductionPlan '${planId}'.`)
      }
      if (laterKey !== null && compareExecutionHistoryOrder(key, laterKey) > 0) {
        throw new Error(`ExecutionHistory '${key.id}' is converted after a record it precedes.`)
      }
      const isLastRecord = laterKey === null
      laterKey = key
      const { result, nextReference } = convertRecord({ key, record, currentPlan, reference, isLastRecord })
      if (nextReference !== undefined) reference = nextReference
      return result
    },
  }
}

/**
 * Converts a whole in-memory record collection (the Export schema 13 -> 14
 * migration) through exactly the order and per-Plan conversion the Dexie
 * upgrade uses. `productionPlans` are the Plans as they are now; a record whose
 * Plan is not exactly one of them is unconvertible. Returns one result per
 * record, in the input order.
 */
export function convertExecutionHistoryCollection(
  records: readonly unknown[],
  productionPlans: readonly unknown[],
): ExecutionHistoryRecordConversion[] {
  const plansById = new Map<string, unknown[]>()
  productionPlans.forEach((plan) => {
    if (!isObjectRecord(plan) || typeof plan.id !== 'string') return
    const plans = plansById.get(plan.id)
    if (plans) plans.push(plan)
    else plansById.set(plan.id, [plan])
  })
  const candidates = records.map((record, index) => {
    const value = isObjectRecord(record) ? record : {}
    return { index, id: value.id, planId: value.planId, createdAt: value.createdAt }
  })
  const results: ExecutionHistoryRecordConversion[] = new Array(records.length)
  const ordered = orderExecutionHistoryKeys(candidates)
  ordered.unordered.forEach((candidate) => {
    results[candidate.index] = unorderedExecutionHistoryRecord(candidate)
  })
  ordered.plans.forEach(({ planId, records: planRecords }) => {
    const plans = plansById.get(planId)
    const conversion = startExecutionHistoryPlanConversion(planId, plans?.length === 1 ? plans[0] : undefined)
    for (let index = planRecords.length - 1; index >= 0; index -= 1) {
      const { index: recordIndex, id, planId: recordPlanId, createdAt } = planRecords[index]
      results[recordIndex] = conversion.convertPrevious({ id, planId: recordPlanId, createdAt }, records[recordIndex])
    }
  })
  return results
}
