import type {
  BuildListEntry,
  BuildListEntryId,
  ExpectedPlanState,
  ExpectedPlanStateOwnedWeapon,
  ExpectedResult,
  InventoryChange,
  ISODateTimeString,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStep,
  PlanStepExecutionEffects,
  PlanStepId,
  ProductionPlanId,
  RngAdvance,
  RngState,
  TargetWeapon,
  TargetWeaponId,
} from '../models/publicTypes'
import {
  areRestorationBonusSlotsEqual,
  createExpectedPlanState,
  hashStableValue,
  normalizeReferencedOwnedWeapon,
  stableStringify,
  V1_NORMAL_ARTIAN_RARITY,
} from '../models/publicTypes'
import { isIntermediatePinHeldAtRouteStart } from './plannerCheckpoints'
import {
  applyProductionPlanStartTargetLinks,
  deriveProductionPlanStartTargetLinks,
} from './productionPlanStartEffects'
import { PlannerPlanGenerationError } from './plannerPlanGenerationError'
import type { PlannerPlanStepDraft } from './plannerTraceReplay'
import type { PlannerDependencies, PlannerInput } from './plannerTypes'
import { createPlanStepPresentation } from './planStepPresentation'

/**
 * The ProductionPlan execution projection (`docs/PLANNER_SPEC.md` 16.3).
 *
 * Candidate Routes and the Planner search keep their own representation - a
 * transient Gogma has no OwnedWeapon ID, and an owned Normal is consumed from
 * the simulated inventory - while a PlanStep binds each physical weapon the
 * Plan keeps working on to one OwnedWeapon ID:
 *
 * - `create_normal_artian` is one Step per forge; every forge before the last
 *   one is a Counter-advance Normal that is never registered, and the last one
 *   is the production target registered under a Planner-reserved ID
 * - conversion updates that same ID (or an owned Normal's own ID) to `gogma`
 * - the Targets of Entries starting from an existing weapon are linked to it by
 *   the Plan start effect, before the first Step; only a registered
 *   production-target Normal is linked by a Step (its registration Step)
 * - every later amendment, and the completion, updates the same ID
 * - the internal reserve is never a Step: its completion rides on the Entry's
 *   last physical Step, and a zero-operation Candidate becomes
 *   `confirm_owned_ideal`
 *
 * It is built deterministically from the settled Trace Replay drafts only and
 * never re-runs an RNG prediction. Nothing here writes a Target or an
 * OwnedWeapon: the effects are recorded for the Execution service to apply.
 */
export interface ProductionPlanExecutionProjectionRequest {
  input: PlannerInput
  drafts: readonly PlannerPlanStepDraft[]
  selectedBuildListEntryIds: readonly BuildListEntryId[]
  /** The settled full Planner run inventory the projection must agree with. */
  searchFinalOwnedWeapons: readonly OwnedWeapon[]
  dependencies: PlannerDependencies
  productionPlanId: ProductionPlanId
  now: ISODateTimeString
}

export interface ProductionPlanExecutionProjection {
  steps: PlanStep[]
  /** Sorted, deduplicated Plan-dependent Target IDs (`docs/PLANNER_SPEC.md` 16.5). */
  dependentTargetWeaponIds: TargetWeaponId[]
  /** The Plan-start premise: the persisted state before the start effect. */
  initialExecutionState: ExpectedPlanState
  /** The state right after the start effect, which the first Step starts from. */
  startExecutionState: ExpectedPlanState
}

interface StepGroup {
  physical: PlannerPlanStepDraft | null
  reserves: PlannerPlanStepDraft[]
}

