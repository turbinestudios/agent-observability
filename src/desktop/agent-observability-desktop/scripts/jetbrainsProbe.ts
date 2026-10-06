/**
 * What the Copilot-for-JetBrains reader makes of the chat stores on THIS
 * machine, reported as structure only so the output can be pasted into an
 * issue: store paths, sizes, header bytes, record-name counts, and how many
 * conversations, turns and models the scanner recovered. No prompt, reply,
 * title or project name is ever printed.
 *
 *   npx vite-node scripts/jetbrainsProbe.ts [store root]
 *
 * Read-only: each store file is read into memory; nothing is written.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanNitriteStore } from '@agent-observability/core/src/copilotJetbrains/nitriteScan';
import {
  JETBRAINS_CHAT_KINDS,
  copilotJetbrainsRoot,
  discoverJetbrainsStores,
  jetbrainsIdeName,
} from '@agent-observability/core/src/copilotJetbrains/paths';

const override = process.argv[2];
const root = copilotJetbrainsRoot(override);
console.log(`Store root: ${override !== undefined ? 'override' : 'default'} (${fs.existsSync(root) ? 'exists' : 'missing'})`);

// Only the plugin's own folder names are printed: other folders under the
// root (Visual Studio's, for one) can be named after the signed-in account.
const KNOWN = new Set<string>([...JETBRAINS_CHAT_KINDS, 'bg-agent-sessions']);
if (fs.existsSync(root)) {
  for (const ide of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ide.isDirectory()) {
      continue;
    }
    const folders = fs.readdirSync(path.join(root, ide.name), { withFileTypes: true }).filter((k) => k.isDirectory());
    const kinds = folders.filter((k) => KNOWN.has(k.name)).map((k) => k.name);
    if (kinds.length > 0) {
      console.log(`  ${ide.name}/  ${kinds.join(', ')}`);
    } else {
      console.log(`  (a folder with no Copilot chat stores, ${folders.length} subfolders)`);
    }
  }
}

const stores = discoverJetbrainsStores(override);
console.log(`\nChat stores found: ${stores.length}`);
for (const store of stores) {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(store.path);
  } catch (error) {
    console.log(`\n${path.relative(root, store.path)}\n  could not read: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    continue;
  }
  const scan = scanNitriteStore(bytes);
  const header = bytes.subarray(0, 24).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  const conversations = scan.conversations;
  console.log(`\n${path.relative(root, store.path)}`);
  console.log(`  IDE ${jetbrainsIdeName(store.ide)} (${store.ide}), ${store.kind}, ${(store.size / 1024).toFixed(0)} KB`);
  console.log(`  header "${header}"  MVStore: ${scan.stats.mvstoreHeader}`);
  console.log(`  Java strings: ${scan.stats.strings}`);
  console.log(`  record names: ${JSON.stringify(scan.stats.markers)}`);
  console.log(`  conversations: ${conversations.length} (with id ${conversations.filter((c) => c.id !== undefined).length}, with title ${conversations.filter((c) => c.title !== undefined).length}, with project ${conversations.filter((c) => c.projectName !== undefined).length})`);
  const turns = conversations.flatMap((c) => c.turns);
  console.log(
    `  turns: ${turns.length} (agent ${turns.filter((t) => t.mode === 'agent').length}, ask ${turns.filter((t) => t.mode === 'ask').length}, ` +
      `with prompt ${turns.filter((t) => t.prompt !== undefined).length}, with reply ${turns.filter((t) => t.reply !== undefined).length}, ` +
      `with time ${turns.filter((t) => t.timestampMs !== undefined).length}, with model ${turns.filter((t) => t.model !== undefined).length})`,
  );
  console.log(`  distinct model ids: ${scan.stats.models}; file references: ${conversations.reduce((n, c) => n + c.fileUris.length, 0)}`);
}
