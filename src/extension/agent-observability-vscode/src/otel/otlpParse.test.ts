import { describe, expect, it } from 'vitest';
import { flattenSpans, parseLine } from './otlpParse';

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
