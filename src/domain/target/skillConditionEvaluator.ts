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

  // Every specified Skill must match (`all`, `docs/DATA_MODEL.md` 8.4); none
  // specified constrains nothing.
  return matches.every(Boolean)
}
