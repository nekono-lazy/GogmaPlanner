import { alpha, type PaletteMode } from '@mui/material/styles'
import type { BonusRankMasterLookup } from '../domain/master/masterSelectors'
import { isExRank } from '../domain/master/masterSelectors'
import type { BonusRankId, BonusTypeId } from '../domain/models/publicTypes'

/**
 * Presentation-only colour coding of restoration bonus slots (Issue #69,
 * `docs/UI_FLOW.md` 3.4).
 *
 * A tone is a display family of the Bonus Type: it makes the five slots
 * easier to tell apart at a glance and carries no Domain meaning. The text
 * label stays the authority - `RestorationBonusSlots` never changes it - so
 * colour is only a secondary cue, and an EX rank - already named by the `EX`
 * text of its label - is set apart only by a stronger tint of its family
 * colour.
 *
 * The family is resolved from the stable `bonusTypeId`, never from a display
 * name. Normal-side and Gogma-side types of one meaning share a family, so a
 * converted weapon's inherited normal-scope slots read like the Gogma slots
 * that replace them. A `bonusTypeId` outside this table gets no tone: the
 * caller keeps the standard Chip style instead of guessing a family from the
 * ID text.
 */
export type RestorationBonusTone = 'attack' | 'affinity' | 'element' | 'sharpness_capacity'

const TONE_BY_BONUS_TYPE_ID: Readonly<Record<string, RestorationBonusTone>> = {
  'bonus_type.attack': 'attack',
  'bonus_type.affinity': 'affinity',
  'bonus_type.element': 'element',
  'bonus_type.normal_sharpness': 'sharpness_capacity',
  'bonus_type.normal_capacity': 'sharpness_capacity',
  'bonus_type.gogma_sharpness_capacity': 'sharpness_capacity',
}

export function resolveRestorationBonusTone(
  bonusTypeId: BonusTypeId,
): RestorationBonusTone | null {
  return TONE_BY_BONUS_TYPE_ID[bonusTypeId] ?? null
}

/**
 * Whether a rank is EX, by the Master `BonusRankMaster.isEx` authority.
 *
 * Display must not throw on a persisted rank the Master no longer knows, so a
 * missing rank is "not EX" here; entity validation reports it elsewhere.
 */
export function isRestorationBonusExRank(
  master: BonusRankMasterLookup,
  bonusRankId: BonusRankId,
): boolean {
  if (!master.bonusRanks.some(({ id }) => id === bonusRankId)) return false
  return isExRank(master, bonusRankId)
}

/** Label and outline colours of one tone. */
export interface RestorationBonusToneColor {
  text: string
  border: string
}

/**
 * Tone colours on the light theme.
 *
 * `text` is the label colour and the reference colour of the background
 * tint; it keeps at least 4.5:1 against white and against every tint used
 * below. `border` is a lighter shade of the same hue for the outline and keeps
 * at least 3:1 against the page background (`#f5f5f1`), the WCAG non-text
 * minimum. The amber family deliberately uses a dark brown-amber text and
 * reserves the yellow for the border, because a bright yellow label is not
 * readable on a white surface.
 */
export const RESTORATION_BONUS_TONE_COLORS: Readonly<
  Record<RestorationBonusTone, RestorationBonusToneColor>
> = {
  attack: { text: '#9c2a21', border: '#c2554d' },
  affinity: { text: '#5f3d9e', border: '#8f73c4' },
  element: { text: '#1b6a8f', border: '#3f8db3' },
  sharpness_capacity: { text: '#7a5200', border: '#ad7f16' },
}

/**
 * Tone colours on the dark theme (`docs/UI_FLOW.md` 3.4 / 3.5).
 *
 * The same four hue families as the Light table, lifted to light pastel
 * labels for the dark surface: `text` keeps at least 4.5:1 against the dark
 * `background.paper` (`#1a1f1c`) and against the strongest EX tint over it
 * (about 5:1 or more), and `border` - a mid shade of the same hue, darker
 * than the label - keeps at least 3:1 against both dark surfaces. Here the
 * amber family can use a yellow label, because a light yellow is readable on
 * a dark surface.
 */
