import type {
  GroupSkillId,
  SeriesSkillId,
  SkillCondition,
} from '../models/publicTypes'

export function evaluateSkillCondition(
  condition: SkillCondition,
  seriesSkillId: SeriesSkillId | null,
  groupSkillId: GroupSkillId | null,
): boolean {
  const matches: boolean[] = []
  if (condition.seriesSkillId !== null) {
    matches.push(condition.seriesSkillId === seriesSkillId)
  }
  if (condition.groupSkillId !== null) {
    matches.push(condition.groupSkillId === groupSkillId)
  }

  if (matches.length === 0) return true
  return condition.matchMode === 'all'
    ? matches.every(Boolean)
    : matches.some(Boolean)
}
