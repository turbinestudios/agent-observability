import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { PathEnvironment } from './paths';
import { IngestStore } from '../otel/ingestStore';
import { flattenSpans } from '../otel/otlpParse';
import { otlpSpansToRows } from '../otel/otlpToRows';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const SESSION = 'ingest-sess';

const envelope = {
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat',
              spanId: 'c1',
              traceId: 't1',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.agent.name', value: sv('copilot') },
                { key: 'gen_ai.conversation.id', value: sv(SESSION) },
                { key: 'gen_ai.usage.input_tokens', value: iv(42) },
                { key: 'copilot_chat.user_request', value: sv('hi') },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** A config + environment that find NO Copilot DB, so only the ingest source can apply. */
const config: ServiceConfig = {
  isLocalTelemetryEnabled: () => true,
  getCodeFileExtensions: () => [],
  getDocFileExtensions: () => [],
  getSqlitePathOverride: () => undefined,
};
const noCopilotEnv: PathEnvironment = {
  platform: 'win32',
  env: {},
  homedir: () => '',
  statKind: () => 'absent',
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('TelemetryService with a live-OTLP ingest source', () => {
  it('reads the extension-owned ingest DB as the sole source', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-svc-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    store.close();

    const service = new TelemetryService(config, noCopilotEnv);

    // Without an ingest source, no Copilot DB exists → a typed failure (not a throw).
    expect(service.getSessionInteractions(SESSION).ok).toBe(false);

    // Point it at our ingest DB → it becomes the sole source and reads our spans.
    service.setIngestDbPath(dbPath);
    const result = service.getSessionInteractions(SESSION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].operation).toBe('chat');
      expect(result.value[0].inputTokens).toBe(42);
    }
    service.dispose();
  });
});

