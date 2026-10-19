import type {
  CandidateSearchInput,
  CandidateSearchSettings,
} from './searchTypes'
import { CandidateSearchError } from './searchTypes'
import { validateTargetPreferredOwnedWeapons } from '../target'

export interface CandidateSearchValidationIssue {
  path: string
  message: string
}

function positiveIntegerIssue(value: number, path: string) {
  return Number.isInteger(value) && value >= 1
    ? null
    : { path, message: `${path} must be an integer greater than or equal to 1.` }
}

export function validateCandidateSearchSettings(
  settings: CandidateSearchSettings,
): CandidateSearchValidationIssue[] {
  return [
    positiveIntegerIssue(settings.maxNormalAdvance, 'maxNormalAdvance'),
    positiveIntegerIssue(settings.maxGogmaAdvance, 'maxGogmaAdvance'),
    positiveIntegerIssue(settings.maxSkillAdvance, 'maxSkillAdvance'),
  ].filter((issue): issue is CandidateSearchValidationIssue => issue !== null)
}

/**
 * `docs/SEARCH_SPEC.md` 3.3: absent and `[]` are no exclusion; otherwise every
 * element is a non-empty string, unique, and names a weapon of the same input's
 * `ownedWeapons`. The derivation reads the same state as the input, so a
 * violation is a caller inconsistency and is reported, never repaired.
 */
export function validateExcludedSourceOwnedWeaponIds(
  input: CandidateSearchInput,
): CandidateSearchValidationIssue[] {
  const path = 'excludedSourceOwnedWeaponIds'
  const value: unknown = input.excludedSourceOwnedWeaponIds
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return [{ path, message: `${path} must be an array of OwnedWeapon IDs when present.` }]
  }
  const issues: CandidateSearchValidationIssue[] = []
  const ownedWeaponIds = new Set<string>(input.ownedWeapons.map(({ id }) => id))
  const seen = new Set<string>()
  // Every index, holes included: `forEach()` would skip the empty slots of a
  // sparse array and let them through.
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`
    if (!(index in value)) {
      issues.push({ path: itemPath, message: `${itemPath} is an empty slot; it must be a non-empty OwnedWeapon ID string.` })
      continue
    }
    const id: unknown = value[index]
    if (typeof id !== 'string' || id.trim().length === 0) {
      issues.push({ path: itemPath, message: `${itemPath} must be a non-empty OwnedWeapon ID string.` })
      continue
    }
    if (seen.has(id)) {
      issues.push({ path: itemPath, message: `${itemPath} repeats OwnedWeapon '${id}'.` })
      continue
    }
    seen.add(id)
    if (!ownedWeaponIds.has(id)) {
      issues.push({ path: itemPath, message: `${itemPath} names OwnedWeapon '${id}', which is not in ownedWeapons.` })
    }
  }
  return issues
}

export function assertCandidateSearchInput(input: CandidateSearchInput): void {
  const issues = validateCandidateSearchSettings(input.settings)
  if (input.searchRunId.trim().length === 0) {
    issues.push({ path: 'searchRunId', message: 'searchRunId cannot be empty.' })
  }
  if (input.targetWeaponId.trim().length === 0) {
    issues.push({ path: 'targetWeaponId', message: 'targetWeaponId cannot be empty.' })
  }
  issues.push(...validateExcludedSourceOwnedWeaponIds(input))
  // The same collection-level authority the save Service and the Planner use.
  // A preference pointing at a missing, incompatible, protected, or
  // double-claimed weapon fails closed here rather than quietly ordering
  // Candidates by a reference that means nothing (`docs/DATA_MODEL.md` 8.5).
  const preferred = validateTargetPreferredOwnedWeapons(
    input.targetWeapons,
    input.ownedWeapons,
  )
  issues.push(
    ...preferred.issues.map(({ path, message }) => ({ path, message })),
  )
  if (issues.length > 0) {
    throw new CandidateSearchError(
      'invalid_input',
      issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
    )
  }
}
