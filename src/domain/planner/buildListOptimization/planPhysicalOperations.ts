/**
 * Build List global optimization (`docs/PLANNER_SPEC.md` 17.7 / 17.13), Stage D' (moved from the Global Assignment Research
 * Phase 2-B physical summary, Issue #154).
 *
 * The physical operations of a finished ProductionPlan (`REQUIREMENTS.md` 22.1: one in-game operation per Step that advances a
 * Counter). Stream positions are replayed from the Planner-start origin in Plan order and cross-checked against each Step's own debug
 * start Counter when present. A Step that advances no Counter is counted apart by its operation type (`confirm_owned_ideal` is the
 * one such Step of a current Plan). A Step that advances two Counters, advances one by more than one, advances the Counter of another
 * stream than its operation's, or whose recorded start position is not the replayed one throws: the summary is never a guess.
 */
import type { ProductionPlan } from '../../models/publicTypes'
import type { PlannerInput } from '../plannerTypes'

export const PLAN_PHYSICAL_OPERATION_TYPES = ['create_normal_artian', 'convert_normal_to_gogma', 'reset_skills', 'reset_bonuses', 'keep_bonuses'] as const
export type PlanPhysicalOperationType = typeof PLAN_PHYSICAL_OPERATION_TYPES[number]
/** `skill`, `gogma`, or `normal:<NormalArtianCounter id>`. */
export type PlanPhysicalStreamKey = string

export interface PlanPhysicalStreamRange { readonly start: number; readonly end: number; readonly advance: number }

export interface PlanPhysicalSummary {
  readonly planSteps: number
  /** Steps that advance exactly one Counter by one. */
  readonly physicalOperations: number
  /** Steps that advance no Counter (`confirm_owned_ideal`), by operation type. Not physical operations. */
  readonly nonPhysicalSteps: Readonly<Record<string, number>>
  readonly operationCounts: Readonly<Record<PlanPhysicalOperationType, number>>
  readonly streams: Readonly<Record<PlanPhysicalStreamKey, PlanPhysicalStreamRange & { readonly weaponTypeId: string | null }>>
  readonly streamAdvanceSum: number
  /** physical operations === sum of stream advances (every physical operation advances exactly one Counter by one). */
  readonly identityHolds: boolean
  /** Steps whose primary Target is shared with other progressed Targets. */
  readonly sharedPhysicalSteps: number
  /** Compact executed positions, one per physical step in Plan order: [streamIndex, position, operationTypeIndex, targetIndex]. */
  readonly executed: { readonly streams: readonly PlanPhysicalStreamKey[]; readonly targets: readonly string[]; readonly rows: readonly (readonly [number, number, number, number])[] }
  readonly perTarget: Readonly<Record<string, { readonly physical: number; readonly byType: Readonly<Record<string, number>>; readonly byStream: Readonly<Record<PlanPhysicalStreamKey, number>> }>>
}

const operationTypeIndex = (type: string) => PLAN_PHYSICAL_OPERATION_TYPES.indexOf(type as PlanPhysicalOperationType)

export function physicalStreamKeyOfNormal(counterId: string): PlanPhysicalStreamKey { return `normal:${counterId}` }

/**
 * Reads the physical operations of a Plan. Stream positions are replayed from the Planner-start origin in Plan order and
 * cross-checked against each Step's own debug start Counter when present (fail closed on a mismatch).
 */
