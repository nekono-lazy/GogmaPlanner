import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import {
  APP_VERSION_MANIFEST_FILE_NAME,
  createAppVersionManifestJson,
  normalizeAppBuildId,
} from './src/services/appVersion/appBuildId.ts'

/**
 * Writes `version.json` for the stale client check (`docs/REQUIREMENTS.md` 3.3).
 *
 * The build ID comes from Vite's resolved env (`config.env`), which is the very
 * object Vite exposes to the bundle as `import.meta.env`, so the manifest and
 * the running JavaScript always carry the same `VITE_APP_BUILD_ID`. A build
 * without one (local, ordinary CI) writes no manifest.
 */
function appVersionManifest(): Plugin {
  let buildId: string | null = null
  return {
    name: 'gogma-artian-planner:app-version-manifest',
    apply: 'build',
    configResolved(config) {
      buildId = normalizeAppBuildId(config.env.VITE_APP_BUILD_ID)
    },
    generateBundle() {
      if (buildId === null) return
      this.emitFile({
        type: 'asset',
        fileName: APP_VERSION_MANIFEST_FILE_NAME,
        source: createAppVersionManifestJson(buildId),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), appVersionManifest()],
  base: '/GogmaPlanner/',
  build: {
    license: {
      fileName: 'licenses.md',
    },
  },
})
