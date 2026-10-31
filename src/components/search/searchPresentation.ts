import type { ArtianBonusScope, MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  RestorationBonus,
  SkillCondition,
} from '../../domain/models/publicTypes'
import { SKILL_CONDITION_ALL_MATCH_LABEL } from '../../presentation/labels'
export {
  getRouteOperationLabel as operationLabel,
  routeKindLabels,
  skippedRouteReasonLabels,
  staleReasonLabels,
} from '../../presentation/labels'

/**
 * The display name of one restoration bonus.
 *
 * Restoration bonus availability and naming are scope-dependent Master Data
 * (`docs/MASTER_DATA.md`): a normal-tier and a Gogma-tier slot of the same
 * bonus type are different `WeaponBonusDefinition`s. Callers that know the
 * scope of the slots they render - a Candidate's `restorationBonusScope`, a
 * trace step's `restorationBonusScope` - pass it so the matching definition's own label is
 * used. When no scope is given, the historical lookup (Gogma definition, then
 * the generic type + rank label) is kept unchanged for existing call sites.
 * No scope is ever inferred here from an ID pattern.
 *
 * An explicit `null` scope means the caller knows the scope was *not*
 * recorded - a persisted `ExpectedResult.restorationBonusScope === null` - so
 * no scope-specific definition is looked up at all and only the generic
 * Master type + rank label is used. It is distinct from omitting the argument,
 * which keeps the historical lookup for older call sites.
 */
export function bonusLabel(
  bonus: RestorationBonus,
  weaponTypeId: string,
  master: MasterDataRoot,
  scope: ArtianBonusScope | null = 'gogma_artian',
): string {
  const specificDefinition = scope === null
    ? undefined
    : master.weaponBonusDefinitions.find(
      (definition) =>
        definition.weaponTypeId === weaponTypeId &&
        definition.bonusTypeId === bonus.bonusTypeId &&
        definition.bonusRankId === bonus.bonusRankId &&
        definition.scope === scope,
    )?.displayNameJa
  const genericLabel = [
      master.bonusTypes.find(({ id }) => id === bonus.bonusTypeId)?.displayNameJa,
      master.bonusRanks.find(({ id }) => id === bonus.bonusRankId)?.displayNameJa,
    ]
      .filter(Boolean)
      .join(' ')
  return specificDefinition ?? (genericLabel || '不明な復元ボーナス')
}

export function seriesSkillLabel(id: string | null, master: MasterDataRoot): string {
  if (id === null) return 'なし'
  return master.seriesSkills.find((skill) => skill.id === id)?.displayNameJa ?? '不明なシリーズスキル'
}

export function groupSkillLabel(id: string | null, master: MasterDataRoot): string {
  if (id === null) return 'なし'
  return master.groupSkills.find((skill) => skill.id === id)?.displayNameJa ?? '不明なグループスキル'
}

/**
 * A read-only summary of one stored `SkillCondition`, in the words of the
 * Target Weapons list (`docs/UI_FLOW.md` 8).
 *
 * Presentation only: the stored IDs are looked up in the Master and an unknown
 * ID falls back to the stored ID itself rather than being dropped, so a
 * condition is never shown as weaker than it is. Both IDs `null` reads
 * 「指定なし」; the match mode is named only when both skills are set, because
 * it decides nothing with a single skill.
 */
export function skillConditionSummary(
  condition: SkillCondition,
  master: MasterDataRoot,
): string {
  const parts = [
    condition.seriesSkillId === null
      ? null
      : `シリーズ ${master.seriesSkills.find(({ id }) => id === condition.seriesSkillId)?.displayNameJa ?? condition.seriesSkillId}`,
    condition.groupSkillId === null
      ? null
      : `グループ ${master.groupSkills.find(({ id }) => id === condition.groupSkillId)?.displayNameJa ?? condition.groupSkillId}`,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return '指定なし'
  return parts.length > 1
    ? `${parts.join(' ／ ')}（${SKILL_CONDITION_ALL_MATCH_LABEL}）`
    : parts[0]!
}

export function materialLabel(id: string, master: MasterDataRoot): string {
  return master.materials.find((material) => material.id === id)?.displayNameJa ?? '不明なアイテム素材'
}
