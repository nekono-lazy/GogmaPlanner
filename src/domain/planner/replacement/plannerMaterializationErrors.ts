/**
 * Failure modes of the shared deterministic materializer
 * (`createDeterministicMaterializer()`) and of resolving a Target from a
 * Planner-start Search origin.
 *
 * Phase 6-B2a moved this module from the legacy B8-C2 materializer without
 * changing its runtime contract, and Phase 6-B2b removed the legacy import path
 * that re-exported it: the one constructor is still
 * `ConstrainedMaterializationError`, so a thrown error keeps its `instanceof`,
 * its `name` / `constructor.name` (`'ConstrainedMaterializationError'`), its
 * `code` and its message. `PlannerMaterializationError` is the neutral alias of
 * that very constructor, never a second class.
 *
 * Every failure fails closed: no partially built Candidate, no fallback to a
 * random ID, and no overwrite of an existing BuildListEntry. The caller reads
 * `code`, never the message text.
 */
export type ConstrainedMaterializationErrorCode =
  /** The Target is missing from the origin, or the Candidate names another one. */
  | 'target_mismatch'
  /** The materialized `BuildCandidate` failed `validateBuildCandidate()`. */
  | 'invalid_candidate'
  /**
   * An existing BuildListEntry already holds the deterministic generated ID
   * while carrying different current semantic content. It is kept as history
   * and never overwritten, and no substitute ID is invented.
   */
  | 'generated_entry_id_collision'

export class ConstrainedMaterializationError extends Error {
  readonly code: ConstrainedMaterializationErrorCode

  constructor(code: ConstrainedMaterializationErrorCode, message: string) {
    super(message)
    this.name = 'ConstrainedMaterializationError'
    this.code = code
  }
}

/** The neutral name of `ConstrainedMaterializationErrorCode`; the same type. */
export type PlannerMaterializationErrorCode = ConstrainedMaterializationErrorCode

/**
 * The neutral name of `ConstrainedMaterializationError`: the same constructor,
 * so `instanceof` holds under either name and `name` stays
 * `'ConstrainedMaterializationError'`.
 */
export { ConstrainedMaterializationError as PlannerMaterializationError }
