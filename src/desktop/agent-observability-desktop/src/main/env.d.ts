/**
 * Build-time constants electron-vite bakes into the main bundle. Only
 * `MAIN_VITE_`-prefixed variables present at `electron-vite build` time are
 * statically replaced; anything absent compiles to `undefined`.
 */
interface ImportMetaEnv {
  /**
   * `'1'` in official release builds, which turns on update checks against the
   * public release feed. The release workflow sets it; local builds and forks
   * lack it, which disables update checks. Not a secret.
   */
  readonly MAIN_VITE_ENABLE_UPDATES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
