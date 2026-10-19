import type {
  BuildCandidate,
  OwnedWeapon,
  TargetWeapon,
} from '../../domain/models/publicTypes'

/** Where the displayed Route actually starts. */
export type CandidateRouteOrigin =
  | { kind: 'owned_weapon'; weaponName: string }
  | { kind: 'new_normal_artian' }

/**
 * The notice of a Candidate whose Route does not start from the Target's
 * preferred owned weapon (Issue #128, `docs/UI_FLOW.md` 9).
 */
export interface PreferredOwnedWeaponNotice {
  preferredWeaponName: string
  routeOrigin: CandidateRouteOrigin
}

const missingWeaponName = '（見つからない所持武器）'

function weaponName(
  weaponId: OwnedWeapon['id'],
  ownedWeapons: readonly OwnedWeapon[],
): string {
  return ownedWeapons.find(({ id }) => id === weaponId)?.name ?? missingWeaponName
}

/**
 * Whether this Candidate's Route ignores the Target's preferred owned weapon,
 * and how to say so. Display-only.
 *
 * The test is the Search authority itself (`docs/SEARCH_SPEC.md` 8.1):
 * `candidate.route.sourceOwnedWeaponId === target.preferredOwnedWeaponId`. A
 * Target with no preference never gets a notice - two `null`s are not a match,
 * they mean there is nothing to compare - and a new-Normal Route, whose source
 * is `null`, never starts from a preferred weapon. It never changes which Route
 * is chosen: the preference stays a soft tie-break of the Search.
 */
export function describePreferredOwnedWeaponNotice(
  candidate: BuildCandidate,
  target: TargetWeapon | null,
  ownedWeapons: readonly OwnedWeapon[],
): PreferredOwnedWeaponNotice | null {
  const preferredOwnedWeaponId = target?.preferredOwnedWeaponId ?? null
  if (preferredOwnedWeaponId === null) return null
  const sourceOwnedWeaponId = candidate.route.sourceOwnedWeaponId
  if (sourceOwnedWeaponId === preferredOwnedWeaponId) return null
  return {
    preferredWeaponName: weaponName(preferredOwnedWeaponId, ownedWeapons),
    routeOrigin:
      sourceOwnedWeaponId === null
        ? { kind: 'new_normal_artian' }
        : { kind: 'owned_weapon', weaponName: weaponName(sourceOwnedWeaponId, ownedWeapons) },
  }
}

export const preferredOwnedWeaponNoticeTitle = '優先する所持武器を使用しないルートです'

export const preferredOwnedWeaponNoticeExplanation =
  '優先する所持武器は起点の優先指定です。より短い作成ルートがある場合や、その武器からは現在の検索条件と探索範囲で理想品に届かない場合は、別の起点のルートが選ばれます。'

export function candidateRouteOriginLabel(origin: CandidateRouteOrigin): string {
  return origin.kind === 'owned_weapon'
    ? `所持武器「${origin.weaponName}」`
    : '新しく作成する通常アーティア'
}
