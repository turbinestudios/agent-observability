import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Three build targets in one config.
 *
 * `externalizeDepsPlugin` keeps runtime dependencies out of the main and
 * datahost bundles — `better-sqlite3` is a native module that must be required
 * from node_modules at runtime, not inlined. The shared core is a devDependency
 * precisely so it stays bundled instead of being externalized.
 *
 * The datahost is a separate entry because it runs as its own utilityProcess:
 * all session parsing and indexing happens there, never on the main thread.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          datahost: resolve(__dirname, 'src/datahost/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
