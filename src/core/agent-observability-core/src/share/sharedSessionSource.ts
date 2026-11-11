import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AggregationRow } from '../aggregate/aggregator';
import type { SessionDataSource } from '../sources/sessionSource';
import type {
  AgentSourceId,
  CostMode,
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
} from '../telemetry/models';
import type { Result } from '../telemetry/telemetryService';
import { SHARED_SESSION_MAX_BYTES, SHARED_SOURCE_ID, type SharedSessionEnvelope } from './sharedSessionModels';
import { SHARED_SESSION_ID_PATTERN, importedDetail, parseSharedSession, sharedSessionId } from './sharedSession';

/** One imported session as read from the app's own copy. */
export interface StoredSharedSession {
  id: string;
  file: string;
  size: number;
  mtimeMs: number;
  envelope: SharedSessionEnvelope;
}

/**
 * Sessions other people shared, served from the copies the import step
 * wrote into this app's own folder (`<dir>/<id>.json`, one file each).
 *
 * Every read re-validates the file: the folder is the app's, but a file in
 * it is still someone else's content, and a hand-edited copy must fail as
 * an unreadable session rather than reach a renderer.
 *
 * Nothing here contributes to this user's own figures: the overview and the
 * aggregation rows are empty by construction, and the data host keeps the
 * indexed rows out of every aggregate query. The context analysis is not
 * offered (its paths are the sender's), and the retrospective falls back to
 * the shared turn analysis of the detail.
 */
export class SharedSessionSource implements SessionDataSource {
  readonly id: AgentSourceId = SHARED_SOURCE_ID;
  readonly label = 'Shared';
  /** Only a fallback; {@link costModeOf} answers per session. */
  readonly costMode: CostMode = 'usd';
  readonly iconId = 'cloud-download';

  private readonly cache = new Map<string, StoredSharedSession>();

  constructor(private readonly dir: string) {}

  isEnabled(): boolean {
    return true;
  }

  /** The folder imported sessions are kept in. */
  directory(): string {
    return this.dir;
  }

  /** The file an id is stored in, or `undefined` for an id that could not be one of ours. */
  fileFor(id: string): string | undefined {
    return SHARED_SESSION_ID_PATTERN.test(id) ? path.join(this.dir, `${id}.json`) : undefined;
  }

  /**
   * Every readable stored session. A file that no longer validates, or whose
   * name does not match its content, is skipped and named in `problems`.
   */
  sessions(): { sessions: StoredSharedSession[]; problems: string[] } {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      this.cache.clear();
      return { sessions: [], problems: [] };
    }
    const sessions: StoredSharedSession[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const id = name.slice(0, -'.json'.length);
      if (!SHARED_SESSION_ID_PATTERN.test(id)) {
        continue;
      }
      seen.add(id);
      const stored = this.read(id);
      if (stored.ok) {
        sessions.push(stored.value);
      } else {
        problems.push(`${name}: ${stored.message}`);
      }
    }
    for (const id of [...this.cache.keys()]) {
      if (!seen.has(id)) {
        this.cache.delete(id);
      }
    }
    return { sessions, problems };
  }

  costModeOf(sessionKey: string): CostMode | undefined {
    const stored = this.read(sessionKey);
    return stored.ok ? stored.value.envelope.origin.costMode : undefined;
  }

  /** Where an imported session came from, for its detail header. */
  originDetails(sessionKey: string): { source: string; exportedAtMs: number; toolVersion: string } | undefined {
    const stored = this.read(sessionKey);
    if (!stored.ok) {
      return undefined;
    }
    const { origin, exportedAtMs, toolVersion } = stored.value.envelope;
    return { source: origin.source, exportedAtMs, toolVersion };
  }

  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    const stored = this.read(sessionKey);
    return stored.ok ? { ok: true, value: importedDetail(stored.value.envelope, stored.value.id) } : stored;
  }

  getSessionInteractions(): Result<Interaction[]> {
    // The file holds turns, not spans; deviation detection has nothing to read.
    return { ok: true, value: [] };
  }

  getOverview(): Result<OverviewMetrics> {
    return {
      ok: true,
      value: {
        totalInteractions: 0,
        totalSessions: 0,
        totalRepositories: 0,
        totalModels: 0,
        avgDurationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        errorCount: 0,
      },
    };
  }

  listRepositories(): Result<RepositorySummary[]> {
    return { ok: true, value: [] };
  }

  listSessions(): Result<SessionSummary[]> {
    return {
      ok: true,
      value: this.sessions().sessions.map((s) => importedDetail(s.envelope, s.id).summary),
    };
  }

  getAggregationRows(): Result<AggregationRow[]> {
    return { ok: true, value: [] };
  }

  refresh(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.cache.clear();
  }

  private read(id: string): Result<StoredSharedSession> {
    const file = this.fileFor(id);
    if (file === undefined) {
      return { ok: false, reason: 'missingDb', message: 'No shared session has this id.' };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.cache.delete(id);
      return { ok: false, reason: 'missingDb', message: 'This shared session has been removed.' };
    }
    const cached = this.cache.get(id);
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { ok: true, value: cached };
    }
    if (stat.size > SHARED_SESSION_MAX_BYTES) {
      return { ok: false, reason: 'error', message: 'The stored file is larger than a shared session may be.' };
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    const parsed = parseSharedSession(text);
    if (!parsed.ok) {
      return { ok: false, reason: 'error', message: parsed.problems[0] ?? 'The stored file is not valid.' };
    }
    if (sharedSessionId(parsed.envelope) !== id) {
      return { ok: false, reason: 'error', message: 'The stored file does not match its name.' };
    }
    const stored: StoredSharedSession = { id, file, size: stat.size, mtimeMs: stat.mtimeMs, envelope: parsed.envelope };
    this.cache.set(id, stored);
    return { ok: true, value: stored };
  }
}
