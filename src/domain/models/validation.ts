import type {
  AppSettings,
  BuildListEntryId,
  CalculationContext,
  CandidateSearchDefaults,
  KnownValue,
  NormalArtianCounter,
  PlanStepOperationType,
  RestorationBonus,
  RngState,
} from './common'
import {
  APP_SETTINGS_SCHEMA_VERSION,
  currentExecutionActions,
  legacyExecutionActions,
  productionPlanAbandonmentReasons,
  RNG_STATE_SCHEMA_VERSION,
  V1_NORMAL_ARTIAN_RARITY,
} from './common'
import { stableStringify } from './hashing'
import { improvementPreferences, targetWeaponLifecycleStatuses } from './entities'
import type {
  BuildCandidate,
  BuildListEntry,
  BuildRoute,
  IntermediateStateOpportunity,
  MaterialRequirement,
  OwnedWeapon,
  RouteOperation,
  TargetWeapon,
} from './entities'
import { completionConditionReviewReasons } from './common'
import { findCompletionSkillVariantConflicts } from './completionSkillVariantIdentity'
import type {
  LegacyAlternativeBonusRule,
  LegacyPracticalBonusCondition,
  LegacySkillCondition,
  LegacyTargetWeapon,
} from './legacyTargetWeapon'
import { hasCompletionConditionTargetField, hasLegacyTargetWeaponField } from './legacyTargetWeapon'
import { isBlindCreateNormalArtianOperation } from './entities'
import type {
  ActualResult,
  ExecutionHistory,
  ExecutionSavePoint,
  ExecutionUndoSnapshot,
  ExpectedPlanState,
  PlanStep,
  PlanStepExecutionEffects,
  PlannerConflictRepairLineage,
  ProductionPlan,
} from './planning'
import {
  executionSavePointIdForPlan,
  rejectedBuildListEntryResourceConflictCauses,
} from './planning'
import type { ProductionPlanUndoState } from './productionPlanUndoState'
import {
  areRestorationBonusSetsEqual,
  areRestorationBonusSlotsEqual,
  canKeepBonuses,
  canResetBonuses,
  canResetSkills,
  isCalculationContextCompatible,
} from './domainRules'

export type DomainValidationIssueCode =
  | 'invalid_id'
  | 'invalid_literal'
  | 'invalid_integer'
  | 'invalid_range'
  | 'invalid_structure'
  | 'invalid_reference'
  | 'invalid_route_operation'
  | 'protected_destructive_use'
  | 'inconsistent_snapshot'
  | 'invalid_state'

export interface DomainValidationIssue {
  path: string
  code: DomainValidationIssueCode
  message: string
}

export interface DomainValidationResult {
  isValid: boolean
  issues: DomainValidationIssue[]
}

function result(issues: DomainValidationIssue[]): DomainValidationResult {
  return { isValid: issues.length === 0, issues }
}

function addIssue(
  issues: DomainValidationIssue[],
  path: string,
  code: DomainValidationIssueCode,
  message: string,
) {
  issues.push({ path, code, message })
}

function appendIssues(
  issues: DomainValidationIssue[],
  prefix: string,
  nested: DomainValidationResult,
) {
  nested.issues.forEach((issue) =>
    issues.push({
      ...issue,
      path: issue.path
        ? `${prefix}${issue.path.startsWith('[') ? '' : '.'}${issue.path}`
        : prefix,
    }),
  )
}

function validateId(
  value: string | undefined,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addIssue(issues, path, 'invalid_id', 'ID must be a non-empty string.')
  }
}

function validateNonNegativeInteger(
  value: number,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (!Number.isInteger(value) || value < 0) {
    addIssue(
      issues,
      path,
      'invalid_integer',
      'Value must be a non-negative integer.',
    )
  }
}

function validatePositiveInteger(
  value: number,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (!Number.isInteger(value) || value < 1) {
    addIssue(
      issues,
      path,
      'invalid_integer',
      'Value must be a positive integer.',
    )
  }
}

export function validateCalculationContext(
  context: CalculationContext,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (!context.gameVersion.trim()) {
    addIssue(issues, `${path}.gameVersion`, 'invalid_structure', 'gameVersion is required.')
  }
  if (!context.rngEngineVersion.trim()) {
    addIssue(
      issues,
      `${path}.rngEngineVersion`,
      'invalid_structure',
      'rngEngineVersion is required.',
    )
  }
  validatePositiveInteger(
    context.masterDataVersion,
    `${path}.masterDataVersion`,
    issues,
  )
  validatePositiveInteger(
    context.appSchemaVersion,
    `${path}.appSchemaVersion`,
    issues,
  )
}

export function validateKnownValue<T>(
  known: KnownValue<T>,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!isPlainObject(known)) {
    addIssue(issues, '', 'invalid_structure', 'KnownValue must be an object.')
    return result(issues)
  }
  if (
    known.source !== null &&
    !['manual', 'observation'].includes(known.source)
  ) {
    addIssue(issues, 'source', 'invalid_literal', 'KnownValue source is invalid.')
  }
  if (known.isConfirmed && known.value === null) {
    addIssue(
      issues,
      'value',
      'invalid_state',
      'A confirmed KnownValue must have a value.',
    )
  }
  if (known.value === null && known.isConfirmed) {
    addIssue(
      issues,
      'isConfirmed',
      'invalid_state',
      'A null KnownValue cannot be confirmed.',
    )
  }
  return result(issues)
}

function validateCounterKnownValue(
  known: KnownValue<number>,
  path: string,
  issues: DomainValidationIssue[],
) {
  appendIssues(issues, path, validateKnownValue(known))
  if (isPlainObject(known) && known.value !== null) {
    validateNonNegativeInteger(known.value, `${path}.value`, issues)
  }
}

export function validateRngState(state: RngState): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (state.id !== 'current') {
    addIssue(issues, 'id', 'invalid_literal', "RngState id must be 'current'.")
  }
  if (state.schemaVersion !== RNG_STATE_SCHEMA_VERSION) {
    addIssue(
      issues,
      'schemaVersion',
      'invalid_literal',
      `RngState schemaVersion must be ${RNG_STATE_SCHEMA_VERSION}.`,
    )
  }
  appendIssues(issues, 'baseSeed', validateKnownValue(state.baseSeed))
  validateCounterKnownValue(state.gogmaCounter, 'gogmaCounter', issues)
  validateCounterKnownValue(state.skillCounter, 'skillCounter', issues)
  validateCounterKnownValue(state.counterGate, 'counterGate', issues)
  validateIdentificationProvenance(state.lastIdentifiedAt, issues)
  return result(issues)
}

/** `lastIdentifiedAt` is `null` or an ISO date-time string; a missing field is a pre-provenance record. */
function validateIdentificationProvenance(value: unknown, issues: DomainValidationIssue[]) {
  if (value !== null && !isNonEmptyString(value)) {
    addIssue(issues, 'lastIdentifiedAt', 'invalid_structure', 'lastIdentifiedAt must be null or an ISO date-time string.')
  }
}

export function validateNormalArtianCounter(
  counter: NormalArtianCounter,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  validateId(counter.weaponTypeId, 'weaponTypeId', issues)
  if (counter.rarity !== V1_NORMAL_ARTIAN_RARITY) {
    addIssue(issues, 'rarity', 'invalid_literal', 'v1 supports only rarity 8 Normal Artian counters.')
  }
  const expectedId = `${counter.weaponTypeId}:${counter.rarity}`
  if (counter.id !== expectedId) {
    addIssue(
      issues,
      'id',
      'invalid_literal',
      `NormalArtianCounter id must be '${expectedId}'.`,
    )
  }
  if (counter.counter !== null) {
    validateNonNegativeInteger(counter.counter, 'counter', issues)
  }
  if (counter.isConfirmed && counter.counter === null) {
    addIssue(
      issues,
      'counter',
      'invalid_state',
      'A confirmed NormalArtianCounter requires a counter value.',
    )
  }
  validateNonNegativeInteger(counter.observationCount, 'observationCount', issues)
  if (counter.candidateCount !== null) {
    validateNonNegativeInteger(counter.candidateCount, 'candidateCount', issues)
  }
  validateIdentificationProvenance(counter.lastIdentifiedAt, issues)
  return result(issues)
}

function validateRestorationBonus(
  bonus: RestorationBonus,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (!bonus || typeof bonus !== 'object') {
    addIssue(issues, path, 'invalid_structure', 'Restoration bonus is required.')
    return
  }
  validateId(bonus.bonusTypeId, `${path}.bonusTypeId`, issues)
  validateId(bonus.bonusRankId, `${path}.bonusRankId`, issues)
}

export function validateRestorationBonusSet(
  bonuses: readonly RestorationBonus[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!Array.isArray(bonuses) || bonuses.length !== 5) {
    addIssue(
      issues,
      '',
      'invalid_structure',
      'RestorationBonusSet must contain exactly five entries.',
    )
  }
  // A value that is not an array has no entries to read: it is reported, never
  // walked as one.
  if (!Array.isArray(bonuses)) return result(issues)
  bonuses.forEach((bonus, index) =>
    validateRestorationBonus(bonus, `[${index}]`, issues),
  )
  return result(issues)
}

function validateRestorationBonusScope(
  scope: unknown,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (scope !== 'normal_artian' && scope !== 'gogma_artian') {
    addIssue(issues, path, 'invalid_literal', 'Restoration bonus scope is required and must be valid.')
  }
}
export function validateOwnedWeapon(
  weapon: OwnedWeapon,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  validateId(weapon.id, 'id', issues)
  validateId(weapon.weaponTypeId, 'weaponTypeId', issues)
  validateId(weapon.elementId, 'elementId', issues)
  appendIssues(
    issues,
    'restorationBonuses',
    validateRestorationBonusSet(weapon.restorationBonuses),
  )
  validateRestorationBonusScope(weapon.restorationBonusScope, 'restorationBonusScope', issues)
  if (!['normal', 'gogma'].includes(weapon.kind)) {
    addIssue(issues, 'kind', 'invalid_literal', 'OwnedWeapon kind is invalid.')
  } else if (weapon.kind === 'normal') {
    if (weapon.restorationBonusScope !== 'normal_artian') {
      addIssue(issues, 'restorationBonusScope', 'invalid_state', 'Normal Artian weapons require normal_artian scope.')
    }
    if (weapon.rarity !== V1_NORMAL_ARTIAN_RARITY) {
      addIssue(issues, 'rarity', 'invalid_literal', 'v1 supports only rarity 8 owned Normal Artian weapons.')
    }
    if (weapon.seriesSkillId !== null) {
      addIssue(issues, 'seriesSkillId', 'invalid_state', 'Normal Artian weapons cannot have a Series Skill.')
    }
    if (weapon.groupSkillId !== null) {
      addIssue(issues, 'groupSkillId', 'invalid_state', 'Normal Artian weapons cannot have a Group Skill.')
    }
    if (weapon.status !== null) {
      addIssue(issues, 'status', 'invalid_state', 'Normal Artian weapons cannot have an OwnedWeapon status.')
    }
  } else if (!['unclassified', 'practical', 'ideal'].includes(weapon.status)) {
    addIssue(issues, 'status', 'invalid_literal', 'Gogma Artian weapons require a valid status.')
  }
  validateOwnedWeaponExecutionInProgress(weapon.executionInProgress, issues)
  return result(issues)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * `executionInProgress` must be present: `null` or a Plan ID plus a start time.
 * A missing field is never read as `null`, because that would silently accept a
 * record whose shape predates the Execution lifecycle.
 */
function validateOwnedWeaponExecutionInProgress(
  value: unknown,
  issues: DomainValidationIssue[],
) {
  if (value === null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    addIssue(issues, 'executionInProgress', 'invalid_structure', 'executionInProgress must be null or an in-progress record.')
    return
  }
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.productionPlanId)) {
    addIssue(issues, 'executionInProgress.productionPlanId', 'invalid_id', 'ID must be a non-empty string.')
  }
  if (!isNonEmptyString(record.startedAt)) {
    addIssue(issues, 'executionInProgress.startedAt', 'invalid_structure', 'startedAt must be an ISO date-time string.')
  }
}

function validateLegacyBonusCondition(
  condition: LegacyPracticalBonusCondition, count: number, path: string, issues: DomainValidationIssue[],
) {
  validateId(condition.id, path + '.id', issues)
  validateId(condition.bonusTypeId, path + '.bonusTypeId', issues)
  validateId(condition.minimumRankId, path + '.minimumRankId', issues)
  if (!Number.isInteger(condition.requiredExCount) || condition.requiredExCount < 0 || condition.requiredExCount > count) {
    addIssue(issues, path + '.requiredExCount', 'invalid_range', 'EX最低数は0以上、理想内の同種類の個数以下の整数にしてください。')
  }
  if ('requiredCount' in condition) addIssue(issues, path, 'invalid_structure', '旧実用条件は再設定が必要です。')
}

function validateLegacyAlternativeRule(
  rule: LegacyAlternativeBonusRule, count: number, path: string, issues: DomainValidationIssue[],
) {
  validateId(rule.id, path + '.id', issues)
  validateId(rule.sourceBonusTypeId, path + '.sourceBonusTypeId', issues)
  if (!Number.isInteger(rule.maxReplacementCount) || rule.maxReplacementCount < 1 || rule.maxReplacementCount > count) {
    addIssue(issues, path + '.maxReplacementCount', 'invalid_range', '最大置換数は1以上、理想内の元種類の個数以下の整数にしてください。')
  }
  if (!Array.isArray(rule.options) || rule.options.length === 0) {
    addIssue(issues, path + '.options', 'invalid_structure', '代替候補を1件以上設定してください。')
    return
  }
  const seen = new Set<string>()
  rule.options.forEach((option, index) => {
    const optionPath = path + '.options[' + index + ']'
    if (!isPlainObject(option)) {
      addIssue(issues, optionPath, 'invalid_structure', '代替候補の形式が不正です。')
      return
    }
    validateId(option.alternativeBonusTypeId, optionPath + '.alternativeBonusTypeId', issues)
    validateId(option.minimumRankId, optionPath + '.minimumRankId', issues)
    if (option.alternativeBonusTypeId === rule.sourceBonusTypeId || seen.has(option.alternativeBonusTypeId)) {
      addIssue(issues, optionPath, 'invalid_structure', '代替先は元と異なる種類を重複なく設定してください。')
    }
    seen.add(option.alternativeBonusTypeId)
    if (!Number.isInteger(option.requiredExCount) || option.requiredExCount < 0 || option.requiredExCount > rule.maxReplacementCount) {
      addIssue(issues, optionPath + '.requiredExCount', 'invalid_range', 'EX最低数は0以上、最大置換数以下の整数にしてください。')
    }
  })
}

function validateSkillConditionIds(
  condition: { seriesSkillId: unknown; groupSkillId: unknown },
  path: string,
  issues: DomainValidationIssue[],
) {
  if (condition.seriesSkillId !== null) {
    validateId(condition.seriesSkillId as string, `${path}.seriesSkillId`, issues)
  }
  if (condition.groupSkillId !== null) {
    validateId(condition.groupSkillId as string, `${path}.groupSkillId`, issues)
  }
}

/**
 * Structural validation of the completion Skill configurations
 * (`docs/DATA_MODEL.md` 8.4, Issue #367): one or more configurations, each with
 * a non-empty editing `id` unique in the Target and a Series / Group Skill that
 * is `null` or an ID, and no former `matchMode` field (AND inside a
 * configuration is structural; `any` and `all` no longer exist). Duplicate and
 * included configurations - an unspecified side includes a specified one - are
 * refused through `findCompletionSkillVariantConflicts()`, the authority the
 * editor shows. No Master is read, and no configuration count cap exists.
 */
function validateCompletionSkillVariants(variants: unknown, issues: DomainValidationIssue[]) {
  if (!Array.isArray(variants) || variants.length === 0) {
    addIssue(issues, 'completionSkillVariants', 'invalid_structure', '完成スキル構成を1件以上設定してください。')
    return
  }
  const seenIds = new Set<string>()
  let variantsValid = true
  variants.forEach((variant: unknown, index) => {
    const path = `completionSkillVariants[${index}]`
    if (!isPlainObject(variant)) {
      addIssue(issues, path, 'invalid_structure', '完成スキル構成の形式が不正です。')
      variantsValid = false
      return
    }
    if (!isNonEmptyString(variant.id)) {
      addIssue(issues, `${path}.id`, 'invalid_id', '完成スキル構成のIDが不正です。')
    } else if (seenIds.has(variant.id)) {
      addIssue(issues, `${path}.id`, 'invalid_id', '完成スキル構成のIDが重複しています。')
    } else {
      seenIds.add(variant.id)
    }
    if ('matchMode' in variant) {
      addIssue(issues, `${path}.matchMode`, 'invalid_structure', '完成スキル構成は一致方法（matchMode）を持ちません（指定したスキルはすべて一致が必要です）。')
    }
    const before = issues.length
    for (const field of ['seriesSkillId', 'groupSkillId'] as const) {
      if (!(field in variant) || (variant[field] !== null && typeof variant[field] !== 'string')) {
        addIssue(issues, `${path}.${field}`, 'invalid_structure', `${field} must be null or an ID.`)
      }
    }
    if (issues.length === before) validateSkillConditionIds(variant as { seriesSkillId: unknown; groupSkillId: unknown }, path, issues)
    if (issues.length !== before) variantsValid = false
  })
  if (!variantsValid) return
  findCompletionSkillVariantConflicts(variants as { seriesSkillId: string | null; groupSkillId: string | null }[]).forEach(({ index, kind, otherIndex }) => {
    addIssue(
      issues,
      `completionSkillVariants[${index}]`,
      'invalid_structure',
      kind === 'duplicate'
        ? `完成スキル構成${index + 1}は完成スキル構成${otherIndex + 1}と同じ内容です。`
        : `完成スキル構成${index + 1}は完成スキル構成${otherIndex + 1}に含まれます（「指定なし」の項目は、その項目を指定した構成を含みます）。`,
    )
  })
}

