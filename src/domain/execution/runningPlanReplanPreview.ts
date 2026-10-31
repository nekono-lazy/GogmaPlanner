import {
  applyBuildListEntryReplacements,
  resolveBuildListEntryReplacement,
  validateBuildListEntryAdditions,
  validateBuildListEntryReplacements,
} from '../buildList/buildListEntryReplacement'
import type { BuildListEntry, OwnedWeaponId, ProductionPlan, TargetWeapon, TargetWeaponId } from '../models/publicTypes'
import { inspectProductionPlanStartTargetLinks } from './productionPlanStart'
import {
  runningPlanReplanEntryChangeIssues,
  type RunningPlanReplanOptimizationArtifact,
} from './runningPlanReplanOptimization'

/**
 * The read-only Preview derivations of a running Plan replan re-optimization (`docs/PLANNER_SPEC.md` 18.7, Issue #276 PR-4).
 *
 * Pure: every input is passed in, nothing is written, predicted or planned. In particular no TargetWeapon's `preferredOwnedWeaponId`
 * is changed here: the Preview only says what the new Plan's start would change. The write authority stays the adoption's own
 * `prepareProductionPlanStart()` (18.8), which re-derives the changes from the then-current Targets through the same 16.11 functions.
 */

/**
 * One preference change starting the new Plan would make (16.11), as the Preview shows it and as the adoption re-checks it (18.8): the
 * semantic content only - the destination Target, the weapon it is linked to, the Target that preferred that weapon until now (or
 * none) and the weapon the destination Target preferred until now (or none). No name, timestamp, display order or Entry ID is part
 * of it.
 */
export interface RunningPlanReplanStartTargetLinkChange {
  targetWeaponId: TargetWeaponId
  ownedWeaponId: OwnedWeaponId
  fromTargetWeaponId: TargetWeaponId | null
  replacedOwnedWeaponId: OwnedWeaponId | null
}

/** The artifact fields the Build List after the adoption is derived from (a whole artifact is one). */
export interface RunningPlanReplanEntryChangeArtifact extends Pick<RunningPlanReplanOptimizationArtifact,
  'replanTargetWeaponIds' | 'generatedBuildListEntries' | 'replacements' | 'additions' | 'unchangedTargetWeaponIds'> {
  plannerResult: { plan: Pick<ProductionPlan, 'selectedBuildListEntryIds'> | null }
}

export type RunningPlanReplanBuildListAfterAdoption =
  /** The whole Build List the adoption would leave: every replaced `O` removed, every generated `G` held once, every other Entry kept. */
  | { kind: 'ready'; buildListEntries: BuildListEntry[] }
  /** The artifact's Entry changes do not fit the current Build List; nothing is assembled and nothing is guessed. */
  | { kind: 'invalid'; issues: string[] }

/** An artifact whose Entry changes do not fit the Build List they are applied to (fail closed: never a skipped or overwritten Entry). */
export class RunningPlanReplanEntryChangeError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`The replan's Entry changes do not fit the current Build List: ${issues.join(' ')}`)
    this.name = 'RunningPlanReplanEntryChangeError'
    this.issues = [...issues]
  }
}

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function repeated(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort(compareIds)
}

/**
 * The Build List the adoption would leave (18.8 [W]), checked against the **whole** current Build List before it is assembled.
 *
 * The calculation applies the replacement authority to the replan Targets' Entries only (its Stage 0R scope, 18.6), so it cannot see an
 * Entry outside the scope. Here the same authorities are applied to every current Entry, and a mismatch is an issue - a generated Entry
 * is never silently skipped and no Entry outside the replacements is ever removed or overwritten:
 *
 * - the generated Entries carry distinct IDs;
 * - `resolveBuildListEntryReplacement()` over the whole Build List: a generated Entry's ID held by any current Entry - of another Target,
 *   or the replaced `O` itself - is `generated_entry_id_in_use` (an unchanged Entry is a reuse, never a `G`, 17.12); a replacement names
 *   its Target's one current Entry, and an addition's Target holds none (`replaced_entry_missing`);
 * - PR-3's `runningPlanReplanEntryChangeIssues()` over the replan Targets' Entries: each replan Target replaced, added or unchanged once,
 *   and the new Plan selecting exactly the final Entries;
 * - on the assembled collection, `validateBuildListEntryReplacements(..., 'replaced')` and `validateBuildListEntryAdditions()` (the
 *   checks Stage D' applies to its own final input): each replaced or added Target holds exactly its `G`, and no other Target holds it.
 *
 * Only the Entries the adoption changes are judged: a stale Entry outside the scope, or a legacy duplicate of a Target outside it, never
 * refuses anything unless one of its IDs collides with a generated Entry. The Worker result check and the Preview derivation both read
 * this one function; the adoption (PR-5) can read it over the then-current Build List.
 */
