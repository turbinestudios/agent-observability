import { describe, it, expect } from 'vitest';
import type { TranscriptRecord } from '../claude/transcript';
import {
  LIVE_FINISHED_MS,
  LIVE_IDLE_MS,
  LIVE_STATUS_ORDER,
  deriveLiveStatus,
  deriveTailFacts,
} from './liveStatus';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function user(text: string, extra: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: iso(0), ...extra };
}

function assistantText(text: string, extra: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
    timestamp: iso(0),
    ...extra,
  };
}

function assistantTools(tools: { id: string; name: string }[]): TranscriptRecord {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: {} })),
    },
    timestamp: iso(0),
  };
}

function toolResult(ids: string[]): TranscriptRecord {
  return {
    type: 'user',
    message: { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
    timestamp: iso(0),
  };
}

describe('deriveTailFacts: last event', () => {
  it('classifies a trailing assistant text as assistant-text', () => {
    const facts = deriveTailFacts([user('do x'), assistantText('done')], T0);
    expect(facts.lastEvent).toBe('assistant-text');
    expect(facts.pendingTools).toEqual([]);
  });

  it('classifies a trailing human prompt as user-prompt', () => {
    expect(deriveTailFacts([assistantText('hi'), user('now do y')], T0).lastEvent).toBe('user-prompt');
  });

  it('classifies an unresolved tool_use as tool-pending with the tool names', () => {
    const facts = deriveTailFacts([user('go'), assistantTools([{ id: 'a', name: 'Bash' }])], T0);
    expect(facts.lastEvent).toBe('tool-pending');
    expect(facts.pendingTools).toEqual(['Bash']);
  });

  it('tracks pending tools across two assistant records, resolving by later tool_result', () => {
    const records = [
      user('go'),
      assistantTools([{ id: 'a', name: 'Read' }]),
      toolResult(['a']),
      assistantTools([{ id: 'b', name: 'Edit' }, { id: 'c', name: 'Bash' }]),
      toolResult(['b']),
    ];
    // Last record is the tool_result for b → tool-result; c is still outstanding
    // but the last event is what the transcript says happened last.
    expect(deriveTailFacts(records, T0).lastEvent).toBe('tool-result');
    // With the second assistant record last, c is pending and a is resolved.
    const facts = deriveTailFacts(records.slice(0, 4), T0);
    expect(facts.lastEvent).toBe('tool-pending');
    expect(facts.pendingTools).toEqual(['Edit', 'Bash']);
  });

  it('does not report a tool as pending when a later tool_result resolved it', () => {
    const records = [user('go'), assistantTools([{ id: 'a', name: 'Read' }]), toolResult(['a']), assistantText('ok')];
    const facts = deriveTailFacts(records, T0);
    expect(facts.lastEvent).toBe('assistant-text');
    expect(facts.pendingTools).toEqual([]);
  });

  it('classifies a trailing tool_result-only user record as tool-result', () => {
    expect(deriveTailFacts([assistantTools([{ id: 'a', name: 'Read' }]), toolResult(['a'])], T0).lastEvent).toBe(
      'tool-result',
    );
  });

  it('classifies an interruption marker as interruption', () => {
    expect(deriveTailFacts([assistantText('…'), user('[Request interrupted by user]')], T0).lastEvent).toBe(
      'interruption',
    );
  });

  it('skips isMeta user records', () => {
    const records = [assistantText('done'), user('injected', { isMeta: true })];
    expect(deriveTailFacts(records, T0).lastEvent).toBe('unknown');
  });

  it('skips slash-command bookkeeping and keeps walking', () => {
    const records = [assistantText('done'), user('<command-name>/clear</command-name>')];
    expect(deriveTailFacts(records, T0).lastEvent).toBe('assistant-text');
  });

  it('ignores sidechain records', () => {
    const records = [assistantText('done'), user('sub prompt', { isSidechain: true })];
    expect(deriveTailFacts(records, T0).lastEvent).toBe('assistant-text');
  });

  it('classifies a turn_duration system record as turn-ended and skips other system records', () => {
    expect(
      deriveTailFacts([assistantText('x'), { type: 'system', subtype: 'turn_duration', durationMs: 5 }], T0).lastEvent,
    ).toBe('turn-ended');
    expect(
      deriveTailFacts([user('x'), { type: 'system', subtype: 'compact_boundary' }], T0).lastEvent,
    ).toBe('user-prompt');
  });

  it('skips metadata record types', () => {
    const records = [user('x'), { type: 'ai-title', aiTitle: 'T' }, { type: 'last-prompt' }, { type: 'mode', mode: 'x' }];
    expect(deriveTailFacts(records, T0).lastEvent).toBe('user-prompt');
  });

  it('returns unknown for an empty window', () => {
    expect(deriveTailFacts([], T0).lastEvent).toBe('unknown');
  });
});

describe('deriveTailFacts: metadata', () => {
  it('extracts branch, cwd, sessionId, model and ai-title', () => {
    const records: TranscriptRecord[] = [
      { type: 'ai-title', aiTitle: 'Fix the build' },
      user('x', { gitBranch: 'main', cwd: 'C:\\repo', sessionId: 'abc' }),
      assistantText('y'),
    ];
    const facts = deriveTailFacts(records, T0);
    expect(facts.aiTitle).toBe('Fix the build');
    expect(facts.gitBranch).toBe('main');
    expect(facts.cwd).toBe('C:\\repo');
    expect(facts.sessionId).toBe('abc');
    expect(facts.model).toBe('claude-opus-5-5');
  });

  it('takes lastActivityMs as the max of file mtime and the newest record timestamp', () => {
    const newer = iso(60_000);
    expect(deriveTailFacts([user('x', { timestamp: newer })], T0).lastActivityMs).toBe(T0 + 60_000);
    expect(deriveTailFacts([user('x', { timestamp: iso(-60_000) })], T0).lastActivityMs).toBe(T0);
    expect(deriveTailFacts([user('x', { timestamp: 'garbage' })], T0).lastActivityMs).toBe(T0);
  });
});

describe('deriveLiveStatus', () => {
  const facts = (lastEvent: Parameters<typeof deriveLiveStatus>[0]['lastEvent'], lastActivityMs = T0) => ({
    lastActivityMs,
    lastEvent,
    pendingTools: [],
  });

  it('maps fresh last events to working or waiting', () => {
    expect(deriveLiveStatus(facts('assistant-text'), T0 + 1000)).toBe('waiting');
    expect(deriveLiveStatus(facts('turn-ended'), T0 + 1000)).toBe('waiting');
    expect(deriveLiveStatus(facts('interruption'), T0 + 1000)).toBe('waiting');
    expect(deriveLiveStatus(facts('tool-pending'), T0 + 1000)).toBe('working');
    expect(deriveLiveStatus(facts('user-prompt'), T0 + 1000)).toBe('working');
    expect(deriveLiveStatus(facts('tool-result'), T0 + 1000)).toBe('working');
    expect(deriveLiveStatus(facts('unknown'), T0 + 1000)).toBe('working');
  });

  it('grades by age regardless of last event', () => {
    expect(deriveLiveStatus(facts('assistant-text'), T0 + LIVE_IDLE_MS - 1)).toBe('waiting');
    expect(deriveLiveStatus(facts('assistant-text'), T0 + LIVE_IDLE_MS)).toBe('idle');
    expect(deriveLiveStatus(facts('unknown'), T0 + LIVE_IDLE_MS)).toBe('idle');
    expect(deriveLiveStatus(facts('tool-pending'), T0 + LIVE_FINISHED_MS - 1)).toBe('idle');
    expect(deriveLiveStatus(facts('tool-pending'), T0 + LIVE_FINISHED_MS)).toBe('finished');
  });

  it('honours injected thresholds', () => {
    expect(deriveLiveStatus(facts('user-prompt'), T0 + 10, { idleMs: 5, finishedMs: 20 })).toBe('idle');
    expect(deriveLiveStatus(facts('user-prompt'), T0 + 25, { idleMs: 5, finishedMs: 20 })).toBe('finished');
  });

  it('orders statuses by what needs the user first', () => {
    expect(LIVE_STATUS_ORDER).toEqual(['waiting', 'working', 'idle', 'finished']);
  });
});
