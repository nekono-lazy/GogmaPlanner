import type { ArtianBonusScope, MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildCandidate,
  IntermediateStateOpportunity,
  RestorationBonus,
  SkillCondition,
} from '../../domain/models/publicTypes'
import { skillMatchModeLabels } from '../../presentation/labels'
export {
  compromiseCheckpointBadgeLabel,
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
 * trace step's `restorationBonusScope`, a checkpoint group's
 * `restorationBonusScope` - pass it so the matching definition's own label is
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
    ? `${parts.join(' ／ ')}（${skillMatchModeLabels[condition.matchMode]}）`
    : parts[0]
}

const bonusOperationLabels = {
  reset_bonuses: '再抽選',
  keep_bonuses: '保持して再抽選',
} as const

/** The lane position of one intermediate state, in the words of the game operation. */
export function intermediateOpportunityLabel(
  candidate: BuildCandidate,
  opportunity: IntermediateStateOpportunity,
): string {
  const hasConversion = candidate.route.operations.some(
    ({ type }) => type === 'convert_normal_to_gogma',
  )
  if (opportunity.axis === 'skill') {
    if (opportunity.lanePosition === 0) {
      return hasConversion
        ? '巨戟化直後のスキル（スキルリセット0回）'
        : '現在のスキルのまま（スキルリセット0回）'
    }
    return `スキルリセット${opportunity.lanePosition}回目の直後`
  }
  if (opportunity.lanePosition === 0) {
    return '現在の復元ボーナスのまま（復元ボーナス操作0回）'
  }
  const operation =
    opportunity.operationIndex === null
      ? undefined
      : candidate.route.operations[opportunity.operationIndex]
  const operationLabel =
    operation?.type === 'reset_bonuses' || operation?.type === 'keep_bonuses'
      ? `（${bonusOperationLabels[operation.type]}）`
      : ''
  return `復元ボーナス操作${opportunity.lanePosition}回目${operationLabel}の直後`
}

export function materialLabel(id: string, master: MasterDataRoot): string {
  return master.materials.find((material) => material.id === id)?.displayNameJa ?? '不明なアイテム素材'
}
