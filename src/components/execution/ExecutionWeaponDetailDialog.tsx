import { useId, useState, type ReactNode } from 'react'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { OwnedWeapon, TargetWeapon } from '../../domain/models/publicTypes'
import {
  artianWeaponKindLabels,
  restorationBonusScopeFieldLabel,
  restorationBonusScopeLabels,
} from '../../presentation/labels'
import { BonusSlotList } from '../ManagementListItem'
import { groupSkillLabel, seriesSkillLabel, skillConditionSummary } from '../search/searchPresentation'

/**
 * What the Execution Navigator lets the user look up beside a name (Issue #76).
 *
 * Always an exact persisted entity of the Navigator's own snapshot: the
 * current `OwnedWeapon` the Step operates on, or the current `TargetWeapon` it
 * produces. Nothing is reconstructed from `PlanStep.expectedResult` - which
 * describes the state *after* the operation, not the weapon as it is now - and
 * nothing from a BuildCandidate, a BuildListEntry, a Planner result or an RNG
 * prediction. A name the Navigator can only show as an ID fallback resolves to
 * no entity, so the caller offers no lookup at all rather than guessing one.
 */
export type ExecutionEntityDetail =
  | { kind: 'owned_weapon'; weapon: OwnedWeapon }
  | { kind: 'target_weapon'; target: TargetWeapon }

function masterLabel(
  entries: readonly { id: string; displayNameJa: string }[],
  id: string,
): string {
  return entries.find((entry) => entry.id === id)?.displayNameJa ?? id
}

/** One 「項目: 値」 row of the read-only detail list. */
function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary">
        {term}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </>
  )
}

const detailListSx = {
  m: 0,
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  columnGap: 1.5,
  rowGap: 0.5,
} as const

/**
 * The read-only content of one owned weapon: what the user has to recognise in
 * the game before operating on it.
 *
 * `status`, protection, memo, the preferring Target, the Execution-internal
 * 作成中 state, the timestamps and the technical ID are deliberately absent:
 * this dialog identifies a weapon, it does not manage one.
 */
function OwnedWeaponDetail({ weapon, master }: { weapon: OwnedWeapon; master: MasterDataRoot }) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2" color="text.secondary">
        現在の登録内容
      </Typography>
      <Box component="dl" sx={detailListSx}>
        <DetailRow term="種類">{artianWeaponKindLabels[weapon.kind]}</DetailRow>
        <DetailRow term="武器種">{masterLabel(master.weaponTypes, weapon.weaponTypeId)}</DetailRow>
        <DetailRow term="属性">{masterLabel(master.elements, weapon.elementId)}</DetailRow>
        <DetailRow term={restorationBonusScopeFieldLabel}>
          {restorationBonusScopeLabels[weapon.restorationBonusScope]}
        </DetailRow>
      </Box>
      <BonusSlotList
        heading="復元ボーナス"
        bonuses={weapon.restorationBonuses}
        weaponTypeId={weapon.weaponTypeId}
        master={master}
        scope={weapon.restorationBonusScope}
      />
      {/* A normal Artian weapon has no Series / Group Skill at all, so none is invented for it. */}
      {weapon.kind === 'gogma' && (
        <Box component="dl" sx={detailListSx}>
          <DetailRow term="シリーズスキル">{seriesSkillLabel(weapon.seriesSkillId, master)}</DetailRow>
          <DetailRow term="グループスキル">{groupSkillLabel(weapon.groupSkillId, master)}</DetailRow>
        </Box>
      )}
    </Stack>
  )
}

/**
 * The read-only Ideal condition of one Target weapon: what this Plan is
 * ultimately aiming at.
 *
 * The compromise definition (practical / alternative bonus conditions, the
 * practical Skill condition), the priority, the enablement, the preferred
 * owned weapon, the lifecycle and the technical ID stay out: the Execution
 * Navigator answers 「最終的に何を目指しているのか」, and the Target Weapons
 * screen remains the place to inspect or change a whole definition.
 */
