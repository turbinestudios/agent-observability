import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveArchiveDbPath, ArchiveEnv, ArchivePathConfig } from './archivePaths';

const cfg = (override?: string): ArchivePathConfig => ({
  getCopilotArchivePathOverride: () => override,
});

const env = (home: string, vars: Record<string, string | undefined> = {}): ArchiveEnv => ({
  homedir: () => home,
  env: vars,
});

describe('resolveArchiveDbPath', () => {
  it('prefers an explicit override, normalized', () => {
    const p = resolveArchiveDbPath(cfg('/custom/archive.db'), env('/home/me'));
    expect(p).toBe(path.normalize('/custom/archive.db'));
  });

  it('uses AGENT_OBSERVABILITY_HOME when set and no override', () => {
    const p = resolveArchiveDbPath(cfg(), env('/home/me', { AGENT_OBSERVABILITY_HOME: '/data/ao' }));
    expect(p).toBe(path.join('/data/ao', 'copilot', 'agent-traces.db'));
  });

  it('falls back to ~/.agent-observability/copilot/agent-traces.db', () => {
    const p = resolveArchiveDbPath(cfg(), env('/home/me'));
    expect(p).toBe(path.join('/home/me', '.agent-observability', 'copilot', 'agent-traces.db'));
  });

  it('override wins over the env var', () => {
    const p = resolveArchiveDbPath(cfg('/x/y.db'), env('/home/me', { AGENT_OBSERVABILITY_HOME: '/data/ao' }));
    expect(p).toBe(path.normalize('/x/y.db'));
  });

  it('returns undefined when there is no override and no home', () => {
    expect(resolveArchiveDbPath(cfg(), env(''))).toBeUndefined();
  });
});
