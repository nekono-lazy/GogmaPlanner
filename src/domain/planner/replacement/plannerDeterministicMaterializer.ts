import {
  createBuildCandidateMeaningFingerprint,
  createBuildListEntry,
  createTargetDefinitionHash,
  evaluateBuildListEntryStaleness,
  type BuildListStalenessContext,
} from '../../buildList'
import {
  hashStableValue,
  isCalculationContextCompatible,
  validateBuildCandidate,
} from '../../models/publicTypes'
import type {
  BuildCandidate,
  BuildCandidateId,
  BuildListEntry,
  BuildListEntryId,
  CandidateBonusAmendmentStep,
  CandidateConversionSkillStep,
  CandidateSkillAmendmentStep,
  ISODateTimeString,
  TargetWeapon,
} from '../../models/publicTypes'
import { extractIntermediateStateGroups } from '../../search'
import type {
  ConstrainedCandidate,
  ConstrainedSearchOrigin,
} from '../../search'
import type { PlannerClock } from '../plannerTypes'
import { ConstrainedMaterializationError } from './plannerMaterializationErrors'

/** One materialized generated Entry and the Candidate snapshot it carries. */
export interface GeneratedBuildListEntryResult {
  entry: BuildListEntry
  candidate: BuildCandidate
  /**
   * True when a current, non-stale BuildListEntry already carried this exact
   * semantic content. A reused Entry keeps its own ID, its own `createdAt`, and
   * its own Candidate snapshot, so the caller must not persist it again.
   */
  reusedExisting: boolean
}

/**
 * One transient semantic result a deterministic materializer converts: the
 * B8 `ConstrainedCandidate`, or a Planner Alternative Candidate that also
 * carries the ordinary observational traces (`docs/SEARCH_SPEC.md` 5.6.8).
 * The traces are carried over as they are - never re-predicted - and take no
 * part in any identity.
 */
export interface DeterministicMaterializationSource extends ConstrainedCandidate {
  bonusAmendmentTrace?: CandidateBonusAmendmentStep[]
  skillAmendmentTrace?: CandidateSkillAmendmentStep[]
  conversionSkillTrace?: CandidateConversionSkillStep
}

export interface DeterministicMaterializer<TSource extends DeterministicMaterializationSource> {
  readonly target: TargetWeapon
  /** The deterministic search identity, also the `searchRunId`. */
  readonly searchIdentity: string
  materializeCandidate(candidate: TSource): BuildCandidate
  materializeBuildListEntry(
    candidate: TSource,
    existingEntries: readonly BuildListEntry[],
  ): GeneratedBuildListEntryResult
}

function deterministicCandidateId(
  candidateIdPrefix: string,
  searchIdentity: string,
  meaningFingerprint: string,
): BuildCandidateId {
  const suffix = hashStableValue({
    searchIdentity,
    meaning: meaningFingerprint,
  }).replace(':', '-')
  return `${candidateIdPrefix}${suffix}` as BuildCandidateId
}

/**
 * The generated BuildListEntry ID (PLANNER_SPEC 9.2.13).
 *
 * It is derived from the Candidate semantic meaning, the Target definition
 * hash, both Search hashes, and the `CalculationContext`. `createdAt`, the
 * Clock, a random UUID, a request UUID, an enumeration ordinal, and the kernel
 * that found the Candidate are all absent, which is exactly why the ordinary
 * `createBuildListEntry()` default ID - meaning plus `createdAt` - cannot be
 * reused here. One semantic content therefore has one generated Entry ID.
 *
 * The `build-list.constrained.` prefix is part of the ID value itself. It is
 * kept exactly as B8 introduced it, although the B8 adapter was removed in
 * Phase 6-B2b: changing it would change every generated Entry ID.
 */
