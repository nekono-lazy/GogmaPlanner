import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  AppSettings,
  BuildCandidate,
  BuildListEntry,
  BuildRoute,
  ExecutionHistory,
  ExecutionSavePoint,
  ExportRoot,
  NormalArtianCounter,
  OwnedWeapon,
  ProductionPlan,
  RestorationBonus,
  SkillCondition,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import {
  collectReferencedOwnedWeaponIds,
  EXPORT_APP_NAME,
  validateAppSettings,
  validateBuildCandidate,
  validateBuildListEntry,
  validateCurrentExportRoot,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '../../domain/models/publicTypes'
import { validateTargetPreferredOwnedWeapons } from '../../domain/target/preferredOwnedWeapon'
import { validateTargetIdealImpliesPractical } from '../../domain/target/targetInvariantValidation'
import { collectProductionPlanDependentTargetWeaponIds } from '../../domain/planner/productionPlanGeneration'
import { isRunningProductionPlanStatus } from '../../db/repositories/productionPlanRepository'

/*
 * Full-replacement Import validation of a current-schema Export root
 * (`docs/DATA_MODEL.md` 15.2, `docs/REQUIREMENTS.md` 30).
 *
 * `prepareExportRootForImport()` is the schema migration authority and already
 * validates the Execution lifecycle state and the root-level RNG persistent
 * state. This module adds what a whole-database replacement needs on top of it
 * and never repeats or replaces that migration chain:
 *
 * - the entity validation of every collection it leaves out (BuildCandidate,
 *   BuildListEntry, AppSettings) and the Target Ideal => Practical containment
 * - primary ID uniqueness inside every top-level collection
 * - the running-Plan collection invariant (at most one active / stale Plan)
 *   and the independent Draft collection invariant (at most one draft Plan)
 * - the formal persisted references between collections, including every
 *   BuildListEntry / TargetWeapon reference of an `active` ProductionPlan
 *   (a `draft` / `stale` / `completed` / `abandoned` Plan body is not read as
 *   current foreign keys, see `productionPlanReferenceIssues()`), the Plan
 *   lifecycle an in-progress weapon or a game save point may name, and the
 *   current entities a game save point's snapshot Plan needs
 * - the collection-level Target preference contract
 * - the existence of every persisted Master ID in the current Master Data
 *
 * Everything here is pure and never throws on untrusted input: a malformed
 * nested body becomes an `invalid_structure` issue.
 */

/** The Master collections whose IDs persisted user data can carry. */
export type ImportMasterSubset = Pick<
  MasterDataRoot,
  | 'weaponTypes'
  | 'elements'
  | 'bonusTypes'
  | 'bonusRanks'
  | 'seriesSkills'
  | 'groupSkills'
  | 'materials'
>

type MasterReferenceKind =
  | 'weaponTypeId'
  | 'elementId'
  | 'bonusTypeId'
  | 'bonusRankId'
  | 'seriesSkillId'
  | 'groupSkillId'
  | 'materialId'

interface MasterReference {
  kind: MasterReferenceKind
  id: unknown
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(
  path: string,
  code: DomainValidationIssue['code'],
  message: string,
): DomainValidationIssue {
  return { path, code, message }
}

function prefixed(prefix: string, nested: DomainValidationResult): DomainValidationIssue[] {
  return nested.issues.map((entry) => ({
    ...entry,
    path: entry.path
      ? `${prefix}${entry.path.startsWith('[') ? '' : '.'}${entry.path}`
      : prefix,
  }))
}

/**
 * The typed Domain validators trust the declared entity shape. Import input is
 * untrusted, so a nested value of the wrong type must become an issue rather
 * than an exception escaping to the caller.
 */
function guarded(path: string, validate: () => DomainValidationIssue[]): DomainValidationIssue[] {
  try {
    return validate()
  } catch {
    return [issue(path, 'invalid_structure', `${path || 'Export root'} has a malformed nested structure.`)]
  }
}

function collectionShapeIssues(root: Record<string, unknown>, field: string): DomainValidationIssue[] {
  const value = root[field]
  if (!Array.isArray(value)) {
    return [issue(field, 'invalid_structure', `${field} must be an array.`)]
  }
  return value.flatMap((element: unknown, index) =>
    isRecord(element) ? [] : [issue(`${field}[${index}]`, 'invalid_structure', `${field}[${index}] must be an object.`)])
}

const ENTITY_COLLECTIONS = [
  'normalArtianCounters',
  'ownedWeapons',
  'targetWeapons',
  'buildCandidates',
  'buildListEntries',
  'productionPlans',
  'executionHistory',
  'executionSavePoints',
] as const

/**
 * Every top-level entity collection is a set keyed by its primary ID. A
 * duplicate must be refused here: a `bulkPut` would silently keep the last
 * record and a `bulkAdd` would fail only inside the write transaction.
 */
function duplicateIdIssues(root: ExportRoot): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = []
  ENTITY_COLLECTIONS.forEach((field) => {
    const seen = new Set<string>()
    ;(root[field] as readonly { id: string }[]).forEach((record, index) => {
      if (seen.has(record.id)) {
        issues.push(issue(`${field}[${index}].id`, 'invalid_id', `${field} には同じIDのrecordが複数あります: ${record.id}`))
      }
      seen.add(record.id)
    })
  })
  return issues
}

function idSet(records: readonly { id: string }[]): Set<string> {
  return new Set(records.map(({ id }) => id))
}

function routeOwnedWeaponReferenceIssues(
  route: BuildRoute,
  path: string,
  ownedWeaponIds: ReadonlySet<string>,
): DomainValidationIssue[] {
  return collectReferencedOwnedWeaponIds(route)
    .filter((id) => !ownedWeaponIds.has(id))
    .map((id) => issue(`${path}.route`, 'invalid_reference', `Routeが参照する所持武器が存在しません: ${id}`))
}

/**
 * One BuildListEntry reference a persisted Plan carries, with the Target the
 * same field names when the generating authority derived that Target from the
 * Entry (`entry.targetWeaponId`: PlanStep primary Target, checkpoint milestone,
 * Target link, Target completion).
 */
interface PlanBuildListEntryReference {
  id: unknown
  path: string
  targetWeaponId?: unknown
}

/**
 * Every BuildListEntry reference of a persisted ProductionPlan: the selected
 * Entries, each Step's Entry, milestone, Target link, compromise label and
 * Target completion, each conflict's participants / recommendation / selection
 * / checkpoint participants, and the rejected Entries (with the Target their
 * record names, Issue #121). Fields a legacy Plan does not carry are simply
 * absent; every field is read defensively.
 */
function planBuildListEntryReferences(plan: ProductionPlan, path: string): PlanBuildListEntryReference[] {
  const references: PlanBuildListEntryReference[] = []
  const add = (id: unknown, refPath: string, targetWeaponId?: unknown) => {
    if (id !== null && id !== undefined) references.push({ id, path: refPath, targetWeaponId })
  }
  if (Array.isArray(plan.selectedBuildListEntryIds)) {
    plan.selectedBuildListEntryIds.forEach((id, index) => add(id, `${path}.selectedBuildListEntryIds[${index}]`))
  }
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((step, index) => {
      if (!isRecord(step)) return
      const stepPath = `${path}.steps[${index}]`
      add(step.buildListEntryId, `${stepPath}.buildListEntryId`, step.targetWeaponId)
      if (Array.isArray(step.checkpointMilestones)) {
        step.checkpointMilestones.forEach((milestone, milestoneIndex) => {
          if (isRecord(milestone)) add(milestone.buildListEntryId, `${stepPath}.checkpointMilestones[${milestoneIndex}].buildListEntryId`, milestone.targetWeaponId)
        })
      }
      const effects = step.executionEffects
      if (!isRecord(effects)) return
      const effectsPath = `${stepPath}.executionEffects`
      if (Array.isArray(effects.targetLinks)) {
        effects.targetLinks.forEach((link, linkIndex) => {
          if (isRecord(link)) add(link.buildListEntryId, `${effectsPath}.targetLinks[${linkIndex}].buildListEntryId`, link.targetWeaponId)
        })
      }
      if (Array.isArray(effects.compromiseLabels)) {
        effects.compromiseLabels.forEach((label, labelIndex) => {
          if (isRecord(label)) add(label.buildListEntryId, `${effectsPath}.compromiseLabels[${labelIndex}].buildListEntryId`)
        })
      }
      if (Array.isArray(effects.targetCompletions)) {
        effects.targetCompletions.forEach((completion, completionIndex) => {
          if (isRecord(completion)) add(completion.buildListEntryId, `${effectsPath}.targetCompletions[${completionIndex}].buildListEntryId`, completion.targetWeaponId)
        })
      }
    })
  }
  if (Array.isArray(plan.conflicts)) {
    plan.conflicts.forEach((conflict, index) => {
      if (!isRecord(conflict)) return
      const conflictPath = `${path}.conflicts[${index}]`
      if (Array.isArray(conflict.buildListEntryIds)) {
        conflict.buildListEntryIds.forEach((id, idIndex) => add(id, `${conflictPath}.buildListEntryIds[${idIndex}]`))
      }
      add(conflict.recommendedBuildListEntryId, `${conflictPath}.recommendedBuildListEntryId`)
      add(conflict.selectedBuildListEntryId, `${conflictPath}.selectedBuildListEntryId`)
      if (Array.isArray(conflict.checkpointParticipants)) {
        conflict.checkpointParticipants.forEach((participant, participantIndex) => {
          if (isRecord(participant)) add(participant.buildListEntryId, `${conflictPath}.checkpointParticipants[${participantIndex}].buildListEntryId`)
        })
      }
    })
  }
  if (Array.isArray(plan.rejectedBuildListEntries)) {
    // The Issue #121 `targetWeaponId` (absent on a record saved before it) is
    // the Target the Plan names this Entry with, so it must be the Entry's own;
    // the Target itself is never required to exist (`docs/DATA_MODEL.md` 11.9).
    plan.rejectedBuildListEntries.forEach((rejected, index) => {
      if (isRecord(rejected)) add(rejected.buildListEntryId, `${path}.rejectedBuildListEntries[${index}].buildListEntryId`, rejected.targetWeaponId)
    })
  }
  return references
}

