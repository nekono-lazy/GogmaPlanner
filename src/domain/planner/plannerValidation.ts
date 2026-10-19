import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import type {
  BuildListEntry,
  DomainValidationIssue,
  DomainValidationResult,
  InventoryChange,
  OwnedGogmaArtianWeapon,
  OwnedWeapon,
  RestorationBonusSet,
  TargetWeapon,
} from '../models/publicTypes'
import {
  isBlindCreateNormalArtianOperation,
  stableStringify,
  validateBuildCandidate,
  validateBuildListEntryIntermediateStateSelection,
  validateBuildRoute,
  validateOwnedWeapon,
} from '../models/publicTypes'
import {
  evaluateBuildListEntryStaleness,
  findBuildListTargetDuplicates,
  validateBuildListEntryReplacements,
} from '../buildList'
import { validateTargetPreferredOwnedWeapons } from '../target'
import { derivePlannerCheckpointRequirements } from './plannerCheckpoints'
import { derivePlannerPlanningTargets } from './plannerPlanningTargets'
import { collectReferencedOwnedWeaponIds } from '../models/hashing'
import { deriveRngCapabilities } from '../rng/capabilities'
import type { RngPredictionUnsupportedReason } from '../rng/rngEngine'
import {
  getPlannerPredictionSupport,
  type PlannerPredictionSupportCache,
} from './plannerPredictionSupport'
import type {
  ExcludedBuildListEntry,
  PlannerBuildListContext,
  PlannerConflictResolution,
  PlannerDependencies,
  PlannerInput,
  PlannerOptions,
  PlannerWarning,
  ValidatedBuildListEntry,
} from './plannerTypes'
import { PERSISTED_PLANNER_BUILD_LIST_CONTEXT, plannerWarningKinds } from './plannerTypes'

export interface PlannerInputValidationResult extends DomainValidationResult {
  validConflictResolutions: PlannerConflictResolution[]
  validBuildListEntries: ValidatedBuildListEntry[]
  excludedBuildListEntries: ExcludedBuildListEntry[]
  /**
   * The typed exclusion reason of every excluded Entry, in the order of `excludedBuildListEntries`: its ID and the one warning
   * its exclusion added to `warnings` (the same value). A caller that must tell an exclusion warning apart from any other
   * warning (the Build List global optimization's final verification, `docs/PLANNER_SPEC.md` 17.7) reads this instead of
   * parsing a warning message. It adds nothing to `warnings` and changes no validation.
   */
  excludedBuildListEntryWarnings: PlannerExcludedEntryWarning[]
  warnings: PlannerWarning[]
}

/** One excluded Entry and the warning its exclusion added (`PlannerInputValidationResult.excludedBuildListEntryWarnings`). */
export interface PlannerExcludedEntryWarning {
  buildListEntryId: BuildListEntry['id']
  warning: PlannerWarning
}

function issue(
  path: string,
  code: DomainValidationIssue['code'],
  message: string,
): DomainValidationIssue {
  return { path, code, message }
}

/** One Planner bound must be a positive integer; `null` when it is. */
export function plannerPositiveIntegerOptionIssue(
  value: number,
  path: string,
): DomainValidationIssue | null {
  return Number.isInteger(value) && value >= 1
    ? null
    : issue(path, 'invalid_integer', `${path} must be an integer greater than or equal to 1.`)
}

/**
 * The Production Planner options: `maxPlanSteps`, the one Production bound
 * (Issue #103 Phase D-2a). The Beam Search oracle validates its own two bounds
 * on top of this through `validatePlannerBeamSearchOptions()`; the Production
 * scheduler never requires them.
 */
export function validatePlannerOptions(
  options: PlannerOptions,
): DomainValidationResult {
  const issues = [
    plannerPositiveIntegerOptionIssue(options.maxPlanSteps, 'maxPlanSteps'),
  ].filter((entry): entry is DomainValidationIssue => entry !== null)
  if ('preferPracticalBeforeIdeal' in options) {
    issues.push(issue(
      'preferPracticalBeforeIdeal',
      'invalid_structure',
      "'preferPracticalBeforeIdeal' belongs to a legacy Planner contract and is not supported: the Planner has no Practical-first priority and takes no such option.",
    ))
  }
  return { isValid: issues.length === 0, issues }
}

