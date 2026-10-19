/**
 * Execution-only runtime section boundaries of one Planner Alternative Search
 * (Issue #154 Phase 2-C2.6-A4 outer runtime localization,
 * `docs/SEARCH_SPEC.md` 5.6.8).
 *
 * A section is a named, directly bounded stretch of the Search's own execution.
 * Sections nest in one fixed hierarchy (`SEARCH_RUNTIME_SECTION_PARENT`): a
 * section starts only while its registered parent is the innermost open
 * section, and completes before its parent does. One Search is one strictly
 * nested sequence, so a consumer can derive an inclusive time per section and
 * an exclusive time (inclusive minus its children) without double counting.
 *
 * Nothing here reads a clock or carries a timestamp: the Search only reports
 * the boundaries, synchronously, and the observer stamps them itself.
 */

/** Every section, parents before their children. */
export const SEARCH_RUNTIME_SECTIONS = [
  // Search root: `visitPlannerAlternativeCandidates()` from entry to return.
  'search_runtime',
  // Execution context, prediction support, reservations, streams, scheduler.
  'search_setup',
  // The three Route search primitives registering their Route bases.
  'route_registration',
  'normal_route_registration',
  'owned_normal_route_registration',
  'existing_gogma_route_registration',
  // One `TargetSearchScheduler.step()`.
  'scheduler_step',
  'scheduler_checkpoint',
  'scheduler_settle',
  'scheduler_post_settle',
  // Scheduler-owned work items, settled inside `scheduler_settle`.
  'bonus_depth_work',
  'bonus_depth_read',
  'bonus_notice_scan',
  'bonus_ideal_filter',
  'bonus_route_materialization',
  'bonus_evaluate_sort',
  'bonus_channel_publication',
  'cross_add_bonus',
  'bonus_depth_advance',
  'skill_depth_work',
  'skill_depth_read',
  'skill_ideal_filter',
  'skill_route_materialization',
  'skill_evaluate_sort',
  'skill_channel_publication',
  'cross_add_skill',
  'skill_depth_advance',
  'composition_work',
  'composition_checkpoint',
  'compose_route',
  'composition_consumer',
  'cross_open_next',
  'cross_wake_work',
  'cross_wake',
  // One flush of the buffered equal-cost Candidates to the consumer.
  'delivery_flush',
  'delivery_sort',
  'delivery_checkpoint',
  'delivery_key_dedup',
  'delivery_consumer',
] as const
export type SearchRuntimeSection = typeof SEARCH_RUNTIME_SECTIONS[number]

/** The one registered parent of each section (`null` for the Search root). */
export const SEARCH_RUNTIME_SECTION_PARENT: Readonly<Record<SearchRuntimeSection, SearchRuntimeSection | null>> = {
  search_runtime: null,
  search_setup: 'search_runtime',
  route_registration: 'search_runtime',
  normal_route_registration: 'route_registration',
  owned_normal_route_registration: 'route_registration',
  existing_gogma_route_registration: 'route_registration',
  scheduler_step: 'search_runtime',
  scheduler_checkpoint: 'scheduler_step',
  scheduler_settle: 'scheduler_step',
  scheduler_post_settle: 'scheduler_step',
  bonus_depth_work: 'scheduler_settle',
  bonus_depth_read: 'bonus_depth_work',
  bonus_notice_scan: 'bonus_depth_work',
  bonus_ideal_filter: 'bonus_depth_work',
  bonus_route_materialization: 'bonus_depth_work',
  bonus_evaluate_sort: 'bonus_depth_work',
  bonus_channel_publication: 'bonus_depth_work',
  cross_add_bonus: 'bonus_channel_publication',
  bonus_depth_advance: 'bonus_depth_work',
  skill_depth_work: 'scheduler_settle',
  skill_depth_read: 'skill_depth_work',
  skill_ideal_filter: 'skill_depth_work',
  skill_route_materialization: 'skill_depth_work',
  skill_evaluate_sort: 'skill_depth_work',
  skill_channel_publication: 'skill_depth_work',
  cross_add_skill: 'skill_channel_publication',
  skill_depth_advance: 'skill_depth_work',
  composition_work: 'scheduler_settle',
  composition_checkpoint: 'composition_work',
  compose_route: 'composition_work',
  composition_consumer: 'composition_work',
  cross_open_next: 'composition_work',
  cross_wake_work: 'scheduler_settle',
  cross_wake: 'cross_wake_work',
  delivery_flush: 'search_runtime',
  delivery_sort: 'delivery_flush',
  delivery_checkpoint: 'delivery_flush',
  delivery_key_dedup: 'delivery_flush',
  delivery_consumer: 'delivery_flush',
}

/** Which stream depth a `bonus_depth_work` / `skill_depth_work` reads. */
export interface SearchRuntimeDepthWork {
  /** 0-based creation order of the channel among the scheduler's channels of that stream. */
  channel: number
  /** The own amendment / reset count of the depth. */
  depth: number
}

/**
 * Sizes a completed stream depth work already holds; nothing is scanned to
 * produce them. Present only on the `section_completed` of a
 * `bonus_depth_work` / `skill_depth_work` read held-aware (Planner Alternative
 * policy).
 */
export interface SearchRuntimeDepthCounts {
  /** Every absolute-position solution the stream returned for the depth. */
  rawSolutions: number
  /** Unsupported amendment predictions the stream reported (Bonus only; 0 for Skill). */
  unsupportedPredictions: number
  /** Solutions satisfying the Ideal authority. */
  idealSolutions: number
  /** Evaluated solutions appended to the channel and published. */
  evaluatedSolutions: number
  /** Subscribers (Route base Crosses) each evaluated solution was published to. */
  subscriberCount: number
  /** Channel retained size after the publication. */
  retainedCountAfter: number
  /** The stream reported the depth exhausted. */
  exhausted: boolean
}

/** One section boundary. It carries no timestamp and no Search state. */
export type SearchRuntimeEvent =
  | { type: 'section_started'; section: SearchRuntimeSection; work?: SearchRuntimeDepthWork }
  | { type: 'section_completed'; section: SearchRuntimeSection; counts?: SearchRuntimeDepthCounts }

/**
 * Execution-only observer of the section boundaries. Called synchronously at
 * each boundary, never awaited, its return value never read; it changes no
 * prediction, Candidate, order or termination and is absent in every
 * Production call. A section interrupted by an exception (cancellation)
 * reports no completion, and nothing after it is reported.
 */
export type SearchRuntimeObserver = (event: SearchRuntimeEvent) => void
