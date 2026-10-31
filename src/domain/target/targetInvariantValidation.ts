import type { BonusRankId, TargetWeapon } from '../models/publicTypes'
import type {
  DomainValidationIssue,
  DomainValidationResult,
} from '../models/validation'
import { validateTargetWeapon } from '../models/validation'
import { findCompletionVariantConflicts } from './completionCondition'
import type { TargetEvaluationMasterSubset } from './targetEvaluationTypes'

/**
 * The minimum ranks missing from Master Data. Only existence is read: a rank
 * the Master keeps with `isEnabled = false` still has its `order` and stays a
 * valid reference here, exactly as the Import Master ID check treats it
 * (`docs/DATA_MODEL.md` 8.2 / 15.2). Whether a rank may be chosen when the
 * user saves is the Production availability of
 * `validateTargetWeaponMasterReferences()`, which this never stands in for.
 */
function unresolvableBonusRankIds(
  target: TargetWeapon,
  master: TargetEvaluationMasterSubset,
): BonusRankId[] {
  const known = new Set(master.bonusRanks.map((rank) => rank.id))
  return [
    ...new Set(
      target.completionBonusVariants
        .flatMap((variant) => variant.slots.map((slot) => slot.minimumRankId))
        .filter((id) => !known.has(id)),
    ),
  ]
}

/**
 * The completion condition invariants that need Master Data
 * (`docs/DATA_MODEL.md` 8.2): the structural `validateTargetWeapon()` first,
 * then every minimum rank must resolve, and no Variant may be included in
 * another (a Variant accepting a subset of what another accepts adds nothing,
 * Owner decision D2). Rank comparison uses the Master `order` as its only
 * authority, so this validation and the completion judgement can never
 * disagree. The save Service, Import and the Candidate Search input all read
 * this one function.
 */
export function validateTargetCompletionConditions(
  target: TargetWeapon,
  master: TargetEvaluationMasterSubset,
): DomainValidationResult {
  const structural = validateTargetWeapon(target)
  if (!structural.isValid) return structural
  const issues: DomainValidationIssue[] = []

  const unresolvable = unresolvableBonusRankIds(target, master)
  if (unresolvable.length > 0) {
    issues.push({
      path: 'completionBonusVariants',
      code: 'invalid_reference',
      message: `The completion Variants cannot be evaluated because Bonus Rank ID(s) ${unresolvable.join(', ')} are missing from Master Data.`,
    })
    return { isValid: false, issues }
  }

  findCompletionVariantConflicts(target.completionBonusVariants, master)
    .filter(({ kind }) => kind === 'included')
    .forEach(({ index, otherIndex }) => {
      issues.push({
        path: `completionBonusVariants[${index}]`,
        code: 'invalid_structure',
        message: `完成構成${index + 1}は完成構成${otherIndex + 1}に含まれます（完成構成${otherIndex + 1}を満たさずにこの構成だけを満たす武器はありません）。`,
      })
    })

  return { isValid: issues.length === 0, issues }
}
