import type {
  BuildListEntryId,
  OwnedWeaponId,
} from '../models/publicTypes'
import { hashStableValue } from '../models/publicTypes'

interface ConflictSemanticBase {
  buildListEntryIds: BuildListEntryId[]
}

export type PlanConflictSemantic =
  | (ConflictSemanticBase & {
      kind: 'same_gogma_counter'
      gogmaCounter: number
    })
  | (ConflictSemanticBase & {
      kind: 'same_skill_counter'
      skillCounter: number
    })
  | (ConflictSemanticBase & {
      kind: 'same_normal_counter'
      normalCounterId: string
      normalCounter: number
    })
  | (ConflictSemanticBase & {
      kind: 'same_owned_weapon_consumed'
      ownedWeaponId: OwnedWeaponId
    })

function sortedEntryIds(ids: readonly BuildListEntryId[]): BuildListEntryId[] {
  return [...new Set(ids)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
}

/** Stable PlanConflict.id; deliberately independent from PlannerIdFactory. */
export function createPlanConflictId(conflict: PlanConflictSemantic): string {
  const buildListEntryIds = sortedEntryIds(conflict.buildListEntryIds)
  let semantic: Record<string, unknown>
  switch (conflict.kind) {
    case 'same_gogma_counter':
      semantic = {
        kind: conflict.kind,
        gogmaCounter: conflict.gogmaCounter,
        buildListEntryIds,
      }
      break
    case 'same_skill_counter':
      semantic = {
        kind: conflict.kind,
        skillCounter: conflict.skillCounter,
        buildListEntryIds,
      }
      break
    case 'same_normal_counter':
      semantic = {
        kind: conflict.kind,
        normalCounterId: conflict.normalCounterId,
        normalCounter: conflict.normalCounter,
        buildListEntryIds,
      }
      break
    case 'same_owned_weapon_consumed':
      semantic = {
        kind: conflict.kind,
        ownedWeaponId: conflict.ownedWeaponId,
        buildListEntryIds,
      }
      break
  }
  return `plan-conflict:${hashStableValue(semantic)}`
}
