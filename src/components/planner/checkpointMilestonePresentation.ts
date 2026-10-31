import type { CompromiseConditionMatch, TargetWeaponId } from '../../domain/models/publicTypes'

/**
 * The read-only Presentation of a legacy Step's `checkpointMilestones`
 * (Issue #336 PR-2, `docs/PLANNER_SPEC.md` 20.8, `docs/DATA_MODEL.md` 11.3).
 *
 * Issue #100 abolished the compromise checkpoints, so no current Plan reaches
 * one; a historical Plan may still carry the milestones its own calculation
 * schema wrote, in one of two shapes:
 *
 * ```text
 * schema 10      { buildListEntryId, targetWeaponId, checkpointGroupId, checkpointOpportunityId, remainingOperationCount }
 * schema 11..18  { buildListEntryId, targetWeaponId, skillOpportunityId, bonusOpportunityId, conditionMatch, remainingOperationCount }
 * ```
 *
 * The Plan validation checks neither shape (`docs/DATA_MODEL.md` 11.3 / 11.8),
 * so the screen reads the persisted value defensively: it shows what the
 * record certainly carries (the Target, the remaining operation count, the
 * identifiers in Debug Mode), omits the two-axis judgement where the record has
 * none (schema 10) or an unreadable one, and names a record of no readable
 * shape without hiding it. Nothing is inferred - no `conditionMatch` is
 * completed, no count is guessed - and nothing is written back.
 */

const BONUS_MATCHES: readonly CompromiseConditionMatch['bonus'][] = ['ideal', 'practical', 'alternative']
const SKILL_MATCHES: readonly CompromiseConditionMatch['skill'][] = ['ideal', 'practical']

/** One raw identifier of a milestone record, for Debug Mode only. */
export interface CheckpointMilestoneIdentifier {
  label: string
  value: string
}

export type CheckpointMilestoneView =
  | {
      kind: 'milestone'
      targetWeaponId: TargetWeaponId
      /** `null` when the record carries no readable two-axis judgement (every schema 10 milestone). */
      conditionMatch: CompromiseConditionMatch | null
      /** `null` when the record carries no non-negative integer count. */
      remainingOperationCount: number | null
      /** The persisted identifiers the record carries, in a fixed order (Debug Mode). */
      identifiers: CheckpointMilestoneIdentifier[]
    }
  /** An element that is not an object naming a Target: listed as such, never dropped or reinterpreted. */
  | { kind: 'unreadable' }

export type CheckpointMilestonesView =
  /** `undefined` (a Plan predating the field) or `[]`: no section. */
  | { kind: 'none' }
  /** The field is present but not an array: the section says the record cannot be read. */
  | { kind: 'unreadable' }
  | { kind: 'listed'; milestones: CheckpointMilestoneView[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readConditionMatch(value: unknown): CompromiseConditionMatch | null {
  if (!isRecord(value)) return null
  const { bonus, skill } = value
  if (!BONUS_MATCHES.includes(bonus as CompromiseConditionMatch['bonus'])) return null
  if (!SKILL_MATCHES.includes(skill as CompromiseConditionMatch['skill'])) return null
  return { bonus: bonus as CompromiseConditionMatch['bonus'], skill: skill as CompromiseConditionMatch['skill'] }
}

/**
 * The identifiers in the order the schema 11..18 Debug line showed them,
 * followed by the schema 10 ones; a `null` lane id reads `ideal` as before
 * (the lane end was held), and an absent field is simply not listed.
 */
function readIdentifiers(record: Record<string, unknown>): CheckpointMilestoneIdentifier[] {
  const identifiers: CheckpointMilestoneIdentifier[] = []
  const add = (label: string, field: string, nullValue: string | null) => {
    if (!(field in record)) return
    const value = record[field]
    if (typeof value === 'string') identifiers.push({ label, value })
    else if (value === null && nullValue !== null) identifiers.push({ label, value: nullValue })
  }
  add('BuildListEntry ID', 'buildListEntryId', null)
  add('skill', 'skillOpportunityId', 'ideal')
  add('bonus', 'bonusOpportunityId', 'ideal')
  add('checkpointGroupId', 'checkpointGroupId', null)
  add('checkpointOpportunityId', 'checkpointOpportunityId', null)
  return identifiers
}

/** Reads one persisted `checkpointMilestones` value (any shape) for display. Never throws. */
export function describeCheckpointMilestones(value: unknown): CheckpointMilestonesView {
  if (value === undefined) return { kind: 'none' }
  if (!Array.isArray(value)) return { kind: 'unreadable' }
  if (value.length === 0) return { kind: 'none' }
  return {
    kind: 'listed',
    milestones: value.map((element): CheckpointMilestoneView => {
      if (!isRecord(element) || typeof element.targetWeaponId !== 'string') return { kind: 'unreadable' }
      const count = element.remainingOperationCount
      return {
        kind: 'milestone',
        targetWeaponId: element.targetWeaponId as TargetWeaponId,
        conditionMatch: readConditionMatch(element.conditionMatch),
        remainingOperationCount: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null,
        identifiers: readIdentifiers(element),
      }
    }),
  }
}
