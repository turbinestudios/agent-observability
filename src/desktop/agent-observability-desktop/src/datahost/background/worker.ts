import { parentPort, workerData } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource, SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { sweepSnapshotDirs } from '@agent-observability/core/src/telemetry/snapshot';
import type { IndexStatus, SessionRow } from '../../shared/rpc';
import { sessionKey } from '../../shared/rpc';
import { IndexDb } from '../indexer/indexDb';
import { ClaudeIndexer } from '../indexer/claudeIndexer';
import { CopilotIndexer } from '../indexer/copilotIndexer';
import { CopilotCliIndexer, dropCopilotDuplicates } from '../indexer/copilotCliIndexer';
import { CopilotCliSource } from '@agent-observability/core/src/copilotCli/copilotCliSource';
import { NativeTelemetryBackend } from '../drivers/nativeTelemetryBackend';
import { AnalysisQueue } from '../analysis/analysisQueue';
import { ensureArchiveIndexes } from '../archiveIndexes';
import type { BackgroundInput, BackgroundMessage } from './protocol';

const input = workerData as BackgroundInput;
const port = parentPort;
if (port === null) {
  throw new Error('Background processing requires a worker thread.');
}
const send = (message: BackgroundMessage): void => port.postMessage(message);
// The broker alone initializes/migrates. A worker never drops live tables.
const db = new IndexDb(input.indexPath, { initialize: false });
const settings = {
  get: <T>(key: string, fallback: T): T => (input.settings[key] === undefined ? fallback : input.settings[key] as T),
  onDidChange: () => ({ dispose: () => undefined }),
};
const config = new Configuration(settings);
const telemetry = new TelemetryService(config, undefined, new NativeTelemetryBackend(db));
telemetry.setArchiveDbPath(resolveArchiveDbPath(config));
const sources = new SourceRegistry([
  new ClaudeCodeService(config),
  new CopilotSource(telemetry, config),
  new CopilotCliSource(config),
]);
let status: IndexStatus = { indexed: 0, total: 0, phase: 'discovering' };
const progress = (): void => {
  status = { ...status, ...db.counts() };
  send({ type: 'index', status });
};
const onRows = (rows: SessionRow[]): void => {
  send({ type: 'rows', keys: rows.map((row) => sessionKey(row.source, row.sessionId)) });
  progress();
};
const onDiscovered = (): void => {
  status = { ...status, phase: 'hydrating' };
  progress();
};
const before = db.sessionKeys();
const notes: string[] = [];

try {
  // Heal old-release copies off the interactive path. Fresh extension copies
  // keep the same age protection as before.
  if (input.cleanupSnapshots === true) {
    sweepSnapshotDirs(path.join(os.homedir(), '.agent-observability', 'desktop', 'snapshots'));
    sweepSnapshotDirs(os.tmpdir(), 60 * 60_000);
  }
  if (input.ensureArchiveIndexes === true && config.isLocalTelemetryEnabled()) {
    const note = ensureArchiveIndexes(config);
    if (note !== undefined) { notes.push(`Copilot: ${note}`); }
  }
  // No archive writer lease is held beyond this point. The broker may now
  // terminate parsing safely to serialize a settings/delete/rebuild mutation.
  send({ type: 'ready' });
  progress();
  if (config.isClaudeEnabled()) {
    try { new ClaudeIndexer({ db, config, onRows, onDiscovered }).run(); }
    catch (error) { notes.push(`Claude Code: ${String(error)}`); }
  } else {
    db.removeMissing('claude', new Set());
    notes.push('Claude Code is turned off in Settings');
  }
  if (config.isCopilotCliEnabled()) {
    try {
      const result = new CopilotCliIndexer({ db, config, onRows, onDiscovered }).run();
      if (result.helperRuns > 0) { notes.push(`Copilot CLI: left out ${result.helperRuns} of this app's own helper runs`); }
    } catch (error) { notes.push(`Copilot CLI: ${String(error)}`); }
  } else {
    db.removeMissing('copilot-cli', new Set());
    notes.push('Copilot CLI is turned off in Settings');
  }
  if (config.isLocalTelemetryEnabled()) {
    try {
      const result = new CopilotIndexer({ db, config, onRows, onDiscovered }).run();
      if (result.skipped !== undefined) { notes.push(`Copilot: ${result.skipped}`, ...input.copilotNotes); }
    } catch (error) { notes.push(`Copilot: ${String(error)}`); }
  } else {
    db.removeMissing('copilot', new Set());
    notes.push('Copilot is turned off in Settings');
  }
  // A session the CLI stored and VS Code also traced is one session: the CLI row wins.
  dropCopilotDuplicates(db);
  const present = new Set(db.sessionKeys());
  const removed = before.filter((key) => !present.has(key));
  if (removed.length > 0) { send({ type: 'removed', keys: removed }); }
  status = { ...status, phase: 'idle', message: notes.length === 0 ? undefined : notes.join(' · ') };
  progress();

  const analysis = new AnalysisQueue({
    db, sources, detector: new LocalDeviationDetector(config),
    settledBeforeMs: () => input.skipAnalysisNewerThanMs,
    acceptedMissing: () => ({
      files: settings.get<string[]>('context.acceptedMissingFiles', []),
      sources: settings.get<string[]>('context.acceptedMissingSources', []),
    }),
    onAnalyzed: (targets) => send({ type: 'rows', keys: targets.map((t) => sessionKey(t.source, t.sessionId)) }),
    onProgress: (status) => {
      send({ type: 'analysis', status });
      if (!status.running) {
        sources.dispose();
        db.close();
        send({ type: 'done' });
        port.close();
      }
    },
  });
  analysis.start();
} catch (error) {
  sources.dispose();
  db.close();
  throw error;
}