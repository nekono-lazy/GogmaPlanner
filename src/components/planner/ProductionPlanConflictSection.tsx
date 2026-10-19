import { useId, type ReactNode } from 'react'
import { Alert, AlertTitle, Box, Button, Paper, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { DisclosureAccordion } from '../DisclosureAccordion'
import { StatusChip } from '../StatusChip'
import { SummaryFigure } from './ProductionPlanSummary'
import type {
  ConflictCardDisplay,
  ConflictNotCreatedTargetDisplay,
  ConflictParticipantDisplay,
  ConflictSectionDisplay,
  ConflictTargetCauseGroups,
  ConflictTargetOutcome,
} from './productionPlanConflictPresentation'

/**
 * The 「競合と解決」 section of the Production Plan screen (Issue #278 PR-3,
 * `docs/UI_FLOW.md` 11.6). Presentation only: every figure and sentence comes
 * from `createProductionPlanConflictSectionDisplay()`, the page keeps the
 * preparation and the 「この候補を優先」 state machine, and this component only
 * calls `onPrefer` for a participant the display marks `canPrefer`.
 *
 * Layout (PC and a 375px phone, light and dark): one column on a phone, the
 * participants side by side from `md`; status chips stay on one line and wrap
 * as a group; names and sentences wrap (`overflow-wrap: anywhere`); every
 * action is at least 44px high with an 8px gap; every state is written as text,
 * the chip tone only reinforces it.
 */
export interface ProductionPlanConflictSectionProps {
  display: ConflictSectionDisplay
  /** Debug Mode adds a collapsed diagnostics block per Conflict; it changes nothing else. */
  debugMode: boolean
  /** A preference run or a save is in progress: every 「この候補を優先」 is disabled. */
  busy: boolean
  onPrefer(conflictId: string, buildListEntryId: string): void
  /** The page's own running / saving / result notices, shown at the top. */
  statusSlot?: ReactNode
  /** Debug Mode only: the raw issue and warning messages of an invalid preparation. */
  debugPreparationMessages?: readonly string[]
}

function figureCount(count: number): string {
  return `${count.toLocaleString('ja-JP')}件`
}

function weaponCount(count: number): string {
  return `${count.toLocaleString('ja-JP')}本`
}

/**
 * The line under 「今回作成しない目標武器」: how many of them a conflict leaves
 * out - the shared Domain numbers, known while the names load or fail too
 * (11.6.5) - and the candidates whose Target cannot be read.
 */
function notCreatedDetail(targets: ConflictTargetOutcome): string | undefined {
  const lines: string[] = []
  const groups = targets.causeGroups
  if (groups !== null) {
    lines.push(groups.ratioDetermined
      ? `うち競合のため ${weaponCount(groups.conflictCount)}`
      : `うち競合を確認できたもの ${weaponCount(groups.conflictCount)}・確認できないもの ${weaponCount(groups.unestablishedCount)}`)
  }
  if (targets.namesStatus === 'loaded' && targets.notCreatedUnresolvedCount > 0) {
    lines.push(`ほかに目標武器を確認できない候補 ${figureCount(targets.notCreatedUnresolvedCount)}`)
  }
  return lines.length === 0 ? undefined : lines.join('、')
}

function ConflictSummary({ display }: { display: ConflictSectionDisplay }) {
  const { targets } = display
  const notCreatedValue =
    !targets.hasCompletionAuthority
      ? '不明（旧形式の計画）'
      : targets.namesStatus === 'loading'
        ? '確認中'
        : targets.namesStatus === 'failed'
          ? '確認できません'
          : weaponCount(targets.notCreated.length)
  return (
    <Box
      component="dl"
      aria-label="競合と作成予定の件数"
      sx={{
        m: 0,
        display: 'grid',
        // A phone shows the Conflict figure on its own row and the two Target
        // figures side by side; from `sm` the three share one row.
        gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' },
        gap: 1,
      }}
    >
      <SummaryFigure
        gridColumn={{ xs: '1 / -1', sm: 'auto' }}
        label="競合（記録件数）"
        value={display.conflictCount === 0 ? 'なし' : figureCount(display.conflictCount)}
        numeric={display.conflictCount > 0}
        detail={
          display.conflictCount === 0
            ? undefined
            : display.countDetail
        }
      />
      <SummaryFigure
        label="今回作成する目標武器"
        value={targets.createdCount === null ? '不明（旧形式の計画）' : `${targets.createdCount}本`}
        numeric={targets.createdCount !== null}
      />
      <SummaryFigure
        label="今回作成しない目標武器"
        value={notCreatedValue}
        numeric={targets.hasCompletionAuthority && targets.namesStatus === 'loaded'}
        detail={notCreatedDetail(targets)}
      />
    </Box>
  )
}

function TargetName({ name, weaponLabel, nameResolved = true }: { name: string; weaponLabel: string | null; nameResolved?: boolean }) {
  return (
    <>
      <Typography
        component="span"
        variant="body2"
        sx={{ fontWeight: 600, overflowWrap: 'anywhere', color: nameResolved ? 'text.primary' : 'text.secondary' }}
      >
        {name}
      </Typography>
      {weaponLabel !== null && (
        <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75, overflowWrap: 'anywhere' }}>
          （{weaponLabel}）
        </Typography>
      )}
    </>
  )
}

