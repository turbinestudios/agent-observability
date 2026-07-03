import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Database } from 'node-sqlite3-wasm';
import { titleStorageDirs, overlayTitle, readMergedSessionTitles } from './titleStore';
import { SessionTitleInfo } from './sessionTitles';

/**
 * Shared title resolution over one or more workspaceStorage directories — the
 * seam that lets BOTH the read layer (archive/ingest sources have no sibling
 * title store) and the archive sweep locate and merge titles from the native
 * stores. Precedence pinned here: index > customTitle > derived fallback.
 */

const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-store-'));
  tempDirs.push(dir);
  return dir;
}

/** Write a minimal `state.vscdb` with the chat-session index row. */
function writeStateDb(wsDir: string, entries: Record<string, string>): void {
  const built: Record<string, unknown> = {};
  for (const [key, title] of Object.entries(entries)) {
    built[key] = { sessionId: key, title, lastMessageDate: 1, isEmpty: false };
  }
  fs.mkdirSync(wsDir, { recursive: true });
  const db = new Database(path.join(wsDir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [
    'chat.ChatSessionStore.index',
    JSON.stringify({ version: 1, entries: built }),
  ]);
  db.close();
}

/** Write a `chatSessions/<id>.jsonl` snapshot with a customTitle and/or first request. */
function writeChatSessionJsonl(
  wsDir: string,
  id: string,
  customTitle: string | null,
  firstRequest?: string,
): void {
  const chatDir = path.join(wsDir, 'chatSessions');
  fs.mkdirSync(chatDir, { recursive: true });
  const requests = firstRequest !== undefined ? [{ message: { text: firstRequest } }] : [];
  const snapshot = JSON.stringify({ kind: 0, v: { customTitle, requests } });
  fs.writeFileSync(path.join(chatDir, `${id}.jsonl`), `${snapshot}\n`, 'utf8');
}

describe('titleStorageDirs', () => {
  it('maps native copilot DB paths to their sibling workspaceStorage, deduplicated', () => {
    const user = path.join('C:', 'u', 'AppData', 'Roaming', 'Code', 'User');
    const native = path.join(user, 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
    expect(titleStorageDirs([native, native])).toEqual([path.join(user, 'workspaceStorage')]);
  });

  it('contributes nothing for archive / ingest / fixture paths', () => {
    const archive = path.join('C:', 'u', '.agent-observability', 'copilot', 'agent-traces.db');
    const fixture = path.join('C:', 'tmp', 'fixture.db');
    expect(titleStorageDirs([archive, fixture])).toEqual([]);
  });
});

describe('overlayTitle', () => {
  it('never downgrades a non-derived title to a derived one', () => {
    const titles = new Map<string, SessionTitleInfo>([
      [ID_A, { title: 'Authoritative', derived: false }],
    ]);
    overlayTitle(titles, ID_A, { title: 'first message…', derived: true });
    expect(titles.get(ID_A)).toEqual({ title: 'Authoritative', derived: false });
  });

  it('lets a later layer win on equal derivedness and upgrade derived titles', () => {
    const titles = new Map<string, SessionTitleInfo>([
      [ID_A, { title: 'Old name', derived: false }],
      [ID_B, { title: 'first message…', derived: true }],
    ]);
    overlayTitle(titles, ID_A, { title: 'Renamed', derived: false });
    overlayTitle(titles, ID_B, { title: 'Real name', derived: false });
    expect(titles.get(ID_A)).toEqual({ title: 'Renamed', derived: false });
    expect(titles.get(ID_B)).toEqual({ title: 'Real name', derived: false });
  });
});

describe('readMergedSessionTitles', () => {
  it('prefers the state.vscdb index title over the JSONL fallback for the same id', () => {
    const dir = makeTempDir();
    const ws = path.join(dir, 'hashA');
    writeStateDb(ws, { [ID_A]: 'Index title' });
    writeChatSessionJsonl(ws, ID_A, null, 'derived from first message');

    const titles = readMergedSessionTitles([dir]);
    expect(titles.get(ID_A)).toEqual({ title: 'Index title', derived: false });
  });

  it('merges titles across multiple workspaceStorage directories', () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeStateDb(path.join(dirA, 'hashA'), { [ID_A]: 'From stable' });
    writeChatSessionJsonl(path.join(dirB, 'hashB'), ID_B, 'From insiders');

    const titles = readMergedSessionTitles([dirA, dirB]);
    expect(titles.get(ID_A)).toEqual({ title: 'From stable', derived: false });
    expect(titles.get(ID_B)).toEqual({ title: 'From insiders', derived: false });
  });

  it('keeps the derived first-request fallback when no real title exists anywhere', () => {
    const dir = makeTempDir();
    writeChatSessionJsonl(path.join(dir, 'hashA'), ID_A, null, 'fix the login bug please');

    const titles = readMergedSessionTitles([dir]);
    expect(titles.get(ID_A)).toEqual({ title: 'fix the login bug please', derived: true });
  });

  it('returns an empty map for missing directories', () => {
    expect(readMergedSessionTitles([path.join(os.tmpdir(), 'definitely-not-here-xyz')]).size).toBe(0);
  });
});
