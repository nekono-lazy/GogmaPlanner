import type {
  BuildCandidate,
  BuildRoute,
  GroupSkillId,
  IntermediateBonusOpportunity,
  IntermediateBonusStateGroup,
  IntermediateSkillOpportunity,
  IntermediateSkillStateGroup,
  IntermediateStateGroup,
  IntermediateStateGroupId,
  IntermediateStateOpportunityId,
  OwnedWeapon,
  RestorationBonusScope,
  RestorationBonusSet,
  RouteOperation,
  SeriesSkillId,
  TargetWeapon,
  WeaponTypeId,
} from '../models/publicTypes'
import { areRestorationBonusSetsEqual, hashStableValue, stableStringify } from '../models/publicTypes'
import { evaluateTargetBonusMatch, evaluateTargetSkillMatch } from '../target'
import { candidateStableKey } from './candidateProcessing'
import { bonusSolutionRetentionKey, compareStableKeys } from './semanticKeys'
import { CandidateSearchError, type SearchMasterSubset } from './searchTypes'

/**
 * The five restoration bonus slots one Bonus lane position carries.
 *
 * `known: false` covers every state whose five slots this Candidate never
 * recorded: a freshly forged Normal Artian, and a Candidate persisted before
 * the observational traces existed. It is never fabricated, and a state that is
 * not known can never become an intermediate state.
 */
export type LaneBonusState =
  | {
      known: true
      restorationBonuses: RestorationBonusSet
      restorationBonusScope: RestorationBonusScope
    }
  | { known: false }

export type LaneSkillState =
  | { known: true; seriesSkillId: SeriesSkillId | null; groupSkillId: GroupSkillId | null }
  | { known: false }

/** One lane position of one Route, and the weapon state held there. */
export interface RouteLanePosition<State> {
  /** Lane operations executed when this state is held; `0` is the lane start. */
  lanePosition: number
  /** The Route operation producing this state, or `null` for a Route base state. */
  operationIndex: number | null
  state: State
}

/**
 * The two independent stream lanes of one Route, replayed from what the
 * Search already recorded (`docs/SEARCH_SPEC.md` 5.8.1).
 *
 * `skill[i]` is the Skill state after `i` Reset Skills operations and
 * `bonus[d]` the five slots after `d` Bonus amendments. Position `0` of each
 * lane is the lane's starting state: the conversion-assigned Skills or an
 * existing Gogma's current Skills, and the inherited or current five slots.
 * The last position of each lane is the Ideal lane end.
 */
export interface CandidateLaneReplay {
  skill: RouteLanePosition<LaneSkillState>[]
  bonus: RouteLanePosition<LaneBonusState>[]
}

function sourceWeapon(route: BuildRoute, ownedWeapons: readonly OwnedWeapon[]): OwnedWeapon | undefined {
  return route.sourceOwnedWeaponId === null
    ? undefined
    : ownedWeapons.find(({ id }) => id === route.sourceOwnedWeaponId)
}

/**
 * Replays the Candidate's Skill lane and Bonus lane from its observational
 * traces and its Route base OwnedWeapon.
 *
 * It is a pure reconstruction: the bonus amendment results, the Reset Skills
 * results and the conversion Skill result all come from the Candidate's own
 * traces, and the Route base state comes from the source OwnedWeapon. No RNG
 * Engine is touched, so extracting intermediate states adds no
 * `predictGogmaBonus`, `predictSkills`, or `predictNormalArtian` call and
 * cannot widen any stream's search extent.
 */
