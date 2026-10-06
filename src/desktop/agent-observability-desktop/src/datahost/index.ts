import type { MessagePortMain } from 'electron';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource, SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { CopilotCliSource } from '@agent-observability/core/src/copilotCli/copilotCliSource';
import { CopilotJetbrainsSource } from '@agent-observability/core/src/copilotJetbrains/copilotJetbrainsSource';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import * as path from 'node:path';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type {
  ContextAction,
  AnalysisStatus,
  IndexStatus,
  ReworkSessionRow,
  ListSessionsParams,
  RpcEvent,
  RpcRequest,
  RpcResponse,
  SessionRef,
  SessionRow,
} from '../shared/rpc';
import {
  DEFAULT_OVERVIEW_WINDOW,
  DEFAULT_TEAM_WINDOW,
  INSIGHT_HOTSPOT_LIMIT,
  INSIGHT_TOOL_LIMIT,
  TOOL_FAILURE_MIN_CALLS,
  MAX_COMPARE_SESSIONS,
  sessionKey,
  toOverviewWindow,
  toTeamWindow,
  windowStartMs,
} from '../shared/rpc';
import { DetailRenderer } from './detail/detailRenderer';
import type { CombinedRequest, DetailContext } from './detail/detailRenderer';
import { BackgroundController } from './background/controller';
import { ProcessingWorker } from './background/processingWorker';
import type { BackgroundInput, BackgroundMessage } from './background/protocol';
import { scoreHotspots } from './analysis/hotspotScore';
import { DesktopSettingsReader } from './drivers/desktopConfig';
import { NativeTelemetryBackend } from './drivers/nativeTelemetryBackend';
import { applySettingsPatch, buildSettingsSnapshot } from './settings';
import { IndexDb, resolveIndexDbPath } from './indexer/indexDb';
import type { SessionKeyOverlay } from './indexer/indexDb';
import { RenameStore } from './renames';
import { HiddenStore } from './hidden';
import { TagStore } from './tags';
import { NoteStore } from './notes';
import { describeDeletion, deleteSession } from './deletion';
import { DeepRetroStore, toLlmVerdict } from './deepRetros';
import { DEEP_RETRO_ENABLED_KEY, runDeepRetrospective } from './deepRetro';
import { ContextPlanStore } from './improve/contextPlans';
import {
  generateContextPlan,
  improveRepoStatus,
  planSummary,
  planView,
} from './improve/contextPlan';
import { applyContextPlan, diffForEdit, undoContextPlan } from './improve/contextPlanApply';
import { LiveBoardService } from './live/liveBoard';
import { markdownToHtml } from '@agent-observability/core/src/chat/webview/markdownToHtml';
import { buildRepositoryDigest, renderRepositoryDigestMarkdown } from '@agent-observability/core/src/analysis/repositoryDigest';
import { renderHandoffBriefMarkdown } from '@agent-observability/core/src/analysis/handoffBrief';
import { RunController } from './run/runController';
import { RunService } from './run/runService';
import { RunStore } from './run/runs';
import { resolveRuntimeTarget } from './run/runtimePath';
import { SdkRunDriver } from './run/sdkDriver';
import { RUN_DEFAULT_MODEL_KEY, RUN_DISCLOSED_KEY, runEnabledSetting } from './settings';
import { buildHandoff, buildReviewPackets, resumeTarget, type HandoffBriefDeps } from './packet/sessionText';
import { resolveRepoRoot } from './improve/repoRoot';
import { reworkFileRows } from './analysis/reworkPaths';
import { InboxService } from './inbox/inboxService';
import { InboxStore } from './inbox/inboxStore';
import { TeamController } from './team/teamController';
import { buildRepoDigestInput, buildRepoHub, buildRepositoryCards } from './workspace/repoHub';
import { AiBackendHolder, backendVendor } from './aiBackends';
import { AiHelperController } from './aiHelper';
import {
  COPILOT_SETUP_DISMISS_KEY,
  checkCopilotSetup,
  enableCopilotTracing,
  setupNotes,
  startupCopilotSetup,
} from './copilotSetup';

