/**
 * Incremental parser for the Copilot CLI's `--output-format json --stream on`
 * output: newline-delimited JSON, one event per line. The mirror of
 * `claudeStreamParser.ts` for the other vendor's vocabulary (probed against
 * CLI v1.0.82; see `copilotCliArgs.ts` for the probe notes).
 *
 * Chunk-boundary tolerant, and silently skips unparseable or unrecognized
 * lines — the CLI's event vocabulary grows over time and an unknown event must
 * not abort a stream.
 */

/** A recognized event from the CLI stream, reduced to what the backend needs. */
export type CopilotEvent =
  | { kind: 'text'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'result'; exitCode: number };

/** Structural view of one parsed NDJSON line (fields probed defensively). */
interface RawLine {
  type?: unknown;
  exitCode?: unknown;
  data?: { deltaContent?: unknown; content?: unknown };
}

export class CopilotStreamParser {
  private buffer = '';

  /** Feed a stdout chunk; returns the events completed by this chunk. */
  push(chunk: string): CopilotEvent[] {
    this.buffer += chunk;
    const events: CopilotEvent[] = [];
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
  flush(): CopilotEvent[] {
    const line = this.buffer;
    this.buffer = '';
    const event = parseLine(line);
    return event ? [event] : [];
  }
}

/** Map one NDJSON line to a {@link CopilotEvent}, or `undefined` to skip it. */
function parseLine(line: string): CopilotEvent | undefined {
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

  if (raw.type === 'assistant.message_delta' && typeof raw.data?.deltaContent === 'string') {
    return { kind: 'text', text: raw.data.deltaContent };
  }
  // The complete answer — the fallback when a stream carried no deltas.
  if (raw.type === 'assistant.message' && typeof raw.data?.content === 'string') {
    return { kind: 'message', text: raw.data.content };
  }
  if (raw.type === 'result') {
    return { kind: 'result', exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : 0 };
  }

  return undefined;
}
