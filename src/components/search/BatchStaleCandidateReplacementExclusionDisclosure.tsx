import { Box, Typography } from '@mui/material'
import type { BuildListResearchExclusion } from '../../domain/buildList'
import { DisclosureAccordion, type DisclosureHeadingLevel } from '../DisclosureAccordion'
import { batchResearchExclusionName, batchResearchExclusionReasonLabel } from './batchStaleCandidateReplacementPresentation'

/**
 * The stale candidates 「再検索が必要な候補を一括再検索・置換」 leaves alone, each
 * with its reason in Japanese (`docs/UI_FLOW.md` 9.3), collapsed. Read-only and
 * shared by the confirmation dialog and the Search screen itself, so the
 * reasons can be read even when no Target is re-searched at all. The reasons
 * are the Domain's selection; nothing is judged, searched or written here.
 */
export function BatchCandidateResearchExclusionDisclosure({
  excluded,
  title,
  headingLevel,
}: {
  excluded: readonly BuildListResearchExclusion[]
  title: string
  headingLevel: DisclosureHeadingLevel
}) {
  return (
    <DisclosureAccordion title={title} headingLevel={headingLevel}>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
        {excluded.map((exclusion, index) => (
          <Box
            component="li"
            key={exclusion.targetWeaponId}
            sx={{ minWidth: 0, borderTop: index === 0 ? 0 : 1, borderColor: 'divider', pt: index === 0 ? 0 : 1 }}
          >
            <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
              {batchResearchExclusionName(exclusion)}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {batchResearchExclusionReasonLabel(exclusion.reason)}
            </Typography>
          </Box>
        ))}
      </Box>
    </DisclosureAccordion>
  )
}
