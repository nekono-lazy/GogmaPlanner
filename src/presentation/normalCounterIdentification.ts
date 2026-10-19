import type { ElementMaster } from '../domain/master/masterTypes'
import type { ElementId, WeaponTypeId } from '../domain/models/publicTypes'
import type {
  NormalArtianCounterIdentificationResult,
  NormalArtianLotteryTableClass,
} from '../domain/rng/identification'
import {
  gameVerifiedNormalCandidatesForWeaponAndTableClass,
  normalArtianLotteryTableClassElementIds,
} from '../domain/rng/production/gameNormalBonuses'
import type { RngPredictionUnsupportedReason } from '../domain/rng/rngEngine'

/** The formal result classes of `docs/RNG_SPEC.md` 9.12; only `unique` may be confirmed. */
export type NormalCounterIdentificationClassification = 'unique' | 'multiple' | 'zero' | 'truncated'

export function classifyNormalCounterIdentificationResult(
  result: NormalArtianCounterIdentificationResult,
): NormalCounterIdentificationClassification {
  if (result.isTruncated) return 'truncated'
  if (result.matches.length === 1) return 'unique'
  if (result.matches.length === 0) return 'zero'
  return 'multiple'
}

/**
 * The Japanese sentence for one structured unsupported reason. The reason only
 * selects the sentence; the enum text itself never reaches the ordinary UI.
 */
export function normalCounterIdentificationUnsupportedLabel(
  reason: RngPredictionUnsupportedReason | null,
): string {
  switch (reason) {
    case 'normal_pool_unverified':
      return 'この武器種の通常アーティア抽選テーブルはProduction検証対象外のため、Counter検索できません。'
    case 'engine_capability_unavailable':
      return '現在のRNG Engineは通常アーティア予測に対応していないため、Counter検索できません。'
    case 'reference_adapter_unsupported':
      return 'この武器種は現在のRNG Engineが扱えないため、Counter検索できません。'
    default:
      return 'この入力はCounter検索に対応していません。'
  }
}

/**
 * The supplementary sentence for a weapon type whose two table classes draw
 * one and the same Production pool (`docs/RNG_SPEC.md` 6.3.1: Light / Heavy
 * Bowgun, and Switch Axe since its single-pool verification). It is derived
 * from the Domain pool authority itself, never from a weapon-type list in the
 * UI, and says only what the pool identity proves: the two classes never
 * change which bonuses can be drawn, while the class is still recorded per
 * observation. Returns `null` when the pools differ or the weapon type has no
 * Production pool.
 */
export function normalCounterIdentificationSharedPoolNote(weaponTypeId: WeaponTypeId): string | null {
  try {
    const tableA = gameVerifiedNormalCandidatesForWeaponAndTableClass(weaponTypeId, 'table_a')
    const tableB = gameVerifiedNormalCandidatesForWeaponAndTableClass(weaponTypeId, 'table_b')
    if (tableA !== tableB) return null
  } catch {
    return null
  }
  return 'この武器種は属性の有無によらず同じ復元ボーナス抽選を使用するため、どちらの区分でも選択できる復元ボーナスは同じです。'
}

/** One selectable lottery table of the observation UI, labelled for the weapon type. */
export interface NormalCounterIdentificationTableClassOption {
  readonly tableClass: NormalArtianLotteryTableClass
  readonly label: string
}

/**
 * The two table-class radio options for one weapon type (`docs/UI_FLOW.md` 6).
 *
 * The split itself comes from the Domain classification
 * (`normalArtianLotteryTableClassElementIds()`); this function only decides
 * how to word it. When Table B holds nothing but 無属性 the tables are the
 * familiar 属性あり / 無属性 distinction and are labelled that way (Melee,
 * Bowguns). When an attribute also draws from Table B (the Bow), the label
 * spells out which elements belong to each table, using the Master display
 * names, so the user never sees the internal `table_a` / `table_b` enum and
 * never has to know the classification by heart. Returns `null` for a weapon
 * type without a Production pool.
 */
export function normalCounterIdentificationTableClassOptions(
  weaponTypeId: WeaponTypeId,
  elements: readonly ElementMaster[],
): readonly NormalCounterIdentificationTableClassOption[] | null {
  let tableA: readonly ElementId[]
  let tableB: readonly ElementId[]
  try {
    tableA = normalArtianLotteryTableClassElementIds(weaponTypeId, 'table_a')
    tableB = normalArtianLotteryTableClassElementIds(weaponTypeId, 'table_b')
  } catch {
    return null
  }
  const attributeOnlySplit = tableB.length === 1 && tableB[0] === 'element.none'
  if (attributeOnlySplit) {
    return [
      { tableClass: 'table_a', label: '属性あり' },
      { tableClass: 'table_b', label: '無属性' },
    ]
  }
  const names = new Map(elements.map((element) => [element.id, element.displayNameJa] as const))
  const list = (elementIds: readonly ElementId[]) =>
    elementIds.map((elementId) => names.get(elementId) ?? elementId).join('・')
  return [
    { tableClass: 'table_a', label: `テーブルA（${list(tableA)}）` },
    { tableClass: 'table_b', label: `テーブルB（${list(tableB)}）` },
  ]
}
