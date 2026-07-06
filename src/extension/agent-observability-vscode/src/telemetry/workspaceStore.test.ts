import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  readWorkspaceStoreSessions,
  WorkspaceStoreIo,
} from './workspaceStore';

const HASH_DIR = path.join('/ws', 'hashA');
const CHAT_DIR = path.join(HASH_DIR, 'chatSessions');

const UUID_RECENT = 'aaaaaaaa-1111-2222-3333-444444444444';
const UUID_DERIVED = 'bbbbbbbb-1111-2222-3333-444444444444';
const UUID_OLD = 'cccccccc-1111-2222-3333-444444444444';
const UUID_EMPTY = 'dddddddd-1111-2222-3333-444444444444';

const NOW = 1_700_000_000_000;

/** A line-0 snapshot with a persisted customTitle. */
const withTitle = (title: string) =>
  JSON.stringify({ kind: 0, v: { customTitle: title, requests: [] } });

/** A line-0 snapshot with no title but a first request (derived title). */
const withRequest = (text: string) =>
  JSON.stringify({ kind: 0, v: { customTitle: null, requests: [{ message: { text } }] } });

/** A line-0 snapshot with neither a title nor a request (empty placeholder). */
const empty = () => JSON.stringify({ kind: 0, v: { customTitle: null, requests: [] } });

interface FileEntry {
  mtimeMs: number;
  content: string;
}

function makeIo(files: Record<string, FileEntry>): WorkspaceStoreIo {
  return {
    listChatSessionFiles: (dir) => (dir === CHAT_DIR ? Object.keys(files) : []),
    statMtimeMs: (p) => files[path.basename(p)]?.mtimeMs,
    readFile: (p) => files[path.basename(p)]?.content,
  };
}

describe('readWorkspaceStoreSessions', () => {
  it('collects EVERY UUID session id (recent or not) and ignores non-UUID files', () => {
    const io = makeIo({
      [`${UUID_RECENT}.jsonl`]: { mtimeMs: NOW - 10_000, content: withTitle('Recent chat') },
      [`${UUID_OLD}.jsonl`]: { mtimeMs: NOW - 10 * 60_000, content: withTitle('Old chat') },
      'not-a-uuid.jsonl': { mtimeMs: NOW, content: withTitle('junk') },
      'README.md': { mtimeMs: NOW, content: 'nope' },
    });

    const result = readWorkspaceStoreSessions(HASH_DIR, {
      io,
      nowMs: NOW,
      recencyMs: 60_000,
    });

    // The scoping set spans all UUID sessions in the workspace.
    expect([...result.sessionIds].sort()).toEqual([UUID_RECENT, UUID_OLD].sort());
    expect(result.sessionIds.has('not-a-uuid')).toBe(false);
  });

  it('synthesizes ONLY recent, titled sessions (newest first), skipping old + empty', () => {
    const io = makeIo({
      [`${UUID_RECENT}.jsonl`]: { mtimeMs: NOW - 5_000, content: withTitle('Fix the login flow') },
      [`${UUID_DERIVED}.jsonl`]: { mtimeMs: NOW - 20_000, content: withRequest('migrate the db') },
      [`${UUID_OLD}.jsonl`]: { mtimeMs: NOW - 10 * 60_000, content: withTitle('Ancient chat') },
      [`${UUID_EMPTY}.jsonl`]: { mtimeMs: NOW - 1_000, content: empty() },
    });

    const result = readWorkspaceStoreSessions(HASH_DIR, {
      io,
      nowMs: NOW,
      recencyMs: 60_000,
    });

    expect(result.recent.map((s) => s.sessionId)).toEqual([UUID_RECENT, UUID_DERIVED]);
    expect(result.recent[0]).toMatchObject({
      sessionId: UUID_RECENT,
      title: 'Fix the login flow',
      titleDerived: false,
      startedAtMs: NOW - 5_000,
    });
    expect(result.recent[1]).toMatchObject({
      sessionId: UUID_DERIVED,
      title: 'migrate the db',
      titleDerived: true,
    });
  });

  it('caps the synthesized set at maxRecent', () => {
    const files: Record<string, FileEntry> = {};
    for (let i = 0; i < 5; i += 1) {
      const id = `eeeeeeee-1111-2222-3333-00000000000${i}`;
      files[`${id}.jsonl`] = { mtimeMs: NOW - i * 1_000, content: withTitle(`chat ${i}`) };
    }
    const io = makeIo(files);

    const result = readWorkspaceStoreSessions(HASH_DIR, {
      io,
      nowMs: NOW,
      recencyMs: 60_000,
      maxRecent: 2,
    });

    expect(result.recent).toHaveLength(2);
    // All five ids are still in the (uncapped) scoping set.
    expect(result.sessionIds.size).toBe(5);
  });

  it('returns empty results when the chatSessions directory is absent', () => {
    const io: WorkspaceStoreIo = {
      listChatSessionFiles: () => [],
      statMtimeMs: () => undefined,
      readFile: () => undefined,
    };
    const result = readWorkspaceStoreSessions(HASH_DIR, { io, nowMs: NOW });
    expect(result.sessionIds.size).toBe(0);
    expect(result.recent).toHaveLength(0);
  });
});
