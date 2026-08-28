import type { MessagePortMain } from 'electron';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource, SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type {
  ContextAction,
  IndexStatus,
  ListSessionsParams,
  RpcEvent,
  RpcRequest,
  RpcResponse,
  SessionRef,
  SessionRow,
} from '../shared/rpc';
import { MAX_COMPARE_SESSIONS, sessionKey } from '../shared/rpc';
import { DetailRenderer } from './detail/detailRenderer';
import type { CombinedRequest, DetailContext } from './detail/detailRenderer';
import { AnalysisQueue } from './analysis/analysisQueue';
import { DesktopSettingsReader } from './drivers/desktopConfig';
import { applySettingsPatch, buildSettingsSnapshot } from './settings';
import { ClaudeIndexer } from './indexer/claudeIndexer';
import { CopilotIndexer } from './indexer/copilotIndexer';
import { ensureArchiveIndexes } from './archiveIndexes';
import { IndexDb } from './indexer/indexDb';
import type { AnalysisTarget } from './indexer/indexDb';
import { RenameStore } from './renames';
import { HiddenStore } from './hidden';
import { describeDeletion, deleteSession } from './deletion';

/**
 * The data host: a utilityProcess that owns every expensive operation.
 *
 * It runs here rather than in the main process because core's session API is
 * synchronous — parsing a large transcript blocks whatever thread it runs on,
 * and on the main thread that would freeze the window. Keeping it in a separate
 * process also means a crash while parsing a corrupt file loses the index pass,
 * not the app.
 *
 * The renderer talks to this over a MessagePort handed over by main, so requests
 * never round-trip through the main thread.
 */

const settings = new DesktopSettingsReader();
const config = new Configuration(settings);
const db = new IndexDb();

// The same registry abstraction the extension wires up. Listing comes from the
// index; the registry serves session detail, where the per-source parsing
// differences live. Cloud sources plug in here unchanged as they land.
//
// The archive has to be pointed at explicitly, exactly as the extension does at
// startup. Without it the read layer falls back to Copilot's own short-lived
// database, which holds a rolling handful of sessions — so every session the
// indexer found in the archive fails to open with "database not found".
const telemetry = new TelemetryService(config);
telemetry.setArchiveDbPath(resolveArchiveDbPath(config));

// Held directly as well as via the registry: its directory-listing cache must
// be dropped on every index pass, or a session created while the app is open
// shows in the list but fails to open with "not found" until a restart.
const claude = new ClaudeCodeService(config);
const sources = new SourceRegistry([claude, new CopilotSource(telemetry, config)]);

// One detector for the whole process: it is stateless and reads the live config
// on every call, so the detail view and the background pass always agree about
// what counts as a deviation.
const deviations = new LocalDeviationDetector(config);
const detail = new DetailRenderer(sources, deviations);
const renames = new RenameStore();
const hidden = new HiddenStore();

/** How far back the overview charts look. */
const OVERVIEW_WINDOW_DAYS = 30;

let status: IndexStatus = { indexed: 0, total: 0, phase: 'idle' };
let indexing = false;
/** A pass was requested while one was running; run again when it finishes. */
let rerunQueued = false;
/** The archive is indexed once per launch, before anything reads it. */
let archiveIndexesEnsured = false;

/** Ports the renderer is reachable on. Populated by the handshake from main. */
const ports: MessagePortMain[] = [];

/**
 * Reads sessions in the background for the two things the index cannot answer
 * on its own: whether a session went wrong, and what it pulled into context.
 * Started after each index pass rather than during one, so parsing never
 * competes with the list filling in.
 */
const analysis = new AnalysisQueue({
  db,
  sources,
  detector: deviations,
  acceptedMissing,
  onProgress: (status) => emit({ event: 'analysis.progress', status }),
  onAnalyzed: pushAnalyzedRows,
});

/**
 * Push the list rows whose analysis just landed, so a deviation badge appears
 * without the user refreshing. Hidden sessions are dropped here exactly as the
 * indexer's own pushes drop them.
 */
function pushAnalyzedRows(targets: readonly AnalysisTarget[]): void {
  const rows = targets
    .filter((t) => !hidden.isHidden(t.source, t.sessionId))
    .map((t) => db.getRow(t.source, t.sessionId))
    .filter((row): row is SessionRow => row !== undefined);
  if (rows.length > 0) {
    emit({ event: 'sessions.upserted', rows: renames.apply(rows) });
  }
}

function post(message: RpcResponse | RpcEvent): void {
  for (const port of ports) {
    port.postMessage(message);
  }
}