/**
 * Interactive data host. Background indexing/analysis runs in a worker with
 * its own WAL connection, never on this request-serving thread.
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
const indexPath = resolveIndexDbPath();
const db = new IndexDb(indexPath);

// The same registry abstraction the extension wires up. Listing comes from the
// index; the registry serves session detail, where the per-source parsing
// differences live. Cloud sources plug in here unchanged as they land.
//
// The archive has to be pointed at explicitly, exactly as the extension does at
// startup. Without it the read layer falls back to Copilot's own short-lived
// database, which holds a rolling handful of sessions — so every session the
// indexer found in the archive fails to open with "database not found".
const telemetry = new TelemetryService(config, undefined, new NativeTelemetryBackend(db));
telemetry.setArchiveDbPath(resolveArchiveDbPath(config));

// Held directly as well as via the registry: its directory-listing cache must
// be dropped on every index pass, or a session created while the app is open
// shows in the list but fails to open with "not found" until a restart.
// The runtime-store sources and the JetBrains reader cache their discovery the
// same way, so they are dropped with it.
const claude = new ClaudeCodeService(config);
const copilotCli = new CopilotCliSource(config);
const copilotApp = new CopilotCliSource(config, undefined, 'app');
const copilotJetbrains = new CopilotJetbrainsSource(config);
const sources = new SourceRegistry([
  claude,
  new CopilotSource(telemetry, config),
  copilotCli,
  copilotApp,
  copilotJetbrains,
]);
const invalidateDiscovery = (): void => {
  claude.invalidateDiscovery();
  copilotCli.refresh();
  copilotApp.refresh();
  copilotJetbrains.refresh();
};

// One detector for the whole process: it is stateless and reads the live config
// on every call, so the detail view and the background pass always agree about
// what counts as a deviation.
const deviations = new LocalDeviationDetector(config);
const detail = new DetailRenderer(sources, deviations);
const renames = new RenameStore();
const hidden = new HiddenStore();
// Tags and notes deliberately do NOT reach the AI backends below: everything
// they hold is text the user wrote, and the consent notices on the deep
// retrospective and the AI Helper enumerate exactly what those requests carry.
const tags = new TagStore();
const notes = new NoteStore();
const deepRetros = new DeepRetroStore();
const contextPlans = new ContextPlanStore();

// One backend wiring for everything that talks to the user's `claude` CLI —
// the deep retrospective and the AI Helper share its probe cache, and an AI
// settings change rebuilds it (a cached probe would ignore a changed path).
const aiBackends = new AiBackendHolder(config);
const aiHelper = new AiHelperController({
  db,
  sources,
  settings,
  renames,
  hidden,
  backend: () => aiBackends.active(),
  emit,
});

let status: IndexStatus = { indexed: 0, total: 0, phase: 'idle' };
let analysisRunning = false;
/**
 * The launch-time Copilot setup advisory, appended to the index notes whenever
 * the Copilot indexer finds no database. Refreshed after a consented enable so
 * the status bar never keeps claiming tracing is off once it isn't.
 */
let copilotSetupNotes: string[] = [];

/** Ports the renderer is reachable on. Populated by the handshake from main. */
const ports: MessagePortMain[] = [];

let cleanupSnapshots = true;
let ensureArchiveIndexes = true;
/**
 * Set when the live board asked for the next pass. Such a pass skips
 * re-analyzing sessions that are still being written to; a user-initiated
 * Refresh or the startup pass analyzes everything.
 */
let liveTriggered = false;
/** Sessions that ended within this long before a live-triggered pass are left for later. */
const LIVE_ANALYSIS_SETTLE_MS = 120_000;
const background = new BackgroundController({
  spawn: () => {
    const worker = new ProcessingWorker(path.join(__dirname, 'background.js'), {
      workerData: {
        indexPath, settings: settings.all(), copilotNotes: copilotSetupNotes,
        cleanupSnapshots, ensureArchiveIndexes,
        ...(liveTriggered ? { skipAnalysisNewerThanMs: Date.now() - LIVE_ANALYSIS_SETTLE_MS } : {}),
      } satisfies BackgroundInput,
    });
    cleanupSnapshots = false;
    ensureArchiveIndexes = false;
    liveTriggered = false;
    return worker;
  },
  onStart: () => {
    invalidateDiscovery();
    status = { ...status, phase: 'discovering', message: undefined };
    emit({ event: 'index.progress', status });
  },
  onStopped: () => {
    analysisRunning = false;
    status = { ...status, phase: 'idle' };
    emit({ event: 'analysis.progress', status: analysisStatus() });
  },
  onError: (error) => {
    analysisRunning = false;
    status = { ...status, phase: 'error', message: error.message };
    emit({ event: 'index.progress', status });
    emit({ event: 'analysis.progress', status: analysisStatus() });
  },
  onMessage: onBackgroundMessage,
});

function analysisStatus(): AnalysisStatus {
  return { ...db.analysisCounts(), running: analysisRunning };
}

// The live board: watches the transcripts the agents are writing right now
// and derives each session's status from its tail. Started once the first
// index pass settles, so a cold start paints the list before any watch is
// armed; its own re-index requests are marked so the analysis pass leaves
// still-moving transcripts alone.
// The attention inbox rides the live board's own change events, so "needs
// you" can never lag the card it is derived from. Bound late because each
// needs the other: the board feeds the inbox, the inbox reads the board.
const inboxRef: { current?: InboxService } = {};
// Bound late for the same reason: the run host is built after the board it reports to.
const runRef: { current?: RunController } = {};
const live = new LiveBoardService({
  db,
  config,
  hidden,
  renames,
  emit: (event) => {
    emit(event);
    if (event.event === 'workspace.live') {
      inboxRef.current?.onLive(event.snapshot);
    }
  },
  requestIndex: () => {
    liveTriggered = true;
    background.request();
  },
  hosted: () => runRef.current?.liveStates() ?? [],
});
const attention = new InboxService({
  db,
  hidden,
  renames,
  store: new InboxStore(),
  live: () => live.snapshot(),
  emit,
});
inboxRef.current = attention;

