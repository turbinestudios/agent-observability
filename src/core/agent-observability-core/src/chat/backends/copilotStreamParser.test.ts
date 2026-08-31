import { describe, it, expect } from 'vitest';
import { CopilotStreamParser } from './copilotStreamParser';

/** Real event shapes captured from `copilot` CLI v1.0.82 with `--output-format json --stream on`. */
const DELTA = '{"type":"assistant.message_delta","data":{"messageId":"m1","deltaContent":"PO"},"ephemeral":true}';
const DELTA2 = '{"type":"assistant.message_delta","data":{"messageId":"m1","deltaContent":"NG"}}';
const MESSAGE = '{"type":"assistant.message","data":{"messageId":"m1","model":"x","content":"PONG","toolRequests":[]}}';
const RESULT = '{"type":"result","timestamp":"t","sessionId":"s","exitCode":0,"usage":{}}';

describe('CopilotStreamParser', () => {
  it('yields text deltas, the full message, and the result', () => {
    const parser = new CopilotStreamParser();
    const events = parser.push(`${DELTA}\n${DELTA2}\n${MESSAGE}\n${RESULT}\n`);
    expect(events).toEqual([
      { kind: 'text', text: 'PO' },
      { kind: 'text', text: 'NG' },
      { kind: 'message', text: 'PONG' },
      { kind: 'result', exitCode: 0 },
    ]);
  });

  it('buffers a line split across chunks until its newline arrives', () => {
    const parser = new CopilotStreamParser();
    const cut = 30;
    expect(parser.push(DELTA.slice(0, cut))).toEqual([]);
    expect(parser.push(`${DELTA.slice(cut)}\n`)).toEqual([{ kind: 'text', text: 'PO' }]);
  });

  it('flushes a final unterminated line at stream end', () => {
    const parser = new CopilotStreamParser();
    parser.push(RESULT);
    expect(parser.flush()).toEqual([{ kind: 'result', exitCode: 0 }]);
    // Flushing twice must not replay.
    expect(parser.flush()).toEqual([]);
  });

  it('skips unknown, malformed, and blank lines without aborting', () => {
    const parser = new CopilotStreamParser();
    const events = parser.push(
      '{"type":"session.usage_checkpoint"}\nnot json at all\n\n{"type":"assistant.message_delta","data":{"deltaContent":"x"}}\n',
    );
    expect(events).toEqual([{ kind: 'text', text: 'x' }]);
  });
});