/** A one-chat-span session envelope for the given session id. */
function envelopeFor(session: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `c-${session}`,
                traceId: `tr-${session}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'gen_ai.conversation.id', value: sv(session) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('TelemetryService with a durable archive source', () => {
  it('reads the archive as the sole source when set and present, else falls back', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arc-'));
    const archivePath = path.join(tmp, 'agent-traces.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('arch-sess'))));
    store.close();

    const service = new TelemetryService(config, noCopilotEnv);
    // No archive set + no Copilot DB → typed failure.
    expect(service.getSessionInteractions('arch-sess').ok).toBe(false);

    service.setArchiveDbPath(archivePath);
    expect(service.getSessionInteractions('arch-sess').ok).toBe(true);
    service.dispose();
  });

  it('prefers the durable archive over the live-ingest DB when both are set', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arc-'));
    const archivePath = path.join(tmp, 'archive.db');
    const ingestPath = path.join(tmp, 'ingest.db');

    const arc = new IngestStore(archivePath);
    arc.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('arch-only'))));
    arc.close();
    const ing = new IngestStore(ingestPath);
    ing.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('live-only'))));
    ing.close();

    const service = new TelemetryService(config, noCopilotEnv);
    service.setArchiveDbPath(archivePath);
    service.setIngestDbPath(ingestPath);

    // The archive is the SOLE source: the archiver sweeps the ingest DB into it
    // (so it is a superset in production, lagging at most one sweep) and keeps
    // months where ingest keeps days — reading ingest instead silently hid every
    // repository older than the prune window. The reader never folds live spans
    // in itself; that is the archiver's job. The ingest-only session is invisible
    // (a source is open, so the lookup succeeds with an empty result).
    const arch = service.getSessionInteractions('arch-only');
    expect(arch.ok && arch.value.length > 0).toBe(true);
    const live = service.getSessionInteractions('live-only');
    expect(live.ok && live.value.length === 0).toBe(true);
    service.dispose();
  });
});

const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444';

/**
 * A one-chat-span envelope shaped like a HUMAN-INITIATED Copilot session: a
 * UUID `chat_session_id`, a `copilot_chat.user_request` span, and a real chat
 * model — the shape `listSessions` requires a session to have.
 */
function titledEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `c-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'gen_ai.conversation.id', value: sv(uuid) },
                  { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
                  { key: 'gen_ai.response.model', value: sv('gpt-x') },
                  { key: 'copilot_chat.user_request', value: sv('hello there') },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Write a minimal `state.vscdb` with the chat-session index row. */
function writeStateDb(wsDir: string, entries: Record<string, string>): void {
  const built: Record<string, unknown> = {};
  for (const [key, title] of Object.entries(entries)) {
    built[key] = { sessionId: key, title, isEmpty: false };
  }
  mkdirSync(wsDir, { recursive: true });
  const db = new Database(path.join(wsDir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [
    'chat.ChatSessionStore.index',
    JSON.stringify({ version: 1, entries: built }),
  ]);
  db.close();
}

/** The session summary listed for `id`, or undefined. */
function listedSession(service: TelemetryService, id: string) {
  const result = service.listSessions();
  expect(result.ok).toBe(true);
  return result.ok ? result.value.find((s) => s.sessionId === id) : undefined;
}

describe('session titles when the archive is the read source', () => {
  it('resolves titles from the NATIVE workspaceStorage even though the archive has no sibling store', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-title-'));
    // The native candidate layout — only the TITLE stores exist; the native
    // telemetry DB itself is gone (rotated out), which must not matter.
    const appData = path.join(tmp, 'Roaming');
    writeStateDb(path.join(appData, 'Code', 'User', 'workspaceStorage', 'hashA'), {
      [UUID_A]: 'Fix the login flow',
    });
    const archivePath = path.join(tmp, 'archive.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(titledEnvelopeFor(UUID_A))));
    store.close();

    const env: PathEnvironment = {
      platform: 'win32',
      env: { APPDATA: appData },
      homedir: () => '',
      statKind: () => 'absent', // no native DB anywhere → archive stays the sole source
    };
    const service = new TelemetryService(config, env);
    service.setArchiveDbPath(archivePath);

    const session = listedSession(service, UUID_A);
    expect(session?.title).toBe('Fix the login flow');
    expect(session?.titleDerived).toBe(false);
    service.dispose();
  });

  it('falls back to titles ARCHIVED in the session_titles sidecar when no native store remains', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-title-'));
    const archivePath = path.join(tmp, 'archive.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(titledEnvelopeFor(UUID_A))));
    store.writeSessionTitles(new Map([[UUID_A, { title: 'Archived name', derived: false }]]), 1);
    store.close();

    const service = new TelemetryService(config, noCopilotEnv); // no candidates at all
    service.setArchiveDbPath(archivePath);

    const session = listedSession(service, UUID_A);
    expect(session?.title).toBe('Archived name');
    expect(session?.titleDerived).toBe(false);
    service.dispose();
  });

  it('a live native title (e.g. a rename) overrides the archived one', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-title-'));
    const appData = path.join(tmp, 'Roaming');
    writeStateDb(path.join(appData, 'Code', 'User', 'workspaceStorage', 'hashA'), {
      [UUID_A]: 'Renamed by the user',
    });
    const archivePath = path.join(tmp, 'archive.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(titledEnvelopeFor(UUID_A))));
    store.writeSessionTitles(new Map([[UUID_A, { title: 'Stale archived name', derived: false }]]), 1);
    store.close();

    const env: PathEnvironment = {
      platform: 'win32',
      env: { APPDATA: appData },
      homedir: () => '',
      statKind: () => 'absent',
    };
    const service = new TelemetryService(config, env);
    service.setArchiveDbPath(archivePath);

    expect(listedSession(service, UUID_A)?.title).toBe('Renamed by the user');
    service.dispose();
  });
});

const UUID_TOOL = 'a1111111-1111-2222-3333-444444444444';
const UUID_SUGG = 'b1111111-1111-2222-3333-444444444444';
const UUID_FALLBACK = 'c1111111-1111-2222-3333-444444444444';
const UUID_SYNTH = 'd1111111-1111-2222-3333-444444444444';
const UUID_AGENT = 'e1111111-1111-2222-3333-444444444444';
const UUID_PARENT = 'f1111111-1111-2222-3333-444444444444';
const UUID_TURN = '01111111-1111-2222-3333-444444444444';
const UUID_NOISE = '21111111-1111-2222-3333-444444444444';
const UUID_GLOBAL = '31111111-1111-2222-3333-444444444444';
const UUID_REPOINT = '41111111-1111-2222-3333-444444444444';
const WS_REPO = 'https://github.com/org/workspace-repo';
const GLOBAL_REPO = 'https://github.com/org/global-repo';
const AGENT_REPO = 'https://github.com/turbinestudios/loop-app';

/**
 * A session whose ONLY span is a tool call — a UUID `chat_session_id`, no
 * `conversation.id`, no `user_request`, no repo. This is the shape the FIRST
 * span of a fresh chat typically has, arriving seconds before the first
 * `user_request`. The relaxed gate must surface it.
 */
function toolOnlyEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'execute_tool',
                spanId: `x-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('execute_tool') },
                  { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A session whose only chat span is an inline SUGGESTION — must stay excluded. */
function suggestionOnlyEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `s-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
                  { key: 'gen_ai.response.model', value: sv('copilot-suggestions') },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The shape ordinary chat-helper telemetry has: a conversation-keyed `chat`
 * span with a real chat model, NO `chat_session_id`, and NO agent-run span.
 * Emitted by NES, commit-message/title/progress generators and
 * `copilotLanguageModelWrapper` — must never be listed as a session.
 */
function helperNoiseEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `n-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'gen_ai.conversation.id', value: sv(uuid) },
                  { key: 'gen_ai.response.model', value: sv('gpt-4o-mini') },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The shape an autonomous Copilot CLI agent relays through the OTLP relay: the
 * whole run shares ONE `gen_ai.conversation.id`, NO `chat_session_id` is ever
 * emitted, and the repository is a bare `owner/repo` slug on
 * `github.copilot.git.repository` (not a `copilot_chat.repo.remote_url`).
 */
function autonomousEnvelopeFor(conversation: string) {
  const span = (
    id: string,
    name: string,
    operation: string,
    extra: Array<{ key: string; value: { stringValue: string } }> = [],
  ) => ({
    name,
    spanId: `${id}-${conversation}`,
    traceId: `tr-${conversation}`,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    status: { code: 1 },
    attributes: [
      { key: 'gen_ai.operation.name', value: sv(operation) },
      { key: 'gen_ai.conversation.id', value: sv(conversation) },
      ...extra,
    ],
  });

  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: sv('copilot-remediation-agent') }] },
        scopeSpans: [
          {
            spans: [
              span('a', 'invoke_agent', 'invoke_agent', [
                { key: 'github.copilot.git.repository', value: sv('turbinestudios/loop-app') },
              ]),
              span('c', 'chat claude-sonnet-5', 'chat', [
                { key: 'gen_ai.response.model', value: sv('claude-sonnet-5') },
              ]),
              span('t', 'execute_tool bash', 'execute_tool', [
                { key: 'gen_ai.tool.name', value: sv('bash') },
              ]),
            ],
          },
        ],
      },
    ],
  };
}

/**
 * A Copilot Chat session (`chat_session_id`) plus ONE per-turn
 * `conversation_id` fragment under it — both spans carry the parent's
 * `chat_session_id`, which is what must keep the fragment out of the list.
 */
function perTurnFragmentEnvelope(turn: string, parent: string) {
  const span = (id: string, conversation: string) => ({
    name: 'chat',
    spanId: `${id}-${conversation}`,
    traceId: `tr-${parent}`,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    status: { code: 1 },
    attributes: [
      { key: 'gen_ai.operation.name', value: sv('chat') },
      { key: 'gen_ai.conversation.id', value: sv(conversation) },
      { key: 'copilot_chat.chat_session_id', value: sv(parent) },
      { key: 'gen_ai.response.model', value: sv('gpt-x') },
    ],
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [{ spans: [span('root', parent), span('turn', turn)] }],
      },
    ],
  };
}

/**
 * A session whose workspace `origin` was RE-POINTED mid-session: two
 * repo-bearing spans with different remotes. The alphabetically-LATER value is
 * deliberately the EARLIER span, so the old `MAX(value)` pick would keep it.
 */
function repointedEnvelopeFor(uuid: string) {
  const span = (id: string, startNano: string, repo: string) => ({
    name: 'invoke_agent',
    spanId: `${id}-${uuid}`,
    traceId: `tr-${uuid}`,
    startTimeUnixNano: startNano,
    endTimeUnixNano: startNano,
    status: { code: 1 },
    attributes: [
      { key: 'gen_ai.operation.name', value: sv('invoke_agent') },
      { key: 'gen_ai.conversation.id', value: sv(uuid) },
      { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
      { key: 'copilot_chat.repo.remote_url', value: sv(repo) },
    ],
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              span('a', '1700000000000000000', 'https://github.com/org/zzz-old.git'),
              span('b', '1700000600000000000', 'https://github.com/org/aaa-new.git'),
            ],
          },
        ],
      },
    ],
  };
}

/** Build a service backed solely by an ingest DB holding the given envelope. */
function serviceForIngest(env: object): TelemetryService {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-gate-'));
  const dbPath = path.join(tmp, 'agent-traces.db');
  const store = new IngestStore(dbPath);
  store.writeSpans(otlpSpansToRows(flattenSpans(env)));
  store.close();
  const service = new TelemetryService(config, noCopilotEnv);
  service.setIngestDbPath(dbPath);
  return service;
}

describe('relaxed session gate + workspace-scoped context', () => {
  it('surfaces a started session that has a span but NO user_request', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_TOOL));
    const session = listedSession(service, UUID_TOOL);
    expect(session).toBeDefined();
    expect(session?.toolCalls).toBe(1);
    expect(session?.llmCalls).toBe(0);
    service.dispose();
  });

  it('still excludes a suggestion-only session under the relaxed gate', () => {
    const service = serviceForIngest(suggestionOnlyEnvelopeFor(UUID_SUGG));
    expect(listedSession(service, UUID_SUGG)).toBeUndefined();
    service.dispose();
  });

  it('groups a repo-less started session under the workspace repo via the scoped fallback', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_FALLBACK));

    // Before any context is supplied, the session has no discoverable repo.
    expect(listedSession(service, UUID_FALLBACK)?.repository).toBe('unknown');

    service.setWorkspaceSessionContext({
      repository: WS_REPO,
      sessionIds: new Set([UUID_FALLBACK]),
      recent: [],
    });

    expect(listedSession(service, UUID_FALLBACK)?.repository).toBe(WS_REPO);

    // The workspace repo is now a filterable node, and the session lands under it.
    const repos = service.listRepositories();
    expect(repos.ok && repos.value.some((r) => r.repository === WS_REPO)).toBe(true);
    const scoped = service.listSessions(WS_REPO);
    expect(scoped.ok && scoped.value.some((s) => s.sessionId === UUID_FALLBACK)).toBe(true);
    service.dispose();
  });

  it('lists an autonomous CLI session (conversation id only) under its slug repo', () => {
    const service = serviceForIngest(autonomousEnvelopeFor(UUID_AGENT));

    // The whole run shares ONE conversation id and carries NO chat_session_id —
    // the shape an autonomous Copilot CLI agent relays. It must still be listed,
    // grouped under the repo from `github.copilot.git.repository`.
    const session = listedSession(service, UUID_AGENT);
    expect(session).toBeDefined();
    expect(session?.repository).toBe(AGENT_REPO);
    expect(session?.llmCalls).toBe(1);
    expect(session?.toolCalls).toBe(1);

    const repos = service.listRepositories();
    expect(repos.ok && repos.value.some((r) => r.repository === AGENT_REPO)).toBe(true);
    const scoped = service.listSessions(AGENT_REPO);
    expect(scoped.ok && scoped.value.some((s) => s.sessionId === UUID_AGENT)).toBe(true);
    service.dispose();
  });

  it('resolves a mid-session origin re-point to the LATEST remote, not the alphabetical max', () => {
    const service = serviceForIngest(repointedEnvelopeFor(UUID_REPOINT));
    expect(listedSession(service, UUID_REPOINT)?.repository).toBe('https://github.com/org/aaa-new');
    service.dispose();
  });

  it('groups a repo-less session under its repo via the cross-workspace map', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_GLOBAL));
    expect(listedSession(service, UUID_GLOBAL)?.repository).toBe('unknown');

    service.setGlobalSessionRepositories(new Map([[UUID_GLOBAL, GLOBAL_REPO]]));
    expect(listedSession(service, UUID_GLOBAL)?.repository).toBe(GLOBAL_REPO);
    const repos = service.listRepositories();
    expect(repos.ok && repos.value.some((r) => r.repository === GLOBAL_REPO)).toBe(true);

    // The LIVE workspace context wins over the global map for sessions it claims.
    service.setWorkspaceSessionContext({
      repository: WS_REPO,
      sessionIds: new Set([UUID_GLOBAL]),
      recent: [],
    });
    expect(listedSession(service, UUID_GLOBAL)?.repository).toBe(WS_REPO);
    service.dispose();
  });

  it('never lists conversation-only chat-helper noise (no agent-run span)', () => {
    // The shape NES / commit-message / title generators and language-model
    // wrappers emit: conversation-keyed `chat` spans with NO chat_session_id and
    // NO invoke_agent/execute_tool/execute_hook span. Before the agent-run-span
    // gate these flooded the tree as phantom repo-less sessions.
    const service = serviceForIngest(helperNoiseEnvelopeFor(UUID_NOISE));
    expect(listedSession(service, UUID_NOISE)).toBeUndefined();
    const loose = service.listSessions('unknown');
    expect(loose.ok && loose.value.length === 0).toBe(true);
    service.dispose();
  });

  it('still hides a per-turn conversation fragment that carries a parent chat_session_id', () => {
    // Guard for the gate relaxation above: Copilot Chat spans carry BOTH ids, and
    // the per-turn conversation id must never surface as a session of its own.
    const service = serviceForIngest(perTurnFragmentEnvelope(UUID_TURN, UUID_PARENT));
    expect(listedSession(service, UUID_TURN)).toBeUndefined();
    expect(listedSession(service, UUID_PARENT)).toBeDefined();
    service.dispose();
  });

  it('synthesizes a spanless store session, and a real telemetry row is not duplicated', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_FALLBACK));
    service.setWorkspaceSessionContext({
      repository: WS_REPO,
      sessionIds: new Set([UUID_FALLBACK, UUID_SYNTH]),
      recent: [
        { sessionId: UUID_SYNTH, startedAtMs: 1_700_000_500_000, title: 'Draft chat', titleDerived: true },
        { sessionId: UUID_FALLBACK, startedAtMs: 1_700_000_400_000, title: 'Has telemetry', titleDerived: true },
      ],
    });

    // The spanless store session appears as a zero-metric placeholder with its
    // store title, grouped under the workspace repo.
    const synth = listedSession(service, UUID_SYNTH);
    expect(synth).toBeDefined();
    expect(synth?.repository).toBe(WS_REPO);
    expect(synth?.interactionCount).toBe(0);
    expect(synth?.toolCalls).toBe(0);
    expect(synth?.title).toBe('Draft chat');

    // The session that DOES have telemetry keeps its real row (toolCalls === 1)
    // and is not duplicated by a synthetic placeholder.
    const result = service.listSessions();
    const fallbackRows = result.ok ? result.value.filter((s) => s.sessionId === UUID_FALLBACK) : [];
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0].toolCalls).toBe(1);
    service.dispose();
  });
});
