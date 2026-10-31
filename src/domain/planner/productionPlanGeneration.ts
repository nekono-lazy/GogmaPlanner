import type {
  BuildCandidate,
  BuildListEntry,
  BuildListEntryId,
  ExpectedPlanState,
  IntermediateBonusOpportunity,
  IntermediateBonusStateGroup,
  IntermediateSkillOpportunity,
  IntermediateSkillStateGroup,
  IntermediateStateAxis,
  IntermediateStateOpportunityId,
  MaterialRequirement,
  PlanningInputSnapshot,
  ProductionPlan,
  RejectedBuildListEntry,
  RejectedBuildListEntryResourceConflictCause,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import { hashStableValue } from '../models/publicTypes'
import { createTargetDefinitionHash, hasIntermediateStateSelection } from '../buildList'
import { runPlannerDeterministicSchedule } from './plannerDeterministicScheduler'
import {
  replayPlannerSearchTrace,
  type PlannerTraceReplayResult,
  type PlannerTraceReplayIssue,
} from './plannerTraceReplay'
import { PlannerPlanGenerationError } from './plannerPlanGenerationError'
import {
  evaluatePlannerConflictResolutionOutcome,
  type PlannerConflictResolutionOutcome,
} from './plannerConflictPreferenceOutcome'
import { projectProductionPlanExecution } from './productionPlanExecutionProjection'
import type {
  CreateProductionPlanCalculation,
  PlannerRunResult,
  PlannerRunResultOf,
  PlannerDependencies,
  PlannerRunBuildListContext,
  PlannerExecutionOptions,
  PlannerInput,
  PlannerResult,
  PlannerSearchRejection,
  PlannerTerminationOf,
  PlannerWarning,
  ProductionPlanGenerationObserver,
  ProductionPlanGenerationPhase,
} from './plannerTypes'
import { PERSISTED_PLANNER_BUILD_LIST_CONTEXT } from './plannerTypes'

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeCandidateBonuses(candidate: BuildCandidate) {
  return candidate.finalBonuses
    .map(({ bonusTypeId, bonusRankId }) => ({ bonusTypeId, bonusRankId }))
    .sort((left, right) => {
      const type = compareStableStrings(left.bonusTypeId, right.bonusTypeId)
      return type !== 0
        ? type
        : compareStableStrings(left.bonusRankId, right.bonusRankId)
    })
}

function normalizeCandidateMaterials(candidate: BuildCandidate) {
  return candidate.requiredMaterials
    .map(({ materialId, quantity }) => ({ materialId, quantity }))
    .sort((left, right) => {
      const material = compareStableStrings(left.materialId, right.materialId)
      return material !== 0 ? material : left.quantity - right.quantity
    })
}

function normalizeCandidateSnapshot(candidate: BuildCandidate) {
  return {
    targetWeaponId: candidate.targetWeaponId,
    finalBonuses: normalizeCandidateBonuses(candidate),
    restorationBonusScope: candidate.restorationBonusScope,
    seriesSkillId: candidate.seriesSkillId,
    groupSkillId: candidate.groupSkillId,
    route: candidate.route,
    estimatedOperationCount: candidate.estimatedOperationCount,
    estimatedGogmaAdvance: candidate.estimatedGogmaAdvance,
    estimatedSkillAdvance: candidate.estimatedSkillAdvance,
    estimatedNormalAdvance: candidate.estimatedNormalAdvance,
    requiredMaterials: normalizeCandidateMaterials(candidate),
    searchStateHash: candidate.searchStateHash,
    referencedOwnedWeaponsHash: candidate.referencedOwnedWeaponsHash,
    calculationContext: candidate.calculationContext,
  }
}

/** The Route operation count of each stream lane (the hash normalization below). */
function routeLaneLengths(candidate: BuildCandidate): { skill: number; bonus: number } {
  let skill = 0
  let bonus = 0
  candidate.route.operations.forEach(({ type }) => {
    if (type === 'reset_skills') skill += 1
    else if (type === 'reset_bonuses' || type === 'keep_bonuses') bonus += 1
  })
  return { skill, bonus }
}

/** One selected opportunity of a legacy Entry, resolved against its own Candidate Snapshot. */
function resolvedLegacySelection(
  entry: BuildListEntry,
  axis: IntermediateStateAxis,
  opportunityId: IntermediateStateOpportunityId,
) {
  for (const group of entry.candidateSnapshot.intermediateStateGroups ?? []) {
    if (group.axis !== axis) continue
    const opportunity = group.opportunities.find(({ id }) => id === opportunityId)
    if (opportunity) return { group, opportunity }
  }
  return null
}

/**
 * The compromise checkpoint pin pair an Entry with a selection made the
 * Planner hold, for the planning Build List hash (`docs/PLANNER_SPEC.md`
 * 7.5.2 / 7.5.5, historical).
 *
 * Issue #100 removed the selection and the pin (20.7 / 20.10), and a valid
 * Entry carrying a selection fails the Planner input closed. The normalization
 * stays exactly as calculation schema 11..18 defined it so that no
 * `buildListEntriesHash` / `dependentBuildListEntriesHash` moves: above all the
 * selection-free `null`, which every schema 19 Entry hashes - changing it would
 * make a Plan calculated before the removal `build_list_changed` (20.3) - and
 * the value of a legacy Entry still in the Build List, which a Draft's
 * whole-input hash covers. What follows is that historical definition.
 *
 * The hard constraint is never the selected opportunity alone: the checkpoint
 * is the pinned state of *both* lanes - the selected state of a selected
 * lane and the Candidate's Ideal lane end of an unselected one - and Trace
 * Replay verifies exactly that pair. So the hash carries, per lane, either
 * the selected state (the lane position and ending operation the pin gating
 * uses, the Series / Group Skills or the exact ordered five slots and scope,
 * and the match the milestone reports) or the Ideal lane end (the Candidate's
 * final Skills, or its final five slots in stored order and scope). Slot order
 * is kept as stored on both variants, never sorted: the Candidate Snapshot
 * hash normalizes `finalBonuses` as an unordered multiset, but the checkpoint
 * verification is ordered, so a Skill-only selection whose Ideal Bonus slots
 * were reordered is a different constraint.
 *
 * An Entry without any selection has no checkpoint and hashes `null` here,
 * leaving the Candidate Snapshot semantics unchanged. Candidate identity, the
 * deduplication key and the meaning fingerprint stay untouched. A selected id
 * that does not resolve on its own lane is a validation failure elsewhere;
 * here it is hashed deterministically as an unresolved id - never read as
 * empty and never replaced by the Ideal lane end - so the helper never crashes.
 */
function normalizeCheckpointPinMeaning(entry: BuildListEntry) {
  if (!hasIntermediateStateSelection(entry)) return null
  const selection = entry.intermediateStateSelection
  const candidate = entry.candidateSnapshot
  const resolved = {
    skill: (selection?.skillOpportunityId == null
      ? null
      : resolvedLegacySelection(entry, 'skill', selection.skillOpportunityId)) as
      { group: IntermediateSkillStateGroup; opportunity: IntermediateSkillOpportunity } | null,
    bonus: (selection?.bonusOpportunityId == null
      ? null
      : resolvedLegacySelection(entry, 'bonus', selection.bonusOpportunityId)) as
      { group: IntermediateBonusStateGroup; opportunity: IntermediateBonusOpportunity } | null,
  }
  const laneLengths = routeLaneLengths(candidate)
  const orderedSlots = (slots: BuildCandidate['finalBonuses']) =>
    slots.map(({ bonusTypeId, bonusRankId }) => ({ bonusTypeId, bonusRankId }))

  const skillOpportunityId = selection?.skillOpportunityId ?? null
  const skill = skillOpportunityId === null
    ? {
        kind: 'ideal' as const,
        axis: 'skill' as const,
        lanePosition: laneLengths.skill,
        seriesSkillId: candidate.seriesSkillId,
        groupSkillId: candidate.groupSkillId,
        match: 'ideal' as const,
      }
    : resolved.skill === null || resolved.skill.opportunity.id !== skillOpportunityId
      ? { kind: 'selected' as const, opportunityId: skillOpportunityId, resolved: false as const }
      : {
          kind: 'selected' as const,
          opportunityId: skillOpportunityId,
          resolved: true as const,
          axis: 'skill' as const,
          lanePosition: resolved.skill.opportunity.lanePosition,
          operationIndex: resolved.skill.opportunity.operationIndex,
          seriesSkillId: resolved.skill.group.seriesSkillId,
          groupSkillId: resolved.skill.group.groupSkillId,
          match: resolved.skill.group.match,
        }

  const bonusOpportunityId = selection?.bonusOpportunityId ?? null
  const bonus = bonusOpportunityId === null
    ? {
        kind: 'ideal' as const,
        axis: 'bonus' as const,
        lanePosition: laneLengths.bonus,
        restorationBonuses: orderedSlots(candidate.finalBonuses),
        restorationBonusScope: candidate.restorationBonusScope,
        match: 'ideal' as const,
      }
    : resolved.bonus === null || resolved.bonus.opportunity.id !== bonusOpportunityId
      ? { kind: 'selected' as const, opportunityId: bonusOpportunityId, resolved: false as const }
      : {
          kind: 'selected' as const,
          opportunityId: bonusOpportunityId,
          resolved: true as const,
          axis: 'bonus' as const,
          lanePosition: resolved.bonus.opportunity.lanePosition,
          operationIndex: resolved.bonus.opportunity.operationIndex,
          restorationBonuses: orderedSlots(resolved.bonus.opportunity.restorationBonuses),
          restorationBonusScope: resolved.bonus.opportunity.restorationBonusScope,
          match: resolved.bonus.group.match,
        }

  return { skill, bonus }
}

/**
 * `PlanningInputSnapshot.targetWeaponsHash`: the planning-input normalization
 * of every PlannerInput Target (`docs/DATA_MODEL.md` 11.2).
 *
 * It is its own contract, never `createTargetDefinitionHash()` reused: the
 * performance definition hash is one field of it, and `priority`, `isEnabled`,
 * `preferredOwnedWeaponId`, `lifecycleStatus` and `completionConditionReview` -
 * planning input that no longer stales a BuildListEntry - are added beside it. `name`, `memo`,
 * completion metadata and timestamps stay out.
 */
export function createPlanningTargetWeaponsHash(
  targetWeapons: readonly TargetWeapon[],
): string {
  return hashStableValue(
    targetWeapons
      .map((target) => ({
        id: target.id,
        definitionHash: createTargetDefinitionHash(target),
        priority: target.priority,
        isEnabled: target.isEnabled,
        preferredOwnedWeaponId: target.preferredOwnedWeaponId,
        lifecycleStatus: target.lifecycleStatus,
        completionConditionReview: [...target.completionConditionReview].sort(compareStableStrings),
      }))
      .sort((left, right) => compareStableStrings(left.id, right.id)),
  )
}

/**
 * `PlanningInputSnapshot.dependentTargetDefinitionsHash`: the planning
 * definition of the Plan-dependent Targets only (`docs/PLANNER_SPEC.md` 16.6).
 *
 * `preferredOwnedWeaponId` and `lifecycleStatus` are excluded because Execution
 * itself links, relinks, clears and completes them as normal progress; the
 * expected `targetExecutionStateHash` of each Step verifies those instead. A
 * Target the Plan does not depend on never enters, so adding or changing one
 * leaves the hash unchanged. A dependent Target missing from the collection
 * hashes as missing.
 */
export function createDependentTargetDefinitionsHash(
  targetWeapons: readonly TargetWeapon[],
  dependentTargetWeaponIds: readonly TargetWeaponId[],
): string {
  const targetById = new Map(targetWeapons.map((target) => [target.id, target]))
  return hashStableValue(
    [...new Set(dependentTargetWeaponIds)]
      .sort(compareStableStrings)
      .map((id) => {
        const target = targetById.get(id)
        return target
          ? {
              id,
              definitionHash: createTargetDefinitionHash(target),
              priority: target.priority,
              isEnabled: target.isEnabled,
            }
          : { id, missing: true }
      }),
  )
}

function normalizePlanningBuildListEntry(entry: BuildListEntry) {
  return {
    id: entry.id,
    candidateSnapshot: normalizeCandidateSnapshot(entry.candidateSnapshot),
    // Calculation schema 11..18 planned the selected intermediate states and
    // the improvement preference, so changing either made an existing Plan a
    // recalculation target (`docs/PLANNER_SPEC.md` 7.5.5). Both are gone with
    // Issue #100; the normalization is kept unchanged so that no hash moves
    // (20.3 / 20.10).
    intermediateStateSelection: {
      checkpointPin: normalizeCheckpointPinMeaning(entry),
      improvementPreference:
        entry.intermediateStateSelection?.improvementPreference ?? 'planner',
    },
    targetDefinitionHash: entry.targetDefinitionHash,
    searchStateHash: entry.searchStateHash,
    referencedOwnedWeaponsHash: entry.referencedOwnedWeaponsHash,
    calculationContext: entry.calculationContext,
  }
}

/**
 * Stable semantic fingerprint of BuildList inputs. Persisted stale flags and
 * timestamps are deliberately excluded because Planner revalidates them.
 */
export function createPlanningBuildListEntriesHash(
  entries: readonly BuildListEntry[],
): string {
  return hashStableValue(
    entries
      .map(normalizePlanningBuildListEntry)
      .sort((left, right) => compareStableStrings(left.id, right.id)),
  )
}

/**
 * `PlanningInputSnapshot.dependentBuildListEntriesHash`: the
 * `buildListEntriesHash` normalization of the Plan's selected Entries only
 * (`docs/DATA_MODEL.md` 11.2). Adding an Entry the Plan does not use never
 * moves it; changing a selected Entry's snapshot (or, on a legacy Entry, its
 * selection or improvement preference) does. A selected Entry missing from the collection
 * hashes as missing.
 */
export function createDependentBuildListEntriesHash(
  entries: readonly BuildListEntry[],
  selectedBuildListEntryIds: readonly BuildListEntryId[],
): string {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  return hashStableValue(
    [...new Set(selectedBuildListEntryIds)]
      .sort(compareStableStrings)
      .map((id) => {
        const entry = entryById.get(id)
        return entry ? normalizePlanningBuildListEntry(entry) : { id, missing: true }
      }),
  )
}

/**
 * The Plan-dependent Targets of a persisted ProductionPlan
 * (`docs/PLANNER_SPEC.md` 16.5): the Targets of its selected Entries and every
 * Target a Step names as its primary Target, a progressed Target, a Target link
 * or a Target completion. A selected Entry absent from `buildListEntries`
 * contributes nothing here; callers that require it verify it separately.
 */
export function collectProductionPlanDependentTargetWeaponIds(
  plan: Pick<ProductionPlan, 'selectedBuildListEntryIds' | 'steps'>,
  buildListEntries: readonly BuildListEntry[],
): TargetWeaponId[] {
  const entryById = new Map(buildListEntries.map((entry) => [entry.id, entry]))
  return [
    ...new Set([
      ...plan.selectedBuildListEntryIds.flatMap((id) => {
        const entry = entryById.get(id)
        return entry ? [entry.targetWeaponId] : []
      }),
      ...plan.steps.flatMap((step) => [
        ...(step.targetWeaponId === null ? [] : [step.targetWeaponId]),
        ...(step.progressedTargetWeaponIds ?? []),
        ...(step.executionEffects?.targetLinks.map(({ targetWeaponId }) => targetWeaponId) ?? []),
        ...(step.executionEffects?.targetCompletions.map(({ targetWeaponId }) => targetWeaponId) ?? []),
      ]),
    ]),
  ].sort(compareStableStrings)
}

export function createPlanningInputSnapshot(
  input: PlannerInput,
  projection: {
    initialExecutionState: ExpectedPlanState
    dependentTargetWeaponIds: readonly TargetWeaponId[]
    selectedBuildListEntryIds: readonly BuildListEntryId[]
  },
  createdAt: PlanningInputSnapshot['createdAt'],
): PlanningInputSnapshot {
  return {
    initialExecutionState: structuredClone(projection.initialExecutionState),
    targetWeaponsHash: createPlanningTargetWeaponsHash(input.targetWeapons),
    buildListEntriesHash: createPlanningBuildListEntriesHash(input.buildListEntries),
    dependentTargetDefinitionsHash: createDependentTargetDefinitionsHash(
      input.targetWeapons,
      projection.dependentTargetWeaponIds,
    ),
    dependentBuildListEntriesHash: createDependentBuildListEntriesHash(
      input.buildListEntries,
      projection.selectedBuildListEntryIds,
    ),
    calculationContext: structuredClone(input.calculationContext),
    createdAt,
  }
}

function replayErrorMessage(issues: readonly PlannerTraceReplayIssue[]): string {
  return issues
    .map(({ code, message, actionIndex }) =>
      `[${code}] actionIndex=${actionIndex ?? 'null'}: ${message}`)
    .join('; ')
}

/**
 * The parts of a full Planner run result that do not depend on how the run
 * ended: what the shared Plan-generation tail and the rejected Build List
 * record read besides the termination. Both the Production `PlannerRunResult`
 * and a Beam Search oracle result have them, so neither has to be converted
 * into the other to be read here.
 */
export type PlannerRunOutcome = Omit<PlannerRunResultOf<unknown>, 'termination'>

/**
 * The persisted reason of one rejected Entry and, for a `resource_conflict`
 * one, its cause (`docs/PLANNER_SPEC.md` 9.6.9.1), decided together in one
 * branch order so the cause always names the branch that gave the reason.
 */
interface RejectedReasonDecision {
  reason: RejectedBuildListEntry['reason']
  resourceConflictCause: RejectedBuildListEntryResourceConflictCause | null
}

/**
 * The cause of a `conflict_not_committed` rejection, read from the run's own
 * route commitment evidence and never from a message: the provisional outcome
 * that dropped the Entry, or the deadlock / stall drop with whether other
 * committed Routes were pending. Evidence that names neither is an invariant
 * violation of Plan generation, refused rather than guessed.
 */
function notCommittedCause(
  entryId: BuildListEntryId,
  runResult: PlannerRunOutcome,
): RejectedBuildListEntryResourceConflictCause {
  const evidence = runResult.routeCommitment?.entries.find(
    ({ buildListEntryId }) => buildListEntryId === entryId,
  )
  if (evidence?.provisionalOutcome != null) return 'provisional_outcome_not_committed'
  if (evidence?.stuckDrop != null) {
    return evidence.stuckDrop.otherPendingRoutes
      ? 'stuck_drop_with_other_routes'
      : 'stuck_drop_without_other_routes'
  }
  throw new PlannerPlanGenerationError(
    `BuildListEntry '${entryId}' was not committed, but the run records neither the provisional outcome nor the deadlock / stall drop that dropped it.`,
  )
}

function rejectedReason(
  entry: BuildListEntry,
  selectedEntryIds: ReadonlySet<BuildListEntryId>,
  input: PlannerInput,
  runResult: PlannerRunOutcome,
): RejectedReasonDecision {
  const rejections = runResult.rejections.filter(
    (rejection) => rejection.buildListEntryId === entry.id,
  )
  if (rejections.some(({ reason }) => reason === 'protected_destructive_use')) {
    return { reason: 'requires_protected_weapon', resourceConflictCause: null }
  }
  if (runResult.conflicts.some((conflict) =>
    conflict.buildListEntryIds.includes(entry.id) &&
    conflict.selectedBuildListEntryId !== null &&
    conflict.selectedBuildListEntryId !== entry.id &&
    selectedEntryIds.has(conflict.selectedBuildListEntryId),
  )) {
    return { reason: 'resource_conflict', resourceConflictCause: 'explicit_resolution_not_selected' }
  }
  // A deterministic scheduler reason only: a Beam Search oracle result never
  // carries it, so the mapping above and below is unchanged
  // (`docs/ISSUE_103_DETERMINISTIC_PLANNER_DESIGN.md` 8.4).
  if (rejections.some(({ reason }) => reason === 'conflict_not_committed')) {
    return { reason: 'resource_conflict', resourceConflictCause: notCommittedCause(entry.id, runResult) }
  }
  // Calculation schema 11..19 mapped `candidate_already_satisfied` (a release
  // through cross satisfaction) to `already_satisfied`; no new Plan records it
  // since Issue #334 PR-3 (`docs/PLANNER_SPEC.md` 21.5). The persisted literal
  // stays for the Plans that carry it.
  const selectedComparable = input.buildListEntries.some((selected) =>
    selectedEntryIds.has(selected.id) &&
    selected.targetWeaponId === entry.targetWeaponId &&
    selected.candidateSnapshot.estimatedOperationCount <
      entry.candidateSnapshot.estimatedOperationCount,
  )
  return {
    reason: selectedComparable ? 'longer_route' : 'dominated_by_better_candidate',
    resourceConflictCause: null,
  }
}

/**
 * One persisted record: the Entry, its Target as the PlannerInput named it
 * (Issue #121, copied for every reason), the reason and - for
 * `resource_conflict` only - its cause.
 */
function rejectedRecord(
  entry: BuildListEntry,
  decision: RejectedReasonDecision,
  detail: string,
): RejectedBuildListEntry {
  return {
    buildListEntryId: entry.id,
    targetWeaponId: entry.targetWeaponId,
    reason: decision.reason,
    ...(decision.resourceConflictCause === null
      ? {}
      : { resourceConflictCause: decision.resourceConflictCause }),
    detail,
  }
}

function hasOnlyNonSearchRejections(rejections: readonly PlannerSearchRejection[]): boolean {
  return rejections.length > 0 && rejections.every(({ reason }) =>
    reason === 'rng_contract_unavailable' ||
    reason === 'counter_after_mismatch' ||
    reason === 'counter_unavailable',
  )
}

const NOT_COMMITTED_DETAIL =
  'Plannerが資源競合を解決するため、このBuildListEntryを今回の計画では実行しませんでした。'

export function createRejectedBuildListEntries(
  input: PlannerInput,
  runResult: PlannerRunOutcome,
  selectedBuildListEntryIds: readonly BuildListEntryId[],
): RejectedBuildListEntry[] {
  const selected = new Set(selectedBuildListEntryIds)
  const excludedIds = new Set(runResult.excludedBuildListEntries.map(({ entry }) => entry.id))
  const rejectionsByEntryId = new Map<BuildListEntryId, PlannerSearchRejection[]>()
  runResult.rejections.forEach((rejection) => {
    const entries = rejectionsByEntryId.get(rejection.buildListEntryId) ?? []
    entries.push(rejection)
    rejectionsByEntryId.set(rejection.buildListEntryId, entries)
  })
  // Deterministic scheduler results only (`conflict_not_committed`); empty for
  // a Beam Search oracle result, whose mapping and detail are therefore
  // unchanged.
  const notCommittedIds = new Set<BuildListEntryId>(
    runResult.rejections
      .filter(({ reason }) => reason === 'conflict_not_committed')
      .map(({ buildListEntryId }) => buildListEntryId),
  )
  const traceEntryIds = new Set<BuildListEntryId>(
    runResult.bestState?.trace.flatMap((action) => [
      action.primaryBuildListEntryId,
      ...action.progressedBuildListEntryIds,
    ]) ?? [],
  )
  const baseRejectedEntries = input.buildListEntries
    .filter((entry) => !selected.has(entry.id))
    .filter((entry) => {
      const rejections = rejectionsByEntryId.get(entry.id) ?? []
      return !excludedIds.has(entry.id) || rejections.some(
        ({ reason }) => reason === 'protected_destructive_use',
      )
    })
    .filter((entry) => !hasOnlyNonSearchRejections(rejectionsByEntryId.get(entry.id) ?? []))

  if (!runResult.completed) {
    return baseRejectedEntries
      // An Entry the deterministic scheduler dropped from its commitment may
      // already have progressed; the Beam Search oracle never produces that reason.
      .filter((entry) => !traceEntryIds.has(entry.id) || notCommittedIds.has(entry.id))
      .map((entry) => ({
        entry,
        decision: rejectedReason(entry, selected, input, runResult),
      }))
      .filter(({ decision }) =>
        decision.reason === 'requires_protected_weapon' || decision.reason === 'resource_conflict',
      )
      .map(({ entry, decision }) => rejectedRecord(
        entry,
        decision,
        notCommittedIds.has(entry.id)
          ? NOT_COMMITTED_DETAIL
          : 'Plannerの計算途中で、このBuildListEntryは実行不能と確定しました。',
      ))
      .sort((left, right) => compareStableStrings(left.buildListEntryId, right.buildListEntryId))
  }

  return baseRejectedEntries
    .map((entry) => rejectedRecord(
      entry,
      rejectedReason(entry, selected, input, runResult),
      notCommittedIds.has(entry.id)
        ? NOT_COMMITTED_DETAIL
        : 'Plannerの最終結果でこのBuildListEntryは採用されませんでした。',
    ))
    .sort((left, right) => compareStableStrings(left.buildListEntryId, right.buildListEntryId))
}

export function collectRequiredMaterials(
  input: PlannerInput,
  selectedBuildListEntryIds: readonly BuildListEntryId[],
): MaterialRequirement[] {
  const selected = new Set(selectedBuildListEntryIds)
  const quantities = new Map<string, number>()
  input.buildListEntries.forEach((entry) => {
    if (!selected.has(entry.id)) return
    entry.candidateSnapshot.requiredMaterials.forEach(({ materialId, quantity }) => {
      quantities.set(materialId, (quantities.get(materialId) ?? 0) + quantity)
    })
  })
  return [...quantities]
    .filter(([, quantity]) => quantity >= 1)
    .sort(([left], [right]) => compareStableStrings(left, right))
    .map(([materialId, quantity]) => ({
      materialId: materialId as MaterialRequirement['materialId'],
      quantity,
    }))
}

/**
 * Shared Production Plan generation with an optional runtime observer
 * (PLANNER_SPEC 9.2.16).
 *
 * This is the single implementation. Ordinary `createProductionPlan()`
 * delegates here without an observer, and the Planner Alternative full-run
 * path delegates here with one, so the two paths can never drift apart.
 *
 * The full Planner run is the deterministic scheduler
 * (`runPlannerDeterministicSchedule()`, Issue #103 Phase C): this is the one
 * place Production chooses it, so the ordinary Planner, the Planner
 * Alternative trials, the replan Preview and the runtime-unsupported retry all
 * run the same strategy.
 *
 * `observer.beforePlannerRun()` is called once immediately before each full
 * Planner run that actually starts: the first one, and
 * every runtime-unsupported retry, and the optional
 * `observer.afterPlannerRun()` once immediately after each of them returns.
 * The observer is semantics-neutral, so nothing below branches on its presence,
 * and an exception it throws propagates unchanged instead of becoming a
 * `PlannerResult`.
 *
 * `buildListContext` is the Build List cardinality contract of `input`
 * (`PlannerBuildListContext`): the ordinary `persisted` default, or
 * `temporary_replacement` for the replacement set of a Planner Alternative trial
 * (`docs/PLANNER_SPEC.md` 9.2.18). A trial's augmented preflight input is
 * never a full Planner run, so its context is not accepted here.
 */
export async function createProductionPlanWithObserver(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  options: PlannerExecutionOptions | undefined,
  observer?: ProductionPlanGenerationObserver,
  buildListContext: PlannerRunBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
): Promise<PlannerResult> {
  // Production is fixed to the deterministic scheduler (Issue #103 Phase C): no
  // caller, Worker message or setting chooses the full Planner run.
  return createProductionPlanWithSearchRunner(
    runPlannerDeterministicSchedule,
    input,
    dependencies,
    options,
    observer,
    buildListContext,
  )
}

/**
 * One full Planner run over one input, returning the Production
 * `PlannerRunResult` (Issue #103 Phase D-2a). Production passes the
 * deterministic scheduler; a test may pass a runner of its own, but only one
 * that returns a genuine Production result. The Beam Search oracle is never a
 * `PlannerFullSearchRunner`: its termination can name `max_expanded_states`,
 * which no Production termination can, so the parity harness reaches the
 * shared tail through `generatePlanFromFullRun()` with the oracle's own
 * termination type instead (`plannerSchedulerParity.ts`).
 */
export type PlannerFullSearchRunner = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
  options: PlannerExecutionOptions | undefined,
  buildListContext: PlannerRunBuildListContext,
) => Promise<PlannerRunResult>

