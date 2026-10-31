import { BuildListCardinalityError } from '../../services/buildList/buildListService'

/**
 * The words of the Search screen's Build List replacement
 * (`docs/UI_FLOW.md` 9, `docs/DATA_MODEL.md` 9.4.1). The confirmation names a
 * replacement of the Target's one registered Candidate, never an overwrite, an
 * update or an addition.
 */
export const BUILD_LIST_REPLACEMENT_TITLE = '作成リストの候補を置き換えますか？'
export const BUILD_LIST_REPLACEMENT_LEAD =
  '作成リストは目標武器ごとに候補を1件だけ登録します。「置き換える」を選ぶと、現在の候補を作成リストから外し、新しい候補を登録します。'
export const BUILD_LIST_REPLACEMENT_CURRENT_HEADING = '現在の候補'
export const BUILD_LIST_REPLACEMENT_NEW_HEADING = '新しい候補'
export const BUILD_LIST_REPLACEMENT_CONFIRM_LABEL = '置き換える'
/** The operation-specific line under the breaking-change warning (`docs/UI_FLOW.md` 16.3). */
export const BUILD_LIST_REPLACEMENT_PLAN_BREAKING_NOTE =
  '作成リストの候補を置き換えると、現在の生産計画の前提と一致しなくなります。'
export const BUILD_LIST_REPLACED_MESSAGE = '作成リストの候補を置き換えました。'
export const BUILD_LIST_REPLACED_PLAN_ABANDONED_MESSAGE =
  '作成リストの候補を置き換え、実行中の生産計画を破棄しました。'
/**
 * A Target already holding two or more Entries (a legacy duplicate): the Search
 * screen neither adds nor replaces, and never picks which Entry to keep. The
 * words are the Service's own refusal of the same state.
 */
export const BUILD_LIST_LEGACY_DUPLICATE_MESSAGE = new BuildListCardinalityError('legacy_duplicate_entries').message
export const BUILD_LIST_LEGACY_DUPLICATE_LINK_LABEL = 'ビルドリストで整理する'
/** Offered beside a refused replacement: the Build List shows the Target's current Entries. */
export const BUILD_LIST_CHECK_LINK_LABEL = 'ビルドリストを確認する'

/**
 * A replacement the Build List Service refused by typed code, in the user's
 * words. `null` means the error is not a cardinality refusal and is reported
 * as any other failure. No message text is parsed.
 */
export function buildListCardinalityRefusalMessage(caught: unknown): string | null {
  return caught instanceof BuildListCardinalityError ? caught.message : null
}
