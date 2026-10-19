/**
 * Dexie schema 1 -> 2 and future legacy-import boundary.
 * Old OR groups lack a source type. Never reinterpret old conditions as new.
 * Historical calculation artifacts are intentionally outside this migration.
 */
export function migrateLegacyTargetCompromise(
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  const migrated = { ...legacy }
  delete migrated.practicalAlternativeGroups
  migrated.practicalBonusConditions = []
  migrated.alternativeBonusRules = []
  migrated.practicalSkillCondition = {
    seriesSkillId: null, groupSkillId: null, matchMode: 'all',
  }
  migrated.compromiseNeedsReview = true
  return migrated
}
