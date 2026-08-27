import { describe, it, expect } from 'vitest';
import { parseTranscriptText } from './parser';

describe('parseTranscriptText', () => {
  it('parses one record per non-blank line', () => {
    const text = '{"type":"user"}\n{"type":"assistant"}\n';
    const { records, skipped } = parseTranscriptText(text);
    expect(records.map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(skipped).toBe(0);
  });

  it('skips blank lines without counting them as skipped', () => {
    const text = '{"type":"user"}\n\n   \n{"type":"system"}\n';
    const { records, skipped } = parseTranscriptText(text);
    expect(records).toHaveLength(2);
    expect(skipped).toBe(0);
  });

  it('skips malformed / truncated lines and counts them', () => {
    const text = '{"type":"user"}\n{ this is not json\n{"type":"assistant"}';
    const { records, skipped } = parseTranscriptText(text);
    expect(records.map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(skipped).toBe(1);
  });

  it('includes a valid final line with no trailing newline', () => {
    const { records } = parseTranscriptText('{"type":"assistant"}');
    expect(records).toHaveLength(1);
  });

  it('tolerates CRLF line endings', () => {
    const { records } = parseTranscriptText('{"type":"user"}\r\n{"type":"assistant"}\r\n');
    expect(records.map((r) => r.type)).toEqual(['user', 'assistant']);
  });

  it('rejects lines that are valid JSON but not objects with a string type', () => {
    const text = '42\n["a"]\n{"noType":1}\n{"type":7}\n{"type":"ok"}';
    const { records, skipped } = parseTranscriptText(text);
    expect(records.map((r) => r.type)).toEqual(['ok']);
    expect(skipped).toBe(4);
  });
});
