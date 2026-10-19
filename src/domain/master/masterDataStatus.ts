import type { MasterDataRoot } from './masterTypes'

/**
 * Whether a feature can run on the loaded Master.
 *
 * `isProductionReady` is false only for a `blockingReason`: a Master gap that
 * makes the feature unusable. The provisional `LotteryMaster` is never
 * consulted here: Production RNG reads its own reference-verified tables, and
 * Route availability is decided route-locally by RngState, RngEngine
 * capability, `getPredictionSupport()`, the semantic Masters a prediction
 * actually needs, and Route eligibility - never by this generic status. The
 * `MaterialCostMaster` is not consulted either: the user-facing cost figure is
 * the display-only estimate derived from a Route or a Plan
 * (`docs/MASTER_DATA_STATUS.md`, `docs/SEARCH_SPEC.md` 4.3), so an all-disabled
 * cost Master narrows nothing the user sees and raises no advisory.
 */
export interface MasterDataStatus {
  isProductionReady: boolean
  blockingReason: string | null
}

export function getMasterDataStatus(master: MasterDataRoot): MasterDataStatus {
  const hasCoreData =
    master.weaponTypes.some(({ isEnabled }) => isEnabled) &&
    master.elements.some(({ isEnabled }) => isEnabled) &&
    master.weaponBonusDefinitions.some(
      ({ isEnabled, scope }) => isEnabled && scope === 'normal_artian',
    ) &&
    master.weaponBonusDefinitions.some(
      ({ isEnabled, scope }) => isEnabled && scope === 'gogma_artian',
    ) &&
    master.artianBonusTypeMappings.length > 0 &&
    master.seriesSkills.some(({ isEnabled }) => isEnabled) &&
    master.groupSkills.some(({ isEnabled }) => isEnabled)

  if (!hasCoreData) {
    return {
      isProductionReady: false,
      blockingReason:
        '武器入力に必要なマスターデータが不足しています。推測した選択肢は表示しません。',
    }
  }

  return { isProductionReady: true, blockingReason: null }
}
