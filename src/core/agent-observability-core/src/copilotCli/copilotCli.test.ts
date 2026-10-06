import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LIVE_FINISHED_MS, LIVE_IDLE_MS } from '../live/liveStatus';
import { aiuToUsd } from '../telemetry/pricing';
import { COPILOT_PAYLOAD_POINTER_PREFIX, copilotPayloadPointer } from '../chat/backends/copilotCliArgs';
import { helperWorkingDirectory } from '../chat/backends/copilotCliBackend';
import { CopilotCliSource } from './copilotCliSource';
import { parseCliEvents, parseWorkspaceYaml, readCliEventsTail, type CliEvent } from './events';
import { isHelperRun } from './helperRuns';
import {
  buildCliAggregationRows,
  buildCliInteractions,
  buildCliSessionDetail,
  deriveCliLive,
  extractCliRetrospectiveSignals,
  resolveCliRepository,
  summarizeCliUsage,
} from './mapper';
import { copilotHelperCwd, defaultCopilotCliFs, discoverCopilotCliSessions, type CopilotCliFs } from './paths';

/**
 * Fixtures mirror what Copilot CLI 1.0.82 and an earlier build wrote on a
 * real machine (probed 2026-10-06), reduced to the fields the mapper reads.
 * Times are numeric milliseconds from a fixed base; nothing here depends on
 * locale, timezone or the path separator.
 */
const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);
let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, atMs = T0 + (seq += 1000)): CliEvent => ({
  type,
  data,
  timestamp: new Date(atMs).toISOString(),
});
const shutdown = (model: string, input: number, output: number, cacheRead: number, nano?: number): CliEvent =>
  ev('session.shutdown', {
    modelMetrics: { [model]: { requests: { count: 2 }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } } },
    ...(nano !== undefined ? { totalNanoAiu: nano } : {}),
  });
const session = (events: CliEvent[], workspace: Record<string, string> = {}) => ({
  sessionId: 'abc',
  events,
  workspace,
  repository: 'https://github.com/o/repo',
});

beforeEach(() => {
  seq = 0;
});