export function replayCandidateLanes(
  candidate: BuildCandidate,
  ownedWeapons: readonly OwnedWeapon[],
): CandidateLaneReplay {
  const operations = candidate.route.operations
  const source = sourceWeapon(candidate.route, ownedWeapons)
  const conversionIndex = operations.findIndex(
    (operation) => operation.type === 'convert_normal_to_gogma',
  )
  const conversion = candidate.conversionSkillTrace ?? null
  const bonusByIndex = new Map(
    (candidate.bonusAmendmentTrace ?? []).map((step) => [step.operationIndex, step]),
  )
  const skillByIndex = new Map(
    (candidate.skillAmendmentTrace ?? []).map((step) => [step.operationIndex, step]),
  )

  // Skill lane start: the conversion's initial Skills for a conversion Route,
  // the source Gogma's own Skills otherwise. A Normal source without a
  // conversion cannot occur on a valid Route; it is simply unknown.
  const skillStart: RouteLanePosition<LaneSkillState> =
    conversionIndex >= 0
      ? {
          lanePosition: 0,
          operationIndex: conversionIndex,
          state:
            conversion !== null && conversion.operationIndex === conversionIndex
              ? { known: true, seriesSkillId: conversion.seriesSkillId, groupSkillId: conversion.groupSkillId }
              : { known: false },
        }
      : {
          lanePosition: 0,
          operationIndex: null,
          state:
            source?.kind === 'gogma'
              ? { known: true, seriesSkillId: source.seriesSkillId, groupSkillId: source.groupSkillId }
              : { known: false },
        }
  // Bonus lane start: the source weapon's five slots (inherited exactly by a
  // conversion), or unknown for a forged Normal whose slots were never recorded
  // on the Candidate.
  const bonusStart: RouteLanePosition<LaneBonusState> = {
    lanePosition: 0,
    operationIndex: conversionIndex >= 0 ? conversionIndex : null,
    state:
      source !== undefined
        ? {
            known: true,
            restorationBonuses: structuredClone(source.restorationBonuses),
            restorationBonusScope: source.restorationBonusScope,
          }
        : { known: false },
  }

  const skill: RouteLanePosition<LaneSkillState>[] = [skillStart]
  const bonus: RouteLanePosition<LaneBonusState>[] = [bonusStart]
  operations.forEach((operation: RouteOperation, operationIndex) => {
    if (operation.type === 'reset_skills') {
      const step = skillByIndex.get(operationIndex)
      skill.push({
        lanePosition: skill.length,
        operationIndex,
        state: step === undefined
          ? { known: false }
          : { known: true, seriesSkillId: step.seriesSkillId, groupSkillId: step.groupSkillId },
      })
    } else if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
      const step = bonusByIndex.get(operationIndex)
      bonus.push({
        lanePosition: bonus.length,
        operationIndex,
        state: step === undefined
          ? { known: false }
          : {
              known: true,
              restorationBonuses: structuredClone(step.restorationBonuses),
              restorationBonusScope: step.restorationBonusScope,
            },
      })
    }
  })
  return { skill, bonus }
}

/**
 * The replayed lane ends must be the Candidate's own recorded result.
 *
 * A disagreement means the traces and the Route no longer describe the same
 * thing, which is an internal inconsistency: it fails loudly rather than
 * silently offering states nobody will actually reach. A lane end that was
 * never recorded is not a disagreement and is simply skipped.
 */
function assertLaneEndsMatchCandidate(candidate: BuildCandidate, lanes: CandidateLaneReplay): void {
  const skillEnd = lanes.skill[lanes.skill.length - 1].state
  if (
    skillEnd.known &&
    (skillEnd.seriesSkillId !== candidate.seriesSkillId || skillEnd.groupSkillId !== candidate.groupSkillId)
  ) {
    throw new CandidateSearchError(
      'invalid_candidate',
      'Skill lane replay ends at Skills the Candidate does not record.',
    )
  }
  const bonusEnd = lanes.bonus[lanes.bonus.length - 1].state
  if (
    bonusEnd.known &&
    (bonusEnd.restorationBonusScope !== candidate.restorationBonusScope ||
      !areRestorationBonusSetsEqual(bonusEnd.restorationBonuses, candidate.finalBonuses))
  ) {
    throw new CandidateSearchError(
      'invalid_candidate',
      'Bonus lane replay ends at restoration bonuses the Candidate does not record.',
    )
  }
}

/**
 * The per-`bonusTypeId` descending rank-order vectors of one Bonus state, or
 * `null` when any reference cannot be compared safely.
 *
 * Deliberately the same conservative shape the Search retention audit uses: an
 * unknown, disabled, or weapon-unavailable Master reference makes the whole
 * state incomparable rather than optimistically comparable.
 */
function rankVectors(
  bonuses: RestorationBonusSet,
  scope: RestorationBonusScope,
  master: SearchMasterSubset,
  weaponTypeId: WeaponTypeId,
): Map<string, number[]> | null {
  const grouped = new Map<string, number[]>()
  for (const bonus of bonuses) {
    const ranks = master.bonusRanks.filter(({ id }) => id === bonus.bonusRankId)
    const rank = ranks[0]
    if (
      ranks.length !== 1 ||
      !rank.isEnabled ||
      !Number.isFinite(rank.order) ||
      !master.bonusTypes.some(({ id, isEnabled }) => id === bonus.bonusTypeId && isEnabled) ||
      !master.weaponBonusDefinitions.some((definition) =>
        definition.isEnabled &&
        definition.weaponTypeId === weaponTypeId &&
        definition.scope === scope &&
        definition.bonusTypeId === bonus.bonusTypeId &&
        definition.bonusRankId === bonus.bonusRankId,
      )
    ) {
      return null
    }
    const vector = grouped.get(bonus.bonusTypeId) ?? []
    vector.push(rank.order)
    grouped.set(bonus.bonusTypeId, vector)
  }
  for (const vector of grouped.values()) vector.sort((left, right) => right - left)
  return grouped
}

