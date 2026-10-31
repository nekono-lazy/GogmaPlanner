import type { OwnedWeapon, TargetWeapon } from '../../domain/models/publicTypes'
import type { ProductionPlanCompletionAssignmentIssue } from '../../domain/planner/productionPlanCompletionAssignmentSafety'

/**
 * The words of a Plan whose recorded completions would make one owned weapon
 * the completion of two Targets (Issue #334, `docs/UI_FLOW.md` 12.11,
 * `docs/PLANNER_SPEC.md` 21.4.1). Built from the typed issues of
 * `inspectProductionPlanCompletionAssignmentSafety()` alone - the screen never
 * re-reads the Plan - and naming Targets and weapons by name only: an ID is
 * Debug Mode only, and a name that cannot be resolved reads as such, never as
 * an ID.
 */

export const UNRESOLVED_TARGET_NAME = '名前を確認できない目標武器'
export const UNRESOLVED_WEAPON_NAME = '名前を確認できない所持武器'

export interface CompletionAssignmentNames {
  targetName(id: string): string | null
  weaponName(id: string): string | null
}

/** Names from the loaded collections, for display only. */
export function completionAssignmentNamesOf(
  targetWeapons: readonly Pick<TargetWeapon, 'id' | 'name'>[],
  ownedWeapons: readonly Pick<OwnedWeapon, 'id' | 'name'>[],
): CompletionAssignmentNames {
  const targets = new Map(targetWeapons.map(({ id, name }) => [id as string, name]))
  const weapons = new Map(ownedWeapons.map(({ id, name }) => [id as string, name]))
  return {
    targetName: (id) => targets.get(id) ?? null,
    weaponName: (id) => weapons.get(id) ?? null,
  }
}

function quoted(name: string | null, fallback: string): string {
  return name === null ? fallback : `「${name}」`
}

/** One sentence per typed issue, in the issues' own order. */
export function completionAssignmentIssueText(
  issue: ProductionPlanCompletionAssignmentIssue,
  names: CompletionAssignmentNames,
): string {
  const target = (id: string) => quoted(names.targetName(id), UNRESOLVED_TARGET_NAME)
  const weapon = (id: string) => quoted(names.weaponName(id), UNRESOLVED_WEAPON_NAME)
  switch (issue.reason) {
    case 'duplicate_completion_weapon':
      return `${issue.targetWeaponIds.map(target).join('と')}の完成に、同じ所持武器${weapon(issue.ownedWeaponId)}を使う予定になっています。`
    case 'completion_weapon_assigned_elsewhere':
      return `所持武器${weapon(issue.ownedWeaponId)}は、すでに${target(issue.assignedTargetWeaponId)}の完成品です。${target(issue.targetWeaponId)}の完成には使えません。`
    case 'completion_assignment_unverifiable':
      return 'この生産計画の記録からは、どの武器でどの目標武器を完成させるかを確認できません。'
  }
}

/** The same sentences, one per distinct text, for a list. */
export function completionAssignmentIssueTexts(
  issues: readonly ProductionPlanCompletionAssignmentIssue[],
  names: CompletionAssignmentNames,
): string[] {
  return [...new Set(issues.map((issue) => completionAssignmentIssueText(issue, names)))]
}

/** The Debug Mode line of one issue: its typed code and IDs, never shown in the ordinary UI. */
export function completionAssignmentIssueDebugText(issue: ProductionPlanCompletionAssignmentIssue): string {
  switch (issue.reason) {
    case 'duplicate_completion_weapon':
      return `${issue.reason}: ${issue.ownedWeaponId} / ${issue.targetWeaponIds.join(', ')} / ${issue.planStepIds.join(', ')}`
    case 'completion_weapon_assigned_elsewhere':
      return `${issue.reason}: ${issue.ownedWeaponId} / ${issue.targetWeaponId} (assigned: ${issue.assignedTargetWeaponId}) / ${issue.planStepId}`
    case 'completion_assignment_unverifiable':
      return `${issue.reason}: ${issue.detail} / ${issue.planStepId ?? 'unknown step'}`
  }
}

export const COMPLETION_ASSIGNMENT_ONE_WEAPON_NOTE =
  '1本の武器で2件の目標武器を完成させることはできないため、この計画のままでは進められません。'

export const COMPLETION_ASSIGNMENT_REPLAN_NOTE =
  '現在地点からの再計画で、続きを作り直せる場合があります。ただし、完成条件が重なる目標武器を含む場合などは再計画が成立しないことがあります。'

export const COMPLETION_ASSIGNMENT_ZERO_OPERATION_NOTE =
  '同じ所持武器を起点にする候補が原因の場合は、作成リストでどちらかの候補を外すか、一方の目標武器を「この武器で目標を完了にする」で完了にできます。'

/** Whether a duplicate is among the issues - the case the Build List / direct completion guidance resolves. */
export function hasDuplicateCompletionWeapon(issues: readonly ProductionPlanCompletionAssignmentIssue[]): boolean {
  return issues.some(({ reason }) => reason === 'duplicate_completion_weapon')
}
