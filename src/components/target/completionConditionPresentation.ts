import type {
  BonusRankId,
  BuildListEntry,
  CompletionConditionReviewReason,
  RestorationBonus,
  RestorationBonusScope,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import {
  satisfiedCompletionBonusVariants,
  type CompletionVariantConflict,
} from '../../domain/target/completionCondition'
import type { TargetEvaluationMasterSubset } from '../../domain/target/targetEvaluationTypes'

/**
 * The words of the Target completion condition (`docs/UI_FLOW.md` 8 / 8.4,
 * Issue #100). Presentation only: no judgement is made here. A conflict is
 * always the Domain's `findCompletionVariantConflicts()` result, and the
 * Variants a weapon achieves are always the Domain's
 * `satisfiedCompletionBonusVariants()` result, never one computed here.
 */

/**
 * Which completion Variants of a Target one concrete five-slot result
 * satisfies, judged at display time (`docs/REQUIREMENTS.md` 13.2).
 *
 * - `achieved`: every satisfied Variant, named by its place in the current
 *   Target (「完成構成2」). The numbers only name Variants: they are listed in
 *   the Target's own order and carry no preference
 * - `not_achieved`: the result satisfies no Variant of the current Target
 *   (a `normal_artian` scope included) - for a kept Candidate, the current
 *   condition is no longer the one it was found for
 * - `unavailable`: there is no Target to judge against, or the judgement
 *   failed (an unknown Master reference); nothing is claimed either way
 *
 * Nothing here is persisted, and no Variant ID is written anywhere.
 */
export type AchievedCompletionVariants =
  | { kind: 'achieved'; headings: string[] }
  | { kind: 'not_achieved' }
  /** `result_missing`: the concrete result itself (a Plan's completing Entry) cannot be found. */
  | { kind: 'unavailable'; reason: 'target_missing' | 'result_missing' | 'evaluation_failed' }

export function describeAchievedCompletionVariants(
  target: Pick<TargetWeapon, 'completionBonusVariants'> | null,
  bonuses: readonly RestorationBonus[],
  scope: RestorationBonusScope,
  master: TargetEvaluationMasterSubset,
): AchievedCompletionVariants {
  if (target === null) return { kind: 'unavailable', reason: 'target_missing' }
  let satisfied: ReturnType<typeof satisfiedCompletionBonusVariants>
  try {
    satisfied = satisfiedCompletionBonusVariants(target, bonuses, scope, master)
  } catch {
    return { kind: 'unavailable', reason: 'evaluation_failed' }
  }
  if (satisfied.length === 0) return { kind: 'not_achieved' }
  const achieved = new Set(satisfied)
  return {
    kind: 'achieved',
    headings: target.completionBonusVariants.flatMap((variant, index) =>
      achieved.has(variant) ? [completionVariantHeading(index)] : [],
    ),
  }
}

/**
 * The achieved Variants of what one Build List Entry completes: its Candidate
 * Snapshot's finished slots and scope - the completion result a Plan confirms
 * (`docs/REQUIREMENTS.md` 13.2 / 25) - against the given Target. Nothing is
 * reconstructed from a Route or a PlanStep; a missing Entry says so.
 */
export function describeEntryAchievedCompletionVariants(
  entry: Pick<BuildListEntry, 'candidateSnapshot'> | null | undefined,
  target: Pick<TargetWeapon, 'completionBonusVariants'> | null | undefined,
  master: TargetEvaluationMasterSubset,
): AchievedCompletionVariants {
  if (target === null || target === undefined) return { kind: 'unavailable', reason: 'target_missing' }
  if (entry === null || entry === undefined) return { kind: 'unavailable', reason: 'result_missing' }
  const { finalBonuses, restorationBonusScope } = entry.candidateSnapshot
  return describeAchievedCompletionVariants(target, finalBonuses, restorationBonusScope, master)
}

/** The label of the achieved Variants wherever a concrete result is shown. */
export const ACHIEVED_COMPLETION_VARIANTS_LABEL = '達成した完成構成'

/** The words of `describeAchievedCompletionVariants()`; the state is always in text, never colour alone. */
export function achievedCompletionVariantsText(achieved: AchievedCompletionVariants): string {
  switch (achieved.kind) {
    case 'achieved':
      return achieved.headings.join('、')
    case 'not_achieved':
      return '現在の完成条件では満たしません'
    case 'unavailable':
      return achieved.reason === 'target_missing'
        ? '目標武器が見つからないため確認できません'
        : achieved.reason === 'result_missing'
          ? '完成時の復元ボーナスが見つからないため確認できません'
          : '完成構成を確認できません'
  }
}

/** Said under 「現在の完成条件では満たしません」 for a result kept from an earlier calculation. */
export const ACHIEVED_COMPLETION_VARIANTS_NOT_ACHIEVED_NOTE =
  'この結果が作られた後に、目標武器の完成条件が変更された可能性があります。'

/** The chip a Target whose completion condition needs review carries (text, never colour alone). */
export const COMPLETION_CONDITION_REVIEW_CHIP_LABEL = '完成条件の再設定が必要'

/** Why the review is needed, one line per recorded reason (`docs/UI_FLOW.md` 8.4). */
export const completionConditionReviewReasonLabels: Record<CompletionConditionReviewReason, string> = {
  compromise_conditions_removed: '移行で旧条件（実用・代替・実用スキル）を削除しました',
  skill_condition_normalized: 'スキル条件を「すべて満たす」として保存しました',
}

/** What the edit dialog asks the user to do for each reason (`docs/UI_FLOW.md` 8.4). */
export const completionConditionReviewGuidance: Record<CompletionConditionReviewReason, string> = {
  compromise_conditions_removed:
    '旧仕様の実用・代替・実用スキルの条件は、新しい完成条件では使えないため削除しました。より低いランクでも完成としてよい枠は、その枠の最低ランクを下げてください。別の種類のボーナスを含む構成でも完成としてよい場合は、その構成を「完成ボーナス構成」に追加してください。',
  skill_condition_normalized:
    '旧条件の「どちらか一方を満たす」は新しい完成条件では使えません。現在は、指定したシリーズスキルとグループスキルを「すべて満たす」条件として設定しています。「完成スキル条件」で、シリーズ・グループの指定を確認してください。',
}

/** Where in the edit dialog each reason asks the user to look: the section it names. */
export const completionConditionReviewSectionNotes: Record<CompletionConditionReviewReason, string> = {
  compromise_conditions_removed:
    '再設定: 旧条件（実用・代替・実用スキル）は削除されました。低いランクでもよい枠は最低ランクを下げ、別の種類を含む構成でもよい場合は構成を追加してください。',
  skill_condition_normalized:
    '再設定: 旧条件の「どちらか一方」は使えないため、「すべて満たす」として設定しています。指定を確認してください。',
}

/** The dialog's review summary heading and lead (`docs/UI_FLOW.md` 8.4). */
export const COMPLETION_CONDITION_REVIEW_DIALOG_TITLE = '完成条件の再設定が必要です'
export const COMPLETION_CONDITION_REVIEW_DIALOG_LEAD =
  '完成条件の仕様変更に伴う自動移行で、この目標武器の条件が変わりました。次の点を確認してください。'

/** Said with the review guidance: saving is what clears it, closing keeps it. */
export const COMPLETION_CONDITION_REVIEW_SAVE_NOTE =
  '内容を確認して「保存」すると、この案内は消え、候補検索や生産計画の対象に戻ります。保存せずに閉じた場合は、再設定が必要な状態のまま残ります。'

/** The list item's hint below the review reasons. */
export const COMPLETION_CONDITION_REVIEW_LIST_HINT = '「編集」で内容を確認して保存すると解除されます。'

/** The list-level notice above the active Targets while any of them needs review. */
export function completionConditionReviewListNotice(count: number): string {
  return `完成条件の再設定が必要な目標武器が${count}件あります。各目標武器の「編集」で内容を確認して保存するまで、候補検索や生産計画の対象になりません。`
}

/** The display-only list filter (`docs/UI_FLOW.md` 8.4). */
export const COMPLETION_CONDITION_REVIEW_FILTER_LABEL = '完成条件の再設定が必要な目標武器だけ表示'

/** Explains the Variants beside the editor (`docs/UI_FLOW.md` 8). */
export const COMPLETION_VARIANTS_HELP_TEXT =
  'いずれかの構成を満たせば完成です。構成の間に優先順位はなく、並び順にも意味はありません。'

/** How one slot reads: the type must match, the rank may be higher (`docs/REQUIREMENTS.md` 10). */
export const COMPLETION_VARIANTS_MINIMUM_RANK_HELP_TEXT =
  '各枠は、ボーナスの種類が一致し、ランクが最低ランク以上なら満たします（例: 最低ランク「III以上」の枠は、同じ種類のEXでも満たします）。枠の並び順は問いません。同じ種類・同じ最低ランクを複数の枠に指定できます。'

/** The difference between 「新しい構成を追加」 and 「この構成を複製」. */
export const COMPLETION_VARIANTS_ADD_HELP_TEXT =
  '「新しい構成を追加」は初期値（すべての枠が同じボーナス）から始まります。目標に合わせて5枠を選び直してください。一部の枠だけが異なる構成を作るときは、元にする構成の「この構成を複製」を使います。'

export const COMPLETION_VARIANTS_MINIMUM_NOTE = '完成ボーナス構成は1件以上必要です。'

/** A Variant's heading: Variants carry no order of preference, the number only names them. */
export function completionVariantHeading(index: number): string {
  return `完成構成${index + 1}`
}

/**
 * Whether a Bonus Rank is the highest one in Master order (Issue #353): every
 * other rank of `master.bonusRanks` has a strictly lower `order`. That is the
 * whole set the completion judgement compares ranks against (Domain
 * `bonusRankOrder()`), whatever its scope, weapon type, Production availability
 * or `isEnabled`, so no actual rank can exceed a minimum of the highest rank.
 * An unknown ID, or an `order` another rank shares, is never the highest.
 * `isEx`, display names and IDs decide nothing (`docs/MASTER_DATA.md` 7).
 */
export function isHighestBonusRank(bonusRankId: BonusRankId, master: Pick<TargetEvaluationMasterSubset, 'bonusRanks'>): boolean {
  const rank = master.bonusRanks.find(({ id }) => id === bonusRankId)
  if (!rank) return false
  return master.bonusRanks.every((other) => other.id === rank.id || other.order < rank.order)
}

/**
 * One minimum-rank slot label (`docs/UI_FLOW.md` 8): 「基礎攻撃力強化III以上」, and
 * the label alone for the highest rank (「基礎攻撃力強化EX」), which no rank can
 * exceed. The words only: the minimum rank and how it is judged do not change.
 */
export function minimumRankSlotLabel(
  slotLabel: string,
  bonusRankId: BonusRankId,
  master: Pick<TargetEvaluationMasterSubset, 'bonusRanks'>,
): string {
  return isHighestBonusRank(bonusRankId, master) ? slotLabel : `${slotLabel}以上`
}

/** The short state of a Variant that cannot be saved, next to its heading (text, never colour alone). */
export function completionVariantConflictBadge(conflict: CompletionVariantConflict, justDuplicated = false): string {
  if (justDuplicated) return '複製直後・保存できません'
  return conflict.kind === 'duplicate' ? '重複・保存できません' : '包含・保存できません'
}

/** One line of the conflict summary: the Variant and the other Variant it conflicts with. */
export function completionVariantConflictShortReason(conflict: CompletionVariantConflict): string {
  const self = completionVariantHeading(conflict.index)
  const other = completionVariantHeading(conflict.otherIndex)
  return conflict.kind === 'duplicate' ? `${self}: ${other}と同じ内容` : `${self}: ${other}に含まれる`
}

/**
 * The reason and the way out for one conflicting Variant. `justDuplicatedFrom`
 * is the index of the Variant it was duplicated from while it is still that
 * very duplicate: the expected state right after 「この構成を複製」, said as such.
 */
export function completionVariantConflictMessage(
  conflict: CompletionVariantConflict,
  justDuplicatedFrom: number | null = null,
): string {
  const self = completionVariantHeading(conflict.index)
  const other = completionVariantHeading(conflict.otherIndex)
  if (conflict.kind === 'duplicate') {
    if (justDuplicatedFrom === conflict.otherIndex) {
      return `${self}は${other}を複製した直後のため、${other}と同じ内容です。このままでは保存できません。一部の枠の種類か最低ランクを変更してください。`
    }
    return `${self}は${other}と同じ内容です（枠の並び順だけが異なる構成も同じ内容です）。このままでは保存できません。枠を変更するか、不要な方を削除してください。`
  }
  return `${self}は${other}に含まれるため保存できません。${self}を満たす武器はすべて${other}も満たすので、${self}を登録しても完成になる武器は増えません。不要なら${self}を削除し、残す場合は${other}を満たさない武器も受け付ける内容に変更してください。`
}

/**
 * The save validation issues as the Target dialog shows them. The issues are
 * the Service's own (`path: message`); only the display changes: an issue
 * repeated by two validations is shown once, and a completion Variant issue,
 * whose message already names its Variant (「完成構成3は…」), drops the internal
 * `completionBonusVariants[n]` path. Nothing is judged here.
 */
export function targetFormValidationIssuesText(issues: readonly string[]): string {
  return [...new Set(issues.map((issue) => issue.replace(/^completionBonusVariants(?:\[\d+\])?: /, '')))].join(' / ')
}

/** The summary above the Variants while any of them cannot be saved. */
export function completionVariantConflictSummary(count: number): string {
  return `保存できない完成構成が${count}件あります。`
}
