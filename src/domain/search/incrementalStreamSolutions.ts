import type { TargetWeapon } from '../models/publicTypes'
import type { CandidateSearchInput } from './searchTypes'
import {
  buildBonusSolutionSet, buildSkillSolutionSet,
  type EvaluatedBonusSolution, type EvaluatedSkillSolution,
  type RouteBonusSolution, type RouteSkillSolution,
} from './streamSolutions'

/**
 * Append one complete depth, never a cumulative prefix. Since advance is the
 * primary ordering key, later depths cannot replace a retained result.
 * B3 ordering within the new depth settles every tie before publication.
 * These sets are initial-Search retention only, never permanent dominance.
 */
export function createIncrementalSkillRetention(target: TargetWeapon) {
  const seen = new Set<string>()
  let previousDepth = -1
  return {
    appendDepth(solutions: readonly RouteSkillSolution[]): EvaluatedSkillSolution[] {
      if (solutions.length === 0) return []
      const depth = solutions[0].resetCount
      if (depth <= previousDepth || solutions.some((s) => s.resetCount !== depth)) {
        throw new Error('Skill retention requires a new complete depth.')
      }
      previousDepth = depth
      return buildSkillSolutionSet(target, solutions).filter((entry) => {
        if (seen.has(entry.semanticKey)) return false
        seen.add(entry.semanticKey)
        return true
      })
    },
  }
}

export function createIncrementalBonusRetention(target: TargetWeapon, input: Pick<CandidateSearchInput, 'master'>) {
  const seen = new Set<string>()
  let previousDepth = -1
  return {
    appendDepth(solutions: readonly RouteBonusSolution[]): EvaluatedBonusSolution[] {
      if (solutions.length === 0) return []
      const depth = solutions[0].gogmaAdvance
      if (depth <= previousDepth || solutions.some((s) => s.gogmaAdvance !== depth)) {
        throw new Error('Bonus retention requires a new complete depth.')
      }
      previousDepth = depth
      return buildBonusSolutionSet(target, input, solutions).filter((entry) => {
        if (seen.has(entry.retentionKey)) return false
        seen.add(entry.retentionKey)
        return true
      })
    },
  }
}
