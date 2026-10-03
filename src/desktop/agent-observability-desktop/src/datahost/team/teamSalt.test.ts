import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEVELOPER_ID_PATTERN } from '@agent-observability/core/src/aggregate/pseudonymizer';
import { getOrCreateTeamSalt, getTeamDeveloperId } from './teamSalt';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-salt-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getOrCreateTeamSalt', () => {
  it('mints a 64-hex salt once and returns the same one afterwards', () => {
    const file = path.join(dir, 'nested', 'team-salt');
    const first = getOrCreateTeamSalt(file);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(getOrCreateTeamSalt(file)).toBe(first);
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('replaces a corrupt salt file rather than hashing with garbage', () => {
    const file = path.join(dir, 'team-salt');
    fs.writeFileSync(file, 'not-a-salt');
    expect(getOrCreateTeamSalt(file)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the file owner-only where the platform honours modes', () => {
    const file = path.join(dir, 'team-salt');
    getOrCreateTeamSalt(file);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('derives a developer id in the shared pattern, different per salt', () => {
    const a = getTeamDeveloperId(getOrCreateTeamSalt(path.join(dir, 'a')));
    const b = getTeamDeveloperId(getOrCreateTeamSalt(path.join(dir, 'b')));
    expect(a).toMatch(DEVELOPER_ID_PATTERN);
    expect(b).toMatch(DEVELOPER_ID_PATTERN);
    expect(a).not.toBe(b);
  });
});