/**
 * The app version, for the team shard's `toolVersion`. Only main knows it, so
 * it rides the port handshake; until that arrives nothing can export anyway.
 */
let toolVersion = '0.0.0';

// The Team feature: reads the shared folder (always, read-only) and writes
// this member's shard (only when sharing is on and consented). Exports run
// behind the background controller like every other write.
const team = new TeamController({
  db,
  settings,
  sources,
  hidden,
  emit,
  exclusive: (work) => background.exclusive(work),
  toolVersion: () => toolVersion,
});

/** The identity seam Settings needs; the salt is minted lazily on first use. */
const settingsSeams = { teamDeveloperId: () => team.developerId() };

const hubDeps = {
  db,
  hiddenKeys: () => hidden.all(),
  decorate,
  liveRows: () => live.snapshot().rows,
  plans: (repository: string) => contextPlans.list(repository).map(planSummary),
  analysisStatus,
  sources,
};

// Run: the app as agent host. Drives the installed `copilot` through the
// Copilot SDK under the signed-in Copilot login; on unless turned off in
// Settings, and inert until acknowledged in the view. The SDK is loaded lazily inside the
// driver, so nothing is required until a session is actually started.
const runEnabled = (): boolean => runEnabledSetting(settings);
const runAcknowledged = (): boolean => settings.get<unknown>(RUN_DISCLOSED_KEY, false) === true;
const runController = new RunController({
  driver: new SdkRunDriver({
    resolveRuntime: () => resolveRuntimeTarget(config.getAiHelperCopilotCliPath() ?? ''),
  }),
  records: new RunStore(),
  emit: (sessionId, change) => {
    emit({ event: 'run.event', sessionId, change });
    if (change.type === 'status' || change.type === 'permission' || change.type === 'permission-cleared') {
      live.onHostedChanged();
      emit({ event: 'run.active', count: runController.activeCount() });
    }
  },
  enabled: runEnabled,
  acknowledged: runAcknowledged,
  renderMarkdown: markdownToHtml,
  onTurnEnded: () => background.request(),
});
runRef.current = runController;
const run = new RunService({
  controller: runController,
  enabled: runEnabled,
  acknowledged: runAcknowledged,
  acknowledge: () => settings.update({ [RUN_DISCLOSED_KEY]: true }),
  defaultModel: () => {
    const value = settings.get<unknown>(RUN_DEFAULT_MODEL_KEY, '');
    return typeof value === 'string' ? value : '';
  },
  repositories: () => [...new Set(db.listGroups(hidden.all()).map((group) => group.repository))],
  resolveRoot: (repository) => {
    const resolved = resolveRepoRoot(repository, db);
    return 'root' in resolved ? resolved.root : undefined;
  },
  cliSessions: () =>
    db
      .listSessions({ source: 'copilot-cli', limit: 30 }, hidden.all())
      .map((row) => ({ sessionId: row.sessionId, repository: row.repository })),
  cliCwd: (sessionId) =>
    resumeTarget('copilot-cli', sessionId, { mainPath: (src, id) => db.mainPath(src, id) }).cwd,
  isHidden: (source, sessionId) => hidden.isHidden(source, sessionId),
  repositoryOf: (source, sessionId) => db.getRow(source, sessionId)?.repository,
  digestMarkdown: (repository) =>
    renderRepositoryDigestMarkdown(
      buildRepositoryDigest(buildRepoDigestInput(repository, DEFAULT_OVERVIEW_WINDOW, hubDeps)),
    ),
  plan: (planId) => {
    const plan = contextPlans.get(planId);
    return plan === undefined
      ? undefined
      : {
          repository: plan.repository,
          ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
          edits: plan.edits.map((edit) => ({
            path: edit.path,
            action: edit.action,
            ...(edit.rationale !== undefined ? { rationale: edit.rationale } : {}),
          })),
        };
  },
  retro: (source, sessionId) => {
    const facts = detail.sessionFacts(source, sessionId, stampOf(source, sessionId), detailContext(source, sessionId));
    const retro = facts.retro;
    return retro === undefined
      ? undefined
      : {
          ...(retro.goal !== undefined ? { goal: retro.goal } : {}),
          tips: retro.tips.map((tip) => tip.text),
          findings: retro.findings.filter((f) => f.severity !== 'info').map((f) => f.description),
        };
  },
  handoffMarkdown: (source, sessionId) => {
    try {
      return renderHandoffBriefMarkdown(buildHandoff(source, sessionId, sessionTextDeps()).brief);
    } catch {
      return undefined;
    }
  },
});

