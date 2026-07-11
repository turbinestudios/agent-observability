import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngestStore } from '../otel/ingestStore';
import { flattenSpans } from '../otel/otlpParse';
import { otlpSpansToRows } from '../otel/otlpToRows';
import { AgentSink, freshAgentIndex } from './agentSink';
import { CopilotAgentSource, type AgentSourceConfig } from './copilotAgentSource';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
// A UUID session id, as real Copilot CLI emits — required for the session to
// surface in listSessions (the tree admits only UUID-shaped chat_session_ids).
const SESSION = '11111111-1111-4111-8111-111111111111';

/** An autonomous-agent OTLP envelope: identity on the resource, a chat span. */
const envelope = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: sv('error-remediation') },
          { key: 'service.instance.id', value: sv('run-42') },
          { key: 'agent.type', value: sv('copilot-cli') },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat',
              spanId: 'a1',
              traceId: 'tr1',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.conversation.id', value: sv(SESSION) },
                { key: 'copilot_chat.chat_session_id', value: sv(SESSION) },
                { key: 'gen_ai.request.model', value: sv('gpt-4o') },
                { key: 'gen_ai.usage.input_tokens', value: iv(42) },
                { key: 'copilot_chat.user_request', value: sv('fix the null deref') },
              ],
            },
          ],
        },
      ],
    },
  ],
};

class FakeConfig implements AgentSourceConfig {
  enabled = true;
  isCopilotAgentEnabled(): boolean {
    return this.enabled;
  }
  getCodeFileExtensions(): string[] {
    return [];
  }
  getDocFileExtensions(): string[] {
    return [];
  }
  getExcludedRepositories(): ReadonlySet<string> {
    return new Set();
  }
}

/** Populate the sink's ingest DB with the agent envelope. */
function seedIngest(sink: AgentSink): void {
  sink.ensureDirs();
  const store = new IngestStore(sink.ingestDbPath());
  store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
  store.close();
}

describe('CopilotAgentSource', () => {
  let dir: string;
  let sink: AgentSink;
  let config: FakeConfig;
  let source: CopilotAgentSource;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-source-'));
    sink = new AgentSink(dir);
    config = new FakeConfig();
    source = new CopilotAgentSource(sink, config);
  });

  afterEach(() => {
    source.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares its identity', () => {
    expect(source.id).toBe('copilot-agent');
    expect(source.label).toBe('Copilot (Autonomous)');
    expect(source.costMode).toBe('aiu');
    expect(source.isEnabled()).toBe(true);
  });

  it('reads pulled agent sessions from the sink once the ingest DB lands', () => {
    // Before the first batch: no ingest DB → a typed failure, not a throw.
    expect(source.getSessionInteractions(SESSION).ok).toBe(false);

    seedIngest(sink);
    source.refresh();

    const interactions = source.getSessionInteractions(SESSION);
    expect(interactions.ok).toBe(true);
    if (interactions.ok) {
      expect(interactions.value).toHaveLength(1);
      expect(interactions.value[0].operation).toBe('chat');
      expect(interactions.value[0].inputTokens).toBe(42);
    }
    const sessions = source.listSessions();
    expect(sessions.ok && sessions.value.length).toBe(1);
  });

  it('exposes LOCAL-only content for the deviation detector', () => {
    seedIngest(sink);
    source.refresh();
    const content = source.getSessionContent(SESSION, 'copilot_chat.user_request');
    expect(content.ok).toBe(true);
    if (content.ok) {
      expect([...content.value.values()]).toContain('fix the null deref');
    }
  });

  it('never emits aggregation rows (raw is LOCAL-only, never re-uploaded)', () => {
    seedIngest(sink);
    source.refresh();
    expect(source.getAggregationRows()).toEqual({ ok: true, value: [] });
  });

  it('reports disabled through the read stack when the flag is off', () => {
    config.enabled = false;
    expect(source.isEnabled()).toBe(false);
    expect(source.getOverview()).toMatchObject({ ok: false, reason: 'disabled' });
    expect(source.getAggregationRows()).toMatchObject({ ok: false, reason: 'disabled' });
  });

  it('notes a first pull in progress until a batch has landed', () => {
    expect(source.truncationNote()).toBe(
      'First pull in progress — autonomous agent sessions will appear shortly.',
    );

    const index = freshAgentIndex();
    index.puller.firstPullCompleted = true;
    index.batches['b1'] = {
      batchId: 'b1',
      service: 'error-remediation',
      createdAtMs: 1,
      ingestedAtMs: 2,
      spanCount: 1,
    };
    sink.writeIndex(index);

    expect(source.truncationNote()).toBeUndefined();
  });

  it('stays inert (no throw) when there is no sink', () => {
    const noSink = new CopilotAgentSource(undefined, config);
    expect(noSink.isEnabled()).toBe(true);
    expect(noSink.getSessionInteractions(SESSION).ok).toBe(false);
    expect(noSink.truncationNote()).toBeUndefined();
    noSink.dispose();
  });
});
