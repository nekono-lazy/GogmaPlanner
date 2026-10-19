/**
 * Build-time env read by the Pages stale client detection
 * (`src/services/appVersion`). The deploy workflow sets it to `github.sha`;
 * local development and ordinary CI builds leave it unset.
 */
interface ImportMetaEnv {
  readonly VITE_APP_BUILD_ID?: string
}
