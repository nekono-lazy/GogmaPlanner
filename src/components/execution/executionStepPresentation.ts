import {
  executionReidentificationDestination,
  type AlternateWeaponExecutionAvailability,
  type ExecutionRuntimeErrorCode,
  type ReidentificationDestination,
} from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildListEntry,
  ExecutionHistory,
  ExpectedResult,
  NormalArtianCounter,
  OwnedWeapon,
  OwnedWeaponId,
  PlanStep,
  PlanStepNormalCreationRole,
  ProductionPlan,
  TargetWeapon,
  TargetWeaponId,
} from '../../domain/models/publicTypes'
import type { TargetEvaluationMasterSubset } from '../../domain/target/targetEvaluationTypes'
import { planStepOperationLabels } from '../../presentation/labels'
import { orderPlanSteps } from '../planner/productionPlanPresentation'
import {
  describeEntryAchievedCompletionSkillVariants,
  describeEntryAchievedCompletionVariants,
  type AchievedCompletionSkillVariants,
  type AchievedCompletionVariants,
} from '../target/completionConditionPresentation'

/**
 * Pure presentation over an exact persisted ProductionPlan for the Execution
 * Navigator (`docs/UI_FLOW.md` 12, `docs/PLANNER_SPEC.md` 16).
 *
 * Nothing here decides Execution semantics: the Plan's `currentStepId`, the
 * Steps' `isCompleted`, `order` and `executionEffects` are read as they were
 * persisted, no RNG prediction runs, and no Step is reconstructed from a
 * Candidate. The Execution runtime stays the authority that accepts or refuses
 * every confirmation.
 */

/** Where the Plan stands, from its persisted `order`, `isCompleted` and `currentStepId`. */
export interface ExecutionProgressView {
  totalStepCount: number
  completedStepCount: number
  remainingStepCount: number
  /** 1-based position of the current Step in Plan order, or `null` when there is none. */
  currentStepNumber: number | null
  currentStep: PlanStep | null
}

export function createExecutionProgress(plan: ProductionPlan): ExecutionProgressView {
  const steps = orderPlanSteps(plan)
  const completedStepCount = steps.filter(({ isCompleted }) => isCompleted).length
  // `currentStepId` is the only current-Step authority; an array index or the
  // first incomplete Step is never taken in its place.
  const currentIndex =
    plan.currentStepId === null ? -1 : steps.findIndex(({ id }) => id === plan.currentStepId)
  const currentStep = currentIndex < 0 ? null : steps[currentIndex]
  return {
    totalStepCount: steps.length,
    completedStepCount,
    remainingStepCount: steps.length - completedStepCount,
    currentStepNumber: currentStep === null || currentStep.isCompleted ? null : currentIndex + 1,
    currentStep: currentStep === null || currentStep.isCompleted ? null : currentStep,
  }
}

/** Which confirmation the current Step offers (`docs/PLANNER_SPEC.md` 16.4). */
export type ExecutionStepActionKind =
  /** 「結果一致・次へ」 */
  | 'confirm_expected'
  /** 「実際の5枠を入力して確定」: a blind production-target Normal. */
  | 'observe_normal_bonuses'
  /** 「所持武器で完成を確認」: no game operation. */
  | 'confirm_owned_ideal'
  /** A legacy or projection-less Step the Navigator never executes. */
  | 'not_executable'

export type ExecutionExpectedView =
  | { kind: 'none' }
  | { kind: 'observation_required' }
  | { kind: 'result'; result: ExpectedResult }

export interface ExecutionStepPresentation {
  step: PlanStep
  operationLabel: string
  actionKind: ExecutionStepActionKind
  normalCreationRole: PlanStepNormalCreationRole | null
  /**
   * The tracked weapon's current name (or its ID when it cannot be resolved).
   * `null` for a Counter-advance Normal and for the Step that registers the
   * production-target Normal, which does not exist yet.
   */
  weaponLabel: string | null
  /**
   * The exact persisted OwnedWeapon `weaponLabel` names, for the read-only
   * lookup beside it (Issue #76). `null` whenever no name is shown and
   * whenever the tracked ID cannot be resolved in the current snapshot, so the
   * ID fallback label is never backed by a guessed weapon.
   */
  weapon: OwnedWeapon | null
  /** The weapon type whose bonus names the expected result uses. */
  weaponTypeId: string
  /** The element the actual result input offers bonuses for (tracked weapon, else the Target). */
  elementId: string
  /** The Step's primary Target name, or its ID when it cannot be resolved. */
  targetLabel: string | null
  /**
   * The exact persisted TargetWeapon `targetLabel` names, for the read-only
   * lookup beside it (Issue #76). `null` when the Step names no Target or the
   * Target is not in the current snapshot.
   */
  target: TargetWeapon | null
  expected: ExecutionExpectedView
  /** Target names from `executionEffects.targetCompletions` only. */
  completionTargetLabels: string[]
  /**
   * The same completions with the completion Variants each achieves, judged at
   * display time (`docs/REQUIREMENTS.md` 13.2) from the completing Entry's
   * Candidate Snapshot and the current Target, and - for a Target with two or
   * more completion Skill configurations (Issue #367) - the configurations the
   * same Snapshot's Skills achieve. `achieved` / `skillAchieved` are null when
   * the caller gave no completion sources; `skillAchieved` is null too for a
   * Target with one configuration or none found.
   */
  completionTargets: ExecutionCompletionTargetView[]
  /**
   * The game operation of a `create_normal_artian` Step whose
   * `executionEffects.normalCreationRole` is recorded (Issue #275), shown in
   * place of the persisted `step.instruction`. `null` for every other Step and
   * for a Normal creation without a recorded role, which keeps the persisted
   * instruction as it is.
   */
  normalCreation: ExecutionNormalCreationGuidance | null
}

