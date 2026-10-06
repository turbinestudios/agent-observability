import * as fs from 'node:fs';

/**
 * Tolerant readers for a Copilot CLI session's `events.jsonl` and
 * `workspace.yaml`. Third-party, undocumented data: unknown event types are
 * kept as-is, a malformed or half-written line is skipped, nothing throws.
 */

export interface CliEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  /** ISO-8601. */
  timestamp?: string;
  parentId?: string | null;
}

export function parseCliEvents(text: string): { events: CliEvent[]; skipped: number } {
  const events: CliEvent[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      skipped += 1;
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string') {
      skipped += 1;
      continue;
    }
    const data = record.data;
    events.push({
      type: record.type,
      data: data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {},
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
    });
  }
  return { events, skipped };
}

export function eventTimeMs(event: CliEvent | undefined): number | undefined {
  if (event?.timestamp === undefined) {
    return undefined;
  }
  const ms = Date.parse(event.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

export const DEFAULT_CLI_TAIL_BYTES = 256 * 1024;

export interface CliEventsTail {
  events: CliEvent[];
  sizeBytes: number;
  mtimeMs: number;
  truncated: boolean;
}

/** The last `maxBytes` of an events file, parsed. `undefined` on any I/O error. */
export function readCliEventsTail(file: string, maxBytes: number = DEFAULT_CLI_TAIL_BYTES): CliEventsTail | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const offset = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) {
      // Drop the partial first line (and any split multibyte sequence with it).
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return { events: parseCliEvents(text).events, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, truncated: offset > 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * `workspace.yaml` is a flat list of `key: value` lines, so it needs no YAML
 * dependency. Values may be quoted and may contain colons (Windows paths,
 * timestamps): only the FIRST colon separates key from value.
 */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0 || line.trimStart().startsWith('#') || /^\s/.test(line)) {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
      }
    }
    if (key.length > 0 && value.length > 0 && value !== 'null' && value !== '~') {
      out[key] = value;
    }
  }
  return out;
}

export function readWorkspaceYaml(file: string): Record<string, string> {
  try {
    return parseWorkspaceYaml(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Which client wrote a session into the shared store. The GitHub Copilot app
 * runs the same runtime as the CLI and leaves the same files; only
 * `client_name` in `workspace.yaml` tells it apart (`github/autopilot`, seen
 * with app 1.1.24). Everything else (the CLI, the SDK, VS Code's wrapper) is
 * the CLI source.
 */
export type CliClient = 'cli' | 'app';

export const COPILOT_APP_CLIENT_NAME = 'github/autopilot';

export function cliClientOf(workspace: Readonly<Record<string, string>>): CliClient {
  return workspace.client_name === COPILOT_APP_CLIENT_NAME ? 'app' : 'cli';
}
