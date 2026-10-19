import { isTargetWeaponPlanningEligible } from '../models/domainRules'
import { TargetSearchScheduler } from './targetSearchScheduler'
import type { BuildCandidate, OwnedWeaponId, RestorationBonusSet, RouteKind, TargetWeapon } from '../models/publicTypes'
import type { RngEngine } from '../rng/rngEngine'
import { validateTargetIdealImpliesPractical } from '../target'
import { selectCanonicalIdealCandidate } from './candidateRetention'
import { compareStableKeys } from './semanticKeys'
import { searchExistingGogmaRoutes } from './existingGogmaRouteSearch'
import { searchNormalArtianRoutes } from './normalArtianRouteSearch'
import { searchOwnedNormalArtianRoutes } from './ownedNormalArtianRouteSearch'
import { createTargetBonusStream } from './bonusStream'
import { createSearchPredictionSupport, type CandidateSearchRouteContext } from './routeSearchShared'
import { createTargetSkillStream } from './skillStream'
import {
  bonusStreamInputForSearch,
  routeSearchInputForSearch,
  skillStreamInputForSearch,
} from './searchStreamInputs'
import {
  createSearchExecutionContext,
  type CandidateSearchExecutionOptions,
} from './searchExecution'
import type {
  CandidateSearchInput,
  CandidateSearchResult,
  CandidateSearchWarning,
  SkippedRoute,
  TargetCandidateSearchResult,
} from './searchTypes'
import { assertCandidateSearchInput } from './searchValidation'

const routeOrder: RouteKind[] = [
  'normal_artian_to_gogma',
  'owned_normal_artian_to_gogma',
  'existing_gogma_current',
  'existing_gogma_reset_bonuses',
  'existing_gogma_keep_bonuses',
  'existing_gogma_reset_skills',
  'existing_gogma_mixed',
]
const normalRouteKinds: RouteKind[] = [
  'normal_artian_to_gogma',
  'owned_normal_artian_to_gogma',
]
const existingGogmaRouteKinds: RouteKind[] = [
  'existing_gogma_current',
  'existing_gogma_reset_bonuses',
  'existing_gogma_keep_bonuses',
  'existing_gogma_reset_skills',
  'existing_gogma_mixed',
]

function routeKindsForFilter(
  filter: CandidateSearchInput['routeFilter'],
): RouteKind[] {
  if (filter === 'normal_artian') return normalRouteKinds
  if (filter === 'existing_gogma') return existingGogmaRouteKinds
  return routeOrder
}