describe('events and workspace readers', () => {
  it('skips a truncated last line and non-event lines, and keeps unknown types', () => {
    const text = `${JSON.stringify(ev('session.start'))}\n"just a string"\n${JSON.stringify(ev('brand.new_event', { x: 1 }))}\n{"type":"user.mess`;
    const { events, skipped } = parseCliEvents(text);
    expect(events.map((e) => e.type)).toEqual(['session.start', 'brand.new_event']);
    expect(skipped).toBe(2);
  });

  it('reads flat workspace.yaml values with colons, backslashes and quotes', () => {
    const yaml = ["id: abc", 'cwd: C:\\Projects\\my repo', "name: 'Reply with: ok'", 'updated_at: 2026-10-06T10:00:00.000Z', 'repository: o/repo', 'branch:', '  nested: ignored'].join('\r\n');
    expect(parseWorkspaceYaml(yaml)).toEqual({
      id: 'abc',
      cwd: 'C:\\Projects\\my repo',
      name: 'Reply with: ok',
      updated_at: '2026-10-06T10:00:00.000Z',
      repository: 'o/repo',
    });
  });

  it('reads only the tail of a large events file and drops the partial first line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-tail-'));
    try {
      const file = path.join(dir, 'events.jsonl');
      const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify(ev('user.message', { content: `m${i}` })));
      fs.writeFileSync(file, lines.join('\n') + '\n');
      const tail = readCliEventsTail(file, 2000);
      expect(tail?.truncated).toBe(true);
      expect(tail?.events.at(-1)?.data.content).toBe('m199');
      expect(tail?.events.every((e) => e.type === 'user.message')).toBe(true);
      expect(readCliEventsTail(path.join(dir, 'missing.jsonl'))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('usage', () => {
  it('sums shutdown segments (per process, not cumulative) and prices billed AIU like the Copilot source', () => {
    const usage = summarizeCliUsage([
      shutdown('gpt-5', 1000, 100, 400, 2_000_000_000),
      ev('session.resume'),
      shutdown('gpt-5', 500, 50, 100, 1_000_000_000),
    ]);
    expect(usage).toMatchObject({ inputTokens: 1500, outputTokens: 150, cachedTokens: 500, aiuNano: 3_000_000_000 });
    const detail = buildCliSessionDetail(session([ev('user.message', { content: 'hi' }), shutdown('gpt-5', 10, 1, 0, 3_000_000_000)]));
    expect(detail.summary.costMicros).toBe(Math.round(aiuToUsd(3_000_000_000) * 1_000_000));
  });

  it('adds the still-open segment from its messages and last checkpoint', () => {
    const usage = summarizeCliUsage([
      shutdown('gpt-5', 1000, 100, 0, 1_000_000_000),
      ev('assistant.message', { model: 'gpt-5', outputTokens: 40 }),
      ev('session.usage_checkpoint', { totalNanoAiu: 100 }),
      ev('assistant.message', { model: 'gpt-5', outputTokens: 2 }),
      ev('session.usage_checkpoint', { totalNanoAiu: 500 }),
    ]);
    expect(usage.outputTokens).toBe(142);
    expect(usage.aiuNano).toBe(1_000_000_500);
    expect(usage.byModel.get('gpt-5')?.llmCalls).toBe(4);
  });

  it('leaves a session with no billed figure unpriced, never zero', () => {
    const detail = buildCliSessionDetail(session([ev('user.message', { content: 'x' }), shutdown('claude-opus-4.6', 100, 10, 0)]));
    expect(detail.summary.costMicros).toBeUndefined();
    expect(detail.summary.inputTokens).toBe(100);
  });
});

describe('mapper', () => {
  const events = (): CliEvent[] => [
    ev('session.start', { context: { cwd: path.join(os.tmpdir(), 'repo'), repository: 'o/ctx' } }),
    ev('user.message', { content: 'Fix the build please' }),
    ev('assistant.turn_start'),
    ev('assistant.message', { model: 'gpt-5', outputTokens: 5, toolRequests: [{ toolCallId: 't1', name: 'bash' }] }),
    ev('tool.execution_start', { toolCallId: 't1', toolName: 'bash' }),
    ev('tool.execution_complete', { toolCallId: 't1', success: false }),
    ev('assistant.message', { model: 'gpt-5', outputTokens: 7, content: 'Done.' }),
    ev('assistant.turn_end'),
    ev('user.message', { content: 'Now the tests', delivery: 'steering' }),
    ev('assistant.message', { model: 'gpt-4', outputTokens: 1, toolRequests: [{ toolCallId: 't2', name: 'view' }] }),
    ev('tool.execution_start', { toolCallId: 't2', toolName: 'view' }),
    ev('some.future_event', { anything: true }),
  ];

  it('pairs turns and tools, counts an orphan tool start without blaming it, and derives a title', () => {
    const detail = buildCliSessionDetail(session(events()));
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]).toMatchObject({ userRequest: 'Fix the build please', finalResponse: 'Done.', llmCalls: 2, success: false });
    expect(detail.turns[0].events.map((e) => e.operation)).toEqual(['chat', 'execute_tool', 'chat']);
    expect(detail.turns[1].events.at(-1)).toMatchObject({ toolName: 'view', success: true, durationMs: 0 });
    expect(detail.summary).toMatchObject({ llmCalls: 3, toolCalls: 2, interactionCount: 5, model: 'gpt-5', source: 'copilot-cli', title: 'Fix the build please', titleDerived: true });
    expect(detail.treeStats.errorCount).toBe(1);
    expect(detail.summary.durationMs).toBe(detail.summary.endedAtMs - detail.summary.startedAtMs);
    expect(buildCliInteractions(session(events())).filter((i) => i.operation === 'execute_tool' && !i.success)).toHaveLength(1);
  });

  it('prefers the name the CLI stored over a derived title', () => {
    const detail = buildCliSessionDetail(session(events(), { name: 'Build fix' }));
    expect(detail.summary).toMatchObject({ title: 'Build fix', titleDerived: false });
  });

  it('normalises the repository to the form every other source uses', () => {
    expect(resolveCliRepository({ repository: 'o/repo' }, [])).toBe('https://github.com/o/repo');
    expect(resolveCliRepository({}, events())).toBe('https://github.com/o/ctx');
    expect(resolveCliRepository({ cwd: 'x' }, [], () => 'https://github.com/from/cwd')).toBe('https://github.com/from/cwd');
    expect(resolveCliRepository({}, [])).toBe('unknown');
  });

  it('emits content-free aggregation rows with allowlisted tool names, inside the window', () => {
    const rows = buildCliAggregationRows(session(events()));
    expect(rows).toHaveLength(5);
    expect(JSON.stringify(rows)).not.toContain('Fix the build');
    expect(rows.find((r) => r.operation === 'execute_tool' && r.statusCode === 2)).toBeDefined();
    expect(buildCliAggregationRows(session(events()), T0 + 60_000_000)).toEqual([]);
  });

  it('reads steering, plan mode and errors as retrospective signals', () => {
    const signals = extractCliRetrospectiveSignals([
      ...events(),
      ev('session.mode_changed', { newMode: 'plan' }),
      ev('session.error'),
      ev('session.compaction_complete'),
    ]);
    expect(signals).toMatchObject({ interruptionCount: 1, planModeUsed: true, apiErrorCount: 1, compactionCount: 1 });
  });
});

