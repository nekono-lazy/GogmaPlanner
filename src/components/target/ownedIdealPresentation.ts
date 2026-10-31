import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { OwnedGogmaArtianWeapon, TargetWeapon } from '../../domain/models/publicTypes'
import { artianWeaponKindLabels, ownedWeaponStatusLabels } from '../../presentation/labels'
import { EntityFormValidationError } from '../../services/crud/entityCrudServices'
import { TargetWeaponLifecycleError } from '../../services/crud/targetWeaponLifecycleService'

/** The words of the owned Ideal notice (`docs/UI_FLOW.md` 8.2 / `docs/SEARCH_SPEC.md` 5.5.5). */
export const OWNED_IDEAL_NOTICE_MESSAGE = 'この目標の完成条件を満たす所持武器をすでに所有しています。'
export const OWNED_IDEAL_NOTICE_GUIDANCE =
  '候補検索、作成リストへの追加、生産計画の作成を行わずに、この武器で目標を完了にできます。'
export const COMPLETE_WITH_OWNED_IDEAL_LABEL = 'この武器で目標を完了にする'
export const COMPLETE_WITH_OWNED_IDEAL_TITLE = 'この所持武器で目標を完了しますか？'
export const COMPLETE_WITH_OWNED_IDEAL_UNCHANGED_NOTE = '武器の復元ボーナスとスキルは変更しません。'
export const COMPLETE_WITH_OWNED_IDEAL_AFFECTED_HEADING = 'この武器は次の目標武器でも優先起点に設定されています。'
export const COMPLETE_WITH_OWNED_IDEAL_AFFECTED_NOTE = '完了すると武器が保護されるため、これらの優先起点設定も解除されます。'

/**
 * The weapon also satisfies other active Targets (Issue #334, `docs/UI_FLOW.md`
 * 8.2): it completes this one only, and those need another weapon.
 */
export function completeWithOwnedIdealCrossSatisfactionNote(
  target: Pick<TargetWeapon, 'name'>,
  others: readonly Pick<TargetWeapon, 'name'>[],
): string {
  const names = others.map(({ name }) => `「${name}」`).join('、')
  return `この武器は別の目標武器（${names}）の完成条件も満たしますが、完了にするのは「${target.name}」だけです。${names}を完了するには、別の武器が必要です。`
}

/** Some completed Targets recorded no completion weapon (completed before Issue #334); nothing is guessed. */
export const COMPLETE_WITH_OWNED_IDEAL_UNRECORDED_NOTE =
  '以前に完了した目標武器のうち、完成に使った武器が記録されていないものがあります。この武器がその目標武器の完成品だった場合は、別の武器を選んでください。'

/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
export const COMPLETE_WITH_OWNED_IDEAL_PLAN_BREAKING_NOTE =
  'この目標武器を完了にすると、現在の生産計画の前提と一致しなくなります。'
export const REOPEN_TARGET_PLAN_BREAKING_NOTE =
  'この目標武器を未完了に戻すと、現在の生産計画の前提と一致しなくなります。'

export const REOPEN_TARGET_LABEL = '未完了に戻す'
export const REOPEN_TARGET_TITLE = 'この目標武器を未完了に戻しますか？'
export const REOPEN_TARGET_LINES: readonly string[] = [
  '所持武器は変更しません。',
  '再び候補検索と生産計画の対象になります。',
]

/**
 * The reopening line about the recorded completion weapon (Issue #334,
 * `docs/UI_FLOW.md` 8.3): it becomes a candidate of the other Targets again,
 * and its Ideal label and protection stay as they are.
 */
export function reopenTargetCompletionWeaponLine(weaponName: string): string {
  return `完成に使った武器「${weaponName}」は、ほかの目標武器の完了・候補検索・生産計画の候補に戻ります（武器の理想・保護は変更しません）。`
}

export const COMPLETED_TARGETS_HEADING = '完了済みの目標武器'

/** The identity of one owned Ideal weapon beside its name: kind, weapon type, element, status, protection. */
export function ownedIdealWeaponSummary(weapon: OwnedGogmaArtianWeapon, master: MasterDataRoot): string {
  const weaponType = master.weaponTypes.find(({ id }) => id === weapon.weaponTypeId)?.displayNameJa ?? weapon.weaponTypeId
  const element = master.elements.find(({ id }) => id === weapon.elementId)?.displayNameJa ?? weapon.elementId
  return [
    artianWeaponKindLabels[weapon.kind],
    weaponType,
    element,
    ownedWeaponStatusLabels[weapon.status],
    weapon.isProtected ? '保護中' : '保護なし',
  ].join(' / ')
}

/** The Targets, other than the one being completed, that would lose their preference for the weapon. */
export function targetsReleasedByCompletion(
  targets: readonly TargetWeapon[],
  target: Pick<TargetWeapon, 'id'>,
  weapon: Pick<OwnedGogmaArtianWeapon, 'id'>,
): TargetWeapon[] {
  return targets.filter((other) => other.id !== target.id && other.preferredOwnedWeaponId === weapon.id)
}

/**
 * A lifecycle action the Service refused, in the user's words: a typed
 * lifecycle refusal (the Target or weapon is no longer what the screen showed)
 * or the change's own validation. `null` means it is not one of these.
 */
export function targetLifecycleErrorMessage(caught: unknown): string | null {
  if (caught instanceof TargetWeaponLifecycleError) return caught.message
  if (caught instanceof EntityFormValidationError) return caught.issues.join(' / ')
  return null
}

export function formatCompletedAt(completedAt: string): string {
  const date = new Date(completedAt)
  return Number.isNaN(date.getTime()) ? completedAt : date.toLocaleString('ja-JP')
}