/**
 * The BuildListEntry / TargetWeapon references of one persisted Plan against
 * the current collections (`docs/DATA_MODEL.md` 15.2 step 7), judged by the
 * Plan's lifecycle:
 *
 * Only a top-level `active` Plan is checked, because only it must be executable
 * against the current collections now:
 *
 * - every BuildListEntry the Plan names exists
 * - where the Plan names an Entry together with a Target, that Target is the
 *   Entry's own `targetWeaponId`, exactly as the Plan generation and the Plan
 *   start effect derived it
 * - every Plan-dependent Target (`collectProductionPlanDependentTargetWeaponIds()`,
 *   the one dependent-Target authority) and every checkpoint milestone Target
 *   exists
 *
 * A `draft` is the Plan artifact as generated and not yet started: the Build
 * List or the Targets may legally have changed since, and
 * `prepareProductionPlanStart()` is the authority that refuses to start it
 * then. A `stale` Plan can legally lose its Entries or Targets, because the
 * Plan-breaking change guard warns for an `active` Plan only, and its replan,
 * recovery and save point restore each re-verify what they need at runtime. A
 * `completed` / `abandoned` Plan is history the user may tidy the Build List or
 * the Targets behind. None of those Plan bodies is read as current foreign keys
 * here, so a backup of such a state stays exportable and importable; their
 * structural, Master ID, CalculationContext and lifecycle validation is
 * unchanged. The restore-required references of a game save point
 * (`executionSavePointScopeIssues()`) are a separate contract that this
 * lifecycle rule never relaxes.
 *
 * A Step's `candidateId` and `ownedWeaponId` are not current foreign keys: the
 * former names the Entry snapshot's Candidate, the latter may be a weapon the
 * Execution registers later.
 */