/**
 * What the player forges in the game for a `create_normal_artian` Step
 * (`docs/UI_FLOW.md` 12, Issue #275).
 *
 * Presentation only: the role is `executionEffects.normalCreationRole` as it
 * was persisted, never inferred, and the weapon type / element come from the
 * same records the Execution runtime reads for that Step (see
 * `normalCreationWeapon()`). The persisted Step is never rewritten.
 */
export interface ExecutionNormalCreationGuidance {
  role: PlanStepNormalCreationRole
  /** A blind production-target Normal: its five slots are the user's observation. */
  isBlind: boolean
  /**
   * 「双剣」 (Counter-advance) or 「双剣・火属性」 (production target) from the
   * Master `displayNameJa`, or `null` when it cannot be resolved safely; the
   * instruction then names no weapon type or element at all.
   */
  weaponDescription: string | null
  /** The operation itself, e.g. 「双剣の通常アーティアを1本作成してください。」 */
  instruction: string
  /** The production-target notice shown above the body text; `null` for a Counter-advance Normal. */
  keepNotice: { title: string; body: string } | null
  /** Supplementary lines in display order. */
  notes: readonly string[]
}

/** The persisted records a Normal creation instruction is named from. */
export interface ExecutionNormalCreationSources {
  normalCounters: readonly Pick<NormalArtianCounter, 'id' | 'weaponTypeId'>[]
  master: Pick<MasterDataRoot, 'weaponTypes' | 'elements'>
}

function masterDisplayName(
  entries: readonly { id: string; displayNameJa: string }[],
  id: string,
): string | null {
  return entries.find((entry) => entry.id === id)?.displayNameJa ?? null
}

/** 「火」 reads 「火属性」; a name that already says 属性 (「無属性」) is kept. */
function elementPhrase(displayName: string): string {
  return displayName.endsWith('属性') ? displayName : `${displayName}属性`
}

/**
 * The weapon type of the Normal Counter the Step advances, from the persisted
 * Counter record `rngAdvance.affectedNormalCounterId` names - never by reading
 * the Counter ID. `none` when the Step names no Counter (a blind creation over
 * an unconfirmed Counter); `unresolved` when it names one that is not in the
 * snapshot, which the Execution runtime refuses too.
 */
function advancedNormalCounterWeaponType(
  step: PlanStep,
  normalCounters: ExecutionNormalCreationSources['normalCounters'],
): { kind: 'none' } | { kind: 'unresolved' } | { kind: 'resolved'; weaponTypeId: string } {
  const counterId = step.rngAdvance.affectedNormalCounterId
  if (counterId === null) return { kind: 'none' }
  const record = normalCounters.find(({ id }) => id === counterId)
  return record === undefined ? { kind: 'unresolved' } : { kind: 'resolved', weaponTypeId: record.weaponTypeId }
}

/**
 * The weapon type (and, for the production target, the element) the Step
 * forges, or `null` whenever the records do not agree.
 *
 * - Counter-advance: the advanced Normal Counter's weapon type, which must
 *   match the Step's Target when the Target is known, because the forge only
 *   exists to move that very Counter.
 * - Production target: the identity the runtime registers the weapon with
 *   (`productionTargetNormalIdentity()`): the Target for a blind creation, the
 *   recorded `inventoryChange.addOwnedWeapon` otherwise, which must agree with
 *   the Target and with the advanced Counter.
 */
function normalCreationWeapon(
  step: PlanStep,
  role: PlanStepNormalCreationRole,
  target: TargetWeapon | null,
  normalCounters: ExecutionNormalCreationSources['normalCounters'],
): { weaponTypeId: string; elementId: string | null } | null {
  const counter = advancedNormalCounterWeaponType(step, normalCounters)
  if (role === 'counter_advance') {
    if (counter.kind !== 'resolved') return null
    if (target !== null && target.weaponTypeId !== counter.weaponTypeId) return null
    return { weaponTypeId: counter.weaponTypeId, elementId: null }
  }
  const effects = step.executionEffects
  if (effects === undefined || target === null) return null
  let identity: { weaponTypeId: string; elementId: string }
  if (effects.observationBinding !== null) {
    identity = { weaponTypeId: target.weaponTypeId, elementId: target.elementId }
  } else {
    const registered = step.inventoryChange?.addOwnedWeapon ?? null
    if (
      registered === null ||
      registered.kind !== 'normal' ||
      registered.id !== effects.trackedOwnedWeaponId ||
      registered.weaponTypeId !== target.weaponTypeId ||
      registered.elementId !== target.elementId
    ) {
      return null
    }
    identity = { weaponTypeId: registered.weaponTypeId, elementId: registered.elementId }
  }
  if (counter.kind === 'unresolved') return null
  if (counter.kind === 'resolved' && counter.weaponTypeId !== identity.weaponTypeId) return null
  return identity
}