/** Any full Planner run termination: the Production one or the Beam Search oracle's. */
export type PlannerAnyRunTermination = PlannerTerminationOf<string, unknown>

/**
 * One full Planner run whose result carries the termination shape `T`. With
 * `T = PlannerRunTermination` it is exactly `PlannerFullSearchRunner`.
 */
export type PlannerFullRunOf<T extends PlannerAnyRunTermination> = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
  options: PlannerExecutionOptions | undefined,
  buildListContext: PlannerRunBuildListContext,
) => Promise<PlannerRunResultOf<T>>

/**
 * What the shared Plan-generation tail returns for a run with termination
 * shape `T`: the `PlannerResult` fields, with the run's own termination
 * carried through unchanged. With `T = PlannerRunTermination` it is exactly
 * `PlannerResult`; for the Beam Search oracle it keeps the oracle termination,
 * `max_expanded_states` included, and is never a `PlannerResult`.
 */
export interface PlannerPlanGenerationOf<T extends PlannerAnyRunTermination> {
  plan: ProductionPlan | null
  conflicts: PlannerResult['conflicts']
  warnings: PlannerWarning[]
  termination: T
  /** Present only for an input with explicit conflict resolutions (`PlannerResult.conflictResolutionOutcome`). */
  conflictResolutionOutcome?: PlannerConflictResolutionOutcome
}

