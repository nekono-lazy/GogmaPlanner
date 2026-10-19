import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildCandidate,
  IntermediateStateOpportunityId,
  IntermediateStateSelection,
} from '../../domain/models/publicTypes'
import { improvementPreferenceLabels } from '../../presentation/labels'
import { BuildListCardinalityError } from '../../services/buildList/buildListService'
import { groupSkillLabel, intermediateOpportunityLabel, seriesSkillLabel } from './searchPresentation'

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
export const BUILD_LIST_REPLACEMENT_NOT_CARRIED_TITLE = '引き継がれない設定'
export const BUILD_LIST_REPLACEMENT_NOT_CARRIED_NOTE =
  '現在の候補で設定している「途中採用する状態」と「改善優先」は、新しい候補に引き継がれません。新しい候補には、この画面で選択している内容が登録されます。'
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

/** One lane of an intermediate state selection, in the user's words. */
export interface IntermediateStateSelectionSummary {
  skill: string
  bonus: string
  improvementPreference: string
}

const UNSELECTED_LANE = '未選択（理想品まで進む）'
const UNKNOWN_OPPORTUNITY = '候補の記録と一致しない状態'

function laneSummary(
  candidate: BuildCandidate,
  id: IntermediateStateOpportunityId | null,
  master: MasterDataRoot,
): string {
  if (id === null) return UNSELECTED_LANE
  for (const group of candidate.intermediateStateGroups ?? []) {
    const opportunity = group.opportunities.find((candidateOpportunity) => candidateOpportunity.id === id)
    if (opportunity === undefined) continue
    const position = intermediateOpportunityLabel(candidate, opportunity)
    return group.axis === 'skill'
      ? `${position}（シリーズ: ${seriesSkillLabel(group.seriesSkillId, master)} ／ グループ: ${groupSkillLabel(group.groupSkillId, master)}）`
      : position
  }
  return UNKNOWN_OPPORTUNITY
}

/**
 * A read-only summary of one intermediate state selection against the
 * Candidate it belongs to. Presentation only: the stored opportunity ids are
 * looked up in the Candidate's own recorded groups, and an id the Candidate
 * does not record is named as such rather than read as "unselected".
 */
export function summarizeIntermediateStateSelection(
  candidate: BuildCandidate,
  selection: IntermediateStateSelection,
  master: MasterDataRoot,
): IntermediateStateSelectionSummary {
  return {
    skill: laneSummary(candidate, selection.skillOpportunityId, master),
    bonus: laneSummary(candidate, selection.bonusOpportunityId, master),
    improvementPreference:
      improvementPreferenceLabels[selection.improvementPreference] ?? selection.improvementPreference,
  }
}

/**
 * A replacement the Build List Service refused by typed code, in the user's
 * words. `null` means the error is not a cardinality refusal and is reported
 * as any other failure. No message text is parsed.
 */
export function buildListCardinalityRefusalMessage(caught: unknown): string | null {
  return caught instanceof BuildListCardinalityError ? caught.message : null
}