function TargetWeaponDetail({ target, master }: { target: TargetWeapon; master: MasterDataRoot }) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2" color="text.secondary">
        理想条件
      </Typography>
      <Box component="dl" sx={detailListSx}>
        <DetailRow term="武器種">{masterLabel(master.weaponTypes, target.weaponTypeId)}</DetailRow>
        <DetailRow term="属性">{masterLabel(master.elements, target.elementId)}</DetailRow>
      </Box>
      <BonusSlotList
        heading="理想ボーナス"
        bonuses={target.idealBonuses}
        weaponTypeId={target.weaponTypeId}
        master={master}
        scope="gogma_artian"
      />
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        理想スキル: {skillConditionSummary(target.idealSkillCondition, master)}
      </Typography>
    </Stack>
  )
}

function detailTitle(detail: ExecutionEntityDetail): string {
  return detail.kind === 'owned_weapon' ? detail.weapon.name : detail.target.name
}

/**
 * The read-only lookup dialog behind a name in the Execution Navigator
 * (`docs/UI_FLOW.md` 12 / 12.6).
 *
 * Presentation only: opening or closing it reads the snapshot the Navigator
 * already holds and writes nothing - no ProductionPlan, RngState, Counter,
 * OwnedWeapon, TargetWeapon, ExecutionHistory or save point changes, and in
 * the weapon switch guidance it is not an acknowledgement of the switch.
 */
export function ExecutionWeaponDetailDialog({
  detail,
  master,
  onClose,
}: {
  /** The entity to show; `null` keeps the dialog closed. */
  detail: ExecutionEntityDetail | null
  master: MasterDataRoot
  onClose(): void
}) {
  const titleId = useId()
  if (detail === null) return null
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ px: { xs: 2, sm: 3 }, overflowWrap: 'anywhere' }}>
        {detailTitle(detail)}
      </DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
        {detail.kind === 'owned_weapon' ? (
          <OwnedWeaponDetail weapon={detail.weapon} master={master} />
        ) : (
          <TargetWeaponDetail target={detail.target} master={master} />
        )}
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5 }}>
        <Button
          variant="outlined"
          onClick={onClose}
          sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}
        >
          閉じる
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * An entity name in the Execution Navigator, with its read-only lookup.
 *
 * The name itself is the control (Issue #76): a text button, underlined and in
 * the primary colour so it reads as operable without competing with the Step's
 * own primary action, never an `<a>`, because nothing is navigated to. Its
 * accessible name contains the visible name, so 「○○の内容を確認」 and the
 * visible 「○○」 are the same control for speech input.
 *
 * With no resolvable entity the same text is rendered as plain text: the
 * existing ID fallback label stays visible, and no lookup is offered for
 * something the Navigator cannot show.
 *
 * `describedById` names the field this control sits in, so a weapon and a
 * Target that happen to share a name are still told apart by assistive
 * technology without lengthening the name itself - the same pattern
 * `ManagementListItem` uses for its per-entity edit / delete buttons.
 */
export function ExecutionEntityName({
  label,
  detail,
  master,
  bold = false,
  describedById,
}: {
  /** The name as the Navigator shows it, including its ID fallback form. */
  label: string
  detail: ExecutionEntityDetail | null
  master: MasterDataRoot
  bold?: boolean
  describedById?: string
}) {
  const [open, setOpen] = useState(false)
  if (detail === null) {
    return (
      <Typography
        component="span"
        variant="body2"
        sx={{ overflowWrap: 'anywhere', fontWeight: bold ? 600 : undefined }}
      >
        {label}
      </Typography>
    )
  }
  return (
    <>
      <Button
        variant="text"
        onClick={() => setOpen(true)}
        aria-label={`${label}の内容を確認`}
        aria-describedby={describedById}
        sx={{
          minHeight: 44,
          px: 1,
          mx: -1,
          my: -0.5,
          textAlign: 'left',
          justifyContent: 'flex-start',
          textDecoration: 'underline',
          textUnderlineOffset: '0.2em',
          fontWeight: bold ? 600 : 500,
          fontSize: 'body2.fontSize',
          maxWidth: '100%',
          overflowWrap: 'anywhere',
          '&:hover': { textDecoration: 'underline' },
        }}
      >
        {label}
      </Button>
      <ExecutionWeaponDetailDialog
        detail={open ? detail : null}
        master={master}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
