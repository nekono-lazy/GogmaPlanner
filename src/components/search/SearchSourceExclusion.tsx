import { useId } from 'react'
import { Alert, AlertTitle, Box, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material'
import { DisclosureAccordion, type DisclosureHeadingLevel } from '../DisclosureAccordion'
import {
  SOURCE_EXCLUSION_CHECKBOX_LABEL,
  SOURCE_EXCLUSION_DESCRIPTION,
  SOURCE_EXCLUSION_RESULT_TITLE,
  SOURCE_EXCLUSION_SINGLE_SEARCH_ONLY_NOTE,
  sourceExclusionDisclosureTitle,
  sourceExclusionReasonLabel,
  sourceExclusionResultMessage,
  type SearchSourceExclusionDisplay,
} from './sourceExclusionPresentation'

/** A medium MUI Checkbox is 42px wide (9px padding on each side of a 24px icon): where the label text starts. */
const checkboxLabelInset = '42px'

/**
 * 「他の目標武器で使用する所持武器を除外する」 (`docs/UI_FLOW.md` 9.2): the one Checkbox of the single search, read when
 * 「検索開始」 is pressed; the batch never reads it and always excludes (Issue #290). A Checkbox rather than a Switch:
 * the value is a condition of the next search, never applied immediately. The description and, apart from it, the
 * note that the batch excludes anyway stay visible under the label and the Checkbox refers to both. The value is the
 * caller's temporary UI state and is never persisted.
 */
export function SourceExclusionConditionCheckbox({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  const descriptionId = useId()
  const noteId = useId()
  return (
    <Box sx={{ minWidth: 0 }}>
      <FormControlLabel
        sx={{
          m: 0,
          minHeight: 44,
          pr: 1,
          alignItems: 'center',
          '& .MuiFormControlLabel-label': { fontWeight: 500, overflowWrap: 'anywhere' },
        }}
        control={
          <Checkbox
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            slotProps={{ input: { 'aria-describedby': `${descriptionId} ${noteId}` } }}
          />
        }
        label={SOURCE_EXCLUSION_CHECKBOX_LABEL}
      />
      {/* Indented to the label text so both read as this Checkbox's own text; the top margin keeps a gap under a
          label that wraps to two lines at phone width. */}
      <Stack spacing={1} sx={{ mt: 0.5, pl: checkboxLabelInset, minWidth: 0 }}>
        {/* `sx` colour: MUI 9 Typography emits no rule for a dotted `color="text.secondary"` prop. */}
        <Typography id={descriptionId} variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {SOURCE_EXCLUSION_DESCRIPTION}
        </Typography>
        {/* Kept apart from the description by a rule, a tint and the 「※」, never by colour alone. */}
        <Box
          sx={{
            px: 1.5,
            py: 1,
            borderLeft: 3,
            borderColor: 'info.main',
            bgcolor: 'background.default',
            borderRadius: 1,
            minWidth: 0,
          }}
        >
          <Typography id={noteId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {SOURCE_EXCLUSION_SINGLE_SEARCH_ONLY_NOTE}
          </Typography>
        </Box>
      </Stack>
    </Box>
  )
}

/**
 * 「所持武器の除外」 (`docs/UI_FLOW.md` 9.2): the weapons a single search really excluded, each with the reasons recorded
 * when that search's input was prepared. Kept apart from the Candidate Search notices. Shown only when at least one
 * weapon was excluded; internal IDs appear in Debug Mode only.
 */
export function SourceExclusionResultAlert({
  display,
  debugMode = false,
  headingLevel = 'h3',
}: {
  display: SearchSourceExclusionDisplay
  debugMode?: boolean
  headingLevel?: DisclosureHeadingLevel
}) {
  const count = display.excludedWeapons.length
  if (!display.excludeOtherTargetSources || count === 0) return null
  return (
    <Alert severity="info" sx={{ '& .MuiAlert-message': { flex: '1 1 auto', minWidth: 0 } }}>
      <AlertTitle>{SOURCE_EXCLUSION_RESULT_TITLE}</AlertTitle>
      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {sourceExclusionResultMessage(count)}
        </Typography>
        <DisclosureAccordion title={sourceExclusionDisclosureTitle(count)} headingLevel={headingLevel}>
          <Box component="ul" aria-label="除外した所持武器" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
            {display.excludedWeapons.map((weapon, index) => (
              <Box
                component="li"
                key={weapon.ownedWeaponId}
                sx={{ minWidth: 0, borderTop: index === 0 ? 0 : 1, borderColor: 'divider', pt: index === 0 ? 0 : 1 }}
              >
                <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                  {weapon.weaponName}
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {weapon.reasons.map((reason) => (
                    <Typography
                      component="li"
                      variant="body2"
                      color="text.secondary"
                      key={`${reason.kind}:${reason.targetWeaponId}`}
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {sourceExclusionReasonLabel(reason)}
                    </Typography>
                  ))}
                </Box>
                {debugMode && (
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: 'anywhere' }}>
                    ownedWeaponId: {weapon.ownedWeaponId}
                    {weapon.reasons.map((reason) => (
                      <Box component="span" key={`${reason.kind}:${reason.targetWeaponId}`} sx={{ display: 'block' }}>
                        {reason.kind}: {reason.targetWeaponId}
                        {reason.buildListEntryIds.length > 0 && ` (${reason.buildListEntryIds.join(', ')})`}
                      </Box>
                    ))}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>
        </DisclosureAccordion>
      </Stack>
    </Alert>
  )
}