export function validatePlannerWarning(
  warning: PlannerWarning,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!plannerWarningKinds.includes(warning.kind)) {
    issues.push(issue('kind', 'invalid_literal', 'Planner warning kind is invalid.'))
  }
  if (warning.message.trim().length === 0) {
    issues.push(issue('message', 'invalid_structure', 'Planner warning message cannot be empty.'))
  }
  return { isValid: issues.length === 0, issues }
}

function invalidResolutionWarning(
  resolution: PlannerConflictResolution,
  reason: string,
): PlannerWarning {
  return {
    kind: 'invalid_conflict_resolution',
    message: `Conflict resolution '${resolution.conflictKey}' cannot use BuildListEntry '${resolution.selectedBuildListEntryId}': ${reason}`,
  }
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function entryWarning(
  kind: PlannerWarning['kind'],
  entry: BuildListEntry,
  message: string,
): PlannerWarning {
  return { kind, message: `BuildListEntry '${entry.id}' ${message}` }
}

/** Appends the Entry's warning once; returns the warning of that Entry and kind (added now or earlier). */
function appendUniqueEntryWarning(
  warnings: PlannerWarning[], warningKeys: Map<string, PlannerWarning>, entry: BuildListEntry,
  kind: PlannerWarning['kind'], message: string,
): PlannerWarning {
  const key = `${kind}:${entry.id}`
  const existing = warningKeys.get(key)
  if (existing !== undefined) return existing
  const warning = entryWarning(kind, entry, message)
  warningKeys.set(key, warning)
  warnings.push(warning)
  return warning
}

interface EntryPredictionSupportFailure {
  operationType: 'normal_artian' | 'skill' | 'gogma_reset' | 'gogma_keep'
  reason: RngPredictionUnsupportedReason
}

function nextBonusOperation(
  operations: BuildListEntry['candidateSnapshot']['route']['operations'],
  operationIndex: number,
): 'reset_bonuses' | 'keep_bonuses' | null {
  for (let index = operationIndex + 1; index < operations.length; index += 1) {
    const type = operations[index].type
    if (type === 'reset_bonuses' || type === 'keep_bonuses') return type
  }
  return null
}

function initialRouteBonuses(
  input: PlannerInput,
  entry: BuildListEntry,
): RestorationBonusSet | null {
  const sourceId = entry.candidateSnapshot.route.sourceOwnedWeaponId
  if (sourceId === null) return null
  const source = input.ownedWeapons.find(({ id }) => id === sourceId)
  return source ? structuredClone(source.restorationBonuses) : null
}

/**
 * Checks every static semantic input and deterministically advances bonus state
 * only when a later Keep needs the preceding result as its input: the forged
 * Normal slots of a predicted creation, or the preceding Reset/Keep result.
 * It never reconstructs or rewrites the saved RouteOperation sequence.
 */
function entryPredictionSupportFailure(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  entry: BuildListEntry,
  target: TargetWeapon,
  cache: PlannerPredictionSupportCache,
): EntryPredictionSupportFailure | null {
  const engine = dependencies.rngEngine
  const operations = entry.candidateSnapshot.route.operations
  let currentBonuses = initialRouteBonuses(input, entry)

  const query = (
    supportInput: Parameters<typeof getPlannerPredictionSupport>[1],
  ): EntryPredictionSupportFailure | null => {
    const support = getPlannerPredictionSupport(engine, supportInput, cache)
    return support.supported
      ? null
      : { operationType: supportInput.type, reason: support.reason }
  }

  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]
    if (operation.type === 'create_normal_artian') {
      // A blind creation predicts nothing, so it queries no Normal Artian
      // prediction support (`docs/SEARCH_SPEC.md` 6.1.1), and its unknown
      // slots leave `currentBonuses` null until the first Reset.
      if (isBlindCreateNormalArtianOperation(operation)) continue
      const failure = query({
        type: 'normal_artian',
        weaponTypeId: operation.weaponTypeId,
        elementId: target.elementId,
        rarity: operation.rarity,
      })
      if (failure) return failure
      // The converted weapon is the last forged one, whose slots a Keep as the
      // first amendment reads (`docs/SEARCH_SPEC.md` 6.1 / 5.9).
      if (nextBonusOperation(operations, operationIndex) === 'keep_bonuses') {
        currentBonuses = engine.predictNormalArtian({
          baseSeed: input.rngState.baseSeed.value!,
          weaponTypeId: operation.weaponTypeId,
          elementId: target.elementId,
          rarity: operation.rarity,
          normalCounter: operation.normalCounterAfter - 1,
          master: input.master,
        })
      }
      continue
    }
    if (
      operation.type === 'convert_normal_to_gogma' ||
      operation.type === 'reset_skills'
    ) {
      const failure = query({
        type: 'skill',
        weaponTypeId: operation.type === 'convert_normal_to_gogma'
          ? operation.weaponTypeId
          : target.weaponTypeId,
        elementId: target.elementId,
      })
      if (failure) return failure
      continue
    }
    if (operation.type === 'reset_bonuses') {
      const failure = query({
        type: 'gogma_reset',
        weaponTypeId: target.weaponTypeId,
        elementId: target.elementId,
        master: input.master,
      })
      if (failure) return failure
      if (nextBonusOperation(operations, operationIndex) === 'keep_bonuses') {
        currentBonuses = engine.predictGogmaBonus({
          baseSeed: input.rngState.baseSeed.value!,
          gogmaCounter: operation.gogmaCounterBefore,
          weaponTypeId: target.weaponTypeId,
          elementId: target.elementId,
          operation: { type: 'reset_bonuses' },
          master: input.master,
        })
      }
      continue
    }
    if (operation.type === 'keep_bonuses') {
      if (currentBonuses === null) {
        return {
          operationType: 'gogma_keep',
          reason: 'unsupported_current_bonus',
        }
      }
      const failure = query({
        type: 'gogma_keep',
        weaponTypeId: target.weaponTypeId,
        elementId: target.elementId,
        currentBonuses,
        master: input.master,
      })
      if (failure) return failure
      if (nextBonusOperation(operations, operationIndex) === 'keep_bonuses') {
        currentBonuses = engine.predictGogmaBonus({
          baseSeed: input.rngState.baseSeed.value!,
          gogmaCounter: operation.gogmaCounterBefore,
          weaponTypeId: target.weaponTypeId,
          elementId: target.elementId,
          operation: {
            type: 'keep_bonuses',
            currentBonuses: structuredClone(currentBonuses),
          },
          master: input.master,
        })
      }
    }
  }
  return null
}

