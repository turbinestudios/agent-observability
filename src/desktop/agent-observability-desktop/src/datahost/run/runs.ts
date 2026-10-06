import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunDoor } from '../../shared/runTypes';
import type { RunRecord } from './runController';

/**
 * Which sessions were started from this app, so the Sessions list can say
 * "Started here" and the Run view can offer them for resuming.
 *
 * Ids, working directories and timestamps only — never a goal, a prompt or
 * any transcript text. The session itself lives where every Copilot CLI
 * session lives, under `~/.copilot`; this file only remembers that the app
 * began it. Same tmp-then-rename JSON store as `renames.ts`, so it survives
 * index rebuilds.
 */

export const MAX_RUN_RECORDS = 500;

const DOORS: ReadonlySet<string> = new Set<RunDoor>([
  'blank',
  'continue-session',
  'repo-digest',
  'improve-plan',
  'retro-advice',
  'handoff-brief',
]);

export class RunStore {
  private records: RunRecord[];

  constructor(private readonly file: string = resolveRunsPath()) {
    this.records = read(file);
  }

  list(): RunRecord[] {
    return [...this.records];
  }

  has(sessionId: string): boolean {
    return this.records.some((record) => record.sessionId === sessionId);
  }

  get(sessionId: string): RunRecord | undefined {
    return this.records.find((record) => record.sessionId === sessionId);
  }

  /** Newest first; a repeated id replaces its earlier record; the oldest fall off the end. */
  add(record: RunRecord): void {
    this.records = [record, ...this.records.filter((r) => r.sessionId !== record.sessionId)].slice(0, MAX_RUN_RECORDS);
    write(this.file, this.records);
  }
}

export function resolveRunsPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'runs.json');
}

function read(file: string): RunRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const records: RunRecord[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.sessionId === 'string' &&
      typeof raw.cwd === 'string' &&
      typeof raw.repository === 'string' &&
      typeof raw.startedAtMs === 'number' &&
      typeof raw.door === 'string' &&
      DOORS.has(raw.door)
    ) {
      records.push({
        sessionId: raw.sessionId,
        cwd: raw.cwd,
        repository: raw.repository,
        startedAtMs: raw.startedAtMs,
        door: raw.door as RunDoor,
      });
    }
  }
  return records.slice(0, MAX_RUN_RECORDS);
}

function write(file: string, records: RunRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