function deterministicEntryId(
  candidate: BuildCandidate,
  meaningFingerprint: string,
  targetDefinitionHash: string,
): BuildListEntryId {
  const suffix = hashStableValue({
    meaning: meaningFingerprint,
    targetDefinitionHash,
    searchStateHash: candidate.searchStateHash,
    referencedOwnedWeaponsHash: candidate.referencedOwnedWeaponsHash,
    calculationContext: {
      gameVersion: candidate.calculationContext.gameVersion,
      masterDataVersion: candidate.calculationContext.masterDataVersion,
      rngEngineVersion: candidate.calculationContext.rngEngineVersion,
      appSchemaVersion: candidate.calculationContext.appSchemaVersion,
    },
  }).replace(':', '-')
  return `build-list.constrained.${suffix}` as BuildListEntryId
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export interface DeterministicMaterializationCoreContext {
  origin: ConstrainedSearchOrigin
  target: TargetWeapon
  /** The kernel's own deterministic search identity (PLANNER_SPEC 9.2.13). */
  searchIdentity: string
  /** The `BuildCandidate.id` prefix naming the kernel that found the Candidate. */
  candidateIdPrefix: string
  clock: PlannerClock
}

/**
 * The shared deterministic materialization core (PLANNER_SPEC 9.2.13): the
 * Planner Alternative adapter (`createPlannerAlternativeMaterializer()`) passes
 * its own search identity and Candidate ID prefix. A shared Planner Domain
 * primitive since Phase 6-B2a (PLANNER_SPEC 9.2.19.16); the legacy B8
 * constrained adapter that also used it was removed in Phase 6-B2b.
 *
 * It converts one transient semantic result into `BuildCandidate` shape and,
 * when the Planner needs it as trial input, into a generated `BuildListEntry`
 * of the ordinary persisted shape - no new provenance field and no new entity.
 *
 * It recomputes no Search semantics. The completed five slots and their scope,
 * Skills, the concrete Route, every estimate, the material requirements,
 * `idealDifference`, both hashes, the `CalculationContext` and any
 * observational trace are carried over unchanged. It adds only what the Search
 * Domain deliberately could not produce: the deterministic IDs, the
 * Clock-derived `createdAt`, and the intermediate state groups of the
 * materialized Candidate's own Route, from the same
 * `extractIntermediateStateGroups()` authority an ordinary Candidate uses.
 *
 * It is pure apart from the injected `PlannerClock`: no `crypto.randomUUID()`,
 * no `new Date()`, no persistence, and no ordinary-Search candidate factory.
 */
export function createDeterministicMaterializer<TSource extends DeterministicMaterializationSource>(
  context: DeterministicMaterializationCoreContext,
): DeterministicMaterializer<TSource> {
  const { target, searchIdentity } = context
  const targetDefinitionHash = createTargetDefinitionHash(target)
  const stalenessContext: BuildListStalenessContext = {
    target,
    rngState: context.origin.rngState,
    normalCounters: context.origin.normalCounters,
    ownedWeapons: context.origin.ownedWeapons,
    calculationContext: context.origin.calculationContext,
  }

  function buildCandidate(
    source: TSource,
    createdAt: ISODateTimeString,
  ): BuildCandidate {
    if (source.targetWeaponId !== target.id) {
      throw new ConstrainedMaterializationError(
        'target_mismatch',
        `The materialized Candidate targets "${source.targetWeaponId}", not "${target.id}".`,
      )
    }
    const semantic = structuredClone(source)
    const withoutId = {
      targetWeaponId: semantic.targetWeaponId,
      finalBonuses: semantic.finalBonuses,
      restorationBonusScope: semantic.restorationBonusScope,
      seriesSkillId: semantic.seriesSkillId,
      groupSkillId: semantic.groupSkillId,
      route: semantic.route,
      estimatedOperationCount: semantic.estimatedOperationCount,
      estimatedGogmaAdvance: semantic.estimatedGogmaAdvance,
      estimatedSkillAdvance: semantic.estimatedSkillAdvance,
      estimatedNormalAdvance: semantic.estimatedNormalAdvance,
      requiredMaterials: semantic.requiredMaterials,
      idealDifference: semantic.idealDifference,
      searchStateHash: semantic.searchStateHash,
      referencedOwnedWeaponsHash: semantic.referencedOwnedWeaponsHash,
      calculationContext: semantic.calculationContext,
      searchRunId: searchIdentity,
      createdAt,
      ...(semantic.bonusAmendmentTrace === undefined
        ? {}
        : { bonusAmendmentTrace: semantic.bonusAmendmentTrace }),
      ...(semantic.skillAmendmentTrace === undefined
        ? {}
        : { skillAmendmentTrace: semantic.skillAmendmentTrace }),
      ...(semantic.conversionSkillTrace === undefined
        ? {}
        : { conversionSkillTrace: semantic.conversionSkillTrace }),
    }
    const candidate: BuildCandidate = {
      ...withoutId,
      id: deterministicCandidateId(
        context.candidateIdPrefix,
        searchIdentity,
        createBuildCandidateMeaningFingerprint(withoutId),
      ),
    }
    // Derived from the finished Route, its observational traces (when the
    // source carries them) and the Route base OwnedWeapon only, so it adds no
    // RNG prediction call (`docs/SEARCH_SPEC.md` 5.8.1). A B8
    // `ConstrainedCandidate` carries no trace, so only a lane start an existing
    // source weapon already holds can be offered for it, never an invented
    // amendment result (`docs/PLANNER_SPEC.md` 9.2.13).
    candidate.intermediateStateGroups = extractIntermediateStateGroups(candidate, {
      target,
      master: context.origin.master,
      ownedWeapons: context.origin.ownedWeapons,
    })
    const valid = validateBuildCandidate(candidate, context.origin.ownedWeapons)
    if (!valid.isValid) {
      throw new ConstrainedMaterializationError(
        'invalid_candidate',
        valid.issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
      )
    }
    return candidate
  }

  /**
   * Whether one existing Entry holds exactly the current semantic content.
   *
   * PLANNER_SPEC 9.2.12 requires all of it: the Candidate semantic meaning, the
   * Target definition hash, both Search hashes, the `CalculationContext`, and a
   * currently empty staleness recomputed from live state rather than read off
   * the persisted `isStale` flag. `createdAt` is deliberately absent - a past
   * run's timestamp differs from this run's Clock and says nothing about
   * semantic content.
   */
  function isCurrentSemanticMatch(
    entry: BuildListEntry,
    candidate: BuildCandidate,
    meaningFingerprint: string,
  ): boolean {
    return (
      entry.targetWeaponId === candidate.targetWeaponId &&
      createBuildCandidateMeaningFingerprint(entry.candidateSnapshot) ===
        meaningFingerprint &&
      entry.targetDefinitionHash === targetDefinitionHash &&
      entry.searchStateHash === candidate.searchStateHash &&
      entry.referencedOwnedWeaponsHash === candidate.referencedOwnedWeaponsHash &&
      isCalculationContextCompatible(
        entry.calculationContext,
        candidate.calculationContext,
      ) &&
      !evaluateBuildListEntryStaleness(entry, stalenessContext).isStale
    )
  }

  return {
    target,
    searchIdentity,
    materializeCandidate: (candidate) =>
      buildCandidate(candidate, context.clock.now()),
    materializeBuildListEntry: (source, existingEntries) => {
      const createdAt = context.clock.now()
      const candidate = buildCandidate(source, createdAt)
      const meaningFingerprint = createBuildCandidateMeaningFingerprint(candidate)
      const entryId = deterministicEntryId(
        candidate,
        meaningFingerprint,
        targetDefinitionHash,
      )

      // Every Entry holding the deterministic ID is checked, not just the first
      // one found: a single divergent holder fails the whole materialization,
      // so the outcome cannot depend on `existingEntries` array order.
      const sameId = existingEntries.filter(({ id }) => id === entryId)
      if (
        sameId.some(
          (entry) => !isCurrentSemanticMatch(entry, candidate, meaningFingerprint),
        )
      ) {
        throw new ConstrainedMaterializationError(
          'generated_entry_id_collision',
          `BuildListEntry "${entryId}" already exists with different current semantic content.`,
        )
      }

      // A stale or otherwise divergent same-meaning Entry stays history: it is
      // never updated into a current Entry, and a new deterministic Entry is
      // created beside it (PLANNER_SPEC 9.2.12). Reuse picks the lowest matching
      // ID so the input array order cannot decide the outcome.
      const reusable = existingEntries
        .filter((entry) =>
          isCurrentSemanticMatch(entry, candidate, meaningFingerprint),
        )
        .sort((left, right) => compareIds(left.id, right.id))[0]
      if (reusable) {
        const entry = structuredClone(reusable)
        return { entry, candidate: entry.candidateSnapshot, reusedExisting: true }
      }

      return {
        entry: createBuildListEntry(candidate, target, {
          id: entryId,
          createdAt,
        }),
        candidate,
        reusedExisting: false,
      }
    },
  }
}