function currentEntryEligibility(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  entry: BuildListEntry,
  supportCache: PlannerPredictionSupportCache,
): { valid: ValidatedBuildListEntry | null; reason: string; warningKind: PlannerWarning['kind'] } {
  const target = input.targetWeapons.find(({ id }) => id === entry.targetWeaponId) ?? null
  const staleness = evaluateBuildListEntryStaleness(entry, {
    target, rngState: input.rngState, normalCounters: input.normalCounters,
    ownedWeapons: input.ownedWeapons, calculationContext: input.calculationContext,
  })
  if (target === null) {
    return { valid: null, reason: 'references a missing TargetWeapon.', warningKind: 'build_list_entry_stale' }
  }
  if (target.lifecycleStatus === 'completed') {
    // A completed Target's Entry is excluded from Planner input without being
    // stale (`docs/DATA_MODEL.md` 8.1): it needs no re-search, so it reports
    // its own warning kind and its staleness is never rewritten.
    return { valid: null, reason: 'references a completed TargetWeapon.', warningKind: 'completed_target_excluded' }
  }
  if (!isTargetWeaponPlanningEligible(target)) {
    return { valid: null, reason: 'references a disabled TargetWeapon.', warningKind: 'build_list_entry_stale' }
  }
  if (dependencies.rngEngine.version !== input.calculationContext.rngEngineVersion) {
    return { valid: null, reason: 'uses an RNG Engine incompatible with CalculationContext.', warningKind: 'calculation_context_incompatible' }
  }

  if (!validateBuildCandidate(entry.candidateSnapshot).isValid) {
    return { valid: null, reason: 'has an invalid Candidate snapshot.', warningKind: 'build_list_entry_stale' }
  }
  for (const ownedWeaponId of collectReferencedOwnedWeaponIds(entry.candidateSnapshot.route)) {
    const weapon = input.ownedWeapons.find(({ id }) => id === ownedWeaponId)
    if (!weapon || !validateOwnedWeapon(weapon).isValid) {
      return { valid: null, reason: `references an invalid or missing OwnedWeapon '${ownedWeaponId}'.`, warningKind: 'build_list_entry_stale' }
    }
  }
  const routeValidation = validateBuildRoute(
    entry.candidateSnapshot.route,
    input.ownedWeapons,
  )
  if (!routeValidation.isValid) {
    return { valid: null, reason: 'requires an invalid or no-longer-executable BuildRoute.', warningKind: routeValidation.issues.some(({ code }) => code === 'protected_destructive_use') ? 'protected_weapon_required' : 'build_list_entry_stale' }
  }
  if (staleness.isStale) {
    const contextChanged = staleness.staleReasons.includes(
      'calculation_context_changed',
    )
    return {
      valid: null,
      reason: `is stale (${staleness.staleReasons.join(', ')}).`,
      warningKind: contextChanged
        ? 'calculation_context_incompatible'
        : 'build_list_entry_stale',
    }
  }
  const capabilities = deriveRngCapabilities(
    input.rngState,
    input.normalCounters,
    entry.candidateSnapshot.route.operations,
    dependencies.rngEngine.capabilities,
  )
  if (!capabilities.canRunPlanner) {
    return { valid: null, reason: `requires unavailable RNG capability (${capabilities.missingRequirements.join(', ')}).`, warningKind: 'rng_state_missing' }
  }
  const unsupported = entryPredictionSupportFailure(
    input,
    dependencies,
    entry,
    target,
    supportCache,
  )
  if (unsupported) {
    return {
      valid: null,
      reason: `requires unsupported RNG input (${unsupported.operationType}: ${unsupported.reason}).`,
      warningKind: 'rng_prediction_unsupported',
    }
  }
  return { valid: { entry, missingRngRequirements: [...capabilities.missingRequirements] }, reason: '', warningKind: 'build_list_entry_stale' }
}