export function summarizePlanPhysicalOperations(plan: ProductionPlan, input: PlannerInput): PlanPhysicalSummary {
  const skillOrigin = input.rngState.skillCounter.value, gogmaOrigin = input.rngState.gogmaCounter.value
  if (skillOrigin === null || gogmaOrigin === null) throw new Error('Planner origin lacks a Skill / Gogma Counter.')
  const position = new Map<PlanPhysicalStreamKey, number>([['skill', skillOrigin], ['gogma', gogmaOrigin]])
  const origin = new Map(position)
  const weaponTypeOf = new Map<PlanPhysicalStreamKey, string | null>([['skill', null], ['gogma', null]])
  for (const counter of input.normalCounters) {
    if (counter.counter === null) continue
    position.set(physicalStreamKeyOfNormal(counter.id), counter.counter)
    origin.set(physicalStreamKeyOfNormal(counter.id), counter.counter)
    weaponTypeOf.set(physicalStreamKeyOfNormal(counter.id), counter.weaponTypeId)
  }
  const operationCounts = Object.fromEntries(PLAN_PHYSICAL_OPERATION_TYPES.map(type => [type, 0])) as Record<PlanPhysicalOperationType, number>
  const nonPhysicalSteps: Record<string, number> = {}
  const streams: PlanPhysicalStreamKey[] = [], targets: string[] = []
  const rows: [number, number, number, number][] = []
  const perTarget: Record<string, { physical: number; byType: Record<string, number>; byStream: Record<string, number> }> = {}
  let sharedPhysicalSteps = 0
  for (const step of plan.steps) {
    const { skillCounterDelta: skill, gogmaCounterDelta: gogma, normalCounterDelta: normal, affectedNormalCounterId } = step.rngAdvance
    const advanced = [skill, gogma, normal ?? 0]
    if (advanced.every(delta => delta === 0)) {
      if (operationTypeIndex(step.operationType) >= 0) throw new Error(`Physical operation ${step.operationType} advanced no Counter.`)
      nonPhysicalSteps[step.operationType] = (nonPhysicalSteps[step.operationType] ?? 0) + 1
      continue
    }
    if (advanced.filter(delta => delta !== 0).length !== 1 || advanced.some(delta => delta !== 0 && delta !== 1)) {
      throw new Error(`Step ${step.id} does not advance exactly one Counter by one.`)
    }
    const typeIndex = operationTypeIndex(step.operationType)
    if (typeIndex < 0) throw new Error(`Unknown physical operation ${step.operationType}.`)
    const stream: PlanPhysicalStreamKey = skill === 1 ? 'skill' : gogma === 1 ? 'gogma' : physicalStreamKeyOfNormal(affectedNormalCounterId ?? '')
    const expected = (step.operationType === 'create_normal_artian' && !stream.startsWith('normal:')) ||
      ((step.operationType === 'reset_bonuses' || step.operationType === 'keep_bonuses') && stream !== 'gogma') ||
      ((step.operationType === 'reset_skills' || step.operationType === 'convert_normal_to_gogma') && stream !== 'skill')
    if (expected) throw new Error(`Operation ${step.operationType} advanced ${stream}.`)
    const at = position.get(stream)
    if (at === undefined) throw new Error(`No Planner-start origin for stream ${stream}.`)
    const debugStart = stream === 'skill' ? step.debug?.startSkillCounter : stream === 'gogma' ? step.debug?.startGogmaCounter : step.debug?.startNormalCounter
    if (debugStart !== undefined && debugStart !== null && debugStart !== at) throw new Error(`Step ${step.id} debug start ${debugStart} differs from replayed ${at} (${stream}).`)
    position.set(stream, at + 1)
    operationCounts[step.operationType as PlanPhysicalOperationType] += 1
    const target = step.targetWeaponId ?? '(none)'
    if (!streams.includes(stream)) streams.push(stream)
    if (!targets.includes(target)) targets.push(target)
    rows.push([streams.indexOf(stream), at, typeIndex, targets.indexOf(target)])
    const entry = perTarget[target] ??= { physical: 0, byType: {}, byStream: {} }
    entry.physical += 1
    entry.byType[step.operationType] = (entry.byType[step.operationType] ?? 0) + 1
    entry.byStream[stream] = (entry.byStream[stream] ?? 0) + 1
    if ((step.progressedTargetWeaponIds?.length ?? 0) > 1) sharedPhysicalSteps += 1
  }
  const ranges: Record<PlanPhysicalStreamKey, PlanPhysicalStreamRange & { weaponTypeId: string | null }> = {}
  for (const [key, end] of position) {
    const start = origin.get(key)!
    if (end !== start || key === 'skill' || key === 'gogma') ranges[key] = { start, end, advance: end - start, weaponTypeId: weaponTypeOf.get(key) ?? null }
  }
  const physicalOperations = rows.length
  const streamAdvanceSum = Object.values(ranges).reduce((sum, range) => sum + range.advance, 0)
  return { planSteps: plan.steps.length, physicalOperations, nonPhysicalSteps, operationCounts, streams: ranges, streamAdvanceSum,
    identityHolds: streamAdvanceSum === physicalOperations, sharedPhysicalSteps, executed: { streams, targets, rows }, perTarget }
}