function productionPlanReferenceIssues(
  plan: ProductionPlan,
  path: string,
  buildListEntries: readonly BuildListEntry[],
  targetIds: ReadonlySet<string>,
): DomainValidationIssue[] {
  if (plan.status !== 'active') return []
  const issues: DomainValidationIssue[] = []
  const entryById = new Map(buildListEntries.map((entry) => [entry.id as string, entry]))
  planBuildListEntryReferences(plan, path).forEach((reference) => {
    const entry = typeof reference.id === 'string' ? entryById.get(reference.id) : undefined
    if (entry === undefined) {
      issues.push(issue(reference.path, 'invalid_reference', `生産計画が参照する作成リスト項目が存在しません: ${String(reference.id)}`))
      return
    }
    if (reference.targetWeaponId !== undefined && reference.targetWeaponId !== null && reference.targetWeaponId !== entry.targetWeaponId) {
      issues.push(issue(reference.path, 'inconsistent_snapshot', `作成リスト項目 ${entry.id} の目標武器は ${entry.targetWeaponId} ですが、生産計画は ${String(reference.targetWeaponId)} と組み合わせています`))
    }
  })
  collectProductionPlanDependentTargetWeaponIds(plan, buildListEntries).forEach((targetId) => {
    if (!targetIds.has(targetId)) {
      issues.push(issue(`${path}.dependentTargetWeaponIds`, 'invalid_reference', `生産計画が依存する目標武器が存在しません: ${targetId}`))
    }
  })
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((step, index) => {
      if (!isRecord(step) || !Array.isArray(step.checkpointMilestones)) return
      step.checkpointMilestones.forEach((milestone, milestoneIndex) => {
        if (!isRecord(milestone)) return
        const targetId = milestone.targetWeaponId
        if (typeof targetId !== 'string' || !targetIds.has(targetId)) {
          issues.push(issue(`${path}.steps[${index}].checkpointMilestones[${milestoneIndex}].targetWeaponId`, 'invalid_reference', `妥協checkpointが参照する目標武器が存在しません: ${String(targetId)}`))
        }
      })
    })
  }
  return issues
}

/**
 * The current-collection references of one game save point beyond
 * `validateExecutionSavePointReferences()` (`docs/DATA_MODEL.md` 12.1,
 * `docs/PLANNER_SPEC.md` 16.9), exactly the current-entity contract
 * `prepareExecutionSavePointRestore()` requires before it writes:
 *
 * - the save point belongs to a running (active / stale) Plan - it is
 *   recorded only for an active Plan and deleted when the Plan completes or
 *   is abandoned
 * - the snapshot Plan is `active`, the only status a save point can be
 *   recorded at; the current top-level Plan may be stale meanwhile
 * - every snapshot OwnedWeapon ID still exists, because the restore never
 *   revives a deleted weapon; the snapshot body itself is past state and is
 *   not compared with the current body
 * - the snapshot Plan's selected BuildListEntries and Plan-dependent Targets
 *   (`collectProductionPlanDependentTargetWeaponIds()`) still exist
 *
 * A Plan-independent Target inside `savePoint.targetWeapons` is not a current
 * foreign key: the restore simply does not revive it. No restore-time
 * precondition (CalculationContext, executable Step, expected state, scope
 * completeness, history boundary) is asked here.
 */
