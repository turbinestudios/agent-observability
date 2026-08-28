import { describe, expect, it } from 'vitest';
import type { ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import type { SessionDetail } from '@agent-observability/core/src/telemetry/models';
import type { RpcEvent, SessionRow } from '../shared/rpc';
import { AI_HELPER_ACK_KEY, AiHelperController, linkifyCitations, type AiHelperDeps } from './aiHelper';

/**
 * The controller under fakes: no CLI is ever spawned (streamSeam), no SQLite is
 * opened, and the settings live in a Map. What is asserted is the consent gate,
 * the grounding, the history replay, and the cancellation behavior — the parts
 * a renderer bug or refactor could silently break.
 */

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'claude',
    sessionId: 'abc-123',
    repository: 'github.com/acme/app',
    title: 'Fix the login bug',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    durationMs: 1_000,
    interactionCount: 3,
    llmCalls: 3,
    toolCalls: 5,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    model: 'sonnet',
    agentModes: [],
    indexedAtMs: 3_000,
    ...overrides,
  };
}

function fakeSettings(initial: Record<string, unknown> = {}): AiHelperDeps['settings'] & {
  values: Map<string, unknown>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T,>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
    update: (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
      }
    },
  };
}

function fakeBackend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    isAvailable: async () => ({ available: true }),
    listModels: async () => [],
    streamChat: async () => undefined,
    describeError: (err) => ({ message: err instanceof Error ? err.message : String(err), recoverable: false }),
    ...overrides,
  };
}

/** A detail with one turn, enough for the focus digest. */
function fakeDetail(): SessionDetail {
  return {
    turns: [
      {
        timestampMs: 0,
        agentMode: 'agent',
        model: 'sonnet',
        durationMs: 0,
        success: true,
        llmCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        linesOfCode: 0,
        linesOfDoc: 0,
        linesOfCodeRemoved: 0,
        linesOfDocRemoved: 0,
        events: [],
        userRequest: 'please fix it',
        finalResponse: 'fixed',
      },
    ],
  } as unknown as SessionDetail;
}

interface Harness {
  controller: AiHelperController;
  events: RpcEvent[];
  sentMessages: { role: string; text: string }[][];
  settings: ReturnType<typeof fakeSettings>;
}

function harness(overrides: Partial<AiHelperDeps> = {}, acknowledged = true): Harness {
  const events: RpcEvent[] = [];
  const sentMessages: { role: string; text: string }[][] = [];
  const settings = fakeSettings(acknowledged ? { [AI_HELPER_ACK_KEY]: true } : {});
  const deps: AiHelperDeps = {
    db: {
      listSessions: () => [row(), row({ sessionId: 'def-456', title: 'Second session' })],
      getRow: (source, sessionId) =>
        source === 'claude' && sessionId === 'abc-123' ? row() : undefined,
    },
    sources: {
      get: (source: string) =>
        source === 'claude'
          ? ({ getSessionDetail: () => ({ ok: true, value: fakeDetail() }) } as unknown as ReturnType<
              AiHelperDeps['sources']['get']
            >)
          : undefined,
    },
    settings,
    renames: { apply: (rows) => rows },
    hidden: { all: () => [] },
    backend: () => fakeBackend(),
    emit: (event) => events.push(event),
    streamSeam: async (messages, onDelta) => {
      sentMessages.push(messages.map((m) => ({ role: m.role, text: m.text })));
      onDelta('The answer cites [S1].');
    },
    ...overrides,
  };
  return { controller: new AiHelperController(deps), events, sentMessages, settings };
}

