import { describe, expect, it } from 'vitest';
import type { TranscriptRecord } from './transcript';
import { extractRetrospectiveSignals } from './retrospectiveSignals';

// Inline record fixtures in the style of mapper.test.ts: the minimal shape a
// real transcript line carries, nothing more.

function user(text: string, extra: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return { type: 'user', message: { role: 'user', content: text }, ...extra };
}

function assistant(text: string, extra: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  };
}

describe('extractRetrospectiveSignals', () => {
  it('counts both interruption variants, string or block content', () => {
    const signals = extractRetrospectiveSignals([
      user('please fix the tests'),
      user('[Request interrupted by user]'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        },
      },
      assistant('resuming'),
    ]);
    expect(signals.interruptionCount).toBe(2);
    expect(signals.endedWithInterruption).toBe(false);
  });

  it('classifies a trailing interruption as how the session ended', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      assistant('working'),
      user('[Request interrupted by user]'),
    ]);
    expect(signals.endedWithInterruption).toBe(true);
    expect(signals.lastEvent).toBe('interruption');
  });

  it('counts an interruption even when the record is stamped meta', () => {
    // Claude Code versions differ on the isMeta stamp — text wins.
    const signals = extractRetrospectiveSignals([
      user('go'),
      user('[Request interrupted by user]', { isMeta: true }),
    ]);
    expect(signals.interruptionCount).toBe(1);
    expect(signals.lastEvent).toBe('interruption');
  });

  it('counts compaction boundaries', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      { type: 'system', subtype: 'compact_boundary' },
      assistant('ok'),
      { type: 'system', subtype: 'compact_boundary' },
    ]);
    expect(signals.compactionCount).toBe(2);
  });

  it('detects plan mode from a mode record and from a per-record stamp', () => {
    const viaRecord = extractRetrospectiveSignals([
      { type: 'permission-mode', permissionMode: 'plan' },
      user('go'),
    ]);
    expect(viaRecord.planModeUsed).toBe(true);

    const viaStamp = extractRetrospectiveSignals([
      { type: 'assistant', permissionMode: 'plan', message: { role: 'assistant', content: [] } },
    ]);
    expect(viaStamp.planModeUsed).toBe(true);

    const without = extractRetrospectiveSignals([user('go'), assistant('ok')]);
    expect(without.planModeUsed).toBe(false);
  });

  it('counts assistant records flagged as API errors', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      assistant('overloaded', { isApiErrorMessage: true }),
    ]);
    expect(signals.apiErrorCount).toBe(1);
  });

  it('reads a normal ending as an assistant response, skipping trailing metadata', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      assistant('all done'),
      { type: 'ai-title', aiTitle: 'A tidy title' },
      { type: 'file-history-snapshot' },
    ]);
    expect(signals.lastEvent).toBe('assistant-response');
  });

  it('reads an unanswered final prompt as the session ending on a user request', () => {
    const signals = extractRetrospectiveSignals([user('go'), assistant('ok'), user('and now this?')]);
    expect(signals.lastEvent).toBe('user-request');
  });

  it('walks past trailing slash-command bookkeeping to the real ending', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      assistant('all done'),
      user('<command-name>/clear</command-name> <command-message>clear</command-message>'),
    ]);
    expect(signals.lastEvent).toBe('assistant-response');
  });

  it('classifies a trailing tool-result delivery as such, not as a prompt', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      assistant('running'),
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] },
      },
    ]);
    expect(signals.lastEvent).toBe('tool-result');
  });

  it('never lets side-chain records contribute', () => {
    const signals = extractRetrospectiveSignals([
      user('go'),
      assistant('done'),
      user('[Request interrupted by user]', { isSidechain: true }),
      assistant('sub-agent tail', { isSidechain: true }),
    ]);
    expect(signals.interruptionCount).toBe(0);
    expect(signals.lastEvent).toBe('assistant-response');
  });

  it('yields zeroed signals with an unknown ending for an empty transcript', () => {
    expect(extractRetrospectiveSignals([])).toEqual({
      interruptionCount: 0,
      endedWithInterruption: false,
      compactionCount: 0,
      planModeUsed: false,
      apiErrorCount: 0,
      lastEvent: 'unknown',
    });
  });

  it('ignores malformed records without throwing', () => {
    const signals = extractRetrospectiveSignals([
      { type: 'user' },
      { type: 'assistant' },
      { type: 'mystery-record' },
    ]);
    expect(signals.lastEvent).toBe('unknown');
    expect(signals.interruptionCount).toBe(0);
  });
});
