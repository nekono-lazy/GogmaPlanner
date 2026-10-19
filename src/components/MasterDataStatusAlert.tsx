import { Alert } from '@mui/material'
import type { MasterDataRoot } from '../domain/master/masterTypes'
import { getMasterDataStatus } from '../domain/master/masterDataStatus'

/**
 * A blocking Master gap is one warning. The disabled Lottery and material
 * cost placeholders of the bundled Master are never a warning
 * (`docs/MASTER_DATA_STATUS.md`).
 */
export function MasterDataStatusAlert({ master }: { master: MasterDataRoot }) {
  const status = getMasterDataStatus(master)
  if (!status.isProductionReady) {
    return <Alert severity="warning">{status.blockingReason}</Alert>
  }
  return null
}
