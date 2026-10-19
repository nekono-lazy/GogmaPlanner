import { useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/material'
import type { ExecutionNormalRestorationBonusObservation } from '../../domain/execution'
import type { MasterDataRoot } from '../../domain/master/masterTypes'
import type { RestorationBonusSet } from '../../domain/models/publicTypes'
import { BonusSetEditor } from '../forms/BonusSetEditor'

/** Five unfilled slots: an observation never starts from a fabricated value. */
function unfilledSlots(): RestorationBonusSet {
  return Array.from({ length: 5 }, () => ({ bonusTypeId: '', bonusRankId: '' })) as RestorationBonusSet
}

function isObservationComplete(slots: RestorationBonusSet): boolean {
  return slots.every(({ bonusTypeId, bonusRankId }) => bonusTypeId !== '' && bonusRankId !== '')
}

/**
 * 「実際の5枠を入力して確定」 for a blind production-target Normal
 * (`docs/UI_FLOW.md` 12.1, `docs/PLANNER_SPEC.md` 16.4).
 *
 * It reuses the Owned Weapon five-slot editor and its Production availability
 * selector, with `normal_artian` scope and the Target's weapon type / element
 * the runtime registers the weapon with. Confirmation stays disabled until all
 * five slots hold a type and a rank; the runtime still validates the result.
 */
export function BlindObservationForm({
  master,
  weaponTypeId,
  elementId,
  disabled,
  onSubmit,
}: {
  master: MasterDataRoot
  weaponTypeId: string
  elementId: string
  disabled: boolean
  onSubmit(observation: ExecutionNormalRestorationBonusObservation): void
}) {
  const [slots, setSlots] = useState<RestorationBonusSet>(unfilledSlots)
  const complete = isObservationComplete(slots)
  return (
    <Stack spacing={1.5}>
      <Alert severity="info">
        これは予測ではなく、ゲーム画面で確認した実際の5枠です。
      </Alert>
      <BonusSetEditor
        label="実際の復元ボーナス5枠"
        master={master}
        weaponTypeId={weaponTypeId}
        elementId={elementId}
        scope="normal_artian"
        value={slots}
        onChange={setSlots}
      />
      {!complete && (
        <Typography variant="body2" color="text.secondary">
          5枠すべてのボーナス種別とランクを入力すると確定できます。
        </Typography>
      )}
      <Button
        variant="contained"
        size="large"
        disabled={disabled || !complete}
        onClick={() =>
          onSubmit({ kind: 'normal_restoration_bonuses', restorationBonuses: structuredClone(slots) })
        }
        sx={{ minHeight: 48, width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }}
      >
        実際の5枠を入力して確定
      </Button>
    </Stack>
  )
}
