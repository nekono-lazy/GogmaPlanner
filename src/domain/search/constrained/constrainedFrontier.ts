import type { RestorationBonusScope } from '../../models/publicTypes'
import { stableStringify } from '../../models/publicTypes'
import { compareStableKeys } from '../semanticKeys'
import type {
  EvaluatedBonusSolution,
  EvaluatedSkillSolution,
} from '../streamSolutions'

/**
 * The lazy off-axis Cross frontier of SEARCH_SPEC 5.6.7 (B8-B1b).
 *
 * One `(Route base, stream category predicate)` matrix owns a lattice whose
 * cell `(i, j)` is the pair `(B(c)[i], K(c)[j])`. The initial Search composes
 * only `i = 0` or `j = 0` (5.5.4); constrained enumeration may additionally
 * reach `i > 0 && j > 0`, capped by `maxOffAxisPairEvaluations`.
 *
 * The lattice is never materialized. Cells are discovered by expanding a popped
 * cell into `(i + 1, j)` and `(i, j + 1)` only, so the live frontier stays
 * `O(seeds + popped cells)` rather than `O(|B| x |K|)`, and no array, Set or
 * Map is ever sized by the Cartesian product.
 *
 * A single-seed lazy lattice only reproduces true best-first order if the work
 * priority is coordinate-wise monotone: moving right or down must never produce
 * a strictly better cell than the one it was discovered from. Otherwise a
 * higher-priority cell would still be invisible while a lower-priority one is
 * popped, which a consumer stopping after the first Candidate, or a small
 * off-axis cap, would turn into a wrong selection. A binary heap alone does not
 * give that property; the comparator below is what does, by following the two
 * canonical stream orderings coordinate by coordinate.
 */

/**
 * The Engine-free semantic cost of one cell, used only to order traversal.
 *
 * Every field is derived from the Route base and the two already-solved stream
 * solutions, so a cell can be ranked before it is composed or evaluated. The
 * leading fields mirror the existing Candidate ordering priorities
 * (`compareCandidateSelection`, SEARCH_SPEC 8) so a near off-axis cell can
 * outrank a distant axis cell; the trailing `bonus*` and `skill*` fields
 * reproduce the canonical stream orderings of 5.5.3 and 5.5.2 exactly, which is
 * what keeps the comparator monotone along each lattice axis.
 */
export interface ConstrainedWorkPriority {
  /** Base units plus the two stream operation counts. */
  operationCount: number
  gogmaAdvance: number
  skillAdvance: number
  normalAdvance: number | null
  /** Matched Ideal bonus slots plus matched Ideal skills; higher is better. */
  idealCloseness: number
  /** `compareBonusSolutions()` key 3: summed required material quantity. */
  bonusMaterialQuantity: number
  /** `compareBonusSolutions()` key 4: completed five-slot multiset. */
  bonusKey: string
  /** `compareBonusSolutions()` key 5: amendment operation type sequence. */
  bonusOperationTypeKey: string
  /** `compareBonusSolutions()` key 6: restoration bonus scope. */
  bonusScope: RestorationBonusScope
  /** `compareSkillSolutions()` key 3: the completed Series / Group Skills. */
  skillSemanticKey: string
  /**
   * 0 when this cell's Route base starts from the Target's preferred owned
   * weapon, 1 otherwise; 0 for every base when the Target sets no preference
   * (`docs/SEARCH_SPEC.md` 8.1).
   *
   * A property of the Route base alone, so it is constant across every `(i, j)`
   * of one matrix. That is what keeps it safe here: see the monotonicity note
   * on `compareConstrainedWorkItems()`.
   */
  preferredSourceRank: number
  /**
   * Run-independent stable key over the Route base, the Bonus solution and the
   * Skill solution semantics. Never a push order, ordinal, ID or Clock value.
   * It carries the `baseKey`, so it also separates cells of different bases
   * that tie on every field above.
   */
  semanticKey: string
}

export interface ConstrainedWorkBase {
  baseKey: string
  /** `create_normal_artian` counted as its forge `count`. */
  operationUnits: number
  normalAdvance: number | null
  /** `preferredSourceRank()` over this base's source and the Target preference. */
  preferredSourceRank: number
}

