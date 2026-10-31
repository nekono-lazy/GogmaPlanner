import { useId, type ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Alert, Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { StatusChip } from '../StatusChip'
import type { BatchCandidateResearchSummary, BatchCandidateResearchTargetOutcome } from '../../services/search/batchStaleCandidateReplacement'
import type {
  BatchCandidateSearchProgress,
  BatchCandidateSearchSummary,
  BatchCandidateSearchTargetOutcome,
  BatchCandidateSearchTermination,
} from '../../services/search/batchCandidateSearch'
import { candidateSearchProgressPhaseLabels } from '../../presentation/labels'
import {
  BATCH_RESEARCH_KEPT_NOTE,
  BATCH_RESEARCH_SUMMARY_COUNTS_LABEL,
  BATCH_RESEARCH_SUMMARY_TITLE,
  batchResearchRefusalReasonLabels,
} from './batchStaleCandidateReplacementPresentation'
import { batchSourceExclusionCountNote, sourceExclusionConditionLabel } from './sourceExclusionPresentation'

type NotAddedReason = Extract<BatchCandidateSearchTargetOutcome, { status: 'not_added' }>['reason']

/** Why a found Candidate was not added: the Service result, never a guess. */
const batchNotAddedReasonLabels: Record<NotAddedReason, string> = {
  duplicate: '同じ候補が作成リストに登録済みのため、追加しませんでした。',
  replacement_required: '別の候補が作成リストに登録済みのため、追加しませんでした（置き換えは行っていません）。',
  legacy_duplicate: '作成リストに複数の候補が登録されているため、追加しませんでした。作成リストで整理してください。',
}

export function BatchCandidateSearchProgressPanel({
  progress,
  cancelling,
  onCancel,
  title = '一括検索・追加中',
  cancelLabel = '一括検索をキャンセル',
}: {
  progress: BatchCandidateSearchProgress
  cancelling: boolean
  onCancel: () => void
  /** The operation running: 「未登録を一括検索・追加」 by default, or 「再検索が必要な候補を一括再検索・置換」 (9.3). */
  title?: string
  cancelLabel?: string
}) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      role="status"
      aria-live="polite"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component="h2" variant="h2">
            {title}
          </Typography>
          <StatusChip label={candidateSearchProgressPhaseLabels[progress.search.phase]} tone="info" />
        </Stack>
        {/* Each Target's work is discovered while searching and differs per
            Target, so neither the Target nor the batch becomes a percent. */}
        <LinearProgress aria-label="一括検索の進捗" />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 3 }} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography variant="body2" className="tabular-nums" sx={{ fontWeight: 500 }}>
            {progress.index + 1} / {progress.total} 件目
          </Typography>
          <Typography variant="body2" className="tabular-nums">
            完了: {progress.completed} / {progress.total}件
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 3 }} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            対象: {progress.target.name}
          </Typography>
          <Typography variant="body2" className="tabular-nums">
            探索ステップ: {progress.search.processedWorkItems}
          </Typography>
        </Stack>
        {/* The condition the whole batch started with, not the Checkbox now (`docs/UI_FLOW.md` 9.1 / 9.2). */}
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {sourceExclusionConditionLabel(progress.excludeOtherTargetSources)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          目標武器ごとに探索量が異なり、探索ステップの総数も検索中に増えるため、全体の進捗率は表示しません。
        </Typography>
        <Button
          variant="outlined"
          onClick={onCancel}
          disabled={cancelling}
          sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          {cancelling ? 'キャンセル中…' : cancelLabel}
        </Button>
      </Stack>
    </Paper>
  )
}

/** One Target of a summary group; `note` sits beside the name (e.g. how many weapons its search excluded). */
interface TargetListItem {
  key: string
  name: string
  note?: string
  detail?: string
}

