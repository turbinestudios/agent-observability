import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RetrospectiveLlmVerdict, SessionOutcome } from '@agent-observability/core/src/analysis/retrospective';
import type { DeepRetroVerdict } from '../shared/rpc';
import { sessionKey } from '../shared/rpc';

/**
 * Stored deep-retrospective verdicts — what the user's own `claude` CLI wrote
 * about a session, keyed like renames.
 *
 * A JSON store beside `renames.json` rather than columns in `index.db` because
 * the index is a disposable cache and these verdicts are EXPENSIVE user data:
 * each one cost a model call the user explicitly confirmed, and losing them to
 * a schema bump would silently re-charge that cost.
 *
 * LOCAL-ONLY: verdict text is model output about raw session content — the
 * same privacy class as the transcript itself. It lives in this file on this
 * machine and never touches the aggregate/sync path.
 */

const MAX_STORED = 100;

type VerdictMap = Record<string, DeepRetroVerdict>;

export class DeepRetroStore {
  private verdicts: VerdictMap;

  constructor(private readonly file: string = resolveDeepRetrosPath()) {
    this.verdicts = read(this.file);
  }

  get(source: string, sessionId: string): DeepRetroVerdict | undefined {
    return this.verdicts[sessionKey(source, sessionId)];
  }

  /** Store a verdict, pruning the oldest entries beyond the cap. */
  set(source: string, sessionId: string, verdict: DeepRetroVerdict): void {
    const next: VerdictMap = { ...this.verdicts, [sessionKey(source, sessionId)]: verdict };
    const keys = Object.keys(next);
    if (keys.length > MAX_STORED) {
      keys
        .sort((a, b) => (next[a].generatedAtMs ?? 0) - (next[b].generatedAtMs ?? 0))
        .slice(0, keys.length - MAX_STORED)
        .forEach((key) => delete next[key]);
    }
    this.verdicts = next;
    write(this.file, next);
  }
}

/**
 * Narrow a stored verdict back to core's shape: the JSON round-trip widens
 * `outcome` to a plain string, and an unrecognized label must read as absent
 * rather than flow into the renderer as a fake outcome.
 */
export function toLlmVerdict(stored: DeepRetroVerdict): RetrospectiveLlmVerdict {
  const outcomes: readonly SessionOutcome[] = ['likely-fulfilled', 'partially', 'unclear', 'likely-unfulfilled'];
  const { outcome, ...rest } = stored;
  return {
    ...rest,
    ...(typeof outcome === 'string' && (outcomes as readonly string[]).includes(outcome)
      ? { outcome: outcome as SessionOutcome }
      : {}),
  };
}

export function resolveDeepRetrosPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'deep-retros.json');
}

function read(file: string): VerdictMap {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Keep only entries with the minimal valid shape, so a truncated or
    // hand-edited file degrades to "no verdict" rather than a broken card.
    const clean: VerdictMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as DeepRetroVerdict).model === 'string' &&
        typeof (value as DeepRetroVerdict).generatedAtMs === 'number'
      ) {
        clean[key] = value as DeepRetroVerdict;
      }
    }
    return clean;
  } catch {
    return {}; // absent on first run, or unreadable
  }
}

function write(file: string, verdicts: VerdictMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(verdicts, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
