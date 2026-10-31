/**
 * The value a persisted body stands for once it is written as JSON
 * (`docs/DATA_MODEL.md` 12.2): null, booleans, finite numbers, strings, arrays
 * and plain objects only.
 */
export type PersistedJsonValue =
  | null
  | boolean
  | number
  | string
  | PersistedJsonValue[]
  | PersistedJsonObject

export interface PersistedJsonObject {
  [key: string]: PersistedJsonValue
}

/**
 * Why a value has no persisted JSON equivalent. A failure is never repaired:
 * the value is never converted into `null` or another value.
 */
export type PersistedJsonNormalizationFailure =
  /** `undefined` as an array element (an array hole included) or as the whole value. */
  | 'undefined_value'
  /** A function, symbol or bigint. */
  | 'unsupported_type'
  | 'non_finite_number'
  /** An object other than an array or a plain object (Date, Map, a class instance, ...). */
  | 'non_plain_object'
  | 'cyclic_value'
  /**
   * The value is persisted JSON but not a ProductionPlan body the Plan hashes
   * can project: not a plain object, or `steps` is not an array of plain
   * objects (`createProductionPlanUndoHashes()`).
   */
  | 'invalid_plan_shape'

export class PersistedJsonNormalizationError extends Error {
  readonly failure: PersistedJsonNormalizationFailure
  /** Where the failure is, such as `steps[3].completedAt`; empty for the whole value. */
  readonly path: string

  constructor(failure: PersistedJsonNormalizationFailure, path: string, message: string) {
    super(path ? `${message} (at ${path})` : message)
    this.name = 'PersistedJsonNormalizationError'
    this.failure = failure
    this.path = path
  }
}

type PathSegment = string | number

function formatPath(path: readonly PathSegment[]): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`)
    .join('')
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeValue(
  value: unknown,
  path: PathSegment[],
  ancestors: WeakSet<object>,
): PersistedJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PersistedJsonNormalizationError('non_finite_number', formatPath(path), 'Only finite numbers are persisted JSON.')
    }
    return value
  }
  if (value === undefined) {
    throw new PersistedJsonNormalizationError('undefined_value', formatPath(path), 'undefined is persisted JSON only as an absent object property.')
  }
  if (typeof value !== 'object') {
    throw new PersistedJsonNormalizationError('unsupported_type', formatPath(path), `A ${typeof value} is not persisted JSON.`)
  }
  if (ancestors.has(value)) {
    throw new PersistedJsonNormalizationError('cyclic_value', formatPath(path), 'A cyclic value is not persisted JSON.')
  }
  ancestors.add(value)
  let normalized: PersistedJsonValue
  if (Array.isArray(value)) {
    const elements: PersistedJsonValue[] = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      path.push(index)
      // A hole reads as undefined; JSON would write it as null, which is exactly
      // the silent conversion this normalization refuses.
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new PersistedJsonNormalizationError('undefined_value', formatPath(path), 'An array hole is not persisted JSON.')
      }
      elements[index] = normalizeValue(value[index], path, ancestors)
      path.pop()
    }
    normalized = elements
  } else {
    if (!isPlainObject(value)) {
      throw new PersistedJsonNormalizationError('non_plain_object', formatPath(path), 'Only plain objects are persisted JSON.')
    }
    const record = value as Record<string, unknown>
    const object: PersistedJsonObject = {}
    for (const key of Object.keys(record)) {
      const property = record[key]
      // IndexedDB keeps an undefined-valued property; JSON drops it. Both stand
      // for the same persisted value, so it is left out.
      if (property === undefined) continue
      path.push(key)
      object[key] = normalizeValue(property, path, ancestors)
      path.pop()
    }
    normalized = object
  }
  ancestors.delete(value)
  return normalized
}

/**
 * The one normalization of a persisted body into the value its JSON stands for
 * (`docs/DATA_MODEL.md` 12.2). It returns a new value and never changes the
 * input:
 *
 * - an object property whose value is `undefined` is left out, so a body read
 *   back from IndexedDB and the same body read from an Export normalize alike
 * - `undefined` in an array (a hole included), a function, a symbol, a bigint,
 *   a non-finite number, an object that is neither an array nor a plain object
 *   and a cyclic value throw `PersistedJsonNormalizationError` instead of being
 *   converted, unlike `JSON.stringify`
 *
 * Any other exception (a throwing getter, for instance) propagates unchanged:
 * it is not a normalization failure.
 */
export function normalizePersistedJsonValue(value: unknown): PersistedJsonValue {
  return normalizeValue(value, [], new WeakSet<object>())
}

/** Whether a normalized value is a JSON object (neither null nor an array). */
export function isPersistedJsonObject(value: PersistedJsonValue | undefined): value is PersistedJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Exact equality of two normalized values, independent of object key order.
 * `undefined` stands for an absent property and equals only `undefined`.
 */
export function persistedJsonValuesEqual(
  left: PersistedJsonValue | undefined,
  right: PersistedJsonValue | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left === null || right === null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((element, index) => persistedJsonValuesEqual(element, right[index]))
  }
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && persistedJsonValuesEqual(left[key], right[key]))
}