/**
 * The 「双剣」 / 「双剣・火属性」 the instruction names, or `null` when a name is
 * missing from the Master: an internal ID is never shown as a weapon name, and
 * a production target never names its weapon type without its element.
 */
function normalCreationWeaponDescription(
  weapon: { weaponTypeId: string; elementId: string | null } | null,
  master: ExecutionNormalCreationSources['master'],
): string | null {
  if (weapon === null) return null
  const weaponTypeName = masterDisplayName(master.weaponTypes, weapon.weaponTypeId)
  if (weaponTypeName === null) return null
  if (weapon.elementId === null) return weaponTypeName
  const elementName = masterDisplayName(master.elements, weapon.elementId)
  return elementName === null ? null : `${weaponTypeName}・${elementPhrase(elementName)}`
}

/** The production-target notice, emphasized above the body text (Issue #275). */
const PRODUCTION_TARGET_KEEP_NOTICE = {
  title: 'この武器は、この後の巨戟化に使用します。',
  body: '巨戟化するまで、作成した武器を処分しないでください。',
} as const

export function createNormalCreationGuidance(
  step: PlanStep,
  target: TargetWeapon | null,
  sources: ExecutionNormalCreationSources,
): ExecutionNormalCreationGuidance | null {
  const effects = step.executionEffects
  // A role is never inferred: a legacy Step, or one with no recorded role,
  // keeps its persisted instruction.
  if (step.operationType !== 'create_normal_artian' || effects === undefined) return null
  const role = effects.normalCreationRole
  if (role === null) return null
  const weaponDescription = normalCreationWeaponDescription(
    normalCreationWeapon(step, role, target, sources.normalCounters),
    sources.master,
  )
  const instruction = weaponDescription === null
    ? '通常アーティアを1本作成してください。'
    : `${weaponDescription}の通常アーティアを1本作成してください。`
  if (role === 'counter_advance') {
    return {
      role,
      isBlind: false,
      weaponDescription,
      instruction,
      keepNotice: null,
      notes: [
        weaponDescription === null
          ? '通常アーティアCounterを進めるための作成です。この武器は所持武器として登録しません。'
          : '武器種ごとの通常アーティアCounterを進めるための作成です。この武器は所持武器として登録しません。',
        ...(weaponDescription === null ? ['作成する武器種を特定できないため、武器種を表示していません。'] : []),
      ],
    }
  }
  const isBlind = effects.observationBinding !== null
  return {
    role,
    isBlind,
    weaponDescription,
    instruction,
    keepNotice: PRODUCTION_TARGET_KEEP_NOTICE,
    notes: [
      isBlind
        ? '復元ボーナスは予測していないため、ゲーム画面で確認した5枠を入力して所持武器として登録します。後の「復元ボーナスを再抽選」で5枠すべてが引き直されます。'
        : '作成後、復元ボーナス5枠を想定結果と照らし合わせてください。この武器を所持武器として登録します。',
      ...(weaponDescription === null ? ['作成する武器種・属性を特定できないため、武器種・属性を表示していません。'] : []),
    ],
  }
}

export function ownedWeaponLabel(
  weaponId: OwnedWeaponId,
  ownedWeapons: readonly OwnedWeapon[],
): string {
  return ownedWeapons.find(({ id }) => id === weaponId)?.name ?? `所持武器（${weaponId}）`
}

export function targetWeaponLabel(
  targetWeaponId: TargetWeaponId,
  targetWeapons: readonly TargetWeapon[],
): string {
  return targetWeapons.find(({ id }) => id === targetWeaponId)?.name ?? `目標武器（${targetWeaponId}）`
}

function actionKindFor(step: PlanStep): ExecutionStepActionKind {
  const effects = step.executionEffects
  if (effects === undefined) return 'not_executable'
  switch (step.operationType) {
    case 'confirm_owned_ideal':
      return 'confirm_owned_ideal'
    case 'create_normal_artian':
      return effects.observationBinding !== null ? 'observe_normal_bonuses' : 'confirm_expected'
    case 'convert_normal_to_gogma':
    case 'reset_bonuses':
    case 'keep_bonuses':
    case 'reset_skills':
      return 'confirm_expected'
    case 'reserve_weapon':
    case 'confirm_result':
      // Legacy Steps are displayed by the Plan page but never executed.
      return 'not_executable'
  }
}

/** One Target a Step completes and, when the caller gave the sources, the completion Variants it achieves. */
export interface ExecutionCompletionTargetView {
  label: string
  achieved: AchievedCompletionVariants | null
  skillAchieved: AchievedCompletionSkillVariants | null
}

/**
 * What the achieved completion Variants of a Step's completions are judged
 * from: the Navigator snapshot's Build List Entries (whose Candidate Snapshot
 * is the completion result the Step confirms) and the Master (its rank order,
 * and the Skill names of the completion Skill configurations). Display only.
 */