function uniqueSkippedRoutes(routes: readonly SkippedRoute[]): SkippedRoute[] {
  const keys = new Set<string>()
  return routes.filter((route) => {
    const key = `${route.route}\u0000${route.reason}\u0000${route.detail}`
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

/**
 * The one TargetWeapon this request searches, or a warning explaining why it
 * cannot be searched (`docs/SEARCH_SPEC.md` 4.1).
 *
 * A disabled or completed Target is refused rather than silently skipped: the
 * Search UI only offers enabled active Targets, so reaching one here means the
 * request no longer matches current data.
 */
function selectedTarget(
  input: CandidateSearchInput,
): { target: TargetWeapon | null; warnings: CandidateSearchWarning[] } {
  const target = input.targetWeapons.find(({ id }) => id === input.targetWeaponId) ?? null
  if (!target) {
    return {
      target: null,
      warnings: [{
        targetWeaponId: input.targetWeaponId,
        severity: 'warning',
        message: `TargetWeapon '${input.targetWeaponId}' does not exist and was not searched.`,
      }],
    }
  }
  if (!isTargetWeaponPlanningEligible(target)) {
    return {
      target: null,
      warnings: [{
        targetWeaponId: target.id,
        severity: 'warning',
        message: target.lifecycleStatus === 'active'
          ? `TargetWeapon '${target.id}' is disabled and was not searched.`
          : `TargetWeapon '${target.id}' is completed and was not searched.`,
      }],
    }
  }
  const containment = validateTargetIdealImpliesPractical(target, input.master)
  if (!containment.isValid) {
    return {
      target: null,
      warnings: [{
        targetWeaponId: target.id,
        severity: 'warning',
        message: `TargetWeapon '${target.id}' violates the Ideal implies Practical containment invariant and was not searched: ${containment.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join(' / ')}`,
      }],
    }
  }
  return { target, warnings: [] }
}

function contextSkippedRoutes(input: CandidateSearchInput): SkippedRoute[] {
  const detail = 'The RNG Engine version does not match CalculationContext.'
  return routeKindsForFilter(input.routeFilter).map((route) => ({
    route,
    reason: 'calculation_context_incompatible',
    detail,
  }))
}

async function searchTarget(
  target: TargetWeapon,
  input: CandidateSearchInput,
  engine: RngEngine,
  execution: ReturnType<typeof createSearchExecutionContext>,
): Promise<{ result: TargetCandidateSearchResult; warnings: CandidateSearchWarning[] }> {
  const skippedRoutes: SkippedRoute[] = []
  const searchedRoutes: RouteKind[] = []
  const candidates: BuildCandidate[] = []
  const warnings: CandidateSearchWarning[] = []

  if (engine.version !== input.calculationContext.rngEngineVersion) {
    return {
      result: {
        targetWeaponId: target.id,
        candidate: null,
        searchedRoutes: [],
        skippedRoutes: contextSkippedRoutes(input),
        // No Route base was enumerated, so no source was excluded from one.
        excludedSourceOwnedWeaponIds: [],
      },
      warnings,
    }
  }

  const predictionSupport = createSearchPredictionSupport(engine, target, input.master)
  const routeContext: CandidateSearchRouteContext = {
    target,
    input: routeSearchInputForSearch(input),
    searchInput: input,
    // The ordinary request alone carries a source exclusion (SEARCH_SPEC 3.3).
    excludedSourceOwnedWeaponIds: new Set(input.excludedSourceOwnedWeaponIds ?? []),
    engine,
    execution,
    predictionSupport,
    normalPredictions: new Map<number, RestorationBonusSet>(),
    // One Skill stream per Target, shared by every RouteKind and Route base.
    skillStream: createTargetSkillStream(
      target,
      skillStreamInputForSearch(input),
      engine,
      execution,
      () => predictionSupport.skill().supported,
    ),
    // One Bonus stream per Target. Reset is predicted once per Gogma Counter
    // position and Keep once per (position, family layout), shared by every
    // source weapon and every Normal offset.
    bonusStream: createTargetBonusStream(
      target,
      bonusStreamInputForSearch(input),
      engine,
      execution,
      predictionSupport,
    ),
  }

  if (input.routeFilter === 'existing_gogma') {
    skippedRoutes.push(...normalRouteKinds.map((route) => ({
      route, reason: 'disabled_by_filter' as const,
      detail: 'Normal Artian routes are disabled by routeFilter.',
    })))
  }
  if (input.routeFilter === 'normal_artian') {
    skippedRoutes.push(...existingGogmaRouteKinds.map((route) => ({
      route, reason: 'disabled_by_filter' as const,
      detail: 'Existing Gogma routes are disabled by routeFilter.',
    })))
  }

  const scheduler = new TargetSearchScheduler(routeContext)
  const searchers = [
    ...(input.routeFilter === 'existing_gogma' ? [] : [searchNormalArtianRoutes, searchOwnedNormalArtianRoutes]),
    ...(input.routeFilter === 'normal_artian' ? [] : [searchExistingGogmaRoutes]),
  ]
  const routeResults = []
  for (const search of searchers) routeResults.push(await search(routeContext, scheduler))
  await scheduler.run()
  const excludedSourceOwnedWeaponIds = new Set<OwnedWeaponId>()
  for (const found of routeResults) {
    found.finalize?.()
    candidates.push(...found.candidates)
    searchedRoutes.push(...found.searchedRoutes)
    skippedRoutes.push(...found.skippedRoutes)
    for (const id of found.excludedSourceOwnedWeaponIds ?? []) excludedSourceOwnedWeaponIds.add(id)
    for (const warning of found.warnings) {
      if (!warnings.some((existing) => existing.message === warning.message)) warnings.push(warning)
    }
  }

  // At most one canonical Ideal. A compromise state discovered on the way is
  // never returned as a Candidate: only an intermediate state on a lane of an
  // actual Ideal Route may be offered, and without an Ideal there is no such
  // lane (`docs/SEARCH_SPEC.md` 5.7).
  const candidate = selectCanonicalIdealCandidate(
    candidates,
    target.preferredOwnedWeaponId,
  )
  const orderedSearchedRoutes = routeOrder.filter((route) =>
    searchedRoutes.includes(route),
  )
  const searchedRouteSet = new Set(orderedSearchedRoutes)
  return {
    result: {
      targetWeaponId: target.id,
      candidate,
      searchedRoutes: orderedSearchedRoutes,
      skippedRoutes: uniqueSkippedRoutes(skippedRoutes).filter(
        ({ route }) => !searchedRouteSet.has(route),
      ),
      // Code unit order, never `localeCompare` (SEARCH_SPEC 3.3).
      excludedSourceOwnedWeaponIds: [...excludedSourceOwnedWeaponIds].sort(compareStableKeys),
    },
    warnings,
  }
}

export async function searchCandidates(
  input: CandidateSearchInput,
  engine: RngEngine,
  options: CandidateSearchExecutionOptions = {},
): Promise<CandidateSearchResult> {
  assertCandidateSearchInput(input)
  const execution = createSearchExecutionContext(options)
  const startedAt = execution.nowMs()
  const selection = selectedTarget(input)
  if (selection.target === null) {
    // A Target that cannot be searched is reported as a notice with an empty
    // result, exactly like a skipped Route: the request itself is well formed,
    // and the UI renders the reason rather than failing the whole search.
    return {
      searchRunId: input.searchRunId,
      calculationContext: { ...input.calculationContext },
      targetResult: {
        targetWeaponId: input.targetWeaponId,
        candidate: null,
        searchedRoutes: [],
        skippedRoutes: [],
        excludedSourceOwnedWeaponIds: [],
      },
      warnings: selection.warnings,
      elapsedMs: Math.max(0, execution.nowMs() - startedAt),
    }
  }
  const target = selection.target
  await execution.checkpoint()
  execution.beginTarget({ targetWeaponId: target.id })
  const searched = await searchTarget(target, input, engine, execution)
  execution.completeTarget()

  return {
    searchRunId: input.searchRunId,
    calculationContext: { ...input.calculationContext },
    targetResult: searched.result,
    warnings: searched.warnings,
    elapsedMs: Math.max(0, execution.nowMs() - startedAt),
  }
}
