import type { ReactNode } from 'react'
import { useId } from 'react'
import { Alert, AlertTitle, Box, Divider, Paper, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import {
  restorationBonusScopeFieldLabel,
  restorationBonusScopeLabels,
} from '../../presentation/labels'
import { RestorationBonusSlots } from '../RestorationBonusSlots'
import { ExecutionEntityName } from './ExecutionWeaponDetailDialog'
import { StatusChip } from '../StatusChip'
import { groupSkillLabel, seriesSkillLabel } from '../search/searchPresentation'
import type { ExecutionNormalCreationGuidance, ExecutionStepPresentation } from './executionStepPresentation'

function ExpectedResultSection({
  presentation,
  master,
}: {
  presentation: ExecutionStepPresentation
  master: MasterDataRoot
}) {
  const { expected } = presentation
  if (expected.kind === 'observation_required') {
    return (
      <Typography variant="body2">
        想定結果: ゲーム画面で確認した5枠を入力
      </Typography>
    )
  }
  if (expected.kind === 'none') {
    return <Typography variant="body2" color="text.secondary">想定結果: 予測なし</Typography>
  }
  const { result } = expected
  const hasSkills = result.seriesSkillId !== null || result.groupSkillId !== null
  return (
    <Stack spacing={0.75}>
      <Typography component="p" variant="subtitle2">想定結果</Typography>
      {result.restorationBonuses !== null && (
        <>
          <RestorationBonusSlots
            bonuses={result.restorationBonuses}
            weaponTypeId={presentation.weaponTypeId}
            master={master}
            scope={result.restorationBonusScope}
            variant="outlined"
            label="想定される復元ボーナス5枠"
          />
          <Typography variant="caption" color="text.secondary">
            {restorationBonusScopeFieldLabel}:{' '}
            {result.restorationBonusScope === null
              ? '記録なし'
              : restorationBonusScopeLabels[result.restorationBonusScope]}
          </Typography>
        </>
      )}
      {hasSkills && (
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          シリーズ: {seriesSkillLabel(result.seriesSkillId, master)} ／ グループ:{' '}
          {groupSkillLabel(result.groupSkillId, master)}
        </Typography>
      )}
      {result.restorationBonuses === null && !hasSkills && (
        <Typography variant="body2" color="text.secondary">予測なし</Typography>
      )}
    </Stack>
  )
}

/**
 * The game operation of a Normal creation Step with a recorded role
 * (`docs/UI_FLOW.md` 12, Issue #275), in place of the persisted instruction:
 * the instruction naming the weapon type (and the production target's
 * element), the production target's notice above the body text, then the
 * supplementary lines. The Counter-advance / production-target difference is
 * carried by the wording, the role chip and the notice's icon and title, never
 * by colour alone.
 */
function NormalCreationGuidanceSection({ guidance }: { guidance: ExecutionNormalCreationGuidance }) {
  return (
    <Stack spacing={1}>
      <Typography component="p" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
        {guidance.instruction}
      </Typography>
      {guidance.keepNotice !== null && (
        <Alert severity="warning" role="note">
          <AlertTitle sx={{ fontWeight: 700 }}>{guidance.keepNotice.title}</AlertTitle>
          {guidance.keepNotice.body}
        </Alert>
      )}
      {guidance.notes.map((note) => (
        <Typography key={note} variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {note}
        </Typography>
      ))}
    </Stack>
  )
}

/**
 * The current Step of the Execution Navigator (`docs/UI_FLOW.md` 12).
 *
 * Everything shown comes from the persisted Step and its `executionEffects`;
 * no Seed or Counter value appears. A Normal creation with a recorded role
 * shows its derived instruction instead of the persisted one (Issue #275).
 * The actions are the caller's children, so the card never decides which
 * confirmation applies.
 */
export function ExecutionStepCard({
  presentation,
  master,
  children,
}: {
  presentation: ExecutionStepPresentation
  master: MasterDataRoot
  children?: ReactNode
}) {
  const headingId = useId()
  const weaponTermId = useId()
  const targetTermId = useId()
  const { step, normalCreationRole } = presentation
  const isOwnedIdeal = presentation.actionKind === 'confirm_owned_ideal'
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0 }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography id={headingId} component="h2" variant="h2">
            {presentation.operationLabel}
          </Typography>
          {normalCreationRole === 'counter_advance' && <StatusChip label="Counter進行用" tone="neutral" />}
          {normalCreationRole === 'production_target' && <StatusChip label="作成対象" tone="info" />}
          {presentation.completionTargetLabels.length > 0 && <StatusChip label="目標武器が完成" tone="positive" />}
        </Stack>

        {isOwnedIdeal ? (
          <Alert severity="info">
            この所持武器はすでに目標条件を満たしています。
            <br />
            理想品として確定します。
          </Alert>
        ) : (
          <>
            <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{step.title}</Typography>
            {presentation.normalCreation === null ? (
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {step.instruction}
              </Typography>
            ) : (
              <NormalCreationGuidanceSection guidance={presentation.normalCreation} />
            )}
          </>
        )}

        {/*
          * Issue #76: both names are the lookup control for the entity they
          * name, so the user can check which weapon to pick up and what the
          * Target really asks for without leaving the Navigator. The lookup is
          * read-only and reads the persisted entity of the Navigator's own
          * snapshot; a name that resolves to no entity stays plain text.
          */}
        <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 1.5, rowGap: 0.5, alignItems: 'center' }}>
          {presentation.weaponLabel !== null && (
            <>
              <Typography id={weaponTermId} component="dt" variant="body2" color="text.secondary">使用する武器</Typography>
              <Box component="dd" sx={{ m: 0, minWidth: 0 }}>
                <ExecutionEntityName
                  label={presentation.weaponLabel}
                  detail={presentation.weapon === null ? null : { kind: 'owned_weapon', weapon: presentation.weapon }}
                  master={master}
                  bold
                  describedById={weaponTermId}
                />
              </Box>
            </>
          )}
          {presentation.targetLabel !== null && (
            <>
              <Typography id={targetTermId} component="dt" variant="body2" color="text.secondary">目標武器</Typography>
              <Box component="dd" sx={{ m: 0, minWidth: 0 }}>
                <ExecutionEntityName
                  label={presentation.targetLabel}
                  detail={presentation.target === null ? null : { kind: 'target_weapon', target: presentation.target }}
                  master={master}
                  describedById={targetTermId}
                />
              </Box>
            </>
          )}
        </Box>

        {presentation.completionTargetLabels.map((label, index) => (
          <Alert key={`${label}:${index}`} severity="success">
            このStepで「{label}」が完成します
          </Alert>
        ))}
        {presentation.reachesCheckpoint && (
          <Alert severity="info">このStepで作成リストの途中採用状態に到達します</Alert>
        )}

        {!isOwnedIdeal && (
          <>
            <Divider />
            <ExpectedResultSection presentation={presentation} master={master} />
          </>
        )}
        {children}
      </Stack>
    </Paper>
  )
}