function executionSavePointScopeIssues(
  savePoint: ExecutionSavePoint,
  path: string,
  buildListEntries: readonly BuildListEntry[],
  ownedWeaponIds: ReadonlySet<string>,
  targetIds: ReadonlySet<string>,
  planById: ReadonlyMap<string, ProductionPlan>,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = []
  const plan = planById.get(savePoint.productionPlanId)
  if (plan !== undefined && !isRunningProductionPlanStatus(plan.status)) {
    issues.push(issue(`${path}.productionPlanId`, 'invalid_state', `ゲーム内セーブ地点は実行中（active / stale）の生産計画にだけ存在できます: ${plan.id} は ${plan.status} です`))
  }
  // Every snapshot OwnedWeapon must still exist: the restore refuses to revive
  // a weapon the user deleted (`docs/DATA_MODEL.md` 12.1), so an Import that
  // lacks one would leave a save point that can never be restored. Only the ID
  // is required here; the body is the snapshot's own past state.
  if (Array.isArray(savePoint.ownedWeapons)) {
    savePoint.ownedWeapons.forEach((weapon, index) => {
      const weaponId = isRecord(weapon) ? weapon.id : undefined
      if (typeof weaponId !== 'string' || !ownedWeaponIds.has(weaponId)) {
        issues.push(issue(`${path}.ownedWeapons[${index}].id`, 'invalid_reference', `ゲーム内セーブ地点が保持する所持武器が存在しません: ${String(weaponId)}`))
      }
    })
  }
  const snapshotPlan = savePoint.productionPlan
  if (!isRecord(snapshotPlan)) return issues
  // The snapshot Plan is the Plan as it was when the user recorded the save
  // point, which is allowed only while the Plan is active (12.1); the current
  // top-level Plan may have become stale since, which is exactly the state a
  // restore returns from.
  if (snapshotPlan.status !== 'active') {
    issues.push(issue(`${path}.productionPlan.status`, 'invalid_state', `ゲーム内セーブ地点の生産計画snapshotはactiveでなければなりません: ${String(snapshotPlan.status)}`))
  }
  const entryIds = idSet(buildListEntries)
  if (Array.isArray(snapshotPlan.selectedBuildListEntryIds)) {
    snapshotPlan.selectedBuildListEntryIds.forEach((entryId, index) => {
      if (typeof entryId !== 'string' || !entryIds.has(entryId)) {
        issues.push(issue(`${path}.productionPlan.selectedBuildListEntryIds[${index}]`, 'invalid_reference', `ゲーム内セーブ地点の生産計画が参照する作成リスト項目が存在しません: ${String(entryId)}`))
      }
    })
  }
  collectProductionPlanDependentTargetWeaponIds(snapshotPlan, buildListEntries).forEach((targetId) => {
    if (!targetIds.has(targetId)) {
      issues.push(issue(`${path}.productionPlan.dependentTargetWeaponIds`, 'invalid_reference', `ゲーム内セーブ地点の生産計画が依存する目標武器が存在しません: ${targetId}`))
    }
  })
  return issues
}

/**
 * At most one running (active / stale) Plan exists in the top-level collection
 * (`docs/DATA_MODEL.md` 11.1 / 16). Only `root.productionPlans` is counted:
 * the Plan bodies inside an Undo snapshot or a save point are historical
 * snapshots, and terminal or draft Plans get no count constraint.
 */
function runningPlanIssues(root: ExportRoot): DomainValidationIssue[] {
  const running = root.productionPlans
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan }) => isRunningProductionPlanStatus(plan.status))
  if (running.length <= 1) return []
  return running.slice(1).map(({ plan, index }) =>
    issue(`productionPlans[${index}].status`, 'invalid_state', `実行中（active / stale）の生産計画は同時に1件までです: ${running[0].plan.id} と ${plan.id}`))
}

/**
 * At most one `draft` Plan exists in the top-level collection
 * (`docs/DATA_MODEL.md` 11.1): the current Draft, which the next Planner save
 * replaces atomically. It is independent of the running-Plan invariant - a
 * Draft beside an active / stale Plan is legal - and, like it, counts only
 * `root.productionPlans`, never the Plan bodies inside an Undo snapshot or a
 * save point.
 */
function draftPlanIssues(root: ExportRoot): DomainValidationIssue[] {
  const drafts = root.productionPlans
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan }) => plan.status === 'draft')
  if (drafts.length <= 1) return []
  return drafts.slice(1).map(({ plan, index }) =>
    issue(`productionPlans[${index}].status`, 'invalid_state', `未開始（draft）の生産計画は同時に1件までです: ${drafts[0].plan.id} と ${plan.id}`))
}

/**
 * The formal persisted references between collections (`docs/DATA_MODEL.md`
 * 15.2 step 3 / 7). Only fields the specification defines as references to a
 * currently persisted entity are checked:
 *
 * - a Candidate / Entry snapshot Route references its persisted source
 *   OwnedWeapons through `collectReferencedOwnedWeaponIds()`, the one Route
 *   reference authority; the transient converted Gogma of a Route is `null`
 *   there and never a reference
 * - a Plan / PlanStep may name OwnedWeapon IDs the Execution registers later
 *   (`docs/PLANNER_SPEC.md` 16.3) and an Undo snapshot holds past bodies, so
 *   neither is read as a current foreign key
 * - the BuildListEntry / Target references inside a Plan body are current
 *   foreign keys only for an `active` Plan (`productionPlanReferenceIssues()`)
 * - `BuildListEntry.candidateId` needs no BuildCandidate record: the snapshot
 *   is the authority and the source Candidate may have been replaced
 */
