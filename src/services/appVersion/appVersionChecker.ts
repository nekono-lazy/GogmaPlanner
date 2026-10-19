import {
  APP_VERSION_MANIFEST_FILE_NAME,
  normalizeAppBuildId,
  parseAppVersionManifest,
} from './appBuildId'

/**
 * Stale client detection (`docs/REQUIREMENTS.md` 3.3, `docs/UI_FLOW.md` 3.6).
 *
 * The running build compares its own build ID with the one the latest Pages
 * deployment publishes in `version.json`. A difference means a newer build was
 * deployed while this page stayed open. The check is a helper feature: every
 * failure is silent and simply retried by the next check, and nothing here ever
 * reloads the page on its own.
 */

/** When the running build asks for the latest manifest (Application infrastructure constants). */
export const APP_VERSION_CHECK_TIMING = {
  /** A startup or visibility check is skipped when the last one started less than this ago. */
  minimumCheckGapMs: 60_000,
  /** Period of the check while the tab stays visible. No periodic check runs while it is hidden. */
  visibleIntervalMs: 15 * 60_000,
} as const

export interface AppVersionCheckTiming {
  minimumCheckGapMs: number
  visibleIntervalMs: number
}

/**
 * The build ID this JavaScript was built with, or `null` for a build without
 * one (local development, ordinary CI). Vite fills `VITE_APP_BUILD_ID` from the
 * same resolved env the build writes into `version.json`.
 */
export const currentAppBuildId: string | null = normalizeAppBuildId(import.meta.env.VITE_APP_BUILD_ID)

/**
 * The manifest URL under the Vite base. The unique query keeps an HTTP cache
 * from answering with an old manifest; it is a fetch URL only and never touches
 * the HashRouter location.
 */
export function appVersionManifestUrl(baseUrl: string, cacheBuster: number): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${APP_VERSION_MANIFEST_FILE_NAME}?t=${cacheBuster}`
}

/**
 * Fetches the latest published build ID. Never throws: an offline browser, a
 * network error, an HTTP error, malformed JSON and a manifest without a usable
 * `buildId` all resolve to `null` ("unknown"), with nothing logged.
 */
export async function fetchLatestAppBuildId(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (!response.ok) return null
    return parseAppVersionManifest(await response.json())
  } catch {
    return null
  }
}

export interface AppVersionChecker {
  /** `false` when this build has no production build ID: checks never fetch. */
  readonly isEnabled: boolean
  /** Sticky: once a newer build was seen it stays `true` until the page reloads. */
  isUpdateAvailable(): boolean
  /** Runs one check now. A check already in flight is shared, never duplicated. */
  check(): Promise<boolean>
  /** Runs one check unless the last one started less than `minimumGapMs` ago. */
  checkIfDue(minimumGapMs: number): Promise<boolean>
  subscribe(listener: () => void): () => void
}

export interface AppVersionCheckerOptions {
  currentBuildId: string | null
  fetchLatestBuildId(): Promise<string | null>
  now?: () => number
}

export function createAppVersionChecker({
  currentBuildId,
  fetchLatestBuildId,
  now = () => Date.now(),
}: AppVersionCheckerOptions): AppVersionChecker {
  const listeners = new Set<() => void>()
  let updateAvailable = false
  let lastCheckStartedAt: number | null = null
  let inFlight: Promise<boolean> | null = null

  const check = (): Promise<boolean> => {
    // No production build ID: nothing to compare with, so no request at all.
    if (currentBuildId === null) return Promise.resolve(false)
    // Detection is final for this page load; later failures cannot clear it.
    if (updateAvailable) return Promise.resolve(true)
    if (inFlight !== null) return inFlight
    lastCheckStartedAt = now()
    inFlight = fetchLatestBuildId()
      .catch(() => null)
      .then((latestBuildId) => {
        inFlight = null
        if (latestBuildId !== null && latestBuildId !== currentBuildId && !updateAvailable) {
          updateAvailable = true
          listeners.forEach((listener) => listener())
        }
        return updateAvailable
      })
    return inFlight
  }

  return {
    isEnabled: currentBuildId !== null,
    isUpdateAvailable: () => updateAvailable,
    check,
    checkIfDue(minimumGapMs) {
      if (lastCheckStartedAt !== null && now() - lastCheckStartedAt < minimumGapMs) {
        return inFlight ?? Promise.resolve(updateAvailable)
      }
      return check()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Starts the check lifecycle and returns its stop function: one check at
 * start, one when the tab becomes visible again, and one every
 * `visibleIntervalMs` while it stays visible. Startup and visibility checks
 * share the `minimumCheckGapMs` throttle, so rapid tab switches and a React
 * StrictMode remount never multiply requests. Hidden tabs keep no interval.
 */
export function startAppVersionMonitor(
  checker: AppVersionChecker,
  doc: Document = document,
  timing: AppVersionCheckTiming = APP_VERSION_CHECK_TIMING,
): () => void {
  if (!checker.isEnabled) return () => undefined

  let intervalId: ReturnType<typeof setInterval> | null = null

  const stopInterval = () => {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }
  const startInterval = () => {
    stopInterval()
    intervalId = setInterval(() => {
      if (doc.visibilityState === 'visible') void checker.check()
    }, timing.visibleIntervalMs)
  }
  const handleVisibilityChange = () => {
    if (doc.visibilityState === 'visible') {
      void checker.checkIfDue(timing.minimumCheckGapMs)
      startInterval()
    } else {
      stopInterval()
    }
  }

  doc.addEventListener('visibilitychange', handleVisibilityChange)
  void checker.checkIfDue(timing.minimumCheckGapMs)
  if (doc.visibilityState === 'visible') startInterval()

  return () => {
    doc.removeEventListener('visibilitychange', handleVisibilityChange)
    stopInterval()
  }
}

/** The one checker of this page load, comparing against the latest Pages manifest. */
export const defaultAppVersionChecker: AppVersionChecker = createAppVersionChecker({
  currentBuildId: currentAppBuildId,
  fetchLatestBuildId: () =>
    fetchLatestAppBuildId(
      (input, init) => globalThis.fetch(input, init),
      appVersionManifestUrl(import.meta.env.BASE_URL, Date.now()),
    ),
})

/** An ordinary browser reload. It never clears IndexedDB, AppSettings or any store. */
export function reloadPage(): void {
  window.location.reload()
}
