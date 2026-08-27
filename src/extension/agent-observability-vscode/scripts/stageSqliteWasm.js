// @ts-check
/**
 * Stages the node-sqlite3-wasm runtime dependency into dist/node_modules.
 *
 * node-sqlite3-wasm is marked external in esbuild (it locates its .wasm sidecar
 * relative to its own __dirname, so bundling the JS would break that lookup) and
 * must therefore ship as real files inside the .vsix.
 *
 * Under npm workspaces the package is hoisted to the REPO ROOT node_modules, so
 * it no longer sits inside the extension folder where .vscodeignore could
 * re-include it. Copying it to dist/node_modules solves that for good: dist/
 * ships wholesale, the anchored `node_modules/**` ignore rule does not match
 * `dist/node_modules`, and Node's resolution walks up from dist/extension.js
 * and finds dist/node_modules first — identical in dev and when installed.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'node_modules', 'node-sqlite3-wasm');

function packageRoot() {
  // Resolves through the workspace symlink / hoisted root, wherever npm put it.
  return path.dirname(require.resolve('node-sqlite3-wasm/package.json'));
}

function main() {
  const source = packageRoot();

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT_DIR), { recursive: true });
  fs.cpSync(source, OUT_DIR, { recursive: true, dereference: true });

  // The .wasm sidecar is the whole reason this dependency is not bundled; if it
  // is missing the .vsix would install and then fail at runtime, so fail loudly.
  const wasm = fs
    .readdirSync(path.join(OUT_DIR, 'dist'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.wasm'));
  if (wasm.length === 0) {
    throw new Error(`No .wasm sidecar found under ${path.join(OUT_DIR, 'dist')}`);
  }

  console.log(`[stage] node-sqlite3-wasm -> dist/node_modules (${wasm.map((w) => w.name).join(', ')})`);
}

main();
