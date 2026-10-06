import { describe, expect, it } from 'vitest';
import type { TranscriptRecord } from '../claude/transcript';
import type { CliEvent } from '../copilotCli/events';
import { deriveCliLive } from '../copilotCli/mapper';
import { deriveTailFacts } from './liveStatus';

/**
 * `lastToolFailed`: the transcript's tail is a failed tool result with nothing
 * after it. The attention inbox uses it to tell "ended on an error" from an
 * ordinary finish. Timestamps are built from a fixed epoch value.
 */

const AT = 1_700_000_000_000;
const iso = (offsetMs: number): string => new Date(AT + offsetMs).toISOString();

function toolUse(id: string): TranscriptRecord {
  return {
    type: 'assistant',
    timestamp: iso(0),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
  };
}

function toolResult(id: string, isError: boolean): TranscriptRecord {
  return {
    type: 'user',
    timestamp: iso(1_000),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] },
  };
}

describe('deriveTailFacts lastToolFailed', () => {
  it('is set when the newest record is a failed tool result', () => {
    const facts = deriveTailFacts([toolUse('t1'), toolResult('t1', true)], AT);
    expect(facts.lastEvent).toBe('tool-result');
    expect(facts.lastToolFailed).toBe(true);
  });

  it('is absent for a successful result, and once the agent has answered after a failure', () => {
    expect(deriveTailFacts([toolUse('t1'), toolResult('t1', false)], AT).lastToolFailed).toBeUndefined();
    const answered = deriveTailFacts(
      [
        toolUse('t1'),
        toolResult('t1', true),
        { type: 'assistant', timestamp: iso(2_000), message: { role: 'assistant', content: [{ type: 'text', text: 'That failed.' }] } },
      ],
      AT,
    );
    expect(answered.lastEvent).toBe('assistant-text');
    expect(answered.lastToolFailed).toBeUndefined();
  });
});

describe('deriveCliLive lastToolFailed and approval', () => {
  const event = (type: string, data: Record<string, unknown>, offsetMs: number): CliEvent => ({
    type,
    data,
    timestamp: iso(offsetMs),
  });

  it('flags a tail that ends on a failed tool, and not one that ends on a success', () => {
    const failed = deriveCliLive(
      [
        event('tool.execution_start', { toolCallId: 'c1', toolName: 'shell' }, 0),
        event('tool.execution_complete', { toolCallId: 'c1', success: false }, 1_000),
      ],
      AT,
      AT + 2_000,
    );
    expect(failed.facts.lastEvent).toBe('tool-result');
    expect(failed.facts.lastToolFailed).toBe(true);

    const passed = deriveCliLive(
      [
        event('tool.execution_start', { toolCallId: 'c1', toolName: 'shell' }, 0),
        event('tool.execution_complete', { toolCallId: 'c1', success: true }, 1_000),
      ],
      AT,
      AT + 2_000,
    );
    expect(passed.facts.lastToolFailed).toBeUndefined();
  });

  it('reports an unanswered permission request as an exact wait', () => {
    const live = deriveCliLive(
      [
        event('tool.execution_start', { toolCallId: 'c1', toolName: 'create' }, 0),
        event('permission.requested', { requestId: 'r1' }, 500),
      ],
      AT,
      AT + 2_000,
    );
    expect(live.status).toBe('waiting');
    expect(live.awaitingApproval).toBe(true);
  });
});
