import type { MessagePortMain } from 'electron';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import type { IndexStatus, RpcEvent, RpcRequest, RpcResponse, SessionRow } from '../shared/rpc';
import { DetailRenderer } from './detail/detailRenderer';
import { DesktopSettingsReader } from './drivers/desktopConfig';
import { ClaudeIndexer } from './indexer/claudeIndexer';
import { IndexDb } from './indexer/indexDb';

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

// The same registry abstraction the extension wires up. Only the Claude source
// is registered so far; the others plug in here unchanged as they land.
const sources = new SourceRegistry([new ClaudeCodeService(config)]);
const detail = new DetailRenderer(sources);

let status: IndexStatus = { indexed: 0, total: 0, phase: 'idle' };
let indexing = false;

/** Ports the renderer is reachable on. Populated by the handshake from main. */
const ports: MessagePortMain[] = [];

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
 * Run an index pass. Rows are pushed as they are written so the list fills in
 * progressively instead of waiting for the whole sweep.
 */
function runIndex(): IndexStatus {
  if (indexing) {
    return status;
  }
  indexing = true;
  status = { ...status, phase: 'discovering' };
  emit({ event: 'index.progress', status });

  try {
    const indexer = new ClaudeIndexer({
      db,
      config,
      onDiscovered: (total) => {
        status = { ...status, total, phase: 'hydrating' };
        emit({ event: 'index.progress', status });
      },
      onRows: (rows: SessionRow[]) => {
        emit({ event: 'sessions.upserted', rows });
        refreshCounts();
        emit({ event: 'index.progress', status });
      },
    });
    indexer.run();
    refreshCounts();
    status = { ...status, phase: 'idle', message: undefined };
  } catch (err) {
    status = { ...status, phase: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    indexing = false;
  }
  emit({ event: 'index.progress', status });
  return status;
}

function handle(request: RpcRequest): unknown {
  switch (request.method) {
    case 'ping':
      return request.params[0];
    case 'sessions.list':
      return db.listSessions(request.params[0]);
    case 'sessions.groups':
      return db.listGroups();
    case 'sessions.count':
      return db.countSessions(request.params[0]);
    case 'sessions.detail': {
      const [source, sessionId, theme] = request.params;
      // The indexed timestamp doubles as the cache key: it moves whenever the
      // indexer rewrites the row, which is exactly when a re-parse is needed.
      const row = db.getRow(source, sessionId);
      return detail.renderDocument(source, sessionId, theme, row?.indexedAtMs ?? 0);
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