/**
 * Conservative, display-only dominance between two Bonus state groups
 * (`docs/SEARCH_SPEC.md` 5.8.4).
 *
 * True only when `better` is obviously the same compromise product with every
 * rank at least as high, at least one strictly higher, and reachable no later
 * on the lane. Differing Bonus Type compositions are never ranked against each
 * other. This organises the Candidate Search display and nothing else: no
 * group and no opportunity is ever removed from the Domain, because a "worse"
 * state can be the only one that avoids a Counter conflict.
 */
export function bonusStateGroupDisplayDominates(
  better: IntermediateBonusStateGroup,
  worse: IntermediateBonusStateGroup,
  master: SearchMasterSubset,
  weaponTypeId: WeaponTypeId,
): boolean {
  if (better.id === worse.id || better.restorationBonusScope !== worse.restorationBonusScope) {
    return false
  }
  const betterEarliest = better.opportunities[0]?.lanePosition
  const worseEarliest = worse.opportunities[0]?.lanePosition
  if (betterEarliest === undefined || worseEarliest === undefined) return false
  if (betterEarliest > worseEarliest) return false

  const betterRanks = rankVectors(better.restorationBonuses, better.restorationBonusScope, master, weaponTypeId)
  const worseRanks = rankVectors(worse.restorationBonuses, worse.restorationBonusScope, master, weaponTypeId)
  if (!betterRanks || !worseRanks || betterRanks.size !== worseRanks.size) return false
  let strict = false
  for (const [bonusTypeId, worseVector] of worseRanks) {
    const betterVector = betterRanks.get(bonusTypeId)
    if (!betterVector || betterVector.length !== worseVector.length) return false
    for (let index = 0; index < worseVector.length; index += 1) {
      if (betterVector[index] < worseVector[index]) return false
      strict ||= betterVector[index] > worseVector[index]
    }
  }
  return strict
}

interface SkillDraft {
  identityKey: string
  seriesSkillId: SeriesSkillId | null
  groupSkillId: GroupSkillId | null
  match: IntermediateSkillStateGroup['match']
  positions: RouteLanePosition<LaneSkillState>[]
}

interface BonusDraft {
  identityKey: string
  restorationBonuses: RestorationBonusSet
  restorationBonusScope: RestorationBonusScope
  match: IntermediateBonusStateGroup['match']
  positions: RouteLanePosition<LaneBonusState & { known: true }>[]
}

/** Earliest reachable first, then a stable id. Nothing run-dependent takes part. */
function compareGroups(left: IntermediateStateGroup, right: IntermediateStateGroup): number {
  return (
    left.opportunities[0].lanePosition - right.opportunities[0].lanePosition ||
    compareStableKeys(left.id, right.id)
  )
}

export interface IntermediateStateExtractionInput {
  target: TargetWeapon
  master: SearchMasterSubset
  ownedWeapons: readonly OwnedWeapon[]
}

/**
 * Extracts the accepted intermediate states of one canonical Ideal
 * Candidate's Skill lane and Bonus lane (`docs/SEARCH_SPEC.md` 5.8).
 *
 * Each lane is evaluated on its own axis: a Skill lane position is offered when
 * its Skills satisfy the Target's Ideal or Practical Skill condition, and a
 * Bonus lane position when its `gogma_artian` five slots satisfy the Ideal,
 * Practical, or Alternative Bonus condition. The lane end (the Ideal result)
 * is never an intermediate state; the lane start (position 0) is, so a
 * conversion whose assigned Skills already satisfy the Target, and an existing
 * Gogma whose current Skills or five slots already do, are offered as
 * zero-Reset states. An existing Gogma whose selected states are both lane
 * starts already holds its compromise checkpoint at Planner start
 * (`docs/PLANNER_SPEC.md` 7.5.2); that is the Planner's concern, not this
 * extraction's.
 */