function referenceIssues(root: ExportRoot): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = []
  const targetIds = idSet(root.targetWeapons)
  const ownedWeaponIds = idSet(root.ownedWeapons)
  const planById = new Map(root.productionPlans.map((plan) => [plan.id as string, plan]))

  root.buildCandidates.forEach((candidate, index) => {
    const path = `buildCandidates[${index}]`
    if (!targetIds.has(candidate.targetWeaponId)) {
      issues.push(issue(`${path}.targetWeaponId`, 'invalid_reference', `候補が参照する目標武器が存在しません: ${candidate.targetWeaponId}`))
    }
    issues.push(...routeOwnedWeaponReferenceIssues(candidate.route, path, ownedWeaponIds))
  })
  root.buildListEntries.forEach((entry, index) => {
    const path = `buildListEntries[${index}]`
    if (!targetIds.has(entry.targetWeaponId)) {
      issues.push(issue(`${path}.targetWeaponId`, 'invalid_reference', `作成リスト項目が参照する目標武器が存在しません: ${entry.targetWeaponId}`))
    }
    if (!targetIds.has(entry.candidateSnapshot.targetWeaponId)) {
      issues.push(issue(`${path}.candidateSnapshot.targetWeaponId`, 'invalid_reference', `候補snapshotが参照する目標武器が存在しません: ${entry.candidateSnapshot.targetWeaponId}`))
    }
    issues.push(...routeOwnedWeaponReferenceIssues(entry.candidateSnapshot.route, `${path}.candidateSnapshot`, ownedWeaponIds))
  })
  root.targetWeapons.forEach((target, index) => {
    if (target.completedByProductionPlanId !== null && !planById.has(target.completedByProductionPlanId)) {
      issues.push(issue(`targetWeapons[${index}].completedByProductionPlanId`, 'invalid_reference', `目標武器を完了した生産計画が存在しません: ${target.completedByProductionPlanId}`))
    }
  })
  root.ownedWeapons.forEach((weapon, index) => {
    const inProgress = weapon.executionInProgress
    if (inProgress === null) return
    const path = `ownedWeapons[${index}].executionInProgress.productionPlanId`
    const plan = planById.get(inProgress.productionPlanId)
    if (plan === undefined) {
      issues.push(issue(path, 'invalid_reference', `作成中状態が参照する生産計画が存在しません: ${inProgress.productionPlanId}`))
    } else if (!isRunningProductionPlanStatus(plan.status)) {
      // The in-progress mark is set by Execution Steps only and cleared when the
      // Plan completes or is abandoned (`docs/DATA_MODEL.md` 7.1 / 14.4), so it
      // can only name a running (active / stale) Plan.
      issues.push(issue(path, 'invalid_state', `作成中状態が参照する生産計画は実行中（active / stale）でなければなりません: ${inProgress.productionPlanId} は ${plan.status} です`))
    }
  })
  root.productionPlans.forEach((plan, index) => {
    issues.push(...productionPlanReferenceIssues(plan, `productionPlans[${index}]`, root.buildListEntries, targetIds))
  })
  root.executionSavePoints.forEach((savePoint, index) => {
    issues.push(...executionSavePointScopeIssues(savePoint, `executionSavePoints[${index}]`, root.buildListEntries, ownedWeaponIds, targetIds, planById))
  })
  root.executionHistory.forEach((history, index) => {
    const path = `executionHistory[${index}]`
    const plan = planById.get(history.planId)
    if (plan === undefined) {
      issues.push(issue(`${path}.planId`, 'invalid_reference', `操作履歴が参照する生産計画が存在しません: ${history.planId}`))
      return
    }
    if (!plan.steps.some((step) => step.id === history.planStepId)) {
      issues.push(issue(`${path}.planStepId`, 'invalid_reference', `操作履歴が参照するStepが生産計画に存在しません: ${history.planStepId}`))
    }
  })
  // ExecutionSavePoint references (Plan existence, `lastExecutionHistoryId` of
  // the same Plan, one save point per Plan) are the existing authority
  // `validateExecutionSavePointReferences()`, run by `validateCurrentExportRoot()`.
  return issues
}

function masterReference(kind: MasterReferenceKind, id: unknown, path: string): MasterReference[] {
  return id === null || id === undefined ? [] : [{ kind, id, path }]
}

function bonusReferences(value: unknown, path: string): MasterReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((bonus: unknown, index) => {
    if (!isRecord(bonus)) return []
    const slot = bonus as Partial<RestorationBonus>
    return [
      ...masterReference('bonusTypeId', slot.bonusTypeId, `${path}[${index}].bonusTypeId`),
      ...masterReference('bonusRankId', slot.bonusRankId, `${path}[${index}].bonusRankId`),
    ]
  })
}

function skillReferences(
  value: Partial<Pick<SkillCondition, 'seriesSkillId' | 'groupSkillId'>> | null | undefined,
  path: string,
): MasterReference[] {
  if (!isRecord(value)) return []
  return [
    ...masterReference('seriesSkillId', value.seriesSkillId, `${path}.seriesSkillId`),
    ...masterReference('groupSkillId', value.groupSkillId, `${path}.groupSkillId`),
  ]
}

function materialReferences(value: unknown, path: string): MasterReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((requirement: unknown, index) =>
    isRecord(requirement)
      ? masterReference('materialId', requirement.materialId, `${path}[${index}].materialId`)
      : [])
}

function normalCounterReferences(counter: NormalArtianCounter, path: string): MasterReference[] {
  return masterReference('weaponTypeId', counter.weaponTypeId, `${path}.weaponTypeId`)
}

function ownedWeaponReferences(weapon: OwnedWeapon, path: string): MasterReference[] {
  return [
    ...masterReference('weaponTypeId', weapon.weaponTypeId, `${path}.weaponTypeId`),
    ...masterReference('elementId', weapon.elementId, `${path}.elementId`),
    ...bonusReferences(weapon.restorationBonuses, `${path}.restorationBonuses`),
    ...skillReferences(weapon, path),
  ]
}