describe('live status from the events tail', () => {
  const now = T0 + 60_000;
  const at = (type: string, data: Record<string, unknown> = {}, ms = T0): CliEvent => ev(type, data, ms);

  it('covers each status', () => {
    expect(deriveCliLive([at('user.message', { content: 'x' })], T0, now).status).toBe('working');
    expect(deriveCliLive([at('assistant.message', { content: 'ok' }), at('assistant.turn_end')], T0, now)).toMatchObject({
      status: 'waiting',
      facts: { lastEvent: 'turn-ended' },
    });
    expect(deriveCliLive([at('assistant.turn_end')], T0, T0 + LIVE_IDLE_MS).status).toBe('idle');
    expect(deriveCliLive([at('assistant.turn_end')], T0, T0 + LIVE_FINISHED_MS).status).toBe('finished');
    expect(deriveCliLive([at('assistant.turn_end'), at('session.shutdown')], T0, now).status).toBe('finished');
  });

  it('names pending tools, whether started or only requested', () => {
    const live = deriveCliLive(
      [
        at('assistant.message', { model: 'gpt-5', toolRequests: [{ toolCallId: 'a', name: 'bash' }, { toolCallId: 'b', name: 'view' }] }),
        at('tool.execution_start', { toolCallId: 'a', toolName: 'bash' }),
      ],
      T0,
      now,
    );
    expect(live).toMatchObject({ status: 'working', awaitingApproval: false, facts: { lastEvent: 'tool-pending', model: 'gpt-5' } });
    expect([...live.facts.pendingTools].sort()).toEqual(['bash', 'view']);
  });

  it('is exact about an unanswered permission request, and never reads its content', () => {
    const asked = [
      at('tool.execution_start', { toolCallId: 'a', toolName: 'bash' }),
      at('permission.requested', { requestId: 'r1', permissionRequest: { kind: 'shell', fullCommandText: 'rm -rf secret' } }),
    ];
    const waiting = deriveCliLive(asked, T0, T0 + LIVE_IDLE_MS * 2);
    expect(waiting).toMatchObject({ status: 'waiting', awaitingApproval: true });
    expect(JSON.stringify(waiting)).not.toContain('secret');
    const answered = deriveCliLive([...asked, at('permission.completed', { requestId: 'r1' })], T0, now);
    expect(answered).toMatchObject({ status: 'working', awaitingApproval: false });
  });
});

describe('helper runs', () => {
  const home = path.join(os.tmpdir(), 'home');
  const context = { helperCwd: path.join(home, '.agent-observability', 'helper-cwd'), homeDir: home };
  const start = (cwd: string): CliEvent => ev('session.start', { context: { cwd } });

  it('drops anything started in the dedicated helper directory', () => {
    expect(isHelperRun([start(context.helperCwd), ev('user.message', { content: 'a' }), ev('user.message', { content: 'b' })], {}, context)).toBe(true);
    expect(isHelperRun([], { cwd: context.helperCwd + path.sep }, context)).toBe(true);
  });

  it('drops the legacy shapes: a tool-less one-shot at home, or one view of the payload file', () => {
    expect(isHelperRun([start(home), ev('user.message', { content: 'q' }), ev('assistant.message')], {}, context)).toBe(true);
    const pointer = copilotPayloadPointer(path.join(os.tmpdir(), 'ao-copilot-1', 'prompt.md'));
    expect(pointer.startsWith(COPILOT_PAYLOAD_POINTER_PREFIX)).toBe(true);
    expect(
      isHelperRun([start(home), ev('user.message', { content: pointer }), ev('tool.execution_start', { toolCallId: 'v', toolName: 'view' })], {}, context),
    ).toBe(true);
  });

  it('keeps a real session that happened to start at home, and any session elsewhere', () => {
    const two = [start(home), ev('user.message', { content: 'a' }), ev('assistant.message'), ev('user.message', { content: 'b' })];
    expect(isHelperRun(two, {}, context)).toBe(false);
    const tooled = [start(home), ev('user.message', { content: 'list files' }), ev('tool.execution_start', { toolCallId: 'x', toolName: 'bash' })];
    expect(isHelperRun(tooled, {}, context)).toBe(false);
    expect(isHelperRun([start(path.join(home, 'repo')), ev('user.message', { content: 'q' })], {}, context)).toBe(false);
  });
});

