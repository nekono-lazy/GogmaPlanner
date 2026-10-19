import type { OtherTargetSourceUsageReason } from '../../domain/buildList'
import type {
  BuildCandidate,
  BuildListEntryId,
  OwnedWeaponId,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import { compareByRegistrationOrder, type RegistrationOrdered } from '../../presentation/managementListOrder'
import type { CandidateSearchSourceExclusionSnapshot } from '../../services/search/prepareCandidateSearchInput'

/*
 * 「他の目標武器で使用する所持武器を除外する」 on the Search screen (Issue #157 PR-4, `docs/UI_FLOW.md` 9.2 /
 * `docs/SEARCH_SPEC.md` 3.3). Presentation only: which weapons a search excluded is the Search Domain's result
 * (`TargetCandidateSearchResult.excludedSourceOwnedWeaponIds`), and why is the derivation recorded when that search's
 * input was prepared (`CandidateSearchSourceExclusionSnapshot`). Nothing here derives an exclusion, reads the current
 * screen state, or is persisted.
 */

/** The one Checkbox, used by the single search only (Issue #290, `docs/UI_FLOW.md` 9.2). */
export const SOURCE_EXCLUSION_CHECKBOX_LABEL = '他の目標武器で使用する所持武器を除外する'

export const SOURCE_EXCLUSION_DESCRIPTION =
  'ほかの目標武器の「優先する所持武器」と、作成リストに登録済みのほかの目標武器の候補が起点に使う所持武器を、作成ルートの起点にしません。新しく作成する通常アーティアと、ほかで使われていない所持武器は引き続き検索します。この目標武器の「優先する所持武器」だけを使う設定ではありません。'

/** Shown apart from the description: the batch never reads the Checkbox and always excludes. */
export const SOURCE_EXCLUSION_SINGLE_SEARCH_ONLY_NOTE =
  '※ このチェックは単体検索にのみ適用されます。一括検索・追加では、チェック状態に関係なく自動的に除外します。'

/** The condition a search or a batch ran with, in text so it never depends on colour. */
export function sourceExclusionConditionLabel(excludeOtherTargetSources: boolean): string {
  return `他の目標武器で使用する所持武器: ${excludeOtherTargetSources ? '除外する' : '除外しない'}`
}

/** Added to the condition of a search that excluded nothing (`docs/UI_FLOW.md` 9.2). */
export const SOURCE_EXCLUSION_NOTHING_EXCLUDED_NOTE = '（除外の対象になる所持武器はありませんでした）'

export const SOURCE_EXCLUSION_RESULT_TITLE = '所持武器の除外'

export function sourceExclusionResultMessage(count: number): string {
  return `他の目標武器で使用する所持武器（${count}本）を起点から除外して検索しました。`
}

export function sourceExclusionDisclosureTitle(count: number): string {
  return `除外した所持武器（${count}本）`
}

/**
 * Follows 「現在の探索範囲では理想品が見つかりませんでした…」 when a search that excluded weapons found no Ideal. It
 * never says an Ideal does not exist and never searches the excluded weapons again on its own.
 */
export function sourceExclusionNotFoundNote(count: number): string {
  return `この検索では、他の目標武器で使用する所持武器（${count}本）を起点から除外したため、それらの所持武器からの作成ルートは探していません。除外をOFFにして検索すると、それらの所持武器を起点にする候補が見つかる場合があります（他の目標武器と同じ所持武器を使う候補になります）。`
}

/** The batch summary's note beside a 「候補なし」 Target whose search excluded weapons. */
export function batchSourceExclusionCountNote(count: number): string {
  return `（除外した所持武器 ${count}本）`
}

const missingWeaponName = '（見つからない所持武器）'
const missingTargetName = '（見つからない目標武器）'

/** One reason a weapon was excluded, with the Target named as it was read when the search was prepared. */
export interface SourceExclusionReasonDisplay {
  kind: OtherTargetSourceUsageReason['kind']
  targetWeaponId: TargetWeaponId
  targetName: string
  /** The Entries behind a `build_list_entry_source` reason (Debug Mode only); empty for a preference. */
  buildListEntryIds: BuildListEntryId[]
}

export interface SourceExclusionWeaponDisplay {
  ownedWeaponId: OwnedWeaponId
  weaponName: string
  reasons: SourceExclusionReasonDisplay[]
}

/** What one displayed search excluded: its own condition, never the Checkbox the screen shows now. */
export interface SearchSourceExclusionDisplay {
  excludeOtherTargetSources: boolean
  /** The weapons the search really excluded, in the Owned Weapons display order (`docs/UI_FLOW.md` 3.2). */
  excludedWeapons: SourceExclusionWeaponDisplay[]
}

export function sourceExclusionReasonLabel(reason: Pick<SourceExclusionReasonDisplay, 'kind' | 'targetName'>): string {
  return reason.kind === 'preferred_owned_weapon'
    ? `目標武器「${reason.targetName}」の優先する所持武器`
    : `目標武器「${reason.targetName}」の作成リストの候補が起点に使用`
}

/** A record missing from the read sorts after every registered one, by ID (`compareByRegistrationOrder()`). */
function registrationKey(id: string, record: RegistrationOrdered | undefined): RegistrationOrdered {
  return record ?? { id, createdAt: '' }
}

/**
 * Builds the display of one search's exclusion from the IDs the Search Domain really excluded and the snapshot taken
 * when that search's input was prepared. A weapon the derivation named but the search did not exclude (another weapon
 * type, a RouteKind the route filter left out) is not shown; one reason repeated by several Entries of one Target (a
 * legacy duplicate) reads once. Weapons follow the Owned Weapons display order and reasons the Target Weapons display
 * order (registration order, `docs/UI_FLOW.md` 3.2 / 9.2), never the Domain's code unit order.
 */
export function createSearchSourceExclusionDisplay(
  excludeOtherTargetSources: boolean,
  excludedSourceOwnedWeaponIds: readonly OwnedWeaponId[],
  snapshot: CandidateSearchSourceExclusionSnapshot | null,
): SearchSourceExclusionDisplay {
  if (!excludeOtherTargetSources) return { excludeOtherTargetSources, excludedWeapons: [] }
  const usageById = new Map((snapshot?.exclusion.usages ?? []).map((usage) => [usage.ownedWeaponId, usage]))
  const weaponById = new Map((snapshot?.ownedWeapons ?? []).map((weapon) => [weapon.id, weapon]))
  const targetById = new Map((snapshot?.targetWeapons ?? []).map((target) => [target.id, target]))
  const compareTargets = (left: TargetWeaponId, right: TargetWeaponId) =>
    compareByRegistrationOrder(registrationKey(left, targetById.get(left)), registrationKey(right, targetById.get(right)))

  const excludedWeapons = [...new Set(excludedSourceOwnedWeaponIds)].map((ownedWeaponId): SourceExclusionWeaponDisplay => {
    const reasons: SourceExclusionReasonDisplay[] = []
    for (const reason of usageById.get(ownedWeaponId)?.reasons ?? []) {
      const existing = reasons.find(({ kind, targetWeaponId }) => kind === reason.kind && targetWeaponId === reason.targetWeaponId)
      const entryIds = reason.kind === 'build_list_entry_source' ? [reason.buildListEntryId] : []
      if (existing) {
        existing.buildListEntryIds.push(...entryIds)
        continue
      }
      reasons.push({
        kind: reason.kind,
        targetWeaponId: reason.targetWeaponId,
        targetName: targetById.get(reason.targetWeaponId)?.name ?? missingTargetName,
        buildListEntryIds: entryIds,
      })
    }
    // Stable: within one Target the preference keeps its place before an Entry.
    reasons.sort((left, right) => compareTargets(left.targetWeaponId, right.targetWeaponId))
    return {
      ownedWeaponId,
      weaponName: weaponById.get(ownedWeaponId)?.name ?? missingWeaponName,
      reasons,
    }
  })
  excludedWeapons.sort((left, right) =>
    compareByRegistrationOrder(
      registrationKey(left.ownedWeaponId, weaponById.get(left.ownedWeaponId)),
      registrationKey(right.ownedWeaponId, weaponById.get(right.ownedWeaponId)),
    ),
  )
  return { excludeOtherTargetSources, excludedWeapons }
}

function quotedNames(reasons: readonly SourceExclusionReasonDisplay[]): string {
  return reasons.map(({ targetName }) => `「${targetName}」`).join('、')
}

/**
 * The sentence the Issue #128 notice gains when the displayed search excluded the Target's preferred owned weapon
 * because another Target's Build List Candidate starts from it (`docs/UI_FLOW.md` 9). `null` unless that search ran with
 * the exclusion on, the Candidate does not start from the preferred weapon (the notice's own test), the Search really
 * excluded that weapon, and the search's snapshot records a Build List reason for it. Only the reasons recorded for
 * that weapon are named.
 */
export function describePreferredOwnedWeaponExclusion(
  candidate: BuildCandidate,
  target: TargetWeapon | null,
  display: SearchSourceExclusionDisplay | null | undefined,
): string | null {
  if (!display?.excludeOtherTargetSources) return null
  const preferredOwnedWeaponId = target?.preferredOwnedWeaponId ?? null
  if (preferredOwnedWeaponId === null || candidate.route.sourceOwnedWeaponId === preferredOwnedWeaponId) return null
  const weapon = display.excludedWeapons.find(({ ownedWeaponId }) => ownedWeaponId === preferredOwnedWeaponId)
  if (!weapon) return null
  const buildListReasons = weapon.reasons.filter(({ kind }) => kind === 'build_list_entry_source')
  if (buildListReasons.length === 0) return null
  // A preferred weapon is the preference of one Target only (`docs/DATA_MODEL.md` 8.5), so this clause is normally
  // absent; it is named only if the recorded reasons really say so.
  const preferenceReasons = weapon.reasons.filter(({ kind }) => kind === 'preferred_owned_weapon')
  const clauses = [`目標武器${quotedNames(buildListReasons)}の作成リストの候補が起点に使用しているため`]
  if (preferenceReasons.length > 0) clauses.push(`目標武器${quotedNames(preferenceReasons)}の優先する所持武器であるため`)
  return `この検索では、優先する所持武器を起点から除外しました（${clauses.join('、また')}）。`
}