export interface ExecutionCompletionSources {
  buildListEntries: readonly BuildListEntry[]
  master: TargetEvaluationMasterSubset & Pick<MasterDataRoot, 'seriesSkills' | 'groupSkills'>
}

export function createExecutionStepPresentation(
  step: PlanStep,
  ownedWeapons: readonly OwnedWeapon[],
  targetWeapons: readonly TargetWeapon[],
  normalCreationSources: ExecutionNormalCreationSources,
  completionSources: ExecutionCompletionSources | null = null,
): ExecutionStepPresentation {
  const effects = step.executionEffects
  const actionKind = actionKindFor(step)
  const trackedId = effects?.trackedOwnedWeaponId ?? null
  const tracked = trackedId === null ? null : ownedWeapons.find(({ id }) => id === trackedId) ?? null
  const target = step.targetWeaponId === null
    ? null
    : targetWeapons.find(({ id }) => id === step.targetWeaponId) ?? null
  // A weapon the Step registers does not exist yet: the Target's type / element apply.
  const existingTracked = effects?.registersTrackedWeapon === true ? null : tracked
  const weaponLabel =
    trackedId === null || effects?.registersTrackedWeapon === true
      ? null
      : ownedWeaponLabel(trackedId, ownedWeapons)
  const expected: ExecutionExpectedView =
    actionKind === 'observe_normal_bonuses'
      ? { kind: 'observation_required' }
      : step.expectedResult === null
        ? { kind: 'none' }
        : { kind: 'result', result: step.expectedResult }
  return {
    step,
    operationLabel: planStepOperationLabels[step.operationType],
    actionKind,
    normalCreationRole: effects?.normalCreationRole ?? null,
    weaponLabel,
    weapon: weaponLabel === null ? null : existingTracked,
    weaponTypeId: tracked?.weaponTypeId ?? target?.weaponTypeId ?? '',
    elementId: existingTracked?.elementId ?? target?.elementId ?? '',
    targetLabel:
      step.targetWeaponId === null ? null : targetWeaponLabel(step.targetWeaponId, targetWeapons),
    target,
    expected,
    completionTargetLabels: (effects?.targetCompletions ?? []).map(({ targetWeaponId }) =>
      targetWeaponLabel(targetWeaponId, targetWeapons),
    ),
    completionTargets: (effects?.targetCompletions ?? []).map(({ targetWeaponId, buildListEntryId }) => {
      const completingEntry = completionSources?.buildListEntries.find(({ id }) => id === buildListEntryId)
      const completedTarget = targetWeapons.find(({ id }) => id === targetWeaponId)
      return {
        label: targetWeaponLabel(targetWeaponId, targetWeapons),
        achieved: completionSources === null
          ? null
          : describeEntryAchievedCompletionVariants(completingEntry, completedTarget, completionSources.master),
        skillAchieved: completionSources === null
          ? null
          : describeEntryAchievedCompletionSkillVariants(completingEntry, completedTarget, completionSources.master),
      }
    }),
    normalCreation: createNormalCreationGuidance(step, target, normalCreationSources),
  }
}

/** The physical operations the weapon switch guidance compares (16.14). */
const WEAPON_SWITCH_OPERATIONS: ReadonlySet<PlanStep['operationType']> = new Set([
  'convert_normal_to_gogma',
  'reset_bonuses',
  'keep_bonuses',
  'reset_skills',
])

function switchSubject(step: PlanStep): OwnedWeaponId | null {
  if (!WEAPON_SWITCH_OPERATIONS.has(step.operationType)) return null
  return step.executionEffects?.trackedOwnedWeaponId ?? null
}

/**
 * The completed Steps the user performed on an unneeded weapon instead of the
 * tracked one (`executed_on_alternate_weapon`, `docs/PLANNER_SPEC.md` 16.20),
 * from the Plan's ExecutionHistory metadata. Undo and a save point restore
 * delete the record, so the Step counts as ordinary again.
 */
export function alternateExecutedStepIds(
  plan: Pick<ProductionPlan, 'id'>,
  planExecutionHistory: readonly ExecutionHistory[],
): Set<PlanStep['id']> {
  return new Set(
    planExecutionHistory
      .filter(({ planId, action }) => planId === plan.id && action === 'executed_on_alternate_weapon')
      .map(({ planStepId }) => planStepId),
  )
}

/** The weapon the last completed compared Step really left in the player's hand, or `unknown`. */
type PreviousWeaponSubject = OwnedWeaponId | 'unknown' | null

/**
 * The weapon the user must switch to before the current Step
 * (`docs/UI_FLOW.md` 12.6, `docs/PLANNER_SPEC.md` 16.14), or `null`.
 *
 * Presentation only: it compares the current Step's tracked weapon with the
 * weapon the last *completed* conversion / Reset / Keep / Reset Skills Step in
 * Plan order was really performed on. A Step confirmed through
 * 「スキル再付与済み・次へ」 (`executed_on_alternate_weapon`, Issue #379) was performed on
 * an unneeded weapon the Plan does not know, so after it the weapon in hand is
 * unknown and the next compared Step always prompts - even when the Plan
 * tracks the same weapon on both. `create_normal_artian` and
 * `confirm_owned_ideal` are neither compared nor prompted, and they never
 * change the weapon in hand. With no earlier compared Step there is no weapon
 * to switch from, so nothing is prompted.
 */
