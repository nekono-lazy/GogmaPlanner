/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage B (moved from the Global Assignment Research
 * Phase B-1, Issue #154).
 *
 * The resource conditions of the assignment problem (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 6.1):
 * C1 source exclusivity through `sourceResourceKey()` (one OwnedWeapon, or one production-target forge
 * position of one Normal Counter, for at most one Target) and C2 required Counter position exclusivity
 * per stream (Skill, Gogma, and each Normal Counter as its own stream: the same numeric position of two
 * weapon types' Counters is not one resource). Only required positions are occupied; the skippable
 * chain units between them (design 5.2 / 7) are never resources here, and no held / blocked / sharing
 * semantics is re-implemented - Phase D derives those from real Entries.
 *
 * This module reads no lower bound and makes no pruning decision (design 6.4 / 10.1, review R1): it is
 * the first link of the one-way chain `resourceFeasibleOptions -> LB -> pruning`.
 */
import type { PartialResourceAssignment, RequiredPositions, ResourceViolationKind } from './assignmentTypes'
import { sourceResourceKey } from './reachOptions'
import { BuildListOptimizationInvariantError, type ReachOption, type ReachTable, type StreamEnd } from './buildListOptimizationTypes'

function fail(message: string): never {
  throw new BuildListOptimizationInvariantError('requirement_inconsistent', message)
}

/** The required positions of one option (design 6.1 C2); an option contradicting its own source fails closed. */
export function requiredPositionsOf(option: ReachOption): RequiredPositions {
  const skill: number[] = []
  const skillRequired = option.skillRequired
  if (skillRequired.kind === 'reset_skills') skill.push(skillRequired.finalPosition)
  else if (skillRequired.kind === 'conversion') {
    if (skillRequired.conversionPosition > skillRequired.finalPosition) {
      fail(`Option ${option.targetWeaponId}: conversion position ${skillRequired.conversionPosition} is after its final Skill position ${skillRequired.finalPosition}.`)
    }
    skill.push(skillRequired.conversionPosition)
    // `c = s*`: the conversion Skill itself is Ideal - one required Skill position, never two.
    if (skillRequired.conversionPosition !== skillRequired.finalPosition) skill.push(skillRequired.finalPosition)
  }
  const gogma: number[] = []
  const bonusRequired = option.bonusRequired
  if (bonusRequired.kind === 'reset' || bonusRequired.kind === 'keep_from_source') gogma.push(bonusRequired.finalPosition)
  else if (bonusRequired.kind === 'reset_then_keep') {
    if (bonusRequired.resetPosition >= bonusRequired.finalPosition) {
      fail(`Option ${option.targetWeaponId}: reset_then_keep needs its Reset ${bonusRequired.resetPosition} strictly before its Keep ${bonusRequired.finalPosition}.`)
    }
    gogma.push(bonusRequired.resetPosition, bonusRequired.finalPosition)
  }
  if (option.source.kind === 'new_normal') {
    const normal = option.normalRequired
    if (!normal || normal.counterId !== option.source.counterId || normal.position !== option.source.position) {
      fail(`Option ${option.targetWeaponId}: a new_normal source must carry its own forge as normalRequired.`)
    }
    return { skill, gogma, normal: { counterId: normal.counterId, position: normal.position } }
  }
  if (option.normalRequired !== null) fail(`Option ${option.targetWeaponId}: an owned source has no required Normal position.`)
  return { skill, gogma, normal: null }
}

/** The empty partial assignment of a table: nothing used, every stream at its origin, one Normal position set per Counter (ID order). */
export function createEmptyPartialAssignment(table: ReachTable): PartialResourceAssignment {
  const counterIds = Object.keys(table.originNormal).sort()
  return {
    chosen: new Map(),
    usedSources: new Set(),
    usedSkillPositions: new Set(),
    usedGogmaPositions: new Set(),
    usedNormalPositions: new Map(counterIds.map(counterId => [counterId, new Set<number>()])),
    streamEnd: { skill: table.originSkill, gogma: table.originGogma, normal: Object.fromEntries(counterIds.map(counterId => [counterId, table.originNormal[counterId]!])) },
  }
}

/**
 * The first resource condition `option` violates against `partial`, or null when it is resource-feasible
 * (design 6.4 `resourceFeasibleOptions`). Reads resources only: no lower bound, no window check (every
 * table option lies inside the scanned window by construction).
 */
export function findResourceViolation(option: ReachOption, partial: PartialResourceAssignment): ResourceViolationKind | null {
  if (partial.usedSources.has(sourceResourceKey(option.source))) return 'source'
  const required = requiredPositionsOf(option)
  for (const position of required.skill) if (partial.usedSkillPositions.has(position)) return 'skill_position'
  for (const position of required.gogma) if (partial.usedGogmaPositions.has(position)) return 'gogma_position'
  if (required.normal) {
    const used = partial.usedNormalPositions.get(required.normal.counterId)
    if (!used) fail(`Option ${option.targetWeaponId} names Normal Counter ${required.normal.counterId}, which the table does not hold.`)
    if (used.has(required.normal.position)) return 'normal_position'
  }
  return null
}

/** Σ_streams max(0, option.streamEnd − partial.streamEnd): how far the option would push the assignment's stream ends (design 6.3 value order key 1). */
export function streamEndDelta(option: ReachOption, partial: PartialResourceAssignment): number {
  let delta = Math.max(0, option.streamEnd.skill - partial.streamEnd.skill) + Math.max(0, option.streamEnd.gogma - partial.streamEnd.gogma)
  for (const [counterId, end] of Object.entries(option.streamEnd.normal)) {
    const current = partial.streamEnd.normal[counterId]
    if (current === undefined) fail(`Option ${option.targetWeaponId} ends Normal Counter ${counterId}, which the table does not hold.`)
    delta += Math.max(0, end - current)
  }
  return delta
}

/** A new partial assignment with `option` added. The option must be resource-feasible and its Target unassigned; both fail closed. */
export function applyReachOption(partial: PartialResourceAssignment, option: ReachOption): PartialResourceAssignment {
  if (partial.chosen.has(option.targetWeaponId)) fail(`Target ${option.targetWeaponId} is already assigned.`)
  const violation = findResourceViolation(option, partial)
  if (violation) fail(`Option ${option.targetWeaponId} violates ${violation} against the partial assignment.`)
  const required = requiredPositionsOf(option)
  const chosen = new Map(partial.chosen)
  chosen.set(option.targetWeaponId, option)
  const usedSources = new Set(partial.usedSources)
  usedSources.add(sourceResourceKey(option.source))
  const usedSkillPositions = new Set(partial.usedSkillPositions)
  for (const position of required.skill) usedSkillPositions.add(position)
  const usedGogmaPositions = new Set(partial.usedGogmaPositions)
  for (const position of required.gogma) usedGogmaPositions.add(position)
  const usedNormalPositions = new Map([...partial.usedNormalPositions].map(([counterId, positions]) => [counterId, new Set(positions)]))
  if (required.normal) usedNormalPositions.get(required.normal.counterId)!.add(required.normal.position)
  const normal: StreamEnd['normal'] = { ...partial.streamEnd.normal }
  for (const [counterId, end] of Object.entries(option.streamEnd.normal)) normal[counterId] = Math.max(normal[counterId]!, end)
  return {
    chosen, usedSources, usedSkillPositions, usedGogmaPositions, usedNormalPositions,
    streamEnd: { skill: Math.max(partial.streamEnd.skill, option.streamEnd.skill), gogma: Math.max(partial.streamEnd.gogma, option.streamEnd.gogma), normal },
  }
}

/** Σ_streams (streamEnd − origin) over the Skill stream, the Gogma stream and every Normal Counter of the table (design 6.1 objective). */
export function streamEndObjective(streamEnd: StreamEnd, table: ReachTable): number {
  let total = (streamEnd.skill - table.originSkill) + (streamEnd.gogma - table.originGogma)
  for (const [counterId, origin] of Object.entries(table.originNormal)) total += (streamEnd.normal[counterId] ?? origin) - origin
  return total
}
