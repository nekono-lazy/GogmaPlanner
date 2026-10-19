import type { ThemeMode } from './theme'

/**
 * The Light / Dark choice as a local Presentation preference of this device
 * and browser (`docs/UI_FLOW.md` 3.5).
 *
 * It is deliberately not user data: it lives in `localStorage` under its own
 * key, never in `AppSettings`, the Dexie settings table or `ExportRoot`, so an
 * Export does not carry it, an Import does not change it and clearing all data
 * does not reset it. The operating system colour scheme is never followed: the
 * default is `light`, and only the user's own choice changes it.
 *
 * Every access is guarded. Storage can be missing, blocked or throwing
 * (privacy modes, disabled site data, quota), and a stored value is untrusted
 * text; none of that may break the application, so a read falls back to
 * `light` and a write reports failure instead of throwing.
 */
export const THEME_MODE_STORAGE_KEY = 'gogma-artian-planner.theme-mode'

export const DEFAULT_THEME_MODE: ThemeMode = 'light'

/** The part of `Storage` the preference uses; injectable for tests. */
export type ThemeModeStorage = Pick<Storage, 'getItem' | 'setItem'>

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark'
}

/**
 * The browser's `localStorage`, or `null` when it cannot be reached. Merely
 * reading `window.localStorage` throws in some browsers when site data is
 * blocked, so the access itself is guarded.
 */
export function browserThemeModeStorage(): ThemeModeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The stored mode; `light` for no value, an unknown value or a failed read. */
export function readThemeMode(storage: ThemeModeStorage | null): ThemeMode {
  if (storage === null) return DEFAULT_THEME_MODE
  try {
    const stored = storage.getItem(THEME_MODE_STORAGE_KEY)
    return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE
  } catch {
    return DEFAULT_THEME_MODE
  }
}

/** Persists the mode; `false` when storage is unavailable or the write failed. */
export function writeThemeMode(storage: ThemeModeStorage | null, mode: ThemeMode): boolean {
  if (storage === null) return false
  try {
    storage.setItem(THEME_MODE_STORAGE_KEY, mode)
    return true
  } catch {
    return false
  }
}