/**
 * Validates one Planner input against the current state.
 *
 * `buildListContext` defaults to the ordinary `persisted` contract, so every
 * caller that does not explicitly declare a Planner Alternative trial input gets the
 * Build List cardinality fail-closed check (`docs/PLANNER_SPEC.md` 4.1). A
 * trial input gets the same check on its persisted side plus the temporary
 * contract of its replacements (9.2.18).
 *
 * `optionsValidation` defaults to the Production `validatePlannerOptions()`.
 * Only the Beam Search oracle passes its own
 * (`validatePlannerBeamSearchOptions()`), so an invalid oracle bound fails its
 * input closed exactly like an invalid Production bound.
 */
export function validatePlannerInput(
  input: PlannerInput,
  dependencies: PlannerDependencies,
  buildListContext: PlannerBuildListContext = PERSISTED_PLANNER_BUILD_LIST_CONTEXT,
  optionsValidation: DomainValidationResult = validatePlannerOptions(input.options),
): PlannerInputValidationResult {
  const options = optionsValidation
  const issues = [...options.issues]
  const warnings: PlannerWarning[] = []
  const validConflictResolutions: PlannerConflictResolution[] = []
  const warningKeys = new Map<string, PlannerWarning>()
  const supportCache: PlannerPredictionSupportCache = new Map()
  const eligibilityByEntryId = new Map<string, ReturnType<typeof currentEntryEligibility>>()
  const validBuildListEntries: ValidatedBuildListEntry[] = []
  const excludedBuildListEntries: ExcludedBuildListEntry[] = []
  const excludedBuildListEntryWarnings: PlannerExcludedEntryWarning[] = []

  const entriesByStableId = [...input.buildListEntries]
    .sort((left, right) => compareStableStrings(left.id, right.id))
  entriesByStableId.forEach((entry) => {
      // A malformed intermediate state selection is corrupted planning input,
      // not a stale Entry: it fails the whole input closed so that the
      // selection is never read as empty and no other Entry of the Target
      // stands in for it (`docs/PLANNER_SPEC.md` 7.5.9).
      const selection = validateBuildListEntryIntermediateStateSelection(entry)
      if (!selection.isValid) {
        const detail = selection.issues
          .map(({ path, message }) => `${path}: ${message}`)
          .join(' ')
        const message =
          `BuildListEntry '${entry.id}' has an invalid intermediate state selection (${detail}). Clear that selection in the Build List before planning.`
        issues.push(issue(`buildListEntries.${entry.id}.intermediateStateSelection`, 'invalid_state', message))
        warnings.push({ kind: 'invalid_checkpoint_selection', message })
      }
      const eligibility = currentEntryEligibility(
        input,
        dependencies,
        entry,
        supportCache,
      )
      eligibilityByEntryId.set(entry.id, eligibility)
      if (eligibility.valid) {
        validBuildListEntries.push(eligibility.valid)
        return
      }
      excludedBuildListEntries.push({ entry, reason: eligibility.reason })
      const warning = appendUniqueEntryWarning(warnings, warningKeys, entry, eligibility.warningKind, eligibility.reason)
      excludedBuildListEntryWarnings.push({ buildListEntryId: entry.id, warning: { ...warning } })
    })

  // Build List cardinality (`docs/DATA_MODEL.md` 9.4.1, `docs/PLANNER_SPEC.md`
  // 4.1): an ordinary persisted input holds at most one Entry per planning
  // Target. A legacy duplicate leaves the user's Route unknown, so the whole
  // input fails closed; the Planner never picks one by Route length,
  // `createdAt`, staleness or ID. Every Entry of a planning Target counts,
  // stale ones included - counting only the valid Entries would silently run
  // the non-stale one. A Target that is no planning Target (every Entry
  // excluded) is not planned, so its duplicate chooses nothing here and is left
  // to the Build List.
  //
  // A Planner Alternative trial input (`docs/PLANNER_SPEC.md` 9.2.18) is checked the
  // same way on its persisted side - its temporary Entries set aside - and each
  // Target of its replacements must hold exactly `O` + `G` (the preflight's
  // augmented input) or exactly `G` (the replacement set). Temporary 2+,
  // persisted 2+, a temporary Entry of an unknown Target and a replaced Entry
  // that is not unique all fail the whole trial input closed.
  const temporaryIds = new Set(
    buildListContext.kind === 'persisted'
      ? []
      : buildListContext.replacements.map(({ generatedBuildListEntryId }) => generatedBuildListEntryId),
  )
  const planningTargetIds = new Set(
    derivePlannerPlanningTargets(input.targetWeapons, validBuildListEntries).map(({ id }) => id),
  )
  findBuildListTargetDuplicates(
    buildListContext.kind === 'temporary_augmented'
      ? input.buildListEntries.filter(({ id }) => !temporaryIds.has(id))
      : input.buildListEntries,
  )
    .filter(({ targetWeaponId }) => planningTargetIds.has(targetWeaponId))
    .forEach(({ targetWeaponId, buildListEntryIds }) => {
      const message =
        `TargetWeapon '${targetWeaponId}' has ${buildListEntryIds.length} BuildListEntries (${buildListEntryIds.join(', ')}); the Build List holds at most one Entry per Target. Keep one of them in the Build List before planning.`
      issues.push(issue('buildListEntries', 'invalid_structure', message))
      warnings.push({ kind: 'duplicate_build_list_entries_for_target', message })
    })
  if (buildListContext.kind !== 'persisted') {
    issues.push(
      ...validateBuildListEntryReplacements(
        input.buildListEntries,
        buildListContext.replacements,
        buildListContext.kind === 'temporary_augmented' ? 'augmented' : 'replaced',
      ).issues,
    )
  }

  // Collection-level checkpoint invariant (`docs/DATA_MODEL.md` 9.4,
  // `docs/PLANNER_SPEC.md` 7.5.7): two checkpoint-selected Entries of one
  // Target leave the user's intent unknown, so the input fails closed. The
  // Planner never picks one by score, cost, or position.
  derivePlannerCheckpointRequirements(
    validBuildListEntries.map(({ entry }) => entry),
  ).violations.forEach(({ targetWeaponId, buildListEntryIds }) => {
    const message =
      `TargetWeapon '${targetWeaponId}' has ${buildListEntryIds.length} BuildListEntries with a selected intermediate state (${buildListEntryIds.join(', ')}); at most one is allowed. Clear the selection of all but one in the Build List.`
    issues.push(issue('buildListEntries', 'invalid_structure', message))
    warnings.push({ kind: 'multiple_selected_checkpoint_entries', message })
  })

  // The same collection-level authority the save Service and Candidate Search
  // use, so a preference pointing at a missing, incompatible, protected, or
  // double-claimed weapon fails the Planner input closed rather than silently
  // preferring nothing (`docs/DATA_MODEL.md` 8.5).
  issues.push(
    ...validateTargetPreferredOwnedWeapons(
      input.targetWeapons,
      input.ownedWeapons,
    ).issues,
  )
  // The authority is the valid Entry set, not the raw input: Entries that were
  // all excluded above leave the run with no planning Target, exactly as an
  // empty Build List does (`docs/PLANNER_SPEC.md` 4 / 7.2.1).
  if (validBuildListEntries.length === 0) {
    warnings.push({ kind: 'no_build_list_entries', message: 'No BuildListEntry is available for Planner input.' })
  }
  const conflictKeys = new Set<string>()

  input.conflictResolutions.forEach((resolution, index) => {
    const path = `conflictResolutions[${index}]`
    if (resolution.conflictKey.trim().length === 0) {
      issues.push(issue(`${path}.conflictKey`, 'invalid_id', 'conflictKey cannot be empty.'))
      return
    }
    if (conflictKeys.has(resolution.conflictKey)) {
      issues.push(issue(`${path}.conflictKey`, 'invalid_id', 'conflictKey must be unique.'))
      return
    }
    conflictKeys.add(resolution.conflictKey)
    const eligibility = eligibilityByEntryId.get(resolution.selectedBuildListEntryId)
    if (!eligibility) {
      warnings.push(invalidResolutionWarning(resolution, 'the entry no longer exists.'))
      return
    }
    if (eligibility.valid === null) {
      warnings.push(invalidResolutionWarning(resolution, eligibility.reason))
      return
    }
    validConflictResolutions.push(resolution)
  })

  return {
    isValid: issues.length === 0,
    issues,
    validConflictResolutions,
    validBuildListEntries,
    excludedBuildListEntries,
    excludedBuildListEntryWarnings,
    warnings,
  }
}

