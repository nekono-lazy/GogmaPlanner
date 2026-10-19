import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  KnownValue,
  NormalArtianCounter,
  WeaponTypeId,
} from '../../domain/models/publicTypes'
import { rngStateSourceLabels } from '../../presentation/labels'

/**
 * Debug presentation of the persisted RNG state and Normal Artian Counters
 * (`docs/REQUIREMENTS.md` 33, `docs/UI_FLOW.md` 15).
 *
 * Pure projections of the stored records. Nothing is predicted, derived or
 * defaulted here: a `null` value is reported as 未設定 and never as `0` or as
 * the string `"null"`, and a Counter is never invented for a weapon type with
 * no persisted record.
 */

/** What a Debug row shows for a `null` persisted value. */
export const debugUnsetValueLabel = '未設定'

export interface KnownValueDebugView {
  /** The persisted value, or 未設定. Raw, because this screen is the Debug screen. */
  value: string
  /** `isConfirmed` as the raw flag plus its meaning. */
  confirmed: string
  /** `source` as the raw enum plus its Japanese label, or 未設定. */
  source: string
}

export function knownValueDebugView(known: KnownValue<string | number>): KnownValueDebugView {
  return {
    value: known.value === null ? debugUnsetValueLabel : String(known.value),
    confirmed: `${String(known.isConfirmed)}（${known.isConfirmed ? '確定' : '未確定'}）`,
    source:
      known.source === null
        ? debugUnsetValueLabel
        : `${known.source}（${rngStateSourceLabels[known.source]}）`,
  }
}

/** An `ISODateTimeString | null` timestamp, shown exactly as stored. */
export function debugTimestampLabel(value: string | null): string {
  return value === null ? debugUnsetValueLabel : value
}

/** The Master display name of a weapon type, falling back to the raw ID. */
export function debugWeaponTypeLabel(
  weaponTypeId: WeaponTypeId,
  master: MasterDataRoot,
): string {
  return master.weaponTypes.find(({ id }) => id === weaponTypeId)?.displayNameJa ?? weaponTypeId
}

/**
 * Persisted Normal Artian Counters in a stable display order, independent of
 * what order the repository happened to return.
 *
 * Master `WeaponTypeMaster.sortOrder` first, then rarity, then the record ID.
 * A weapon type with no Master entry sorts after every known one rather than
 * being hidden, so an imported or legacy record stays visible.
 */
export function orderNormalArtianCountersForDebug(
  counters: readonly NormalArtianCounter[],
  master: MasterDataRoot,
): NormalArtianCounter[] {
  const sortOrderByWeaponType = new Map(
    master.weaponTypes.map(({ id, sortOrder }) => [id, sortOrder] as const),
  )
  const unknownSortOrder = Number.MAX_SAFE_INTEGER
  return [...counters].sort((left, right) => {
    const leftOrder = sortOrderByWeaponType.get(left.weaponTypeId) ?? unknownSortOrder
    const rightOrder = sortOrderByWeaponType.get(right.weaponTypeId) ?? unknownSortOrder
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    if (left.weaponTypeId !== right.weaponTypeId) {
      return left.weaponTypeId < right.weaponTypeId ? -1 : 1
    }
    if (left.rarity !== right.rarity) return left.rarity - right.rarity
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
}