interface ProjectionSnapshot {
  rngState: RngState
  normalCounters: NormalArtianCounter[]
  weapons: ExpectedPlanStateOwnedWeapon[]
  bindingTokens: Map<OwnedWeaponId, PlanStepId>
  targets: TargetWeapon[]
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fail(message: string): never {
  throw new PlannerPlanGenerationError(`Execution projection: ${message}`)
}

function groupDrafts(
  drafts: readonly PlannerPlanStepDraft[],
  entriesById: ReadonlyMap<BuildListEntryId, BuildListEntry>,
): StepGroup[] {
  const groups: StepGroup[] = []
  drafts.forEach((draft) => {
    if (draft.actionKind === 'route_operation') {
      groups.push({ physical: draft, reserves: [] })
      return
    }
    const entryId = draft.primaryBuildListEntryId
    const entry = entryId === null ? undefined : entriesById.get(entryId)
    if (!entry || entryId === null) fail('a reserve references a missing BuildListEntry.')
    if (entry.candidateSnapshot.route.operations.length === 0) {
      groups.push({ physical: null, reserves: [draft] })
      return
    }
    const last = groups.at(-1)
    if (!last?.physical?.progressedBuildListEntryIds.includes(entryId)) {
      fail(`the reserve of BuildListEntry '${entryId}' does not directly follow its last physical Step.`)
    }
    last.reserves.push(draft)
  })
  return groups
}

function cloneWeapons(
  weapons: ReadonlyMap<OwnedWeaponId, ExpectedPlanStateOwnedWeapon>,
): ExpectedPlanStateOwnedWeapon[] {
  return [...weapons.values()].map((weapon) => structuredClone(weapon))
}

function semanticWeaponKey(weapon: ExpectedPlanStateOwnedWeapon): string {
  if (weapon.restorationBonuses === null) return `unknown:${weapon.id}`
  const known = weapon as OwnedWeapon
  return stableStringify(
    known.kind === 'normal'
      ? { ...normalizeReferencedOwnedWeapon(known), rarity: known.rarity }
      : normalizeReferencedOwnedWeapon(known),
  )
}

function knownWeapon(weapon: ExpectedPlanStateOwnedWeapon): OwnedWeapon | null {
  return weapon.restorationBonuses === null ? null : structuredClone(weapon as OwnedWeapon)
}

function emptyEffects(): PlanStepExecutionEffects {
  return {
    trackedOwnedWeaponId: null,
    normalCreationRole: null,
    registersTrackedWeapon: false,
    observationBinding: null,
    targetLinks: [],
    compromiseLabels: [],
    targetCompletions: [],
  }
}

function zeroRngAdvance(): RngAdvance {
  return {
    gogmaCounterDelta: 0,
    skillCounterDelta: 0,
    normalCounterDelta: null,
    affectedNormalCounterId: null,
  }
}

export function projectProductionPlanExecution(
  request: ProductionPlanExecutionProjectionRequest,
): ProductionPlanExecutionProjection {
  const { input, drafts, dependencies, productionPlanId, now } = request
  const entriesById = new Map(input.buildListEntries.map((entry) => [entry.id, entry]))
  const entryFor = (id: BuildListEntryId): BuildListEntry =>
    entriesById.get(id) ?? fail(`BuildListEntry '${id}' is missing.`)
  const groups = groupDrafts(drafts, entriesById)
  const stepIds = groups.map(() => dependencies.idFactory.planStepId())

  const reservedIdByEntry = new Map<BuildListEntryId, OwnedWeaponId>()
  drafts.forEach((draft) => {
    if (
      draft.actionKind === 'reserve_candidate' &&
      draft.primaryBuildListEntryId !== null &&
      draft.ownedWeaponId !== null
    ) {
      reservedIdByEntry.set(draft.primaryBuildListEntryId, draft.ownedWeaponId)
    }
  })

  // Projection state. Every Target of the input is simulated so a link or a
  // completion clears the preference of whichever other Target held the weapon;
  // only the Plan-dependent ones are hashed afterwards.
  let rngState = structuredClone(input.rngState)
  let normalCounters = structuredClone(input.normalCounters)
  const weapons = new Map<OwnedWeaponId, ExpectedPlanStateOwnedWeapon>(
    input.ownedWeapons.map((weapon) => [weapon.id, structuredClone(weapon)]),
  )
  const bindingTokens = new Map<OwnedWeaponId, PlanStepId>()
  const targets = new Map<TargetWeaponId, TargetWeapon>(
    input.targetWeapons.map((target) => [target.id, structuredClone(target)]),
  )
  const trackedIdByEntry = new Map<BuildListEntryId, OwnedWeaponId>()
  const forgeUnitIndexByEntry = new Map<BuildListEntryId, number>()
  const physicallyStartedEntries = new Set<BuildListEntryId>()

  const snapshot = (): ProjectionSnapshot => ({
    rngState: structuredClone(rngState),
    normalCounters: structuredClone(normalCounters),
    weapons: cloneWeapons(weapons),
    bindingTokens: new Map(bindingTokens),
    targets: [...targets.values()].map((target) => structuredClone(target)),
  })
  const targetOf = (entry: BuildListEntry): TargetWeapon =>
    targets.get(entry.targetWeaponId) ?? fail(`TargetWeapon '${entry.targetWeaponId}' is missing.`)
  const weaponOf = (id: OwnedWeaponId): ExpectedPlanStateOwnedWeapon =>
    weapons.get(id) ?? fail(`tracked OwnedWeapon '${id}' is not in the projected inventory.`)

  const trackedIdFor = (entry: BuildListEntry): OwnedWeaponId => {
    const known = trackedIdByEntry.get(entry.id)
    if (known !== undefined) return known
    const route = entry.candidateSnapshot.route
    if (route.kind === 'normal_artian_to_gogma') {
      fail(`BuildListEntry '${entry.id}' operates on its weapon before registering it.`)
    }
    if (route.sourceOwnedWeaponId === null) {
      fail(`BuildListEntry '${entry.id}' has no source OwnedWeapon.`)
    }
    trackedIdByEntry.set(entry.id, route.sourceOwnedWeaponId)
    return route.sourceOwnedWeaponId
  }
  const link = (effects: PlanStepExecutionEffects, entry: BuildListEntry, weaponId: OwnedWeaponId) => {
    effects.targetLinks.push({ buildListEntryId: entry.id, targetWeaponId: entry.targetWeaponId })
    targets.forEach((target) => {
      if (target.id !== entry.targetWeaponId && target.preferredOwnedWeaponId === weaponId) {
        target.preferredOwnedWeaponId = null
      }
    })
    targetOf(entry).preferredOwnedWeaponId = weaponId
  }
  const labelPractical = (effects: PlanStepExecutionEffects, entry: BuildListEntry, weaponId: OwnedWeaponId) => {
    const weapon = weaponOf(weaponId)
    if (weapon.kind !== 'gogma') {
      fail(`the compromise checkpoint of BuildListEntry '${entry.id}' is not held by a Gogma weapon.`)
    }
    effects.compromiseLabels.push({ buildListEntryId: entry.id, ownedWeaponId: weaponId })
    weapons.set(weaponId, { ...weapon, status: 'practical' })
  }
  const complete = (effects: PlanStepExecutionEffects, entry: BuildListEntry, weaponId: OwnedWeaponId) => {
    const weapon = weaponOf(weaponId)
    if (weapon.kind !== 'gogma' || bindingTokens.has(weaponId)) {
      fail(`BuildListEntry '${entry.id}' completes a weapon that is not a known Gogma result.`)
    }
    const candidate = entry.candidateSnapshot
    effects.targetCompletions.push({
      buildListEntryId: entry.id,
      targetWeaponId: entry.targetWeaponId,
      ownedWeaponId: weaponId,
    })
    weapons.set(weaponId, {
      ...weapon,
      restorationBonuses: structuredClone(candidate.finalBonuses),
      restorationBonusScope: candidate.restorationBonusScope,
      seriesSkillId: candidate.seriesSkillId,
      groupSkillId: candidate.groupSkillId,
      status: 'ideal',
      isProtected: true,
      executionInProgress: null,
    })
    const target = targetOf(entry)
    target.lifecycleStatus = 'completed'
    target.completedAt = now
    target.completedByProductionPlanId = productionPlanId
    targets.forEach((other) => {
      if (other.preferredOwnedWeaponId === weaponId) other.preferredOwnedWeaponId = null
    })
    target.preferredOwnedWeaponId = null
  }

  const initial = snapshot()
  // The Plan start effect (16.2 / 16.11): the Targets of Entries that start
  // from an existing weapon prefer it from the moment the Plan starts.
  applyProductionPlanStartTargetLinks(
    [...targets.values()],
    deriveProductionPlanStartTargetLinks(request.selectedBuildListEntryIds, input.buildListEntries),
  ).forEach((target) => targets.set(target.id, target))
  const started = snapshot()
  const befores: ProjectionSnapshot[] = []
  const afters: ProjectionSnapshot[] = []
  const stepBodies: Omit<PlanStep, 'expectedStateBefore' | 'expectedStateAfter'>[] = []

  groups.forEach((group, index) => {
    const stepId = stepIds[index]
    const first = group.physical ?? group.reserves[0]
    rngState = structuredClone(first.rngStateBefore)
    normalCounters = structuredClone(first.normalCountersBefore)
    befores.push(snapshot())
    const effects = emptyEffects()
    let inventoryChange: InventoryChange | null = null
    let expectedResult: ExpectedResult | null
    let rngAdvance: RngAdvance
    let operationType: PlanStep['operationType']
    let isBlindNormalCreation = false
    const primaryEntry = entryFor(
      first.primaryBuildListEntryId ?? fail('a Step has no primary BuildListEntry.'),
    )

    if (group.physical !== null) {
      const physical = group.physical
      const operation = physical.routeOperation ?? fail('a physical Step has no RouteOperation.')
      operationType = operation.type
      rngAdvance = structuredClone(physical.rngAdvance)
      expectedResult = physical.expectedResult === null ? null : structuredClone(physical.expectedResult)
      const progressedEntries = physical.progressedBuildListEntryIds.map(entryFor)

      if (operation.type === 'create_normal_artian') {
        if (progressedEntries.length !== 1) fail('a Normal creation is never a shared physical action.')
        const entry = progressedEntries[0]
        // The role follows the Route unit this forge executed, never the number
        // of forges the Entry executed so far: a Counter-advance forge another
        // Entry's real forge passed is fast-forwarded and never reaches the
        // trace (Issue #129, `docs/PLANNER_SPEC.md` 7.0.2).
        const position = physical.routePosition ?? fail(`a Normal creation of BuildListEntry '${entry.id}' has no Route position.`)
        if (position.unitCount !== operation.count || position.unitIndex < 0 || position.unitIndex >= operation.count) {
          fail(`BuildListEntry '${entry.id}' forges a Normal outside its Route.`)
        }
        const previousForge = forgeUnitIndexByEntry.get(entry.id)
        if (previousForge !== undefined && position.unitIndex <= previousForge) {
          fail(`BuildListEntry '${entry.id}' forges the same Route Normal twice.`)
        }
        forgeUnitIndexByEntry.set(entry.id, position.unitIndex)
        if (position.unitIndex < operation.count - 1) {
          effects.normalCreationRole = 'counter_advance'
        } else {
          effects.normalCreationRole = 'production_target'
          isBlindNormalCreation = physical.isBlindNormalCreation
          const weaponId = reservedIdByEntry.get(entry.id) ?? dependencies.idFactory.ownedWeaponId()
          if (weapons.has(weaponId)) fail(`the production-target OwnedWeapon ID '${weaponId}' already exists.`)
          trackedIdByEntry.set(entry.id, weaponId)
          const target = targetOf(entry)
          const predicted = physical.expectedResult?.restorationBonuses ?? null
          if (!isBlindNormalCreation && predicted === null) {
            fail(`the predicted production-target Normal of BuildListEntry '${entry.id}' has no predicted slots.`)
          }
          const registered: ExpectedPlanStateOwnedWeapon = {
            id: weaponId,
            kind: 'normal',
            name: target.name,
            weaponTypeId: operation.weaponTypeId,
            elementId: target.elementId,
            rarity: V1_NORMAL_ARTIAN_RARITY,
            restorationBonuses: isBlindNormalCreation ? null : structuredClone(predicted),
            restorationBonusScope: 'normal_artian',
            seriesSkillId: null,
            groupSkillId: null,
            status: null,
            isProtected: false,
            executionInProgress: null,
            memo: null,
            createdAt: now,
            updatedAt: now,
          } as ExpectedPlanStateOwnedWeapon
          weapons.set(weaponId, registered)
          effects.trackedOwnedWeaponId = weaponId
          effects.registersTrackedWeapon = true
          if (isBlindNormalCreation) {
            // The five slots are the user's observation at confirmation, never
            // a prediction, so the expected states carry a binding token.
            effects.observationBinding = { kind: 'normal_restoration_bonuses' }
            bindingTokens.set(weaponId, stepId)
          }
          physicallyStartedEntries.add(entry.id)
          link(effects, entry, weaponId)
          inventoryChange = {
            addOwnedWeapon: knownWeapon(registered),
            removeOwnedWeaponIds: [],
            updateOwnedWeapons: [],
            materialRequirements: [],
          }
        }
      } else {
        const weaponIds = [...new Set(progressedEntries.map(trackedIdFor))]
        if (weaponIds.length !== 1) fail('one physical Step operates on more than one weapon.')
        const weaponId = weaponIds[0]
        const weapon = weaponOf(weaponId)
        const result = physical.expectedResult ?? fail('a physical amendment has no expected result.')
        if (operation.type === 'convert_normal_to_gogma') {
          if (weapon.kind !== 'normal') fail(`conversion source '${weaponId}' is not a Normal Artian.`)
          if (
            weapon.restorationBonuses !== null &&
            (result.restorationBonuses === null ||
              !areRestorationBonusSlotsEqual(weapon.restorationBonuses, result.restorationBonuses))
          ) {
            fail(`conversion of '${weaponId}' does not preserve its five slots.`)
          }
          const { rarity: _rarity, ...rest } = weapon
          void _rarity
          weapons.set(weaponId, {
            ...rest,
            kind: 'gogma',
            seriesSkillId: result.seriesSkillId,
            groupSkillId: result.groupSkillId,
            status: 'unclassified',
          } as ExpectedPlanStateOwnedWeapon)
        } else if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
          if (weapon.kind !== 'gogma' || result.restorationBonuses === null) {
            fail(`a bonus amendment of '${weaponId}' has no Gogma weapon or no result.`)
          }
          if (operation.type === 'keep_bonuses' && bindingTokens.has(weaponId)) {
            fail(`Keep Bonuses cannot read the observation-bound slots of '${weaponId}'.`)
          }
          // Reset Bonuses replaces all five slots, which ends an observation
          // binding (`docs/PLANNER_SPEC.md` 16.5).
          bindingTokens.delete(weaponId)
          weapons.set(weaponId, {
            ...weapon,
            restorationBonuses: structuredClone(result.restorationBonuses),
            restorationBonusScope: 'gogma_artian',
          })
        } else {
          if (weapon.kind !== 'gogma') fail(`Reset Skills of '${weaponId}' has no Gogma weapon.`)
          weapons.set(weaponId, {
            ...weapon,
            seriesSkillId: result.seriesSkillId,
            groupSkillId: result.groupSkillId,
          })
        }
        effects.trackedOwnedWeaponId = weaponId
        progressedEntries.forEach((entry) => {
          if (physicallyStartedEntries.has(entry.id)) return
          physicallyStartedEntries.add(entry.id)
          // An existing weapon was linked by the Plan start effect; only a
          // registered production-target Normal is linked by a Step.
          // A checkpoint already held at Plan start is labelled on the Entry's
          // first physical Step (`docs/PLANNER_SPEC.md` 16.12).
          if (isIntermediatePinHeldAtRouteStart(entry)) labelPractical(effects, entry, weaponId)
        })
      }

      physical.checkpointMilestones.forEach((milestone) => {
        const entry = entryFor(milestone.buildListEntryId)
        if (effects.compromiseLabels.some(({ buildListEntryId }) => buildListEntryId === entry.id)) return
        labelPractical(effects, entry, trackedIdFor(entry))
      })
      group.reserves.forEach((reserve) => {
        const entry = entryFor(reserve.primaryBuildListEntryId ?? fail('a reserve has no Entry.'))
        const weaponId = trackedIdFor(entry)
        if (entry.candidateSnapshot.route.kind === 'normal_artian_to_gogma' && reserve.ownedWeaponId !== weaponId) {
          fail(`the reserved ID of BuildListEntry '${entry.id}' differs from its production-target Normal.`)
        }
        complete(effects, entry, weaponId)
      })
      if (effects.trackedOwnedWeaponId !== null && operation.type !== 'create_normal_artian') {
        inventoryChange = {
          addOwnedWeapon: null,
          removeOwnedWeaponIds: [],
          updateOwnedWeapons: (() => {
            const updated = knownWeapon(weaponOf(effects.trackedOwnedWeaponId))
            return updated === null ? [] : [updated]
          })(),
          materialRequirements: [],
        }
      }
      if (expectedResult !== null) expectedResult.shouldSecure = effects.targetCompletions.length > 0
      rngState = structuredClone((group.reserves.at(-1) ?? physical).rngStateAfter)
      normalCounters = structuredClone((group.reserves.at(-1) ?? physical).normalCountersAfter)
    } else {
      if (group.reserves.length !== 1) fail('a zero-operation confirmation carries exactly one Entry.')
      operationType = 'confirm_owned_ideal'
      rngAdvance = zeroRngAdvance()
      const reserve = group.reserves[0]
      if (reserve.rngAdvance.gogmaCounterDelta !== 0 || reserve.rngAdvance.skillCounterDelta !== 0 || reserve.rngAdvance.normalCounterDelta !== null) {
        fail('a zero-operation confirmation advances a Counter.')
      }
      const weaponId = trackedIdFor(primaryEntry)
      if (weaponOf(weaponId).kind !== 'gogma') fail(`zero-operation source '${weaponId}' is not a Gogma weapon.`)
      effects.trackedOwnedWeaponId = weaponId
      complete(effects, primaryEntry, weaponId)
      const candidate = primaryEntry.candidateSnapshot
      expectedResult = {
        restorationBonuses: structuredClone(candidate.finalBonuses),
        restorationBonusScope: candidate.restorationBonusScope,
        seriesSkillId: candidate.seriesSkillId,
        groupSkillId: candidate.groupSkillId,
        shouldSecure: true,
      }
      inventoryChange = {
        addOwnedWeapon: null,
        removeOwnedWeaponIds: [],
        updateOwnedWeapons: [knownWeapon(weaponOf(weaponId)) ?? fail('confirmed weapon is unknown.')],
        materialRequirements: [],
      }
      rngState = structuredClone(reserve.rngStateAfter)
      normalCounters = structuredClone(reserve.normalCountersAfter)
    }
    afters.push(snapshot())

    const target = targets.get(primaryEntry.targetWeaponId) ?? null
    const presentationTarget = target === null
      ? null
      : input.targetWeapons.find(({ id }) => id === target.id) ?? null
    const progressedTargetWeaponIds = group.physical === null
      ? []
      : [...new Set(group.physical.progressedBuildListEntryIds.map((id) => entryFor(id).targetWeaponId))]
          .sort(compareStableStrings)
    const debugSource = group.physical ?? group.reserves[0]
    stepBodies.push({
      id: stepId,
      order: index + 1,
      operationType,
      ...createPlanStepPresentation(operationType, presentationTarget, {
        isBlindNormalCreation,
        normalCreationRole: effects.normalCreationRole,
      }),
      targetWeaponId: primaryEntry.targetWeaponId,
      buildListEntryId: primaryEntry.id,
      progressedTargetWeaponIds,
      checkpointMilestones: structuredClone(group.physical?.checkpointMilestones ?? []),
      candidateId: primaryEntry.candidateSnapshot.id,
      ownedWeaponId: effects.trackedOwnedWeaponId,
      expectedResult,
      inventoryChange,
      rngAdvance,
      executionEffects: effects,
      requiresUserConfirmation: true,
      isCompleted: false,
      completedAt: null,
      debug: debugSource.debug === null
        ? null
        : {
            ...structuredClone(debugSource.debug),
            plannerReason: operationType,
          },
    })
  })

