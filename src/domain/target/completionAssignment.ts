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

/**
 * Which `completed` Target each owned weapon was completed with - the one
 * authority for "completion-assigned weapons" (Issue #334,
 * `docs/PLANNER_SPEC.md` 21.4, `docs/DATA_MODEL.md` 8.7).
 *
 * It reads `TargetWeapon.completedWithOwnedWeaponId` of the `completed`
 * Targets only: an `active` Target never holds an assignment (its structural
 * validation refuses one), and a `null` assignment ("not recorded", a Target
 * completed before the assignment existed) assigns nothing - no weapon is
 * inferred from `completedByProductionPlanId`, a Plan or an owned Ideal.
 * Protection is not a condition: an unprotected weapon stays assigned.
 *
 * Every consumer - the owned Ideal notice and the direct completion, the
 * Candidate Search Route base, the Planner input and its satisfaction, the
 * Build List optimization's reach table and the preferred owned weapon
 * collection validation - reads this one derivation, so no screen or Service
 * re-implements the rule. When an invalid collection names one weapon twice,
 * the first Target in collection order is kept here; the collection validation
 * below refuses that state wherever it would be written.
 */
export function collectCompletionAssignedOwnedWeaponIds(
  targets: readonly TargetWeapon[],
): ReadonlyMap<OwnedWeaponId, TargetWeaponId> {
  const assignments = new Map<OwnedWeaponId, TargetWeaponId>()
  targets.forEach((target) => {
    if (target.lifecycleStatus !== 'completed') return
    const weaponId = target.completedWithOwnedWeaponId
    if (weaponId === null || weaponId === undefined) return
    if (!assignments.has(weaponId)) assignments.set(weaponId, target.id)
  })
  return assignments
}

/**
 * Whether the weapon is the completion of a Target other than `targetId`, and
 * so can be neither the completion, the Route base nor the preferred origin of
 * `targetId` (21.4). A weapon assigned to `targetId` itself is not "assigned
 * elsewhere".
 */
export function isCompletionAssignedElsewhere(
  assignments: ReadonlyMap<OwnedWeaponId, TargetWeaponId>,
  weaponId: OwnedWeaponId,
  targetId: TargetWeaponId,
): boolean {
  const assignedTo = assignments.get(weaponId)
  return assignedTo !== undefined && assignedTo !== targetId
}

function issue(
  path: string,
  code: DomainValidationIssue['code'],
  message: string,
): DomainValidationIssue {
  return { path, code, message }
}

/**
 * The collection-level authority for `TargetWeapon.completedWithOwnedWeaponId`
 * (`docs/DATA_MODEL.md` 8.7): every non-null assignment names a weapon of the
 * current OwnedWeapon collection, and no weapon is the completion of two
 * Targets. `validateTargetWeapon()` checks the field's structure (`active` ->
 * `null`), and `validateTargetPreferredOwnedWeapons()` refuses a Target
 * preferring an assigned weapon, so together the three cover the whole 8.7
 * contract. The save Services, the Execution transactions (Step confirmation,
 * Undo), the game save point restore, the direct completion and the full Import
 * validation reuse this one function; the UI is never the authority.
 */
export function validateTargetCompletionAssignments(
  targets: readonly TargetWeapon[],
  ownedWeapons: readonly OwnedWeapon[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const weaponIds = new Set<OwnedWeaponId>(ownedWeapons.map(({ id }) => id))
  const claimedBy = new Map<OwnedWeaponId, TargetWeaponId>()
  targets.forEach((target, index) => {
    const weaponId = target.completedWithOwnedWeaponId
    if (weaponId === null || weaponId === undefined) return
    const path = `targetWeapons[${index}].completedWithOwnedWeaponId`
    const claimant = claimedBy.get(weaponId)
    if (claimant !== undefined) {
      issues.push(issue(
        path,
        'invalid_reference',
        `1本の所持武器を2件以上の目標武器の完成品にはできません（${claimant} と重複しています）。`,
      ))
    } else {
      claimedBy.set(weaponId, target.id)
    }
    if (!weaponIds.has(weaponId)) {
      issues.push(issue(path, 'invalid_reference', '完成に使った所持武器が存在しません。'))
    }
  })
  return { isValid: issues.length === 0, issues }
}
