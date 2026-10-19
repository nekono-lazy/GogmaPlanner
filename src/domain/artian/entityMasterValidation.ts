import type { ArtianBonusScope, MasterDataRoot } from '../master/masterTypes'
import type { OwnedWeapon, RestorationBonus, TargetWeapon } from '../models/publicTypes'
import {
  getProductionAvailableBonusDefinitions,
  ProductionBonusAvailabilityError,
} from './productionBonusAvailability'

/*
 * Master reference validation of persisted OwnedWeapon / TargetWeapon entities.
 *
 * Restoration bonuses are checked against the Production bonus availability
 * (Master weapon type / scope definitions x the Production lottery,
 * `docs/RNG_SPEC.md` 6.1.1 / 6.3.1), not the Master-only
 * `getBonusDefinitionsForWeapon()`. This module lives outside `domain/master`
 * because that availability reads the Production RNG layer, which
 * `domain/master` must never depend on.
 *
 * This is the save boundary only. Loading, Import, Search, and Planner never
 * call it, so a stored bonus outside the availability is kept exactly as it is
 * and is refused only when the user tries to save it (`docs/DATA_MODEL.md` 7.1).
 */

interface BonusCheck {
  readonly bonus: RestorationBonus
  readonly path: string
}

function bonusKey(bonus: RestorationBonus): string {
  return `${bonus.bonusTypeId}\u0000${bonus.bonusRankId}`
}

function validateBonuses(
  master: MasterDataRoot,
  weaponTypeId: string,
  elementId: string,
  scope: ArtianBonusScope,
  checks: readonly BonusCheck[],
  issues: string[],
) {
  if (checks.length === 0) return
  if (
    !master.weaponTypes.some(
      ({ id, isEnabled }) => id === weaponTypeId && isEnabled,
    ) ||
    !master.elements.some(
      ({ id, isEnabled }) => id === elementId && isEnabled,
    )
  ) {
    checks.forEach(({ path }) => issues.push(`${path}: 武器種または属性のマスターデータが利用できません。`))
    return
  }
  let available: ReadonlySet<string>
  try {
    available = new Set(
      getProductionAvailableBonusDefinitions(master, weaponTypeId, elementId, scope).map(bonusKey),
    )
  } catch (caught) {
    if (caught instanceof ProductionBonusAvailabilityError) {
      checks.forEach(({ path }) => issues.push(`${path}: この武器種・属性の復元ボーナス抽選対象を判定できないため保存できません。`))
      return
    }
    throw caught
  }
  checks.forEach(({ bonus, path }) => {
    if (!available.has(bonusKey(bonus))) {
      issues.push(`${path}: この武器種・属性ではProductionで抽選されない復元ボーナス／ランクです。選択肢から選び直してください。`)
    }
  })
}

function validateCommon(
  value: Pick<OwnedWeapon, 'weaponTypeId' | 'elementId' | 'seriesSkillId' | 'groupSkillId'>,
  master: MasterDataRoot,
  issues: string[],
) {
  if (!master.weaponTypes.some(({ id, isEnabled }) => id === value.weaponTypeId && isEnabled)) {
    issues.push('weaponTypeId: 利用可能な武器種が見つかりません。')
  }
  if (!master.elements.some(({ id, isEnabled }) => id === value.elementId && isEnabled)) {
    issues.push('elementId: 利用可能な属性が見つかりません。')
  }
  if (value.seriesSkillId !== null && !master.seriesSkills.some(({ id, isEnabled }) => id === value.seriesSkillId && isEnabled)) {
    issues.push('seriesSkillId: 利用可能なシリーズスキルではありません。')
  }
  if (value.groupSkillId !== null && !master.groupSkills.some(({ id, isEnabled }) => id === value.groupSkillId && isEnabled)) {
    issues.push('groupSkillId: 利用可能なグループスキルではありません。')
  }
}

export function validateOwnedWeaponMasterReferences(
  weapon: OwnedWeapon,
  master: MasterDataRoot,
): string[] {
  const issues: string[] = []
  validateCommon(weapon, master, issues)
  // The stored scope is the authority. A Gogma weapon may still hold the
  // `normal_artian` slots it inherited at conversion (`docs/DATA_MODEL.md` 7.1);
  // the structural validation already pins a Normal weapon to `normal_artian`.
  validateBonuses(
    master,
    weapon.weaponTypeId,
    weapon.elementId,
    weapon.restorationBonusScope,
    weapon.restorationBonuses.map((bonus, index) => ({ bonus, path: `restorationBonuses[${index}]` })),
    issues,
  )
  return issues
}

export function validateTargetWeaponMasterReferences(
  target: TargetWeapon,
  master: MasterDataRoot,
): string[] {
  const issues: string[] = []
  validateCommon(
    {
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
      seriesSkillId: target.idealSkillCondition.seriesSkillId,
      groupSkillId: target.idealSkillCondition.groupSkillId,
    },
    master,
    issues,
  )
  if (target.practicalSkillCondition.seriesSkillId !== null && !master.seriesSkills.some(({ id, isEnabled }) => id === target.practicalSkillCondition.seriesSkillId && isEnabled)) issues.push('practicalSkillCondition.seriesSkillId: 利用できません。')
  if (target.practicalSkillCondition.groupSkillId !== null && !master.groupSkills.some(({ id, isEnabled }) => id === target.practicalSkillCondition.groupSkillId && isEnabled)) issues.push('practicalSkillCondition.groupSkillId: 利用できません。')
  validateBonuses(master, target.weaponTypeId, target.elementId, 'gogma_artian', [
    ...target.idealBonuses.map((bonus, index) => ({ bonus, path: `idealBonuses[${index}]` })),
    ...target.practicalBonusConditions.map((condition, index) => ({
      bonus: { bonusTypeId: condition.bonusTypeId, bonusRankId: condition.minimumRankId },
      path: `practicalBonusConditions[${index}]`,
    })),
    ...target.alternativeBonusRules.flatMap((group, groupIndex) => group.options.map((option, optionIndex) => ({
      bonus: { bonusTypeId: option.alternativeBonusTypeId, bonusRankId: option.minimumRankId },
      path: `alternativeBonusRules[${groupIndex}].options[${optionIndex}]`,
    }))),
  ], issues)
  return issues
}
