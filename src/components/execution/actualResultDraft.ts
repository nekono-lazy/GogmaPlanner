import type { ExecutionActualResultObservation } from '../../domain/execution'
import type { GroupSkillId, RestorationBonusSet, SeriesSkillId } from '../../domain/models/publicTypes'
import type { ActualResultInputKind } from './executionStepPresentation'

/**
 * One Skill as the user saw it: not entered yet, explicitly none, or a Master
 * Skill. 「未入力」 and 「スキルなし」 stay distinct, so a `null` actual Skill is
 * only ever sent when the user chose it.
 */
export type ActualSkillChoice = { status: 'unset' } | { status: 'none' } | { status: 'skill'; id: string }

/** The draft of the actual result form, kept by the caller so a refusal loses no input. */
export interface ActualResultDraft {
  slots: RestorationBonusSet
  series: ActualSkillChoice
  group: ActualSkillChoice
}

/** Five unfilled slots and unset Skills: the actual result never starts from a fabricated or expected value. */
export function emptyActualResultDraft(): ActualResultDraft {
  return {
    slots: Array.from({ length: 5 }, () => ({ bonusTypeId: '', bonusRankId: '' })) as RestorationBonusSet,
    series: { status: 'unset' },
    group: { status: 'unset' },
  }
}

function skillValue(choice: ActualSkillChoice | null): string | null {
  if (choice === null || choice.status === 'unset') return null
  return choice.status === 'none' ? null : choice.id
}

/**
 * The runtime observation the draft stands for, or `null` while it is
 * incomplete. Only the fields the operation's result contract has are read.
 */
export function actualResultFromDraft(
  kind: ActualResultInputKind,
  draft: ActualResultDraft,
): ExecutionActualResultObservation | null {
  if (kind.kind === 'restoration_bonuses') {
    const complete = draft.slots.every(({ bonusTypeId, bonusRankId }) => bonusTypeId !== '' && bonusRankId !== '')
    return complete
      ? {
          kind: 'restoration_bonuses',
          restorationBonuses: structuredClone(draft.slots),
          restorationBonusScope: kind.scope,
        }
      : null
  }
  if (draft.series.status === 'unset' || draft.group.status === 'unset') return null
  return {
    kind: 'skills',
    seriesSkillId: skillValue(draft.series) as SeriesSkillId | null,
    groupSkillId: skillValue(draft.group) as GroupSkillId | null,
  }
}