/** A legacy Skill condition, where `any` still existed (migration input only). */
function validateLegacySkillCondition(
  condition: LegacySkillCondition,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (!isPlainObject(condition)) {
    addIssue(issues, path, 'invalid_structure', 'Skill condition must be an object.')
    return
  }
  if (!['all', 'any'].includes(condition.matchMode)) {
    addIssue(issues, `${path}.matchMode`, 'invalid_literal', 'Skill matchMode is invalid.')
  }
  validateSkillConditionIds(condition, path, issues)
}

/**
 * Target lifecycle combinations (`docs/DATA_MODEL.md` 8.1). An active Target
 * carries no completion metadata; a completed one carries its completion time,
 * an optional completing Plan (null for a user completion with an owned
 * weapon), and no preferred owned weapon. A missing field is never read as its
 * default.
 */
function validateTargetWeaponLifecycle(
  target: TargetWeapon | LegacyTargetWeapon,
  issues: DomainValidationIssue[],
) {
  if (!(targetWeaponLifecycleStatuses as readonly unknown[]).includes(target.lifecycleStatus)) {
    addIssue(issues, 'lifecycleStatus', 'invalid_literal', 'Target lifecycleStatus must be active or completed.')
    return
  }
  if (target.completedAt !== null && typeof target.completedAt !== 'string') {
    addIssue(issues, 'completedAt', 'invalid_structure', 'completedAt must be null or an ISO date-time string.')
  }
  if (target.completedByProductionPlanId !== null) {
    validateId(target.completedByProductionPlanId, 'completedByProductionPlanId', issues)
  }
  if (target.lifecycleStatus === 'active') {
    if (target.completedAt !== null) {
      addIssue(issues, 'completedAt', 'invalid_state', 'An active Target cannot have completedAt.')
    }
    if (target.completedByProductionPlanId !== null) {
      addIssue(issues, 'completedByProductionPlanId', 'invalid_state', 'An active Target cannot have completedByProductionPlanId.')
    }
    return
  }
  if (!isNonEmptyString(target.completedAt)) {
    addIssue(issues, 'completedAt', 'invalid_state', 'A completed Target requires completedAt.')
  }
  if (target.preferredOwnedWeaponId !== null) {
    addIssue(issues, 'preferredOwnedWeaponId', 'invalid_state', 'A completed Target cannot prefer an owned weapon.')
  }
}

/**
 * The structure of the completion assignment (`docs/DATA_MODEL.md` 8.7): an
 * `active` Target holds `null`, a `completed` Target an `OwnedWeaponId` or
 * `null` ("not recorded", completed before the assignment existed). The field
 * is required - a body without it is not a current (Dexie 13 / Export 16)
 * body. Whether the weapon exists and is assigned to no other Target needs the
 * collections, so it belongs to `validateTargetCompletionAssignments()`. A
 * legacy (schema 18) body never carries the field and is not checked here.
 */
function validateTargetCompletionAssignmentField(
  target: TargetWeapon,
  issues: DomainValidationIssue[],
) {
  const record = target as unknown as Record<string, unknown>
  if (!('completedWithOwnedWeaponId' in record) || record.completedWithOwnedWeaponId === undefined) {
    addIssue(issues, 'completedWithOwnedWeaponId', 'invalid_structure', 'completedWithOwnedWeaponId must be null or an OwnedWeapon ID.')
    return
  }
  const assigned = target.completedWithOwnedWeaponId
  if (assigned === null) return
  if (target.lifecycleStatus !== 'completed') {
    addIssue(issues, 'completedWithOwnedWeaponId', 'invalid_state', 'An active Target cannot have completedWithOwnedWeaponId.')
    return
  }
  validateId(assigned, 'completedWithOwnedWeaponId', issues)
}

function validateTargetWeaponCommon(
  target: TargetWeapon | LegacyTargetWeapon,
  issues: DomainValidationIssue[],
) {
  validateId(target.id, 'id', issues)
  validateId(target.weaponTypeId, 'weaponTypeId', issues)
  validateId(target.elementId, 'elementId', issues)
  if (!Number.isInteger(target.priority) || target.priority < 1 || target.priority > 5) {
    addIssue(issues, 'priority', 'invalid_range', 'Target priority must be 1 through 5.')
  }
  // Structural only. Whether the referenced weapon exists, is compatible, is
  // unprotected, and is claimed by no other Target needs the whole collection,
  // so it belongs to validateTargetPreferredOwnedWeapons() instead.
  if (target.preferredOwnedWeaponId !== null) {
    validateId(target.preferredOwnedWeaponId, 'preferredOwnedWeaponId', issues)
  }
  validateTargetWeaponLifecycle(target, issues)
}

function normalizedCompletionVariantKey(slots: readonly unknown[]): string {
  return stableStringify(
    slots
      .map((slot) => {
        const record = slot as Record<string, unknown>
        return stableStringify({ bonusTypeId: record.bonusTypeId, minimumRankId: record.minimumRankId })
      })
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  )
}

/**
 * Structural validation of the completion bonus Variants (`docs/DATA_MODEL.md`
 * 8.2): one or more Variants, each with a non-empty editing `id` and exactly
 * five slots of a bonus type and a minimum rank, and no two Variants with the
 * same normalized form (slot order and `id` never matter). The same `(type,
 * minimum)` may fill several slots of one Variant. No Variant count cap exists.
 * Inclusion between Variants needs the Master rank order and belongs to
 * `validateTargetCompletionConditions()`.
 */
function validateCompletionBonusVariants(variants: unknown, issues: DomainValidationIssue[]) {
  if (!Array.isArray(variants) || variants.length === 0) {
    addIssue(issues, 'completionBonusVariants', 'invalid_structure', '完成ボーナス構成を1件以上設定してください。')
    return
  }
  const seenKeys = new Map<string, number>()
  const seenIds = new Set<string>()
  variants.forEach((variant: unknown, index) => {
    const path = `completionBonusVariants[${index}]`
    if (!isPlainObject(variant)) {
      addIssue(issues, path, 'invalid_structure', '完成ボーナス構成の形式が不正です。')
      return
    }
    if (!isNonEmptyString(variant.id)) {
      addIssue(issues, `${path}.id`, 'invalid_id', '完成ボーナス構成のIDが不正です。')
    } else if (seenIds.has(variant.id)) {
      addIssue(issues, `${path}.id`, 'invalid_id', '完成ボーナス構成のIDが重複しています。')
    } else {
      seenIds.add(variant.id)
    }
    const slots: unknown = variant.slots
    if (!Array.isArray(slots) || slots.length !== 5) {
      addIssue(issues, `${path}.slots`, 'invalid_structure', '完成ボーナス構成は5枠を指定してください。')
      return
    }
    let slotsValid = true
    slots.forEach((slot: unknown, slotIndex) => {
      const slotPath = `${path}.slots[${slotIndex}]`
      if (!isPlainObject(slot)) {
        addIssue(issues, slotPath, 'invalid_structure', '完成ボーナス構成の枠の形式が不正です。')
        slotsValid = false
        return
      }
      const before = issues.length
      validateId(slot.bonusTypeId as string, `${slotPath}.bonusTypeId`, issues)
      validateId(slot.minimumRankId as string, `${slotPath}.minimumRankId`, issues)
      if (issues.length !== before) slotsValid = false
    })
    if (!slotsValid) return
    const key = normalizedCompletionVariantKey(slots)
    const duplicateOf = seenKeys.get(key)
    if (duplicateOf !== undefined) {
      addIssue(issues, path, 'invalid_structure', `完成構成${index + 1}は完成構成${duplicateOf + 1}と同じ内容です（枠の順番だけが異なる構成は登録できません）。`)
    } else {
      seenKeys.set(key, index)
    }
  })
}

function validateCompletionConditionReview(review: unknown, issues: DomainValidationIssue[]) {
  if (!Array.isArray(review)) {
    addIssue(issues, 'completionConditionReview', 'invalid_structure', 'completionConditionReview must be an array.')
    return
  }
  const known: readonly unknown[] = completionConditionReviewReasons
  review.forEach((reason: unknown, index) => {
    if (!known.includes(reason)) {
      addIssue(issues, `completionConditionReview[${index}]`, 'invalid_literal', 'Unknown completion condition review reason.')
    }
  })
  if (new Set(review).size !== review.length) {
    addIssue(issues, 'completionConditionReview', 'invalid_structure', 'completionConditionReview reasons must not repeat.')
  }
}

/**
 * Structural validation of a TargetWeapon (`docs/DATA_MODEL.md` 8): identity,
 * priority, lifecycle, the completion Variants, the completion Skill
 * configurations (8.4) and the review reasons. A body still carrying a legacy field
 * (`idealBonuses`, the compromise conditions, `compromiseNeedsReview`) is not a
 * current body and is refused rather than read, and so is a body still
 * carrying the schema 16 `completionSkillCondition` (Issue #367). A non-empty review list is
 * still a valid Target: valid and calculable are separate concepts (8.6).
 */
export function validateTargetWeapon(
  target: TargetWeapon,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!isPlainObject(target)) {
    addIssue(issues, '', 'invalid_structure', 'TargetWeapon must be an object.')
    return result(issues)
  }
  validateTargetWeaponCommon(target, issues)
  validateTargetCompletionAssignmentField(target, issues)
  if (hasLegacyTargetWeaponField(target as unknown as Record<string, unknown>)) {
    addIssue(issues, '', 'invalid_structure', '旧形式の目標武器（理想5枠・妥協条件）は移行が必要です。')
  }
  if ('completionSkillCondition' in target) {
    addIssue(issues, 'completionSkillCondition', 'invalid_structure', '旧形式の完成スキル条件（1組）は移行が必要です。')
  }
  validateCompletionBonusVariants(target.completionBonusVariants, issues)
  validateCompletionSkillVariants(target.completionSkillVariants, issues)
  validateCompletionConditionReview(target.completionConditionReview, issues)
  return result(issues)
}

/**
 * The structural validation of a legacy (calculation schema 18 / Dexie 11 /
 * Export 14) Target body - the rule `validateTargetWeapon()` applied before
 * Issue #100. Only the ExecutionHistory conversion of legacy data (the Dexie
 * version(11) upgrade and the Export schema 13 -> 14 migration) reads it, for
 * the Target bodies inside the records it converts; those bodies are migrated
 * to the current shape by the next step.
 */
export function validateLegacyTargetWeapon(
  target: LegacyTargetWeapon,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!isPlainObject(target)) {
    addIssue(issues, '', 'invalid_structure', 'TargetWeapon must be an object.')
    return result(issues)
  }
  validateTargetWeaponCommon(target, issues)
  if (hasCompletionConditionTargetField(target as unknown as Record<string, unknown>)) {
    addIssue(issues, '', 'invalid_structure', 'A legacy Target body cannot carry a completion condition field.')
  }
  appendIssues(issues, 'idealBonuses', validateRestorationBonusSet(target.idealBonuses))
  if (!Array.isArray(target.practicalBonusConditions) || !Array.isArray(target.alternativeBonusRules) || 'practicalAlternativeGroups' in target) {
    addIssue(issues, 'alternativeBonusRules', 'invalid_structure', '旧条件または不正な妥協条件です。移行・再設定が必要です。')
    return result(issues)
  }
  // An Ideal that is not an array was reported above; it holds no type to count.
  const idealBonuses: readonly unknown[] = Array.isArray(target.idealBonuses) ? target.idealBonuses : []
  const idealCount = (type: string) =>
    idealBonuses.filter((bonus) => isPlainObject(bonus) && bonus.bonusTypeId === type).length
  const practicalTypes = new Set<string>()
  target.practicalBonusConditions.forEach((condition, index) => {
    const path = 'practicalBonusConditions[' + index + ']'
    if (!isPlainObject(condition)) {
      addIssue(issues, path, 'invalid_structure', '実用条件の形式が不正です。')
      return
    }
    const count = idealCount(condition.bonusTypeId)
    if (count === 0 || practicalTypes.has(condition.bonusTypeId)) addIssue(issues, path, 'invalid_structure', '理想に含まれる種類を重複なく設定してください。')
    practicalTypes.add(condition.bonusTypeId)
    validateLegacyBonusCondition(condition, count, path, issues)
  })
  const sources = new Set<string>()
  target.alternativeBonusRules.forEach((rule, index) => {
    const path = 'alternativeBonusRules[' + index + ']'
    if (!isPlainObject(rule)) {
      addIssue(issues, path, 'invalid_structure', '代替条件の形式が不正です。')
      return
    }
    const count = idealCount(rule.sourceBonusTypeId)
    if (count === 0 || sources.has(rule.sourceBonusTypeId)) addIssue(issues, path, 'invalid_structure', '元ボーナスは理想に含まれる種類を重複なく設定してください。')
    sources.add(rule.sourceBonusTypeId)
    validateLegacyAlternativeRule(rule, count, path, issues)
  })
  validateLegacySkillCondition(target.idealSkillCondition, 'idealSkillCondition', issues)
  validateLegacySkillCondition(target.practicalSkillCondition, 'practicalSkillCondition', issues)
  return result(issues)
}

function validateRouteOperation(
  operation: RouteOperation,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (operation.type === 'create_normal_artian') {
    validateId(operation.weaponTypeId, `${path}.weaponTypeId`, issues)
    if (operation.rarity !== V1_NORMAL_ARTIAN_RARITY) {
      addIssue(
        issues,
        `${path}.rarity`,
        'invalid_literal',
        'v1 can create only rarity 8 Normal Artian weapons.',
      )
    }
    validatePositiveInteger(operation.count, `${path}.count`, issues)
    // Blind creation stores no absolute Counter position at all. A half-filled
    // pair is neither variant, so it is rejected instead of being coerced.
    if (
      operation.normalCounterBefore === null ||
      operation.normalCounterAfter === null
    ) {
      if (
        operation.normalCounterBefore !== null ||
        operation.normalCounterAfter !== null
      ) {
        addIssue(
          issues,
          `${path}.normalCounterBefore`,
          'invalid_state',
          'A blind Normal creation must leave both Normal Counter positions null.',
        )
      }
      if (operation.count !== 1) {
        addIssue(
          issues,
          `${path}.count`,
          'invalid_state',
          'A blind Normal creation forges exactly one Normal Artian weapon.',
        )
      }
      return
    }
    validateNonNegativeInteger(operation.normalCounterBefore, `${path}.normalCounterBefore`, issues)
    validateNonNegativeInteger(operation.normalCounterAfter, `${path}.normalCounterAfter`, issues)
    return
  }
  if (operation.type === 'convert_normal_to_gogma') {
    validateId(operation.weaponTypeId, `${path}.weaponTypeId`, issues)
    validateNonNegativeInteger(operation.skillCounterBefore, `${path}.skillCounterBefore`, issues)
    validateNonNegativeInteger(operation.skillCounterAfter, `${path}.skillCounterAfter`, issues)
    return
  }
  if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
    if (operation.sourceOwnedWeaponId !== null) {
      validateId(operation.sourceOwnedWeaponId, `${path}.sourceOwnedWeaponId`, issues)
    }
    validateNonNegativeInteger(operation.gogmaCounterBefore, `${path}.gogmaCounterBefore`, issues)
    validateNonNegativeInteger(operation.gogmaCounterAfter, `${path}.gogmaCounterAfter`, issues)
    return
  }
  if (operation.type === 'reset_skills') {
    if (operation.sourceOwnedWeaponId !== null) {
      validateId(operation.sourceOwnedWeaponId, `${path}.sourceOwnedWeaponId`, issues)
    }
    validateNonNegativeInteger(operation.skillCounterBefore, `${path}.skillCounterBefore`, issues)
    validateNonNegativeInteger(operation.skillCounterAfter, `${path}.skillCounterAfter`, issues)
    return
  }
  addIssue(
    issues,
    `${path}.type`,
    'invalid_literal',
    'Route operation type is invalid.',
  )
}
function validateProtectedRouteUse(
  route: BuildRoute,
  ownedWeapons: readonly OwnedWeapon[],
  issues: DomainValidationIssue[],
) {
  const byId = new Map(ownedWeapons.map((weapon) => [weapon.id, weapon]))
  if (
    route.sourceOwnedWeaponId !== null &&
    !byId.has(route.sourceOwnedWeaponId)
  ) {
    addIssue(
      issues,
      'sourceOwnedWeaponId',
      'invalid_reference',
      `Referenced OwnedWeapon '${route.sourceOwnedWeaponId}' does not exist.`,
    )
  }
  // An owned Gogma's five slots are always known, so Keep Bonuses is legal from
  // either stored scope (`docs/SEARCH_SPEC.md` 5.9); only kind and protection
  // decide every amendment here.
  route.operations.forEach((operation, index) => {
    const path = `operations[${index}]`
    const id =
      operation.type === 'reset_bonuses' ||
      operation.type === 'keep_bonuses' ||
      operation.type === 'reset_skills'
        ? operation.sourceOwnedWeaponId
        : null
    if (id === null) return
    const weapon = byId.get(id)
    if (!weapon) {
      addIssue(issues, path, 'invalid_reference', `Referenced OwnedWeapon '${id}' does not exist.`)
      return
    }
    const allowed =
      operation.type === 'reset_bonuses'
        ? canResetBonuses(weapon)
        : operation.type === 'keep_bonuses'
          ? canKeepBonuses(weapon)
          : canResetSkills(weapon)
    if (!allowed) {
      addIssue(
        issues,
        path,
        'protected_destructive_use',
        `OwnedWeapon '${id}' cannot be used by this destructive operation.`,
      )
    }
  })
}