export function weaponSwitchTarget(
  plan: ProductionPlan,
  currentStep: PlanStep,
  planExecutionHistory: readonly ExecutionHistory[] = [],
): OwnedWeaponId | null {
  const current = switchSubject(currentStep)
  if (current === null) return null
  const alternate = alternateExecutedStepIds(plan, planExecutionHistory)
  let previous: PreviousWeaponSubject = null
  for (const step of orderPlanSteps(plan)) {
    if (!step.isCompleted) continue
    const subject = switchSubject(step)
    if (subject !== null) previous = alternate.has(step.id) ? 'unknown' : subject
  }
  return previous !== null && previous !== current ? current : null
}

/**
 * The one confirmation of a Skill Counter-advance-only Step performed on an
 * unneeded weapon (`docs/UI_FLOW.md` 12.12, Issue #381). The Step card, its
 * note and the Undo control all name the button with these words.
 */
export const COUNTER_ADVANCE_CONFIRM_LABEL = 'スキル再付与済み・次へ'

/**
 * How long the confirmation controls stay disabled around a Skill
 * Counter-advance-only confirmation (`docs/UI_FLOW.md` 12.12). The next Step's
 * button can appear where the pointer already is, and saving can finish inside a
 * double click, so its second click must not confirm a Step whose game operation
 * has not been done. Well below the time one game operation takes.
 */
export const COUNTER_ADVANCE_REARM_MS = 600

/**
 * The presentation-only choice made on the current Step (`docs/UI_FLOW.md` 12.6
 * / 12.12); never persisted, so a reload starts from the Step's default view.
 *
 * `switch_requested`: 「案内された武器で実行する」 on a Counter-advance-only Step
 * asked for the switch, which is not confirmed yet. `switched`: the switch to
 * the guided weapon was confirmed.
 */
export type ExecutionStepRoute = 'switch_requested' | 'switched'

export type ExecutionStepView =
  /** The weapon switch guidance stands in for the Step card; `offersCounterAdvanceReturn` adds 「不要な武器で進める」. */
  | { kind: 'weapon_switch_prompt'; weaponId: OwnedWeaponId; offersCounterAdvanceReturn: boolean }
  /** The compact card of a Counter-advance-only Step, confirmed on an unneeded weapon in one click. */
  | { kind: 'counter_advance'; trackedOwnedWeaponId: OwnedWeaponId }
  /** The whole Step card with its ordinary confirmation; `offersCounterAdvanceReturn` adds 「不要な武器で進める」. */
  | { kind: 'step'; offersCounterAdvanceReturn: boolean }

/**
 * What the Navigator shows for the current Step (`docs/UI_FLOW.md` 12.6 /
 * 12.12). Pure: it combines the Domain's eligibility, the weapon switch
 * judgement and the temporary route, and decides nothing about Execution.
 *
 * A Counter-advance-only Step skips the guidance because it can be performed on
 * an unneeded weapon whatever is in hand. Skipping it confirms no switch, so the
 * ordinary confirmation stays out of reach until the switch was confirmed, even
 * where `weaponSwitchTarget()` asks for none (the Plan's first compared Step, or
 * the same weapon again): the card never assumes which weapon the user holds.
 * Every other Step keeps the guidance exactly as `weaponSwitchTarget()` judges it.
 */
export function deriveExecutionStepView({
  actionKind,
  alternateWeapon,
  switchWeaponId,
  route,
}: {
  actionKind: ExecutionStepActionKind
  alternateWeapon: AlternateWeaponExecutionAvailability
  switchWeaponId: OwnedWeaponId | null
  route: ExecutionStepRoute | null
}): ExecutionStepView {
  if (actionKind === 'confirm_expected' && alternateWeapon.kind === 'available') {
    const trackedOwnedWeaponId = alternateWeapon.trackedOwnedWeaponId
    switch (route) {
      case null:
        return { kind: 'counter_advance', trackedOwnedWeaponId }
      case 'switch_requested':
        return { kind: 'weapon_switch_prompt', weaponId: trackedOwnedWeaponId, offersCounterAdvanceReturn: true }
      case 'switched':
        return { kind: 'step', offersCounterAdvanceReturn: true }
    }
  }
  if (switchWeaponId !== null && route !== 'switched') {
    return { kind: 'weapon_switch_prompt', weaponId: switchWeaponId, offersCounterAdvanceReturn: false }
  }
  return { kind: 'step', offersCounterAdvanceReturn: false }
}

/**
 * The game save point cannot be restored safely (UI_FLOW 12.8): an entity the
 * restored Plan needs was deleted, or the record itself cannot be restored
 * exactly. Nothing is revived and nothing was changed.
 */
export const SAVE_POINT_UNSAFE_MESSAGE =
  'このセーブ地点を安全に復元できません。必要な所持武器・目標武器・作成リストの状態を確認し、現在状態から再計画してください。状態は変更されていません。'

/**
 * The execution history holds a record the database upgrade could not convert
 * (`docs/DATA_MODEL.md` 14.2, case 2), so nothing that depends on it can be
 * decided. Never read as "no history" or "nothing to re-identify"; the only
 * recoveries are a full-replacement Import or clearing all data.
 */
