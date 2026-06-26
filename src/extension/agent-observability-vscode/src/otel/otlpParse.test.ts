import { describe, expect, it } from 'vitest';
import { extractLiveFields, flattenSpans, parseLine } from './otlpParse';

/**
 * Fixtures mirror the structure of a captured Copilot Agent Debug Logs export
 * (OTLP/JSON: resourceSpans → scopeSpans → spans; resource carries `session.id`;
 * gen_ai.* attributes on spans; int64 tokens serialized as STRINGS).
 */
const SESSION_ID = 'c1eb060a-ea5d-4492-b188-1e9fb2eb51da';

function envelope(spans: unknown[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'copilot-chat' } },
            { key: 'session.id', value: { stringValue: SESSION_ID } },
          ],
        },
        scopeSpans: [{ scope: { name: 'copilot-chat' }, spans }],
      },
    ],
  });
}

const chatSpan = {
  name: 'chat:gpt-5.4',
  startTimeUnixNano: '1780925693304000000',
  endTimeUnixNano: '1780925693404000000',
  attributes: [
    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
    { key: 'gen_ai.request.model', value: { stringValue: 'gpt-5.4' } },
    { key: 'gen_ai.usage.input_tokens', value: { intValue: '1200' } },
    { key: 'gen_ai.usage.output_tokens', value: { intValue: '340' } },
  ],
};

const toolSpan = {
  name: 'read_file',
  attributes: [
    { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
    { key: 'gen_ai.tool.name', value: { stringValue: 'read_file' } },
  ],
};

describe('flattenSpans', () => {
  it('flattens a resourceSpans envelope and attaches resource attributes', () => {
    const flat = flattenSpans(JSON.parse(envelope([chatSpan, toolSpan])));
    expect(flat).toHaveLength(2);
    expect(flat[0].resource.get('session.id')).toBe(SESSION_ID);
    expect(flat[0].span.name).toBe('chat:gpt-5.4');
  });

  it('accepts a single bare span object', () => {
    const flat = flattenSpans(chatSpan);
    expect(flat).toHaveLength(1);
    expect(flat[0].span.name).toBe('chat:gpt-5.4');
  });

  it('returns [] for non-OTLP input', () => {
    expect(flattenSpans(null)).toEqual([]);
    expect(flattenSpans({ hello: 'world' })).toEqual([]);
  });
});

describe('parseLine', () => {
  it('parses a valid line and skips garbage', () => {
    expect(parseLine(envelope([chatSpan]))).toHaveLength(1);
    expect(parseLine('not json')).toEqual([]);
    expect(parseLine('   ')).toEqual([]);
  });
});

describe('extractLiveFields', () => {
  it('reads model + tokens (string int64) from a chat span', () => {
    const [flat] = flattenSpans(JSON.parse(envelope([chatSpan])));
    const f = extractLiveFields(flat);
    expect(f.operation).toBe('chat');
    expect(f.model).toBe('gpt-5.4');
    expect(f.inputTokens).toBe(1200);
    expect(f.outputTokens).toBe(340);
    expect(f.candidateIds).toContain(SESSION_ID);
    expect(f.timestampMs).toBe(1780925693404); // endTimeUnixNano / 1e6
  });

  it('reads the tool name from an execute_tool span', () => {
    const [flat] = flattenSpans(JSON.parse(envelope([toolSpan])));
    const f = extractLiveFields(flat);
    expect(f.operation).toBe('execute_tool');
    expect(f.toolName).toBe('read_file');
  });

  it('derives the turn index from a turn boundary span name', () => {
    const [flat] = flattenSpans(
      JSON.parse(envelope([{ name: 'turn_start:3', attributes: [] }])),
    );
    expect(extractLiveFields(flat).turn).toBe(3);
  });

  it('derives the sub-agent name from a runSubagent span', () => {
    const [flat] = flattenSpans(
      JSON.parse(envelope([{ name: 'runSubagent-Frontend', attributes: [] }])),
    );
    expect(extractLiveFields(flat).subagentName).toBe('Frontend');
  });

  it('prefers a span-level conversation id over the resource session id', () => {
    const span = {
      name: 'chat:gpt-5.4',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.conversation.id', value: { stringValue: 'conv-123' } },
      ],
    };
    const [flat] = flattenSpans(JSON.parse(envelope([span])));
    const f = extractLiveFields(flat);
    expect(f.candidateIds[0]).toBe('conv-123');
    expect(f.candidateIds).toContain(SESSION_ID);
  });
});