function emit(event: RpcEvent): void {
  post(event);
}

function refreshCounts(): void {
  const counts = db.counts();
  status = { ...status, indexed: counts.indexed, total: counts.total };
}

/**
 * Run an index pass over every source. Rows are pushed as they are written so
 * the list fills in progressively instead of waiting for the whole sweep.
 *
 * A source that fails does not stop the others: a missing or locked Copilot
 * database should never cost the user their Claude sessions.
 */
function runIndex(): IndexStatus {
  if (indexing) {
    // A settings change landing mid-pass must still apply: queue one more pass
    // instead of silently dropping the request.
    rerunQueued = true;
    return status;
  }
  indexing = true;
  status = { ...status, phase: 'discovering', message: undefined };
  emit({ event: 'index.progress', status });

  // The detail path keeps its own directory listing; forget it so a session
  // created since the last pass can be opened as soon as it is listed.
  claude.invalidateDiscovery();

  const notes: string[] = [];
  const onRows = (rows: SessionRow[]): void => {
    // The indexer writes the source's own title, which is correct for the index
    // but wrong to show: a user-chosen name has to be layered back on before
    // these reach the list, or a refresh silently reverts every rename. Hidden
    // sessions are dropped here for the same reason — a refresh must not put
    // one back on screen.
    const visible = rows.filter((r) => !hidden.isHidden(r.source, r.sessionId));
    if (visible.length > 0) {
      emit({ event: 'sessions.upserted', rows: renames.apply(visible) });
    }
    refreshCounts();
    emit({ event: 'index.progress', status });
  };
  const onDiscovered = (total: number): void => {
    // Sources are indexed one after another, so the total accumulates rather
    // than being replaced — otherwise the progress bar would restart.
    status = { ...status, total: status.total + total, phase: 'hydrating' };
    emit({ event: 'index.progress', status });
  };

  // Start each pass from a clean total so a refresh does not double-count.
  status = { ...status, total: 0 };

  // A disabled source is purged rather than skipped: its indexers would leave
  // the previously indexed rows on screen forever otherwise.
  if (config.isClaudeEnabled()) {
    try {
      new ClaudeIndexer({ db, config, onDiscovered, onRows }).run();
    } catch (err) {
      notes.push(`Claude Code: ${errorText(err)}`);
    }
  } else {
    purgeSource('claude');
    notes.push('Claude Code is turned off in Settings');
  }

  if (config.isLocalTelemetryEnabled()) {
    try {
      // Before anything reads the archive: without the read layer's indexes the
      // first session opened after a launch takes minutes, not seconds.
      if (!archiveIndexesEnsured) {
        archiveIndexesEnsured = true;
        const note = ensureArchiveIndexes(config);
        if (note !== undefined) {
          notes.push(`Copilot: ${note}`);
        }
      }
      const copilot = new CopilotIndexer({ db, config, onDiscovered, onRows }).run();
      if (copilot.skipped !== undefined) {
        notes.push(`Copilot: ${copilot.skipped}`);
      }
    } catch (err) {
      notes.push(`Copilot: ${errorText(err)}`);
    }
  } else {
    purgeSource('copilot');
    notes.push('Copilot is turned off in Settings');
  }

  refreshCounts();
  indexing = false;
  status = {
    ...status,
    phase: 'idle',
    // Kept as an advisory note, not an error: the sources that did work are
    // still listed, and the user should know which one did not.
    message: notes.length === 0 ? undefined : notes.join(' · '),
  };
  emit({ event: 'index.progress', status });

  if (rerunQueued) {
    rerunQueued = false;
    return runIndex();
  }
  // Only once the pass has settled: reading transcripts while the indexer is
  // still writing rows would put two heavy jobs on this one thread at once.
  analysis.start();
  return status;
}

