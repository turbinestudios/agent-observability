import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SettingsReader } from '@agent-observability/core/src/config/configuration';
import { defaultFs } from '@agent-observability/core/src/claude/paths';
import type { ClaudeFs } from '@agent-observability/core/src/claude/paths';
import { describeDeletion, deleteSession } from './deletion';
import { HiddenStore } from './hidden';

/**
 * Permanent deletion, which is the one operation here that cannot be undone.
 *
 * The tests care about two things above all: that it removes exactly what it
 * said it would remove, and that it removes nothing when it cannot do the job
 * properly — a half-deleted session, or a deletion reported as successful while
 * the data is still there, is worse than a refusal.
 */

let root: string;
let projects: string;
let archive: string;

function settings(values: Record<string, unknown>): SettingsReader {
  return {
    get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function makeConfig(): Configuration {
  return new Configuration(
    settings({
      'claudeCode.projectsPath': projects,
      'claudeCode.enabled': true,
      'copilotArchive.path': archive,
    }),
  );
}

/** Confines Claude discovery to the fixture, as the projects path is additive. */
function isolatedFs(): ClaudeFs {
  return { ...defaultFs, homedir: () => root, env: {} };
}

function deps() {
  return { config: makeConfig(), fs: isolatedFs() };
}

function writeTranscript(sessionId: string): string {
  const dir = path.join(projects, '-work-app');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'user', cwd: '/work/app', sessionId, message: { role: 'user', content: [] } })}\n`,
  );
  return file;
}

function writeSubagent(sessionId: string, agent: string): string {
  const dir = path.join(projects, '-work-app', sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agent}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', sessionId })}\n`);
  return file;
}

