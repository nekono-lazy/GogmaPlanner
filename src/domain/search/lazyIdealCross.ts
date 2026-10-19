import type { EvaluatedBonusSolution, EvaluatedSkillSolution } from './streamSolutions'

/**
 * How the lazy Cross hands its work to the scheduler. Both enqueue one work
 * item whose lower bound is the operation cost of the given pair; the Cross
 * never settles anything itself and owns no cancellation or Worker yield: every
 * item settles behind the scheduler's `SearchExecutionContext.checkpoint()`.
 */
export interface LazyIdealCrossWork {
  /** Queues the cell `(bonus, skill)`; `onSettled` runs after it settled. */
  open(
    bonus: EvaluatedBonusSolution,
    skill: EvaluatedSkillSolution,
    onSettled: () => void,
  ): void
  /**
   * Queues one wake-up step of a waiting row: `resume` runs when it settles and
   * opens that row's cell `(bonus, skill)`. Its lower bound is the cost of that
   * cell, the cheapest cell the remaining wake-up can still open.
   */
  wake(
    bonus: EvaluatedBonusSolution,
    skill: EvaluatedSkillSolution,
    resume: () => void,
  ): void
}

/** A min-heap of row indices. Rows arrive in non-decreasing Gogma advance. */
class RowHeap {
  private readonly rows: number[] = []

  get size(): number { return this.rows.length }
  peek(): number { return this.rows[0] }

  push(row: number): void {
    const rows = this.rows
    let index = rows.push(row) - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (rows[parent] <= row) break
      rows[index] = rows[parent]
      index = parent
    }
    rows[index] = row
  }

  pop(): number {
    const rows = this.rows
    const first = rows[0]
    const last = rows.pop()!
    if (rows.length > 0) {
      let index = 0
      for (;;) {
        let child = 2 * index + 1
        if (child >= rows.length) break
        if (child + 1 < rows.length && rows[child + 1] < rows[child]) child += 1
        if (rows[child] >= last) break
        rows[index] = rows[child]
        index = child
      }
      rows[index] = last
    }
    return first
  }
}

/**
 * Planner Alternative Search composition of one Route base
 * (`docs/SEARCH_SPEC.md` 5.6.8): every Ideal Bonus solution paired with every
 * Ideal Skill solution, off-axis cells (`i > 0` and `j > 0`) included, but
 * never as a precomputed Cartesian product.
 *
 * Each Ideal Bonus solution is a row that walks the Ideal Skill solutions in
 * arrival order. A row holds at most one opened cell at a time: the next cell
 * of a row opens only when the previous one settled (`onSettled`), or, when the
 * Skill it waits for has not arrived yet, once that Skill arrives. So the
 * pending cells are at most one per row, a consumer stop leaves the rest of the
 * grid ungenerated, and each cell is opened exactly once.
 *
 * Rows waiting for a Skill are not resumed in one synchronous pass when it
 * arrives. They form one wake-up batch for that column, resumed one row per
 * queued wake-up step in row order (a row index order is a non-decreasing Gogma
 * advance order, so the next wake-up's cell is never cheaper than the last).
 * Each step settles behind the scheduler checkpoint, so cancellation and
 * Worker yield are observed between any two resumed rows, and a consumer stop
 * leaves the rest of the batch unresumed.
 *
 * The lower bound stays monotone. Both axes arrive in non-decreasing advance
 * order (one complete stream depth at a time), so the cost of a row's next
 * cell is never below the cell that just settled, nor below the stream depth
 * work that delivered the new solution; a wake-up step's lower bound is the
 * cost of the cell it opens, the cheapest cell left in its batch.
 *
 * Unlike the initial Search's `createDeltaCross()`, a solution is never folded
 * into an earlier one with the same completed result: a later Counter position
 * reaching the same Bonus or Skill outcome is its own row or column, because
 * the Planner matches `RouteOperation.counterBefore` (SEARCH_SPEC 5.6.4). No
 * pair evaluation predicts anything.
 */
export function createLazyIdealCross(work: LazyIdealCrossWork) {
  const bonuses: EvaluatedBonusSolution[] = []
  const skills: EvaluatedSkillSolution[] = []
  /** The next Skill column of each row. */
  const nextColumn: number[] = []
  /** Rows waiting for column `skills.length`, which has not arrived yet. */
  let waiting = new RowHeap()

  function openNext(row: number): void {
    const column = nextColumn[row]
    if (column >= skills.length) {
      waiting.push(row)
      return
    }
    nextColumn[row] = column + 1
    work.open(bonuses[row], skills[column], () => openNext(row))
  }

  /** Queues the wake-up of the cheapest row still waiting in `batch`. */
  function wakeNext(batch: RowHeap, column: number): void {
    work.wake(bonuses[batch.peek()], skills[column], () => {
      openNext(batch.pop())
      if (batch.size > 0) wakeNext(batch, column)
    })
  }

  return {
    addBonus(bonus: EvaluatedBonusSolution): void {
      if (!bonus.idealMatch) return
      bonuses.push(bonus)
      nextColumn.push(0)
      openNext(bonuses.length - 1)
    },
    addSkill(skill: EvaluatedSkillSolution): void {
      if (!skill.idealMatch) return
      skills.push(skill)
      if (waiting.size === 0) return
      // Every waiting row waits for exactly this column; later waiters wait
      // for the next one and start a new batch.
      const batch = waiting
      waiting = new RowHeap()
      wakeNext(batch, skills.length - 1)
    },
  }
}
