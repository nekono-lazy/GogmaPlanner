import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CompletionSkillVariant } from '../../domain/models/publicTypes'
import {
  findCompletionSkillVariantConflicts,
  type CompletionSkillVariantConflict,
} from '../../domain/target/completionSkillVariants'
import { StatusChip } from '../StatusChip'
import { SkillConditionFields } from './SkillConditionEditor'
import {
  COMPLETION_SKILL_VARIANTS_ADD_HELP_TEXT,
  COMPLETION_SKILL_VARIANTS_MINIMUM_NOTE,
  COMPLETION_SKILL_VARIANTS_MULTIPLE_HELP_TEXT,
  completionSkillVariantConflictBadge,
  completionSkillVariantConflictMessage,
  completionSkillVariantConflictShortReason,
  completionSkillVariantConflictSummary,
  completionSkillVariantHeading,
} from '../target/completionConditionPresentation'

interface CompletionSkillVariantsEditorProps {
  master: MasterDataRoot
  value: CompletionSkillVariant[]
  onChange(value: CompletionSkillVariant[]): void
  /** A fresh UI editing key for an added configuration (never part of any hash or judgement). */
  createVariantId(): string
  /** What the completion condition review asks of this section (`docs/UI_FLOW.md` 8.4), if anything. */
  reviewNote?: string | null
}

/** Read by a screen reader, never shown: the result of add / duplicate / delete. */
const visuallyHiddenSx = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  p: 0,
  m: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const

const HELP_TEXT = '指定したスキルはすべて一致する必要があります。指定なしの項目は条件にしません。'

/**
 * The completion Skill configuration editor (`docs/UI_FLOW.md` 8, Issue #367),
 * shaped like the completion bonus Variant editor.
 *
 * One configuration reads like the former single Skill condition: the Series
 * and Group Selects with 「この構成を複製」 and a disabled 「削除」, the reason
 * beside it - no card, no heading of its own. Two or more configurations
 * become one card each (its heading - a name, never a preference - its
 * Selects, the reason it cannot be saved, 「この構成を複製」 and 「削除」) under
 * the note that any one of them completes the Skill side. Every configuration
 * is shown and edited, so none is ever lost.
 *
 * 「新しいスキル構成を追加」 appends a configuration with both Skills 「指定なし」;
 * 「この構成を複製」 appends a copy of that configuration's Skills with a new
 * editing ID and leaves the source untouched. Either way focus moves to the new
 * card's Series Select, and no existing configuration is renumbered. A
 * deletion changes the draft only and moves focus to the heading of the card
 * that took its place (the new last card, or the section heading once one
 * configuration is left). A polite status region says what happened.
 *
 * Duplicate and included configurations come from
 * `findCompletionSkillVariantConflicts()` - the authority the save validation
 * uses - and are named on the card, in words, with the configuration they
 * conflict with and the way out; a summary above the cards moves to each. An
 * untouched copy right after 「この構成を複製」 is still a duplicate that cannot
 * be saved, said as such; nothing is changed for the user. The save still
 * re-validates; nothing is judged here.
 */