export function validateBuildRoute(
  route: BuildRoute,
  ownedWeapons?: readonly OwnedWeapon[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (
    ![
      'normal_artian_to_gogma',
      'owned_normal_artian_to_gogma',
      'existing_gogma_current',
      'existing_gogma_reset_bonuses',
      'existing_gogma_keep_bonuses',
      'existing_gogma_reset_skills',
      'existing_gogma_mixed',
    ].includes(route.kind)
  ) {
    addIssue(issues, 'kind', 'invalid_literal', 'BuildRoute kind is invalid.')
  }
  if (!Array.isArray(route.operations)) {
    addIssue(issues, 'operations', 'invalid_structure', 'BuildRoute operations must be an array.')
  } else if (
    route.operations.length === 0 &&
    route.kind !== 'existing_gogma_current'
  ) {
    addIssue(issues, 'operations', 'invalid_structure', 'Only an existing_gogma_current route may have no operations.')
  }
  route.operations.forEach((operation, index) =>
    validateRouteOperation(operation, `operations[${index}]`, issues),
  )

  if (route.kind === 'normal_artian_to_gogma') {
    if (route.sourceOwnedWeaponId !== null) {
      addIssue(
        issues,
        'sourceOwnedWeaponId',
        'invalid_state',
        'normal_artian_to_gogma cannot reference an existing OwnedWeapon.',
      )
    }
    /**
     * Canonical Route contract (`docs/DATA_MODEL.md` 9 / `docs/SEARCH_SPEC.md`
     * 6.1 / 6.1.1): exactly one `create_normal_artian`, whose `count` is the
     * forge count (`candidateOffset = k` forges `k + 1` weapons through one
     * operation, never through repeated creations), then exactly one
     * `convert_normal_to_gogma` for the last forged weapon, then the transient
     * Gogma's Reset Bonuses / Keep Bonuses / Reset Skills. The blind variant is
     * a property of the whole Route, decided before the ordering walk, so a
     * misplaced blind creation can never hide from the Keep check below.
     */
    type CreateOperation = Extract<BuildRoute['operations'][number], { type: 'create_normal_artian' }>
    const creates = route.operations.filter(
      (operation): operation is CreateOperation => operation.type === 'create_normal_artian',
    )
    const isBlind = creates.some(isBlindCreateNormalArtianOperation)
    const createIndex = route.operations.findIndex(({ type }) => type === 'create_normal_artian')
    const conversionIndex = route.operations.findIndex(({ type }) => type === 'convert_normal_to_gogma')
    const conversionCount = route.operations.filter(({ type }) => type === 'convert_normal_to_gogma').length
    if (creates.length !== 1) {
      addIssue(
        issues,
        'operations',
        'invalid_route_operation',
        'normal_artian_to_gogma carries exactly one create_normal_artian operation; several forges are expressed by its count.',
      )
    }
    if (conversionCount !== 1) {
      addIssue(
        issues,
        'operations',
        'invalid_route_operation',
        'normal_artian_to_gogma carries exactly one convert_normal_to_gogma operation for the last forged weapon.',
      )
    }
    let resetBonusesCount = 0
    route.operations.forEach((operation, index) => {
      if (!['create_normal_artian', 'convert_normal_to_gogma', 'reset_bonuses', 'keep_bonuses', 'reset_skills'].includes(operation.type)) {
        addIssue(
          issues,
          `operations[${index}]`,
          'invalid_route_operation',
          `Operation '${operation.type}' is not allowed in normal_artian_to_gogma.`,
        )
        return
      }
      if (operation.type === 'create_normal_artian') {
        if (conversionIndex !== -1 && index > conversionIndex) {
          addIssue(issues, `operations[${index}]`, 'invalid_route_operation', 'create_normal_artian must precede the conversion.')
        }
        return
      }
      if (operation.type === 'convert_normal_to_gogma') {
        if (createIndex === -1 || index < createIndex) {
          addIssue(issues, `operations[${index}]`, 'invalid_route_operation', 'convert_normal_to_gogma requires a preceding create_normal_artian.')
        }
        return
      }
      // Every amendment operates on the converted transient Gogma, so it must
      // follow the conversion and target the unregistered route output.
      if (conversionIndex === -1 || index < conversionIndex) {
        addIssue(issues, `operations[${index}]`, 'invalid_route_operation', `${operation.type} must follow the conversion in normal_artian_to_gogma.`)
      }
      if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
        if (operation.sourceOwnedWeaponId !== null) {
          addIssue(issues, `operations[${index}].sourceOwnedWeaponId`, 'invalid_state', 'A normal-route bonus amendment must target the converted route output.')
        }
        // The predicted variant knows the forged five slots, so Keep may be the
        // first amendment. Only the blind variant's slots are unknown until a
        // Reset rewrites them (`docs/SEARCH_SPEC.md` 6.1.1): an unknown-input
        // rule, not a prediction-support limit and not a game rule.
        if (operation.type === 'keep_bonuses' && isBlind && resetBonusesCount === 0) {
          addIssue(issues, `operations[${index}]`, 'invalid_route_operation', 'Keep Bonuses cannot read the unknown five slots of a blind Normal Artian; a Reset Bonuses must precede it.')
        }
        if (operation.type === 'reset_bonuses') resetBonusesCount += 1
      }
      if (operation.type === 'reset_skills' && operation.sourceOwnedWeaponId !== null) {
        addIssue(
          issues,
          `operations[${index}].sourceOwnedWeaponId`,
          'invalid_state',
          'A normal-route Reset Skills operation must target the unregistered route output.',
        )
      }
    })
    if (isBlind) {
      // The forged weapon's five slots are unknown, so the Route is executable
      // only when a Reset Bonuses rewrites all five of them
      // (`docs/SEARCH_SPEC.md` 6.1.1).
      if (creates.length !== 1 || !creates.every(isBlindCreateNormalArtianOperation)) {
        addIssue(
          issues,
          'operations',
          'invalid_route_operation',
          'A blind Normal Artian route creates exactly one Normal Artian weapon.',
        )
      }
      if (conversionCount === 0) {
        addIssue(
          issues,
          'operations',
          'invalid_route_operation',
          'A blind Normal Artian route requires a conversion operation.',
        )
      }
      if (resetBonusesCount === 0) {
        addIssue(
          issues,
          'operations',
          'invalid_route_operation',
          'A blind Normal Artian route requires Reset Bonuses, because the created weapon has unknown restoration bonuses.',
        )
      }
    }
  } else if (route.kind === 'owned_normal_artian_to_gogma') {
    if (route.sourceOwnedWeaponId === null) {
      addIssue(
        issues,
        'sourceOwnedWeaponId',
        'invalid_state',
        'owned_normal_artian_to_gogma requires a source OwnedWeapon.',
      )
    }
    let hasConversion = false
    route.operations.forEach((operation, index) => {
      if (!['convert_normal_to_gogma', 'reset_bonuses', 'keep_bonuses', 'reset_skills'].includes(operation.type)) {
        addIssue(
          issues,
          `operations[${index}]`,
          'invalid_route_operation',
          `Operation '${operation.type}' is not allowed in owned_normal_artian_to_gogma.`,
        )
      }
      if (operation.type === 'convert_normal_to_gogma') hasConversion = true
      // The source Normal's five slots are known, so either Reset or Keep may be
      // the first amendment after conversion (`docs/SEARCH_SPEC.md` 6.2 / 5.9).
      if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') {
        if (operation.sourceOwnedWeaponId !== null || !hasConversion) {
          addIssue(issues, `operations[${index}].sourceOwnedWeaponId`, 'invalid_state', 'A post-conversion bonus amendment must target the converted route output.')
        }
      }
      if (operation.type === 'reset_skills' && operation.sourceOwnedWeaponId !== null) {
        addIssue(
          issues,
          `operations[${index}].sourceOwnedWeaponId`,
          'invalid_state',
          'A post-conversion Reset Skills operation must target the unregistered route output.',
        )
      }
    })
    if (!hasConversion) {
      addIssue(
        issues,
        'operations',
        'invalid_route_operation',
        'owned_normal_artian_to_gogma requires a conversion operation.',
      )
    }
    if (ownedWeapons && route.sourceOwnedWeaponId !== null) {
      const source = ownedWeapons.find(({ id }) => id === route.sourceOwnedWeaponId)
      if (source && source.kind !== 'normal') {
        addIssue(issues, 'sourceOwnedWeaponId', 'invalid_reference', 'The conversion source must be a Normal Artian weapon.')
      }
      if (source?.isProtected) {
        addIssue(issues, 'sourceOwnedWeaponId', 'protected_destructive_use', 'A protected Normal Artian weapon cannot be converted.')
      }
    }
  } else if (route.sourceOwnedWeaponId === null) {
    addIssue(
      issues,
      'sourceOwnedWeaponId',
      'invalid_state',
      'An existing-Gogma route requires sourceOwnedWeaponId.',
    )
  }

  if (route.kind === 'existing_gogma_reset_skills') {
    route.operations.forEach((operation, index) => {
      if (operation.type !== 'reset_skills') {
        addIssue(
          issues,
          `operations[${index}]`,
          'invalid_route_operation',
          'existing_gogma_reset_skills may contain only Reset Skills operations.',
        )
      } else if (operation.sourceOwnedWeaponId !== route.sourceOwnedWeaponId) {
        addIssue(
          issues,
          `operations[${index}].sourceOwnedWeaponId`,
          'invalid_reference',
          'Reset Skills source must match the BuildRoute source.',
        )
      }
    })
  }
  if (
    route.kind === 'existing_gogma_current' &&
    route.operations.length !== 0
  ) {
    addIssue(
      issues,
      'operations',
      'invalid_route_operation',
      'existing_gogma_current must not contain any operations.',
    )
  }
  if (route.kind.startsWith('existing_gogma_') && route.kind !== 'existing_gogma_reset_skills') {
    const bonusOperations = route.operations.filter(
      ({ type }) => type === 'reset_bonuses' || type === 'keep_bonuses',
    )
    const hasReset = bonusOperations.some(({ type }) => type === 'reset_bonuses')
    const hasKeep = bonusOperations.some(({ type }) => type === 'keep_bonuses')
    const hasResetSkills = route.operations.some(({ type }) => type === 'reset_skills')
    const expectedKind = hasResetSkills || (hasReset && hasKeep)
      ? 'existing_gogma_mixed'
      : hasReset
        ? 'existing_gogma_reset_bonuses'
        : hasKeep
          ? 'existing_gogma_keep_bonuses'
          : null
    if (expectedKind !== null && route.kind !== expectedKind) {
      addIssue(issues, 'kind', 'invalid_state', 'Existing Gogma route kind must match its bonus amendment operations.')
    }
  }
  if (
    route.kind === 'existing_gogma_mixed' &&
    route.operations.every(({ type }) => type === 'reset_skills')
  ) {
    addIssue(
      issues,
      'kind',
      'invalid_state',
      'A Reset-Skills-only route must use existing_gogma_reset_skills.',
    )
  }
  if (ownedWeapons) validateProtectedRouteUse(route, ownedWeapons, issues)
  return result(issues)
}

function validateMaterialRequirement(
  requirement: MaterialRequirement,
  path: string,
  issues: DomainValidationIssue[],
) {
  validateId(requirement.materialId, `${path}.materialId`, issues)
  validatePositiveInteger(requirement.quantity, `${path}.quantity`, issues)
}

/**
 * The observational amendment trace, when present, must describe exactly the
 * Route it belongs to: one entry per `reset_bonuses` / `keep_bonuses`
 * operation, in execution order, pointing at that operation's own index, and
 * ending on the five slots the Candidate itself holds.
 *
 * The field is optional so Candidates persisted before it existed remain
 * valid. An absent trace is never an issue; a wrong one always is, because the
 * whole point is the operation-to-result correspondence.
 */
function validateCandidateBonusAmendmentTrace(
  candidate: BuildCandidate,
  issues: DomainValidationIssue[],
): void {
  const trace = candidate.bonusAmendmentTrace
  if (trace === undefined) return
  const amendmentIndexes = candidate.route.operations.flatMap(
    (operation, index) =>
      operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses'
        ? [index]
        : [],
  )
  if (trace.length !== amendmentIndexes.length) {
    addIssue(
      issues,
      'bonusAmendmentTrace',
      'invalid_state',
      'bonusAmendmentTrace must have one entry per bonus amendment operation.',
    )
    return
  }
  trace.forEach((step, index) => {
    const path = `bonusAmendmentTrace[${index}]`
    if (step.operationIndex !== amendmentIndexes[index]) {
      addIssue(
        issues,
        `${path}.operationIndex`,
        'invalid_state',
        'bonusAmendmentTrace entries must follow the route amendment order.',
      )
      return
    }
    const operation = candidate.route.operations[step.operationIndex]
    if (operation.type !== step.operationType) {
      addIssue(
        issues,
        `${path}.operationType`,
        'invalid_state',
        'bonusAmendmentTrace operationType must match the referenced operation.',
      )
    }
    appendIssues(
      issues,
      `${path}.restorationBonuses`,
      validateRestorationBonusSet(step.restorationBonuses),
    )
    validateRestorationBonusScope(
      step.restorationBonusScope,
      `${path}.restorationBonusScope`,
      issues,
    )
  })

  // The last bonus amendment is what the Candidate actually ends up holding.
  // The Route may continue with Reset Skills, so this is the last amendment,
  // not the last operation.
  const last = trace.at(-1)
  if (!last) return
  const lastPath = `bonusAmendmentTrace[${trace.length - 1}]`
  // Slot order is semantic here, so the multiset comparison of
  // `areRestorationBonusSetsEqual()` would wrongly accept a permutation.
  if (!areRestorationBonusSlotsEqual(last.restorationBonuses, candidate.finalBonuses)) {
    addIssue(
      issues,
      `${lastPath}.restorationBonuses`,
      'invalid_state',
      'The last bonus amendment must match finalBonuses slot by slot.',
    )
  }
  if (last.restorationBonusScope !== candidate.restorationBonusScope) {
    addIssue(
      issues,
      `${lastPath}.restorationBonusScope`,
      'invalid_state',
      'The last bonus amendment must match the Candidate restoration bonus scope.',
    )
  }
}

/**
 * The Skill counterpart of `validateCandidateBonusAmendmentTrace()`.
 *
 * Entries correspond one-to-one and in execution order with the Route's
 * `reset_skills` operations, and the last entry is what the Candidate actually
 * ends up holding. The Route may continue with bonus amendments after its last
 * Reset Skills, so the comparison is against the last Skill amendment, not the
 * last operation.
 *
 * The field is optional so Candidates persisted before it existed remain valid.
 * An absent trace is never an issue; a wrong one always is.
 */
function validateCandidateSkillAmendmentTrace(
  candidate: BuildCandidate,
  issues: DomainValidationIssue[],
): void {
  const trace = candidate.skillAmendmentTrace
  if (trace === undefined) return
  const amendmentIndexes = candidate.route.operations.flatMap(
    (operation, index) => (operation.type === 'reset_skills' ? [index] : []),
  )
  if (trace.length !== amendmentIndexes.length) {
    addIssue(
      issues,
      'skillAmendmentTrace',
      'invalid_state',
      'skillAmendmentTrace must have one entry per Reset Skills operation.',
    )
    return
  }
  trace.forEach((step, index) => {
    const path = `skillAmendmentTrace[${index}]`
    if (step.operationIndex !== amendmentIndexes[index]) {
      addIssue(
        issues,
        `${path}.operationIndex`,
        'invalid_state',
        'skillAmendmentTrace entries must follow the route Reset Skills order.',
      )
      return
    }
    if (step.operationType !== 'reset_skills') {
      addIssue(
        issues,
        `${path}.operationType`,
        'invalid_literal',
        'skillAmendmentTrace operationType must be reset_skills.',
      )
    }
    if (step.seriesSkillId !== null) validateId(step.seriesSkillId, `${path}.seriesSkillId`, issues)
    if (step.groupSkillId !== null) validateId(step.groupSkillId, `${path}.groupSkillId`, issues)
  })

  const last = trace.at(-1)
  if (!last) return
  const lastPath = `skillAmendmentTrace[${trace.length - 1}]`
  if (last.seriesSkillId !== candidate.seriesSkillId) {
    addIssue(
      issues,
      `${lastPath}.seriesSkillId`,
      'invalid_state',
      'The last Skill amendment must match the Candidate series skill.',
    )
  }
  if (last.groupSkillId !== candidate.groupSkillId) {
    addIssue(
      issues,
      `${lastPath}.groupSkillId`,
      'invalid_state',
      'The last Skill amendment must match the Candidate group skill.',
    )
  }
}

/**
 * The observational conversion Skill record, when present, must describe the
 * one `convert_normal_to_gogma` operation of the Route it belongs to.
 *
 * It is singular because SEARCH_SPEC 6.1 / 6.1.1 / 6.2 give a conversion Route
 * exactly one conversion operation, so a Route carrying the field with any
 * other conversion count is an internal inconsistency rather than something to
 * bind by best effort.
 *
 * The record is NOT compared against the Candidate's own Skills: a later
 * `reset_skills` legitimately overwrites the conversion result, and the
 * Candidate's `seriesSkillId` / `groupSkillId` stay the authority for the final
 * Skills. The field is optional so Candidates persisted before it existed
 * remain valid; an absent record is never an issue, a wrong one always is.
 */