export interface ConstrainedWorkItem {
  /** Deterministic index of the owning Route base matrix. */
  matrixIndex: number
  i: number
  j: number
  /** Frontier node identity: matrix plus local lattice coordinates. */
  nodeKey: string
  /**
   * Identity of the concrete `(Bonus solution, Skill solution)` pair, which is
   * deliberately NOT the node identity: a pair is evaluated once even when
   * several frontier nodes reach it, while every node still expands its own
   * neighbours.
   */
  pairKey: string
  /** `i > 0 && j > 0`: the only cells that consume the off-axis budget. */
  offAxis: boolean
  bonus: EvaluatedBonusSolution
  skill: EvaluatedSkillSolution
  priority: ConstrainedWorkPriority
}

function nullableAscending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return left - right
}

/**
 * The deterministic best-first traversal order.
 *
 * Coordinate-wise monotonicity, which the single-seed lazy lattice depends on:
 *
 * - Along the Bonus axis (`i` fixed skill, `i -> i + 1`) the child is the next
 *   solution in `compareBonusSolutions()` order. Its key 1, `gogmaAdvance`, is
 *   compared here as `operationCount` and `gogmaAdvance`; its key 2,
 *   `matchedIdealBonusCount` descending, is compared as `idealCloseness`
 *   descending, which with the Skill side fixed is exactly that quantity; and
 *   its keys 3 to 6 are compared as `bonusMaterialQuantity`, `bonusKey`,
 *   `bonusOperationTypeKey` and `bonusScope`, in that same order and with the
 *   same numeric-versus-string semantics. So the first field where parent and
 *   child differ always ranks the parent first.
 * - Along the Skill axis (`j -> j + 1`) the child is the next solution in
 *   `compareSkillSolutions()` order. Its key 1, `resetCount`, is compared as
 *   `operationCount` and `skillAdvance`; its key 2, `idealCloseness`
 *   descending, is compared as `idealCloseness` with the Bonus side fixed; and
 *   its key 3 is compared as `skillSemanticKey`. Every `bonus*` field ties.
 * - There is no category rank any more: one Route base owns exactly one matrix
 *   whose two axes hold Ideal solutions only, so every cell is an Ideal cell
 *   and no later index can improve a leading field.
 *
 * - `preferredSourceRank` is a property of the Route base, so every cell of one
 *   matrix carries the same value. Parent and child therefore always tie on it
 *   and the comparison falls through to the next field exactly as it did before
 *   the field existed: it can never make a child outrank its parent, and it
 *   leaves the whole argument above untouched. It only ever separates cells of
 *   different bases, which is precisely its purpose.
 *
 * The last four comparisons only separate frontier nodes that denote the same
 * actual pair in different matrices, so they never reorder delivered
 * Candidates. Ranking an axis cell before an identical off-axis cell also
 * guarantees that a pair reachable on any axis is evaluated as axis work and
 * never consumes the off-axis budget.
 *
 * `preferredSourceRank` sits after every Candidate quality and cost comparison
 * and immediately before the stable `semanticKey`, mirroring where the ordinary
 * Search comparators place the same preference (`docs/SEARCH_SPEC.md` 8.1). It
 * is a lexicographic step, never a weight, so it can never reverse a cheaper or
 * better Route. This position is what makes the preference reach the streaming
 * `visitConstrainedCandidates()` delivery order the Production Planner consumes,
 * rather than only the final array sort of `enumerateConstrainedCandidates()`.
 *
 * No run-dependent value participates: no random ID, Clock, Candidate ID, Map
 * insertion order, Promise settlement order, or enumeration ordinal. `i`, `j`
 * and `matrixIndex` decide nothing about Candidate delivery priority; they are
 * only the last internal-node tie-break.
 */
export function compareConstrainedWorkItems(
  left: ConstrainedWorkItem,
  right: ConstrainedWorkItem,
): number {
  const a = left.priority
  const b = right.priority
  return (
    a.operationCount - b.operationCount ||
    a.gogmaAdvance - b.gogmaAdvance ||
    a.skillAdvance - b.skillAdvance ||
    nullableAscending(a.normalAdvance, b.normalAdvance) ||
    b.idealCloseness - a.idealCloseness ||
    a.bonusMaterialQuantity - b.bonusMaterialQuantity ||
    compareStableKeys(a.bonusKey, b.bonusKey) ||
    compareStableKeys(a.bonusOperationTypeKey, b.bonusOperationTypeKey) ||
    compareStableKeys(a.bonusScope, b.bonusScope) ||
    compareStableKeys(a.skillSemanticKey, b.skillSemanticKey) ||
    a.preferredSourceRank - b.preferredSourceRank ||
    compareStableKeys(a.semanticKey, b.semanticKey) ||
    Number(left.offAxis) - Number(right.offAxis) ||
    left.i - right.i ||
    left.j - right.j ||
    left.matrixIndex - right.matrixIndex
  )
}