  assertProjectionMatchesSearch(request, weapons, trackedIdByEntry, reservedIdByEntry)

  const dependentTargetWeaponIds = [
    ...new Set([
      ...request.selectedBuildListEntryIds.map((id) => entryFor(id).targetWeaponId),
      ...stepBodies.flatMap((step) => [
        ...(step.targetWeaponId === null ? [] : [step.targetWeaponId]),
        ...(step.progressedTargetWeaponIds ?? []),
        ...(step.executionEffects?.targetLinks.map(({ targetWeaponId }) => targetWeaponId) ?? []),
        ...(step.executionEffects?.targetCompletions.map(({ targetWeaponId }) => targetWeaponId) ?? []),
      ]),
    ]),
  ].sort(compareStableStrings)

  const hash = (state: ProjectionSnapshot): ExpectedPlanState =>
    createExpectedPlanState(
      state.rngState,
      state.normalCounters,
      state.weapons,
      { targetWeapons: state.targets, dependentTargetWeaponIds },
      state.bindingTokens,
    )
  const initialExecutionState = hash(initial)
  const startExecutionState = hash(started)
  const steps: PlanStep[] = stepBodies.map((body, index) => ({
    ...body,
    expectedStateBefore: hash(befores[index]),
    expectedStateAfter: hash(afters[index]),
  }))
  assertExpectedStateChain(steps, startExecutionState)
  return { steps, dependentTargetWeaponIds, initialExecutionState, startExecutionState }
}

