import { describe, it, expect } from 'vitest';
import { ClaudeStreamParser } from './claudeStreamParser';

const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' });
const textLine = (text: string): string =>
  JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } });
const thinkingLine = JSON.stringify({
  type: 'stream_event',
  event: { delta: { type: 'thinking_delta', thinking: 'hmm' } },
});
const okResultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final text' });

describe('ClaudeStreamParser', () => {
  it('maps init, text, and result lines', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(`${initLine}\n${textLine('Hello')}\n${okResultLine}\n`);
    expect(events).toEqual([
      { kind: 'init', model: 'claude-sonnet-5', sessionId: 's1' },
      { kind: 'text', text: 'Hello' },
      { kind: 'result', isError: false, resultText: 'final text', errorMessage: undefined },
    ]);
  });

  it('buffers a line split across multiple chunks', () => {
    const parser = new ClaudeStreamParser();
    const line = textLine('split across chunks');
    expect(parser.push(line.slice(0, 10))).toEqual([]);
    expect(parser.push(line.slice(10, 25))).toEqual([]);
    expect(parser.push(`${line.slice(25)}\n`)).toEqual([{ kind: 'text', text: 'split across chunks' }]);
  });

  it('handles several lines arriving in one chunk', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(`${textLine('a')}\n${textLine('b')}\n`);
    expect(events.map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['a', 'b']);
  });

  it('ignores thinking deltas and unknown event types', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(`${thinkingLine}\n${JSON.stringify({ type: 'assistant' })}\n`);
    expect(events).toEqual([]);
  });

  it('skips malformed lines without aborting the stream', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(`not json at all\n${textLine('still works')}\n`);
    expect(events).toEqual([{ kind: 'text', text: 'still works' }]);
  });

  it('flushes an unterminated final line', () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(okResultLine)).toEqual([]);
    expect(parser.flush()).toEqual([
      { kind: 'result', isError: false, resultText: 'final text', errorMessage: undefined },
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it('marks error results via is_error or a non-success subtype', () => {
    const parser = new ClaudeStreamParser();
    const viaFlag = parser.push(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'boom' })}\n`,
    );
    expect(viaFlag[0]).toEqual({ kind: 'result', isError: true, resultText: 'boom', errorMessage: 'boom' });

    const viaSubtype = parser.push(
      `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', error: 'usage limit reached' })}\n`,
    );
    expect(viaSubtype[0]).toEqual({
      kind: 'result',
      isError: true,
      resultText: '',
      errorMessage: 'usage limit reached',
    });
  });
});
