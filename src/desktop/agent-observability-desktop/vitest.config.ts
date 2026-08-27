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
  },
});
