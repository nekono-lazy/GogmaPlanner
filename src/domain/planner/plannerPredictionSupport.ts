import { stableStringify } from '../models/publicTypes'
import type {
  RngEngine,
  RngPredictionSupport,
  RngPredictionSupportInput,
} from '../rng/rngEngine'

export type PlannerPredictionSupportCache = Map<string, RngPredictionSupport>

/**
 * Cache only exact semantic support inputs. Ordered Keep slots and the complete
 * caller-supplied Reset Master remain part of the key.
 */
export function getPlannerPredictionSupport(
  engine: RngEngine,
  input: RngPredictionSupportInput,
  cache: PlannerPredictionSupportCache,
): RngPredictionSupport {
  const key = stableStringify(input)
  const cached = cache.get(key)
  if (cached) return cached
  const support = engine.getPredictionSupport(input)
  cache.set(key, support)
  return support
}