describe('AiHelperController.send', () => {
  it('refuses before the first-use notice is acknowledged, and never streams', async () => {
    const h = harness({}, false);
    const result = await h.controller.send({ text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('notice');
    expect(h.sentMessages).toHaveLength(0);
    expect(h.controller.state().messages).toHaveLength(0);
  });

  it('acknowledge() persists the consent key the datahost checks', async () => {
    const h = harness({}, false);
    h.controller.acknowledge();
    expect(h.settings.values.get(AI_HELPER_ACK_KEY)).toBe(true);
    const result = await h.controller.send({ text: 'hi' });
    expect(result.ok).toBe(true);
  });

  it('grounds the send in the session corpus — titles included by decision', async () => {
    const h = harness();
    await h.controller.send({ text: 'what did I do?' });
    const preamble = h.sentMessages[0][0].text;
    expect(preamble).toContain('"Fix the login bug"');
    expect(preamble).toContain('"Second session"');
    expect(preamble).toContain('github.com/acme/app');
  });

  it('applies renames to the corpus, so the model sees the user-chosen names', async () => {
    const h = harness({
      renames: { apply: (rows) => rows.map((r) => ({ ...r, title: `Renamed ${r.sessionId}` })) },
    });
    await h.controller.send({ text: 'q' });
    expect(h.sentMessages[0][0].text).toContain('Renamed abc-123');
  });

  it('replays the whole thread on the next send — the follow-up memory', async () => {
    const h = harness();
    await h.controller.send({ text: 'first question' });
    await h.controller.send({ text: 'and a follow-up?' });

    const second = h.sentMessages[1];
    const texts = second.map((m) => m.text);
    expect(texts).toContain('first question');
    expect(texts.some((t) => t.includes('The answer cites'))).toBe(true);
    expect(texts[texts.length - 1]).toBe('and a follow-up?');
  });

  it('attaches the focus session digest and its ref', async () => {
    const h = harness();
    const result = await h.controller.send({
      text: 'why did this struggle?',
      focus: { source: 'claude', sessionId: 'abc-123' },
    });
    expect(result.ok).toBe(true);
    const preamble = h.sentMessages[0][0].text;
    expect(preamble).toContain('# Focus session');
    expect(preamble).toContain('Developer asked: please fix it');
  });

  it('reports an unknown focus source as an error-value, not a throw', async () => {
    const h = harness();
    const result = await h.controller.send({
      text: 'q',
      focus: { source: 'nope', sessionId: 'x' },
    });
    expect(result).toEqual({ ok: false, error: 'Unknown source: nope' });
  });

  it('maps an unavailable backend to its reason', async () => {
    const h = harness({
      backend: () =>
        fakeBackend({
          isAvailable: async () => ({ available: false, reason: 'Claude Code CLI not found — set the Claude CLI path in Settings.' }),
        }),
    });
    const result = await h.controller.send({ text: 'q' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Settings');
  });

  it('refuses a second send while one is streaming', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      streamSeam: async (_messages, onDelta) => {
        onDelta('partial');
        await gate;
      },
    });
    const first = h.controller.send({ text: 'one' });
    const second = await h.controller.send({ text: 'two' });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already streaming');
    release();
    await first;
  });

  it('stop() keeps the partial answer and resolves cancelled, not failed', async () => {
    // Stop can only land once the stream is up (cancelInFlight is armed after
    // the availability await), so the seam signals when it has started.
    let started: () => void = () => undefined;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness({
      streamSeam: async (_messages, onDelta, token) => {
        onDelta('partial answer');
        started();
        await new Promise<void>((_, reject) => {
          token.onCancellationRequested(() =>
            reject(Object.assign(new Error('Canceled'), { name: 'Canceled' })),
          );
        });
      },
    });
    const pending = h.controller.send({ text: 'q' });
    await startedP;
    h.controller.stop();
    const result = await pending;
    expect(result).toEqual({ ok: true, cancelled: true });
    const state = h.controller.state();
    expect(state.messages.map((m) => m.text)).toContain('partial answer');
    expect(state.busy).toBe(false);
  });

  it('a failed send leaves no dangling user turn when nothing streamed', async () => {
    const h = harness({
      streamSeam: async () => {
        throw new Error('exploded');
      },
    });
    const result = await h.controller.send({ text: 'q' });
    expect(result.ok).toBe(false);
    // The question stays in the input box (renderer behavior); the thread
    // records only what actually happened: the user turn plus nothing.
    expect(h.controller.state().messages.map((m) => m.role)).toEqual(['user']);
  });

  it('streams host-rendered HTML deltas and finishes with a closing emit', async () => {
    const h = harness();
    await h.controller.send({ text: 'q' });
    const deltas = h.events.filter((e) => e.event === 'ai.assistantDelta');
    expect(deltas.length).toBeGreaterThan(0);
    const last = deltas[deltas.length - 1] as Extract<RpcEvent, { event: 'ai.assistantDelta' }>;
    // The [S1] citation is linkified with the session's TITLE as the label.
    expect(last.html).toContain('data-id="abc-123"');
    expect(last.html).toContain('>Fix the login bug</a>');
  });

  it('reset() clears the thread and the focus', async () => {
    const h = harness();
    await h.controller.send({ text: 'q', focus: { source: 'claude', sessionId: 'abc-123' } });
    expect(h.controller.state().messages.length).toBeGreaterThan(0);
    h.controller.reset();
    const state = h.controller.state();
    expect(state.messages).toHaveLength(0);
    expect(state.focus).toBeUndefined();
  });
});

describe('linkifyCitations', () => {
  const refs = new Map([
    ['S1', { source: 'claude', sessionId: 'abc', label: 'My session' }],
  ]);

  it('rewrites a known ref to a labeled anchor with data attributes and no href', () => {
    const html = linkifyCitations('<p>See [S1] for details.</p>', refs);
    expect(html).toContain('data-source="claude"');
    expect(html).toContain('data-id="abc"');
    expect(html).toContain('>My session</a>');
    expect(html).not.toContain('href=');
  });

  it('leaves unknown refs as plain text', () => {
    expect(linkifyCitations('<p>[S99]</p>', refs)).toBe('<p>[S99]</p>');
  });

  it('never rewrites inside code or pre blocks', () => {
    const html = '<pre><code>[S1]</code></pre><p>[S1]</p>';
    const out = linkifyCitations(html, refs);
    expect(out).toContain('<code>[S1]</code>');
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it('escapes hostile characters in the label and the attributes', () => {
    const hostile = new Map([
      ['S1', { source: 'claude', sessionId: 'a"b', label: '<img src=x> "quote"' }],
    ]);
    const out = linkifyCitations('<p>[S1]</p>', hostile);
    expect(out).not.toContain('<img');
    expect(out).toContain('data-id="a&quot;b"');
  });
});
