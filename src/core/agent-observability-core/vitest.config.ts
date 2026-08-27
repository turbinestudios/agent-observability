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
  },
});
