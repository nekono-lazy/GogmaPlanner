import type { CandidateSearchDefaults } from '../../domain/models/publicTypes'

/**
 * The three Candidate Search bounds as the user sees them, shared by the
 * Search screen's 「詳細設定（探索量の上限）」 and the Settings screen's saved
 * defaults so both name them the same way (`docs/UI_FLOW.md` 9 / 14). The
 * user-facing wording is 「復元ボーナス」 for the Gogma bound; the internal
 * `maxGogmaAdvance` name is unchanged.
 */
export const candidateSearchLimitFields: readonly {
  key: keyof CandidateSearchDefaults
  label: string
  helperText: string
}[] = [
  {
    key: 'maxNormalAdvance',
    label: '通常アーティア最大進行量',
    helperText: '通常アーティアを作成する最大本数（1以上）',
  },
  {
    key: 'maxGogmaAdvance',
    label: '復元ボーナス最大進行量',
    helperText: '復元ボーナスの再抽選を進める最大回数',
  },
  {
    key: 'maxSkillAdvance',
    label: 'スキル最大進行量',
    helperText: 'スキルリセットを進める最大回数',
  },
]

/** The text a bound input is edited as, one string per field. */
export type CandidateSearchLimitDraft = Record<keyof CandidateSearchDefaults, string>

export function candidateSearchLimitDraft(defaults: CandidateSearchDefaults): CandidateSearchLimitDraft {
  return {
    maxNormalAdvance: String(defaults.maxNormalAdvance),
    maxGogmaAdvance: String(defaults.maxGogmaAdvance),
    maxSkillAdvance: String(defaults.maxSkillAdvance),
  }
}

/**
 * One bound typed by the user, or `null` when it is not a positive integer
 * (`docs/DATA_MODEL.md` 13). An empty field, `0`, a negative number, a
 * fraction and an exponent are all refused rather than coerced; no upper cap
 * and no ordering between the three bounds is checked.
 */
export function parseCandidateSearchLimit(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

/** The whole draft as saved defaults, or `null` while any field is invalid. */
export function parseCandidateSearchLimitDraft(draft: CandidateSearchLimitDraft): CandidateSearchDefaults | null {
  const maxNormalAdvance = parseCandidateSearchLimit(draft.maxNormalAdvance)
  const maxGogmaAdvance = parseCandidateSearchLimit(draft.maxGogmaAdvance)
  const maxSkillAdvance = parseCandidateSearchLimit(draft.maxSkillAdvance)
  if (maxNormalAdvance === null || maxGogmaAdvance === null || maxSkillAdvance === null) return null
  return { maxNormalAdvance, maxGogmaAdvance, maxSkillAdvance }
}

export function sameCandidateSearchDefaults(left: CandidateSearchDefaults, right: CandidateSearchDefaults): boolean {
  return left.maxNormalAdvance === right.maxNormalAdvance
    && left.maxGogmaAdvance === right.maxGogmaAdvance
    && left.maxSkillAdvance === right.maxSkillAdvance
}

export const CANDIDATE_SEARCH_LIMIT_INVALID_MESSAGE = '1以上の整数を入力してください'