export function extractIntermediateStateGroups(
  candidate: BuildCandidate,
  input: IntermediateStateExtractionInput,
): IntermediateStateGroup[] {
  const lanes = replayCandidateLanes(candidate, input.ownedWeapons)
  assertLaneEndsMatchCandidate(candidate, lanes)
  const stableKey = candidateStableKey(candidate)

  const skillDrafts = new Map<string, SkillDraft>()
  for (let position = 0; position < lanes.skill.length - 1; position += 1) {
    const lanePosition = lanes.skill[position]
    if (!lanePosition.state.known) continue
    const match = evaluateTargetSkillMatch(
      input.target,
      lanePosition.state.seriesSkillId,
      lanePosition.state.groupSkillId,
    )
    if (match === null) continue
    const identityKey = stableStringify({
      seriesSkillId: lanePosition.state.seriesSkillId,
      groupSkillId: lanePosition.state.groupSkillId,
    })
    const existing = skillDrafts.get(identityKey)
    if (existing) {
      // A repeated arrival at the same Skills is never dropped: a later lane
      // position may be the only one the Planner can actually use
      // (SEARCH_SPEC 5.8.3).
      existing.positions.push(lanePosition)
      continue
    }
    skillDrafts.set(identityKey, {
      identityKey,
      seriesSkillId: lanePosition.state.seriesSkillId,
      groupSkillId: lanePosition.state.groupSkillId,
      match,
      positions: [lanePosition],
    })
  }

  const bonusDrafts = new Map<string, BonusDraft>()
  for (let position = 0; position < lanes.bonus.length - 1; position += 1) {
    const lanePosition = lanes.bonus[position]
    const state = lanePosition.state
    if (!state.known) continue
    const match = evaluateTargetBonusMatch(
      input.target,
      state.restorationBonuses,
      state.restorationBonusScope,
      input.master,
    )
    if (match === null) continue
    const identityKey = bonusSolutionRetentionKey(state.restorationBonuses, state.restorationBonusScope)
    const known = { ...lanePosition, state }
    const existing = bonusDrafts.get(identityKey)
    if (existing) {
      existing.positions.push(known)
      continue
    }
    bonusDrafts.set(identityKey, {
      identityKey,
      restorationBonuses: structuredClone(state.restorationBonuses),
      restorationBonusScope: state.restorationBonusScope,
      match,
      positions: [known],
    })
  }

  const groupId = (axis: 'skill' | 'bonus', identityKey: string): IntermediateStateGroupId =>
    `intermediate-group:${hashStableValue({ candidate: stableKey, axis, group: identityKey })}` as IntermediateStateGroupId
  const opportunityId = (group: IntermediateStateGroupId, lanePosition: number): IntermediateStateOpportunityId =>
    `intermediate-opportunity:${hashStableValue({ group, lanePosition })}` as IntermediateStateOpportunityId

  const skillGroups: IntermediateSkillStateGroup[] = [...skillDrafts.values()].map((draft) => {
    const id = groupId('skill', draft.identityKey)
    const opportunities: IntermediateSkillOpportunity[] = draft.positions.map((position) => ({
      id: opportunityId(id, position.lanePosition),
      axis: 'skill',
      lanePosition: position.lanePosition,
      operationIndex: position.operationIndex,
    }))
    return {
      axis: 'skill',
      id,
      seriesSkillId: draft.seriesSkillId,
      groupSkillId: draft.groupSkillId,
      match: draft.match,
      opportunities,
    }
  })

  const bonusGroups: IntermediateBonusStateGroup[] = [...bonusDrafts.values()].map((draft) => {
    const id = groupId('bonus', draft.identityKey)
    const opportunities: IntermediateBonusOpportunity[] = draft.positions.map((position) => ({
      id: opportunityId(id, position.lanePosition),
      axis: 'bonus',
      lanePosition: position.lanePosition,
      operationIndex: position.operationIndex,
      // The exact ordered five slots of this lane position, not the group's
      // unordered identity: Planner and Trace Replay need the real state.
      restorationBonuses: structuredClone(position.state.restorationBonuses),
      restorationBonusScope: position.state.restorationBonusScope,
    }))
    return {
      axis: 'bonus',
      id,
      restorationBonusScope: draft.restorationBonusScope,
      // Representative ordered slots come from the earliest opportunity.
      restorationBonuses: structuredClone(opportunities[0].restorationBonuses),
      match: draft.match,
      opportunities,
      isDisplaySecondary: false,
      dominatingGroupId: null,
    }
  })
  skillGroups.sort(compareGroups)
  bonusGroups.sort(compareGroups)
  bonusGroups.forEach((group) => {
    const dominating = bonusGroups.find((other) =>
      bonusStateGroupDisplayDominates(other, group, input.master, input.target.weaponTypeId),
    )
    if (dominating) {
      group.isDisplaySecondary = true
      group.dominatingGroupId = dominating.id
    }
  })
  return [...skillGroups, ...bonusGroups]
}

/** The number of Reset Skills operations of a Route: its Skill lane length. */
export function routeSkillLaneLength(route: BuildRoute): number {
  return route.operations.filter((operation) => operation.type === 'reset_skills').length
}

/** The number of Bonus amendments of a Route: its Bonus lane length. */
export function routeBonusLaneLength(route: BuildRoute): number {
  return route.operations.filter(
    (operation) => operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses',
  ).length
}
