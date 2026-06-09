import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Database } from 'node-sqlite3-wasm';
import { parseChatSessionIndex, readChatSessionIndexTitles } from './chatSessionIndex';

/**
 * The auto-generated chat-session titles live in each workspace's `state.vscdb`
 * under `ItemTable['chat.ChatSessionStore.index']` — NOT the per-session JSONL.
 * These tests pin the index JSON shape (bare + source-prefixed keys) and the
 * per-workspace `state.vscdb` scan, including its resilience to junk DBs.
 */

/** Build the index JSON value for a set of `key → title` entries. */
function indexJson(entries: Record<string, string | null>): string {
  const built: Record<string, unknown> = {};
  for (const [key, title] of Object.entries(entries)) {
    built[key] = { sessionId: key, title, lastMessageDate: 1, isEmpty: false };
  }
  return JSON.stringify({ version: 1, entries: built });
}

describe('parseChatSessionIndex', () => {
  it('maps a bare-UUID Copilot entry to its title (lower-cased id)', () => {
    const json = indexJson({ 'AAAAAAAA-1111-2222-3333-444444444444': 'Fix the upload bug' });
    const map = parseChatSessionIndex(json);
    expect(map.get('aaaaaaaa-1111-2222-3333-444444444444')).toBe('Fix the upload bug');
  });

  it('extracts the UUID from a source-prefixed key', () => {
    const json = indexJson({
      'claude-code:/bbbbbbbb-1111-2222-3333-444444444444': 'Refactor auth',
      'copilotcli:/cccccccc-1111-2222-3333-444444444444': 'Why does dev fail?',
    });
    const map = parseChatSessionIndex(json);
    expect(map.get('bbbbbbbb-1111-2222-3333-444444444444')).toBe('Refactor auth');
    expect(map.get('cccccccc-1111-2222-3333-444444444444')).toBe('Why does dev fail?');
  });

  it('trims titles and skips null / blank / non-UUID entries', () => {
    const json = indexJson({
      'dddddddd-1111-2222-3333-444444444444': '  Spaced title  ',
      'eeeeeeee-1111-2222-3333-444444444444': null,
      'ffffffff-1111-2222-3333-444444444444': '   ',
      'not-a-uuid-key': 'orphan title',
    });
    const map = parseChatSessionIndex(json);
    expect(map.get('dddddddd-1111-2222-3333-444444444444')).toBe('Spaced title');
    expect(map.has('eeeeeeee-1111-2222-3333-444444444444')).toBe(false);
    expect(map.has('ffffffff-1111-2222-3333-444444444444')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('skips unstarted (isEmpty) sessions so the placeholder title is not surfaced', () => {
    const json = JSON.stringify({
      version: 1,
      entries: {
        'aaaaaaaa-1111-2222-3333-444444444444': {
          title: 'New Chat',
          isEmpty: true,
        },
        'bbbbbbbb-1111-2222-3333-444444444444': {
          title: 'Real running session',
          isEmpty: false,
        },
      },
    });
    const map = parseChatSessionIndex(json);
    expect(map.has('aaaaaaaa-1111-2222-3333-444444444444')).toBe(false);
    expect(map.get('bbbbbbbb-1111-2222-3333-444444444444')).toBe('Real running session');
  });

  it('returns an empty map for malformed JSON or a missing entries object', () => {
    expect(parseChatSessionIndex('not json').size).toBe(0);
    expect(parseChatSessionIndex('{"version":1}').size).toBe(0);
    expect(parseChatSessionIndex('null').size).toBe(0);
  });
});

describe('readChatSessionIndexTitles', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Build a `workspaceStorage` tree. For each hash: optionally a `state.vscdb`
   * holding the given index JSON, and (by default) an empty `chatSessions/` dir
   * — the gate `readChatSessionIndexTitles` requires before reading a DB.
   */
  function makeWorkspaceStorage(
    layout: Record<string, { index?: string; chatSessions?: boolean }>,
  ): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-index-'));
    tempDirs.push(root);
    for (const [hash, spec] of Object.entries(layout)) {
      const wsDir = path.join(root, hash);
      fs.mkdirSync(wsDir, { recursive: true });
      if (spec.chatSessions !== false) {
        fs.mkdirSync(path.join(wsDir, 'chatSessions'), { recursive: true });
      }
      if (spec.index !== undefined) {
        writeStateDb(path.join(wsDir, 'state.vscdb'), spec.index);
      }
    }
    return root;
  }

  /** Write a minimal `state.vscdb` with the chat-session index row. */
  function writeStateDb(dbPath: string, indexValue: string): void {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [
      'chat.ChatSessionStore.index',
      indexValue,
    ]);
    db.close();
  }

  it('reads and merges titles across workspaces', () => {
    const root = makeWorkspaceStorage({
      hashA: {
        index: indexJson({
          'aaaaaaaa-1111-2222-3333-444444444444': 'Add Playwright tests',
        }),
      },
      hashB: {
        index: indexJson({
          'cccccccc-1111-2222-3333-444444444444': 'Refactor auth',
        }),
      },
    });

    const titles = readChatSessionIndexTitles(root);
    expect(titles.get('aaaaaaaa-1111-2222-3333-444444444444')).toBe('Add Playwright tests');
    expect(titles.get('cccccccc-1111-2222-3333-444444444444')).toBe('Refactor auth');
  });

  it('skips a workspace that has no chatSessions directory', () => {
    const root = makeWorkspaceStorage({
      noChat: {
        chatSessions: false,
        index: indexJson({ 'aaaaaaaa-1111-2222-3333-444444444444': 'Should be ignored' }),
      },
    });
    expect(readChatSessionIndexTitles(root).size).toBe(0);
  });

  it('skips a workspace whose state.vscdb is absent or not a real DB', () => {
    const root = makeWorkspaceStorage({
      noDb: { /* chatSessions only, no state.vscdb */ },
      junkDb: { chatSessions: true },
    });
    // Replace junkDb's (absent) DB with a non-SQLite file.
    fs.writeFileSync(path.join(root, 'junkDb', 'state.vscdb'), 'not a sqlite file', 'utf8');
    expect(readChatSessionIndexTitles(root).size).toBe(0);
  });

  it('returns an empty map for a missing directory', () => {
    expect(readChatSessionIndexTitles(path.join(os.tmpdir(), 'definitely-not-here-xyz')).size).toBe(0);
  });
});