/** Renamed titles onto the rework ranking, like every other session list. */
function decorateReworkSessions<T extends { source: string; sessionId: string; title?: string }>(rows: T[]): T[] {
  return rows.map((row) => {
    const renamed = renames.get(row.source, row.sessionId);
    return renamed === undefined ? row : { ...row, title: renamed };
  });
}

/** The Dashboard's rework card: the rate's two numbers and the top five sessions. */
function reworkInsight(
  endedAfterMs: number | undefined,
  hiddenKeys: readonly string[],
): { editedSessions: number; reworkedSessions: number; sessions: ReworkSessionRow[] } {
  const ranking = db.reworkRanking(endedAfterMs === undefined ? {} : { endedAfterMs }, hiddenKeys, 5);
  return {
    editedSessions: ranking.editedSessions,
    reworkedSessions: ranking.reworkedSessions,
    sessions: decorateReworkSessions(ranking.sessions),
  };
}

function onBackgroundMessage(message: BackgroundMessage): void {
  switch (message.type) {
    case 'index':
      status = message.status;
      emit({ event: 'index.progress', status });
      if (message.status.phase === 'idle') {
        live.ensureStarted();
        live.onIndexSettled();
        attention.onIndexSettled();
      }
      break;
    case 'analysis':
      analysisRunning = message.status.running;
      emit({ event: 'analysis.progress', status: message.status });
      break;
    case 'rows':
      // Discovery can push thousands at once. Bound each SQL IN list and
      // message, and decorate CURRENT rows rather than worker-cached overlays.
      invalidateDiscovery();
      for (let i = 0; i < message.keys.length; i += 300) {
        const rows = db.getRowsByKey(message.keys.slice(i, i + 300))
          .filter((row) => !hidden.isHidden(row.source, row.sessionId));
        if (rows.length > 0) {
          emit({ event: 'sessions.upserted', rows: decorate(rows) });
        }
      }
      break;
    case 'removed':
      detail.invalidateAll();
      invalidateDiscovery();
      emit({ event: 'sessions.removed', keys: message.keys });
      break;
    case 'ready':
    case 'done':
      break;
  }
}

/**
 * Layer every user-authored overlay onto rows read from the index: chosen
 * names, tags, and whether a note exists.
 *
 * One function rather than a chain at each call site, because the index stores
 * none of this — it is a disposable cache — and a path that forgot one of them
 * would silently serve rows that look correct and are not: a refresh that
 * reverts a rename, a tag chip that disappears when the indexer touches a row.
 */
