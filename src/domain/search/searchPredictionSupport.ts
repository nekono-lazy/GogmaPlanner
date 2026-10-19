import type { RestorationBonusSet, TargetWeapon } from '../models/publicTypes'
import { V1_NORMAL_ARTIAN_RARITY, stableStringify } from '../models/publicTypes'
import type { RngEngine, RngPredictionSupport } from '../rng/rngEngine'
import type { CandidateSearchInput } from './searchTypes'

export interface SearchPredictionSupport {
  normalArtian(): RngPredictionSupport
  skill(): RngPredictionSupport
  gogmaReset(): RngPredictionSupport
  gogmaKeep(currentBonuses: RestorationBonusSet): RngPredictionSupport
}

export function createSearchPredictionSupport(
  engine: RngEngine,
  target: TargetWeapon,
  master: CandidateSearchInput['master'],
): SearchPredictionSupport {
  let normalArtian: RngPredictionSupport | null = null
  let skill: RngPredictionSupport | null = null
  let gogmaReset: RngPredictionSupport | null = null
  const gogmaKeep = new Map<string, RngPredictionSupport>()

  return {
    normalArtian: () => normalArtian ??= engine.getPredictionSupport({
      type: 'normal_artian',
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
      rarity: V1_NORMAL_ARTIAN_RARITY,
    }),
    skill: () => skill ??= engine.getPredictionSupport({
      type: 'skill',
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
    }),
    gogmaReset: () => gogmaReset ??= engine.getPredictionSupport({
      type: 'gogma_reset',
      weaponTypeId: target.weaponTypeId,
      elementId: target.elementId,
      master,
    }),
    gogmaKeep: (currentBonuses) => {
      const key = stableStringify(currentBonuses)
      const cached = gogmaKeep.get(key)
      if (cached) return cached
      const support = engine.getPredictionSupport({
        type: 'gogma_keep',
        weaponTypeId: target.weaponTypeId,
        elementId: target.elementId,
        currentBonuses,
        master,
      })
      gogmaKeep.set(key, support)
      return support
    },
  }
}
