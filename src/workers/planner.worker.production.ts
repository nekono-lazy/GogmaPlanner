import {
  createProductionPlan,
  createProductionPlannerDependencies,
  preparePlannerInitialContext,
  type ExcludedBuildListEntry,
  type PlannerDependencies,
  type PlannerExcludedEntryWarning,
} from '../domain/planner'
import {
  ProductionRngEngine,
} from '../domain/rng/production/productionRngEngine'
import type { RngEngine } from '../domain/rng/rngEngine'
import type {
  PlannerWorkerCalculations,
  PreparePlannerInteractionCalculation,
} from './planner.worker'
import type { PlannerInteractionExcludedEntry } from './plannerWorkerContracts'

/** Creates the active Planner Engine inside the Worker boundary. */
export function createProductionPlannerRngEngine(): RngEngine {
  return new ProductionRngEngine()
}

/** Composes all runtime-only Planner dependencies inside the Worker. */
export function createProductionPlannerWorkerDependencies(): PlannerDependencies {
  return createProductionPlannerDependencies(createProductionPlannerRngEngine())
}

/**
 * The excluded Entries with the typed warning kind validation recorded for
 * each (`excludedBuildListEntryWarnings`, matched by Entry ID, never by a
 * message). Validation records exactly one warning per excluded Entry; one it
 * did not would be a Domain invariant break, so it fails loudly instead of
 * guessing a kind.
 */
function projectExcludedEntries(
  excluded: readonly ExcludedBuildListEntry[],
  warnings: readonly PlannerExcludedEntryWarning[],
): PlannerInteractionExcludedEntry[] {
  const kindByEntryId = new Map(warnings.map(({ buildListEntryId, warning }) => [buildListEntryId, warning.kind]))
  return excluded.map(({ entry, reason }) => {
    const kind = kindByEntryId.get(entry.id)
    if (kind === undefined) {
      throw new Error(`Excluded BuildListEntry '${entry.id}' carries no typed exclusion warning.`)
    }
    return { buildListEntryId: entry.id, kind, reason }
  })
}

/**
 * Project only the shared Domain helper's validation and current initial
 * Conflicts. No retry, search, or availability rule belongs in this adapter.
 */
const prepareProductionPlannerInteraction: PreparePlannerInteractionCalculation =
  (input, dependencies) => {
    const prepared = preparePlannerInitialContext(input, dependencies)
    if (prepared.status === 'invalid') {
      return {
        status: 'invalid',
        issues: prepared.issues,
        warnings: prepared.warnings,
        excludedBuildListEntries: projectExcludedEntries(
          prepared.excludedBuildListEntries,
          prepared.excludedBuildListEntryWarnings,
        ),
      }
    }
    const { context } = prepared
    return {
      status: 'ready',
      validBuildListEntryIds: context.validBuildListEntries.map(({ entry }) => entry.id),
      excludedBuildListEntries: projectExcludedEntries(
        context.excludedBuildListEntries,
        context.excludedBuildListEntryWarnings,
      ),
      currentConflicts: context.initialConflictDetection.conflicts.map(
        ({ id, buildListEntryIds, checkpointParticipants }) => ({
          id,
          buildListEntryIds: [...buildListEntryIds],
          checkpointParticipants: structuredClone(checkpointParticipants ?? []),
        }),
      ),
    }
  }

/** All Production Planner calculations the Worker controller dispatches to. */
export function createProductionPlannerWorkerCalculations(): PlannerWorkerCalculations {
  return {
    prepareInteraction: prepareProductionPlannerInteraction,
    createPlan: createProductionPlan,
  }
}
