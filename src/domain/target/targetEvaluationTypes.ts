import type { BonusRankMaster } from '../master/masterTypes'
import type { IdealDifference } from '../models/publicTypes'

export interface TargetEvaluationMasterSubset {
  bonusRanks: BonusRankMaster[]
}

/**
 * How one concrete weapon state rates against one Target.
 *
 * There is no Candidate category here any more: Candidate Search produces at
 * most one canonical Ideal Candidate per Target, and the compromise conditions
 * are what classify a *checkpoint* state on that Candidate's own Route
 * (`docs/SEARCH_SPEC.md` 5.8). `bonusMatch` and `skillMatch` stay exactly as
 * they were, because both the Ideal test and the checkpoint test are built
 * from them.
 */
export interface TargetEvaluationResult {
  bonusMatch: 'ideal' | 'practical' | 'alternative' | null
  skillMatch: 'ideal' | 'practical' | null
  idealDifference: IdealDifference
}