function targetWeaponReferences(target: TargetWeapon, path: string): MasterReference[] {
  const references: MasterReference[] = [
    ...masterReference('weaponTypeId', target.weaponTypeId, `${path}.weaponTypeId`),
    ...masterReference('elementId', target.elementId, `${path}.elementId`),
    ...bonusReferences(target.idealBonuses, `${path}.idealBonuses`),
    ...skillReferences(target.idealSkillCondition, `${path}.idealSkillCondition`),
    ...skillReferences(target.practicalSkillCondition, `${path}.practicalSkillCondition`),
  ]
  if (Array.isArray(target.practicalBonusConditions)) {
    target.practicalBonusConditions.forEach((condition, index) => {
      if (!isRecord(condition)) return
      const conditionPath = `${path}.practicalBonusConditions[${index}]`
      references.push(
        ...masterReference('bonusTypeId', condition.bonusTypeId, `${conditionPath}.bonusTypeId`),
        ...masterReference('bonusRankId', condition.minimumRankId, `${conditionPath}.minimumRankId`),
      )
    })
  }
  if (Array.isArray(target.alternativeBonusRules)) {
    target.alternativeBonusRules.forEach((rule, ruleIndex) => {
      if (!isRecord(rule)) return
      const rulePath = `${path}.alternativeBonusRules[${ruleIndex}]`
      references.push(...masterReference('bonusTypeId', rule.sourceBonusTypeId, `${rulePath}.sourceBonusTypeId`))
      if (!Array.isArray(rule.options)) return
      rule.options.forEach((option, optionIndex) => {
        if (!isRecord(option)) return
        const optionPath = `${rulePath}.options[${optionIndex}]`
        references.push(
          ...masterReference('bonusTypeId', option.alternativeBonusTypeId, `${optionPath}.alternativeBonusTypeId`),
          ...masterReference('bonusRankId', option.minimumRankId, `${optionPath}.minimumRankId`),
        )
      })
    })
  }
  return references
}

function routeReferences(route: BuildRoute, path: string): MasterReference[] {
  if (!isRecord(route) || !Array.isArray(route.operations)) return []
  return route.operations.flatMap((operation, index) => {
    if (!isRecord(operation)) return []
    const record = operation as Record<string, unknown>
    return record.type === 'create_normal_artian' || record.type === 'convert_normal_to_gogma'
      ? masterReference('weaponTypeId', record.weaponTypeId, `${path}.operations[${index}].weaponTypeId`)
      : []
  })
}

/**
 * Every Master ID a Candidate body carries: the final result, the Route
 * operations, the item materials, the Ideal difference, the intermediate state
 * groups / opportunities and the observational traces.
 */
function buildCandidateReferences(candidate: BuildCandidate, path: string): MasterReference[] {
  const references: MasterReference[] = [
    ...bonusReferences(candidate.finalBonuses, `${path}.finalBonuses`),
    ...skillReferences(candidate, path),
    ...routeReferences(candidate.route, `${path}.route`),
    ...materialReferences(candidate.requiredMaterials, `${path}.requiredMaterials`),
  ]
  const difference = candidate.idealDifference
  if (isRecord(difference)) {
    references.push(
      ...bonusReferences(difference.missingBonuses, `${path}.idealDifference.missingBonuses`),
      ...bonusReferences(difference.extraBonuses, `${path}.idealDifference.extraBonuses`),
    )
  }
  if (Array.isArray(candidate.intermediateStateGroups)) {
    candidate.intermediateStateGroups.forEach((group, groupIndex) => {
      if (!isRecord(group)) return
      const groupPath = `${path}.intermediateStateGroups[${groupIndex}]`
      if (group.axis === 'skill') {
        references.push(...skillReferences(group, groupPath))
      } else if (group.axis === 'bonus') {
        references.push(...bonusReferences(group.restorationBonuses, `${groupPath}.restorationBonuses`))
        if (Array.isArray(group.opportunities)) {
          group.opportunities.forEach((opportunity, opportunityIndex) => {
            if (!isRecord(opportunity)) return
            references.push(...bonusReferences(
              opportunity.restorationBonuses,
              `${groupPath}.opportunities[${opportunityIndex}].restorationBonuses`,
            ))
          })
        }
      }
    })
  }
  if (Array.isArray(candidate.bonusAmendmentTrace)) {
    candidate.bonusAmendmentTrace.forEach((step, index) => {
      if (isRecord(step)) {
        references.push(...bonusReferences(step.restorationBonuses, `${path}.bonusAmendmentTrace[${index}].restorationBonuses`))
      }
    })
  }
  if (Array.isArray(candidate.skillAmendmentTrace)) {
    candidate.skillAmendmentTrace.forEach((step, index) => {
      references.push(...skillReferences(step, `${path}.skillAmendmentTrace[${index}]`))
    })
  }
  references.push(...skillReferences(candidate.conversionSkillTrace, `${path}.conversionSkillTrace`))
  return references
}

/**
 * Every Master ID a Plan body carries: each Step's expected result, the
 * OwnedWeapon bodies of its inventory change, the item materials. A Plan of an
 * earlier calculation schema has the same persisted field shape, so the same
 * walk applies; every field is read defensively.
 */
