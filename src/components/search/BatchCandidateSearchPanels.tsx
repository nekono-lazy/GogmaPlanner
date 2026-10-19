import { useId } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Alert, Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { StatusChip } from '../StatusChip'
import type {
  BatchCandidateSearchProgress,
  BatchCandidateSearchSummary,
  BatchCandidateSearchTargetOutcome,
} from '../../services/search/batchCandidateSearch'
import { candidateSearchProgressPhaseLabels } from '../../presentation/labels'
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
}: {
  progress: BatchCandidateSearchProgress
  cancelling: boolean
  onCancel: () => void
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
            一括検索・追加中
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
          {cancelling ? 'キャンセル中…' : '一括検索をキャンセル'}
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

export function BatchCandidateSearchSummaryPanel({ summary }: { summary: BatchCandidateSearchSummary }) {
  const headingId = useId()
  const byStatus = <S extends BatchCandidateSearchTargetOutcome['status']>(status: S) =>
    summary.outcomes.filter(
      (outcome): outcome is Extract<BatchCandidateSearchTargetOutcome, { status: S }> => outcome.status === status,
    )
  const added = byStatus('added')
  const noCandidate = byStatus('no_candidate')
  const failed = byStatus('failed')
  const notAdded = byStatus('not_added')
  const groups = [
    {
      key: 'added',
      label: '作成リストへ追加',
      items: added.map(({ target }) => ({ key: target.id, name: target.name })),
    },
    {
      key: 'no_candidate',
      label: '候補なし',
      // Only a search that ran with the exclusion and really excluded weapons
      // says so; an added Target lists no exclusion detail (`docs/UI_FLOW.md` 9.2).
      items: noCandidate.map(({ target, excludedSourceOwnedWeaponIds }): TargetListItem => ({
        key: target.id,
        name: target.name,
        ...(summary.excludeOtherTargetSources && excludedSourceOwnedWeaponIds.length > 0
          ? { note: batchSourceExclusionCountNote(excludedSourceOwnedWeaponIds.length) }
          : {}),
        detail: '現在の探索範囲では理想品が見つかりませんでした。',
      })),
    },
    {
      key: 'failed',
      label: '検索失敗',
      items: failed.map(({ target, message }) => ({ key: target.id, name: target.name, detail: message })),
    },
    {
      key: 'not_added',
      label: '追加しなかった',
      items: notAdded.map(({ target, reason }) => ({
        key: target.id,
        name: target.name,
        detail: batchNotAddedReasonLabels[reason],
      })),
    },
    {
      key: 'not_started',
      label: '未処理',
      items: summary.notStarted.map((target) => ({ key: target.id, name: target.name })),
    },
  ]
  const termination = summary.termination
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
            一括検索・追加の結果
          </Typography>
          {/* The condition this batch ran with; a later Checkbox change never relabels it. */}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {sourceExclusionConditionLabel(summary.excludeOtherTargetSources)}
          </Typography>
        </Box>
        {termination.status === 'completed' && (
          <Alert severity="success">{summary.total}件の目標武器を検索しました。</Alert>
        )}
        {termination.status === 'cancelled' && (
          <Alert severity="info">
            一括検索をキャンセルしました。キャンセル前に作成リストへ追加した候補は、そのまま登録されています。
          </Alert>
        )}
        {termination.status === 'aborted' && (
          <Alert severity="error">
            {termination.message} 以降の目標武器は検索していません。
          </Alert>
        )}
        <Box
          component="ul"
          aria-label="一括検索・追加の件数"
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
            .filter(({ key, items }) => key !== 'not_started' || items.length > 0)
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
        {added.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            追加した候補は、途中採用する状態を選ばず（理想品まで進む）、改善優先を「生産計画に任せる」で登録しています。必要な目標武器だけ作成リストで変更してください。
          </Typography>
        )}
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
