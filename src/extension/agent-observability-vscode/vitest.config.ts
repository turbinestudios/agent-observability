import { defineConfig } from 'vitest/config';

/**
 * Vitest runs headless against pure logic only. The `vscode` module is not
 * available outside the Extension Host, so any unit under test must avoid
 * importing it at module load time (keep VS Code-coupled code behind seams).
 *
 * Later phases test the SQLite adapter here against a fixture DB.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