function productionPlanReferences(plan: ProductionPlan, path: string): MasterReference[] {
  const references: MasterReference[] = materialReferences(plan.requiredMaterials, `${path}.requiredMaterials`)
  if (!Array.isArray(plan.steps)) return references
  plan.steps.forEach((step, index) => {
    if (!isRecord(step)) return
    const stepPath = `${path}.steps[${index}]`
    const expected = step.expectedResult
    if (isRecord(expected)) {
      references.push(
        ...bonusReferences(expected.restorationBonuses, `${stepPath}.expectedResult.restorationBonuses`),
        ...skillReferences(expected, `${stepPath}.expectedResult`),
      )
    }
    const change = step.inventoryChange
    if (!isRecord(change)) return
    if (isRecord(change.addOwnedWeapon)) {
      references.push(...ownedWeaponReferences(change.addOwnedWeapon as OwnedWeapon, `${stepPath}.inventoryChange.addOwnedWeapon`))
    }
    if (Array.isArray(change.updateOwnedWeapons)) {
      change.updateOwnedWeapons.forEach((weapon, weaponIndex) => {
        if (isRecord(weapon)) {
          references.push(...ownedWeaponReferences(weapon as OwnedWeapon, `${stepPath}.inventoryChange.updateOwnedWeapons[${weaponIndex}]`))
        }
      })
    }
    references.push(...materialReferences(change.materialRequirements, `${stepPath}.inventoryChange.materialRequirements`))
  })
  return references
}

function executionSavePointReferences(savePoint: ExecutionSavePoint, path: string): MasterReference[] {
  const references: MasterReference[] = []
  if (Array.isArray(savePoint.normalCounters)) {
    savePoint.normalCounters.forEach((counter, index) => {
      if (isRecord(counter)) references.push(...normalCounterReferences(counter as NormalArtianCounter, `${path}.normalCounters[${index}]`))
    })
  }
  if (Array.isArray(savePoint.ownedWeapons)) {
    savePoint.ownedWeapons.forEach((weapon, index) => {
      if (isRecord(weapon)) references.push(...ownedWeaponReferences(weapon as OwnedWeapon, `${path}.ownedWeapons[${index}]`))
    })
  }
  if (Array.isArray(savePoint.targetWeapons)) {
    savePoint.targetWeapons.forEach((target, index) => {
      if (isRecord(target)) references.push(...targetWeaponReferences(target as TargetWeapon, `${path}.targetWeapons[${index}]`))
    })
  }
  if (isRecord(savePoint.productionPlan)) {
    references.push(...productionPlanReferences(savePoint.productionPlan as ProductionPlan, `${path}.productionPlan`))
  }
  return references
}

function executionHistoryReferences(history: ExecutionHistory, path: string): MasterReference[] {
  const references: MasterReference[] = []
  const actual = history.actualResult
  if (isRecord(actual)) {
    references.push(
      ...bonusReferences(actual.restorationBonuses, `${path}.actualResult.restorationBonuses`),
      ...skillReferences(actual, `${path}.actualResult`),
    )
  }
  const snapshot = history.undoSnapshot
  if (!isRecord(snapshot)) return references
  const snapshotPath = `${path}.undoSnapshot`
  if (Array.isArray(snapshot.normalCountersBefore)) {
    snapshot.normalCountersBefore.forEach((counter, index) => {
      if (isRecord(counter)) references.push(...normalCounterReferences(counter as NormalArtianCounter, `${snapshotPath}.normalCountersBefore[${index}]`))
    })
  }
  ;(['affectedOwnedWeaponsBefore', 'removedOwnedWeaponsBefore'] as const).forEach((field) => {
    const weapons = snapshot[field]
    if (!Array.isArray(weapons)) return
    weapons.forEach((weapon, index) => {
      if (isRecord(weapon)) references.push(...ownedWeaponReferences(weapon as OwnedWeapon, `${snapshotPath}.${field}[${index}]`))
    })
  })
  if (Array.isArray(snapshot.affectedTargetWeaponsBefore)) {
    snapshot.affectedTargetWeaponsBefore.forEach((target, index) => {
      if (isRecord(target)) references.push(...targetWeaponReferences(target as TargetWeapon, `${snapshotPath}.affectedTargetWeaponsBefore[${index}]`))
    })
  }
  if (isRecord(snapshot.productionPlanBefore)) {
    references.push(...productionPlanReferences(snapshot.productionPlanBefore as ProductionPlan, `${snapshotPath}.productionPlanBefore`))
  }
  if (isRecord(snapshot.executionSavePointBefore)) {
    references.push(...executionSavePointReferences(snapshot.executionSavePointBefore as ExecutionSavePoint, `${snapshotPath}.executionSavePointBefore`))
  }
  return references
}

const MASTER_REFERENCE_LABELS: Record<MasterReferenceKind, string> = {
  weaponTypeId: '武器種',
  elementId: '属性',
  bonusTypeId: '復元ボーナス種類',
  bonusRankId: '復元ボーナスランク',
  seriesSkillId: 'シリーズスキル',
  groupSkillId: 'グループスキル',
  materialId: 'アイテム素材',
}

/**
 * Every persisted Master ID of a current-schema Export root exists in the
 * current Master Data (`docs/DATA_MODEL.md` 15.2 step 4, `docs/UI_FLOW.md` 14).
 *
 * This is existence only, judged against the Master collections themselves and
 * never inferred from an ID's spelling. It is deliberately not the save-time
 * `validateOwnedWeaponMasterReferences()` / `validateTargetWeaponMasterReferences()`
 * authority, which also applies the Production lottery availability: Import is
 * the non-destructive load boundary of `docs/DATA_MODEL.md` 7.1, so a stored
 * bonus outside that availability (for example Bow / Poison + Element) is kept
 * exactly as persisted here and refused only when the user next saves it.
 * Historical calculation artifacts are walked the same way: an old
 * CalculationContext is never a reason to refuse them, while an ID that no
 * longer exists is.
 */
