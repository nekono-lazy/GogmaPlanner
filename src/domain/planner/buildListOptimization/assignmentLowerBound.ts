/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B (moved from the Global Assignment Research
 * Phase B-1, Issue #154).
 *
 * The admissible lower bound of a partial assignment (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 10.1):
 *
 *   LB(partial) = Σ_streams ( max(currentEnd_stream, floor_stream(unassigned)) − origin_stream )
 *   floor_stream(unassigned) = max over unassigned Targets t of minStreamEnd_stream(t, partial)
 *
 * `minStreamEnd` is a safe relaxation of "the minimum stream end over the resource-feasible options of
 * t": per stream it reads the Target's ascending position arrays from the ReachTable and takes the first
 * required candidate position the partial assignment has not used, through an unused source, ignoring
 * the other streams of the same option, the Reset position a `reset_then_keep` also needs, the window
 * limit distinctions beyond those the source kind already fixes, and whether the option exists on the
 * other axes. Every relaxation can only lower the value, so no completion of the partial assignment has
 * a smaller objective. `+Infinity` means an unassigned Target has no resource-feasible option on that
 * stream at all - then no completion exists and any bound is admissible.
 *
 * The `reset_then_keep` finals come from the compact `ResetThenKeepIndex` (the Keep positions at least
 * one earlier eligible Reset reaches), so the Reset / Keep position arrays and the layouts are read and
 * no `(g1, g*)` pair is ever built.
 *
 * A lane that admits `none` (`sourceLaneAdmission()`: an owned Gogma's current-Ideal lane, without continuation alone
 * and with continuation before its operations) ends at the stream origin, the smallest end any option can have, so its
 * operations' finals are never read: the continuations add options but never lower a minimal end, and the
 * bound is the same function of the partial assignment for a table with or without continuation (audit 5.4 corollary 2).
 *
 * The option product is never materialized here. This module reads the partial assignment's resources
 * only; it never enumerates options, never calls the feasibility filter and never cuts a branch itself
 * (review R1: `resourceFeasibleOptions -> LB -> pruning`, one direction). It is not the root lower bound
 * of the Research relaxation module (design 10.2), which no Stage integrates (no minimality is claimed).
 */
import type { PartialResourceAssignment } from './assignmentTypes'
import {
  createResetThenKeepIndex, keepFromSourcePositions, laneAdmitsNone, skillRequirementBlocks, sourceLaneAdmission, sourceResourceKey, type ResetThenKeepIndex,
} from './reachOptions'
import type { NormalArtianCounterId, ReachTable, SourceCandidate, TargetReach } from './buildListOptimizationTypes'

export interface TargetStreamMenuSource {
  source: SourceCandidate
  key: string
  /** Whether `none` is one of its Skill requirements (then its minimal Skill end is the origin and `skillFinals` is not read). */
  skillNone: boolean
  /** Ascending final Skill positions of its Skill operations (empty when its Skill lane admits `none` only). */
  skillFinals: readonly number[]
  /** Ascending `keep_from_source` final positions (empty when Keep is unsupported for its layout). */
  keepFinals: readonly number[]
  /** Whether `none` is one of its Bonus requirements (then its minimal Gogma end is the origin and no Bonus final is read). */
  bonusNone: boolean
}

/** The per-stream position menus of one Target the lower bound reads (design 6.4 `minStreamEnd`). */
export interface TargetStreamMenu {
  target: TargetReach
  sources: readonly TargetStreamMenuSource[]
  /** Ascending `reset` final positions (Target-level). */
  resetFinals: readonly number[]
  /** Ascending `reset_then_keep` final positions (Target-level, the Reset position relaxed away). */
  resetThenKeepFinals: readonly number[]
}

/** `resetThenKeep` defaults to the Target's own compact index; the solver passes the one it shares with the value-order lattice. */
export function createTargetStreamMenu(target: TargetReach, table: ReachTable, resetThenKeep: ResetThenKeepIndex = createResetThenKeepIndex(target)): TargetStreamMenu {
  // The conversion finals are the same array for every Normal source, so `firstUnused` memoizes across them.
  let conversionFinals: readonly number[] | null = null
  const sources = target.sources.map((source): TargetStreamMenuSource => {
    const blocks = skillRequirementBlocks(target, source, table)
    let skillNone: boolean
    let skillFinals: readonly number[]
    if (blocks.kind === 'none') { skillNone = true; skillFinals = [] }
    else if (blocks.kind === 'reset_skills') { skillNone = blocks.leadingNone; skillFinals = blocks.finalPositions }
    else { skillNone = false; skillFinals = conversionFinals ??= blocks.finalPositions }
    const bonusNone = laneAdmitsNone(sourceLaneAdmission(source, table.continuesCurrentIdealLanes).bonus)
    return { source, key: sourceResourceKey(source), skillNone, skillFinals, keepFinals: keepFromSourcePositions(target, source), bonusNone }
  })
  // The finals that at least one earlier eligible Reset really reaches, ascending: the compact index derives them from the
  // per-layout Reset positions and the Keep-Ideal positions alone, never by enumerating the (g1, g*) pairs.
  return { target, sources, resetFinals: target.bonus.resetIdealPositions, resetThenKeepFinals: resetThenKeep.finalPositions }
}

/** Menus in the table's Target order; `resetThenKeepByTarget` lets the caller share each Target's compact index. */
export function createTargetStreamMenus(table: ReachTable, resetThenKeepByTarget?: ReadonlyMap<TargetReach['targetWeaponId'], ResetThenKeepIndex>): Map<TargetReach['targetWeaponId'], TargetStreamMenu> {
  return new Map(table.targets.map(target => [target.targetWeaponId, createTargetStreamMenu(target, table, resetThenKeepByTarget?.get(target.targetWeaponId))]))
}

export interface MinimalStreamEnds {
  skill: number
  gogma: number
  /** The Target's Normal Counter and its minimal end, or null for a Target without a Normal Counter. */
  normal: { counterId: NormalArtianCounterId; end: number } | null
}

/** The first position of an ascending array not in `used`, or null. */
function firstUnused(positions: readonly number[], used: ReadonlySet<number>): number | null {
  for (const position of positions) if (!used.has(position)) return position
  return null
}

/** The relaxed minimal stream ends of one unassigned Target under `partial` (design 10.1 `minStreamEnd`); `+Infinity` where no option can end. */
export function minimalStreamEnds(menu: TargetStreamMenu, partial: PartialResourceAssignment, table: ReachTable): MinimalStreamEnds {
  let skill = Number.POSITIVE_INFINITY
  let gogma = Number.POSITIVE_INFINITY
  let normal = Number.POSITIVE_INFINITY
  const firstUnusedMemo = new Map<readonly number[], number | null>()
  const first = (positions: readonly number[], used: ReadonlySet<number>): number | null => {
    const memo = firstUnusedMemo.get(positions)
    if (memo !== undefined) return memo
    const value = firstUnused(positions, used)
    firstUnusedMemo.set(positions, value)
    return value
  }
  const counterId = menu.target.normalCounterId
  const usedNormal = counterId === null ? null : partial.usedNormalPositions.get(counterId) ?? null
  for (const entry of menu.sources) {
    if (partial.usedSources.has(entry.key)) continue
    if (entry.skillNone) skill = Math.min(skill, table.originSkill)
    else {
      const position = first(entry.skillFinals, partial.usedSkillPositions)
      if (position !== null) skill = Math.min(skill, position + 1)
    }
    if (entry.bonusNone) gogma = Math.min(gogma, table.originGogma)
    else {
      for (const finals of [menu.resetFinals, entry.keepFinals, menu.resetThenKeepFinals]) {
        const position = first(finals, partial.usedGogmaPositions)
        if (position !== null) gogma = Math.min(gogma, position + 1)
      }
    }
    if (counterId !== null) {
      if (entry.source.kind === 'new_normal') {
        if (!(usedNormal?.has(entry.source.position) ?? false)) normal = Math.min(normal, entry.source.position + 1)
      } else {
        normal = Math.min(normal, table.originNormal[counterId]!)
      }
    }
  }
  return { skill, gogma, normal: counterId === null ? null : { counterId, end: normal } }
}

/**
 * `LB(partial)` over the given unassigned Targets (design 10.1). `+Infinity` when some unassigned Target
 * has no resource-feasible option on some stream (no completion exists). Never calls the option
 * enumeration, the feasibility filter or any pruning.
 */
export function partialAssignmentLowerBound(partial: PartialResourceAssignment, unassigned: readonly TargetStreamMenu[], table: ReachTable): number {
  let floorSkill = table.originSkill
  let floorGogma = table.originGogma
  const floorNormal: Record<NormalArtianCounterId, number> = { ...table.originNormal }
  for (const menu of unassigned) {
    const ends = minimalStreamEnds(menu, partial, table)
    if (!Number.isFinite(ends.skill) || !Number.isFinite(ends.gogma) || (ends.normal !== null && !Number.isFinite(ends.normal.end))) return Number.POSITIVE_INFINITY
    floorSkill = Math.max(floorSkill, ends.skill)
    floorGogma = Math.max(floorGogma, ends.gogma)
    if (ends.normal !== null) floorNormal[ends.normal.counterId] = Math.max(floorNormal[ends.normal.counterId]!, ends.normal.end)
  }
  let bound = (Math.max(partial.streamEnd.skill, floorSkill) - table.originSkill) + (Math.max(partial.streamEnd.gogma, floorGogma) - table.originGogma)
  for (const [counterId, origin] of Object.entries(table.originNormal)) {
    bound += Math.max(partial.streamEnd.normal[counterId] ?? origin, floorNormal[counterId]!) - origin
  }
  return bound
}
