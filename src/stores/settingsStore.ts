import { create } from 'zustand'
import type { AppSettings } from '../domain/models/publicTypes'

interface SettingsUiState {
  debugMode: boolean
  isHydrated: boolean
  setDebugMode: (debugMode: boolean) => void
  hydrate: (settings: AppSettings) => void
  reset: () => void
}

export const useSettingsStore = create<SettingsUiState>((set) => ({
  debugMode: false,
  isHydrated: false,
  setDebugMode: (debugMode) => set({ debugMode }),
  hydrate: (settings) => set({ debugMode: settings.debugMode, isHydrated: true }),
  reset: () => set({ debugMode: false, isHydrated: false }),
}))
