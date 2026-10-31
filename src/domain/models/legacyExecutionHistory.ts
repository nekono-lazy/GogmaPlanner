import type {
  ExecutionAction,
  ExecutionHistoryId,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeaponId,
  PlanStepId,
  ProductionPlanId,
  RecalculationReason,
  RngState,
} from './common'
import type { OwnedWeapon, TargetWeapon } from './entities'
import type { ActualResult, ExecutionSavePoint, ProductionPlan } from './planning'

/**
 * An ExecutionHistory record of the shape Dexie version 10 and Export schema
 * 13 persisted (`docs/DATA_MODEL.md` 12 before Issue #312): the metadata and
 * its Undo snapshot in one record, the snapshot holding the whole Plan before
 * the Step.
 *
 * Only a migration input: the Dexie version(11) upgrade and the Export schema
 * 13 -> 14 migration convert it (`docs/DATA_MODEL.md` 14.2) and no runtime
 * writes it. A record the upgrade could not convert stays in this shape and is
 * never read as ordinary metadata.
 */
export interface LegacyExecutionHistory {
  id: ExecutionHistoryId
  planId: ProductionPlanId
  planStepId: PlanStepId
  action: ExecutionAction
  actualResult: ActualResult | null
  wasExpected: boolean
  recalculationReason: RecalculationReason | null
  undoSnapshot: LegacyExecutionUndoSnapshot
  createdAt: ISODateTimeString
}

/** The Undo snapshot of a `LegacyExecutionHistory`. */
export interface LegacyExecutionUndoSnapshot {
  rngStateBefore: RngState
  normalCountersBefore: NormalArtianCounter[]
  affectedOwnedWeaponsBefore: OwnedWeapon[]
  addedOwnedWeaponIds: OwnedWeaponId[]
  removedOwnedWeaponsBefore: OwnedWeapon[]
  affectedTargetWeaponsBefore: TargetWeapon[]
  productionPlanBefore: ProductionPlan
  executionSavePointBefore: ExecutionSavePoint | null
}
