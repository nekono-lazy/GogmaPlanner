import type {
  PlanStep,
  PlanStepNormalCreationRole,
  PlanStepOperationType,
  TargetWeapon,
} from '../models/publicTypes'

const operationPresentation: Record<
  PlanStepOperationType,
  { title: string; instruction: string }
> = {
  create_normal_artian: {
    title: '通常アーティアを作成',
    instruction: '対象の通常アーティアを1回作成し、結果を確認してください。',
  },
  convert_normal_to_gogma: {
    title: '巨戟アーティアへ変換',
    instruction: '対象の通常アーティアを巨戟アーティアへ変換し、結果を確認してください。',
  },
  reset_bonuses: {
    title: '復元ボーナスを再抽選',
    instruction: '復元ボーナスを再抽選し、結果を確認してください。',
  },
  keep_bonuses: {
    title: '復元ボーナスを保持して再抽選',
    instruction: '指定された復元ボーナスを保持して再抽選し、結果を確認してください。',
  },
  reset_skills: {
    title: 'スキルを再付与',
    instruction: 'スキルを再付与し、結果を確認してください。',
  },
  confirm_owned_ideal: {
    title: '所持している理想品を確認',
    instruction:
      '所持している巨戟アーティアが目標の理想条件を満たしていることを確認してください。' +
      'ゲーム内の操作は不要です。',
  },
  // Legacy Steps only: a current Plan never contains them, but a historical
  // Plan is still displayed.
  reserve_weapon: {
    title: '候補武器を確保',
    instruction: '候補武器を確保し、結果を確認してください。',
  },
  confirm_result: {
    title: '結果を確認',
    instruction: '操作結果を確認してください。',
  },
}

/** A Normal forged only to advance the Normal Artian Counter (`docs/PLANNER_SPEC.md` 16.3). */
const counterAdvanceNormalInstruction =
  '通常アーティアを 1 本作成してください。' +
  'この武器はカウンターを進めるためのもので、所持武器として登録しません。'

/** The predicted Normal the Plan keeps tracking and converts next. */
const productionTargetNormalInstruction =
  'この後巨戟化する通常アーティアを 1 本作成し、結果を確認してください。' +
  'この武器を所持武器として登録します。'

/**
 * The blind production-target Normal (`docs/SEARCH_SPEC.md` 6.1.1,
 * `docs/PLANNER_SPEC.md` 16.4). Its restoration bonuses were never predicted,
 * so the player enters the five slots shown in the game instead.
 */
const blindProductionTargetNormalInstruction =
  'この後巨戟化する通常アーティアを 1 本作成してください。' +
  '復元ボーナスは予測していないため、ゲーム画面で確認した 5 枠を入力して登録します。' +
  '後の「復元ボーナスを再抽選」で 5 枠すべてが引き直されます。'

export interface PlanStepPresentationOptions {
  isBlindNormalCreation?: boolean
  normalCreationRole?: PlanStepNormalCreationRole | null
}

/** Pure deterministic presentation text; no game UI labels or navigation are assumed. */
export function createPlanStepPresentation(
  operationType: PlanStepOperationType,
  target: TargetWeapon | null,
  options: PlanStepPresentationOptions = {},
): Pick<PlanStep, 'title' | 'instruction'> {
  const base = operationPresentation[operationType]
  const targetSuffix = target === null ? '' : ` 「${target.name}」用`
  let instruction = base.instruction
  if (operationType === 'create_normal_artian') {
    if (options.normalCreationRole === 'counter_advance') {
      instruction = counterAdvanceNormalInstruction
    } else if (options.normalCreationRole === 'production_target') {
      instruction = options.isBlindNormalCreation === true
        ? blindProductionTargetNormalInstruction
        : productionTargetNormalInstruction
    }
  }
  return { title: `${base.title}${targetSuffix}`, instruction }
}
