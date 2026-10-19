import type {
  NormalArtianCounter,
  RngCapabilities,
  RngState,
  RouteOperation,
} from '../models/publicTypes'
import {
  V1_NORMAL_ARTIAN_RARITY,
  isBlindCreateNormalArtianOperation,
} from '../models/publicTypes'
import type { RngEngineCapabilities } from './rngEngine'

export type RngCapabilityMissingRequirement =
  | 'base_seed'
  | 'gogma_counter'
  | 'skill_counter'
  | `normal_artian_counter:${string}`
  | 'engine:gogma_prediction'
  | 'engine:skill_prediction'
  | 'engine:normal_artian_prediction'
  | 'engine:keep_prediction'

function isKnown<T>(knownValue: {
  value: T | null
  isConfirmed: boolean
}): boolean {
  return knownValue.isConfirmed && knownValue.value !== null
}

function normalCounterId(
  operation: Extract<RouteOperation, { type: 'create_normal_artian' }>,
): string {
  return `${operation.weaponTypeId}:${V1_NORMAL_ARTIAN_RARITY}`
}

function compareRequirement(
  left: RngCapabilityMissingRequirement,
  right: RngCapabilityMissingRequirement,
): number {
  const order: Record<Exclude<RngCapabilityMissingRequirement, `normal_artian_counter:${string}`>, number> = {
    base_seed: 0,
    gogma_counter: 1,
    skill_counter: 2,
    'engine:gogma_prediction': 5,
    'engine:skill_prediction': 6,
    'engine:normal_artian_prediction': 7,
    'engine:keep_prediction': 8,
  }
  const leftOrder = left.startsWith('normal_artian_counter:') ? 4 : order[left as keyof typeof order]
  const rightOrder = right.startsWith('normal_artian_counter:') ? 4 : order[right as keyof typeof order]
  return leftOrder - rightOrder || left.localeCompare(right)
}

export function deriveRngCapabilities(
  rngState: RngState,
  normalCounters: readonly NormalArtianCounter[],
  requiredOperations: readonly RouteOperation[],
  engineCapabilities: RngEngineCapabilities,
): RngCapabilities {
  const hasBaseSeed = isKnown(rngState.baseSeed)
  const hasGogmaCounter = isKnown(rngState.gogmaCounter)
  const hasSkillCounter = isKnown(rngState.skillCounter)

  const canPredictGogma =
    hasBaseSeed &&
    hasGogmaCounter &&
    engineCapabilities.supportsGogmaPrediction
  const canPredictSkills =
    hasBaseSeed &&
    hasSkillCounter &&
    engineCapabilities.supportsSkillPrediction

  const confirmedNormalCounterIds = new Set(
    normalCounters
      .filter(
        (counter) =>
          counter.rarity === V1_NORMAL_ARTIAN_RARITY &&
          counter.isConfirmed &&
          counter.counter !== null,
      )
      .map(({ id }) => id),
  )
  const normalArtianSearchableCounterIds =
    hasBaseSeed && engineCapabilities.supportsNormalArtianPrediction
      ? [...confirmedNormalCounterIds].sort((left, right) =>
          left.localeCompare(right),
        )
      : []

  const missingRequirements = new Set<RngCapabilityMissingRequirement>()
  const requireBaseSeed = () => {
    if (!hasBaseSeed) missingRequirements.add('base_seed')
  }
  const requireGogmaPrediction = () => {
    requireBaseSeed()
    if (!hasGogmaCounter) missingRequirements.add('gogma_counter')
    if (!engineCapabilities.supportsGogmaPrediction) {
      missingRequirements.add('engine:gogma_prediction')
    }
  }
  const requireSkillPrediction = () => {
    requireBaseSeed()
    if (!hasSkillCounter) missingRequirements.add('skill_counter')
    if (!engineCapabilities.supportsSkillPrediction) {
      missingRequirements.add('engine:skill_prediction')
    }
  }
  const requireNormalArtianPrediction = (
    operation: Extract<RouteOperation, { type: 'create_normal_artian' }>,
  ) => {
    // A blind Normal creation predicts nothing and reads no Counter, so it adds
    // no RNG requirement of its own (`docs/SEARCH_SPEC.md` 6.1.1). The Route's
    // conversion and Reset Bonuses still require their own inputs.
    if (isBlindCreateNormalArtianOperation(operation)) return
    requireBaseSeed()
    const counterId = normalCounterId(operation)
    if (!confirmedNormalCounterIds.has(counterId)) {
      missingRequirements.add(`normal_artian_counter:${counterId}`)
    }
    if (!engineCapabilities.supportsNormalArtianPrediction) {
      missingRequirements.add('engine:normal_artian_prediction')
    }
  }

  requiredOperations.forEach((operation) => {
    switch (operation.type) {
      case 'create_normal_artian':
        requireNormalArtianPrediction(operation)
        break
      case 'convert_normal_to_gogma':
      case 'reset_skills':
        requireSkillPrediction()
        break
      case 'reset_bonuses':
        requireGogmaPrediction()
        break
      case 'keep_bonuses':
        requireGogmaPrediction()
        if (!engineCapabilities.supportsKeepBonusesPrediction) {
          missingRequirements.add('engine:keep_prediction')
        }
        break
    }
  })

  return {
    canPredictGogma,
    canPredictSkills,
    canSearchNormalArtian: normalArtianSearchableCounterIds.length > 0,
    normalArtianSearchableCounterIds,
    canRunPlanner: missingRequirements.size === 0,
    missingRequirements: [...missingRequirements].sort(compareRequirement),
  }
}