function TargetList({ items }: { items: readonly TargetListItem[] }) {
  return (
    <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
      {items.map((item, index) => (
        <Box
          component="li"
          key={item.key}
          sx={{ minWidth: 0, borderTop: index === 0 ? 0 : 1, borderColor: 'divider', pt: index === 0 ? 0 : 1 }}
        >
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
            {item.name}
            {item.note && (
              <Box component="span" sx={{ fontWeight: 400 }}>
                {item.note}
              </Box>
            )}
          </Typography>
          {item.detail && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {item.detail}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  )
}

/** One outcome group of a finished batch: its label, its Targets, and whether it is listed even when empty. */
interface SummaryGroup {
  key: string
  label: string
  items: TargetListItem[]
  /** A group shown among the counts only while it has members (「未処理」, which exists only after a stop). */
  countedOnlyWhenPresent?: boolean
}

/**
 * The layout every finished batch of this screen shares (`docs/UI_FLOW.md` 9.1
 * / 9.3): the heading with the exclusion condition the batch ran with, the
 * termination notice, the counts per outcome group in text, each non-empty
 * group's Targets behind a disclosure, the caller's supplement and the Build
 * List link. The groups and the notices are the caller's; nothing here judges
 * an outcome.
 */
function BatchSummaryLayout({
  title,
  countsLabel,
  excludeOtherTargetSources,
  termination,
  completedMessage,
  cancelledMessage,
  groups,
  supplement,
}: {
  title: string
  countsLabel: string
  excludeOtherTargetSources: boolean
  termination: BatchCandidateSearchTermination
  completedMessage: string
  cancelledMessage: string
  groups: readonly SummaryGroup[]
  supplement: ReactNode
}) {
  const headingId = useId()
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={2}>
        <Box>
          <Typography id={headingId} component="h2" variant="h2">
            {title}
          </Typography>
          {/* The condition this batch ran with; a later Checkbox change never relabels it. */}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {sourceExclusionConditionLabel(excludeOtherTargetSources)}
          </Typography>
        </Box>
        {termination.status === 'completed' && <Alert severity="success">{completedMessage}</Alert>}
        {termination.status === 'cancelled' && <Alert severity="info">{cancelledMessage}</Alert>}
        {termination.status === 'aborted' && (
          <Alert severity="error">
            {termination.message} 以降の目標武器は検索していません。
          </Alert>
        )}
        <Box
          component="ul"
          aria-label={countsLabel}
          sx={{
            m: 0,
            p: 0,
            listStyle: 'none',
            display: 'grid',
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(auto-fit, minmax(8rem, 1fr))' },
            gap: 1,
          }}
        >
          {groups
            .filter(({ countedOnlyWhenPresent, items }) => !countedOnlyWhenPresent || items.length > 0)
            .map(({ key, label, items }) => (
              <Box
                component="li"
                key={key}
                sx={{ minWidth: 0, border: 1, borderColor: 'divider', borderRadius: 1, px: 1.5, py: 1 }}
              >
                <Typography variant="caption" color="text.secondary" component="div">
                  {label}
                </Typography>
                <Typography variant="subtitle1" component="div" className="tabular-nums" sx={{ fontWeight: 600 }}>
                  {items.length}件
                </Typography>
              </Box>
            ))}
        </Box>
        {groups
          .filter(({ items }) => items.length > 0)
          .map(({ key, label, items }) => (
            <DisclosureAccordion key={key} title={`${label}（${items.length}件）`} headingLevel="h3">
              <TargetList items={items} />
            </DisclosureAccordion>
          ))}
        {supplement}
        <Button
          component={RouterLink}
          to="/build-list"
          variant="outlined"
          sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          作成リストを開く
        </Button>
      </Stack>
    </Paper>
  )
}

/** The 「候補なし」 row of either batch: the exclusion count only when that batch excluded and the search really excluded weapons. */
function noCandidateItem(
  outcome: Extract<BatchCandidateSearchTargetOutcome, { status: 'no_candidate' }>,
  excludeOtherTargetSources: boolean,
  detail: string,
): TargetListItem {
  return {
    key: outcome.target.id,
    name: outcome.target.name,
    ...(excludeOtherTargetSources && outcome.excludedSourceOwnedWeaponIds.length > 0
      ? { note: batchSourceExclusionCountNote(outcome.excludedSourceOwnedWeaponIds.length) }
      : {}),
    detail,
  }
}

/**
 * The finished batch (`docs/UI_FLOW.md` 9.1). `supplement` is what the screen adds after the outcome groups - the replan proposal for
 * the Targets the batch really added (Issue #276 PR-6B) - without changing any of the summary's own content.
 */
export function BatchCandidateSearchSummaryPanel({
  summary,
  supplement = null,
}: {
  summary: BatchCandidateSearchSummary
  supplement?: ReactNode
}) {
  const byStatus = <S extends BatchCandidateSearchTargetOutcome['status']>(status: S) =>
    summary.outcomes.filter(
      (outcome): outcome is Extract<BatchCandidateSearchTargetOutcome, { status: S }> => outcome.status === status,
    )
  const groups: SummaryGroup[] = [
    {
      key: 'added',
      label: '作成リストへ追加',
      items: byStatus('added').map(({ target }) => ({ key: target.id, name: target.name })),
    },
    {
      key: 'no_candidate',
      label: '候補なし',
      // Only a search that ran with the exclusion and really excluded weapons
      // says so; an added Target lists no exclusion detail (`docs/UI_FLOW.md` 9.2).
      items: byStatus('no_candidate').map((outcome) =>
        noCandidateItem(outcome, summary.excludeOtherTargetSources, '現在の探索範囲では完成条件を満たす候補が見つかりませんでした。')),
    },
    {
      key: 'failed',
      label: '検索失敗',
      items: byStatus('failed').map(({ target, message }) => ({ key: target.id, name: target.name, detail: message })),
    },
    {
      key: 'not_added',
      label: '追加しなかった',
      items: byStatus('not_added').map(({ target, reason }) => ({
        key: target.id,
        name: target.name,
        detail: batchNotAddedReasonLabels[reason],
      })),
    },
    {
      key: 'not_started',
      label: '未処理',
      items: summary.notStarted.map((target) => ({ key: target.id, name: target.name })),
      countedOnlyWhenPresent: true,
    },
  ]
  return (
    <BatchSummaryLayout
      title="一括検索・追加の結果"
      countsLabel="一括検索・追加の件数"
      excludeOtherTargetSources={summary.excludeOtherTargetSources}
      termination={summary.termination}
      completedMessage={`${summary.total}件の目標武器を検索しました。`}
      cancelledMessage="一括検索をキャンセルしました。キャンセル前に作成リストへ追加した候補は、そのまま登録されています。"
      groups={groups}
      supplement={supplement}
    />
  )
}

/**
 * The finished 「再検索が必要な候補を一括再検索・置換」 (`docs/UI_FLOW.md` 9.3). Every
 * group but 「置き換えた」 says in text that the original candidate is still
 * registered, so a cancelled, failed or refused Target is never read as a
 * lost Entry. `supplement` is the screen's replan proposal for the Targets
 * whose Entry was really replaced.
 */
export function BatchCandidateResearchSummaryPanel({
  summary,
  supplement = null,
}: {
  summary: BatchCandidateResearchSummary
  supplement?: ReactNode
}) {
  const byStatus = <S extends BatchCandidateResearchTargetOutcome['status']>(status: S) =>
    summary.outcomes.filter(
      (outcome): outcome is Extract<BatchCandidateResearchTargetOutcome, { status: S }> => outcome.status === status,
    )
  const groups: SummaryGroup[] = [
    {
      key: 'replaced',
      label: '候補を置き換えた',
      items: byStatus('replaced').map(({ target }) => ({ key: target.id, name: target.name })),
    },
    {
      key: 'no_candidate',
      label: '候補なし',
      items: byStatus('no_candidate').map((outcome) =>
        noCandidateItem(
          outcome,
          summary.excludeOtherTargetSources,
          `現在の探索範囲では完成条件を満たす候補が見つかりませんでした。${BATCH_RESEARCH_KEPT_NOTE}`,
        )),
    },
    {
      key: 'failed',
      label: '検索失敗',
      items: byStatus('failed').map(({ target, message }) => ({
        key: target.id,
        name: target.name,
        detail: `${message} ${BATCH_RESEARCH_KEPT_NOTE}`,
      })),
    },
    {
      key: 'not_replaced',
      label: '置き換えなかった',
      items: byStatus('not_replaced').map(({ target, reason }) => ({
        key: target.id,
        name: target.name,
        detail: `${batchResearchRefusalReasonLabels[reason]} ${BATCH_RESEARCH_KEPT_NOTE}`,
      })),
    },
    {
      key: 'not_started',
      label: '未処理',
      items: summary.notStarted.map((target) => ({ key: target.id, name: target.name, detail: BATCH_RESEARCH_KEPT_NOTE })),
      countedOnlyWhenPresent: true,
    },
  ]
  return (
    <BatchSummaryLayout
      title={BATCH_RESEARCH_SUMMARY_TITLE}
      countsLabel={BATCH_RESEARCH_SUMMARY_COUNTS_LABEL}
      excludeOtherTargetSources={summary.excludeOtherTargetSources}
      termination={summary.termination}
      completedMessage={`${summary.total}件の目標武器を再検索しました。`}
      cancelledMessage="一括再検索をキャンセルしました。キャンセル前に置き換えた候補はそのまま登録され、処理していない目標武器の候補は元のまま残っています。"
      groups={groups}
      supplement={supplement}
    />
  )
}