function validateCandidateConversionSkillTrace(
  candidate: BuildCandidate,
  issues: DomainValidationIssue[],
): void {
  const step = candidate.conversionSkillTrace
  if (step === undefined) return
  const conversionIndexes = candidate.route.operations.flatMap(
    (operation, index) =>
      operation.type === 'convert_normal_to_gogma' ? [index] : [],
  )
  if (conversionIndexes.length !== 1) {
    addIssue(
      issues,
      'conversionSkillTrace',
      'invalid_state',
      'conversionSkillTrace requires exactly one conversion operation in the route.',
    )
    return
  }
  if (step.operationIndex !== conversionIndexes[0]) {
    addIssue(
      issues,
      'conversionSkillTrace.operationIndex',
      'invalid_state',
      'conversionSkillTrace must point at the route conversion operation.',
    )
    return
  }
  if (step.operationType !== 'convert_normal_to_gogma') {
    addIssue(
      issues,
      'conversionSkillTrace.operationType',
      'invalid_literal',
      'conversionSkillTrace operationType must be convert_normal_to_gogma.',
    )
  }
  if (step.seriesSkillId !== null) {
    validateId(step.seriesSkillId, 'conversionSkillTrace.seriesSkillId', issues)
  }
  if (step.groupSkillId !== null) {
    validateId(step.groupSkillId, 'conversionSkillTrace.groupSkillId', issues)
  }
}

/**
 * The Route operation indexes of each stream lane, in lane order
 * (`docs/SEARCH_SPEC.md` 5.8.1): `skill[i]` is the Route index of the
 * `(i + 1)`-th Reset Skills, `bonus[d]` that of the `(d + 1)`-th Bonus
 * amendment, and `conversion` the Route index of the conversion, or `null`.
 */
function routeLaneOperationIndexes(route: BuildRoute): {
  skill: number[]
  bonus: number[]
  conversion: number | null
} {
  const skill: number[] = []
  const bonus: number[] = []
  let conversion: number | null = null
  route.operations.forEach((operation, index) => {
    if (operation.type === 'reset_skills') skill.push(index)
    else if (operation.type === 'reset_bonuses' || operation.type === 'keep_bonuses') bonus.push(index)
    else if (operation.type === 'convert_normal_to_gogma' && conversion === null) conversion = index
  })
  return { skill, bonus, conversion }
}

/**
 * Strict intermediate state shape validation (`docs/SEARCH_SPEC.md` 5.8, a
 * historical record).
 *
 * Issue #100 abolished the intermediate states: calculation schema 19 and
 * later Candidates carry no `intermediateStateGroups`, and a historical
 * Candidate's groups are kept as they are. The structure is validated only
 * when the field is present (`docs/DATA_MODEL.md` 9.1).
 */
function validateCandidateIntermediateStateGroups(
  candidate: BuildCandidate,
  issues: DomainValidationIssue[],
): void {
  const groups = candidate.intermediateStateGroups
  if (groups === undefined) return
  const lanes = routeLaneOperationIndexes(candidate.route)
  const bonusGroupIds = new Set(
    groups.filter(({ axis }) => axis === 'bonus').map(({ id }) => id),
  )
  const seenGroupIds = new Set<string>()
  const opportunityIds = new Set<string>()
  groups.forEach((group, groupIndex) => {
    const path = `intermediateStateGroups[${groupIndex}]`
    validateId(group.id, `${path}.id`, issues)
    if (!group.id.startsWith('intermediate-group:')) {
      addIssue(issues, `${path}.id`, 'invalid_id', 'Intermediate state group ids use the intermediate-group prefix.')
    }
    if (seenGroupIds.has(group.id)) {
      addIssue(issues, `${path}.id`, 'invalid_structure', 'Intermediate state group ids must be unique.')
    }
    seenGroupIds.add(group.id)
    if (group.axis !== 'skill' && group.axis !== 'bonus') {
      addIssue(issues, `${path}.axis`, 'invalid_literal', 'An intermediate state group belongs to the skill or the bonus lane.')
      return
    }
    const laneIndexes = group.axis === 'skill' ? lanes.skill : lanes.bonus
    if (group.axis === 'skill') {
      if (!['practical', 'ideal'].includes(group.match)) {
        addIssue(issues, `${path}.match`, 'invalid_literal', 'A Skill state satisfies the Practical or the Ideal Skill condition.')
      }
      if (group.seriesSkillId !== null) validateId(group.seriesSkillId, `${path}.seriesSkillId`, issues)
      if (group.groupSkillId !== null) validateId(group.groupSkillId, `${path}.groupSkillId`, issues)
    } else {
      if (!['practical', 'alternative', 'ideal'].includes(group.match)) {
        addIssue(issues, `${path}.match`, 'invalid_literal', 'A Bonus state satisfies the Practical, Alternative, or Ideal Bonus condition.')
      }
      validateRestorationBonusScope(group.restorationBonusScope, `${path}.restorationBonusScope`, issues)
      if (group.restorationBonusScope !== 'gogma_artian') {
        addIssue(issues, `${path}.restorationBonusScope`, 'invalid_state', 'An accepted Bonus state must have Gogma Artian scope.')
      }
      appendIssues(issues, `${path}.restorationBonuses`, validateRestorationBonusSet(group.restorationBonuses))
      if (
        group.dominatingGroupId !== null &&
        (group.dominatingGroupId === group.id || !bonusGroupIds.has(group.dominatingGroupId))
      ) {
        addIssue(
          issues,
          `${path}.dominatingGroupId`,
          'invalid_reference',
          'dominatingGroupId must reference another Bonus state group of the same Candidate.',
        )
      }
      if (group.isDisplaySecondary !== (group.dominatingGroupId !== null)) {
        addIssue(issues, `${path}.isDisplaySecondary`, 'invalid_state', 'isDisplaySecondary must match the presence of dominatingGroupId.')
      }
    }
    if (group.opportunities.length === 0) {
      addIssue(issues, `${path}.opportunities`, 'invalid_state', 'An intermediate state group must keep at least one opportunity.')
    }
    group.opportunities.forEach((opportunity, index) => {
      const opportunityPath = `${path}.opportunities[${index}]`
      validateId(opportunity.id, `${opportunityPath}.id`, issues)
      if (!opportunity.id.startsWith('intermediate-opportunity:')) {
        addIssue(issues, `${opportunityPath}.id`, 'invalid_id', 'Intermediate state opportunity ids use the intermediate-opportunity prefix.')
      }
      if (opportunityIds.has(opportunity.id)) {
        addIssue(issues, `${opportunityPath}.id`, 'invalid_structure', 'Intermediate state opportunity ids must be unique.')
      }
      opportunityIds.add(opportunity.id)
      if (opportunity.axis !== group.axis) {
        addIssue(issues, `${opportunityPath}.axis`, 'invalid_state', 'An opportunity belongs to the lane of its group.')
      }
      validateNonNegativeInteger(opportunity.lanePosition, `${opportunityPath}.lanePosition`, issues)
      // The lane end is the Ideal result and never an intermediate state
      // (`docs/SEARCH_SPEC.md` 5.8.1).
      if (opportunity.lanePosition >= laneIndexes.length) {
        addIssue(issues, `${opportunityPath}.lanePosition`, 'invalid_range', 'An intermediate state lies strictly before its lane end.')
      } else {
        // The producing operation is a Route fact: lane position `n >= 1` is
        // produced by the lane's `n`-th operation, and position 0 by the
        // conversion when the Route has one.
        const expectedOperationIndex =
          opportunity.lanePosition === 0
            ? lanes.conversion
            : laneIndexes[opportunity.lanePosition - 1]
        if (opportunity.operationIndex !== expectedOperationIndex) {
          addIssue(issues, `${opportunityPath}.operationIndex`, 'invalid_state', 'operationIndex must be the Route operation that produces this lane position.')
        }
      }
      if (index > 0 && opportunity.lanePosition <= group.opportunities[index - 1].lanePosition) {
        addIssue(issues, `${opportunityPath}.lanePosition`, 'invalid_structure', 'Intermediate state opportunities must ascend by lane position.')
      }
      if (opportunity.axis === 'bonus' && group.axis === 'bonus') {
        appendIssues(issues, `${opportunityPath}.restorationBonuses`, validateRestorationBonusSet(opportunity.restorationBonuses))
        validateRestorationBonusScope(opportunity.restorationBonusScope, `${opportunityPath}.restorationBonusScope`, issues)
        if (
          opportunity.restorationBonusScope !== group.restorationBonusScope ||
          !areRestorationBonusSetsEqual(opportunity.restorationBonuses, group.restorationBonuses)
        ) {
          addIssue(issues, opportunityPath, 'invalid_state', 'Every opportunity must reach its own group product.')
        }
      }
    })
  })
}