function decorate(rows: SessionRow[]): SessionRow[] {
  return notes.apply(tags.apply(renames.apply(rows)));
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

/** Schedule without blocking the RPC handler; progress arrives independently. */
function runIndex(): IndexStatus {
  background.request();
  return status;
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
  const stored = deepRetros.get(source, sessionId);
  return {
    acceptedMissing: acceptedMissing(),
    renamedTitle: renames.get(source, sessionId),
    deepRetro: {
      enabled: settings.get<boolean>(DEEP_RETRO_ENABLED_KEY, false) === true,
      ...(stored !== undefined ? { stored: toLlmVerdict(stored) } : {}),
    },
  };
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
 * The session keys the index cannot work out for itself, because they come from
 * the JSON stores beside it.
 *
 * Resolved BEFORE the query and handed to it, so a tag filter and a search over
 * user-chosen names are both decided in SQL along with everything else. The
 * earlier shape — query, then union renamed matches in JavaScript — appended
 * rows after SQL's `LIMIT`, which made the second page skip and duplicate and
 * made `sessions.count` disagree with the list it was counting.
 */
function keyOverlay(params: ListSessionsParams): SessionKeyOverlay {
  const query = params.query?.trim() ?? '';
  return {
    ...(params.tag !== undefined && params.tag.length > 0
      ? { restrictKeys: tags.keysFor(params.tag) }
      : {}),
    ...(query.length > 0 ? { renameKeys: renames.matchingKeys(query) } : {}),
  };
}

/** List sessions, with every user-authored overlay layered back on. */
function listSessions(params: ListSessionsParams): SessionRow[] {
  return decorate(db.listSessions(params, hidden.all(), keyOverlay(params)));
}

/** The indexed timestamp doubles as the detail cache key. */
function stampOf(source: string, sessionId: string): number {
  return db.getRow(source, sessionId)?.indexedAtMs ?? 0;
}

/**
 * Push one row's new state to the list and return it.
 *
 * Every annotation — rename, tags, note — ends this way: the row updates in
 * place through the existing upsert event, so the list does not re-query and
 * the session does not jump out from under the pointer that just annotated it.
 */
function pushRow(source: string, sessionId: string): SessionRow | undefined {
  const row = db.getRow(source, sessionId);
  if (row === undefined) {
    return undefined;
  }
  const [patched] = decorate([row]);
  emit({ event: 'sessions.upserted', rows: [patched] });
  return patched;
}

/**
 * What the review packet and the hand-off brief read: the detail view's own
 * memoized parse, the decorated index row, and the repository's verified
 * checkout. Local and user-initiated; nothing here calls a vendor or writes.
 */
function sessionTextDeps(): HandoffBriefDeps {
  return {
    facts: (source, sessionId) =>
      detail.sessionFacts(source, sessionId, stampOf(source, sessionId), detailContext(source, sessionId)),
    row: (source, sessionId) => {
      const row = db.getRow(source, sessionId);
      if (row === undefined) {
        return undefined;
      }
      const [shown] = renames.apply([row]);
      return { repository: shown.repository, ...(shown.title !== undefined ? { title: shown.title } : {}) };
    },
    resolveRoot: (repository) => {
      if (repository.length === 0 || repository === 'unknown') {
        return undefined;
      }
      const resolved = resolveRepoRoot(repository, db);
      return 'root' in resolved ? resolved.root : undefined;
    },
    costMode: (source) => sources.get(source)?.costMode ?? 'usd',
    live: (source, sessionId) => {
      const row = live.snapshot().rows.find((r) => r.source === source && r.sessionId === sessionId);
      if (row === undefined) {
        return undefined;
      }
      const failed = (row as { lastToolFailed?: boolean }).lastToolFailed;
      return { lastEvent: row.lastEvent, ...(failed !== undefined ? { lastToolFailed: failed } : {}) };
    },
  };
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
      // The same overlay the list uses, so "showing 300 of 1,847" can never
      // count a different set than the rows underneath it.
      return db.countSessions(request.params[0], hidden.all(), keyOverlay(request.params[0]));
    case 'sessions.hide': {
      const [source, sessionId, isHidden] = request.params;
      hidden.set(source, sessionId, isHidden);
      // The list filters on this, so it has to re-query rather than patch.
      emit({ event: 'sessions.removed', keys: [sessionKey(source, sessionId)] });
      // A hidden session must leave the inbox at once, not at the next index pass.
      attention.onIndexSettled();
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
      return background.exclusive(() => {
        const result = deleteSession(source, sessionId, { config });
        if (result.ok) {
          // The stopped worker cannot reinsert this session after deletion.
          db.removeSession(source, sessionId);
          tags.set(source, sessionId, []);
          notes.set(source, sessionId, '');
          detail.invalidate(source, sessionId);
          emit({ event: 'sessions.removed', keys: [sessionKey(source, sessionId)] });
          refreshCounts();
        }
        return result;
      });
    }
    case 'sessions.detail': {
      const [source, sessionId, theme, force] = request.params;
      if (force === true) {
        // Re-read the transcript as it is on disk right now. The memoized parse
        // is keyed by index stamp, which does not move without an index pass —
        // dropping it (and the Claude directory listing) is what forces the
        // fresh read for an actively running session.
        detail.invalidate(source, sessionId);
        invalidateDiscovery();
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
      return background.exclusive(() => {
        applyContextAction(action);
        db.clearDeviations();
        // The restarted worker sees the same accepted-missing configuration.
        return detail.renderBody(
          source,
          sessionId,
          stampOf(source, sessionId),
          detailContext(source, sessionId),
        );
      });
    }
    case 'sessions.reviewPacket': {
      const refs = request.params[0];
      if (!Array.isArray(refs) || refs.length === 0) {
        throw new Error('Pick at least one session.');
      }
      if (refs.length > MAX_COMPARE_SESSIONS) {
        throw new Error(`A review packet covers at most ${MAX_COMPARE_SESSIONS} sessions.`);
      }
      return buildReviewPackets(refs, sessionTextDeps());
    }
    case 'sessions.handoffBrief': {
      const [source, sessionId] = request.params;
      return buildHandoff(source, sessionId, sessionTextDeps());
    }
    case 'sessions.handoff': {
      const [source, sessionId] = request.params;
      return resumeTarget(source, sessionId, { mainPath: (src, id) => db.mainPath(src, id) });
    }
    case 'sessions.contextPrompt': {
      const [source, sessionId, section] = request.params;
      return detail.contextPromptFacts(
        source,
        sessionId,
        section,
        stampOf(source, sessionId),
        detailContext(source, sessionId),
      );
    }
    case 'sessions.rename': {
      const [source, sessionId, title] = request.params;
      renames.set(source, sessionId, title);
      // The cached document carries the old name in its header.
      detail.invalidate(source, sessionId);
      return pushRow(source, sessionId);
    }
    case 'sessions.row': {
      const [source, sessionId] = request.params;
      const row = db.getRow(source, sessionId);
      return row === undefined ? undefined : decorate([row])[0];
    }
    case 'sessions.setTags': {
      const [source, sessionId, next] = request.params;
      tags.set(source, sessionId, next);
      // No document invalidation, unlike a rename: tags are drawn by the app's
      // own chrome around the frame, not baked into the rendered document.
      return pushRow(source, sessionId);
    }
    case 'sessions.setNote': {
      const [source, sessionId, note] = request.params;
      notes.set(source, sessionId, note);
      return pushRow(source, sessionId);
    }
    case 'sessions.note': {
      const [source, sessionId] = request.params;
      return notes.get(source, sessionId);
    }
    case 'tags.list':
      // Hidden sessions are left out, so a tag's count matches the rows
      // choosing it would actually show.
      return tags.list(hidden.all());
    case 'hotspots.get': {
      const params = request.params[0] ?? {};
      const hiddenKeys = hidden.all();
      return {
        rows: db.hotspots(params, hiddenKeys),
        repositories: db.hotspotRepositories(hiddenKeys),
        status: analysisStatus(),
      };
    }
    case 'hotspots.sessions': {
      const [file, params] = request.params;
      return db.hotspotSessions(file, params ?? {}, hidden.all());
    }
    case 'retro.get': {
      const params = request.params[0] ?? {};
      const { rows, repositories } = db.retro(params, hidden.all());
      // User-chosen names are layered on here exactly as the list does it —
      // the index stores the source's own titles.
      const named = rows.map((row) => {
        const renamed = renames.get(row.source, row.sessionId);
        return renamed === undefined ? row : { ...row, title: renamed };
      });
      return { rows: named, repositories, status: analysisStatus() };
    }
    case 'evidence.rework': {
      const params = request.params[0] ?? {};
      const window = toOverviewWindow(params.window ?? DEFAULT_OVERVIEW_WINDOW);
      const hiddenKeys = hidden.all();
      const endedAfterMs = window === 'all' ? undefined : windowStartMs(window);
      const ranking = db.reworkRanking(
        {
          ...(params.source !== undefined ? { source: params.source } : {}),
          ...(params.repository !== undefined ? { repository: params.repository } : {}),
          ...(endedAfterMs !== undefined ? { endedAfterMs } : {}),
        },
        hiddenKeys,
      );
      return {
        editedSessions: ranking.editedSessions,
        reworkedSessions: ranking.reworkedSessions,
        sessions: decorateReworkSessions(ranking.sessions),
        files: reworkFileRows(ranking.files, db),
        repositories: [...new Set(db.listGroups(hiddenKeys).map((g) => g.repository))]
          .filter((r) => r !== 'unknown')
          .sort(),
        status: analysisStatus(),
        window,
      };
    }
    case 'evidence.completion': {
      const params = request.params[0] ?? {};
      const window = toOverviewWindow(params.window ?? DEFAULT_OVERVIEW_WINDOW);
      const hiddenKeys = hidden.all();
      const endedAfterMs = window === 'all' ? undefined : windowStartMs(window);
      return {
        summary: db.completionSummary(
          {
            ...(params.source !== undefined ? { source: params.source } : {}),
            ...(params.repository !== undefined ? { repository: params.repository } : {}),
            ...(endedAfterMs !== undefined ? { endedAfterMs } : {}),
          },
          hiddenKeys,
        ),
        repositories: [...new Set(db.listGroups(hiddenKeys).map((g) => g.repository))]
          .filter((r) => r !== 'unknown')
          .sort(),
        status: analysisStatus(),
        window,
      };
    }
    case 'evidence.tools': {
      const params = request.params[0] ?? {};
      const window = toOverviewWindow(params.window ?? DEFAULT_OVERVIEW_WINDOW);
      const hiddenKeys = hidden.all();
      const endedAfterMs = window === 'all' ? undefined : windowStartMs(window);
      return {
        rows: db.toolRanking(
          {
            ...(params.source !== undefined ? { source: params.source } : {}),
            ...(params.repository !== undefined ? { repository: params.repository } : {}),
            ...(endedAfterMs !== undefined ? { endedAfterMs } : {}),
          },
          hiddenKeys,
        ),
        repositories: [...new Set(db.listGroups(hiddenKeys).map((g) => g.repository))]
          .filter((r) => r !== 'unknown')
          .sort(),
        status: analysisStatus(),
        window,
      };
    }
    case 'retro.deep': {
      const [source, sessionId] = request.params;
      return runDeepRetrospective(source, sessionId, {
        sources,
        store: deepRetros,
        config,
        settings,
        backend: aiBackends.active(),
      }).then((result) => {
        if (result.verdict !== undefined) {
          // The open document renders the stored verdict, so the cached
          // markup is stale the moment a new one lands.
          detail.invalidate(source, sessionId);
        }
        return result;
      });
    }
    case 'analysis.status':
      return analysisStatus();
    case 'improve.repoStatus':
      return improveRepoStatus(request.params[0], db);
    case 'improve.generate':
      return generateContextPlan(request.params[0], {
        db,
        sources,
        store: contextPlans,
        deepRetros,
        config,
        settings,
        backend: aiBackends.active(),
        vendor: backendVendor(aiBackends.active().id),
      });
    case 'improve.plans':
      return contextPlans.list(request.params[0]).map(planSummary);
    case 'improve.plan': {
      const plan = contextPlans.get(request.params[0]);
      return plan === undefined ? undefined : planView(plan);
    }
    case 'improve.diff':
      return diffForEdit(request.params[0], request.params[1], { store: contextPlans, settings });
    case 'improve.apply':
      return applyContextPlan(request.params[0], request.params[1], { store: contextPlans, settings });
    case 'improve.undo':
      return undoContextPlan(request.params[0], request.params[1], { store: contextPlans, settings });
    case 'ai.availability':
      return aiBackends.active().isAvailable();
    case 'ai.backends': {
      const activeId = aiBackends.active().id;
      return Promise.all(
        aiBackends.all().map(async (backend) => {
          // One backend's probe blowing up must degrade to "that backend is
          // unavailable", never take the whole list down — every consent
          // surface and the Improve view read this to name the vendor.
          let availability: { available: boolean; reason?: string };
          try {
            availability = await backend.isAvailable();
          } catch (err) {
            availability = {
              available: false,
              reason: err instanceof Error ? err.message : String(err),
            };
          }
          return {
            id: backend.id,
            label: backend.label,
            vendor: backendVendor(backend.id),
            active: backend.id === activeId,
            available: availability.available,
            ...(availability.available ? {} : { reason: availability.reason }),
          };
        }),
      );
    }
    case 'ai.state':
      return aiHelper.state();
    case 'ai.send':
      return aiHelper.send(request.params[0]);
    case 'ai.stop':
      return aiHelper.stop();
    case 'ai.reset':
      return aiHelper.reset();
    case 'ai.acknowledge':
      return aiHelper.acknowledge();
    case 'overview.get':
      // The window is narrowed here rather than trusted: it arrives from the
      // renderer's persisted preference, which a stale or hand-edited
      // localStorage entry can put anything into.
      //
      // Hidden sessions are excluded so the totals agree with the list; a
      // count that includes what the user removed reads as a bug.
      return db.overview(
        toOverviewWindow(request.params[0]?.window ?? DEFAULT_OVERVIEW_WINDOW),
        hidden.all(),
      );
    case 'overview.insights': {
      const window = toOverviewWindow(request.params[0]?.window ?? DEFAULT_OVERVIEW_WINDOW);
      const hiddenKeys = hidden.all();
      const { verdictDaily, themes, windowDays, dailyCapped } = db.insights(window, hiddenKeys);
      // The hotspot card rides the same query as the Hotspots view, windowed to
      // the Dashboard's range and scored over the FULL windowed set — the
      // frequency sub-score normalizes by the busiest file — before truncating.
      const endedAfterMs = window === 'all' ? undefined : windowStartMs(window);
      const hotspots = scoreHotspots(
        db.hotspots(endedAfterMs === undefined ? {} : { endedAfterMs }, hiddenKeys),
      ).slice(0, INSIGHT_HOTSPOT_LIMIT);
      return {
        verdictDaily,
        themes,
        hotspots,
        evidence: {
          completion: db.completionSummary(endedAfterMs === undefined ? {} : { endedAfterMs }, hiddenKeys),
          rework: reworkInsight(endedAfterMs, hiddenKeys),
          // Ranked by failure RATE among tools called often enough to judge;
          // a tool that failed once in two calls is noise, not a finding.
          tools: db
            .toolRanking(endedAfterMs === undefined ? {} : { endedAfterMs }, hiddenKeys)
            .filter((row) => row.calls >= TOOL_FAILURE_MIN_CALLS && row.failures > 0)
            .sort((a, b) => b.failures / b.calls - a.failures / a.calls || b.failures - a.failures)
            .slice(0, INSIGHT_TOOL_LIMIT)
            .map((row) => ({ tool: row.tool, calls: row.calls, failures: row.failures })),
        },
        status: analysisStatus(),
        window,
        windowDays,
        ...(dailyCapped === true ? { dailyCapped: true as const } : {}),
      };
    }
    case 'inbox.list':
      return attention.snapshot(request.params[0]?.includeDismissed === true);
    case 'inbox.mark':
      return attention.mark(request.params[0], request.params[1], request.params[2]);
    case 'workspace.live':
      return live.snapshot();
    case 'workspace.repositories':
      return buildRepositoryCards(
        toOverviewWindow(request.params[0]?.window ?? DEFAULT_OVERVIEW_WINDOW),
        db,
        hidden.all(),
        live.snapshot().rows,
      );
    case 'workspace.repoHub':
      return buildRepoHub(
        request.params[0],
        toOverviewWindow(request.params[1]?.window ?? DEFAULT_OVERVIEW_WINDOW),
        hubDeps,
      );
    case 'workspace.repoDigest':
      return buildRepoDigestInput(
        request.params[0],
        toOverviewWindow(request.params[1]?.window ?? DEFAULT_OVERVIEW_WINDOW),
        hubDeps,
      );
    case 'team.status':
      return team.status();
    case 'team.refresh':
      return team.refresh();
    case 'team.preview':
      return team.preview();
    case 'team.exportNow':
      return team.exportNow();
    case 'team.view':
      return team.view(toTeamWindow(request.params[0]?.window ?? DEFAULT_TEAM_WINDOW));
    case 'team.members':
      return team.members();
    case 'run.availability':
      return run.availability();
    case 'run.acknowledge':
      return run.acknowledge();
    case 'run.repositories':
      return run.repositories();
    case 'run.start':
      return run.start(request.params[0]);
    case 'run.resume':
      return run.resume(request.params[0]);
    case 'run.send':
      return run.send(request.params[0], request.params[1]);
    case 'run.abort':
      return run.abort(request.params[0]);
    case 'run.close':
      return run.close(request.params[0]);
    case 'run.list':
      return run.list();
    case 'run.transcript':
      return run.transcript(request.params[0]);
    case 'run.permission.respond':
      return run.respondPermission(request.params[0], request.params[1], request.params[2]);
    case 'run.input.respond':
      return run.respondInput(request.params[0], request.params[1]);
    case 'run.permissionMode':
      return run.setPermissionMode(request.params[0], request.params[1]);
    case 'run.prefill':
      return run.prefill(request.params[0]);
    case 'settings.get':
      return buildSettingsSnapshot(settings, config, settingsSeams);
    case 'settings.update': {
      return background.exclusive(() => {
        const changed = applySettingsPatch(settings, request.params[0]);
        if (changed.copilot) {
          telemetry.refresh();
          ensureArchiveIndexes = true;
        }
        if (changed.deviation) {
          db.clearDeviations();
          detail.invalidateAll();
        }
        if (changed.deepRetro) {
          detail.invalidateAll();
        }
        if (changed.ai) {
          aiBackends.reload();
        }
        if (changed.claude || changed.copilot) {
          sources.refresh();
          detail.invalidateAll();
          // The watched directories and databases follow the sources.
          live.restart();
        }
        if (changed.team) {
          team.settingsChanged();
        }
        return buildSettingsSnapshot(settings, config, settingsSeams);
      });
    }
    case 'copilot.setupStatus':
      return checkCopilotSetup(settings, config);
    case 'copilot.enableTracing': {
      // Consent happened in the renderer (startup prompt or Settings button);
      // the paths are still validated against our own target list inside.
      const result = enableCopilotTracing(request.params[0], settings, config);
      // The launch advisory must not outlive the fix it recommends.
      copilotSetupNotes = setupNotes(result.status);
      // No re-index: the database cannot exist until the editor restarts and
      // Copilot chats once. "Check again" / index.refresh covers that moment.
      return result;
    }
    case 'copilot.dismissSetupPrompt':
      settings.update({ [COPILOT_SETUP_DISMISS_KEY]: true });
      return undefined;
    case 'index.status':
      refreshCounts();
      return status;
    case 'index.refresh':
      return runIndex();
    case 'index.rebuild':
      return background.exclusive(() => {
        const keys = db.sessionKeys();
        db.clear();
        sources.refresh();
        detail.invalidateAll();
        emit({ event: 'sessions.removed', keys });
        refreshCounts();
        return status;
      });
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
    const fail = (err: unknown): void => {
      port.postMessage({
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RpcResponse);
    };
    try {
      const value = handle(request);
      // Almost every method is synchronous; the deep retrospective is not.
      // A promise is resolved before the response goes back, so the renderer
      // never has to know which methods are which.
      if (value instanceof Promise) {
        value
          .then((resolved) =>
            port.postMessage({ id: request.id, ok: true, value: resolved } satisfies RpcResponse),
          )
          .catch(fail);
      } else {
        port.postMessage({ id: request.id, ok: true, value } satisfies RpcResponse);
      }
    } catch (err) {
      fail(err);
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
  const data = event.data as { type?: string; version?: string } | undefined;
  if (typeof data?.version === 'string' && data.version.length > 0) {
    toolVersion = data.version;
  }
  if (port !== undefined) {
    attach(port);
    refreshCounts();
    team.start();
    // Paint from whatever the last run left behind, then bring it up to date.
    emit({ event: 'index.progress', status });
    // The launch-time Copilot setup check: a few stats and small file parses,
    // cheap enough to run before the index pass whose notes it feeds. The
    // renderer pulls the verdict itself via copilot.setupStatus.
    copilotSetupNotes = startupCopilotSetup(settings, config).notes;
    // A worker runs the pass; even a cold index no longer queues RPC behind it.
    setTimeout(() => runIndex(), 0);
  }
});

// A hosted session must not be left with an unanswered request when the app
// goes away: main asks for a shutdown before quitting, every parked request
// is answered "user not available" and each session is disconnected. The
// sessions stay on disk and can be resumed.
process.parentPort?.on('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'shutdown') {
    void runController.shutdown().finally(() => process.exit(0));
  }
});