function sameBonusSlots(
  left: OwnedGogmaArtianWeapon['restorationBonuses'],
  right: OwnedGogmaArtianWeapon['restorationBonuses'],
): boolean {
  return stableStringify(left) === stableStringify(right)
}

function validateReservedGogma(
  entry: BuildListEntry,
  weapon: OwnedWeapon,
  path: string,
  issues: DomainValidationIssue[],
  expectedProtection: boolean,
) {
  const candidate = entry.candidateSnapshot
  if (weapon.kind !== 'gogma') {
    issues.push(issue(path, 'invalid_state', 'reserve_weapon must secure a Gogma Artian weapon.'))
    return
  }
  if (
    // Every Candidate is a canonical Ideal Candidate, so a secured weapon
    // always carries the Ideal label.
    weapon.status !== 'ideal' ||
    weapon.isProtected !== expectedProtection ||
    !sameBonusSlots(weapon.restorationBonuses, candidate.finalBonuses) ||
    weapon.seriesSkillId !== candidate.seriesSkillId ||
    weapon.groupSkillId !== candidate.groupSkillId
  ) {
    issues.push(issue(path, 'inconsistent_snapshot', 'The reserved weapon must preserve the Candidate result, category, and required protection state.'))
  }
}

/** Validates reserve_weapon inventory semantics without constructing Planner steps. */
export function validateReserveWeaponInventoryChange(
  entry: BuildListEntry,
  beforeInventory: readonly OwnedWeapon[],
  change: InventoryChange,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const route = entry.candidateSnapshot.route
  const added = change.addOwnedWeapon

  if (route.kind === 'normal_artian_to_gogma') {
    if (!added) {
      issues.push(issue('addOwnedWeapon', 'invalid_structure', 'A new-Normal route must add a new Gogma weapon.'))
    } else {
      validateReservedGogma(
        entry,
        added,
        'addOwnedWeapon',
        issues,
        true,
      )
    }
    if (change.removeOwnedWeaponIds.length > 0 || change.updateOwnedWeapons.length > 0) {
      issues.push(issue('', 'invalid_state', 'A new-Normal route must not remove or update an existing weapon.'))
    }
  } else if (route.kind === 'owned_normal_artian_to_gogma') {
    const sourceId = route.sourceOwnedWeaponId
    if (!added) {
      issues.push(issue('addOwnedWeapon', 'invalid_structure', 'An owned-Normal route must add a new Gogma weapon.'))
    } else {
      validateReservedGogma(
        entry,
        added,
        'addOwnedWeapon',
        issues,
        true,
      )
      if (added.id === sourceId) {
        issues.push(issue('addOwnedWeapon.id', 'invalid_reference', 'The converted Gogma weapon must use a new OwnedWeapon ID.'))
      }
    }
    if (
      change.removeOwnedWeaponIds.length > 0 ||
      change.updateOwnedWeapons.length > 0
    ) {
      issues.push(issue('', 'invalid_state', 'The source Normal weapon was already consumed by convert_normal_to_gogma; reserve_weapon only adds the new Gogma weapon.'))
    }
  } else {
    const sourceId = route.sourceOwnedWeaponId
    const source = beforeInventory.find(({ id }) => id === sourceId)
    if (!source || source.kind !== 'gogma') {
      issues.push(issue('sourceOwnedWeaponId', 'invalid_reference', 'An existing-Gogma route must update its source Gogma weapon.'))
    }
    if (added !== null || change.removeOwnedWeaponIds.length > 0) {
      issues.push(issue('', 'invalid_state', 'An existing-Gogma route must not add or remove an OwnedWeapon.'))
    }
    if (
      sourceId === null ||
      change.updateOwnedWeapons.length !== 1 ||
      change.updateOwnedWeapons[0].id !== sourceId
    ) {
      issues.push(issue('updateOwnedWeapons', 'invalid_reference', 'An existing-Gogma route must update the same source OwnedWeapon ID.'))
    } else {
      const updated = change.updateOwnedWeapons[0]
      validateReservedGogma(
        entry,
        updated,
        'updateOwnedWeapons[0]',
        issues,
        // Ideal completion protects an existing weapon too
        // (`docs/PLANNER_SPEC.md` 16.13); its former protection is not kept.
        true,
      )
      if (source?.kind === 'gogma' && updated.createdAt !== source.createdAt) {
        issues.push(issue('updateOwnedWeapons[0]', 'invalid_state', 'createdAt must be preserved.'))
      }
    }
  }
  return { isValid: issues.length === 0, issues }
}