export function CompletionSkillVariantsEditor({
  master,
  value,
  onChange,
  createVariantId,
  reviewNote = null,
}: CompletionSkillVariantsEditorProps) {
  const headingId = useId()
  const helpId = useId()
  const addHelpId = useId()
  const baseId = useId()
  const single = value.length === 1
  const [announcement, setAnnouncement] = useState('')
  // Configuration id -> the id it was duplicated from, while it is still that
  // untouched copy: its duplicate conflict is said to come from 「この構成を複製」.
  const [duplicatedFrom, setDuplicatedFrom] = useState<ReadonlyMap<string, string>>(() => new Map())
  const sectionHeadingRef = useRef<HTMLElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const pendingFocus = useRef<{ id: string; target: 'select' | 'heading' } | null>(null)

  useEffect(() => {
    const pending = pendingFocus.current
    if (pending === null) return
    pendingFocus.current = null
    const card = cardRefs.current.get(pending.id)
    const element = card === undefined
      ? null
      : pending.target === 'select'
        ? card.querySelector<HTMLElement>('[role="combobox"]')
        : card.querySelector<HTMLElement>('[data-skill-variant-heading]')
    // One configuration left has no heading of its own: the section heading takes focus.
    if (element) element.focus()
    else sectionHeadingRef.current?.focus()
  })

  const conflicts = findCompletionSkillVariantConflicts(value)
  const conflictOf = (index: number) => conflicts.find((conflict) => conflict.index === index) ?? null
  const justDuplicatedFrom = (variant: CompletionSkillVariant, conflict: CompletionSkillVariantConflict | null): number | null => {
    const sourceId = duplicatedFrom.get(variant.id)
    if (conflict === null || conflict.kind !== 'duplicate' || sourceId === undefined) return null
    return value[conflict.otherIndex]?.id === sourceId ? conflict.otherIndex : null
  }
  const ids = (index: number) => ({
    heading: `${baseId}-skill-variant-${index}-heading`,
    error: `${baseId}-skill-variant-${index}-error`,
  })
  const focusHeading = (id: string) => cardRefs.current.get(id)?.querySelector<HTMLElement>('[data-skill-variant-heading]')?.focus()

  const forgetDuplicate = (id: string) => {
    if (!duplicatedFrom.has(id)) return
    setDuplicatedFrom((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }
  const update = (index: number, next: Pick<CompletionSkillVariant, 'seriesSkillId' | 'groupSkillId'>) => {
    const variant = value[index]
    if (variant === undefined) return
    onChange(value.map((current, i) => (i === index ? { ...current, seriesSkillId: next.seriesSkillId, groupSkillId: next.groupSkillId } : current)))
    forgetDuplicate(variant.id)
  }
  /** Appends a configuration and moves focus to its Series Select: the first thing to choose. */
  const append = (variant: CompletionSkillVariant, message: string) => {
    onChange([...value, variant])
    setAnnouncement(message)
    pendingFocus.current = { id: variant.id, target: 'select' }
  }
  const add = () => {
    append(
      { id: createVariantId(), seriesSkillId: null, groupSkillId: null },
      `${completionSkillVariantHeading(value.length)}を追加しました。シリーズ・グループのスキルを選んでください。`,
    )
  }
  const duplicate = (index: number) => {
    const source = value[index]
    if (source === undefined) return
    // A new editing ID: the copy is edited on its own and the source never changes.
    const copy: CompletionSkillVariant = { id: createVariantId(), seriesSkillId: source.seriesSkillId, groupSkillId: source.groupSkillId }
    setDuplicatedFrom((current) => new Map(current).set(copy.id, source.id))
    append(
      copy,
      `${completionSkillVariantHeading(index)}を複製し、${completionSkillVariantHeading(value.length)}として追加しました。このままでは同じ内容のため保存できません。シリーズかグループのスキルを変更してください。`,
    )
  }
  const remove = (index: number) => {
    const removed = value[index]
    if (removed === undefined || value.length <= 1) return
    const remaining = value.filter((_, i) => i !== index)
    onChange(remaining)
    setDuplicatedFrom((current) => {
      const next = new Map(current)
      next.delete(removed.id)
      for (const [id, sourceId] of current) if (sourceId === removed.id) next.delete(id)
      return next
    })
    const renumbered = index < remaining.length
    setAnnouncement(
      `${completionSkillVariantHeading(index)}を削除しました。${renumbered ? '後ろの構成の番号が1つずつ繰り上がりました。' : ''}${remaining.length === 1 ? '完成スキル構成は残り1件です。' : ''}`,
    )
    // The card that took its place, or the new last card.
    pendingFocus.current = { id: (remaining[index] ?? remaining[index - 1])!.id, target: 'heading' }
  }

  return (
    <Stack spacing={1.5} component="section" aria-labelledby={headingId}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography
          id={headingId}
          ref={(element: HTMLElement | null) => { sectionHeadingRef.current = element }}
          tabIndex={-1}
          component="h3"
          variant="h3"
        >
          完成スキル構成
        </Typography>
        {!single && <Typography variant="body2" color="text.secondary" className="tabular-nums">{value.length}件</Typography>}
      </Stack>
      {reviewNote !== null && <Alert severity="warning" variant="outlined">{reviewNote}</Alert>}
      <Stack id={helpId} spacing={0.5}>
        {!single && <Typography variant="body2" color="text.secondary">{COMPLETION_SKILL_VARIANTS_MULTIPLE_HELP_TEXT}</Typography>}
        <Typography variant="body2" color="text.secondary">{HELP_TEXT}</Typography>
      </Stack>
      {conflicts.length > 0 && (
        // The summary of what blocks the save; each item moves to its card.
        <Alert severity="error">
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {completionSkillVariantConflictSummary(conflicts.length)}
          </Typography>
          <Box component="ul" sx={{ m: 0, mt: 0.5, p: 0, listStyle: 'none' }}>
            {conflicts.map((conflict) => {
              const variant = value[conflict.index]
              if (variant === undefined) return null
              return (
                <li key={variant.id}>
                  <Button
                    variant="text"
                    color="inherit"
                    onClick={() => focusHeading(variant.id)}
                    sx={{ minHeight: 44, px: 0.5, textAlign: 'left', textDecoration: 'underline' }}
                  >
                    {completionSkillVariantConflictShortReason(conflict)}
                  </Button>
                </li>
              )
            })}
          </Box>
        </Alert>
      )}
      <Box component="ul" aria-labelledby={headingId} sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1.5 }}>
        {value.map((variant, index) => {
          const conflict = conflictOf(index)
          const duplicatedFromIndex = justDuplicatedFrom(variant, conflict)
          const heading = completionSkillVariantHeading(index)
          const { heading: cardHeadingId, error: errorId } = ids(index)
          // An untouched copy is the expected state right after 「この構成を複製」: a caution, not a mistake.
          const conflictTone = duplicatedFromIndex === null ? 'error.main' : 'warning.main'
          const describedBy = single ? headingId : cardHeadingId
          return (
            <Box
              component="li"
              key={variant.id}
              ref={(element: HTMLElement | null) => {
                if (element) cardRefs.current.set(variant.id, element)
                else cardRefs.current.delete(variant.id)
              }}
              aria-labelledby={single ? headingId : cardHeadingId}
              data-skill-variant-card=""
              sx={single ? { minWidth: 0 } : {
                p: { xs: 1.5, sm: 2 },
                minWidth: 0,
                border: 1,
                borderColor: conflict ? conflictTone : 'divider',
                borderRadius: 1,
              }}
            >
              <Stack spacing={1.25}>
                {!single && (
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography
                      id={cardHeadingId}
                      data-skill-variant-heading=""
                      tabIndex={-1}
                      component="h4"
                      variant="subtitle1"
                      sx={{ fontWeight: 700 }}
                    >
                      {heading}
                    </Typography>
                    {conflict && <StatusChip label={completionSkillVariantConflictBadge(conflict)} tone="caution" />}
                  </Stack>
                )}
                <SkillConditionFields
                  master={master}
                  value={variant}
                  onChange={(next) => update(index, next)}
                  describedBy={conflict ? `${errorId} ${helpId}` : helpId}
                />
                {conflict && (
                  <Typography
                    id={errorId}
                    variant="body2"
                    // `main` is the theme's text-safe tone in both Light and Dark (`docs/UI_FLOW.md` 3.5).
                    sx={{ color: conflictTone, overflowWrap: 'anywhere' }}
                  >
                    {completionSkillVariantConflictMessage(conflict, value, master, duplicatedFromIndex)}
                  </Typography>
                )}
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  {single && (
                    <Typography variant="body2" color="text.secondary">{COMPLETION_SKILL_VARIANTS_MINIMUM_NOTE}</Typography>
                  )}
                  <Button
                    variant="outlined"
                    aria-describedby={describedBy}
                    onClick={() => duplicate(index)}
                    sx={{ minHeight: 44, ml: single ? 'auto' : 0 }}
                  >
                    この構成を複製
                  </Button>
                  <Button
                    color="error"
                    disabled={single}
                    aria-label={`${heading}を削除`}
                    onClick={() => remove(index)}
                    sx={{ minHeight: 44, ml: single ? 0 : 'auto' }}
                  >
                    削除
                  </Button>
                </Stack>
              </Stack>
            </Box>
          )
        })}
      </Box>
      <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
        <Button variant="outlined" onClick={add} aria-describedby={addHelpId} sx={{ minHeight: 44 }}>
          新しいスキル構成を追加
        </Button>
        <Typography id={addHelpId} variant="body2" color="text.secondary">{COMPLETION_SKILL_VARIANTS_ADD_HELP_TEXT}</Typography>
      </Stack>
      <Box role="status" aria-atomic="true" sx={visuallyHiddenSx}>{announcement}</Box>
    </Stack>
  )
}
