import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { CompletionBonusVariant, RestorationBonusSet } from '../../domain/models/publicTypes'
import { createDefaultBonusSet } from '../../domain/forms/entityDrafts'
import {
  completionBonusVariantFromBonuses,
  completionVariantMinimumBonuses,
  findCompletionVariantConflicts,
  type CompletionVariantConflict,
} from '../../domain/target/completionCondition'
import { BonusSlotList } from '../ManagementListItem'
import { StatusChip } from '../StatusChip'
import { BonusSetEditor } from './BonusSetEditor'
import {
  COMPLETION_VARIANTS_ADD_HELP_TEXT,
  COMPLETION_VARIANTS_HELP_TEXT,
  COMPLETION_VARIANTS_MINIMUM_NOTE,
  COMPLETION_VARIANTS_MINIMUM_RANK_HELP_TEXT,
  completionVariantConflictBadge,
  completionVariantConflictMessage,
  completionVariantConflictShortReason,
  completionVariantConflictSummary,
  completionVariantHeading,
  minimumRankSlotLabel,
} from '../target/completionConditionPresentation'

interface CompletionBonusVariantsEditorProps {
  master: MasterDataRoot
  weaponTypeId: string
  elementId: string
  value: CompletionBonusVariant[]
  onChange(value: CompletionBonusVariant[]): void
  /** A fresh UI editing key for an added Variant (never part of any hash or judgement). */
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

/**
 * The completion bonus Variant editor (`docs/UI_FLOW.md` 8, Issue #100 PR-4).
 *
 * Every Variant is one card: its heading, its five slots as a summary (each
 * slot read as 「… III以上」, the highest rank as 「… EX」), the reason it cannot be saved, and its own
 * actions - 「5枠を編集」 (a disclosure of the slot Selects once there are two
 * or more Variants), 「この構成を複製」 and 「削除」. Collapsed cards keep the
 * summary, so every Variant stays comparable at a glance however many there
 * are. 「新しい構成を追加」 starts from the draft's initial value; a duplicate
 * starts from the very Variant it copies, with an independent editing ID, and
 * leaves the original untouched. New Variants are appended, so no existing
 * Variant is renumbered by an addition. The order carries no preference.
 *
 * A duplicate or included Variant is named on its card and in a summary above
 * the cards, from `findCompletionVariantConflicts()` - the authority the save
 * validation uses - and the save still re-validates. Focus follows every
 * structural change (the new card's heading, or the card that took a deleted
 * card's place), and a polite status region says what happened.
 */
export function CompletionBonusVariantsEditor({
  master,
  weaponTypeId,
  elementId,
  value,
  onChange,
  createVariantId,
  reviewNote = null,
}: CompletionBonusVariantsEditorProps) {
  const headingId = useId()
  const helpId = useId()
  const addHelpId = useId()
  const baseId = useId()
  const single = value.length === 1
  // The open state of each card's slot editor; a lone Variant is always open.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(value.length === 1 ? [value[0]!.id] : []),
  )
  // Variant id -> the id it was duplicated from, while it is still that
  // untouched copy: the duplicate it is right after 「この構成を複製」 is said
  // as such rather than as a mistake.
  const [duplicatedFrom, setDuplicatedFrom] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [announcement, setAnnouncement] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const headingRefs = useRef(new Map<string, HTMLElement>())
  const pendingFocusId = useRef<string | null>(null)

  useEffect(() => {
    const id = pendingFocusId.current
    if (id === null) return
    const heading = headingRefs.current.get(id)
    if (heading) {
      pendingFocusId.current = null
      heading.focus()
    }
  })

  let conflicts: CompletionVariantConflict[] = []
  try {
    conflicts = findCompletionVariantConflicts(value, master)
  } catch {
    // A stored rank Master no longer knows: the save validation reports it.
    conflicts = []
  }
  const conflictOf = (index: number) => conflicts.find((conflict) => conflict.index === index) ?? null
  const justDuplicatedFrom = (variant: CompletionBonusVariant, conflict: CompletionVariantConflict | null): number | null => {
    const sourceId = duplicatedFrom.get(variant.id)
    if (conflict === null || conflict.kind !== 'duplicate' || sourceId === undefined) return null
    return value[conflict.otherIndex]?.id === sourceId ? conflict.otherIndex : null
  }
  const isExpanded = (variant: CompletionBonusVariant) => single || expandedIds.has(variant.id)
  const variantIds = (index: number) => ({
    heading: `${baseId}-variant-${index}-heading`,
    editor: `${baseId}-variant-${index}-editor`,
    error: `${baseId}-variant-${index}-error`,
  })