export const EXECUTION_HISTORY_UNCONVERTIBLE_MESSAGE =
  '実行履歴に現在の形式へ変換できない記録があるため、この操作はできません。状態は変更されていません。バックアップからの全置換Import、または全データクリアで回復できます。'

/**
 * Why an operation that reads every ExecutionHistory record refused
 * (`execution_history_record_invalid`, `docs/DATA_MODEL.md` 14.6): a record of
 * the current shape lacks its Undo body, or a body lacks its record or is
 * broken, so what it holds is unknown and nothing was decided or written.
 */
export const EXECUTION_HISTORY_RECORD_INVALID_MESSAGE =
  '実行履歴の記録とUndo情報の対応が壊れているため、参照を確認できず、この操作はできません。状態は変更されていません。バックアップからの全置換Import、または全データクリアで回復できます。'

/** A typed Execution runtime refusal, in the words the Navigator shows. */
export function executionErrorMessage(code: ExecutionRuntimeErrorCode): string {
  switch (code) {
    case 'plan_not_found':
      return '生産計画が見つかりません。'
    case 'plan_not_startable':
      return 'この生産計画は開始できる状態ではありません。'
    case 'running_plan_conflict':
      return '別の生産計画が実行中です。実行中の生産計画を終えてから開始してください。'
    case 'plan_not_active':
      return 'この生産計画は実行中ではないため、操作を確定できません。'
    case 'plan_not_executable':
      return 'この生産計画は現在の実行形式ではないため実行できません。ビルドリストから再計算してください。'
    case 'calculation_context_changed':
      return 'この生産計画は現在の計算契約と互換性がないため実行できません。ビルドリストから再計算してください。'
    case 'step_not_current':
      return 'このStepは現在のStepではありません。最新の状態を読み込み直しました。'
    case 'plan_dependency_changed':
      return 'この生産計画が前提とする目標武器または作成リストが変更されています。'
    case 'execution_state_mismatch':
      return '現在の保存状態が、このStep開始時の想定と一致しません。'
    case 'completion_assignment_conflict':
      return 'この生産計画は、1本の所持武器を2件の目標武器の完成品にする予定を含むため続行できません。作成プランで理由と再計画の導線を確認してください。'
    case 'observation_required':
      return 'ゲーム画面で確認した実際の5枠を入力してください。'
    case 'observation_not_expected':
      return 'このStepでは5枠の入力は不要です。'
    case 'observation_invalid':
      return '入力した5枠は、この武器種・属性の通常アーティアとして保存できません。入力を確認してください。'
    case 'actual_result_not_applicable':
      return 'このStepには比較できる想定結果がないため、「結果が違う」として記録できません。'
    case 'actual_result_invalid':
      return '入力した実際の結果は、この武器の結果として保存できません。入力を確認してください。'
    case 'actual_result_matches_expected':
      return '入力した結果は想定結果と一致しています。「結果一致・次へ」を使用してください。'
    case 'alternate_weapon_not_allowed':
      return 'このStepはスキルカウンターを進めるだけの操作ではないため、他武器では実行できません。案内された武器で操作し、「結果一致・次へ」を使用してください。'
    case 'operation_count_recovery_not_applicable':
      return 'この作成プランは、現在位置の確認で再開できる状態ではありません。'
    case 'operation_count_recovery_changed':
      return '表示後に作成プランの状態が変わったため、現在位置の確認を確定しませんでした。最新の状態を読み込み直しました。'
    case 'operation_count_recovery_observation_invalid':
      return '入力したゲームの結果が、この操作の結果として正しくありません。入力を確認してください。'
    case 'operation_count_recovery_not_unique':
      return '入力した結果から現在位置を1つに特定できないため、確定しませんでした。'
    case 'save_point_changed':
      return '表示後にゲーム内セーブ地点の記録が変わったため、操作を確定しませんでした。最新の状態を読み込み直しました。'
    case 'save_point_not_found':
      return 'ゲーム内セーブ地点の記録が見つかりません。最新の状態を読み込み直しました。'
    case 'save_point_restore_not_allowed':
      return 'この作成プランは、ゲーム内セーブ地点へ戻せる状態ではありません。'
    case 'save_point_record_not_allowed':
      return '実行中ではない作成プランでは、ゲーム内セーブ地点を記録できません。'
    case 'save_point_required_entity_missing':
    case 'save_point_snapshot_invalid':
    case 'save_point_restore_invalid':
      return SAVE_POINT_UNSAFE_MESSAGE
    case 'plan_abandon_state_changed':
      return '表示後に作成プランの状態が変わったため、破棄しませんでした。最新の状態を読み込み直しました。'
    case 'plan_abandon_not_allowed':
      return 'この作成プランは破棄できる状態ではありません。'
    case 'save_point_choice_required':
      return 'ゲーム内セーブ地点の扱いを選ぶ必要があります。最新の状態を読み込み直しました。もう一度操作してください。'
    case 'save_point_choice_not_required':
      return '表示後にゲーム内セーブ地点の状態が変わったため、破棄しませんでした。最新の状態を読み込み直しました。'
    case 'replan_preview_not_allowed':
      return '現在の生産計画からは再計画を試算できません。'
    case 'replan_state_changed':
      return '試算後に状態が変わりました。もう一度、現在地点から再計画を試算してください。'
    case 'replan_result_invalid':
    case 'replan_plan_id_collision':
      return 'この試算結果は採用できません。もう一度、現在地点から再計画を試算してください。'
    case 'running_plan_invariant_violated':
      return '実行中の生産計画が複数存在するため、操作できません。'
    case 'undo_history_not_latest':
      return '表示後に新しい操作が記録されたため、Undoしませんでした。最新の状態を読み込み直しました。'
    case 'undo_history_not_found':
      return '取り消す操作の記録が見つかりません。最新の状態を読み込み直しました。'
    case 'undo_not_allowed':
      return 'この作成プランの状態では、最後の操作を元に戻せません。'
    case 'undo_snapshot_invalid':
    case 'undo_result_invalid':
      return '操作前の状態を正しく復元できないため、Undoしませんでした。状態は変更されていません。'
    case 'execution_history_unconvertible':
      return EXECUTION_HISTORY_UNCONVERTIBLE_MESSAGE
    case 'execution_history_record_invalid':
      return EXECUTION_HISTORY_RECORD_INVALID_MESSAGE
    case 'execution_effect_inconsistent':
    case 'expected_state_after_mismatch':
    case 'collection_validation_failed':
    case 'entity_validation_failed':
      return 'Stepを確定すると保存状態の整合性が崩れるため、確定しませんでした。'
    default:
      return '操作を確定できませんでした。'
  }
}

