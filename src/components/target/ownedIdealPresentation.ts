import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { OwnedGogmaArtianWeapon, TargetWeapon } from '../../domain/models/publicTypes'
import { artianWeaponKindLabels, ownedWeaponStatusLabels } from '../../presentation/labels'
import { EntityFormValidationError } from '../../services/crud/entityCrudServices'
import { TargetWeaponLifecycleError } from '../../services/crud/targetWeaponLifecycleService'

/** The words of the owned Ideal notice (`docs/UI_FLOW.md` 8.2 / `docs/SEARCH_SPEC.md` 5.5.5). */
export const OWNED_IDEAL_NOTICE_MESSAGE = 'この目標の理想条件を満たす所持武器をすでに所有しています。'
export const OWNED_IDEAL_NOTICE_GUIDANCE =
  '候補検索、作成リストへの追加、生産計画の作成を行わずに、この武器で目標を完了にできます。'
export const COMPLETE_WITH_OWNED_IDEAL_LABEL = 'この武器で目標を完了にする'
export const COMPLETE_WITH_OWNED_IDEAL_TITLE = 'この所持武器で目標を完了しますか？'
export const COMPLETE_WITH_OWNED_IDEAL_UNCHANGED_NOTE = '武器の復元ボーナスとスキルは変更しません。'
export const COMPLETE_WITH_OWNED_IDEAL_AFFECTED_HEADING = 'この武器は次の目標武器でも優先起点に設定されています。'
export const COMPLETE_WITH_OWNED_IDEAL_AFFECTED_NOTE = '完了すると武器が保護されるため、これらの優先起点設定も解除されます。'

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
