import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexDb } from './indexDb';
import type { SessionRow } from '../../shared/rpc';

/**
 * `mainPath` is what "Resume in terminal" starts from: the session's own file
 * on disk, read back from the index and never handed to the renderer.
 */

let dir: string;
let db: IndexDb;

function row(sessionId: string, mainPath?: string): SessionRow & { mainPath?: string } {
  return {
    source: 'claude',
    sessionId,
    repository: 'github.com/acme/app',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    durationMs: 1_000,
    interactionCount: 1,
    llmCalls: 1,
    toolCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    model: 'm',
    agentModes: ['agent'],
    indexedAtMs: 5_000,
    ...(mainPath !== undefined ? { mainPath } : {}),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mainpath-'));
  db = new IndexDb(path.join(dir, 'index.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('IndexDb.mainPath', () => {
  it('returns the stored file for a session and undefined otherwise', () => {
    const file = path.join(dir, 'projects', 'p', 'a.jsonl');
    db.upsertSessions([row('a', file), row('b')]);
    expect(db.mainPath('claude', 'a')).toBe(file);
    expect(db.mainPath('claude', 'b')).toBeUndefined();
    expect(db.mainPath('claude', 'missing')).toBeUndefined();
    expect(db.mainPath('copilot', 'a')).toBeUndefined();
  });
});
