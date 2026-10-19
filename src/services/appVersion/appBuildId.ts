/**
 * The Pages build ID contract (`docs/REQUIREMENTS.md` 3.3, Issue #131).
 *
 * A GitHub Pages build carries the GitHub commit SHA it was built from as its
 * build ID: the deploy workflow passes `github.sha` as `VITE_APP_BUILD_ID`, the
 * running JavaScript reads it through `import.meta.env`, and the build writes
 * the very same value into `version.json`. This module is shared by the Vite
 * build (`vite.config.ts`) and the runtime checker, so both sides accept and
 * reject a value by one rule.
 *
 * The build ID is Application infrastructure only. It is never persisted, never
 * exported, and never a CalculationContext / artifact compatibility authority.
 * It must stay free of DOM and Vite types: the Node-side Vite config imports it.
 */

/** The version manifest file name, served next to `index.html` under the Vite base. */
export const APP_VERSION_MANIFEST_FILE_NAME = 'version.json'

/** Characters of the build ID shown to the user; comparisons always use the full ID. */
export const APP_BUILD_ID_DISPLAY_LENGTH = 7

/**
 * Returns the build ID when `value` is a usable one, `null` otherwise.
 *
 * A missing, non-string, or blank value is "no production build ID" - the
 * local development / ordinary CI case - and never a fabricated one.
 */
export function normalizeAppBuildId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/** The manifest body the build writes for `buildId`. */
export function createAppVersionManifestJson(buildId: string): string {
  return `${JSON.stringify({ buildId })}\n`
}

/**
 * Reads the build ID out of an untrusted manifest body. Anything but an object
 * whose `buildId` is a usable build ID is rejected with `null`.
 */
export function parseAppVersionManifest(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return normalizeAppBuildId((value as { buildId?: unknown }).buildId)
}

/** The short form shown in the Settings version information. */
export function formatAppBuildIdForDisplay(buildId: string): string {
  return buildId.slice(0, APP_BUILD_ID_DISPLAY_LENGTH)
}