export function validateBuildCandidate(
  candidate: BuildCandidate,
  ownedWeapons?: readonly OwnedWeapon[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  validateId(candidate.id, 'id', issues)
  validateId(candidate.targetWeaponId, 'targetWeaponId', issues)
  appendIssues(issues, 'finalBonuses', validateRestorationBonusSet(candidate.finalBonuses))
  validateRestorationBonusScope(candidate.restorationBonusScope, 'restorationBonusScope', issues)
  appendIssues(issues, 'route', validateBuildRoute(candidate.route, ownedWeapons))
  validateNonNegativeInteger(candidate.estimatedOperationCount, 'estimatedOperationCount', issues)
  validateNonNegativeInteger(candidate.estimatedGogmaAdvance, 'estimatedGogmaAdvance', issues)
  validateNonNegativeInteger(candidate.estimatedSkillAdvance, 'estimatedSkillAdvance', issues)
  if (candidate.estimatedNormalAdvance !== null) {
    validateNonNegativeInteger(candidate.estimatedNormalAdvance, 'estimatedNormalAdvance', issues)
  }
  candidate.requiredMaterials.forEach((requirement, index) =>
    validateMaterialRequirement(requirement, `requiredMaterials[${index}]`, issues),
  )
  if (candidate.idealDifference.matchedBonusCount < 0 || candidate.idealDifference.matchedBonusCount > 5) {
    addIssue(issues, 'idealDifference.matchedBonusCount', 'invalid_range', 'matchedBonusCount must be 0 through 5.')
  }
  validateCandidateIntermediateStateGroups(candidate, issues)
  validateId(candidate.searchStateHash, 'searchStateHash', issues)
  if (candidate.referencedOwnedWeaponsHash !== null) {
    validateId(candidate.referencedOwnedWeaponsHash, 'referencedOwnedWeaponsHash', issues)
  }
  validateCalculationContext(candidate.calculationContext, 'calculationContext', issues)
  validateId(candidate.searchRunId, 'searchRunId', issues)
  validateCandidateBonusAmendmentTrace(candidate, issues)
  validateCandidateSkillAmendmentTrace(candidate, issues)
  validateCandidateConversionSkillTrace(candidate, issues)

  if (candidate.route.kind === 'existing_gogma_reset_skills' && ownedWeapons) {
    const source = ownedWeapons.find(({ id }) => id === candidate.route.sourceOwnedWeaponId)
    if (source && !areRestorationBonusSetsEqual(candidate.finalBonuses, source.restorationBonuses)) {
      addIssue(
        issues,
        'finalBonuses',
        'invalid_state',
        'Reset-Skills-only candidates must preserve source restoration bonuses.',
      )
    }
  }
  if (
    candidate.route.kind === 'owned_normal_artian_to_gogma' &&
    candidate.referencedOwnedWeaponsHash === null
  ) {
    addIssue(
      issues,
      'referencedOwnedWeaponsHash',
      'invalid_state',
      'Owned-Normal conversion candidates must reference their source weapon.',
    )
  }
  return result(issues)
}

/**
 * The selected intermediate states are a hard Planner constraint, so an
 * unknown id, an id of the other lane, or an unknown preference fails closed
 * rather than being ignored (`docs/DATA_MODEL.md` 9.4). A lane start
 * (position 0) is a legal selection on either lane or both: for an existing
 * Gogma that names the weapon the user holds now, whose compromise checkpoint
 * the Planner treats as reached at its start, while a conversion Route's lane
 * start is reached once the conversion ran (`docs/PLANNER_SPEC.md` 7.5.2).
 *
 * Shared with the Planner's current-input validation: a malformed selection
 * must never reach the Planner, which would otherwise read it as an empty
 * selection (`docs/PLANNER_SPEC.md` 7.5.9).
 */
export function validateBuildListEntryIntermediateStateSelection(
  entry: BuildListEntry,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  appendIntermediateStateSelectionIssues(entry, issues)
  return result(issues)
}

function appendIntermediateStateSelectionIssues(
  entry: BuildListEntry,
  issues: DomainValidationIssue[],
): void {
  const selection = entry.intermediateStateSelection
  if (selection === undefined) return
  const path = 'intermediateStateSelection'
  if (!improvementPreferences.includes(selection.improvementPreference)) {
    addIssue(issues, `${path}.improvementPreference`, 'invalid_literal', 'The improvement preference must be planner, skill_first, or bonus_first.')
  }
  // Any lane position may be selected, the lane start included: an existing
  // Gogma that already holds a compromise state on both lanes is a checkpoint
  // held at Planner start, and a conversion Route's lane starts are produced
  // by the conversion itself (`docs/SEARCH_SPEC.md` 5.8.5). A selected id only
  // has to exist on its own lane of the Candidate Snapshot.
  const groups = entry.candidateSnapshot.intermediateStateGroups ?? []
  const axes = ['skill', 'bonus'] as const
  axes.forEach((axis) => {
    const selectedId = axis === 'skill' ? selection.skillOpportunityId : selection.bonusOpportunityId
    const field = axis === 'skill' ? 'skillOpportunityId' : 'bonusOpportunityId'
    if (selectedId === null) return
    const opportunity = groups
      .filter((group) => group.axis === axis)
      .flatMap((group): IntermediateStateOpportunity[] => [...group.opportunities])
      .find(({ id }) => id === selectedId)
    if (opportunity === undefined) {
      addIssue(
        issues,
        `${path}.${field}`,
        'invalid_reference',
        'A selected intermediate state must exist on its own lane in the candidate snapshot.',
      )
    }
  })
}

export function validateBuildListEntry(
  entry: BuildListEntry,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  validateId(entry.id, 'id', issues)
  validateId(entry.candidateId, 'candidateId', issues)
  validateId(entry.targetWeaponId, 'targetWeaponId', issues)
  appendIssues(issues, 'candidateSnapshot', validateBuildCandidate(entry.candidateSnapshot))
  if (entry.candidateSnapshot.id !== entry.candidateId) {
    addIssue(issues, 'candidateId', 'inconsistent_snapshot', 'candidateId must match candidateSnapshot.id.')
  }
  if (entry.candidateSnapshot.targetWeaponId !== entry.targetWeaponId) {
    addIssue(issues, 'targetWeaponId', 'inconsistent_snapshot', 'targetWeaponId must match the candidate snapshot.')
  }
  if (entry.searchStateHash !== entry.candidateSnapshot.searchStateHash) {
    addIssue(issues, 'searchStateHash', 'inconsistent_snapshot', 'searchStateHash must be copied from the candidate snapshot.')
  }
  if (entry.referencedOwnedWeaponsHash !== entry.candidateSnapshot.referencedOwnedWeaponsHash) {
    addIssue(issues, 'referencedOwnedWeaponsHash', 'inconsistent_snapshot', 'OwnedWeapon hash must be copied from the candidate snapshot.')
  }
  if (!isCalculationContextCompatible(entry.calculationContext, entry.candidateSnapshot.calculationContext)) {
    addIssue(issues, 'calculationContext', 'inconsistent_snapshot', 'CalculationContext must match the candidate snapshot.')
  }
  appendIntermediateStateSelectionIssues(entry, issues)
  if (entry.isStale !== (entry.staleReasons.length > 0)) {
    addIssue(issues, 'isStale', 'invalid_state', 'isStale must match the presence of staleReasons.')
  }
  const allowedStaleReasons = [
    'target_definition_changed',
    'rng_state_changed',
    'owned_weapon_changed',
    'calculation_context_changed',
  ]
  entry.staleReasons.forEach((reason, index) => {
    if (!allowedStaleReasons.includes(reason)) {
      addIssue(
        issues,
        `staleReasons[${index}]`,
        'invalid_literal',
        'BuildListEntry stale reason is invalid.',
      )
    }
  })
  validateId(entry.targetDefinitionHash, 'targetDefinitionHash', issues)
  return result(issues)
}

/**
 * The first calculation schema whose ProductionPlan follows the Execution
 * lifecycle contract (`docs/PLANNER_SPEC.md` 16): four-hash expected states,
 * Plan-dependent snapshot hashes, `executionEffects` on every Step, and no
 * independent `reserve_weapon` / `confirm_result` Step.
 */
export const EXECUTION_PLAN_CONTRACT_APP_SCHEMA_VERSION = 12

/**
 * The first calculation schema whose Plans link the Targets of Entries starting
 * from an existing OwnedWeapon at Plan start rather than at the Entry's first
 * physical Step (`docs/PLANNER_SPEC.md` 16.2 / 16.11). From it on,
 * `PlanningInputSnapshot.initialExecutionState` is the pre-start premise and
 * the first Step's `expectedStateBefore` is the state after the start effect.
 */
export const PLAN_START_EFFECT_APP_SCHEMA_VERSION = 13

export function isPlanStartEffectProductionPlan(
  plan: Pick<ProductionPlan, 'calculationContext'>,
): boolean {
  return plan.calculationContext.appSchemaVersion >= PLAN_START_EFFECT_APP_SCHEMA_VERSION
}

/**
 * The start effect changes Target preferences only, so the first Step's
 * `expectedStateBefore` equals the pre-start premise in every hash but
 * `targetExecutionStateHash`. A schema 12 Plan has no start effect and starts
 * exactly at the premise.
 */
function firstStepStartsFromPlanStart(plan: ProductionPlan): boolean {
  const first = plan.steps[0].expectedStateBefore
  const initial = plan.baseSnapshot.initialExecutionState
  if (!isPlanStartEffectProductionPlan(plan)) return sameExpectedPlanState(first, initial)
  return (
    first.rngStateHash === initial.rngStateHash &&
    first.normalCountersHash === initial.normalCountersHash &&
    first.ownedWeaponsHash === initial.ownedWeaponsHash
  )
}

/**
 * The first calculation schema whose Planner completes a planning Target only
 * through its own Entry's secured weapon, one physically distinct weapon per
 * Target (Issue #334 PR-3, `docs/PLANNER_SPEC.md` 21.5). From it on, the
 * `targetCompletions[].ownedWeaponId` of a Plan are distinct across the whole
 * Plan. A Plan of an earlier schema - which the zero-operation confirmation
 * could make complete two Targets with one weapon (21.4.1) - keeps its exact
 * persisted shape and is never failed by this rule: it fails closed at the
 * CalculationContext boundary, and the completion assignment safety judges it
 * before any execution.
 */
export const COMPLETION_WEAPON_UNIQUENESS_APP_SCHEMA_VERSION = 20

export function isCompletionWeaponUniquenessProductionPlan(
  plan: Pick<ProductionPlan, 'calculationContext'>,
): boolean {
  return plan.calculationContext.appSchemaVersion >= COMPLETION_WEAPON_UNIQUENESS_APP_SCHEMA_VERSION
}

/** Whether a persisted Plan claims the current Execution Plan contract. */
export function isExecutionContractProductionPlan(
  plan: Pick<ProductionPlan, 'calculationContext'>,
): boolean {
  return plan.calculationContext.appSchemaVersion >= EXECUTION_PLAN_CONTRACT_APP_SCHEMA_VERSION
}

/** The operations a current Planner may generate; `reserve_weapon` / `confirm_result` are legacy only. */
export const currentPlanStepOperationTypes: readonly PlanStepOperationType[] = [
  'create_normal_artian',
  'convert_normal_to_gogma',
  'reset_bonuses',
  'keep_bonuses',
  'reset_skills',
  'confirm_owned_ideal',
]

const legacyPlanStepOperationTypes: readonly PlanStepOperationType[] = [
  'reserve_weapon',
  'confirm_result',
]

function validateExpectedPlanState(
  state: ExpectedPlanState,
  path: string,
  issues: DomainValidationIssue[],
  requireTargetExecutionState: boolean,
) {
  validateId(state.rngStateHash, `${path}.rngStateHash`, issues)
  validateId(state.normalCountersHash, `${path}.normalCountersHash`, issues)
  validateId(state.ownedWeaponsHash, `${path}.ownedWeaponsHash`, issues)
  if (state.targetExecutionStateHash !== undefined || requireTargetExecutionState) {
    validateId(state.targetExecutionStateHash, `${path}.targetExecutionStateHash`, issues)
  }
}

function sameExpectedPlanState(left: ExpectedPlanState, right: ExpectedPlanState): boolean {
  return stableStringify(left) === stableStringify(right)
}

function validatePlanStepExecutionEffects(
  step: PlanStep,
  effects: PlanStepExecutionEffects,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (typeof effects !== 'object' || effects === null) {
    addIssue(issues, path, 'invalid_structure', 'executionEffects must be an object.')
    return
  }
  const lists = ['targetLinks', 'compromiseLabels', 'targetCompletions'] as const
  if (lists.some((field) => !Array.isArray(effects[field]))) {
    addIssue(issues, path, 'invalid_structure', 'executionEffects lists must be arrays.')
    return
  }
  const tracked = effects.trackedOwnedWeaponId
  if (tracked !== null) validateId(tracked, `${path}.trackedOwnedWeaponId`, issues)
  if (step.ownedWeaponId !== tracked) {
    addIssue(issues, `${path}.trackedOwnedWeaponId`, 'inconsistent_snapshot', 'PlanStep ownedWeaponId must be the tracked OwnedWeapon.')
  }
  effects.targetLinks.forEach((link, index) => {
    validateId(link.buildListEntryId, `${path}.targetLinks[${index}].buildListEntryId`, issues)
    validateId(link.targetWeaponId, `${path}.targetLinks[${index}].targetWeaponId`, issues)
  })
  effects.compromiseLabels.forEach((label, index) => {
    validateId(label.buildListEntryId, `${path}.compromiseLabels[${index}].buildListEntryId`, issues)
    if (label.ownedWeaponId !== tracked) {
      addIssue(issues, `${path}.compromiseLabels[${index}].ownedWeaponId`, 'inconsistent_snapshot', 'A compromise label applies to the tracked OwnedWeapon.')
    }
  })
  effects.targetCompletions.forEach((completion, index) => {
    validateId(completion.buildListEntryId, `${path}.targetCompletions[${index}].buildListEntryId`, issues)
    validateId(completion.targetWeaponId, `${path}.targetCompletions[${index}].targetWeaponId`, issues)
    if (completion.ownedWeaponId !== tracked) {
      addIssue(issues, `${path}.targetCompletions[${index}].ownedWeaponId`, 'inconsistent_snapshot', 'A Target completion applies to the tracked OwnedWeapon.')
    }
  })
  if (
    effects.observationBinding !== null &&
    effects.observationBinding.kind !== 'normal_restoration_bonuses'
  ) {
    addIssue(issues, `${path}.observationBinding.kind`, 'invalid_literal', 'Observation binding kind is invalid.')
  }

  if (step.operationType === 'create_normal_artian') {
    if (effects.normalCreationRole === 'counter_advance') {
      if (
        tracked !== null ||
        effects.registersTrackedWeapon ||
        effects.observationBinding !== null ||
        effects.targetLinks.length > 0 ||
        effects.compromiseLabels.length > 0 ||
        effects.targetCompletions.length > 0
      ) {
        addIssue(issues, path, 'invalid_state', 'A Counter-advance Normal is never tracked, registered, observed, linked, labelled or completed.')
      }
    } else if (effects.normalCreationRole === 'production_target') {
      if (tracked === null || !effects.registersTrackedWeapon) {
        addIssue(issues, path, 'invalid_state', 'A production-target Normal registers its tracked OwnedWeapon.')
      }
      if (effects.compromiseLabels.length > 0 || effects.targetCompletions.length > 0) {
        addIssue(issues, path, 'invalid_state', 'A Normal creation neither reaches a checkpoint nor completes a Target.')
      }
      if (effects.observationBinding !== null) {
        if (
          step.expectedResult?.restorationBonuses !== null ||
          step.expectedResult?.restorationBonusScope !== null ||
          step.inventoryChange?.addOwnedWeapon != null
        ) {
          addIssue(issues, path, 'invalid_state', 'An observation-bound Normal carries no predicted or registered five slots.')
        }
      } else if (
        step.inventoryChange?.addOwnedWeapon == null ||
        step.inventoryChange.addOwnedWeapon.id !== tracked
      ) {
        addIssue(issues, `${path}.inventoryChange.addOwnedWeapon`, 'invalid_state', 'A predicted production-target Normal registers its tracked weapon.')
      }
    } else {
      addIssue(issues, `${path}.normalCreationRole`, 'invalid_literal', 'create_normal_artian requires counter_advance or production_target.')
    }
  } else {
    if (effects.normalCreationRole !== null || effects.registersTrackedWeapon || effects.observationBinding !== null) {
      addIssue(issues, path, 'invalid_state', 'Only a Normal creation carries a creation role, a registration or an observation binding.')
    }
    if (tracked === null) {
      addIssue(issues, `${path}.trackedOwnedWeaponId`, 'invalid_state', 'This PlanStep operates on a tracked OwnedWeapon.')
    }
  }

  if (step.operationType === 'confirm_owned_ideal') {
    const advance = step.rngAdvance
    if (
      advance.gogmaCounterDelta !== 0 ||
      advance.skillCounterDelta !== 0 ||
      advance.normalCounterDelta !== null ||
      advance.affectedNormalCounterId !== null
    ) {
      addIssue(issues, `${path}.rngAdvance`, 'invalid_state', 'confirm_owned_ideal advances no Counter.')
    }
    if (
      effects.targetCompletions.length !== 1 ||
      effects.targetLinks.length > 0 ||
      effects.compromiseLabels.length > 0
    ) {
      addIssue(issues, path, 'invalid_state', 'confirm_owned_ideal carries exactly one Target completion and nothing else.')
    }
    if (
      step.expectedStateBefore.rngStateHash !== step.expectedStateAfter.rngStateHash ||
      step.expectedStateBefore.normalCountersHash !== step.expectedStateAfter.normalCountersHash
    ) {
      addIssue(issues, 'expectedStateAfter', 'inconsistent_snapshot', 'confirm_owned_ideal leaves the RNG and Normal Counter state unchanged.')
    }
  }
}

function validatePlanStep(
  step: PlanStep,
  expectedOrder: number,
  issues: DomainValidationIssue[],
  executionContract: boolean,
) {
  const path = `steps[${expectedOrder - 1}]`
  validateId(step.id, `${path}.id`, issues)
  const allowedOperationTypes: readonly PlanStepOperationType[] = executionContract
    ? currentPlanStepOperationTypes
    : [...currentPlanStepOperationTypes, ...legacyPlanStepOperationTypes]
  if (!allowedOperationTypes.includes(step.operationType)) {
    addIssue(
      issues,
      `${path}.operationType`,
      'invalid_literal',
      'PlanStep operation type is invalid.',
    )
  }
  if (step.order !== expectedOrder) {
    addIssue(issues, `${path}.order`, 'invalid_state', 'PlanStep order must be a one-based contiguous sequence.')
  }
  if (step.progressedTargetWeaponIds !== undefined) {
    if (!Array.isArray(step.progressedTargetWeaponIds)) {
      addIssue(
        issues,
        `${path}.progressedTargetWeaponIds`,
        'invalid_structure',
        'progressedTargetWeaponIds must be an array when present.',
      )
    } else {
      step.progressedTargetWeaponIds.forEach((id, index) =>
        validateId(id, `${path}.progressedTargetWeaponIds[${index}]`, issues),
      )
      if (
        new Set(step.progressedTargetWeaponIds).size !==
        step.progressedTargetWeaponIds.length
      ) {
        addIssue(
          issues,
          `${path}.progressedTargetWeaponIds`,
          'invalid_state',
          'progressedTargetWeaponIds must not contain duplicates.',
        )
      }
    }
  }
  if (step.isCompleted && step.completedAt === null) {
    addIssue(issues, `${path}.completedAt`, 'invalid_state', 'A completed PlanStep requires completedAt.')
  }
  validateExpectedPlanState(step.expectedStateBefore, `${path}.expectedStateBefore`, issues, executionContract)
  validateExpectedPlanState(step.expectedStateAfter, `${path}.expectedStateAfter`, issues, executionContract)
  if (step.executionEffects !== undefined) {
    validatePlanStepExecutionEffects(step, step.executionEffects, `${path}.executionEffects`, issues)
  } else if (executionContract || step.operationType === 'confirm_owned_ideal') {
    addIssue(issues, `${path}.executionEffects`, 'invalid_structure', 'A current PlanStep requires executionEffects.')
  }
  if (step.expectedResult?.restorationBonuses !== null && step.expectedResult) {
    appendIssues(
      issues,
      `${path}.expectedResult.restorationBonuses`,
      validateRestorationBonusSet(step.expectedResult.restorationBonuses),
    )
  }
  step.inventoryChange?.materialRequirements.forEach((requirement, index) =>
    validateMaterialRequirement(requirement, `${path}.inventoryChange.materialRequirements[${index}]`, issues),
  )
}

/**
 * Plan lifecycle metadata (`docs/DATA_MODEL.md` 11.1). The three fields must be
 * present on every Plan: a missing field is a record whose shape predates the
 * lifecycle, and it is never read as `null`.
 */
function validateProductionPlanLifecycle(
  plan: ProductionPlan,
  issues: DomainValidationIssue[],
) {
  const fields = ['abandonmentReason', 'abandonedAt', 'completedAt'] as const
  const missing = fields.filter((field) => plan[field] === undefined)
  if (missing.length > 0) {
    missing.forEach((field) =>
      addIssue(issues, field, 'invalid_structure', `ProductionPlan ${field} must be present (null or a value).`),
    )
    return
  }
  if (plan.abandonmentReason !== null && !(productionPlanAbandonmentReasons as readonly string[]).includes(plan.abandonmentReason)) {
    addIssue(issues, 'abandonmentReason', 'invalid_literal', 'ProductionPlan abandonmentReason is invalid.')
  }
  if (plan.abandonedAt !== null && !isNonEmptyString(plan.abandonedAt)) {
    addIssue(issues, 'abandonedAt', 'invalid_structure', 'abandonedAt must be an ISO date-time string.')
  }
  if (plan.completedAt !== null && !isNonEmptyString(plan.completedAt)) {
    addIssue(issues, 'completedAt', 'invalid_structure', 'completedAt must be an ISO date-time string.')
  }
  const abandoned = plan.status === 'abandoned'
  if (abandoned !== (plan.abandonmentReason !== null)) {
    addIssue(issues, 'abandonmentReason', 'invalid_state', 'abandonmentReason is non-null exactly for an abandoned Plan.')
  }
  if (abandoned !== (plan.abandonedAt !== null)) {
    addIssue(issues, 'abandonedAt', 'invalid_state', 'abandonedAt is non-null exactly for an abandoned Plan.')
  }
  if ((plan.status === 'completed') !== (plan.completedAt !== null)) {
    addIssue(issues, 'completedAt', 'invalid_state', 'completedAt is non-null exactly for a completed Plan.')
  }
}

/**
 * Step progression of a current Execution contract Plan
 * (`docs/PLANNER_SPEC.md` 16.1 / 16.2): Steps are confirmed one at a time in
 * order, so the completed Steps form a prefix and `currentStepId` is the first
 * incomplete Step while the Plan runs.
 */
function validateExecutionPlanProgression(
  plan: ProductionPlan,
  issues: DomainValidationIssue[],
) {
  const firstIncompleteIndex = plan.steps.findIndex(({ isCompleted }) => !isCompleted)
  const firstIncomplete = firstIncompleteIndex < 0 ? null : plan.steps[firstIncompleteIndex]
  if (firstIncompleteIndex >= 0 && plan.steps.slice(firstIncompleteIndex).some(({ isCompleted }) => isCompleted)) {
    addIssue(issues, 'steps', 'invalid_state', 'Completed PlanSteps must form a prefix of the Plan.')
  }
  switch (plan.status) {
    case 'draft':
      if (plan.steps.some(({ isCompleted }) => isCompleted)) {
        addIssue(issues, 'steps', 'invalid_state', 'A draft Plan has no completed PlanStep.')
      }
      if (plan.currentStepId !== (plan.steps[0]?.id ?? null)) {
        addIssue(issues, 'currentStepId', 'invalid_state', 'A draft Plan starts at its first PlanStep.')
      }
      break
    case 'active':
      if (firstIncomplete === null || plan.currentStepId !== firstIncomplete.id) {
        addIssue(issues, 'currentStepId', 'invalid_state', 'An active Plan is at its first incomplete PlanStep.')
      }
      break
    case 'completed':
      if (plan.currentStepId !== null || firstIncomplete !== null) {
        addIssue(issues, 'currentStepId', 'invalid_state', 'A completed Plan has every PlanStep completed and no current PlanStep.')
      }
      break
    case 'stale':
    case 'abandoned':
      if (plan.currentStepId !== null && plan.currentStepId !== firstIncomplete?.id) {
        addIssue(issues, 'currentStepId', 'invalid_state', 'currentStepId must be the first incomplete PlanStep.')
      }
      break
  }
}

const CONFLICT_KINDS: readonly unknown[] = [
  'same_gogma_counter',
  'same_skill_counter',
  'same_normal_counter',
  'same_owned_weapon_consumed',
]

const CONFLICT_REPAIR_OUTCOMES: readonly unknown[] = [
  'replaced',
  'rejected_by_scenario_composition',
  'not_found_within_search_extent',
  'stopped_by_search_extent_bound',
  'stopped_by_candidate_trial_bound',
  'stopped_by_planner_rerun_bound',
  'blocked_by_selected_checkpoint',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateConflictRepairLineageInto(
  value: unknown,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (!isPlainObject(value)) {
    addIssue(issues, path, 'invalid_structure', 'conflictRepairLineage must be null or an object.')
    return
  }
  if (!Array.isArray(value.decisions)) {
    addIssue(issues, `${path}.decisions`, 'invalid_structure', 'decisions must be an array.')
    return
  }
  value.decisions.forEach((decision: unknown, index) => {
    const decisionPath = `${path}.decisions[${index}]`
    if (!isPlainObject(decision)) {
      addIssue(issues, decisionPath, 'invalid_structure', 'A repair decision must be an object.')
      return
    }
    if (!CONFLICT_KINDS.includes(decision.conflictKind)) {
      addIssue(issues, `${decisionPath}.conflictKind`, 'invalid_literal', 'Repair decision conflictKind is invalid.')
    }
    validateId(decision.fixedBuildListEntryId as string | undefined, `${decisionPath}.fixedBuildListEntryId`, issues)
    validateId(decision.fixedTargetWeaponId as string | undefined, `${decisionPath}.fixedTargetWeaponId`, issues)
    if (!Array.isArray(decision.invalidatedRoutes)) {
      addIssue(issues, `${decisionPath}.invalidatedRoutes`, 'invalid_structure', 'invalidatedRoutes must be an array.')
      return
    }
    decision.invalidatedRoutes.forEach((record: unknown, recordIndex) => {
      const recordPath = `${decisionPath}.invalidatedRoutes[${recordIndex}]`
      if (!isPlainObject(record)) {
        addIssue(issues, recordPath, 'invalid_structure', 'An invalidated Route record must be an object.')
        return
      }
      validateId(record.targetWeaponId as string | undefined, `${recordPath}.targetWeaponId`, issues)
      validateId(
        record.invalidatedBuildListEntryId as string | undefined,
        `${recordPath}.invalidatedBuildListEntryId`,
        issues,
      )
      if (typeof record.invalidatedRouteKey !== 'string' || record.invalidatedRouteKey.length === 0) {
        addIssue(issues, `${recordPath}.invalidatedRouteKey`, 'invalid_structure', 'invalidatedRouteKey must be a non-empty string.')
      }
      if (record.replacementBuildListEntryId !== null) {
        validateId(
          record.replacementBuildListEntryId as string | undefined,
          `${recordPath}.replacementBuildListEntryId`,
          issues,
        )
      }
      if (!CONFLICT_REPAIR_OUTCOMES.includes(record.outcome)) {
        addIssue(issues, `${recordPath}.outcome`, 'invalid_literal', 'Repair outcome is invalid.')
      } else if ((record.outcome === 'replaced') !== (record.replacementBuildListEntryId !== null)) {
        addIssue(
          issues,
          `${recordPath}.replacementBuildListEntryId`,
          'invalid_state',
          'replacementBuildListEntryId is non-null exactly when the outcome is replaced.',
        )
      }
    })
  })
}

/**
 * The persisted structure of a repair lineage (`docs/DATA_MODEL.md` 11.1.1,
 * `docs/PLANNER_SPEC.md` 9.2.19.11): shapes, literals and ID forms only. Its
 * Entry and Target IDs are audit data and are never checked as current
 * foreign keys, whatever the Plan's status.
 */
export function validatePlannerConflictRepairLineage(
  lineage: PlannerConflictRepairLineage | null,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (lineage !== null) validateConflictRepairLineageInto(lineage, '', issues)
  return result(issues.map((issue) => ({ ...issue, path: issue.path.replace(/^\./, '') })))
}

/** Whether an array holds an object at every index; a hole is no object. */
function isArrayOfPlainObjects(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !isPlainObject(value[index])) return false
  }
  return true
}

