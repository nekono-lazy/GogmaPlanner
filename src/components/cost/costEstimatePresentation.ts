import type { ArtianPartId } from '../../domain/cost'

/**
 * Display names of the cost estimate items (`docs/UI_FLOW.md` 9 / 11.0).
 *
 * The cost estimate is display-only data held in code, not a Master, so its
 * names live here in the Presentation layer rather than in `MaterialMaster`.
 */
export const artianPartLabels: Record<ArtianPartId, string> = {
  'artian_part.broken_blade': '砕かれた古刃',
  'artian_part.crushed_tube': '潰された古筒',
  'artian_part.cracked_disc': 'ひび割れた古盤',
  'artian_part.rusted_device': '錆びついた古装置',
}

export const costEstimateItemLabels = {
  nanairoKane: 'ナナイロカネ',
  veteranTicket: '歴戦錬磨の証',
  oilyDevice: '油濁した遺装置',
} as const

export const costEstimateSectionTitle = '必要素材・費用の目安'

export const costEstimateGroupLabels = {
  artianParts: 'RARE8アーティアパーツ',
  normalFullRestoration: '通常復元',
  conversion: '巨戟化',
  gogmaRestoration: '巨戟復元',
  skillReassignment: 'スキル再付与',
  zenny: '必要ゼニー',
} as const

export const costEstimateNotes = {
  conversionSameType: '※巨戟化に使用する激化タイプ',
  skillSameType: (sameTypeCount: number) =>
    `※巨戟化時と同じ激化タイプなら ×${formatQuantity(sameTypeCount)}`,
  alternative: 'または',
  empty: '追加の素材・ゼニーは不要',
  unpricedForges: (count: number) =>
    `武器種別のパーツ構成が未定義の作成 ${formatQuantity(count)}本（1本につき3パーツ）`,
  legacyPlan: '旧形式の計画のため、必要素材・費用の目安を算出できません。',
  planScope: '計画全体の物理操作から算出した目安です。完了済みの操作も含みます。',
} as const

const quantityFormatter = new Intl.NumberFormat('ja-JP')

/** Thousands-grouped integer, e.g. `420,000`. */
export function formatQuantity(value: number): string {
  return quantityFormatter.format(value)
}

/** `約 420,000z`. */
export function formatZenny(zenny: number): string {
  return `約 ${formatQuantity(zenny)}z`
}

/** `${count}回`, thousands-grouped. */
export function formatOperationCount(count: number): string {
  return `${formatQuantity(count)}回`
}