export function deriveRunningPlanReplanBuildListAfterAdoption(
  buildListEntries: readonly BuildListEntry[],
  artifact: RunningPlanReplanEntryChangeArtifact,
): RunningPlanReplanBuildListAfterAdoption {
  const issues: string[] = []
  const plan = artifact.plannerResult.plan
  if (plan === null) issues.push('The artifact holds no new Plan.')
  const generated = artifact.generatedBuildListEntries
  for (const id of repeated(generated.map(({ id }) => id))) issues.push(`Generated BuildListEntry ID '${id}' is carried by more than one generated Entry.`)

  // The replacement authority over every current Entry, not the scope only.
  const replacedBy = new Map(artifact.replacements.map(value => [value.generatedBuildListEntryId as string, value]))
  const addedIds = new Set<string>(artifact.additions.map(({ generatedBuildListEntryId }) => generatedBuildListEntryId))
  for (const entry of generated) {
    const resolution = resolveBuildListEntryReplacement(buildListEntries, entry)
    const replacement = replacedBy.get(entry.id)
    if (resolution.status === 'invalid' && resolution.reason === 'generated_entry_id_in_use') {
      issues.push(`generated_entry_id_in_use: ${resolution.detail}`)
    } else if (replacement !== undefined) {
      if (resolution.status !== 'ready' || resolution.replacement.replacedBuildListEntryId !== replacement.replacedBuildListEntryId) {
        issues.push(`Generated BuildListEntry '${entry.id}' does not replace Target ${entry.targetWeaponId}'s one current Entry '${replacement.replacedBuildListEntryId}'${resolution.status === 'invalid' ? ` (${resolution.reason})` : ''}.`)
      }
    } else if (addedIds.has(entry.id) && !(resolution.status === 'invalid' && resolution.reason === 'replaced_entry_missing')) {
      issues.push(`Generated BuildListEntry '${entry.id}' is added for Target ${entry.targetWeaponId}, which holds a current Entry.`)
    }
  }

  // Each replan Target replaced, added or unchanged once against its own current Entries (PR-3).
  const replanIds = new Set<string>(artifact.replanTargetWeaponIds)
  const scope = buildListEntries.filter(entry => replanIds.has(entry.targetWeaponId))
  issues.push(...runningPlanReplanEntryChangeIssues(scope, artifact.replanTargetWeaponIds, artifact, plan?.selectedBuildListEntryIds ?? []))

  // The assembled collection: each changed Target holds exactly its generated Entry, and no other Target holds it.
  const after = applyBuildListEntryReplacements(buildListEntries, artifact.replacements, generated)
  issues.push(...validateBuildListEntryReplacements(after, artifact.replacements, 'replaced').issues.map(({ message }) => message))
  issues.push(...validateBuildListEntryAdditions(after, artifact.additions, artifact.replacements).issues.map(({ message }) => message))

  const unique = [...new Set(issues)]
  return unique.length > 0 ? { kind: 'invalid', issues: unique } : { kind: 'ready', buildListEntries: after }
}

/**
 * The preference changes starting the artifact's new Plan would make against `targetWeapons` (18.7 「採用で変わる優先起点の紐付け」),
 * through the 16.11 authority the Production Plan screen's pre-start preview reads (`inspectProductionPlanStartTargetLinks()`:
 * `deriveProductionPlanStartTargetLinks()` over the new Plan's selected Entries in the Build List after the replacements and additions,
 * then `inspectProductionPlanStartTargetLinkChanges()` against the Targets). A Target released from a weapon may be an excluded Target
 * or one outside the replan target set: the start effect, not the exclusion, releases it (18.2).
 *
 * `buildListEntries` is the whole Build List the Entry changes are applied to: the Build List after them comes only from
 * `deriveRunningPlanReplanBuildListAfterAdoption()`, and an artifact whose changes do not fit it throws
 * `RunningPlanReplanEntryChangeError` (no change set is derived from a mis-assembled Build List).
 *
 * The Preview passes the Targets and Build List read when the calculation started; the adoption (PR-5) passes the latest persisted
 * ones and compares the two results by value. The result is canonical for that comparison: the semantic fields only, sorted by
 * destination Target, then weapon. Empty when the start changes no preference.
 */
export function deriveRunningPlanReplanStartTargetLinkChanges(
  targetWeapons: readonly TargetWeapon[],
  buildListEntries: readonly BuildListEntry[],
  artifact: RunningPlanReplanEntryChangeArtifact,
): RunningPlanReplanStartTargetLinkChange[] {
  const after = deriveRunningPlanReplanBuildListAfterAdoption(buildListEntries, artifact)
  if (after.kind === 'invalid') throw new RunningPlanReplanEntryChangeError(after.issues)
  return inspectProductionPlanStartTargetLinks(artifact.plannerResult.plan!, { targetWeapons, buildListEntries: after.buildListEntries })
    .map(({ targetWeaponId, ownedWeaponId, fromTargetWeaponId, replacedOwnedWeaponId }) => ({ targetWeaponId, ownedWeaponId, fromTargetWeaponId, replacedOwnedWeaponId }))
    .sort((left, right) => compareIds(left.targetWeaponId, right.targetWeaponId) || compareIds(left.ownedWeaponId, right.ownedWeaponId))
}