/** Run-independent identity of one actual `(Bonus, Skill)` solution pair. */
export function constrainedPairKey(
  baseKey: string,
  bonus: EvaluatedBonusSolution,
  skill: EvaluatedSkillSolution,
): string {
  // The two indices are positions in the deterministic 5.5.2 / 5.5.3 orderings
  // of this base's full solution arrays, which `selectIdealBonusAxis()` /
  // `selectIdealSkillAxis()` preserve.
  return stableStringify([baseKey, bonus.index, skill.index])
}

/** Run-independent ordering key over the two solutions' semantic content. */
export function constrainedWorkSemanticKey(
  baseKey: string,
  bonus: EvaluatedBonusSolution,
  skill: EvaluatedSkillSolution,
): string {
  return stableStringify([
    baseKey,
    bonus.retentionKey,
    bonus.operationTypeKey,
    bonus.solution.gogmaAdvance,
    bonus.solution.lastResetDepth,
    skill.semanticKey,
    skill.solution.resetCount,
  ])
}

/**
 * The traversal priority of one lattice cell.
 *
 * Numeric quantities stay numbers and are compared as numbers; only genuinely
 * symbolic values become stable keys. Packing the material quantity into a
 * string would reintroduce lexicographic ordering over a numeric field.
 */
export function createConstrainedWorkPriority(
  base: ConstrainedWorkBase,
  bonus: EvaluatedBonusSolution,
  skill: EvaluatedSkillSolution,
): ConstrainedWorkPriority {
  return {
    operationCount:
      base.operationUnits +
      bonus.solution.operations.length +
      skill.solution.operations.length,
    gogmaAdvance: bonus.solution.gogmaAdvance,
    skillAdvance: skill.solution.estimatedSkillAdvance,
    normalAdvance: base.normalAdvance,
    idealCloseness: bonus.matchedIdealBonusCount + skill.idealCloseness,
    bonusMaterialQuantity: bonus.materialQuantity,
    bonusKey: bonus.bonusKey,
    bonusOperationTypeKey: bonus.operationTypeKey,
    bonusScope: bonus.solution.restorationBonusScope,
    skillSemanticKey: skill.semanticKey,
    preferredSourceRank: base.preferredSourceRank,
    semanticKey: constrainedWorkSemanticKey(base.baseKey, bonus, skill),
  }
}

/**
 * A min-heap over `compareConstrainedWorkItems()`.
 *
 * The existing `SearchWorkQueue` is deliberately not reused: it breaks ties on
 * insertion sequence, which SEARCH_SPEC 5.6.7 forbids here, and it enforces a
 * monotone operation lower bound that the two-dimensional lattice does not
 * satisfy.
 */
export class ConstrainedWorkFrontier {
  private readonly heap: ConstrainedWorkItem[] = []

  get size(): number {
    return this.heap.length
  }

  push(item: ConstrainedWorkItem): void {
    this.heap.push(item)
    let index = this.heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareConstrainedWorkItems(item, this.heap[parent]) >= 0) break
      this.heap[index] = this.heap[parent]
      index = parent
    }
    this.heap[index] = item
  }

  pop(): ConstrainedWorkItem | null {
    const first = this.heap[0]
    if (first === undefined) return null
    const last = this.heap.pop() as ConstrainedWorkItem
    if (this.heap.length > 0) {
      let index = 0
      while (2 * index + 1 < this.heap.length) {
        let child = 2 * index + 1
        if (
          child + 1 < this.heap.length &&
          compareConstrainedWorkItems(this.heap[child + 1], this.heap[child]) < 0
        ) {
          child += 1
        }
        if (compareConstrainedWorkItems(this.heap[child], last) >= 0) break
        this.heap[index] = this.heap[child]
        index = child
      }
      this.heap[index] = last
    }
    return first
  }
}