/**
 * The preferred Entry completion of one run (`docs/PLANNER_SPEC.md` 9.6.6),
 * spread into the generated result only for an input with explicit
 * resolutions: an input without any carries no such field at all, so its
 * result is unchanged.
 */
function conflictResolutionOutcomeOf(
  input: PlannerInput,
  plan: ProductionPlan | null,
  runResult: PlannerRunOutcome,
): { conflictResolutionOutcome?: PlannerConflictResolutionOutcome } {
  if (input.conflictResolutions.length === 0) return {}
  return {
    conflictResolutionOutcome: evaluatePlannerConflictResolutionOutcome({
      resolutions: input.conflictResolutions,
      plan,
      buildListEntries: input.buildListEntries,
      routeCommitment: runResult.routeCommitment ?? null,
    }),
  }
}

/** The observer of the shared tail, typed by the run result it observes. */
export interface PlannerFullRunObserverOf<TResult> {
  beforePlannerRun(): void
  afterPlannerRun?(result: TResult): void
  /** Semantics-neutral tail phase boundary (`ProductionPlanGenerationPhase`). */
  onPlanGenerationPhase?(phase: ProductionPlanGenerationPhase): void
}

/**
 * `createProductionPlanWithObserver()` with the full Planner run passed in
 * (Issue #103 Phase B / C / D-2a).
 *
 * Only the full run is replaced; everything after it is the one shared tail,
 * `generatePlanFromFullRun()`. `observer.beforePlannerRun()` /
 * `afterPlannerRun()` wrap every full run exactly as before, so the Planner
 * Alternative rerun budget keeps counting full Planner runs.
 *
 * Production never calls this with anything but
 * `runPlannerDeterministicSchedule` (through `createProductionPlanWithObserver()`);
 * tests may inject another runner returning a genuine `PlannerRunResult`.
 * It is a Domain function value, never a Worker message, a `PlannerInput`
 * field, a setting or a persisted value.
 */