  const focusHeading = (id: string) => headingRefs.current.get(id)?.focus()
  const setExpanded = (ids: Iterable<string>, open: boolean) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (open) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }
  /**
   * Appends a Variant and moves focus to it. It becomes the one open card: the
   * others fold to their summaries, so the card being edited is unmistakable
   * and every other Variant stays visible for comparison.
   */
  const append = (variant: CompletionBonusVariant, message: string) => {
    onChange([...value, variant])
    setExpandedIds(new Set([variant.id]))
    setAnnouncement(message)
    setAddError(null)
    pendingFocusId.current = variant.id
  }

  const update = (index: number, bonuses: RestorationBonusSet) => {
    const variant = value[index]
    if (variant === undefined) return
    onChange(value.map((current, i) => (i === index ? completionBonusVariantFromBonuses(bonuses, current.id) : current)))
    if (duplicatedFrom.has(variant.id)) {
      setDuplicatedFrom((current) => {
        const next = new Map(current)
        next.delete(variant.id)
        return next
      })
    }
  }
  const add = () => {
    let bonuses: RestorationBonusSet
    try {
      bonuses = createDefaultBonusSet(master, weaponTypeId, elementId, 'gogma_artian')
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : '初期値を用意できないため、構成を追加できません。')
      return
    }
    const heading = completionVariantHeading(value.length)
    append(
      completionBonusVariantFromBonuses(bonuses, createVariantId()),
      `${heading}を追加しました。初期値から5枠を選んでください。`,
    )
  }
  const duplicate = (index: number) => {
    const source = value[index]
    if (source === undefined) return
    // A new editing ID: the copy is edited on its own and the source never changes.
    const copy = completionBonusVariantFromBonuses(completionVariantMinimumBonuses(source), createVariantId())
    setDuplicatedFrom((current) => new Map(current).set(copy.id, source.id))
    append(
      copy,
      `${completionVariantHeading(index)}を複製し、${completionVariantHeading(value.length)}として追加しました。一部の枠を変更してください。`,
    )
  }
  const remove = (index: number) => {
    const removed = value[index]
    if (removed === undefined || value.length <= 1) return
    const remaining = value.filter((_, i) => i !== index)
    onChange(remaining)
    setExpanded([removed.id], false)
    setDuplicatedFrom((current) => {
      const next = new Map(current)
      next.delete(removed.id)
      for (const [id, sourceId] of current) if (sourceId === removed.id) next.delete(id)
      return next
    })
    const renumbered = index < remaining.length
    setAnnouncement(
      `${completionVariantHeading(index)}を削除しました。${renumbered ? '後ろの構成の番号が1つずつ繰り上がりました。' : ''}`,
    )
    // The card that took its place, or the new last card.
    pendingFocusId.current = (remaining[index] ?? remaining[index - 1])!.id
  }

  return (
    <Stack spacing={1.5} component="section" aria-labelledby={headingId}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography id={headingId} component="h3" variant="h3">完成ボーナス構成</Typography>
        <Typography variant="body2" color="text.secondary" className="tabular-nums">{value.length}件</Typography>
      </Stack>
      {reviewNote !== null && (
        <Alert severity="warning" variant="outlined">{reviewNote}</Alert>
      )}
      <Stack id={helpId} spacing={0.5}>
        <Typography variant="body2" color="text.secondary">{COMPLETION_VARIANTS_HELP_TEXT}</Typography>
        <Typography variant="body2" color="text.secondary">{COMPLETION_VARIANTS_MINIMUM_RANK_HELP_TEXT}</Typography>
      </Stack>
      {conflicts.length > 0 && (
        // The summary of what blocks the save; each item moves to its card.
        <Alert severity="error">
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {completionVariantConflictSummary(conflicts.length)}
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
                    {completionVariantConflictShortReason(conflict)}
                  </Button>
                </li>
              )
            })}
          </Box>
        </Alert>
      )}
      {!single && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button variant="text" onClick={() => setExpanded(value.map(({ id }) => id), true)} sx={{ minHeight: 44 }}>
            すべての構成を開く
          </Button>
          <Button variant="text" onClick={() => setExpandedIds(new Set())} sx={{ minHeight: 44 }}>
            すべての構成を閉じる
          </Button>
        </Stack>
      )}
      <Box component="ul" aria-labelledby={headingId} sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1.5 }}>
        {value.map((variant, index) => {
          const conflict = conflictOf(index)
          const duplicatedFromIndex = justDuplicatedFrom(variant, conflict)
          const expanded = isExpanded(variant)
          const ids = variantIds(index)
          const heading = completionVariantHeading(index)
          const describedBy = conflict ? `${ids.heading} ${ids.error}` : ids.heading
          return (
            <Box
              component="li"
              key={variant.id}
              aria-labelledby={ids.heading}
              sx={{
                p: { xs: 1.5, sm: 2 },
                minWidth: 0,
                border: expanded && !single ? 2 : 1,
                borderColor: conflict
                  ? duplicatedFromIndex === null ? 'error.main' : 'warning.main'
                  : expanded && !single ? 'primary.main' : 'divider',
                borderRadius: 1,
              }}
            >
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography
                    id={ids.heading}
                    ref={(element: HTMLElement | null) => {
                      if (element) headingRefs.current.set(variant.id, element)
                      else headingRefs.current.delete(variant.id)
                    }}
                    tabIndex={-1}
                    component="h4"
                    variant="subtitle1"
                    sx={{ fontWeight: 700 }}
                  >
                    {heading}
                  </Typography>
                  {conflict && (
                    <StatusChip
                      label={completionVariantConflictBadge(conflict, duplicatedFromIndex !== null)}
                      tone="caution"
                    />
                  )}
                  {expanded && !single && <StatusChip label="編集中" tone="info" />}
                </Stack>
                {!expanded && (
                  <BonusSlotList
                    heading="各枠の種類と最低ランク（順不同）"
                    bonuses={completionVariantMinimumBonuses(variant)}
                    weaponTypeId={weaponTypeId}
                    master={master}
                    scope="gogma_artian"
                    formatLabel={(label, bonusRankId) => minimumRankSlotLabel(label, bonusRankId, master)}
                  />
                )}
                {conflict && (
                  <Typography
                    id={ids.error}
                    variant="body2"
                    // `main` is the theme's text-safe tone in both Light and Dark (`docs/UI_FLOW.md` 3.5).
                    sx={{ color: duplicatedFromIndex === null ? 'error.main' : 'warning.main', overflowWrap: 'anywhere' }}
                  >
                    {completionVariantConflictMessage(conflict, duplicatedFromIndex)}
                  </Typography>
                )}
                {expanded && (
                  <Box
                    id={ids.editor}
                    role="group"
                    aria-labelledby={ids.heading}
                    aria-describedby={conflict ? `${ids.error} ${helpId}` : helpId}
                  >
                    <BonusSetEditor
                      label={heading}
                      master={master}
                      weaponTypeId={weaponTypeId}
                      elementId={elementId}
                      scope="gogma_artian"
                      rankLabel="最低ランク"
                      rankOptionLabel={(rankName, bonusRankId) => minimumRankSlotLabel(rankName, bonusRankId, master)}
                      headingComponent="none"
                      value={completionVariantMinimumBonuses(variant)}
                      onChange={(bonuses) => update(index, bonuses)}
                    />
                  </Box>
                )}
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  {!single && (
                    <Button
                      variant="outlined"
                      aria-expanded={expanded}
                      {...(expanded ? { 'aria-controls': ids.editor } : {})}
                      aria-describedby={describedBy}
                      onClick={() => setExpanded([variant.id], !expanded)}
                      sx={{ minHeight: 44 }}
                    >
                      {expanded ? '編集を閉じる' : '5枠を編集'}
                    </Button>
                  )}
                  <Button
                    variant="outlined"
                    aria-describedby={describedBy}
                    onClick={() => duplicate(index)}
                    sx={{ minHeight: 44 }}
                  >
                    この構成を複製
                  </Button>
                  <Button
                    color="error"
                    disabled={single}
                    aria-describedby={describedBy}
                    onClick={() => remove(index)}
                    sx={{ minHeight: 44, ml: 'auto' }}
                  >
                    削除
                  </Button>
                </Stack>
              </Stack>
            </Box>
          )
        })}
      </Box>
      {single && (
        <Typography variant="body2" color="text.secondary">{COMPLETION_VARIANTS_MINIMUM_NOTE}</Typography>
      )}
      <Stack spacing={0.75} sx={{ alignItems: 'flex-start' }}>
        <Button variant="outlined" onClick={add} aria-describedby={addHelpId} sx={{ minHeight: 44 }}>
          新しい構成を追加
        </Button>
        <Typography id={addHelpId} variant="body2" color="text.secondary">
          {COMPLETION_VARIANTS_ADD_HELP_TEXT}
        </Typography>
        {addError !== null && (
          <Typography role="alert" variant="body2" color="error">{addError}</Typography>
        )}
      </Stack>
      <Box role="status" aria-atomic="true" sx={visuallyHiddenSx}>{announcement}</Box>
    </Stack>
  )
}