function writeArchive(sessionIds: string[]): void {
  const db = new Database(archive);
  db.exec(`
    CREATE TABLE spans (span_id TEXT PRIMARY KEY, conversation_id TEXT, chat_session_id TEXT);
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);
  const span = db.prepare('INSERT INTO spans (span_id, chat_session_id) VALUES (?, ?)');
  const attr = db.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)');
  for (const id of sessionIds) {
    for (let i = 0; i < 3; i += 1) {
      span.run(`${id}-span-${i}`, id);
      attr.run(`${id}-span-${i}`, 'k', 'v');
    }
  }
  db.close();
}

function archiveCounts(): { spans: number; attrs: number } {
  const db = new Database(archive, { readonly: true });
  const spans = (db.prepare('SELECT COUNT(*) n FROM spans').get() as { n: number }).n;
  const attrs = (db.prepare('SELECT COUNT(*) n FROM span_attributes').get() as { n: number }).n;
  db.close();
  return { spans, attrs };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-delete-'));
  projects = path.join(root, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  archive = path.join(root, 'archive.db');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('describing what a delete would do', () => {
  it('names the transcript that would be removed', () => {
    const file = writeTranscript('sess-a');
    const plan = describeDeletion('claude', 'sess-a', deps());

    expect(plan.supported).toBe(true);
    expect(plan.target).toContain(file);
    expect(plan.consequence).toContain('resume');
  });

  it('mentions sub-agent transcripts in the count', () => {
    writeTranscript('sess-a');
    writeSubagent('sess-a', '1');
    expect(describeDeletion('claude', 'sess-a', deps()).target).toContain('sub-agent');
  });

  it('refuses when the transcript is already gone', () => {
    const plan = describeDeletion('claude', 'missing', deps());
    expect(plan.supported).toBe(false);
    expect(plan.consequence).toContain('hide');
  });

  it('warns that a Copilot session can come back', () => {
    writeArchive(['sess-a']);
    const plan = describeDeletion('copilot', 'sess-a', deps());
    expect(plan.supported).toBe(true);
    expect(plan.caveat).toBeDefined();
  });

  it('refuses a source it cannot delete from', () => {
    expect(describeDeletion('copilot-cloud', 'x', deps()).supported).toBe(false);
  });

  it('does not delete anything just by describing it', () => {
    const file = writeTranscript('sess-a');
    describeDeletion('claude', 'sess-a', deps());
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('deleting a Claude session', () => {
  it('removes the transcript', () => {
    const file = writeTranscript('sess-a');
    const result = deleteSession('claude', 'sess-a', deps());

    expect(result.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes sub-agent transcripts too, so nothing is left half-deleted', () => {
    const main = writeTranscript('sess-a');
    const sub = writeSubagent('sess-a', '1');

    expect(deleteSession('claude', 'sess-a', deps()).ok).toBe(true);
    expect(fs.existsSync(main)).toBe(false);
    expect(fs.existsSync(sub)).toBe(false);
  });

  it('leaves other sessions alone', () => {
    writeTranscript('sess-a');
    const other = writeTranscript('sess-b');

    deleteSession('claude', 'sess-a', deps());
    expect(fs.existsSync(other)).toBe(true);
  });

  it('reports failure when there is nothing to delete', () => {
    expect(deleteSession('claude', 'missing', deps())).toMatchObject({ ok: false });
  });
});

describe('deleting a Copilot session', () => {
  it('removes its spans and their attributes', () => {
    writeArchive(['sess-a', 'sess-b']);
    expect(archiveCounts()).toEqual({ spans: 6, attrs: 6 });

    const result = deleteSession('copilot', 'sess-a', deps());

    expect(result.ok).toBe(true);
    expect(archiveCounts()).toEqual({ spans: 3, attrs: 3 });
  });

  it('reports failure when the session is not in the archive', () => {
    writeArchive(['sess-b']);
    const result = deleteSession('copilot', 'sess-a', deps());

    expect(result.ok).toBe(false);
    expect(archiveCounts().spans).toBe(3);
  });

  it('refuses while another writer holds the archive lock', () => {
    writeArchive(['sess-a']);
    // The archiver takes this lock while sweeping; deleting underneath it
    // could interleave with a transaction in flight.
    fs.writeFileSync(
      path.join(path.dirname(archive), 'writer.lock'),
      JSON.stringify({ pid: 1, host: 'other', ts: Date.now() }),
    );

    const result = deleteSession('copilot', 'sess-a', deps());

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('being written');
    expect(archiveCounts().spans).toBe(3);
  });

  it('releases the lock afterwards, so a second delete can proceed', () => {
    writeArchive(['sess-a', 'sess-b']);
    deleteSession('copilot', 'sess-a', deps());
    expect(deleteSession('copilot', 'sess-b', deps()).ok).toBe(true);
  });

  it('reports failure when there is no archive at all', () => {
    expect(deleteSession('copilot', 'sess-a', deps())).toMatchObject({ ok: false });
  });
});

describe('hiding', () => {
  let hiddenFile: string;

  beforeEach(() => {
    hiddenFile = path.join(root, 'hidden.json');
  });

  it('hides and unhides a session', () => {
    const store = new HiddenStore(hiddenFile);
    store.set('claude', 'abc', true);
    expect(store.isHidden('claude', 'abc')).toBe(true);

    store.set('claude', 'abc', false);
    expect(store.isHidden('claude', 'abc')).toBe(false);
  });

  it('survives a restart', () => {
    new HiddenStore(hiddenFile).set('claude', 'abc', true);
    expect(new HiddenStore(hiddenFile).isHidden('claude', 'abc')).toBe(true);
  });

  it('keeps sources apart for the same session id', () => {
    const store = new HiddenStore(hiddenFile);
    store.set('claude', 'same', true);
    expect(store.isHidden('copilot', 'same')).toBe(false);
  });

  it('touches nothing on disk', () => {
    const file = writeTranscript('sess-a');
    new HiddenStore(hiddenFile).set('claude', 'sess-a', true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('starts empty when unreadable rather than losing the list', () => {
    fs.writeFileSync(hiddenFile, 'not json');
    expect(new HiddenStore(hiddenFile).size()).toBe(0);
  });
});
