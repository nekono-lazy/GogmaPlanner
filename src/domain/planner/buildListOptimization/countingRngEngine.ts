/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.6 / 17.13), Stage D (moved from the Global Assignment Research
 * Phase D-0A-2b, Issue #154).
 *
 * A counting wrapper around the Production RNG Engine. It forwards every call unchanged - the version, the capabilities,
 * every argument, every return value and every exception - and only counts the prediction calls per kind and the support
 * queries. It predicts nothing of its own and changes nothing the Engine sees or returns, so a Search or a check run through
 * it gives exactly what the Engine gives. One wrapper per purpose keeps the shape-constrained Search's counts (its runtime
 * budget) apart from the independent Route checks' re-predictions.
 */
import type { RngEngine } from '../../rng/rngEngine'

/** Production RNG Engine calls one counting wrapper saw. */
export interface PredictionCallCounts {
  normalArtian: number
  skill: number
  gogmaReset: number
  gogmaKeep: number
  supportQueries: number
}

export interface CountingRngEngine {
  engine: RngEngine
  /** Live counts (read them after the calls; they only grow). A call is counted before it is forwarded, so a throwing call counts too. */
  counts: Readonly<PredictionCallCounts>
}

export function createCountingRngEngine(engine: RngEngine): CountingRngEngine {
  const counts: PredictionCallCounts = { normalArtian: 0, skill: 0, gogmaReset: 0, gogmaKeep: 0, supportQueries: 0 }
  const counting: RngEngine = {
    get version() { return engine.version },
    get capabilities() { return engine.capabilities },
    getPredictionSupport(input) {
      counts.supportQueries += 1
      return engine.getPredictionSupport(input)
    },
    normalizeSeed: input => engine.normalizeSeed(input),
    predictGogmaBonus(input) {
      if (input.operation.type === 'reset_bonuses') counts.gogmaReset += 1
      else counts.gogmaKeep += 1
      return engine.predictGogmaBonus(input)
    },
    predictSkills(input) {
      counts.skill += 1
      return engine.predictSkills(input)
    },
    predictNormalArtian(input) {
      counts.normalArtian += 1
      return engine.predictNormalArtian(input)
    },
    advanceGogmaCounter: (current, operation) => engine.advanceGogmaCounter(current, operation),
    advanceSkillCounter: (current, operation) => engine.advanceSkillCounter(current, operation),
    advanceNormalCounter: (current, operation) => engine.advanceNormalCounter(current, operation),
  }
  return { engine: counting, counts }
}

/** A snapshot of the counts (plain data). */
export function snapshotPredictionCallCounts(counts: Readonly<PredictionCallCounts>): PredictionCallCounts {
  return { normalArtian: counts.normalArtian, skill: counts.skill, gogmaReset: counts.gogmaReset, gogmaKeep: counts.gogmaKeep, supportQueries: counts.supportQueries }
}