/** The not-made Target rows, each with its reason, and the candidates whose Target cannot be read. */
function NotCreatedList({
  rows,
  unresolvedCount,
  labelledBy,
}: {
  rows: readonly ConflictNotCreatedTargetDisplay[]
  unresolvedCount: number
  labelledBy: string
}) {
  return (
    <Box component="ul" aria-labelledby={labelledBy} sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
      {rows.map((target) => (
        <Box
          component="li"
          key={target.key}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.5, py: 1, minWidth: 0 }}
        >
          <Typography component="p" variant="body2" sx={{ m: 0 }}>
            <TargetName name={target.name} weaponLabel={target.weaponLabel} nameResolved={target.nameResolved} />
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
            {target.reason}
          </Typography>
        </Box>
      ))}
      {unresolvedCount > 0 && (
        <Box component="li" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.5, py: 1 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
            目標武器を確認できない候補が{unresolvedCount}件あります。作成リストを確認するか、画面を再読み込みしてください。
          </Typography>
        </Box>
      )}
    </Box>
  )
}

/** One cause group (11.6.5): its heading carries the number of Targets. */
function NotCreatedGroup({ title, rows }: { title: string; rows: readonly ConflictNotCreatedTargetDisplay[] }) {
  const headingId = useId()
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Typography id={headingId} component="h5" variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {title}（{weaponCount(rows.length)}）
      </Typography>
      <NotCreatedList rows={rows} unresolvedCount={0} labelledBy={headingId} />
    </Stack>
  )
}

/**
 * 「今回作成しない目標武器」 by cause (Issue #121, 11.6.5), when the Plan
 * recorded every rejection with its cause: 競合のため / 競合によるものか確認
 * できない / その他の理由, an empty group left out. The candidates whose Target
 * cannot be read are said once, after the groups.
 */
function NotCreatedGroups({ groups, unresolvedCount }: { groups: ConflictTargetCauseGroups; unresolvedCount: number }) {
  return (
    // The groups sit visibly under 「今回作成しない目標武器」: a left rule and
    // an indent, not colour, carry the nesting.
    <Stack spacing={1.5} sx={{ pl: { xs: 1, sm: 1.5 }, borderLeft: 2, borderColor: 'divider', minWidth: 0 }}>
      {groups.conflict.length > 0 && <NotCreatedGroup title="競合のため今回作成しない" rows={groups.conflict} />}
      {groups.unestablished.length > 0 && (
        <NotCreatedGroup title="競合によるものか確認できない" rows={groups.unestablished} />
      )}
      {groups.other.length > 0 && <NotCreatedGroup title="その他の理由で今回作成しない" rows={groups.other} />}
      {unresolvedCount > 0 && (
        <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
          ほかに、目標武器を確認できない候補が{unresolvedCount}件あります。作成リストを確認するか、画面を再読み込みしてください。
        </Typography>
      )}
    </Stack>
  )
}

