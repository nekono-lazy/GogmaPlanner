import type {
  GroupSkillId,
  SeriesSkillId,
} from '../../models/publicTypes'

/**
 * Reference-verified against GARP.lua v0.9.4 `artian_set_table_order` from
 * WiseHorror/Gogma-Artian-Roll-Planner
 * @ eceb2bd9ca6f4897ec516387acab2ad6beb8b38b.
 *
 * These semantic IDs deliberately do not follow Master display order.
 */
export const REFERENCE_SERIES_SKILL_POOL: readonly SeriesSkillId[] = [
  'series_skill.verified_01',
  'series_skill.verified_02',
  'series_skill.verified_11',
  'series_skill.verified_09',
  'series_skill.verified_08',
  'series_skill.verified_03',
  'series_skill.verified_07',
  'series_skill.verified_05',
  'series_skill.verified_06',
  'series_skill.verified_12',
  'series_skill.verified_10',
  'series_skill.gore_magala',
  'series_skill.verified_14',
  'series_skill.verified_04',
  'series_skill.verified_15',
  'series_skill.verified_16',
  'series_skill.verified_19',
  'series_skill.verified_18',
  'series_skill.verified_24',
  'series_skill.verified_21',
  'series_skill.verified_22',
]

/**
 * Reference-verified against the same GARP.lua
 * `artian_group_table_order`. The current Master's two additional enabled IDs
 * are intentionally excluded.
 */
export const REFERENCE_GROUP_SKILL_POOL: readonly GroupSkillId[] = [
  'group_skill.verified_04',
  'group_skill.verified_07',
  'group_skill.verified_02',
  'group_skill.verified_08',
  'group_skill.verified_01',
  'group_skill.verified_09',
  'group_skill.verified_03',
  'group_skill.verified_10',
  'group_skill.verified_06',
  'group_skill.verified_12',
  'group_skill.verified_05',
  'group_skill.verified_11',
  'group_skill.verified_13',
  'group_skill.apex',
]

export const REFERENCE_SKILL_COMBINATION_COUNT =
  REFERENCE_SERIES_SKILL_POOL.length * REFERENCE_GROUP_SKILL_POOL.length

export interface ReferenceSkillCombination {
  readonly combinationIndex: number
  readonly seriesSkillId: SeriesSkillId
  readonly groupSkillId: GroupSkillId
}

function requireCombinationIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= REFERENCE_SKILL_COMBINATION_COUNT) {
    throw new RangeError(
      `Reference Skill combination index must be a safe integer from 0 to ${REFERENCE_SKILL_COMBINATION_COUNT - 1}`,
    )
  }
}

/** Converts a reference-only 0..293 combination index to semantic Domain IDs. */
export function referenceSkillCombinationFromIndex(index: number): ReferenceSkillCombination {
  requireCombinationIndex(index)
  const groupCount = REFERENCE_GROUP_SKILL_POOL.length
  const seriesSkillId = REFERENCE_SERIES_SKILL_POOL[Math.floor(index / groupCount)]
  const groupSkillId = REFERENCE_GROUP_SKILL_POOL[index % groupCount]

  if (seriesSkillId === undefined || groupSkillId === undefined) {
    throw new Error(`Reference Skill pool mapping is incomplete for index ${index}`)
  }

  return { combinationIndex: index, seriesSkillId, groupSkillId }
}

/** Converts one complete semantic Skill observation back to its reference table index. */
export function referenceSkillCombinationIndexFromIds(
  seriesSkillId: SeriesSkillId,
  groupSkillId: GroupSkillId,
): number {
  const seriesIndex = REFERENCE_SERIES_SKILL_POOL.indexOf(seriesSkillId)
  const groupIndex = REFERENCE_GROUP_SKILL_POOL.indexOf(groupSkillId)
  if (seriesIndex < 0 || groupIndex < 0) {
    throw new RangeError('Skill observation is outside the Production reference table')
  }
  return seriesIndex * REFERENCE_GROUP_SKILL_POOL.length + groupIndex
}
