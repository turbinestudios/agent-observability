/**
 * Why do some Copilot sessions have no repository?
 *
 * The indexer resolves a repository only from span attributes, which are
 * sparse. The extension additionally builds a map from every VS Code workspace
 * store, joining each workspace's chat-session ids to that folder's git remote.
 * This checks how much of the gap that map closes on real data.
 */
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { GitRemoteResolver } from '@agent-observability/core/src/claude/gitRemote';
import { buildGlobalSessionRepositories } from '@agent-observability/core/src/telemetry/globalWorkspaceRepos';
import { titleStorageDirs } from '@agent-observability/core/src/telemetry/titleStore';
import { resolveDatabasePaths } from '@agent-observability/core/src/telemetry/paths';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { IndexDb } from '../src/datahost/indexer/indexDb';

function main(): void {
  const config = new Configuration(new DesktopSettingsReader());
  const db = new IndexDb();

  const sourcePaths = resolveDatabasePaths(config).databases.map((d) => d.path);
  const roots = titleStorageDirs(sourcePaths);
  console.log(`workspaceStorage roots: ${roots.length}`);
  for (const root of roots) {
    console.log(`  ${root}`);
  }

  const gitRemote = new GitRemoteResolver();
  const started = process.hrtime.bigint();
  const map = new Map<string, string>();
  for (const root of roots) {
    for (const [id, repo] of buildGlobalSessionRepositories(root, (p) => gitRemote.resolve(p))) {
      map.set(id, repo);
    }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`\nmapped ${map.size} session ids in ${ms.toFixed(0)} ms`);

  const repos = [...new Set(map.values())].sort();
  console.log(`\n${repos.length} distinct repositories in the map:`);
  for (const r of repos) {
    console.log(`  ${r}`);
  }

  // How many currently-unknown sessions would this rescue?
  const unknown = db.listSessions({ limit: 2000 }).filter((r) => r.repository === 'unknown');
  const rescued = unknown.filter((r) => map.has(r.sessionId));
  console.log(`\nsessions currently unknown: ${unknown.length}`);
  console.log(`  of those, the map resolves: ${rescued.length}`);
  for (const r of rescued) {
    console.log(`    [${r.source}] ${(r.title ?? r.sessionId).slice(0, 34).padEnd(36)} -> ${map.get(r.sessionId)}`);
  }
  const stillUnknown = unknown.filter((r) => !map.has(r.sessionId));
  if (stillUnknown.length > 0) {
    console.log(`  still unresolved: ${stillUnknown.length}`);
    for (const r of stillUnknown.slice(0, 6)) {
      console.log(`    [${r.source}] ${(r.title ?? r.sessionId).slice(0, 40)}`);
    }
  }

  db.close();
}

main();