function validateCalculationContextStructure(value: unknown, path: string, issues: DomainValidationIssue[]) {
  if (!isPlainObject(value)) {
    addIssue(issues, path, 'invalid_structure', 'CalculationContext must be an object.')
    return
  }
  for (const field of ['gameVersion', 'rngEngineVersion'] as const) {
    if (typeof value[field] !== 'string') {
      addIssue(issues, `${path}.${field}`, 'invalid_structure', `${field} must be a string.`)
    }
  }
}

/** An ExpectedPlanState holds hash strings only, so it is serializable for the chain comparison. */
function validateExpectedPlanStateStructure(value: unknown, path: string, issues: DomainValidationIssue[]) {
  if (!isPlainObject(value)) {
    addIssue(issues, path, 'invalid_structure', 'An expected state must be an object.')
    return
  }
  Object.keys(value).forEach((field) => {
    if (typeof value[field] !== 'string') {
      addIssue(issues, `${path}.${field}`, 'invalid_structure', 'An expected state holds hash strings only.')
    }
  })
}

function validateArrayOfObjectsStructure(value: unknown, path: string, issues: DomainValidationIssue[]) {
  if (!isArrayOfPlainObjects(value)) {
    addIssue(issues, path, 'invalid_structure', `${path} must be an array of objects.`)
  }
}

function validatePlanStepStructure(step: Record<string, unknown>, path: string, issues: DomainValidationIssue[]) {
  validateExpectedPlanStateStructure(step.expectedStateBefore, `${path}.expectedStateBefore`, issues)
  validateExpectedPlanStateStructure(step.expectedStateAfter, `${path}.expectedStateAfter`, issues)
  if (!isPlainObject(step.rngAdvance)) {
    addIssue(issues, `${path}.rngAdvance`, 'invalid_structure', 'rngAdvance must be an object.')
  }
  // A legacy Step carries no executionEffects; a present value is read below.
  const effects = step.executionEffects
  if (effects !== undefined && effects !== null) {
    if (!isPlainObject(effects)) {
      addIssue(issues, `${path}.executionEffects`, 'invalid_structure', 'executionEffects must be an object.')
    } else {
      for (const field of ['targetLinks', 'compromiseLabels', 'targetCompletions'] as const) {
        validateArrayOfObjectsStructure(effects[field], `${path}.executionEffects.${field}`, issues)
      }
      if (effects.observationBinding !== null && !isPlainObject(effects.observationBinding)) {
        addIssue(issues, `${path}.executionEffects.observationBinding`, 'invalid_structure', 'observationBinding must be null or an object.')
      }
    }
  }
  const inventoryChange = step.inventoryChange
  if (inventoryChange !== undefined && inventoryChange !== null) {
    if (!isPlainObject(inventoryChange)) {
      addIssue(issues, `${path}.inventoryChange`, 'invalid_structure', 'inventoryChange must be null or an object.')
    } else {
      validateArrayOfObjectsStructure(inventoryChange.materialRequirements, `${path}.inventoryChange.materialRequirements`, issues)
    }
  }
}

/**
 * The structure `validateProductionPlan()` reads before it can judge a Plan:
 * the containers it walks and the values it calls a method on. Every Plan the
 * application writes, of any calculation schema, has it, so it finds nothing
 * on any of them and the Plan validation runs exactly as before. A corrupted
 * body - read back from storage, an Import or the Plan inside a game save
 * point - is reported here with the path of what is wrong instead of letting a
 * TypeError escape from the validation.
 */
function validateProductionPlanStructure(plan: unknown, issues: DomainValidationIssue[]) {
  if (!isPlainObject(plan)) {
    addIssue(issues, '', 'invalid_structure', 'ProductionPlan must be an object.')
    return
  }
  validateCalculationContextStructure(plan.calculationContext, 'calculationContext', issues)
  const snapshot = plan.baseSnapshot
  if (!isPlainObject(snapshot)) {
    addIssue(issues, 'baseSnapshot', 'invalid_structure', 'baseSnapshot must be an object.')
  } else {
    validateCalculationContextStructure(snapshot.calculationContext, 'baseSnapshot.calculationContext', issues)
    validateExpectedPlanStateStructure(snapshot.initialExecutionState, 'baseSnapshot.initialExecutionState', issues)
  }
  if (!isArrayOfPlainObjects(plan.steps)) {
    addIssue(issues, 'steps', 'invalid_structure', 'steps must be an array of PlanStep objects.')
  } else {
    plan.steps.forEach((step, index) => validatePlanStepStructure(step, `steps[${index}]`, issues))
  }
  validateArrayOfObjectsStructure(plan.requiredMaterials, 'requiredMaterials', issues)
  if (!isArrayOfPlainObjects(plan.conflicts)) {
    addIssue(issues, 'conflicts', 'invalid_structure', 'conflicts must be an array of objects.')
  } else {
    plan.conflicts.forEach((conflict, index) => {
      if (!Array.isArray(conflict.buildListEntryIds)) {
        addIssue(issues, `conflicts[${index}].buildListEntryIds`, 'invalid_structure', 'buildListEntryIds must be an array.')
      }
    })
  }
  if (!Array.isArray(plan.selectedBuildListEntryIds)) {
    addIssue(issues, 'selectedBuildListEntryIds', 'invalid_structure', 'selectedBuildListEntryIds must be an array.')
  }
  validateArrayOfObjectsStructure(plan.rejectedBuildListEntries, 'rejectedBuildListEntries', issues)
}

export function validateProductionPlan(
  plan: ProductionPlan,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  // Nothing below is safe to read from a body without this structure.
  validateProductionPlanStructure(plan, issues)
  if (issues.length > 0) return result(issues)
  validateId(plan.id, 'id', issues)
  if (!['draft', 'active', 'completed', 'stale', 'abandoned'].includes(plan.status)) {
    addIssue(issues, 'status', 'invalid_literal', 'ProductionPlan status is invalid.')
  }
  validateCalculationContext(plan.calculationContext, 'calculationContext', issues)
  validateCalculationContext(plan.baseSnapshot.calculationContext, 'baseSnapshot.calculationContext', issues)
  if (!isCalculationContextCompatible(plan.calculationContext, plan.baseSnapshot.calculationContext)) {
    addIssue(issues, 'baseSnapshot.calculationContext', 'inconsistent_snapshot', 'Plan and base snapshot CalculationContext must match.')
  }
  // A Plan of an earlier calculation schema keeps its exact persisted shape and
  // is failed closed at the CalculationContext boundary; the current contract
  // is required only of a Plan that claims it, never inferred for a legacy one.
  const executionContract = isExecutionContractProductionPlan(plan)
  validateExpectedPlanState(plan.baseSnapshot.initialExecutionState, 'baseSnapshot.initialExecutionState', issues, executionContract)
  validateId(plan.baseSnapshot.targetWeaponsHash, 'baseSnapshot.targetWeaponsHash', issues)
  validateId(plan.baseSnapshot.buildListEntriesHash, 'baseSnapshot.buildListEntriesHash', issues)
  if (executionContract || plan.baseSnapshot.dependentTargetDefinitionsHash !== undefined) {
    validateId(plan.baseSnapshot.dependentTargetDefinitionsHash, 'baseSnapshot.dependentTargetDefinitionsHash', issues)
  }
  if (executionContract || plan.baseSnapshot.dependentBuildListEntriesHash !== undefined) {
    validateId(plan.baseSnapshot.dependentBuildListEntriesHash, 'baseSnapshot.dependentBuildListEntriesHash', issues)
  }
  validateProductionPlanLifecycle(plan, issues)
  // Every persisted Plan carries the field since Dexie v10 / Export 13, a
  // legacy one as `null`; a missing field is no Plan of the current shape.
  if (plan.conflictRepairLineage !== null) {
    validateConflictRepairLineageInto(plan.conflictRepairLineage, 'conflictRepairLineage', issues)
  }
  plan.steps.forEach((step, index) => validatePlanStep(step, index + 1, issues, executionContract))
  if (executionContract) {
    validateExecutionPlanProgression(plan, issues)
    if (plan.steps.length > 0 && !firstStepStartsFromPlanStart(plan)) {
      addIssue(
        issues,
        'steps[0].expectedStateBefore',
        'inconsistent_snapshot',
        isPlanStartEffectProductionPlan(plan)
          ? 'The first PlanStep may differ from PlanningInputSnapshot.initialExecutionState only by the Plan start Target links.'
          : 'The first PlanStep must start at PlanningInputSnapshot.initialExecutionState.',
      )
    }
    for (let index = 0; index + 1 < plan.steps.length; index += 1) {
      if (!sameExpectedPlanState(plan.steps[index].expectedStateAfter, plan.steps[index + 1].expectedStateBefore)) {
        addIssue(issues, `steps[${index + 1}].expectedStateBefore`, 'inconsistent_snapshot', 'The PlanStep expected-state chain is broken.')
      }
    }
    const completedEntries = plan.steps.flatMap((step) =>
      step.executionEffects?.targetCompletions.map(({ buildListEntryId }) => buildListEntryId) ?? [],
    )
    if (new Set(completedEntries).size !== completedEntries.length) {
      addIssue(issues, 'steps', 'invalid_state', 'A BuildListEntry completes its Target at most once.')
    }
    if (isCompletionWeaponUniquenessProductionPlan(plan)) {
      const completedWeapons = plan.steps.flatMap((step) =>
        step.executionEffects?.targetCompletions.map(({ ownedWeaponId }) => ownedWeaponId) ?? [],
      )
      if (new Set(completedWeapons).size !== completedWeapons.length) {
        addIssue(issues, 'steps', 'invalid_state', 'An OwnedWeapon completes at most one Target in a Plan.')
      }
    }
    const productionTargets = plan.steps.flatMap((step) =>
      step.executionEffects?.registersTrackedWeapon === true && step.executionEffects.trackedOwnedWeaponId !== null
        ? [step.executionEffects.trackedOwnedWeaponId]
        : [],
    )
    if (new Set(productionTargets).size !== productionTargets.length) {
      addIssue(issues, 'steps', 'invalid_state', 'An OwnedWeapon is registered at most once.')
    }
  }
  if (new Set(plan.steps.map(({ id }) => id)).size !== plan.steps.length) {
    addIssue(issues, 'steps', 'invalid_id', 'PlanStep IDs must be unique within a plan.')
  }
  if (plan.currentStepId !== null) {
    const current = plan.steps.find(({ id }) => id === plan.currentStepId)
    if (!current || current.isCompleted) {
      addIssue(issues, 'currentStepId', 'invalid_reference', 'currentStepId must reference an incomplete PlanStep.')
    }
  }
  plan.requiredMaterials.forEach((requirement, index) =>
    validateMaterialRequirement(requirement, `requiredMaterials[${index}]`, issues),
  )
  plan.conflicts.forEach((conflict, index) => {
    validateId(conflict.id, `conflicts[${index}].id`, issues)
    conflict.buildListEntryIds.forEach((id, idIndex) =>
      validateId(id, `conflicts[${index}].buildListEntryIds[${idIndex}]`, issues),
    )
  })
  validateRejectedBuildListEntries(plan, issues)
  return result(issues)
}

/**
 * The rejected Build List records (`docs/DATA_MODEL.md` 11.9). The Issue #121
 * fields are checked only where present - a record without them is one saved
 * before they existed, accepted as it is and never completed here: a
 * `targetWeaponId` has the ID form (it is a record, never a current foreign
 * key), a `resourceConflictCause` is a known literal on a `resource_conflict`
 * record only, and `explicit_resolution_not_selected` matches the Plan's own
 * decided Conflicts both ways - a Conflict naming the Entry as a participant
 * selected another participant the Plan selects. The provisional and stuck
 * drop causes leave no runtime evidence in the Plan, so only their structure
 * is checked.
 */
function validateRejectedBuildListEntries(
  plan: ProductionPlan,
  issues: DomainValidationIssue[],
) {
  const selected = new Set<BuildListEntryId>(plan.selectedBuildListEntryIds)
  const explicitlyNotSelected = (entryId: BuildListEntryId) =>
    plan.conflicts.some((conflict) =>
      conflict.buildListEntryIds.includes(entryId) &&
      conflict.selectedBuildListEntryId !== null &&
      conflict.selectedBuildListEntryId !== entryId &&
      selected.has(conflict.selectedBuildListEntryId),
    )
  plan.rejectedBuildListEntries.forEach((entry, index) => {
    const path = `rejectedBuildListEntries[${index}]`
    validateId(entry.buildListEntryId, `${path}.buildListEntryId`, issues)
    if (entry.targetWeaponId !== undefined) {
      validateId(entry.targetWeaponId, `${path}.targetWeaponId`, issues)
    }
    const cause: unknown = entry.resourceConflictCause
    if (cause === undefined) return
    if (!(rejectedBuildListEntryResourceConflictCauses as readonly unknown[]).includes(cause)) {
      addIssue(issues, `${path}.resourceConflictCause`, 'invalid_literal', 'resourceConflictCause is invalid.')
      return
    }
    if (entry.reason !== 'resource_conflict') {
      addIssue(issues, `${path}.resourceConflictCause`, 'invalid_state', 'Only a resource_conflict record carries a resourceConflictCause.')
      return
    }
    const explicit = explicitlyNotSelected(entry.buildListEntryId)
    if (cause === 'explicit_resolution_not_selected' && !explicit) {
      addIssue(issues, `${path}.resourceConflictCause`, 'invalid_state', 'explicit_resolution_not_selected needs a Conflict of this Entry that selected another participant the Plan selects.')
    } else if (cause !== 'explicit_resolution_not_selected' && explicit) {
      addIssue(issues, `${path}.resourceConflictCause`, 'invalid_state', 'A resource_conflict record of an Entry another selected participant of its decided Conflict won is explicit_resolution_not_selected.')
    }
  })
}

function validateActualResult(
  actual: ActualResult,
  path: string,
  issues: DomainValidationIssue[],
) {
  if (actual.restorationBonuses !== null) {
    appendIssues(issues, `${path}.restorationBonuses`, validateRestorationBonusSet(actual.restorationBonuses))
  }
  if (actual.restorationBonusScope !== null) {
    validateRestorationBonusScope(actual.restorationBonusScope, `${path}.restorationBonusScope`, issues)
  }
  // The five slots and their scope are one observation: both null or both present.
  if ((actual.restorationBonuses !== null) !== (actual.restorationBonusScope !== null)) {
    addIssue(issues, `${path}.restorationBonusScope`, 'invalid_state', 'restorationBonuses and restorationBonusScope must both be null or both be present.')
  }
  if (actual.seriesSkillId !== null) {
    validateId(actual.seriesSkillId, `${path}.seriesSkillId`, issues)
  }
  if (actual.groupSkillId !== null) {
    validateId(actual.groupSkillId, `${path}.groupSkillId`, issues)
  }
  if (actual.securedOwnedWeaponId !== null) {
    validateId(actual.securedOwnedWeaponId, `${path}.securedOwnedWeaponId`, issues)
  }
  if (actual.note !== null && typeof actual.note !== 'string') {
    addIssue(issues, `${path}.note`, 'invalid_structure', 'note must be null or a string.')
  }
}

/**
 * The record shape each current Execution action fixes
 * (`docs/DATA_MODEL.md` 12, `docs/PLANNER_SPEC.md` 16.4 / 16.15).
 *
 * The legacy actions and `finished_as_compromise` keep only the generic checks,
 * exactly as `docs/DATA_MODEL.md` 12 specifies. The compromise finish runtime
 * records `wasExpected = true`, `recalculationReason = null` and
 * `actualResult = null` - an explicit user decision abandons the Plan rather
 * than staling it - but that shape is the runtime's, not an additional
 * validation contract.
 */