export function validateExportRootMasterReferences(
  root: ExportRoot,
  master: ImportMasterSubset,
): DomainValidationResult {
  const known: Record<MasterReferenceKind, ReadonlySet<string>> = {
    weaponTypeId: idSet(master.weaponTypes),
    elementId: idSet(master.elements),
    bonusTypeId: idSet(master.bonusTypes),
    bonusRankId: idSet(master.bonusRanks),
    seriesSkillId: idSet(master.seriesSkills),
    groupSkillId: idSet(master.groupSkills),
    materialId: idSet(master.materials),
  }
  const references: MasterReference[] = []
  const collect = <T>(
    field: string,
    records: readonly T[] | undefined,
    walk: (record: T, path: string) => MasterReference[],
  ) => {
    if (!Array.isArray(records)) return
    records.forEach((record, index) => {
      if (isRecord(record)) references.push(...walk(record as T, `${field}[${index}]`))
    })
  }
  collect('normalArtianCounters', root.normalArtianCounters, normalCounterReferences)
  collect('ownedWeapons', root.ownedWeapons, ownedWeaponReferences)
  collect('targetWeapons', root.targetWeapons, targetWeaponReferences)
  collect('buildCandidates', root.buildCandidates, buildCandidateReferences)
  collect('buildListEntries', root.buildListEntries, (entry: BuildListEntry, path) =>
    isRecord(entry.candidateSnapshot)
      ? buildCandidateReferences(entry.candidateSnapshot, `${path}.candidateSnapshot`)
      : [])
  collect('productionPlans', root.productionPlans, productionPlanReferences)
  collect('executionHistory', root.executionHistory, executionHistoryReferences)
  collect('executionSavePoints', root.executionSavePoints, executionSavePointReferences)

  const issues = references.flatMap(({ kind, id, path }) =>
    typeof id === 'string' && known[kind].has(id)
      ? []
      : [issue(path, 'invalid_reference', `${MASTER_REFERENCE_LABELS[kind]}のMaster IDが現在のマスターデータに存在しません: ${String(id)}`)])
  return { isValid: issues.length === 0, issues }
}

/**
 * The whole validation a full-replacement Import applies to a root that
 * `prepareExportRootForImport()` already brought to the current schema, and
 * that an Export applies to the root it built from the current database.
 *
 * Order: the shape of every collection (so no typed validator dereferences a
 * malformed body), then the current-schema root validation
 * (`validateCurrentExportRoot()`) plus the entity validation of BuildCandidate,
 * BuildListEntry and AppSettings, then - only once every record is
 * structurally valid - ID uniqueness, the persisted references, the Target
 * preference collection contract, the Target Ideal => Practical containment
 * and the Master ID existence.
 *
 * `validateBuildCandidate()` is run without the OwnedWeapon collection on
 * purpose. Its second argument applies the save-time source eligibility
 * (Normal kind, unprotected), which a legitimately exported database no longer
 * satisfies once Execution converted the owned Normal in place or the user
 * protected the source; that divergence is the existing `owned_weapon_changed`
 * staleness, not an invalid backup. The formal Route references are checked by
 * `collectReferencedOwnedWeaponIds()` below instead.
 */
export function validateExportRootForFullReplacement(
  root: ExportRoot,
  master: ImportMasterSubset,
): DomainValidationResult {
  if (!isRecord(root)) {
    return { isValid: false, issues: [issue('', 'invalid_structure', 'Export root must be an object.')] }
  }
  const record = root as unknown as Record<string, unknown>
  const shapeIssues = ENTITY_COLLECTIONS.flatMap((field) => collectionShapeIssues(record, field))
  if (record.appName !== EXPORT_APP_NAME) {
    shapeIssues.push(issue('appName', 'invalid_literal', 'Export appName is not supported.'))
  }
  if (record.rngState !== null && !isRecord(record.rngState)) {
    shapeIssues.push(issue('rngState', 'invalid_structure', 'rngState must be an object or null.'))
  }
  if (!isRecord(record.settings)) {
    shapeIssues.push(issue('settings', 'invalid_structure', 'settings must be an object.'))
  }
  if (shapeIssues.length > 0) return { isValid: false, issues: shapeIssues }

  const issues: DomainValidationIssue[] = [
    ...guarded('', () => validateCurrentExportRoot(root).issues),
  ]
  root.buildCandidates.forEach((candidate, index) => {
    const path = `buildCandidates[${index}]`
    issues.push(...guarded(path, () => prefixed(path, validateBuildCandidate(candidate))))
  })
  root.buildListEntries.forEach((entry, index) => {
    const path = `buildListEntries[${index}]`
    issues.push(...guarded(path, () => prefixed(path, validateBuildListEntry(entry))))
  })
  issues.push(...guarded('settings', () => prefixed('settings', validateAppSettings(root.settings as AppSettings))))
  if (issues.length > 0) return { isValid: false, issues }

  issues.push(
    ...guarded('', () => duplicateIdIssues(root)),
    ...guarded('productionPlans', () => runningPlanIssues(root)),
    ...guarded('productionPlans', () => draftPlanIssues(root)),
    ...guarded('', () => referenceIssues(root)),
    ...guarded('targetWeapons', () => validateTargetPreferredOwnedWeapons(root.targetWeapons, root.ownedWeapons).issues),
  )
  root.targetWeapons.forEach((target, index) => {
    const path = `targetWeapons[${index}]`
    issues.push(...guarded(path, () => prefixed(path, validateTargetIdealImpliesPractical(target, master))))
  })
  issues.push(...guarded('', () => validateExportRootMasterReferences(root, master).issues))
  return { isValid: issues.length === 0, issues }
}
