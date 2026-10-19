import { create } from 'zustand'
import type { ThemeMode } from '../app/theme'
import {
  browserThemeModeStorage,
  readThemeMode,
  writeThemeMode,
  type ThemeModeStorage,
} from '../app/themeModePreference'

/**
 * Presentation-only appearance state (`docs/UI_FLOW.md` 3.5).
 *
 * Kept apart from `useSettingsStore` on purpose: that store mirrors the
 * exportable `AppSettings`, and an Import / clear rehydrates it from the
 * persisted record. The theme mode is a device-local preference, so nothing
 * that hydrates `AppSettings` can reach it.
 *
 * The initial mode is read synchronously when this module loads, before the
 * first render, so a stored Dark choice is applied on the first paint instead
 * of flashing Light and switching in an effect.
 */
interface AppearanceState {
  themeMode: ThemeMode
  /** The last change could not be saved; it still applies for this session. */
  themeModePersistFailed: boolean
  setThemeMode: (mode: ThemeMode) => void
  /** Re-reads the stored preference, as a page reload would; for tests. */
  reloadFromStorage: () => void
}

export function createAppearanceStore(storage: () => ThemeModeStorage | null = browserThemeModeStorage) {
  return create<AppearanceState>((set) => ({
    themeMode: readThemeMode(storage()),
    themeModePersistFailed: false,
    setThemeMode: (mode) => {
      const persisted = writeThemeMode(storage(), mode)
      set({ themeMode: mode, themeModePersistFailed: !persisted })
    },
    reloadFromStorage: () => set({ themeMode: readThemeMode(storage()), themeModePersistFailed: false }),
  }))
}

export const useAppearanceStore = createAppearanceStore()