function validateExecutionActionRecordFields(
  history: Pick<ExecutionHistory, 'action' | 'wasExpected' | 'recalculationReason' | 'actualResult'>,
  issues: DomainValidationIssue[],
) {
  switch (history.action) {
    case 'confirmed_expected':
      if (!history.wasExpected) {
        addIssue(issues, 'wasExpected', 'invalid_state', 'confirmed_expected is an expected result.')
      }
      if (history.recalculationReason !== null) {
        addIssue(issues, 'recalculationReason', 'invalid_state', 'confirmed_expected has no recalculation reason.')
      }
      break
    case 'actual_result_different':
      if (history.wasExpected) {
        addIssue(issues, 'wasExpected', 'invalid_state', 'actual_result_different is not an expected result.')
      }
      if (history.recalculationReason !== 'unexpected_result') {
        addIssue(issues, 'recalculationReason', 'invalid_state', 'actual_result_different records unexpected_result.')
      }
      if (history.actualResult === null) {
        addIssue(issues, 'actualResult', 'invalid_state', 'actual_result_different records the actual result.')
      } else if (history.actualResult.securedOwnedWeaponId !== null) {
        addIssue(issues, 'actualResult.securedOwnedWeaponId', 'invalid_state', 'A current actual result secures no weapon.')
      }
      break
    case 'operation_uncertain':
      if (history.wasExpected) {
        addIssue(issues, 'wasExpected', 'invalid_state', 'operation_uncertain is not an expected result.')
      }
      if (history.recalculationReason !== 'execution_operation_uncertain') {
        addIssue(issues, 'recalculationReason', 'invalid_state', 'operation_uncertain records execution_operation_uncertain.')
      }
      if (history.actualResult !== null) {
        addIssue(issues, 'actualResult', 'invalid_state', 'operation_uncertain records no actual result.')
      }
      break
    case 'operation_count_recovered':
      if (!history.wasExpected) {
        addIssue(issues, 'wasExpected', 'invalid_state', 'operation_count_recovered follows the Plan as expected.')
      }
      if (history.recalculationReason !== null) {
        addIssue(issues, 'recalculationReason', 'invalid_state', 'operation_count_recovered has no recalculation reason.')
      }
      if (history.actualResult === null) {
        addIssue(issues, 'actualResult', 'invalid_state', 'operation_count_recovered records the last observed game result.')
      } else {
        if (history.actualResult.securedOwnedWeaponId !== null) {
          addIssue(issues, 'actualResult.securedOwnedWeaponId', 'invalid_state', 'A current actual result secures no weapon.')
        }
        // One observation: the five slots with their scope, or the Skill pair.
        if (
          history.actualResult.restorationBonuses !== null &&
          (history.actualResult.seriesSkillId !== null || history.actualResult.groupSkillId !== null)
        ) {
          addIssue(issues, 'actualResult', 'invalid_state', 'operation_count_recovered observes either five slots or Skills, not both.')
        }
      }
      break
    case 'executed_on_alternate_weapon':
      if (!history.wasExpected) {
        addIssue(issues, 'wasExpected', 'invalid_state', 'executed_on_alternate_weapon advances the Counter as expected.')
      }
      if (history.recalculationReason !== null) {
        addIssue(issues, 'recalculationReason', 'invalid_state', 'executed_on_alternate_weapon has no recalculation reason.')
      }
      if (history.actualResult === null) {
        addIssue(issues, 'actualResult', 'invalid_state', 'executed_on_alternate_weapon records the Skills the tracked weapon kept.')
      } else {
        if (history.actualResult.restorationBonuses !== null || history.actualResult.restorationBonusScope !== null) {
          addIssue(issues, 'actualResult.restorationBonuses', 'invalid_state', 'executed_on_alternate_weapon records no five slots.')
        }
        if (history.actualResult.securedOwnedWeaponId !== null) {
          addIssue(issues, 'actualResult.securedOwnedWeaponId', 'invalid_state', 'A current actual result secures no weapon.')
        }
      }
      break
    default:
      break
  }
}

/**
 * The OwnedWeapon / TargetWeapon collections of one record that an action's
 * record shape constrains, as one stored part holds them: the
 * `docs/DATA_MODEL.md` 12.2 metadata holds the added weapons and its Undo body
 * the rest.
 */
interface ExecutionActionEntitySets {
  changedEntities: readonly (readonly unknown[])[]
  changedEntitiesPath: string
  removedOwnedWeapons: readonly unknown[] | null
  removedOwnedWeaponsPath: string
}

function validateExecutionActionEntitySets(
  action: ExecutionHistory['action'],
  sets: ExecutionActionEntitySets,
  issues: DomainValidationIssue[],
) {
  switch (action) {
    case 'operation_uncertain':
    case 'executed_on_alternate_weapon':
      if (sets.changedEntities.some((entities) => entities.length > 0)) {
        addIssue(issues, sets.changedEntitiesPath, 'invalid_state', `${action} changes no OwnedWeapon or TargetWeapon.`)
      }
      break
    case 'operation_count_recovered':
      if (sets.removedOwnedWeapons !== null && sets.removedOwnedWeapons.length > 0) {
        addIssue(issues, sets.removedOwnedWeaponsPath, 'invalid_state', 'operation_count_recovered removes no OwnedWeapon.')
      }
      break
    default:
      break
  }
}

/**
 * Validates each entity of a snapshot array with its own validator. An element
 * that is not an object (a hole included) is reported as it is, never read as
 * an entity.
 */
function appendEntityIssues<T>(
  issues: DomainValidationIssue[],
  path: string,
  entities: readonly T[],
  validate: (entity: T) => DomainValidationResult,
) {
  for (let index = 0; index < entities.length; index += 1) {
    const entity: unknown = entities[index]
    if (!Object.prototype.hasOwnProperty.call(entities, index) || !isPlainObject(entity)) {
      addIssue(issues, `${path}[${index}]`, 'invalid_structure', 'A snapshot entity must be an object.')
      continue
    }
    appendIssues(issues, `${path}[${index}]`, validate(entity as T))
  }
}

/** The IDs of the entities of a snapshot array that are objects. */
function entityIds(entities: readonly unknown[]): unknown[] {
  return entities.filter(isPlainObject).map(({ id }) => id)
}

const STABLE_VALUE_HASH_PATTERN = /^fnv1a32:[0-9a-f]{8}$/

function validateStableValueHash(value: unknown, path: string, issues: DomainValidationIssue[]) {
  if (typeof value !== 'string' || !STABLE_VALUE_HASH_PATTERN.test(value)) {
    addIssue(issues, path, 'invalid_structure', 'A Plan undo hash must be a hashStableValue() result.')
  }
}

function validateNullableDateTime(value: unknown, path: string, issues: DomainValidationIssue[]) {
  if (value !== null && !isNonEmptyString(value)) {
    addIssue(issues, path, 'invalid_structure', `${path} must be null or an ISO date-time string.`)
  }
}

/**
 * Structural validation of the Plan state a record keeps for its Undo
 * (`docs/DATA_MODEL.md` 12.2): the two hash forms, the seven execution fields
 * with their literals and date-times, and the changed Steps without a repeated
 * Step. Whether the hashes match a Plan, and whether the changed Steps are
 * Steps of it in Plan order, is the Undo's reconstruction
 * (`reconstructProductionPlanFromUndoState()`), never this validation.
 */
export function validateProductionPlanUndoState(
  state: ProductionPlanUndoState,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!isPlainObject(state)) {
    addIssue(issues, '', 'invalid_structure', 'A Plan undo state must be an object.')
    return result(issues)
  }
  validateStableValueHash(state.planContentHash, 'planContentHash', issues)
  validateStableValueHash(state.executionStateHash, 'executionStateHash', issues)
  const plan: unknown = state.plan
  if (!isPlainObject(plan)) {
    addIssue(issues, 'plan', 'invalid_structure', 'The Plan execution fields must be an object.')
  } else {
    if (!['draft', 'active', 'completed', 'stale', 'abandoned'].includes(plan.status as string)) {
      addIssue(issues, 'plan.status', 'invalid_literal', 'ProductionPlan status is invalid.')
    }
    if (plan.currentStepId !== null) validateId(plan.currentStepId as string, 'plan.currentStepId', issues)
    if (!Array.isArray(plan.recalculationReasons) || plan.recalculationReasons.some((reason) => !isNonEmptyString(reason))) {
      addIssue(issues, 'plan.recalculationReasons', 'invalid_structure', 'recalculationReasons must be an array of reasons.')
    }
    if (plan.abandonmentReason !== null && !(productionPlanAbandonmentReasons as readonly unknown[]).includes(plan.abandonmentReason)) {
      addIssue(issues, 'plan.abandonmentReason', 'invalid_literal', 'ProductionPlan abandonmentReason is invalid.')
    }
    validateNullableDateTime(plan.abandonedAt, 'plan.abandonedAt', issues)
    validateNullableDateTime(plan.completedAt, 'plan.completedAt', issues)
    if (!isNonEmptyString(plan.updatedAt)) {
      addIssue(issues, 'plan.updatedAt', 'invalid_structure', 'plan.updatedAt must be an ISO date-time string.')
    }
  }
  const changedSteps: unknown = state.changedSteps
  if (!Array.isArray(changedSteps)) {
    addIssue(issues, 'changedSteps', 'invalid_structure', 'changedSteps must be an array.')
    return result(issues)
  }
  const seen = new Set<unknown>()
  changedSteps.forEach((step: unknown, index) => {
    const path = `changedSteps[${index}]`
    if (!isPlainObject(step)) {
      addIssue(issues, path, 'invalid_structure', 'A changed PlanStep must be an object.')
      return
    }
    validateId(step.stepId as string, `${path}.stepId`, issues)
    if (typeof step.isCompleted !== 'boolean') {
      addIssue(issues, `${path}.isCompleted`, 'invalid_structure', 'isCompleted must be a boolean.')
    }
    validateNullableDateTime(step.completedAt, `${path}.completedAt`, issues)
    if (seen.has(step.stepId)) {
      addIssue(issues, `${path}.stepId`, 'invalid_id', 'changedSteps must not repeat a PlanStep.')
    }
    seen.add(step.stepId)
  })
  return result(issues)
}

/**
 * Validation of one `docs/DATA_MODEL.md` 12.2 metadata record on its own, with
 * no Undo body: the IDs, the action literal and its record shape, the
 * date-time, the actual result, and the added OwnedWeapon IDs. A record of the
 * Dexie version 10 shape (`LegacyExecutionHistory`) - holding an
 * `undoSnapshot`, or no `addedOwnedWeaponIds` - fails it, which is how a record
 * the version 11 upgrade could not convert is told apart without reading any
 * Undo body (`docs/DATA_MODEL.md` 14.2).
 */
export function validateExecutionHistory(
  history: ExecutionHistory,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!isPlainObject(history)) {
    addIssue(issues, '', 'invalid_structure', 'ExecutionHistory metadata must be an object.')
    return result(issues)
  }
  if ('undoSnapshot' in history) {
    addIssue(issues, 'undoSnapshot', 'invalid_structure', 'ExecutionHistory metadata holds no undoSnapshot.')
  }
  validateId(history.id, 'id', issues)
  validateId(history.planId, 'planId', issues)
  validateId(history.planStepId, 'planStepId', issues)
  const actions: readonly string[] = [...currentExecutionActions, ...legacyExecutionActions]
  if (!actions.includes(history.action)) {
    addIssue(issues, 'action', 'invalid_literal', 'Execution action is invalid.')
  }
  if (!isNonEmptyString(history.createdAt)) {
    addIssue(issues, 'createdAt', 'invalid_structure', 'createdAt must be an ISO date-time string.')
  }
  if (typeof history.wasExpected !== 'boolean') {
    addIssue(issues, 'wasExpected', 'invalid_structure', 'wasExpected must be a boolean.')
  }
  if (history.recalculationReason !== null && !isNonEmptyString(history.recalculationReason)) {
    addIssue(issues, 'recalculationReason', 'invalid_structure', 'recalculationReason must be null or a reason.')
  }
  if (history.actualResult !== null) {
    if (!isPlainObject(history.actualResult)) {
      addIssue(issues, 'actualResult', 'invalid_structure', 'actualResult must be null or an object.')
    } else {
      validateActualResult(history.actualResult, 'actualResult', issues)
    }
  }
  if (!Array.isArray(history.addedOwnedWeaponIds)) {
    addIssue(issues, 'addedOwnedWeaponIds', 'invalid_structure', 'addedOwnedWeaponIds must be an array.')
    return result(issues)
  }
  for (let index = 0; index < history.addedOwnedWeaponIds.length; index += 1) {
    // A hole is no ID and is reported like one.
    validateId(history.addedOwnedWeaponIds[index], `addedOwnedWeaponIds[${index}]`, issues)
  }
  if (new Set(history.addedOwnedWeaponIds).size !== history.addedOwnedWeaponIds.length) {
    addIssue(issues, 'addedOwnedWeaponIds', 'invalid_id', 'Undo OwnedWeapon IDs must be unique within their role.')
  }
  if (history.actualResult === null || isPlainObject(history.actualResult)) {
    validateExecutionActionRecordFields(history, issues)
  }
  validateExecutionActionEntitySets(history.action, {
    changedEntities: [history.addedOwnedWeaponIds],
    changedEntitiesPath: 'addedOwnedWeaponIds',
    removedOwnedWeapons: null,
    removedOwnedWeaponsPath: '',
  }, issues)
  if (!history.wasExpected && history.recalculationReason === null) {
    addIssue(issues, 'recalculationReason', 'invalid_state', 'Unexpected execution requires a recalculation reason.')
  }
  return result(issues)
}

/**
 * Validation of one `docs/DATA_MODEL.md` 12.2 Undo body on its own: the
 * entities it restores, the Plan undo state and the deleted game save point,
 * and that it holds no ProductionPlan body of its own.
 */
/**
 * How the Target bodies an Execution record or a save point carries are
 * validated. The default is the current `validateTargetWeapon()`; only the
 * ExecutionHistory conversion of legacy data (Dexie version(11), Export schema
 * 13 -> 14), whose bodies are still the legacy shape the next migration step
 * converts, passes `validateLegacyTargetWeapon()`.
 */
export interface TargetBodyValidationOptions {
  validateTargetBody?: (target: TargetWeapon) => DomainValidationResult
}

export function validateExecutionUndoSnapshot(
  snapshot: ExecutionUndoSnapshot,
  options: TargetBodyValidationOptions = {},
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (!isPlainObject(snapshot)) {
    addIssue(issues, '', 'invalid_structure', 'ExecutionUndoSnapshot must be an object.')
    return result(issues)
  }
  if ('productionPlanBefore' in snapshot || 'executionSavePointBefore' in snapshot) {
    addIssue(issues, '', 'invalid_structure', 'An ExecutionUndoSnapshot of this shape holds no Plan or save point before the Step.')
  }
  validateId(snapshot.executionHistoryId, 'executionHistoryId', issues)
  if (
    !Array.isArray(snapshot.normalCountersBefore) ||
    !Array.isArray(snapshot.affectedOwnedWeaponsBefore) ||
    !Array.isArray(snapshot.removedOwnedWeaponsBefore) ||
    !Array.isArray(snapshot.affectedTargetWeaponsBefore) ||
    !isPlainObject(snapshot.rngStateBefore) ||
    !isPlainObject(snapshot.productionPlanStateBefore) ||
    (snapshot.deletedExecutionSavePoint !== null && !isPlainObject(snapshot.deletedExecutionSavePoint))
  ) {
    addIssue(issues, '', 'invalid_structure', 'ExecutionUndoSnapshot is incomplete.')
    return result(issues)
  }
  appendIssues(issues, 'rngStateBefore', validateRngState(snapshot.rngStateBefore))
  appendEntityIssues(issues, 'normalCountersBefore', snapshot.normalCountersBefore, validateNormalArtianCounter)
  appendEntityIssues(issues, 'affectedOwnedWeaponsBefore', snapshot.affectedOwnedWeaponsBefore, validateOwnedWeapon)
  appendEntityIssues(issues, 'removedOwnedWeaponsBefore', snapshot.removedOwnedWeaponsBefore, validateOwnedWeapon)
  appendEntityIssues(issues, 'affectedTargetWeaponsBefore', snapshot.affectedTargetWeaponsBefore, options.validateTargetBody ?? validateTargetWeapon)
  const hasDuplicates = (ids: readonly unknown[]) => new Set(ids).size !== ids.length
  if (
    hasDuplicates(entityIds(snapshot.affectedOwnedWeaponsBefore)) ||
    hasDuplicates(entityIds(snapshot.removedOwnedWeaponsBefore))
  ) {
    addIssue(issues, '', 'invalid_id', 'Undo OwnedWeapon IDs must be unique within their role.')
  }
  if (hasDuplicates(entityIds(snapshot.affectedTargetWeaponsBefore))) {
    addIssue(issues, 'affectedTargetWeaponsBefore', 'invalid_id', 'Undo TargetWeapon IDs must be unique.')
  }
  appendIssues(issues, 'productionPlanStateBefore', validateProductionPlanUndoState(snapshot.productionPlanStateBefore))
  if (snapshot.deletedExecutionSavePoint !== null) {
    appendIssues(issues, 'deletedExecutionSavePoint', validateExecutionSavePoint(snapshot.deletedExecutionSavePoint, options))
  }
  return result(issues)
}

/**
 * Validation of one `docs/DATA_MODEL.md` 12.2 record - its metadata and its
 * Undo body together: each on its own, the body belonging to the metadata,
 * a deleted save point of the record's own Plan, the action record shape
 * across both (`operation_uncertain` changes no entity, `operation_count_recovered`
 * removes none), and the three OwnedWeapon roles never overlapping. Metadata
 * issues are reported under `executionHistory`, body issues under
 * `executionUndoSnapshot`.
 */
