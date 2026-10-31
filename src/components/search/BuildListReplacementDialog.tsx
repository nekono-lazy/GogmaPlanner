import { useId } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type {
  BuildCandidate,
  OwnedWeapon,
  TargetWeapon,
} from '../../domain/models/publicTypes'
import { DialogFormError } from '../DialogFormError'
import { RestorationBonusSlots } from '../RestorationBonusSlots'
import { StatusChip } from '../StatusChip'
import {
  describeAchievedCompletionSkillVariants,
  describeAchievedCompletionVariants,
} from '../target/completionConditionPresentation'
import { AchievedCompletionDefinitionItems } from './AchievedCompletionDefinitionItems'
import {
  BUILD_LIST_REPLACEMENT_CONFIRM_LABEL,
  BUILD_LIST_REPLACEMENT_CURRENT_HEADING,
  BUILD_LIST_REPLACEMENT_LEAD,
  BUILD_LIST_REPLACEMENT_NEW_HEADING,
  BUILD_LIST_REPLACEMENT_TITLE,
} from './buildListReplacementPresentation'
import type { BuildListCandidateReplacementPending } from './useBuildListCandidateReplacement'
import { SearchDefinitionItem, SearchDefinitionList } from './SearchDefinitionList'
import { groupSkillLabel, routeKindLabels, seriesSkillLabel } from './searchPresentation'

const actionSx = { minHeight: 44, width: { xs: '100%', sm: 'auto' } } as const

/**
 * The gist of one Candidate for the comparison: the Route kind, its starting
 * weapon, the finished five slots and Skills, the completion Variants it
 * achieves and the operation count. Everything shown is the Candidate's own
 * recorded result (the Variants re-judged against the Target as it is now);
 * nothing else is recomputed and no ID is shown.
 */
function CandidateSummary({
  heading,
  candidate,
  target,
  master,
  ownedWeapons,
  isStale,
  emphasized,
}: {
  heading: string
  candidate: BuildCandidate
  target: TargetWeapon
  master: MasterDataRoot
  ownedWeapons: readonly OwnedWeapon[]
  isStale: boolean
  /** The candidate that will be registered; marked by a border in addition to its heading. */
  emphasized: boolean
}) {
  const headingId = useId()
  const sourceName = candidate.route.sourceOwnedWeaponId === null
    ? null
    : ownedWeapons.find(({ id }) => id === candidate.route.sourceOwnedWeaponId)?.name ??
      '参照元の所持武器が見つかりません'
  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: { xs: 1.5, sm: 2 },
        minWidth: 0,
        ...(emphasized ? { borderLeftWidth: 4, borderLeftColor: 'primary.main' } : {}),
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component="h3" variant="subtitle1" sx={{ fontWeight: 600 }}>
            {heading}
          </Typography>
          <StatusChip label={routeKindLabels[candidate.route.kind]} tone="info" />
          {isStale && <StatusChip label="再検索が必要" tone="caution" />}
        </Stack>
        <SearchDefinitionList columns={1}>
          {sourceName !== null && (
            <SearchDefinitionItem label="起点武器">{sourceName}</SearchDefinitionItem>
          )}
          <SearchDefinitionItem label="完成時の復元ボーナス">
            <RestorationBonusSlots
              bonuses={candidate.finalBonuses}
              weaponTypeId={target.weaponTypeId}
              master={master}
              scope={candidate.restorationBonusScope}
              label={`${heading}の完成時の復元ボーナス5枠`}
            />
          </SearchDefinitionItem>
          <SearchDefinitionItem label="シリーズスキル / グループスキル">
            シリーズ: {seriesSkillLabel(candidate.seriesSkillId, master)} ／ グループ:{' '}
            {groupSkillLabel(candidate.groupSkillId, master)}
          </SearchDefinitionItem>
          {/* Both candidates are judged against the Target as it is now (`docs/REQUIREMENTS.md` 13.2). */}
          <AchievedCompletionDefinitionItems
            achieved={describeAchievedCompletionVariants(target, candidate.finalBonuses, candidate.restorationBonusScope, master)}
            skill={describeAchievedCompletionSkillVariants(target, candidate.seriesSkillId, candidate.groupSkillId, master)}
          />
          <SearchDefinitionItem label="操作回数">
            <span className="tabular-nums">{candidate.estimatedOperationCount}回</span>
          </SearchDefinitionItem>
        </SearchDefinitionList>
      </Stack>
    </Box>
  )
}

export interface BuildListReplacementDialogProps {
  /** The pending replacement; `null` keeps the dialog closed. */
  pending: BuildListCandidateReplacementPending | null
  master: MasterDataRoot
  ownedWeapons: readonly OwnedWeapon[]
  submitting: boolean
  error: string | null
  onCancel(): void
  onConfirm(): void
}

/**
 * The confirmation 「作成リストに追加」 needs when the Target already holds one
 * Entry of another Candidate (`docs/UI_FLOW.md` 9, `docs/DATA_MODEL.md` 9.4.1).
 * It shows the registered Candidate and the new one side by side (stacked on a
 * phone). It is a replacement, not a delete, so the action is the ordinary
 * primary button. The breaking-change
 * warning, when the runtime asks for one, follows this dialog through the
 * shared controller; neither confirmation stands in for the other.
 */
export function BuildListReplacementDialog({
  pending,
  master,
  ownedWeapons,
  submitting,
  error,
  onCancel,
  onConfirm,
}: BuildListReplacementDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  if (pending === null) return null
  const { request, existingEntry } = pending
  return (
    <Dialog
      open
      fullWidth
      maxWidth="md"
      scroll="paper"
      onClose={() => {
        if (!submitting) onCancel()
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>{BUILD_LIST_REPLACEMENT_TITLE}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box id={descriptionId}>
            <Typography variant="body1" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              目標武器: {request.target.name}
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {BUILD_LIST_REPLACEMENT_LEAD}
            </Typography>
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
              gap: 2,
            }}
          >
            <CandidateSummary
              heading={BUILD_LIST_REPLACEMENT_CURRENT_HEADING}
              candidate={existingEntry.candidateSnapshot}
              target={request.target}
              master={master}
              ownedWeapons={ownedWeapons}
              isStale={existingEntry.isStale}
              emphasized={false}
            />
            <CandidateSummary
              heading={BUILD_LIST_REPLACEMENT_NEW_HEADING}
              candidate={request.candidate}
              target={request.target}
              master={master}
              ownedWeapons={ownedWeapons}
              isStale={false}
              emphasized
            />
          </Box>
        </Stack>
      </DialogContent>
      {error !== null && <DialogFormError message={error} />}
      {/* `disableSpacing`: the MUI sibling margin would offset the second full-width button on a phone. */}
      <DialogActions disableSpacing sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onCancel} disabled={submitting} sx={actionSx}>
          キャンセル
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={submitting} sx={actionSx}>
          {BUILD_LIST_REPLACEMENT_CONFIRM_LABEL}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