export async function createProductionPlanWithSearchRunner(
  searchRunner: PlannerFullSearchRunner,
  input: PlannerInput,
  dependencies: PlannerDependencies,
  options: PlannerExecutionOptions | undefined,
  observer?: ProductionPlanGenerationObserver,
  buildListContext: PlannerRunBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
): Promise<PlannerResult> {
  return generatePlanFromFullRun(
    searchRunner,
    input,
    dependencies,
    options,
    observer,
    buildListContext,
  )
}

/**
 * The one shared Plan-generation tail after a full Planner run: the
 * runtime-unsupported retry (which reruns the same runner), Trace Replay, the
 * execution projection, the `PlanningInputSnapshot`, the rejected Build List
 * record and the required materials.
 *
 * It is generic over the run's termination shape `T` and reads from the
 * termination nothing but its status, so no termination is ever converted:
 * Production (`createProductionPlanWithSearchRunner()`) fixes
 * `T = PlannerRunTermination` and returns a `PlannerResult`, and the Issue #103
 * parity harness alone runs it with the Beam Search oracle's own termination,
 * which it gets back unchanged (Phase D-2a). No Production module calls it
 * with any other `T`.
 */
export async function generatePlanFromFullRun<T extends PlannerAnyRunTermination>(
  fullRun: PlannerFullRunOf<T>,
  input: PlannerInput,
  dependencies: PlannerDependencies,
  options: PlannerExecutionOptions | undefined,
  observer?: PlannerFullRunObserverOf<PlannerRunResultOf<T>>,
  buildListContext: PlannerRunBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
): Promise<PlannerPlanGenerationOf<T>> {
  const runtimeUnsupported = new Map<BuildListEntryId, string>()
  let runResult: PlannerRunResultOf<T> | null = null
  let replay: PlannerTraceReplayResult | null = null

  for (;;) {
    const runInput: PlannerInput = runtimeUnsupported.size === 0
      ? input
      : {
          ...input,
          buildListEntries: input.buildListEntries.filter(
            ({ id }) => !runtimeUnsupported.has(id),
          ),
        }
    // A temporary Entry the runtime found unsupported leaves the retry input
    // together with its replacement, so its Target then holds neither Entry.
    const runContext: PlannerRunBuildListContext =
      buildListContext.kind === 'persisted' || runtimeUnsupported.size === 0
        ? buildListContext
        : {
            kind: 'temporary_replacement',
            replacements: buildListContext.replacements.filter(
              ({ generatedBuildListEntryId }) => !runtimeUnsupported.has(generatedBuildListEntryId),
            ),
          }
    observer?.beforePlannerRun()
    runResult = await fullRun(runInput, dependencies, options, runContext)
    observer?.afterPlannerRun?.(runResult)
    if (
      runResult.cancelled ||
      runResult.bestState === null ||
      runResult.bestState.trace.length === 0
    ) break

    observer?.onPlanGenerationPhase?.('trace_replay')
    replay = replayPlannerSearchTrace(
      runInput,
      runResult.bestState,
      dependencies.rngEngine,
    )
    if (replay.unsupportedInput === null) break

    const unsupported = replay.unsupportedInput
    if (runtimeUnsupported.has(unsupported.buildListEntryId)) {
      throw new PlannerPlanGenerationError(
        `Planner repeatedly selected unsupported BuildListEntry '${unsupported.buildListEntryId}'.`,
      )
    }
    runtimeUnsupported.set(
      unsupported.buildListEntryId,
      `requires unsupported RNG input (${unsupported.operationType}: ${unsupported.reason}).`,
    )
    replay = null
  }

  if (runResult === null) {
    throw new PlannerPlanGenerationError('Planner full run did not return a result.')
  }
  observer?.onPlanGenerationPhase?.('post_processing')
  const runtimeWarnings: PlannerWarning[] = [...runtimeUnsupported]
    .sort(([left], [right]) => compareStableStrings(left, right))
    .map(([entryId, reason]) => ({
      kind: 'rng_prediction_unsupported',
      message: `BuildListEntry '${entryId}' ${reason}`,
    }))
  if (runtimeUnsupported.size > 0) {
    const alreadyExcluded = new Set(
      runResult.excludedBuildListEntries.map(({ entry }) => entry.id),
    )
    input.buildListEntries.forEach((entry) => {
      const reason = runtimeUnsupported.get(entry.id)
      if (reason && !alreadyExcluded.has(entry.id)) {
        runResult?.excludedBuildListEntries.push({ entry, reason })
      }
    })
  }
  const warnings = [...runResult.warnings, ...runtimeWarnings]
    .filter((warning, index, all) =>
      all.findIndex((candidate) =>
        candidate.kind === warning.kind &&
        candidate.message === warning.message,
      ) === index,
    )
  if (
    runResult.cancelled ||
    runResult.bestState === null ||
    runResult.bestState.trace.length === 0
  ) {
    return {
      plan: null,
      conflicts: structuredClone(runResult.conflicts),
      warnings: structuredClone(warnings),
      termination: structuredClone(runResult.termination),
      ...conflictResolutionOutcomeOf(input, null, runResult),
    }
  }
  if (replay === null || !replay.isValid) {
    throw new PlannerPlanGenerationError(
      `Planner trace replay failed: ${replayErrorMessage(replay?.issues ?? [])}`,
    )
  }

  const now = dependencies.clock.now()
  const productionPlanId = dependencies.idFactory.productionPlanId()
  const selectedBuildListEntryIds = [...new Set(runResult.bestState.selectedBuildListEntryIds)]
    .sort(compareStableStrings)
  observer?.onPlanGenerationPhase?.('execution_projection')
  const projection = projectProductionPlanExecution({
    input,
    drafts: replay.drafts,
    selectedBuildListEntryIds,
    searchFinalOwnedWeapons: runResult.bestState.simulatedInventory.ownedWeapons,
    dependencies,
    productionPlanId,
    now,
  })
  const steps = projection.steps
  observer?.onPlanGenerationPhase?.('planning_input_snapshot')
  const baseSnapshot = createPlanningInputSnapshot(
    input,
    { ...projection, selectedBuildListEntryIds },
    now,
  )
  // The Plan fields below are evaluated in the same order as the object
  // literal lists them; they are only named so the optional observer can see
  // the phase boundaries (`ProductionPlanGenerationPhase`).
  observer?.onPlanGenerationPhase?.('rejected_build_list_entries')
  const calculationContext = structuredClone(input.calculationContext)
  const planConflicts = structuredClone(runResult.conflicts)
  const rejectedBuildListEntries = createRejectedBuildListEntries(
    input,
    runResult,
    selectedBuildListEntryIds,
  )
  observer?.onPlanGenerationPhase?.('required_materials')
  const requiredMaterials = collectRequiredMaterials(input, selectedBuildListEntryIds)
  observer?.onPlanGenerationPhase?.('plan_assembly')
  const plan: ProductionPlan = {
    id: productionPlanId,
    status: 'draft',
    baseSnapshot,
    selectedBuildListEntryIds,
    calculationContext,
    steps,
    conflicts: planConflicts,
    rejectedBuildListEntries,
    requiredMaterials,
    currentStepId: steps[0]?.id ?? null,
    recalculationReasons: [],
    abandonmentReason: null,
    abandonedAt: null,
    completedAt: null,
    // Plan generation never writes a repair lineage (PLANNER_SPEC 9.6.8): the
    // ordinary Planner, the conflict preference, the replan Preview, the Build
    // List global optimization and the research full runs alike. The field
    // stays only for Plans an earlier version's actual repair saved; that
    // repair and its lineage derivation were removed in Issue #278 PR-7.
    conflictRepairLineage: null,
    createdAt: now,
    updatedAt: now,
  }
  const generated: PlannerPlanGenerationOf<T> = {
    plan,
    conflicts: structuredClone(runResult.conflicts),
    warnings: structuredClone(warnings),
    // The last full Planner run that actually produced this Plan, so a Plan built
    // from a truncated run is identifiable without reading a warning message
    // (PLANNER_SPEC 7.2.1).
    termination: structuredClone(runResult.termination),
    ...conflictResolutionOutcomeOf(input, plan, runResult),
  }
  observer?.onPlanGenerationPhase?.('completed')
  return generated
}

/**
 * The ordinary Production Plan calculation. Its signature and result semantics
 * are unchanged; it simply runs the shared implementation with no observer.
 */
export const createProductionPlan: CreateProductionPlanCalculation = async (
  input,
  dependencies,
  options: PlannerExecutionOptions | undefined,
) => createProductionPlanWithObserver(input, dependencies, options)