/** Refusals whose recovery is recalculation, not a retry. */
export function isRecalculationRequiredError(code: ExecutionRuntimeErrorCode): boolean {
  return (
    code === 'execution_state_mismatch' ||
    code === 'plan_dependency_changed' ||
    code === 'calculation_context_changed' ||
    code === 'plan_not_executable'
  )
}

/**
 * The actual result input 「結果が違う」 offers for a Step
 * (`docs/UI_FLOW.md` 12.4, `docs/PLANNER_SPEC.md` 16.15), or `null` when the
 * Step has no predicted result that can differ.
 *
 * Presentation only: it mirrors the operation's result contract
 * (`docs/DATA_MODEL.md` 11.4) so the form asks for the right fields with a
 * fixed scope. The runtime still validates the kind, scope and content and
 * stays the authority that accepts or refuses the record.
 */
export type ActualResultInputKind =
  | { kind: 'restoration_bonuses'; scope: 'normal_artian' | 'gogma_artian' }
  | { kind: 'skills' }

export function actualResultInputKind(step: PlanStep): ActualResultInputKind | null {
  const effects = step.executionEffects
  if (effects === undefined) return null
  switch (step.operationType) {
    case 'create_normal_artian':
      // A blind production-target Normal predicts no five slots: its
      // observation is the result itself, never a differing one.
      return effects.observationBinding !== null ? null : { kind: 'restoration_bonuses', scope: 'normal_artian' }
    case 'reset_bonuses':
    case 'keep_bonuses':
      return { kind: 'restoration_bonuses', scope: 'gogma_artian' }
    case 'convert_normal_to_gogma':
    case 'reset_skills':
      return { kind: 'skills' }
    case 'confirm_owned_ideal':
    case 'reserve_weapon':
    case 'confirm_result':
      return null
  }
}

/**
 * Whether 「何を何回操作したか分からない」 applies: every executable game
 * operation, a blind production-target Normal included. An owned Ideal
 * confirmation involves no game operation and a legacy Step is never executed.
 */
export function offersOperationUncertain(step: PlanStep): boolean {
  if (step.executionEffects === undefined) return false
  switch (step.operationType) {
    case 'create_normal_artian':
    case 'convert_normal_to_gogma':
    case 'reset_bonuses':
    case 'keep_bonuses':
    case 'reset_skills':
      return true
    case 'confirm_owned_ideal':
    case 'reserve_weapon':
    case 'confirm_result':
      return false
  }
}

/** Where the RNG re-identification of a diverged operation happens (UI_FLOW 12.4 / 12.5). */
export type { ReidentificationDestination }

/**
 * The divergence a stale Plan stopped on, from the Plan's latest
 * ExecutionHistory (ordered by `compareExecutionHistoryOrder()` in the
 * repository). `null` whenever the latest record is not an
 * `actual_result_different` / `operation_uncertain` record of this Plan whose
 * reason the Plan still carries: a reason in `recalculationReasons` alone never
 * names the Step, so an older divergence record is never taken for the cause.
 *
 * Only `actual_result_different` names an RNG re-identification destination.
 * `operation_uncertain` is recovered inside the Execution Navigator
 * (`docs/PLANNER_SPEC.md` 16.15) and never sends the user straight to the
 * ordinary Identification.
 */
export type ExecutionDivergenceView =
  | {
      action: 'actual_result_different'
      planStepId: PlanStep['id']
      operationLabel: string
      destination: ReidentificationDestination
    }
  | {
      action: 'operation_uncertain'
      planStepId: PlanStep['id']
      operationLabel: string
    }

