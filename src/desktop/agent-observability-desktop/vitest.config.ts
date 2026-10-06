import { defineConfig } from 'vitest/config';

/**
 * Node-environment tests only. The data host and indexer are plain Node, and
 * the renderer logic under test (formatting, row merging) is deliberately kept
 * free of DOM dependencies so it can be covered without a browser environment.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    // Index and telemetry tests write real SQLite files to temp: honest disk
    // I/O that takes milliseconds on a laptop and seconds on a loaded CI
    // runner. The release workflow runs these AFTER the version is tagged, so
    // a timeout there strands a release. Nothing asserts on timing, so the
    // ceiling is generous, the same as core's.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
