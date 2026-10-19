/**
 * SEARCH_SPEC 5.5.4 Cross rule.
 *
 * The two stream axes are combined by fixing the other stream's anchor:
 *
 * ```text
 * b0 = B(c)[0]      Bonus anchor
 * k0 = K(c)[0]      Skill anchor
 *
 * Candidate(c) = { (B(c)[i], k0) } ∪ { (b0, K(c)[j]) }
 * ```
 *
 * The pair count is `|B(c)| + |K(c)| - 1`, never `|B(c)| × |K(c)|`. Off-axis
 * pairs (`i > 0` and `j > 0`) are not produced here, by a lazily expanded
 * priority queue, or by a fixed diagonal band. When both streams need an
 * alternative at the same time, that is resolved by the Planner-driven
 * constrained re-search (5.6.5), not by widening this rule.
 */
export interface StreamCrossPair<Bonus, Skill> {
  bonus: Bonus
  skill: Skill
}

export function crossStreamSolutions<Bonus, Skill>(
  bonusAxis: readonly Bonus[],
  skillAxis: readonly Skill[],
): StreamCrossPair<Bonus, Skill>[] {
  // An empty axis means this category has no solution on that stream, so the
  // Route base produces no candidate for it.
  if (bonusAxis.length === 0 || skillAxis.length === 0) return []
  const bonusAnchor = bonusAxis[0]
  const skillAnchor = skillAxis[0]
  // The anchor pair is emitted once, so the total is |B| + |K| - 1.
  const pairs: StreamCrossPair<Bonus, Skill>[] = [
    { bonus: bonusAnchor, skill: skillAnchor },
  ]
  for (let index = 1; index < bonusAxis.length; index += 1) {
    pairs.push({ bonus: bonusAxis[index], skill: skillAnchor })
  }
  for (let index = 1; index < skillAxis.length; index += 1) {
    pairs.push({ bonus: bonusAnchor, skill: skillAxis[index] })
  }
  return pairs
}
