// @ts-check
/**
 * esbuild bundler for the Agent Observability VS Code extension.
 *
 * Produces dist/extension.js as a CommonJS bundle with `vscode` marked
 * external (it is provided by the VS Code runtime, never bundled).
 *
 * Usage:
 *   node esbuild.js          -> one-shot production build (minified, no sourcemap)
 *   node esbuild.js --watch  -> incremental dev build with sourcemaps
 *
 * Set NODE_ENV=production (or pass nothing) for a production build; --watch
 * implies a development build with sourcemaps.
 */
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production' && !watch;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // `vscode` is provided by the host at runtime. `node-sqlite3-wasm` is a pure
  // WebAssembly SQLite build (no native .node binary, so no Node/Electron ABI
  // mismatch) but it locates its `.wasm` sidecar relative to its own
  // `__dirname`; bundling the JS into dist/ would break that lookup. So it is
  // marked external, resolved from node_modules at runtime, and shipped in the
  // .vsix (see .vscodeignore re-includes).
  external: ['vscode', 'node-sqlite3-wasm'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(options);
    console.log('[esbuild] build complete -> dist/extension.js');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
