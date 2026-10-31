import { Alert } from '@mui/material'
import type { ProductionPlanExecutionContractBlock } from '../../domain/execution'
import { savePointRestoreUnavailableMessage } from './savePointRestoreUnavailablePresentation'

/**
 * The reason the 16.2 choice cannot offer 「最後のゲーム内セーブ地点へ戻す」
 * (Issue #335), shown in text beside the disabled choice (not by colour alone).
 * `id` lets the disabled button name it with `aria-describedby`.
 */
export function SavePointRestoreUnavailableNotice({
  id,
  reason,
  guidance,
}: {
  id: string
  reason: ProductionPlanExecutionContractBlock
  guidance: string
}) {
  return (
    <Alert id={id} severity="info" role="note" sx={{ mt: 1.5, overflowWrap: 'anywhere' }}>
      {savePointRestoreUnavailableMessage(reason)}
      {guidance}
    </Alert>
  )
}