/**
 * The execution projection and the settled search must describe the same
 * weapons. They may differ only in representation: an owned Normal that the
 * search consumed and re-registered under a fresh reserved ID is the same
 * OwnedWeapon ID in the projection, and a production-target Normal of an Entry
 * the search never secured exists only in the projection.
 */
function assertProjectionMatchesSearch(
  request: ProductionPlanExecutionProjectionRequest,
  projected: ReadonlyMap<OwnedWeaponId, ExpectedPlanStateOwnedWeapon>,
  trackedIdByEntry: ReadonlyMap<BuildListEntryId, OwnedWeaponId>,
  reservedIdByEntry: ReadonlyMap<BuildListEntryId, OwnedWeaponId>,
) {
  const searchIdToProjectionId = new Map<OwnedWeaponId, OwnedWeaponId>()
  reservedIdByEntry.forEach((reservedId, entryId) => {
    const tracked = trackedIdByEntry.get(entryId)
    if (tracked !== undefined) searchIdToProjectionId.set(reservedId, tracked)
  })
  // A weapon an unsecured Entry operated on is physically changed in the
  // projection but still an untouched source, a consumed Normal, or no weapon
  // at all in the search, which only registers a result when it secures it.
  const securedTracked = new Set(
    [...trackedIdByEntry].filter(([entryId]) => reservedIdByEntry.has(entryId)).map(([, id]) => id),
  )
  const unsecuredTracked = new Set(
    [...trackedIdByEntry]
      .filter(([entryId, id]) => !reservedIdByEntry.has(entryId) && !securedTracked.has(id))
      .map(([, id]) => id),
  )
  const matched = new Set<OwnedWeaponId>()
  request.searchFinalOwnedWeapons.forEach((weapon) => {
    const projectionId = searchIdToProjectionId.get(weapon.id) ?? weapon.id
    matched.add(projectionId)
    if (unsecuredTracked.has(projectionId)) return
    const counterpart = projected.get(projectionId)
    if (
      counterpart === undefined ||
      semanticWeaponKey(counterpart) !== semanticWeaponKey({ ...weapon, id: projectionId })
    ) {
      fail(`OwnedWeapon '${projectionId}' differs between the settled search and the execution projection.`)
    }
  })
  projected.forEach((_weapon, id) => {
    if (!matched.has(id) && !unsecuredTracked.has(id)) {
      fail(`OwnedWeapon '${id}' exists only in the execution projection.`)
    }
  })
}

function sameExpectedPlanState(left: ExpectedPlanState, right: ExpectedPlanState): boolean {
  return hashStableValue(left) === hashStableValue(right)
}

/**
 * Chain validity (`docs/PLANNER_SPEC.md` 16.5): the first Step starts at the
 * state right after the Plan start effect, and every Step starts where the
 * previous one ended. The projection fails closed on any break.
 */
export function assertExpectedStateChain(
  steps: readonly Pick<PlanStep, 'order' | 'expectedStateBefore' | 'expectedStateAfter'>[],
  startExecutionState: ExpectedPlanState,
): void {
  if (steps.length > 0 && !sameExpectedPlanState(steps[0].expectedStateBefore, startExecutionState)) {
    throw new PlannerPlanGenerationError(
      'The first PlanStep expectedStateBefore differs from the state after the Plan start effect.',
    )
  }
  for (let index = 0; index + 1 < steps.length; index += 1) {
    if (!sameExpectedPlanState(steps[index].expectedStateAfter, steps[index + 1].expectedStateBefore)) {
      throw new PlannerPlanGenerationError(
        `PlanStep expected-state chain is broken between orders ${steps[index].order} and ${steps[index + 1].order}.`,
      )
    }
  }
}
