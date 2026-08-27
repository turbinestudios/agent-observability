import { defineConfig } from 'vitest/config';

/**
 * Core is host-independent, so its whole suite runs headless by construction —
 * there is no Extension Host and no Electron runtime to stand up. Tests are
 * co-located with the code they cover.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    // Many telemetry tests copy a real SQLite fixture to temp and rewrite it
    // through WASM SQLite before reading it back — several seconds of honest
    // I/O that overruns vitest's 5s default under parallel load on slow CI
    // runners. Nothing here asserts on timing, so the ceiling is generous.
    testTimeout: 30_000,
  },
});
