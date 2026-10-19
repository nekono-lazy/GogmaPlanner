import { stableStringify } from '../models/publicTypes'
import type { EvaluatedBonusSolution, EvaluatedSkillSolution } from './streamSolutions'

interface AxisState {
  bonusAnchor: EvaluatedBonusSolution | null
  skillAnchor: EvaluatedSkillSolution | null
  waitingBonuses: EvaluatedBonusSolution[]
  waitingSkills: EvaluatedSkillSolution[]
}

/**
 * B3 Cross delivered incrementally for one Route base. Complete sorted depths
 * arrive in ascending advance order, so anchors never move. A waiting axis is
 * drained once when its opposite anchor first arrives. Afterwards only the new
 * entry is paired with the opposite anchor. No old pair or off-axis product is
 * traversed.
 *
 * There is one axis, the Ideal one: a composed result is always an Ideal
 * Candidate, and compromise states are offered only as checkpoints on the
 * canonical Ideal Route (`docs/SEARCH_SPEC.md` 5.5.4).
 */
export function createDeltaCross(
  emit: (bonus: EvaluatedBonusSolution, skill: EvaluatedSkillSolution) => void,
) {
  const axis: AxisState = { bonusAnchor: null, skillAnchor: null, waitingBonuses: [], waitingSkills: [] }
  const bonusSeen = new Set<string>()
  const skillSeen = new Set<string>()
  const pairs = new Set<string>()
  function publish(bonus: EvaluatedBonusSolution, skill: EvaluatedSkillSolution) {
    const key = stableStringify([bonus.retentionKey, skill.semanticKey])
    if (pairs.has(key)) return
    pairs.add(key)
    emit(bonus, skill)
  }
  return {
    addBonus(bonus: EvaluatedBonusSolution): void {
      if (bonusSeen.has(bonus.retentionKey)) return
      bonusSeen.add(bonus.retentionKey)
      if (!bonus.idealMatch) return
      const first = axis.bonusAnchor === null
      axis.bonusAnchor ??= bonus
      if (!axis.skillAnchor) axis.waitingBonuses.push(bonus)
      else if (first) {
        for (const skill of axis.waitingSkills) publish(bonus, skill)
        axis.waitingSkills = []
      } else publish(bonus, axis.skillAnchor)
    },
    addSkill(skill: EvaluatedSkillSolution): void {
      if (skillSeen.has(skill.semanticKey)) return
      skillSeen.add(skill.semanticKey)
      if (!skill.idealMatch) return
      const first = axis.skillAnchor === null
      axis.skillAnchor ??= skill
      if (!axis.bonusAnchor) axis.waitingSkills.push(skill)
      else if (first) {
        for (const bonus of axis.waitingBonuses) publish(bonus, skill)
        axis.waitingBonuses = []
      } else publish(axis.bonusAnchor, skill)
    },
  }
}