export function validateExecutionRecord(
  history: ExecutionHistory,
  snapshot: ExecutionUndoSnapshot,
  options: TargetBodyValidationOptions = {},
): DomainValidationResult {
  const metadata = validateExecutionHistory(history)
  const body = validateExecutionUndoSnapshot(snapshot, options)
  const issues: DomainValidationIssue[] = []
  appendIssues(issues, 'executionHistory', metadata)
  appendIssues(issues, 'executionUndoSnapshot', body)
  if (!isPlainObject(history) || !isPlainObject(snapshot)) return result(issues)
  if (snapshot.executionHistoryId !== history.id) {
    addIssue(issues, 'executionUndoSnapshot.executionHistoryId', 'inconsistent_snapshot', 'The Undo body must belong to the ExecutionHistory.')
  }
  const savePoint: unknown = snapshot.deletedExecutionSavePoint
  if (isPlainObject(savePoint) && savePoint.productionPlanId !== history.planId) {
    addIssue(issues, 'executionUndoSnapshot.deletedExecutionSavePoint.productionPlanId', 'inconsistent_snapshot', 'The deleted save point must belong to the history Plan.')
  }
  if (
    !Array.isArray(history.addedOwnedWeaponIds) ||
    !Array.isArray(snapshot.affectedOwnedWeaponsBefore) ||
    !Array.isArray(snapshot.removedOwnedWeaponsBefore) ||
    !Array.isArray(snapshot.affectedTargetWeaponsBefore)
  ) {
    return result(issues)
  }
  validateExecutionActionEntitySets(history.action, {
    changedEntities: [snapshot.affectedOwnedWeaponsBefore, snapshot.removedOwnedWeaponsBefore, snapshot.affectedTargetWeaponsBefore],
    changedEntitiesPath: 'executionUndoSnapshot',
    removedOwnedWeapons: snapshot.removedOwnedWeaponsBefore,
    removedOwnedWeaponsPath: 'executionUndoSnapshot.removedOwnedWeaponsBefore',
  }, issues)
  const affected = new Set(entityIds(snapshot.affectedOwnedWeaponsBefore))
  const added = new Set<unknown>(history.addedOwnedWeaponIds)
  const removed = new Set(entityIds(snapshot.removedOwnedWeaponsBefore))
  const overlaps = [...affected].some((id) => added.has(id) || removed.has(id)) || [...added].some((id) => removed.has(id))
  if (overlaps) {
    addIssue(issues, '', 'invalid_state', 'Undo OwnedWeapon roles must not overlap.')
  }
  return result(issues)
}

/**
 * Collection validation of `docs/DATA_MODEL.md` 12.2 records against their
 * Plans: every metadata record has exactly one Undo body and every Undo body
 * exactly one metadata record (no repeated ID on either side), each changed
 * Step is a Step of the record's Plan in Plan order, and a Plan has at most one
 * record holding a deleted save point. Each record on its own is
 * `validateExecutionRecord()`; this checks only how they relate.
 */
export function validateExecutionHistoryReferences(
  histories: readonly ExecutionHistory[],
  snapshots: readonly ExecutionUndoSnapshot[],
  productionPlans: readonly Pick<ProductionPlan, 'id' | 'steps'>[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const historyById = new Map<string, ExecutionHistory>()
  histories.forEach((history, index) => {
    if (!isPlainObject(history)) {
      addIssue(issues, `executionHistory[${index}]`, 'invalid_structure', 'ExecutionHistory metadata must be an object.')
      return
    }
    if (historyById.has(history.id)) {
      addIssue(issues, `executionHistory[${index}].id`, 'invalid_id', 'ExecutionHistory IDs must be unique.')
    }
    historyById.set(history.id, history)
  })
  const snapshotIds = new Set<string>()
  const savePointRecordPlans = new Set<string>()
  const stepOrderByPlan = new Map<string, Map<string, number>>()
  const stepOrderOf = (plan: Pick<ProductionPlan, 'id' | 'steps'>) => {
    let order = stepOrderByPlan.get(plan.id)
    if (!order) {
      order = new Map(plan.steps.map(({ id }, index) => [id, index]))
      stepOrderByPlan.set(plan.id, order)
    }
    return order
  }
  const planById = new Map(productionPlans.map((plan) => [plan.id, plan]))
  snapshots.forEach((snapshot, index) => {
    const path = `executionUndoSnapshots[${index}]`
    if (!isPlainObject(snapshot)) {
      addIssue(issues, path, 'invalid_structure', 'ExecutionUndoSnapshot must be an object.')
      return
    }
    if (snapshotIds.has(snapshot.executionHistoryId)) {
      addIssue(issues, `${path}.executionHistoryId`, 'invalid_id', 'An ExecutionHistory has at most one Undo body.')
      return
    }
    snapshotIds.add(snapshot.executionHistoryId)
    const history = historyById.get(snapshot.executionHistoryId)
    if (!history) {
      addIssue(issues, `${path}.executionHistoryId`, 'invalid_reference', 'An Undo body must belong to an existing ExecutionHistory.')
      return
    }
    if (snapshot.deletedExecutionSavePoint !== null) {
      if (savePointRecordPlans.has(history.planId)) {
        addIssue(issues, `${path}.deletedExecutionSavePoint`, 'invalid_state', 'A ProductionPlan has at most one record holding a deleted save point.')
      }
      savePointRecordPlans.add(history.planId)
    }
    const plan = planById.get(history.planId)
    if (!plan) {
      addIssue(issues, `${path}.executionHistoryId`, 'invalid_reference', 'The ExecutionHistory Plan must exist.')
      return
    }
    const changedSteps: unknown = snapshot.productionPlanStateBefore?.changedSteps
    if (!Array.isArray(changedSteps)) return
    const order = stepOrderOf(plan)
    let previous = -1
    changedSteps.forEach((step: unknown, stepIndex: number) => {
      // A changed Step that is not an object is the record validation's issue.
      if (!isPlainObject(step)) return
      const at = order.get(step.stepId as ProductionPlanUndoState['changedSteps'][number]['stepId'])
      if (at === undefined) {
        addIssue(issues, `${path}.productionPlanStateBefore.changedSteps[${stepIndex}].stepId`, 'invalid_reference', 'A changed PlanStep must be a PlanStep of the record Plan.')
        return
      }
      if (at <= previous) {
        addIssue(issues, `${path}.productionPlanStateBefore.changedSteps[${stepIndex}].stepId`, 'invalid_state', 'changedSteps must follow the Plan order.')
      }
      previous = at
    })
  })
  histories.forEach((history, index) => {
    if (isPlainObject(history) && !snapshotIds.has(history.id)) {
      addIssue(issues, `executionHistory[${index}].id`, 'invalid_reference', 'An ExecutionHistory must have its Undo body.')
    }
  })
  return result(issues)
}

/** Runs one validation over untrusted structure, reporting a throw as an issue at `path`. */
function containedIssues(path: string, validate: () => DomainValidationIssue[]): DomainValidationIssue[] {
  try {
    return validate()
  } catch {
    return [{ path, code: 'invalid_structure', message: `${path} has a malformed nested structure.` }]
  }
}

function prefixedIssues(prefix: string, nested: DomainValidationResult): DomainValidationIssue[] {
  return nested.issues.map((issue) => ({ ...issue, path: issue.path ? `${prefix}.${issue.path}` : prefix }))
}

/**
 * Validation of a whole ExecutionHistory record collection (`docs/DATA_MODEL.md`
 * 12.2 / 14.6 / 15.2): each metadata record and each Undo body on its own,
 * each pair together (`validateExecutionRecord()`), and how they relate
 * (`validateExecutionHistoryReferences()`: 1:1 with no repeated ID on either
 * side, the changed Steps of the record's Plan in Plan order, at most one
 * deleted save point per Plan). A metadata record with no Undo body, an Undo
 * body with no metadata record and a malformed body are all issues; nothing is
 * filled in or left out. No hash is compared and no Plan is rebuilt: that is
 * the Undo's (`docs/PLANNER_SPEC.md` 19.5).
 *
 * The one authority for "the records are complete": Export / Import validate a
 * root with it, and the OwnedWeapon delete reference check refuses to decide
 * from records it rejects. Issues are reported under `executionHistory[i]` and
 * `executionUndoSnapshots[j]`, the indexes of the given collections.
 */
export function validateExecutionRecordCollection(
  histories: readonly ExecutionHistory[],
  snapshots: readonly ExecutionUndoSnapshot[],
  productionPlans: readonly Pick<ProductionPlan, 'id' | 'steps'>[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const bodyIndexById = new Map<unknown, number>()
  snapshots.forEach((body, index) => {
    const id: unknown = isPlainObject(body) ? body.executionHistoryId : undefined
    if (id !== undefined && !bodyIndexById.has(id)) bodyIndexById.set(id, index)
  })
  const pairedBodies = new Set<number>()
  histories.forEach((history, index) => {
    const path = `executionHistory[${index}]`
    const bodyIndex = isPlainObject(history) ? bodyIndexById.get(history.id) : undefined
    if (bodyIndex === undefined || pairedBodies.has(bodyIndex)) {
      issues.push(...containedIssues(path, () => prefixedIssues(path, validateExecutionHistory(history))))
      return
    }
    pairedBodies.add(bodyIndex)
    const bodyPath = `executionUndoSnapshots[${bodyIndex}]`
    // `validateExecutionRecord()` reports the metadata under `executionHistory`
    // and the body under `executionUndoSnapshot`; each goes back to its own
    // collection path.
    const relocate = (issuePath: string): string => {
      if (issuePath.startsWith('executionUndoSnapshot')) return `${bodyPath}${issuePath.slice('executionUndoSnapshot'.length)}`
      if (issuePath.startsWith('executionHistory')) return `${path}${issuePath.slice('executionHistory'.length)}`
      return issuePath ? `${path}.${issuePath}` : path
    }
    issues.push(...containedIssues(path, () =>
      validateExecutionRecord(history, snapshots[bodyIndex]).issues
        .map((issue) => ({ ...issue, path: relocate(issue.path) }))))
  })
  snapshots.forEach((body, index) => {
    if (pairedBodies.has(index)) return
    const path = `executionUndoSnapshots[${index}]`
    issues.push(...containedIssues(path, () => prefixedIssues(path, validateExecutionUndoSnapshot(body))))
  })
  issues.push(...containedIssues('executionHistory', () =>
    validateExecutionHistoryReferences(histories, snapshots, productionPlans).issues))
  return result(issues)
}

/**
 * Structural validation of one game save point (`docs/DATA_MODEL.md` 12.1).
 *
 * Checks the stable one-per-Plan ID, the embedded entity snapshots, and that
 * the snapshot Plan is the save point's own Plan. References to persisted
 * ProductionPlans and ExecutionHistory need the whole collection and belong to
 * `validateExecutionSavePointReferences()`.
 */
export function validateExecutionSavePoint(
  savePoint: ExecutionSavePoint,
  options: TargetBodyValidationOptions = {},
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  validateId(savePoint.id, 'id', issues)
  validateId(savePoint.productionPlanId, 'productionPlanId', issues)
  if (
    isNonEmptyString(savePoint.productionPlanId) &&
    savePoint.id !== executionSavePointIdForPlan(savePoint.productionPlanId)
  ) {
    addIssue(issues, 'id', 'invalid_id', 'An ExecutionSavePoint ID must be derived from its productionPlanId.')
  }
  if (savePoint.lastExecutionHistoryId !== null) {
    validateId(savePoint.lastExecutionHistoryId, 'lastExecutionHistoryId', issues)
  }
  if (!isNonEmptyString(savePoint.recordedAt)) {
    addIssue(issues, 'recordedAt', 'invalid_structure', 'recordedAt must be an ISO date-time string.')
  }
  if (
    !Array.isArray(savePoint.normalCounters) ||
    !Array.isArray(savePoint.ownedWeapons) ||
    !Array.isArray(savePoint.targetWeapons) ||
    typeof savePoint.rngState !== 'object' || savePoint.rngState === null ||
    typeof savePoint.productionPlan !== 'object' || savePoint.productionPlan === null
  ) {
    addIssue(issues, '', 'invalid_structure', 'ExecutionSavePoint snapshot is incomplete.')
    return result(issues)
  }
  appendIssues(issues, 'rngState', validateRngState(savePoint.rngState))
  appendEntityIssues(issues, 'normalCounters', savePoint.normalCounters, validateNormalArtianCounter)
  appendEntityIssues(issues, 'ownedWeapons', savePoint.ownedWeapons, validateOwnedWeapon)
  appendEntityIssues(issues, 'targetWeapons', savePoint.targetWeapons, options.validateTargetBody ?? validateTargetWeapon)
  const hasDuplicates = (ids: readonly unknown[]) => new Set(ids).size !== ids.length
  if (hasDuplicates(entityIds(savePoint.normalCounters))) {
    addIssue(issues, 'normalCounters', 'invalid_id', 'Snapshot NormalArtianCounter IDs must be unique.')
  }
  if (hasDuplicates(entityIds(savePoint.ownedWeapons))) {
    addIssue(issues, 'ownedWeapons', 'invalid_id', 'Snapshot OwnedWeapon IDs must be unique.')
  }
  if (hasDuplicates(entityIds(savePoint.targetWeapons))) {
    addIssue(issues, 'targetWeapons', 'invalid_id', 'Snapshot TargetWeapon IDs must be unique.')
  }
  appendIssues(issues, 'productionPlan', validateProductionPlan(savePoint.productionPlan))
  if (savePoint.productionPlan.id !== savePoint.productionPlanId) {
    addIssue(issues, 'productionPlan.id', 'inconsistent_snapshot', 'The snapshot ProductionPlan must be the save point Plan.')
  }
  return result(issues)
}

/**
 * Collection-level references of game save points: each belongs to an existing
 * Plan, at most one exists per Plan, and a non-null `lastExecutionHistoryId`
 * names an existing history entry of that same Plan.
 */
export function validateExecutionSavePointReferences(
  savePoints: readonly ExecutionSavePoint[],
  productionPlans: readonly Pick<ProductionPlan, 'id'>[],
  executionHistory: readonly Pick<ExecutionHistory, 'id' | 'planId'>[],
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  const planIds = new Set<string>(productionPlans.map(({ id }) => id))
  const historyById = new Map<string, Pick<ExecutionHistory, 'id' | 'planId'>>(
    executionHistory.map((history) => [history.id, history]),
  )
  const seenPlans = new Set<string>()
  const seenIds = new Set<string>()
  savePoints.forEach((savePoint, index) => {
    const path = `[${index}]`
    if (seenIds.has(savePoint.id)) {
      addIssue(issues, `${path}.id`, 'invalid_id', 'ExecutionSavePoint IDs must be unique.')
    }
    seenIds.add(savePoint.id)
    if (seenPlans.has(savePoint.productionPlanId)) {
      addIssue(issues, `${path}.productionPlanId`, 'invalid_state', 'A ProductionPlan can have at most one ExecutionSavePoint.')
    }
    seenPlans.add(savePoint.productionPlanId)
    if (!planIds.has(savePoint.productionPlanId)) {
      addIssue(issues, `${path}.productionPlanId`, 'invalid_reference', 'ExecutionSavePoint must reference an existing ProductionPlan.')
    }
    if (savePoint.lastExecutionHistoryId !== null) {
      const history = historyById.get(savePoint.lastExecutionHistoryId)
      if (!history) {
        addIssue(issues, `${path}.lastExecutionHistoryId`, 'invalid_reference', 'lastExecutionHistoryId must reference an existing ExecutionHistory.')
      } else if (history.planId !== savePoint.productionPlanId) {
        addIssue(issues, `${path}.lastExecutionHistoryId`, 'invalid_reference', 'lastExecutionHistoryId must belong to the save point Plan.')
      }
    }
  })
  return result(issues)
}

export function validateAppSettings(
  settings: AppSettings,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  if (settings.id !== 'settings') {
    addIssue(issues, 'id', 'invalid_literal', "AppSettings id must be 'settings'.")
  }
  if (settings.schemaVersion !== APP_SETTINGS_SCHEMA_VERSION) {
    addIssue(
      issues,
      'schemaVersion',
      'invalid_literal',
      `AppSettings schemaVersion must be ${APP_SETTINGS_SCHEMA_VERSION}.`,
    )
  }
  validatePositiveInteger(settings.resultPageSize, 'resultPageSize', issues)
  validatePositiveInteger(settings.defaultSearchLimit, 'defaultSearchLimit', issues)
  const defaults: unknown = settings.candidateSearchDefaults
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    addIssue(
      issues,
      'candidateSearchDefaults',
      'invalid_structure',
      'candidateSearchDefaults is required.',
    )
  } else {
    issues.push(
      ...validateCandidateSearchDefaults(defaults as CandidateSearchDefaults).issues.map((issue) => ({
        ...issue,
        path: `candidateSearchDefaults.${issue.path}`,
      })),
    )
  }
  return result(issues)
}

/**
 * The Candidate Search defaults of AppSettings (`docs/DATA_MODEL.md` 13): each
 * of the three bounds is a positive integer. No ordering between them is
 * required - the recommended Bonus bound above the Normal Artian one is a
 * recommendation, never a constraint - and no upper cap is added.
 */
export function validateCandidateSearchDefaults(
  defaults: CandidateSearchDefaults,
): DomainValidationResult {
  const issues: DomainValidationIssue[] = []
  validatePositiveInteger(defaults.maxNormalAdvance, 'maxNormalAdvance', issues)
  validatePositiveInteger(defaults.maxGogmaAdvance, 'maxGogmaAdvance', issues)
  validatePositiveInteger(defaults.maxSkillAdvance, 'maxSkillAdvance', issues)
  return result(issues)
}