describe('discovery and the source', () => {
  let home: string;
  let env: CopilotCliFs;
  const write = (id: string, events: CliEvent[] | undefined, workspace: string): void => {
    const dir = path.join(home, '.copilot', 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), workspace);
    if (events !== undefined) {
      fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  };
  const config = { isCopilotCliEnabled: () => true, getExcludedRepositories: () => new Set<string>() };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-home-'));
    env = { ...defaultCopilotCliFs, homedir: () => home, env: {} };
    write('real', [ev('user.message', { content: 'work' }), ev('assistant.message', { model: 'gpt-5' }), ev('user.message', { content: 'more' })], 'repository: o/repo\ncwd: ' + path.join(home, 'repo'));
    write('stub', undefined, 'cwd: ' + home);
    write('helper', [ev('user.message', { content: 'q' }), ev('assistant.message')], 'cwd: ' + copilotHelperCwd(env));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('finds only directories with an events file, honouring COPILOT_HOME', () => {
    expect(discoverCopilotCliSessions(env).map((s) => s.sessionId).sort()).toEqual(['helper', 'real']);
    expect(discoverCopilotCliSessions({ ...env, env: { COPILOT_HOME: path.join(home, 'elsewhere') } })).toEqual([]);
  });

  it('lists real sessions, leaves helper runs out, and answers detail and retrospective', () => {
    const source = new CopilotCliSource(config, env);
    const listed = source.listSessions();
    expect(listed.ok && listed.value.map((s) => s.sessionId)).toEqual(['real']);
    expect(listed.ok && listed.value[0].repository).toBe('https://github.com/o/repo');
    const detail = source.getSessionDetail('real');
    expect(detail.ok && detail.value.turns).toHaveLength(2);
    expect(source.getSessionRetrospective('real').ok).toBe(true);
    expect(source.getSessionDetail('helper').ok).toBe(false);
    const rows = source.getAggregationRows();
    expect(rows.ok && rows.value.every((r) => r.sessionKey === 'real')).toBe(true);
  });

  it('is a quiet empty source when disabled or when there is no Copilot home', () => {
    expect(new CopilotCliSource({ ...config, isCopilotCliEnabled: () => false }, env).listSessions().ok).toBe(false);
    const empty = new CopilotCliSource(config, { ...env, homedir: () => path.join(home, 'nobody') }).listSessions();
    expect(empty.ok && empty.value).toEqual([]);
  });

  it('starts the helper in its own directory under the app home', () => {
    const previous = process.env.AGENT_OBSERVABILITY_HOME;
    process.env.AGENT_OBSERVABILITY_HOME = path.join(home, 'app-home');
    try {
      const dir = helperWorkingDirectory();
      expect(dir).toBe(path.join(home, 'app-home', 'helper-cwd'));
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_OBSERVABILITY_HOME;
      } else {
        process.env.AGENT_OBSERVABILITY_HOME = previous;
      }
    }
  });

  // Opt-in smoke check against this machine's real store; skipped everywhere else.
  it.skipIf(process.env.AO_REAL_COPILOT !== '1')('maps the real sessions on this machine without throwing', () => {
    const source = new CopilotCliSource(config);
    const listed = source.listSessions();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      for (const s of listed.value) {
        expect(source.getSessionDetail(s.sessionId).ok).toBe(true);
      }
      expect(listed.value.length).toBeLessThan(discoverCopilotCliSessions().length);
    }
  });
});
