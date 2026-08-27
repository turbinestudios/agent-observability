import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseSessionTitle,
  readSessionTitles,
  workspaceStorageDirFor,
} from './sessionTitles';

/**
 * The Copilot chat-session store is the source of the human-readable session
 * names the Sessions tree shows. These tests pin the two real on-disk shapes
 * (a persisted `customTitle`, and an active session whose title isn't baked in
 * yet so we fall back to the first request) and the id-keyed directory scan.
 */

/** A finished-session JSONL: kind-0 snapshot carries `customTitle`. */
function finishedSession(sessionId: string, customTitle: string): string {
  return JSON.stringify({
    kind: 0,
    v: {
      version: 3,
      customTitle,
      sessionId,
      requests: [{ message: { text: 'first prompt that should be ignored' } }],
    },
  });
}

/** An active-session JSONL: empty snapshot, then a kind-2 request delta. */
function activeSession(sessionId: string, firstText: string): string {
  const snapshot = JSON.stringify({
    kind: 0,
    v: { version: 3, customTitle: null, sessionId, requests: [] },
  });
  const modelDelta = JSON.stringify({ kind: 1, v: { identifier: 'copilot/x', metadata: {} } });
  const requestDelta = JSON.stringify({
    kind: 2,
    v: [{ requestId: 'request_1', message: { text: firstText } }],
  });
  return [snapshot, modelDelta, requestDelta].join('\n');
}

describe('parseSessionTitle', () => {
  it('uses customTitle from the snapshot (non-derived)', () => {
    const info = parseSessionTitle(finishedSession('s1', 'Value length validation issue'));
    expect(info).toEqual({ title: 'Value length validation issue', derived: false });
  });

  it('prefers customTitle over the first request text', () => {
    const info = parseSessionTitle(finishedSession('s1', 'Real Title'));
    expect(info?.derived).toBe(false);
    expect(info?.title).toBe('Real Title');
  });

  it('falls back to the snapshot first-request text when customTitle is absent', () => {
    const content = JSON.stringify({
      kind: 0,
      v: { customTitle: null, sessionId: 's1', requests: [{ message: { text: 'Fix the bug' } }] },
    });
    expect(parseSessionTitle(content)).toEqual({ title: 'Fix the bug', derived: true });
  });

  it('falls back to a kind-2 request delta for an active session', () => {
    const info = parseSessionTitle(activeSession('s1', 'How do I add a migration?'));
    expect(info).toEqual({ title: 'How do I add a migration?', derived: true });
  });

  it('collapses whitespace and truncates long derived titles', () => {
    const long = 'a'.repeat(80);
    const info = parseSessionTitle(activeSession('s1', `  multi\n  line   ${long}`));
    expect(info?.derived).toBe(true);
    expect(info?.title.endsWith('…')).toBe(true);
    expect(info?.title.length).toBe(61); // 60 chars + ellipsis
    expect(info?.title).not.toContain('\n');
  });

  it('treats a blank customTitle as absent', () => {
    const content = JSON.stringify({
      kind: 0,
      v: { customTitle: '   ', sessionId: 's1', requests: [{ message: { text: 'Prompt' } }] },
    });
    expect(parseSessionTitle(content)).toEqual({ title: 'Prompt', derived: true });
  });

  it('returns undefined when there is no title and no request', () => {
    const content = JSON.stringify({ kind: 0, v: { sessionId: 's1', requests: [] } });
    expect(parseSessionTitle(content)).toBeUndefined();
  });

  it('returns undefined for malformed content', () => {
    expect(parseSessionTitle('not json')).toBeUndefined();
    expect(parseSessionTitle('')).toBeUndefined();
  });
});

describe('workspaceStorageDirFor', () => {
  it('derives the workspaceStorage sibling of a standard agent-traces.db path', () => {
    const db = path.join(
      'C:',
      'Users',
      'me',
      'AppData',
      'Roaming',
      'Code',
      'User',
      'globalStorage',
      'github.copilot-chat',
      'agent-traces.db',
    );
    const dir = workspaceStorageDirFor(db);
    expect(dir).toBe(
      path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    );
  });

  it('returns undefined for a non-standard (override/fixture) path', () => {
    expect(workspaceStorageDirFor(path.join('tmp', 'fixtures', 'sample-agent-traces.db'))).toBeUndefined();
  });
});

describe('readSessionTitles', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Build a workspaceStorage tree and return its path. */
  function makeWorkspaceStorage(
    layout: Record<string, Record<string, string>>,
  ): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-storage-'));
    tempDirs.push(root);
    for (const [hash, files] of Object.entries(layout)) {
      const chatDir = path.join(root, hash, 'chatSessions');
      fs.mkdirSync(chatDir, { recursive: true });
      for (const [fileName, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(chatDir, fileName), content, 'utf8');
      }
    }
    return root;
  }

  it('maps session ids (the filenames) to titles across workspaces', () => {
    const root = makeWorkspaceStorage({
      hashA: {
        'aaaaaaaa-1111.jsonl': finishedSession('aaaaaaaa-1111', 'Add Playwright tests'),
        'bbbbbbbb-2222.jsonl': activeSession('bbbbbbbb-2222', 'Why does dev fail?'),
      },
      hashB: {
        'cccccccc-3333.jsonl': finishedSession('cccccccc-3333', 'Refactor auth'),
      },
    });

    const titles = readSessionTitles(root);

    expect(titles.get('aaaaaaaa-1111')).toEqual({ title: 'Add Playwright tests', derived: false });
    expect(titles.get('bbbbbbbb-2222')).toEqual({ title: 'Why does dev fail?', derived: true });
    expect(titles.get('cccccccc-3333')).toEqual({ title: 'Refactor auth', derived: false });
  });

  it('prefers a real customTitle over a derived fallback for the same id', () => {
    const root = makeWorkspaceStorage({
      derivedWs: { 'dup-id.jsonl': activeSession('dup-id', 'first message') },
      customWs: { 'dup-id.jsonl': finishedSession('dup-id', 'Proper Title') },
    });
    expect(readSessionTitles(root).get('dup-id')).toEqual({ title: 'Proper Title', derived: false });
  });

  it('skips non-session files and unparseable files', () => {
    const root = makeWorkspaceStorage({
      hashA: {
        'good.jsonl': finishedSession('good', 'Kept'),
        'state.json': '{"kind":0,"v":{}}', // parseable but titleless
        'notes.txt': 'ignored — wrong extension',
        'broken.jsonl': 'not json at all',
      },
    });
    const titles = readSessionTitles(root);
    expect(titles.get('good')).toEqual({ title: 'Kept', derived: false });
    expect(titles.has('state')).toBe(false);
    expect(titles.has('notes')).toBe(false);
    expect(titles.has('broken')).toBe(false);
  });

  it('returns an empty map for a missing directory', () => {
    expect(readSessionTitles(path.join(os.tmpdir(), 'definitely-not-here-xyz')).size).toBe(0);
  });
});