/** Drop every indexed row of a source and tell the list, so toggling a source off empties it live. */
function purgeSource(source: string): void {
  const keys = db.removeMissing(source, new Set());
  if (keys.length > 0) {
    emit({ event: 'sessions.removed', keys });
    refreshCounts();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settings keys shared with the extension, so both honour the same accepts. */
const ACCEPTED_FILES_KEY = 'context.acceptedMissingFiles';
const ACCEPTED_SOURCES_KEY = 'context.acceptedMissingSources';

function acceptedMissing(): AcceptedMissingConfig {
  return {
    files: settings.get<string[]>(ACCEPTED_FILES_KEY, []),
    sources: settings.get<string[]>(ACCEPTED_SOURCES_KEY, []),
  };
}

function detailContext(source: string, sessionId: string): DetailContext {
  return { acceptedMissing: acceptedMissing(), renamedTitle: renames.get(source, sessionId) };
}

/**
 * Remember a context gap the user has accepted, so the analysis stops flagging
 * it. Appends rather than replaces, and ignores a duplicate.
 */
function applyContextAction(action: ContextAction): void {
  const key = action.kind === 'accept-file' ? ACCEPTED_FILES_KEY : ACCEPTED_SOURCES_KEY;
  const current = settings.get<string[]>(key, []);
  if (current.includes(action.value)) {
    return;
  }
  settings.update({ [key]: [...current, action.value] });
}

/**
 * List sessions, with user-chosen names layered on.
 *
 * A text search runs in SQL over the ORIGINAL titles, so a session found only
 * by its new name has to be unioned in separately — otherwise renaming a
 * session would make it unsearchable by the name the user just gave it.
 */
function listSessions(params: ListSessionsParams): SessionRow[] {
  const hiddenKeys = hidden.all();
  const rows = db.listSessions(params, hiddenKeys);
  const query = params.query?.trim() ?? '';
  if (query.length === 0) {
    return renames.apply(rows);
  }

  const seen = new Set(rows.map((r) => sessionKey(r.source, r.sessionId)));
  const showingHidden = params.hidden === true;
  const extraKeys = renames
    .matchingKeys(query)
    .filter((key) => !seen.has(key) && hidden.all().includes(key) === showingHidden);
  const extra = db.getRowsByKey(extraKeys).filter((row) => {
    // The union must still respect an active source filter.
    if (params.source !== undefined && row.source !== params.source) {
      return false;
    }
    return params.repository === undefined || row.repository === params.repository;
  });

  return renames
    .apply([...rows, ...extra])
    .sort((a, b) => b.endedAtMs - a.endedAtMs || (a.sessionId < b.sessionId ? 1 : -1));
}

/** The indexed timestamp doubles as the detail cache key. */
function stampOf(source: string, sessionId: string): number {
  return db.getRow(source, sessionId)?.indexedAtMs ?? 0;
}

function handle(request: RpcRequest): unknown {
  switch (request.method) {
    case 'ping':
      return request.params[0];
    case 'sessions.list':
      return listSessions(request.params[0]);
    case 'sessions.groups':
      return db.listGroups(hidden.all());
    case 'sessions.count':
      return db.countSessions(request.params[0], hidden.all());
    case 'sessions.hide': {
      const [source, sessionId, isHidden] = request.params;
      hidden.set(source, sessionId, isHidden);
      // The list filters on this, so it has to re-query rather than patch.
      emit({ event: 'sessions.removed', keys: [sessionKey(source, sessionId)] });
      return undefined;
    }
    case 'sessions.hiddenCount':
      return hidden.size();
    case 'sessions.deletionPlan': {
      const [source, sessionId] = request.params;
      return describeDeletion(source, sessionId, { config });
    }
    case 'sessions.delete': {
      const [source, sessionId] = request.params;
      const result = deleteSession(source, sessionId, { config });
      if (result.ok) {
        // Drop it from the index too, or the next list would still show it
        // until a re-index noticed the source data was gone.
        db.removeSession(source, sessionId);
        detail.invalidate(source, sessionId);
        emit({ event: 'sessions.removed', keys: [sessionKey(source, sessionId)] });
        refreshCounts();
      }
      return result;
    }
    case 'sessions.detail': {
      const [source, sessionId, theme, force] = request.params;
      if (force === true) {
        // Re-read the transcript as it is on disk right now. The memoized parse
        // is keyed by index stamp, which does not move without an index pass —
        // dropping it (and the Claude directory listing) is what forces the
        // fresh read for an actively running session.
        detail.invalidate(source, sessionId);
        if (source === 'claude') {
          claude.invalidateDiscovery();
        }
      }
      return detail.renderDocument(
        source,
        sessionId,
        theme,
        stampOf(source, sessionId),
        detailContext(source, sessionId),
      );
    }
    case 'sessions.combinedDetail': {
      const [keys, theme] = request.params;
      // Enforced here as well as in the UI: the button is only one way in, and
      // parsing an unbounded selection would block every other call meanwhile.
      if (keys.length < 2) {
        throw new Error('Comparing needs at least two sessions.');
      }
      if (keys.length > MAX_COMPARE_SESSIONS) {
        throw new Error(`At most ${MAX_COMPARE_SESSIONS} sessions can be compared at once.`);
      }
      const requests: CombinedRequest[] = keys.map((key: SessionRef) => ({
        source: key.source,
        sessionId: key.sessionId,
        stamp: stampOf(key.source, key.sessionId),
        context: detailContext(key.source, key.sessionId),
      }));
      return detail.renderCombinedDocument(requests, theme);
    }
    case 'sessions.detailBody': {
      const [source, sessionId] = request.params;
      return detail.renderBody(
        source,
        sessionId,
        stampOf(source, sessionId),
        detailContext(source, sessionId),
      );
    }
    case 'sessions.contextAction': {
      const [source, sessionId, action] = request.params;
      applyContextAction(action);
      // The accepted lists are part of the analysis cache key, so this rebuilds
      // rather than returning the stale breakdown.
      return detail.renderBody(
        source,
        sessionId,
        stampOf(source, sessionId),
        detailContext(source, sessionId),
      );
    }
    case 'sessions.rename': {
      const [source, sessionId, title] = request.params;
      renames.set(source, sessionId, title);
      // The cached document carries the old name in its header.
      detail.invalidate(source, sessionId);
      const row = db.getRow(source, sessionId);
      if (row === undefined) {
        return undefined;
      }
      const [patched] = renames.apply([row]);
      emit({ event: 'sessions.upserted', rows: [patched] });
      return patched;
    }
    case 'sessions.row': {
      const [source, sessionId] = request.params;
      const row = db.getRow(source, sessionId);
      return row === undefined ? undefined : renames.apply([row])[0];
    }
    case 'hotspots.get': {
      const params = request.params[0] ?? {};
      const hiddenKeys = hidden.all();
      return {
        rows: db.hotspots(params, hiddenKeys),
        repositories: db.hotspotRepositories(hiddenKeys),
        status: analysis.status(),
      };
    }
    case 'hotspots.sessions': {
      const [file, params] = request.params;
      return db.hotspotSessions(file, params ?? {}, hidden.all());
    }
    case 'analysis.status':
      return analysis.status();
    case 'overview.get':
      // Hidden sessions are excluded so the totals agree with the list; a
      // count that includes what the user removed reads as a bug.
      return db.overview(OVERVIEW_WINDOW_DAYS, hidden.all());
    case 'settings.get':
      return buildSettingsSnapshot(settings, config);
    case 'settings.update': {
      const changed = applySettingsPatch(settings, request.params[0]);
      if (changed.copilot) {
        // The read layer caches open DB handles; drop them so the detail view
        // follows a changed sqlitePath instead of the old database.
        telemetry.refresh();
      }
      if (changed.deviation) {
        // Every stored verdict was measured against the old threshold, and the
        // open document carries cards drawn from it.
        db.clearDeviations();
        detail.invalidateAll();
      }
      if (changed.claude || changed.copilot) {
        // Respond with the snapshot first, then bring the index in line.
        setTimeout(() => runIndex(), 0);
      } else if (changed.deviation) {
        setTimeout(() => analysis.start(), 0);
      }
      return buildSettingsSnapshot(settings, config);
    }
    case 'index.status':
      refreshCounts();
      return status;
    case 'index.refresh':
      return runIndex();
    case 'index.rebuild':
      db.clear();
      refreshCounts();
      emit({ event: 'index.progress', status });
      return runIndex();
    default: {
      // Exhaustiveness: adding a method to RpcMethods without handling it here
      // is a compile error rather than a runtime "unknown method".
      const never: never = request;
      throw new Error(`Unknown method: ${JSON.stringify(never)}`);
    }
  }
}

function attach(port: MessagePortMain): void {
  ports.push(port);
  port.on('message', (event) => {
    const request = event.data as RpcRequest;
    if (request === null || typeof request !== 'object' || typeof request.id !== 'number') {
      return;
    }
    try {
      port.postMessage({ id: request.id, ok: true, value: handle(request) } satisfies RpcResponse);
    } catch (err) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RpcResponse);
    }
  });
  port.start();
}

const debug = process.env.AO_DEBUG === '1';

// Main sends the renderer's MessagePort over as the first message.
process.parentPort?.on('message', (event) => {
  if (debug) {
    console.log(`[datahost] message from main, ports=${event.ports.length}`);
  }
  const [port] = event.ports;
  if (port !== undefined) {
    attach(port);
    refreshCounts();
    // Paint from whatever the last run left behind, then bring it up to date.
    emit({ event: 'index.progress', status });
    // Deferred so the handshake completes and the first paint happens before
    // the indexer starts competing for this process's single thread.
    setTimeout(() => runIndex(), 0);
  }
});
