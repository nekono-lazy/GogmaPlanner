import type { ArtianBonusScope, MasterDataRoot, WeaponBonusDefinition } from '../master/masterTypes'
import { getEnabledElements, getEnabledWeaponTypes } from '../master/masterSelectors'
import {
  getProductionAvailableBonusDefinitions,
  ProductionBonusAvailabilityError,
} from '../artian/productionBonusAvailability'
import type {
  ArtianWeaponKind,
  CompletionBonusSlots,
  OwnedWeaponStatus,
  RestorationBonusSet,
  RestorationBonusScope,
  TargetWeapon,
} from '../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY } from '../models/publicTypes'
import { completionBonusVariantFromBonuses } from '../target/completionCondition'
import { completionSkillVariantFromCondition } from '../target/completionSkillVariants'
import type { OwnedWeaponDraft, TargetWeaponDraft } from '../../services/crud/entityCrudServices'

export class MasterOptionsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MasterOptionsUnavailableError'
  }
}

/**
 * The Production bonus availability for a draft, or none when that
 * availability cannot be decided. A draft is never seeded from the Master-only
 * `getBonusDefinitionsForWeapon()`, so a new entity starts inside the
 * availability its save validation enforces.
 */
function productionDefinitionsForDraft(
  master: MasterDataRoot,
  weaponTypeId: string,
  elementId: string,
  scope: ArtianBonusScope,
): WeaponBonusDefinition[] {
  try {
    return getProductionAvailableBonusDefinitions(master, weaponTypeId, elementId, scope)
  } catch (caught) {
    if (caught instanceof ProductionBonusAvailabilityError) return []
    throw caught
  }
}

export function createDefaultBonusSet(
  master: MasterDataRoot,
  weaponTypeId: string,
  elementId: string,
  scope: ArtianBonusScope = 'gogma_artian',
): RestorationBonusSet {
  const definition = productionDefinitionsForDraft(
    master,
    weaponTypeId,
    elementId,
    scope,
  )[0]
  if (!definition) {
    throw new MasterOptionsUnavailableError(
      '選択した武器種の復元ボーナスのマスターデータが利用できません。',
    )
  }
  const bonus = {
    bonusTypeId: definition.bonusTypeId,
    bonusRankId: definition.bonusRankId,
  }
  return [
    { ...bonus },
    { ...bonus },
    { ...bonus },
    { ...bonus },
    { ...bonus },
  ]
}

function baseOptions(master: MasterDataRoot, scope: ArtianBonusScope) {
  const element = getEnabledElements(master)[0]
  if (!element) {
    throw new MasterOptionsUnavailableError(
      '属性のマスターデータが利用できません。',
    )
  }
  const weaponType = getEnabledWeaponTypes(master).find((type) =>
    productionDefinitionsForDraft(master, type.id, element.id, scope).length > 0,
  )
  if (!weaponType || !element) {
    throw new MasterOptionsUnavailableError(
      '武器種または属性のマスターデータが利用できません。',
    )
  }
  return { weaponTypeId: weaponType.id, elementId: element.id }
}

/**
 * A new OwnedWeapon draft.
 *
 * A manually registered Gogma weapon starts `unclassified` and unprotected: the
 * status is a user-facing organisation label, so the tool never guesses one.
 * The status-based protection defaults below (practical unprotected, ideal
 * protected) apply to a draft the caller explicitly asks for with that status,
 * which is how a Planner-secured Ideal is registered (`docs/DATA_MODEL.md` 3.2).
 */
export function createOwnedWeaponDraft(
  master: MasterDataRoot,
  kindOrStatus: ArtianWeaponKind | OwnedWeaponStatus = 'gogma',
  requestedStatus: OwnedWeaponStatus = 'unclassified',
): OwnedWeaponDraft {
  const kind: ArtianWeaponKind =
    kindOrStatus === 'normal' || kindOrStatus === 'gogma'
      ? kindOrStatus
      : 'gogma'
  const status: OwnedWeaponStatus =
    kindOrStatus === 'unclassified' ||
    kindOrStatus === 'practical' ||
    kindOrStatus === 'ideal'
      ? kindOrStatus
      : requestedStatus
  const scope: RestorationBonusScope =
    kind === 'normal' ? 'normal_artian' : 'gogma_artian'
  const base = baseOptions(master, scope)
  const common = {
    kind,
    name: '',
    ...base,
    restorationBonusScope: scope,
    restorationBonuses: createDefaultBonusSet(
      master,
      base.weaponTypeId,
      base.elementId,
      scope,
    ),
    memo: null,
  }
  return kind === 'normal'
    ? {
        ...common,
        kind: 'normal',
        rarity: V1_NORMAL_ARTIAN_RARITY,
        seriesSkillId: null,
        groupSkillId: null,
        status: null,
        isProtected: false,
        executionInProgress: null,
      }
    : {
        ...common,
        kind: 'gogma',
        seriesSkillId: null,
        groupSkillId: null,
        status,
        isProtected: status === 'ideal',
        executionInProgress: null,
      }
}

export function createTargetWeaponDraft(master: MasterDataRoot): TargetWeaponDraft {
  const base = baseOptions(master, 'gogma_artian')
  return {
    name: '',
    ...base,
    priority: 3,
    isEnabled: true,
    preferredOwnedWeaponId: null,
    // Execution-owned lifecycle, never a form input.
    lifecycleStatus: 'active',
    completedAt: null,
    completedByProductionPlanId: null,
    completedWithOwnedWeaponId: null,
    completionBonusVariants: [
      completionBonusVariantFromBonuses(createDefaultBonusSet(master, base.weaponTypeId, base.elementId)),
    ],
    completionSkillVariants: [completionSkillVariantFromCondition({ seriesSkillId: null, groupSkillId: null })],
    completionConditionReview: [],
    memo: null,
  }
}

/**
 * A new Target draft that starts from a registered Target (Issue #377,
 * `docs/UI_FLOW.md` 8.6): a new registration, never an edit of `source`.
 *
 * Only what the Target Weapons form edits is carried over - name, weapon type,
 * element, priority, enablement, memo and every completion Variant and Skill
 * configuration, in their order. Each Variant and configuration gets a fresh
 * editing ID from `createVariantId` and its own objects, so the draft shares
 * nothing with `source`. The preferred owned weapon, the lifecycle and its
 * completion records, and the completion condition review start empty as in
 * any new Target; the save assigns the ID and timestamps.
 */
export function createTargetWeaponDuplicateDraft(
  source: TargetWeapon,
  createVariantId: () => string,
): TargetWeaponDraft {
  return {
    name: source.name,
    weaponTypeId: source.weaponTypeId,
    elementId: source.elementId,
    priority: source.priority,
    isEnabled: source.isEnabled,
    preferredOwnedWeaponId: null,
    lifecycleStatus: 'active',
    completedAt: null,
    completedByProductionPlanId: null,
    completedWithOwnedWeaponId: null,
    completionBonusVariants: source.completionBonusVariants.map((variant) => ({
      id: createVariantId(),
      slots: variant.slots.map(({ bonusTypeId, minimumRankId }) => ({ bonusTypeId, minimumRankId })) as CompletionBonusSlots,
    })),
    completionSkillVariants: source.completionSkillVariants.map(({ seriesSkillId, groupSkillId }) =>
      completionSkillVariantFromCondition({ seriesSkillId, groupSkillId }, createVariantId()),
    ),
    completionConditionReview: [],
    memo: source.memo,
  }
}
