import { describe, it, expect } from 'vitest';
import { flattenSpans } from './otlpParse';
import { otlpSpansToRows } from './otlpToRows';

// AnyValue constructors (OTLP/JSON encodes int64 as a STRING).
const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });

/** A synthetic OTLP/JSON `/v1/traces` envelope mirroring the validated shape. */
const envelope = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'session.id', value: sv('sess1') }] },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat gpt',
              spanId: 's-chat',
              traceId: 't1',
              parentSpanId: 's-root',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 2, message: 'boom' },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.provider.name', value: sv('github') },
                { key: 'gen_ai.agent.name', value: sv('copilot') },
                { key: 'gen_ai.conversation.id', value: sv('conv1') },
                { key: 'copilot_chat.chat_session_id', value: sv('chat1') },
                { key: 'gen_ai.request.model', value: sv('gpt-x') },
                { key: 'gen_ai.response.model', value: sv('gpt-x-2024') },
                { key: 'gen_ai.usage.input_tokens', value: iv(100) },
                { key: 'gen_ai.usage.output_tokens', value: iv(20) },
                { key: 'gen_ai.usage.cache_read.input_tokens', value: iv(50) },
                { key: 'gen_ai.usage.reasoning_tokens', value: iv(7) },
                { key: 'copilot_chat.turn_count', value: iv(3) },
                { key: 'copilot_chat.time_to_first_token', value: iv(503) },
                { key: 'copilot_chat.user_request', value: sv('do the thing') },
                { key: 'copilot_chat.copilot_usage_nano_aiu', value: iv(1_000_000_000) },
              ],
            },
            {
              name: 'execute_tool read_file',
              spanId: 's-tool',
              traceId: 't1',
              startTimeUnixNano: '1700000002000000000',
              endTimeUnixNano: '1700000002500000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('execute_tool') },
                { key: 'gen_ai.tool.name', value: sv('read_file') },
                { key: 'gen_ai.tool.type', value: sv('function') },
                { key: 'gen_ai.tool.call.id', value: sv('call-1') },
                { key: 'copilot_chat.chat_session_id', value: sv('chat1') },
              ],
            },
            // No spanId → must be skipped (span_id is the primary key).
            { name: 'orphan', traceId: 't1', attributes: [{ key: 'gen_ai.operation.name', value: sv('chat') }] },
          ],
        },
      ],
    },
  ],
};

describe('otlpSpansToRows', () => {
  const { spans, attributes } = otlpSpansToRows(flattenSpans(envelope));
  const chat = spans.find((s) => s.span_id === 's-chat')!;
  const tool = spans.find((s) => s.span_id === 's-tool')!;

  it('skips spans without a span id', () => {
    expect(spans).toHaveLength(2);
    expect(spans.some((s) => s.name === 'orphan')).toBe(false);
  });

  it('maps the typed chat columns from gen_ai/copilot_chat attributes', () => {
    expect(chat.operation_name).toBe('chat');
    expect(chat.provider_name).toBe('github');
    expect(chat.agent_name).toBe('copilot');
    expect(chat.conversation_id).toBe('conv1');
    expect(chat.chat_session_id).toBe('chat1');
    expect(chat.request_model).toBe('gpt-x');
    expect(chat.response_model).toBe('gpt-x-2024');
    expect(chat.input_tokens).toBe(100);
    expect(chat.output_tokens).toBe(20);
    expect(chat.cached_tokens).toBe(50); // from cache_read.input_tokens
    expect(chat.reasoning_tokens).toBe(7);
    // Mirrors Copilot: turn_index is NOT derived from copilot_chat.turn_count (left null).
    expect(chat.turn_index).toBeNull();
    expect(chat.ttft_ms).toBe(503);
  });

  it('maps status, parent, and nanosecond timestamps', () => {
    expect(chat.status_code).toBe(2);
    expect(chat.status_message).toBe('boom');
    expect(chat.parent_span_id).toBe('s-root');
    expect(chat.start_time_ms).toBe(1_700_000_000_000);
    expect(chat.end_time_ms).toBe(1_700_000_001_000);
  });

  it('maps tool columns and defaults missing typed columns to null', () => {
    expect(tool.operation_name).toBe('execute_tool');
    expect(tool.tool_name).toBe('read_file');
    expect(tool.tool_type).toBe('function');
    expect(tool.tool_call_id).toBe('call-1');
    expect(tool.input_tokens).toBeNull();
    expect(tool.status_code).toBe(1);
  });

  it('writes EVERY attribute to span_attributes (content + AIU + extras), stringified', () => {
    const chatAttrs = new Map(attributes.filter((r) => r.span_id === 's-chat').map((r) => [r.key, r.value]));
    expect(chatAttrs.get('copilot_chat.user_request')).toBe('do the thing');
    expect(chatAttrs.get('copilot_chat.copilot_usage_nano_aiu')).toBe('1000000000');
    expect(chatAttrs.get('gen_ai.usage.input_tokens')).toBe('100');
    // every attribute on the span is represented
    expect(chatAttrs.size).toBe(15);
  });

  it('does not copy non-identity resource attributes (session.id) onto spans', () => {
    // The local-Copilot resource carries only session.id, which is not a
    // service.*/agent.* key, so the copy must be a no-op for the local path.
    expect(attributes.some((r) => r.key === 'session.id')).toBe(false);
  });
});

describe('otlpSpansToRows resource/agent identity', () => {
  // A self-hosted producer (autonomous Copilot CLI agent) sets its identity on
  // the Resource via service.* and custom agent.* keys.
  const agentEnvelope = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: sv('error-remediation') },
            { key: 'service.instance.id', value: sv('run-42') },
            { key: 'service.namespace', value: sv('aca-jobs') },
            { key: 'agent.type', value: sv('copilot-cli') },
            // Not a service.*/agent.* key → must NOT be copied onto the span.
            { key: 'deployment.environment', value: sv('prod') },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat gpt',
                spanId: 's-agent',
                traceId: 't2',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  // Span-level override of a resource key: the span value must win.
                  { key: 'service.namespace', value: sv('span-wins') },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const { attributes } = otlpSpansToRows(flattenSpans(agentEnvelope));
  const agentAttrs = new Map(attributes.filter((r) => r.span_id === 's-agent').map((r) => [r.key, r.value]));

  it('copies service.* and agent.* resource attributes onto the span', () => {
    expect(agentAttrs.get('service.name')).toBe('error-remediation');
    expect(agentAttrs.get('service.instance.id')).toBe('run-42');
    expect(agentAttrs.get('agent.type')).toBe('copilot-cli');
  });

  it('does not copy resource keys outside the identity prefixes', () => {
    expect(agentAttrs.has('deployment.environment')).toBe(false);
  });

  it('lets a span-level attribute win over a resource attribute of the same key', () => {
    expect(agentAttrs.get('service.namespace')).toBe('span-wins');
  });
});
