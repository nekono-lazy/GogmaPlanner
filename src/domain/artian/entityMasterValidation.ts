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

/**
 * The save-time Master references of a Target (`docs/DATA_MODEL.md` 8.2 / 8.4):
 * the weapon type, element and every completion Skill configuration's
 * specified Series / Group Skill must be enabled, and every slot's
 * `(bonusTypeId, minimumRankId)` of every Variant must be a Production draw
 * candidate of the Target's weapon type / element / `gogma_artian` scope
 * (`docs/MASTER_DATA.md` 15.1). Import keeps checking existence only.
 */
export function validateTargetWeaponMasterReferences(
  target: TargetWeapon,
  master: MasterDataRoot,
): string[] {
  const issues: string[] = []
  validateCommon(
    { weaponTypeId: target.weaponTypeId, elementId: target.elementId, seriesSkillId: null, groupSkillId: null },
    master,
    issues,
  )
  // One configuration reads exactly as the former one condition did; two or
  // more name the configuration the Skill belongs to.
  const single = target.completionSkillVariants.length === 1
  target.completionSkillVariants.forEach((variant, index) => {
    const prefix = single ? '' : `完成スキル構成${index + 1}の`
    if (variant.seriesSkillId !== null && !master.seriesSkills.some(({ id, isEnabled }) => id === variant.seriesSkillId && isEnabled)) {
      issues.push(`seriesSkillId: ${prefix}利用可能なシリーズスキルではありません。`)
    }
    if (variant.groupSkillId !== null && !master.groupSkills.some(({ id, isEnabled }) => id === variant.groupSkillId && isEnabled)) {
      issues.push(`groupSkillId: ${prefix}利用可能なグループスキルではありません。`)
    }
  })
  validateBonuses(master, target.weaponTypeId, target.elementId, 'gogma_artian',
    target.completionBonusVariants.flatMap((variant, variantIndex) => variant.slots.map((slot, slotIndex) => ({
      bonus: { bonusTypeId: slot.bonusTypeId, bonusRankId: slot.minimumRankId },
      path: `completionBonusVariants[${variantIndex}].slots[${slotIndex}]`,
    }))),
    issues)
  return issues
}