export function executionDivergenceView(
  plan: ProductionPlan,
  latestHistory: ExecutionHistory | null,
): ExecutionDivergenceView | null {
  if (plan.status !== 'stale' || latestHistory === null || latestHistory.planId !== plan.id) return null
  const { action } = latestHistory
  if (action !== 'actual_result_different' && action !== 'operation_uncertain') return null
  const reason = action === 'actual_result_different' ? 'unexpected_result' : 'execution_operation_uncertain'
  if (latestHistory.recalculationReason !== reason || !plan.recalculationReasons.includes(reason)) return null
  const step = plan.steps.find(({ id }) => id === latestHistory.planStepId)
  if (step === undefined) return null
  const operationLabel = planStepOperationLabels[step.operationType]
  return action === 'actual_result_different'
    ? {
        action,
        planStepId: step.id,
        operationLabel,
        destination: executionReidentificationDestination(step),
      }
    : { action, planStepId: step.id, operationLabel }
}

/** 「Step N（操作名）」 in the Plan's display order; the Step ID when it is unknown. */
export function planStepPositionLabel(plan: ProductionPlan, stepId: PlanStep['id']): string {
  const steps = orderPlanSteps(plan)
  const index = steps.findIndex(({ id }) => id === stepId)
  if (index < 0) return `Step（${stepId}）`
  return `Step ${index + 1}（${planStepOperationLabels[steps[index].operationType]}）`
}

/**
 * Where the game save point was recorded, as 「Step N完了時点」 in the Plan's
 * display order: the Step before the snapshot Plan's current Step. Derived from
 * the save point's own Plan snapshot `currentStepId` only; no Counter value.
 */
export function savePointPositionLabel(
  plan: ProductionPlan,
  savePointCurrentStepId: PlanStep['id'] | null,
): string {
  const steps = orderPlanSteps(plan)
  if (savePointCurrentStepId === null) return `Step ${steps.length}完了時点`
  const index = steps.findIndex(({ id }) => id === savePointCurrentStepId)
  if (index < 0) return '記録地点（Stepを特定できません）'
  return index === 0 ? '作成開始時点（最初の操作の前）' : `Step ${index}完了時点`
}

/** What Undo removes, in the Navigator's words (UI_FLOW 12.7). */
export function executionUndoTargetLabel(plan: ProductionPlan, history: ExecutionHistory): string {
  const step = planStepPositionLabel(plan, history.planStepId)
  switch (history.action) {
    case 'confirmed_expected':
      return `${step} の確定`
    case 'actual_result_different':
      return `${step} の「結果が違う」の記録`
    case 'operation_uncertain':
      return `${step} の「何を何回操作したか分からない」の記録`
    case 'operation_count_recovered':
      return `現在位置の確認による再開（${step}まで）`
    case 'executed_on_alternate_weapon':
      return `${step} の「${COUNTER_ADVANCE_CONFIRM_LABEL}」の記録`
    case 'finished_as_compromise':
      return '妥協品として確定して終了'
    case 'secured_weapon':
    case 'skipped_candidate':
      return step
  }
}

/**
 * How the Undo control introduces itself in 「実行状態の管理」
 * (`docs/UI_FLOW.md` 12.7).
 *
 * The generic wording names the last tool-side operation. A record of
 * 「何を何回操作したか分からない」 gets its own wording, because the user
 * reaches it from the recovery screen and has to recognise it as taking back
 * the record they made by mistake. It is deliberately not a bare
 * 「キャンセル」 / 「戻る」: a user whose in-game situation really is unknown
 * must not leave the recovery by mistake.
 *
 * This is presentation only. The record it applies to, its eligibility and
 * what Undo restores are the runtime's (`docs/PLANNER_SPEC.md` 16.16); nothing
 * here changes which record `undoLatestExecution()` removes.
 */
export interface ExecutionUndoControlPresentation {
  /** The short description above the button. */
  description: string
  buttonLabel: string
  dialogTitle: string
  confirmLabel: string
  /** Lines specific to this record, added to the generic Undo notice. */
  notes: readonly string[]
}

export function executionUndoControlPresentation(
  history: ExecutionHistory,
): ExecutionUndoControlPresentation {
  if (history.action === 'operation_uncertain') {
    return {
      description:
        '「何を何回操作したか分からない」を誤って記録した場合は、この記録を取り消して記録前の操作へ戻せます。実際にゲーム内の操作状況が分からない場合は取り消さず、上の現在位置の確認やゲーム内セーブ地点への復元を使用してください。',
      buttonLabel: '「操作内容不明」の記録を取り消す',
      dialogTitle: '「操作内容不明」の記録を取り消しますか？',
      confirmLabel: '記録を取り消して元の操作に戻る',
      notes: [
        '「何を何回操作したか分からない」を誤って記録し、ゲーム内の状況がツールの案内と一致している場合だけ使用してください。',
        'ゲーム内の操作状況が実際に分からない場合は取り消さず、現在位置の確認やゲーム内セーブ地点への復元を使用してください。',
      ],
    }
  }
  return {
    description: '最後に確定した記録をツール上だけ取り消します。ゲーム内の操作は戻りません。',
    buttonLabel: '最後の操作をUndo',
    dialogTitle: '最後のツール上の操作を元に戻します',
    confirmLabel: 'Undoする',
    notes: [],
  }
}
