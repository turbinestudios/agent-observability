import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Runtime state of the team export — when the shard was last written, how
 * big it was, what went wrong. Separate from `config.json` because it is a
 * record of what happened, not of what the user chose; same tmp+rename JSON
 * store pattern as `renames.ts`.
 */
export interface TeamExportState {
  lastExportAtMs?: number;
  lastExportBytes?: number;
  lastExportError?: string;
  lastExportDeveloperId?: string;
}

export class TeamStateStore {
  private state: TeamExportState;

  constructor(private readonly file: string = resolveTeamStatePath()) {
    this.state = read(file);
  }

  get(): TeamExportState {
    return { ...this.state };
  }

  update(patch: TeamExportState): TeamExportState {
    this.state = { ...this.state, ...patch };
    for (const key of Object.keys(this.state) as (keyof TeamExportState)[]) {
      if (this.state[key] === undefined) {
        delete this.state[key];
      }
    }
    write(this.file, this.state);
    return this.get();
  }
}

export function resolveTeamStatePath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'team-state.json');
}

function read(file: string): TeamExportState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const raw = parsed as Record<string, unknown>;
    const state: TeamExportState = {};
    if (typeof raw.lastExportAtMs === 'number') {
      state.lastExportAtMs = raw.lastExportAtMs;
    }
    if (typeof raw.lastExportBytes === 'number') {
      state.lastExportBytes = raw.lastExportBytes;
    }
    if (typeof raw.lastExportError === 'string') {
      state.lastExportError = raw.lastExportError;
    }
    if (typeof raw.lastExportDeveloperId === 'string') {
      state.lastExportDeveloperId = raw.lastExportDeveloperId;
    }
    return state;
  } catch {
    return {};
  }
}

function write(file: string, state: TeamExportState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