export const RESTORATION_BONUS_DARK_TONE_COLORS: Readonly<
  Record<RestorationBonusTone, RestorationBonusToneColor>
> = {
  attack: { text: '#f2a59e', border: '#d16a61' },
  affinity: { text: '#c9b5ef', border: '#9c85d0' },
  element: { text: '#8fcde9', border: '#4d9dc4' },
  sharpness_capacity: { text: '#e8c56e', border: '#b58d26' },
}

/** The tone table of one theme mode. */
export function restorationBonusToneColors(
  mode: PaletteMode,
): Readonly<Record<RestorationBonusTone, RestorationBonusToneColor>> {
  return mode === 'dark' ? RESTORATION_BONUS_DARK_TONE_COLORS : RESTORATION_BONUS_TONE_COLORS
}

export type RestorationBonusChipVariant = 'filled' | 'outlined'

/** A plain `sx` object, so a caller can spread it next to its own layout rules. */
export interface RestorationBonusChipStyle {
  color: string
  borderColor: string
  bgcolor: string
  boxShadow: string
}

/** Background tint alpha of one variant: a normal rank and an EX rank. */
export interface RestorationBonusTintRule {
  normal: number
  ex: number
}

/**
 * Background tint strengths of one theme mode (`docs/UI_FLOW.md` 3.4 / 3.5).
 *
 * `outlined` keeps a transparent normal rank and `filled` keeps its light
 * normal-rank tint; EX is set apart only by a stronger tint of the same family
 * colour. On Light, one Material state-layer step is enough (0 -> 8% on
 * `outlined`, 10% -> 16% on `filled`). On Dark the same step barely shows,
 * because a pastel label tinted over a near-black surface moves the
 * background luminance very little, so Dark keeps the normal-rank tints and
 * widens only the EX step until an EX slot stands out among five before its
 * label is read. The Dark EX tints stay low enough that every Dark label keeps
 * at least 4.5:1 against its EX background on both Dark surfaces (about 5:1 at
 * worst), so the emphasis stays a quiet surface change, never a glow.
 */
export const RESTORATION_BONUS_TINT_RULES: Readonly<
  Record<PaletteMode, Readonly<Record<RestorationBonusChipVariant, RestorationBonusTintRule>>>
> = {
  light: {
    outlined: { normal: 0, ex: 0.08 },
    filled: { normal: 0.1, ex: 0.16 },
  },
  dark: {
    outlined: { normal: 0, ex: 0.18 },
    filled: { normal: 0.1, ex: 0.24 },
  },
}

/**
 * Chip `sx` for one slot.
 *
 * The two variants keep their existing contrast: `outlined` stays a
 * transparent chip with a coloured 1px border, `filled` stays a tinted chip
 * and draws its border as an inset ring so no Chip dimension changes. EX is
 * emphasised only by a stronger background tint of the same family colour
 * (`RESTORATION_BONUS_TINT_RULES`); the label colour, the label weight and the
 * border / ring strength are the same as a normal rank, because the `EX` text
 * already names the rank and the tint is a secondary cue. Nothing changes the
 * Chip's fixed box, so an EX slot is exactly as tall and wide as a normal one
 * and the five slots wrap the same way as before.
 *
 * `mode` selects the Light or Dark tone table and tint rule; the ring is the
 * same in both modes, so the one function stays the authority for every slot
 * display in either theme. Callers pass `theme.palette.mode`; omitting it
 * keeps the Light table and rule.
 */
export function restorationBonusChipSx(
  tone: RestorationBonusTone,
  isEx: boolean,
  variant: RestorationBonusChipVariant,
  mode: PaletteMode = 'light',
): RestorationBonusChipStyle {
  const { text, border } = restorationBonusToneColors(mode)[tone]
  const ringWidth = variant === 'outlined' ? 0 : 1
  const rule = RESTORATION_BONUS_TINT_RULES[mode][variant]
  const tint = isEx ? rule.ex : rule.normal
  return {
    color: text,
    borderColor: border,
    bgcolor: tint === 0 ? 'transparent' : alpha(text, tint),
    boxShadow: ringWidth === 0 ? 'none' : `inset 0 0 0 ${ringWidth}px ${border}`,
  }
}
