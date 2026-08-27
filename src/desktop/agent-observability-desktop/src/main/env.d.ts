/**
 * Build-time constants electron-vite bakes into the main bundle. Only
 * `MAIN_VITE_`-prefixed variables present at `electron-vite build` time are
 * statically replaced; anything absent compiles to `undefined`.
 */
interface ImportMetaEnv {
  /**
   * Fine-grained GitHub PAT (contents: read, this repo only) that lets the
   * auto-updater read release assets on the INTERNAL-visibility repo. CI sets
   * it from the DESKTOP_UPDATE_TOKEN secret; local builds lack it, which
   * disables update checks.
   */
  readonly MAIN_VITE_UPDATE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