/** 「今回作成する / 作成しない目標武器」 (11.6.5): the Plan's completions, and the participants and rejected Entries it leaves out. */
function TargetOutcomeBlock({ targets }: { targets: ConflictTargetOutcome }) {
  const headingId = useId()
  const createdHeadingId = useId()
  const notCreatedHeadingId = useId()
  let body: ReactNode
  if (!targets.hasCompletionAuthority) {
    body = (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        旧形式の計画のため、この計画で作成する目標武器を確認できません。
      </Typography>
    )
  } else if (targets.namesStatus !== 'loaded') {
    body = (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {targets.namesStatus === 'loading'
          ? '目標武器名を確認しています。'
          : '作成リストと目標武器を読み込めなかったため、目標武器ごとの内訳を表示できません。画面を再読み込みしてください。'}
      </Typography>
    )
  } else {
    body = (
      <Stack spacing={2}>
        <Stack spacing={1}>
          <Typography id={createdHeadingId} component="h4" variant="subtitle2">
            今回作成する目標武器（{targets.createdCount}本）
          </Typography>
          {targets.created.length === 0 && targets.createdUnresolvedCount === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>この計画で完成する目標武器はありません。</Typography>
          ) : (
            <Box component="ul" aria-labelledby={createdHeadingId} sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
              {targets.created.map((target) => (
                <Box component="li" key={target.key} sx={{ minWidth: 0 }}>
                  <TargetName name={target.name} weaponLabel={target.weaponLabel} />
                </Box>
              ))}
              {targets.createdUnresolvedCount > 0 && (
                <Box component="li" sx={{ color: 'text.secondary' }}>
                  <Typography component="span" variant="body2">
                    名前を確認できない目標武器 {targets.createdUnresolvedCount}本
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </Stack>
        <Stack spacing={1}>
          <Typography id={notCreatedHeadingId} component="h4" variant="subtitle2">
            今回作成しない目標武器（{targets.notCreated.length}本）
          </Typography>
          {targets.notCreated.length === 0 && targets.notCreatedUnresolvedCount === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              競合や不採用のために作成しない目標武器はありません。
            </Typography>
          ) : targets.causeGroups !== null ? (
            <NotCreatedGroups groups={targets.causeGroups} unresolvedCount={targets.notCreatedUnresolvedCount} />
          ) : (
            <NotCreatedList
              rows={targets.notCreated}
              unresolvedCount={targets.notCreatedUnresolvedCount}
              labelledBy={notCreatedHeadingId}
            />
          )}
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            「作成しない」は、この計画では作らないという意味です。作成リストの候補と目標武器は削除されず、残っています。
          </Typography>
        </Stack>
      </Stack>
    )
  }
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Typography id={headingId} component="h3" variant="h3">
          今回作成する / 作成しない目標武器
        </Typography>
        {body}
      </Stack>
    </Box>
  )
}

function ParticipantCard({
  participant,
  busy,
  onPrefer,
}: {
  participant: ConflictParticipantDisplay
  busy: boolean
  onPrefer(): void
}) {
  const headingId = useId()
  const explanationId = useId()
  const disabledReasonId = useId()
  return (
    <Paper
      component="li"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{
        listStyle: 'none',
        p: { xs: 1.5, md: 2 },
        minWidth: 0,
        // The selection is said in text (the chip); the border only reinforces it.
        borderColor: participant.isSelected ? 'primary.main' : 'divider',
        borderWidth: participant.isSelected ? 2 : 1,
        // Cards of one Conflict share a row height; the action sits at the bottom.
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Stack spacing={1.25} useFlexGap sx={{ flexGrow: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography
            id={headingId}
            component="h4"
            variant="subtitle1"
            sx={{ color: participant.nameResolved ? 'text.primary' : 'text.secondary', overflowWrap: 'anywhere' }}
          >
            {participant.name}
          </Typography>
          {participant.weaponLabel !== null && (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', overflowWrap: 'anywhere' }}>
              {participant.weaponLabel}
            </Typography>
          )}
        </Box>
        {participant.chips.length > 0 && (
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap', alignItems: 'center' }}
          >
            {participant.chips.map((chip) => (
              <StatusChip key={chip.label} label={chip.label} tone={chip.tone} />
            ))}
          </Stack>
        )}
        {participant.routeSummary !== null && (
          <Typography variant="caption" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
            作成ルート: {participant.routeSummary}
          </Typography>
        )}
        {participant.notes.map((note) => (
          <Typography key={note} variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
            {note}
          </Typography>
        ))}
        {participant.canPrefer && (
          <>
            <Typography id={explanationId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {participant.preferExplanation}
            </Typography>
            <Button
              variant="contained"
              disabled={busy}
              onClick={onPrefer}
              aria-describedby={`${headingId} ${explanationId}`}
              sx={{ minHeight: 44, mt: 'auto', alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
            >
              この候補を優先
            </Button>
          </>
        )}
        {!participant.canPrefer && participant.preferDisabledReason !== null && (
          // Another Conflict's decision leaves this participant out: the
          // action stays visible but disabled, and the reason is written
          // beside it rather than in a tooltip (11.6.6).
          <>
            <Typography id={disabledReasonId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {participant.preferDisabledReason}
            </Typography>
            <Button
              variant="contained"
              disabled
              aria-describedby={`${headingId} ${disabledReasonId}`}
              sx={{ minHeight: 44, mt: 'auto', alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
            >
              この候補を優先
            </Button>
          </>
        )}
      </Stack>
    </Paper>
  )
}

function ConflictDebugDetails({ conflict }: { conflict: ConflictCardDisplay }) {
  const { debug } = conflict
  const rows: readonly { label: string; value: string }[] = [
    { label: 'Conflict ID', value: debug.id },
    { label: 'kind', value: debug.kind },
    { label: 'BuildListEntry ID', value: debug.buildListEntryIds.join(', ') },
    { label: 'recommendedBuildListEntryId', value: debug.recommendedBuildListEntryId ?? 'null' },
    { label: 'selectedBuildListEntryId', value: debug.selectedBuildListEntryId ?? 'null' },
    { label: 'reason', value: debug.reason },
    { label: 'resolutionNote', value: debug.resolutionNote ?? 'null' },
  ]
  return (
    <DisclosureAccordion title={`競合 ${conflict.number} の診断情報（Debug）`} headingLevel="h4" unmountOnExit>
      <Box component="dl" sx={{ m: 0, display: 'grid', gap: 0.75 }}>
        {rows.map((row) => (
          <Box key={row.label} sx={{ minWidth: 0 }}>
            <Typography component="dt" variant="caption" sx={{ color: 'text.secondary' }}>{row.label}</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
              {row.value}
            </Typography>
          </Box>
        ))}
      </Box>
    </DisclosureAccordion>
  )
}

function guidanceSeverity(conflict: ConflictCardDisplay): 'info' | 'warning' | null {
  switch (conflict.status) {
    case 'pending':
    case 'selected':
    case 'undecided':
      return null
    case 'checkpoint_change_required':
    case 'not_compared':
      return 'warning'
    case 'dynamic':
    case 'input_changed':
      return 'info'
  }
}

function ConflictCard({
  conflict,
  debugMode,
  busy,
  onPrefer,
}: {
  conflict: ConflictCardDisplay
  debugMode: boolean
  busy: boolean
  onPrefer(conflictId: string, buildListEntryId: string): void
}) {
  const headingId = useId()
  const severity = guidanceSeverity(conflict)
  const guidance = conflict.guidance.map((line) => (
    <Typography key={line} variant="body2" sx={{ overflowWrap: 'anywhere' }}>{line}</Typography>
  ))
  const buildListLink = conflict.buildListAction !== null && (
    <Button
      component={RouterLink}
      to="/build-list"
      variant="outlined"
      color="inherit"
      sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
    >
      {conflict.buildListAction === 'change_checkpoint' ? 'ビルドリストで途中採用する状態を変更' : 'ビルドリストを開く'}
    </Button>
  )
  return (
    <Box
      component="li"
      aria-labelledby={headingId}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: { xs: 1.5, md: 2 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component="h3" variant="h3" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            競合 {conflict.number}：{conflict.heading}
          </Typography>
          <StatusChip label={conflict.statusChip.label} tone={conflict.statusChip.tone} />
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {conflict.explanation}
        </Typography>
        {severity === null ? (
          guidance.length > 0 && <Stack spacing={0.5}>{guidance}</Stack>
        ) : (
          <Alert severity={severity}>
            <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
              {guidance}
              {buildListLink}
            </Stack>
          </Alert>
        )}
        {severity === null && buildListLink}
        <Box
          component="ul"
          aria-label={`競合 ${conflict.number} の参加候補`}
          sx={{
            m: 0,
            p: 0,
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5,
            alignItems: 'stretch',
          }}
        >
          {conflict.participants.map((participant) => (
            <ParticipantCard
              key={participant.buildListEntryId}
              participant={participant}
              busy={busy}
              onPrefer={() => onPrefer(conflict.id, participant.buildListEntryId)}
            />
          ))}
        </Box>
        {debugMode && <ConflictDebugDetails conflict={conflict} />}
      </Stack>
    </Box>
  )
}

export function ProductionPlanConflictSection({
  display,
  debugMode,
  busy,
  onPrefer,
  statusSlot,
  debugPreparationMessages = [],
}: ProductionPlanConflictSectionProps) {
  const groups = display.targets.causeGroups
  const hasOutcome =
    display.conflictCount > 0 ||
    (display.targets.namesStatus === 'loaded' && display.targets.notCreated.length > 0) ||
    (groups !== null && groups.conflictCount + groups.unestablishedCount > 0)
  return (
    <Stack spacing={2}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        保存された生産計画の競合と、その扱いです。優先する候補を選べるかどうかは、現在の保存状態から判定します。
      </Typography>
      {statusSlot}
      {hasOutcome && <ConflictSummary display={display} />}
      {display.pendingDecisionNotice !== null && (
        <Alert severity="warning" role="note">
          {display.pendingDecisionNotice}
          各競合の案内を確認してください。
        </Alert>
      )}
      {display.sectionNotices.map((notice) => (
        <Alert key={notice} severity="info" role="note">{notice}</Alert>
      ))}
      {display.invalidPreparationReasons !== null && (
        <Alert severity="warning">
          <AlertTitle>現在の作成リストと状態では、競合を確認できません</AlertTitle>
          <Stack spacing={0.5}>
            {display.invalidPreparationReasons.map((reason) => (
              <Typography key={reason} variant="body2" sx={{ overflowWrap: 'anywhere' }}>{reason}</Typography>
            ))}
            <Typography variant="body2">
              優先する候補は選べません。作成リストを確認し、作成リスト画面の「生産計画を作成」から作り直してください。
            </Typography>
            {debugMode && debugPreparationMessages.map((message, index) => (
              <Typography
                key={`${index}:${message}`}
                variant="caption"
                sx={{ color: 'text.secondary', overflowWrap: 'anywhere', fontFamily: 'monospace' }}
              >
                {message}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}
      {display.conflictCount === 0 ? (
        <Alert severity="info">この生産計画に表示する競合はありません。</Alert>
      ) : (
        <Stack component="ul" aria-label="競合の一覧" spacing={2} sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {display.conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              debugMode={debugMode}
              busy={busy}
              onPrefer={onPrefer}
            />
          ))}
        </Stack>
      )}
      {hasOutcome && <TargetOutcomeBlock targets={display.targets} />}
      {display.showBuildListLink && (
        <Button
          component={RouterLink}
          to="/build-list"
          variant="outlined"
          sx={{ minHeight: 44, alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          ビルドリストへ戻る
        </Button>
      )}
    </Stack>
  )
}
