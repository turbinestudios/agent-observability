/**
 * Incremental parser for the Claude Code CLI's `--output-format stream-json`
 * output: newline-delimited JSON, one event per line.
 *
 * Pure (no `vscode`/`child_process`) and chunk-boundary tolerant — stdout
 * chunks split lines arbitrarily, so a trailing partial line is buffered until
 * its newline arrives (or `flush()` is called at process exit). Unparseable or
 * unrecognized lines are skipped silently: the CLI's event vocabulary grows
 * over time and unknown events must not abort a stream.
 */

/** A recognized event from the CLI stream, reduced to what the backend needs. */
export type ClaudeEvent =
  | { kind: 'init'; model?: string; sessionId?: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; isError: boolean; resultText: string; errorMessage?: string };

/** Structural view of one parsed NDJSON line (fields probed defensively). */
interface RawLine {
  type?: unknown;
  subtype?: unknown;
  model?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  error?: unknown;
  event?: { delta?: { type?: unknown; text?: unknown } };
}

export class ClaudeStreamParser {
  private buffer = '';

  /** Feed a stdout chunk; returns the events completed by this chunk. */
  push(chunk: string): ClaudeEvent[] {
    this.buffer += chunk;
    const events: ClaudeEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const event = parseLine(line);
      if (event) {
        events.push(event);
      }
      newline = this.buffer.indexOf('\n');
    }
    return events;
  }

  /** Parse any final unterminated line (call once, when the stream closes). */
  flush(): ClaudeEvent[] {
    const line = this.buffer;
    this.buffer = '';
    const event = parseLine(line);
    return event ? [event] : [];
  }
}

/** Map one NDJSON line to a {@link ClaudeEvent}, or `undefined` to skip it. */
function parseLine(line: string): ClaudeEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let raw: RawLine;
  try {
    raw = JSON.parse(trimmed) as RawLine;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  if (raw.type === 'system' && raw.subtype === 'init') {
    return {
      kind: 'init',
      model: typeof raw.model === 'string' ? raw.model : undefined,
      sessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    };
  }

  if (raw.type === 'stream_event') {
    const delta = raw.event?.delta;
    // Only visible text; thinking_delta and other delta types are not chat output.
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'text', text: delta.text };
    }
    return undefined;
  }

  if (raw.type === 'result') {
    const isError = raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype !== 'success');
    const resultText = typeof raw.result === 'string' ? raw.result : '';
    const errorMessage =
      typeof raw.error === 'string' && raw.error.length > 0
        ? raw.error
        : isError && resultText.length > 0
          ? resultText
          : undefined;
    return { kind: 'result', isError, resultText, errorMessage };
  }

  return undefined;
}
