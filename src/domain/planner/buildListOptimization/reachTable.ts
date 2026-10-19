/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6), Stage A (moved from the Global Assignment Research
 * Phase A, Issue #154).
 *
 * Builds the ReachTable (`docs/PLANNER_GLOBAL_ASSIGNMENT_DESIGN.md` 4.2 / 5.1 / 5.4 / 5.5): for every
 * planning Target of a `BuildListOptimizationContext`, the Counter positions inside an explicit window at
 * which the Production RNG reaches the Target's Ideal, per stream and per source. Only the given
 * `RngEngine`'s public prediction API, `getPredictionSupport()`, the Keep family authority
 * (`keepFamilyLayoutKey()` / `keepFamilyMultisetKey()`) and the Target evaluators
 * (`satisfiesIdealBonuses()` / `evaluateSkillCondition()`) are read. No weight, Counter advance, Gate or
 * game rule is computed here, no Route is built, and nothing outside the window is recorded as absent.
 *
 * Predictions are shared between Targets of one weapon type / element through a memo
 * (design 5.1): Skill / Reset / Normal by position; Keep by position and ordered family layout. Keep
 * reads the Bonus family of each slot only (`AGENTS.md` RNG Rules, `docs/RNG_SPEC.md` 6.1), so one
 * layout's result stands for every current five-slot
 * set with that layout; prediction *support* is still asked of every concrete five-slot input, and two
 * inputs of one layout that disagree fail closed as an Engine contract violation.
 *
 * The existing BuildListEntries of the context are not read here (design 4.1): the Target set is the
 * context's, and the sources / positions come from the PlannerInput's RngState, Normal Counters,
 * OwnedWeapons and Targets alone. `TargetWeapon.preferredOwnedWeaponId` is not an input either.
 *
 * The window is the caller's: this module applies no window of its own, widens none, and reads neither the
 * Candidate Search defaults nor a saved setting (`docs/PLANNER_SPEC.md` 17.13).
 */
import type { BuildListEntryId, ElementId, OwnedWeapon, RestorationBonusSet, TargetWeapon, TargetWeaponId, WeaponTypeId } from '../../models/publicTypes'
import type { PlannerInput } from '../plannerTypes'
import { keepFamilyLayoutKey, keepFamilyMultisetKey } from '../../rng/gogmaBonusFamily'
import type { NormalizedSeed, RngEngine, RngPredictionSupportInput } from '../../rng/rngEngine'
import { evaluateSkillCondition } from '../../target/skillConditionEvaluator'
import { satisfiesIdealBonuses } from '../../target/targetEvaluator'
import type { BuildListOptimizationUnsupportedReason } from './buildListOptimizationResult'
import {
  BuildListOptimizationInvariantError,
  type ExcludedOwnedWeaponReason, type BuildListOptimizationContext, type InclusiveRange, type LayoutKey, type NormalArtianCounterId,
  type ReachOptionSet, type ReachScanSummary, type ReachTable, type ReachTableResult, type ReachWindow, type SourceCandidate, type TargetReach,
} from './buildListOptimizationTypes'

/** The cancel / yield seam. Cancellation is reported as `cancelled`, never as an empty table. */
export interface ReachTableExecution {
  shouldCancel?: () => boolean
  yieldControl?: () => Promise<void>
}

/** Positions scanned between two `yieldControl()` calls. */
const YIELD_INTERVAL = 64

class CancelledSignal extends Error {
  constructor() {
    super('ReachTable scan cancelled.')
    this.name = 'CancelledSignal'
  }
}

export function assertReachWindow(window: ReachWindow): void {
  for (const stream of ['normal', 'gogma', 'skill'] as const) {
    const value = window[stream]
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`ReachWindow.${stream} must be a positive integer (got ${String(value)}).`)
  }
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function emptyCounts(): ReachScanSummary['predictions'] {
  return { skill: 0, gogmaReset: 0, gogmaKeep: 0, normal: 0 }
}

interface Group {
  weaponTypeId: WeaponTypeId
  elementId: ElementId
  targets: TargetWeapon[]
}

/** Targets grouped by weapon type / element in the order the first Target of each group appears (Target ID order). */
function groupTargets(targets: readonly TargetWeapon[]): Group[] {
  const groups = new Map<string, Group>()
  for (const target of targets) {
    const key = `${target.weaponTypeId}\u0000${target.elementId}`
    const group = groups.get(key)
    if (group) group.targets.push(target)
    else groups.set(key, { weaponTypeId: target.weaponTypeId, elementId: target.elementId, targets: [target] })
  }
  return [...groups.values()]
}

function confirmedRarity8Counter(input: PlannerInput, weaponTypeId: WeaponTypeId) {
  const counter = input.normalCounters.find(value => value.weaponTypeId === weaponTypeId && value.rarity === 8) ?? null
  return counter && counter.isConfirmed && counter.counter !== null ? { id: counter.id as NormalArtianCounterId, origin: counter.counter } : null
}

function compatibleOwnedWeapons(input: PlannerInput, group: Group): OwnedWeapon[] {
  return input.ownedWeapons
    .filter(weapon => weapon.weaponTypeId === group.weaponTypeId && weapon.elementId === group.elementId)
    .sort((left, right) => compareStable(left.id, right.id))
}

/** Design 5.2 source rules: a protected Gogma only while already Ideal on both axes; a protected Normal never. */
function classifyOwnedSource(target: TargetWeapon, weapon: OwnedWeapon, master: PlannerInput['master']):
  | { kind: 'source'; gogma: { currentSkillIdeal: boolean; currentBonusIdeal: boolean } | null }
  | { kind: 'excluded'; reason: ExcludedOwnedWeaponReason } {
  if (weapon.kind === 'normal') {
    if (weapon.rarity !== 8) return { kind: 'excluded', reason: 'normal_rarity_not_8' }
    if (weapon.isProtected) return { kind: 'excluded', reason: 'protected_normal' }
    return { kind: 'source', gogma: null }
  }
  const currentSkillIdeal = evaluateSkillCondition(target.idealSkillCondition, weapon.seriesSkillId, weapon.groupSkillId)
  const currentBonusIdeal = satisfiesIdealBonuses(target, weapon.restorationBonuses, weapon.restorationBonusScope, master)
  if (weapon.isProtected && !(currentSkillIdeal && currentBonusIdeal)) return { kind: 'excluded', reason: 'protected_gogma_not_ideal' }
  return { kind: 'source', gogma: { currentSkillIdeal, currentBonusIdeal } }
}

/**
 * One input precondition of the ReachTable that does not hold (`docs/PLANNER_SPEC.md` 17.4): every reason is an input the
 * optimization does not support, never "the Ideal is unreachable".
 */
export type ReachTablePreconditionViolation =
  | { reason: 'unconfirmed_rng_state'; missing: ('base_seed' | 'skill_counter' | 'gogma_counter')[]; detail: string }
  | { reason: 'checkpoint_selection'; entries: { buildListEntryId: BuildListEntryId; targetWeaponId: TargetWeaponId }[]; detail: string }
  | { reason: 'target_without_source'; targetWeaponId: TargetWeaponId; detail: string }
  | { reason: 'blind_route_required'; targetWeaponId: TargetWeaponId; detail: string }

/**
 * The ReachTable's input preconditions over a context, in the order the scan checks them: the confirmed Base Seed / Skill Counter /
 * Gogma Counter, no selected intermediate state on a planning Target's valid Entry (design 15.1: this design places no pin), and
 * for every planning Target (grouped by weapon type / element, in the order the first Target of each group appears) an owned
 * source or a confirmed rarity-8 Normal Counter whose Normal prediction is supported (the blind variant is never an option).
 *
 * `all: false` stops at the first violation with the very Engine queries the scan made before (`buildReachTable()` reports it);
 * `all: true` evaluates every precondition, so the caller can name every unsupported reason and Target at once. Only support
 * queries are asked; nothing is predicted.
 */
export function collectReachTablePreconditionViolations(context: BuildListOptimizationContext, engine: RngEngine, options: { all: boolean }): ReachTablePreconditionViolation[] {
  const violations: ReachTablePreconditionViolation[] = []
  const input = context.plannerInput
  const master = input.master
  const { baseSeed, skillCounter, gogmaCounter } = input.rngState
  if (!baseSeed.isConfirmed || baseSeed.value === null || !skillCounter.isConfirmed || skillCounter.value === null
    || !gogmaCounter.isConfirmed || gogmaCounter.value === null) {
    const missing = [!baseSeed.isConfirmed || baseSeed.value === null ? 'base_seed' as const : null,
      !skillCounter.isConfirmed || skillCounter.value === null ? 'skill_counter' as const : null,
      !gogmaCounter.isConfirmed || gogmaCounter.value === null ? 'gogma_counter' as const : null].filter((value): value is NonNullable<typeof value> => value !== null)
    const label = { base_seed: 'Base Seed', skill_counter: 'Skill Counter', gogma_counter: 'Gogma Counter' } as const
    violations.push({ reason: 'unconfirmed_rng_state', missing, detail: `No confirmed value for: ${missing.map(value => label[value]).join(', ')}.` })
    if (!options.all) return violations
  }
  // Design 15.1: this design places no intermediate state pin, so a selected state is not planned here.
  const pinned = context.validation.validBuildListEntries
    .filter(({ entry }) => context.planningTargetIds.has(entry.targetWeaponId) && entry.intermediateStateSelection !== undefined
      && (entry.intermediateStateSelection.skillOpportunityId !== null || entry.intermediateStateSelection.bonusOpportunityId !== null))
    .map(({ entry }) => entry)
  if (pinned.length > 0) {
    violations.push({ reason: 'checkpoint_selection', entries: pinned.map(entry => ({ buildListEntryId: entry.id, targetWeaponId: entry.targetWeaponId })),
      detail: `BuildListEntries with a selected intermediate state: ${pinned.map(entry => entry.id).join(', ')}.` })
    if (!options.all) return violations
  }
  // Fail closed before any prediction when a Target has no source kind at all (design 5.2).
  for (const group of groupTargets(context.planningTargets)) {
    const counter = confirmedRarity8Counter(input, group.weaponTypeId)
    const normalSupported = engine.getPredictionSupport({ type: 'normal_artian', weaponTypeId: group.weaponTypeId, elementId: group.elementId, rarity: 8 }).supported
    for (const target of group.targets) {
      const hasOwnedSource = compatibleOwnedWeapons(input, group).some(weapon => classifyOwnedSource(target, weapon, master).kind === 'source')
      if (hasOwnedSource) continue
      if (counter === null) {
        violations.push({ reason: 'target_without_source', targetWeaponId: target.id,
          detail: `Target ${target.id} has no owned source and no confirmed rarity-8 Normal Counter for ${group.weaponTypeId}; the blind variant is never an option.` })
        if (!options.all) return violations
        continue
      }
      if (!normalSupported) {
        violations.push({ reason: 'blind_route_required', targetWeaponId: target.id,
          detail: `Target ${target.id} has no owned source and Normal Artian prediction is unsupported for ${group.weaponTypeId} / ${group.elementId}; only a blind Route could reach it.` })
        if (!options.all) return violations
      }
    }
  }
  return violations
}

/**
 * Every typed 17.4 reason of the ReachTable preconditions over a context (`collectReachTablePreconditionViolations()` with
 * `all: true`), grouped by reason in the order the ReachTable checks them; empty when the optimization may start. The one rule
 * Stage 0 of `runBuildListOptimization()` and the plan creation method (`docs/PLANNER_SPEC.md` 17.2) apply: only support queries
 * are asked, nothing is predicted, and a reason never says that a plan or an Ideal does not exist.
 */
export function deriveBuildListOptimizationUnsupportedReasons(context: BuildListOptimizationContext, engine: RngEngine): BuildListOptimizationUnsupportedReason[] {
  const reasons: BuildListOptimizationUnsupportedReason[] = []
  for (const violation of collectReachTablePreconditionViolations(context, engine, { all: true })) {
    switch (violation.reason) {
      case 'unconfirmed_rng_state': reasons.push({ kind: 'unconfirmed_rng_state', missing: [...violation.missing] }); break
      case 'checkpoint_selection': reasons.push({ kind: 'checkpoint_selection', entries: structuredClone(violation.entries) }); break
      case 'target_without_source':
      case 'blind_route_required': {
        const existing = reasons.find((reason): reason is Extract<BuildListOptimizationUnsupportedReason, { kind: typeof violation.reason }> => reason.kind === violation.reason)
        if (existing !== undefined) existing.targetWeaponIds.push(violation.targetWeaponId)
        else reasons.push({ kind: violation.reason, targetWeaponIds: [violation.targetWeaponId] })
        break
      }
    }
  }
  return reasons
}

export function assertReachOptionSet(optionSet: ReachOptionSet): void {
  if (optionSet === null || typeof optionSet !== 'object' || typeof optionSet.id !== 'string' || optionSet.id.length === 0
    || typeof optionSet.continuesCurrentIdealLanes !== 'boolean') {
    throw new RangeError('optionSet must name a ReachOptionSet: a non-empty id and a boolean continuesCurrentIdealLanes.')
  }
}

/**
 * Scans every planning Target of the context inside `window`. Async only for the cancel / yield seam;
 * the result is deterministic for the same context, Engine and window.
 *
 * `optionSet` names the option rule every later Stage applies to the table and is stored on it; the scan itself
 * (predictions, positions, sources, summary) does not depend on it - the continuations need no extra prediction
 * (audit 3.4). It has no default: the caller names the option set it runs (the Build List global optimization runs
 * `BUILD_LIST_OPTIMIZATION_REACH_OPTION_SET`).
 */
export async function buildReachTable(context: BuildListOptimizationContext, engine: RngEngine, window: ReachWindow, optionSet: ReachOptionSet,
  execution: ReachTableExecution = {}): Promise<ReachTableResult> {
  assertReachWindow(window)
  assertReachOptionSet(optionSet)
  const input = context.plannerInput
  const master = input.master
  // The first precondition that does not hold, with the very Engine queries the scan always made before it predicts.
  const [violation] = collectReachTablePreconditionViolations(context, engine, { all: false })
  if (violation !== undefined) return { kind: 'unsupported_input', reason: violation.reason, detail: violation.detail }
  const { baseSeed, skillCounter, gogmaCounter } = input.rngState
  // The persisted Base Seed is already normalized; the Domain passes it to the Engine as is.
  const seed = baseSeed.value as NormalizedSeed
  const originSkill = skillCounter.value!
  const originGogma = gogmaCounter.value!
  const groups = groupTargets(context.planningTargets)

  const predictions = emptyCounts()
  const memoHits = emptyCounts()
  let supportQueries = 0
  const unsupported: ReachScanSummary['unsupported'] = []
  const summaryGroups: ReachScanSummary['groups'] = []
  const originNormal: Record<NormalArtianCounterId, number> = {}
  const scannedNormal: Record<NormalArtianCounterId, InclusiveRange> = {}
  const reaches = new Map<TargetWeaponId, TargetReach>()
  const skillRange: InclusiveRange = { from: originSkill, to: originSkill + window.skill }
  const gogmaRange: InclusiveRange = { from: originGogma, to: originGogma + window.gogma - 1 }
  let lastGroup: { weaponTypeId: WeaponTypeId; elementId: ElementId } | null = null
  let sinceYield = 0
  const checkpoint = async () => {
    if (execution.shouldCancel?.()) throw new CancelledSignal()
    sinceYield += 1
    if (execution.yieldControl && sinceYield >= YIELD_INTERVAL) {
      sinceYield = 0
      await execution.yieldControl()
    }
  }
  const support = (query: RngPredictionSupportInput) => {
    supportQueries += 1
    return engine.getPredictionSupport(query)
  }

  try {
    for (const group of groups) {
      lastGroup = { weaponTypeId: group.weaponTypeId, elementId: group.elementId }
      const { weaponTypeId, elementId } = group
      const skillSupport = support({ type: 'skill', weaponTypeId, elementId })
      const resetSupport = support({ type: 'gogma_reset', weaponTypeId, elementId, master })
      const normalSupport = support({ type: 'normal_artian', weaponTypeId, elementId, rarity: 8 })
      const counter = confirmedRarity8Counter(input, weaponTypeId)
      if (counter) {
        originNormal[counter.id] = counter.origin
        if (normalSupport.supported) scannedNormal[counter.id] = { from: counter.origin, to: counter.origin + window.normal - 1 }
      }

      // Group-level scan: one prediction per position; every Target of the group reads these.
      const skills = new Map<number, ReturnType<RngEngine['predictSkills']>>()
      if (skillSupport.supported) {
        for (let position = skillRange.from; position <= skillRange.to; position++) {
          await checkpoint()
          predictions.skill += 1
          skills.set(position, engine.predictSkills({ baseSeed: seed, skillCounter: position, weaponTypeId, elementId, master }))
        }
      }
      const resets = new Map<number, { bonuses: RestorationBonusSet; layout: LayoutKey }>()
      if (resetSupport.supported) {
        for (let position = gogmaRange.from; position <= gogmaRange.to; position++) {
          await checkpoint()
          predictions.gogmaReset += 1
          const bonuses = engine.predictGogmaBonus({ baseSeed: seed, gogmaCounter: position, weaponTypeId, elementId, operation: { type: 'reset_bonuses' }, master })
          resets.set(position, { bonuses, layout: keepFamilyLayoutKey(bonuses, master) })
        }
      }
      const normals = new Map<number, { bonuses: RestorationBonusSet; layout: LayoutKey }>()
      if (counter && normalSupport.supported) {
        for (let position = counter.origin; position <= counter.origin + window.normal - 1; position++) {
          await checkpoint()
          predictions.normal += 1
          const bonuses = engine.predictNormalArtian({ baseSeed: seed, weaponTypeId, elementId, rarity: 8, normalCounter: position, master })
          normals.set(position, { bonuses, layout: keepFamilyLayoutKey(bonuses, master) })
        }
      }
      const owned = compatibleOwnedWeapons(input, group)

      // Keep support per concrete five-slot input, memoized per layout; a disagreement inside one layout
      // would contradict the family-only Keep contract and fails closed.
      const keepSupportByLayout = new Map<LayoutKey, { supported: boolean; reason: string | null }>()
      const representativeByLayout = new Map<LayoutKey, RestorationBonusSet>()
      const keepSupport = (bonuses: RestorationBonusSet, layout: LayoutKey) => {
        const result = support({ type: 'gogma_keep', weaponTypeId, elementId, currentBonuses: bonuses, master })
        const known = keepSupportByLayout.get(layout)
        if (known && known.supported !== result.supported) {
          throw new BuildListOptimizationInvariantError('engine_contract_violation',
            `Keep support differs between two five-slot inputs of one family layout (${weaponTypeId} / ${elementId}, layout ${layout.split('\u0000').join('|')}).`)
        }
        if (!known) {
          keepSupportByLayout.set(layout, { supported: result.supported, reason: result.supported ? null : result.reason })
          if (result.supported) representativeByLayout.set(layout, bonuses)
        }
        return result.supported
      }
      const keeps = new Map<string, RestorationBonusSet>()
      const keep = (layout: LayoutKey, position: number): RestorationBonusSet => {
        const key = `${position}\u0000${layout}`
        const memo = keeps.get(key)
        if (memo) { memoHits.gogmaKeep += 1; return memo }
        const representative = representativeByLayout.get(layout)
        if (!representative) throw new BuildListOptimizationInvariantError('prediction_unsupported', `Keep layout ${layout} has no supported representative input.`)
        predictions.gogmaKeep += 1
        const result = engine.predictGogmaBonus({ baseSeed: seed, gogmaCounter: position, weaponTypeId, elementId,
          operation: { type: 'keep_bonuses', currentBonuses: structuredClone(representative) }, master })
        keeps.set(key, result)
        return result
      }
      const groupLayoutsOfInterest = new Set<LayoutKey>()

      for (const target of group.targets) {
        if (!skillSupport.supported) unsupported.push({ targetWeaponId: target.id, prediction: 'skill', reason: skillSupport.reason })
        if (!resetSupport.supported) unsupported.push({ targetWeaponId: target.id, prediction: 'gogma_reset', reason: resetSupport.reason })
        if (!normalSupport.supported) unsupported.push({ targetWeaponId: target.id, prediction: 'normal_artian', reason: normalSupport.reason })
        const idealMultiset = keepFamilyMultisetKey(target.idealBonuses, master)
        const ofInterest = (layout: LayoutKey) => layout.split('\u0000').sort().join('\u0000') === idealMultiset

        const sources: SourceCandidate[] = []
        const excludedOwnedWeapons: TargetReach['excludedOwnedWeapons'] = []
        // Layout-of-interest inputs in deterministic order: owned by ID, Normal by position, Reset by position.
        const interestInputs: { layout: LayoutKey; bonuses: RestorationBonusSet }[] = []
        for (const weapon of owned) {
          const classified = classifyOwnedSource(target, weapon, master)
          if (classified.kind === 'excluded') { excludedOwnedWeapons.push({ ownedWeaponId: weapon.id, reason: classified.reason }); continue }
          const layout = keepFamilyLayoutKey(weapon.restorationBonuses, master)
          const keepSupported = keepSupport(weapon.restorationBonuses, layout)
          if (ofInterest(layout)) interestInputs.push({ layout, bonuses: weapon.restorationBonuses })
          if (weapon.kind === 'gogma') {
            sources.push({ kind: 'owned_gogma', ownedWeaponId: weapon.id, layout, scope: weapon.restorationBonusScope,
              currentSkillIdeal: classified.gogma!.currentSkillIdeal, currentBonusIdeal: classified.gogma!.currentBonusIdeal,
              isProtected: weapon.isProtected, keepSupported })
          } else {
            sources.push({ kind: 'owned_normal', ownedWeaponId: weapon.id, layout, isProtected: false, keepSupported })
          }
        }
        if (counter) {
          for (const [position, normal] of normals) {
            const keepSupported = keepSupport(normal.bonuses, normal.layout)
            if (ofInterest(normal.layout)) interestInputs.push({ layout: normal.layout, bonuses: normal.bonuses })
            sources.push({ kind: 'new_normal', counterId: counter.id, position, layout: normal.layout, keepSupported })
          }
        }
        for (const [, reset] of resets) {
          if (!ofInterest(reset.layout)) continue
          keepSupport(reset.bonuses, reset.layout)
          interestInputs.push({ layout: reset.layout, bonuses: reset.bonuses })
        }

        const layoutsOfInterest = [...new Set(interestInputs.map(({ layout }) => layout))].sort(compareStable)
        const keepIdealPositionsByLayout = new Map<LayoutKey, number[]>()
        const keepUnsupportedLayouts: LayoutKey[] = []
        for (const layout of layoutsOfInterest) {
          groupLayoutsOfInterest.add(layout)
          const supportState = keepSupportByLayout.get(layout)!
          if (!supportState.supported) {
            keepUnsupportedLayouts.push(layout)
            unsupported.push({ targetWeaponId: target.id, prediction: 'gogma_keep', reason: supportState.reason ?? 'unsupported', layout })
            continue
          }
          const positions: number[] = []
          for (let position = gogmaRange.from; position <= gogmaRange.to; position++) {
            await checkpoint()
            if (satisfiesIdealBonuses(target, keep(layout, position), 'gogma_artian', master)) positions.push(position)
          }
          keepIdealPositionsByLayout.set(layout, positions)
        }

        const idealPositions: number[] = []
        for (const [position, result] of skills) {
          if (evaluateSkillCondition(target.idealSkillCondition, result.seriesSkillId, result.groupSkillId)) idealPositions.push(position)
        }
        const resetIdealPositions: number[] = []
        const resetLayoutByPosition = new Map<number, LayoutKey>()
        for (const [position, reset] of resets) {
          resetLayoutByPosition.set(position, reset.layout)
          if (satisfiesIdealBonuses(target, reset.bonuses, 'gogma_artian', master)) resetIdealPositions.push(position)
        }
        // Every Target after the first reads the group's Skill / Reset / Normal results from the memo.
        if (group.targets.indexOf(target) > 0) { memoHits.skill += skills.size; memoHits.gogmaReset += resets.size; memoHits.normal += normals.size }

        reaches.set(target.id, {
          targetWeaponId: target.id, weaponTypeId, elementId,
          normalCounterId: counter?.id ?? null,
          support: { normal: normalSupport.supported, skill: skillSupport.supported, gogmaReset: resetSupport.supported },
          skill: { idealPositions, resetSkillsLimit: originSkill + window.skill - 1, conversionLimit: originSkill + window.skill },
          bonus: { resetIdealPositions, resetLayoutByPosition, keepIdealPositionsByLayout, keepUnsupportedLayouts },
          sources,
          excludedOwnedWeapons,
        })
      }
      summaryGroups.push({ weaponTypeId, elementId, targetWeaponIds: group.targets.map(target => target.id), keepLayoutsOfInterest: [...groupLayoutsOfInterest].sort(compareStable) })
    }
  } catch (error) {
    if (error instanceof CancelledSignal) return { kind: 'cancelled', progress: { predictions, lastGroup } }
    throw error
  }

  const table: ReachTable = {
    optionSet: optionSet.id, continuesCurrentIdealLanes: optionSet.continuesCurrentIdealLanes,
    originSkill, originGogma, originNormal,
    window: { ...window },
    scanned: { skill: skillRange, gogma: gogmaRange, normal: scannedNormal },
    targets: context.planningTargets.map(target => reaches.get(target.id)!),
    summary: { predictions, memoHits, supportQueries, groups: summaryGroups, unsupported },
  }
  return { kind: 'reach_table', table }
}