/** Validates the inventory transition of an owned-Normal conversion PlanStep. */
export function validateOwnedNormalConversionInventoryChange(
  entry: BuildListEntry,
  beforeInventory: readonly OwnedWeapon[],
  change: InventoryChange,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const route = entry.candidateSnapshot.route
  if (route.kind !== 'owned_normal_artian_to_gogma') {
    issues.push(issue('route.kind', 'invalid_literal', 'This conversion contract applies only to owned_normal_artian_to_gogma.'))
    return { isValid: false, issues }
  }
  const sourceId = route.sourceOwnedWeaponId
  const source = beforeInventory.find(({ id }) => id === sourceId)
  if (!source || source.kind !== 'normal') {
    issues.push(issue('sourceOwnedWeaponId', 'invalid_reference', 'convert_normal_to_gogma requires its source Normal Artian in the current inventory.'))
  } else if (source.isProtected) {
    issues.push(issue('sourceOwnedWeaponId', 'protected_destructive_use', 'A protected Normal Artian cannot be converted.'))
  }
  if (
    sourceId === null ||
    change.removeOwnedWeaponIds.length !== 1 ||
    change.removeOwnedWeaponIds[0] !== sourceId
  ) {
    issues.push(issue('removeOwnedWeaponIds', 'invalid_state', 'convert_normal_to_gogma must remove the source Normal Artian exactly once.'))
  }
  if (change.addOwnedWeapon !== null || change.updateOwnedWeapons.length > 0) {
    issues.push(issue('', 'invalid_state', 'Conversion removes the Normal source but does not register or update a Gogma OwnedWeapon.'))
  }
  return { isValid: issues.length === 0, issues }
}
