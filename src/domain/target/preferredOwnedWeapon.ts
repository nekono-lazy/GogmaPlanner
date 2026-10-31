import type {
  OwnedWeapon,
  OwnedWeaponId,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import type {
  DomainValidationIssue,
  DomainValidationResult,
} from '../models/validation'
import {
  collectCompletionAssignedOwnedWeaponIds,
  validateTargetCompletionAssignments,
} from './completionAssignment'

function issue(
  path: string,
  code: DomainValidationIssue['code'],
  message: string,
): DomainValidationIssue {
  return { path, code, message }
}

/**
 * Whether one owned weapon may be a Target's preferred Route origin.
 *
 * Weapon type and element must match the Target, and the weapon must be
 * unprotected, because a protected weapon is never an automatic Planner source
 * (`AGENTS.md` Owned Weapon Rules). Both Normal and Gogma weapons qualify, and
 * `status` is deliberately not a condition: a Material, Practical, or Ideal
 * Gogma is equally selectable, and preference stays independent of status
 * (`docs/DATA_MODEL.md` 8.5). A completion-assigned weapon
 * (`collectCompletionAssignedOwnedWeaponIds()`, 8.7) is never eligible, even
 * once unprotected.
 */
export function isEligiblePreferredOwnedWeapon(
  target: Pick<TargetWeapon, 'weaponTypeId' | 'elementId'>,
  weapon: OwnedWeapon,
  completionAssignments: ReadonlyMap<OwnedWeaponId, TargetWeaponId>,
): boolean {
  return (
    weapon.weaponTypeId === target.weaponTypeId &&
    weapon.elementId === target.elementId &&
    !weapon.isProtected &&
    !completionAssignments.has(weapon.id)
  )
}

/**
 * Whether the weapon is compatible with the Target apart from protection.
 *
 * The Target edit dropdown lists a compatible but protected weapon as a
 * disabled option so the user can see why it is unavailable, so the two
 * conditions are asked separately there (`docs/UI_FLOW.md` 8.1).
 */
export function isCompatiblePreferredOwnedWeapon(
  target: Pick<TargetWeapon, 'weaponTypeId' | 'elementId'>,
  weapon: OwnedWeapon,
): boolean {
  return (
    weapon.weaponTypeId === target.weaponTypeId &&
    weapon.elementId === target.elementId
  )
}

/**
 * The collection-level authority for `TargetWeapon.preferredOwnedWeaponId`.
 *
 * `validateTargetWeapon()` can only check the field's structure, because every
 * remaining rule needs the owned weapon collection and the other Targets. The
 * save Service, Candidate Search input validation, and Planner input validation
 * all reuse this one function rather than restating the contract, and the UI is
 * never the authority (`docs/DATA_MODEL.md` 8.5).
 *
 * Fails closed on a missing weapon, a weapon type or element mismatch, a
 * protected weapon, the same weapon being preferred by two Targets, and a
 * completion-assigned weapon (Issue #334, `docs/DATA_MODEL.md` 8.5 / 8.7: the
 * completion of another Target, unprotected or not). Both `normal` and `gogma`
 * kinds are accepted, and a Target with no preference is always valid.
 */
export function validateTargetPreferredOwnedWeapons(
  targets: readonly TargetWeapon[],
  ownedWeapons: readonly OwnedWeapon[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const weaponById = new Map<OwnedWeaponId, OwnedWeapon>(
    ownedWeapons.map((weapon) => [weapon.id, weapon]),
  )
  const claimedBy = new Map<OwnedWeaponId, TargetWeaponId>()
  const assignments = collectCompletionAssignedOwnedWeaponIds(targets)

  targets.forEach((target, index) => {
    const preferredId = target.preferredOwnedWeaponId
    if (preferredId === null || preferredId === undefined) return
    const path = `targetWeapons[${index}].preferredOwnedWeaponId`
    const claimant = claimedBy.get(preferredId)
    if (claimant !== undefined) {
      issues.push(
        issue(
          path,
          'invalid_reference',
          `優先起点の所持武器は1つの目標武器にだけ設定できます（${claimant} と重複しています）。`,
        ),
      )
    } else {
      claimedBy.set(preferredId, target.id)
    }
    const weapon = weaponById.get(preferredId)
    if (!weapon) {
      issues.push(
        issue(path, 'invalid_reference', '優先起点の所持武器が存在しません。'),
      )
      return
    }
    if (weapon.weaponTypeId !== target.weaponTypeId) {
      issues.push(
        issue(
          path,
          'invalid_state',
          '優先起点の所持武器の武器種が目標武器と一致しません。',
        ),
      )
    }
    if (weapon.elementId !== target.elementId) {
      issues.push(
        issue(
          path,
          'invalid_state',
          '優先起点の所持武器の属性が目標武器と一致しません。',
        ),
      )
    }
    if (weapon.isProtected) {
      issues.push(
        issue(
          path,
          'invalid_state',
          '保護中の所持武器は優先起点に設定できません。',
        ),
      )
    }
    if (assignments.has(preferredId)) {
      issues.push(
        issue(
          path,
          'invalid_state',
          '別の目標武器の完成に使った所持武器は優先起点に設定できません。',
        ),
      )
    }
  })

  return { isValid: issues.length === 0, issues }
}

/**
 * The preferred owned weapon collection (`docs/DATA_MODEL.md` 8.5) and the
 * completion assignment collection (8.7) together: what every write of the
 * TargetWeapon collection - the save Services, the Execution transactions, the
 * game save point restore, the direct completion and the full Import validation
 * - re-validates. Issues keep each authority's order.
 */
export function validateTargetOwnedWeaponCollections(
  targets: readonly TargetWeapon[],
  ownedWeapons: readonly OwnedWeapon[],
): DomainValidationResult {
  const issues = [
    ...validateTargetPreferredOwnedWeapons(targets, ownedWeapons).issues,
    ...validateTargetCompletionAssignments(targets, ownedWeapons).issues,
  ]
  return { isValid: issues.length === 0, issues }
}

/**
 * The Targets whose preference would become invalid if this weapon took the
 * given protection state, weapon type, and element.
 *
 * Used by the Owned Weapons screen to ask for confirmation before protecting or
 * re-typing a weapon that a Target currently prefers, and by the save Service
 * to unlink those Targets in the same transaction (`docs/UI_FLOW.md` 7.1).
 */
export function findTargetsInvalidatedByOwnedWeaponChange(
  targets: readonly TargetWeapon[],
  weaponId: OwnedWeaponId,
  next: Pick<OwnedWeapon, 'weaponTypeId' | 'elementId' | 'isProtected'>,
): TargetWeapon[] {
  return targets.filter(
    (target) =>
      target.preferredOwnedWeaponId === weaponId &&
      (next.isProtected ||
        next.weaponTypeId !== target.weaponTypeId ||
        next.elementId !== target.elementId),
  )
}
