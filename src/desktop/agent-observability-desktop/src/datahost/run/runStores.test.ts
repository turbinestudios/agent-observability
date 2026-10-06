import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PREFILL_MAX_CHARS,
  PREFILL_MAX_LIST_ITEMS,
  blankPrefill,
  capPrefill,
  continueSessionPrefill,
  digestPrefill,
  handoffPrefill,
  planPrefill,
  retroPrefill,
} from './runPrefill';
import { MAX_RUN_RECORDS, RunStore } from './runs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-runs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('RunStore', () => {
  const record = (sessionId: string, startedAtMs = 1) => ({
    sessionId,
    cwd: path.join(dir, 'repo'),
    repository: 'https://github.com/o/r',
    startedAtMs,
    door: 'blank' as const,
  });

  it('remembers which sessions started here, newest first, across reopen, with no temp file left', () => {
    const file = path.join(dir, 'nested', 'runs.json');
    const store = new RunStore(file);
    store.add(record('a'));
    store.add(record('b'));
    store.add(record('a', 5));
    expect(store.list().map((r) => r.sessionId)).toEqual(['a', 'b']);
    expect(store.get('a')?.startedAtMs).toBe(5);
    expect(new RunStore(file).has('b')).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['runs.json']);
    // Ids, paths and timestamps only.
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).sort()).toEqual([
      'cwd',
      'door',
      'repository',
      'sessionId',
      'startedAtMs',
    ]);
  });

  it('drops malformed entries and caps the list', () => {
    const file = path.join(dir, 'runs.json');
    fs.writeFileSync(file, JSON.stringify([record('ok'), { sessionId: 1 }, null, { ...record('bad'), door: 'nonsense' }]));
    const store = new RunStore(file);
    expect(store.list().map((r) => r.sessionId)).toEqual(['ok']);
    // One write, not hundreds: the cap is checked on read and on a single add,
    // so the test's speed never depends on the runner's disk.
    const many = Array.from({ length: MAX_RUN_RECORDS + 5 }, (_, i) => record(`s${i}`));
    fs.writeFileSync(file, JSON.stringify(many));
    const capped = new RunStore(file);
    expect(capped.list()).toHaveLength(MAX_RUN_RECORDS);
    capped.add(record('newest'));
    expect(capped.list()).toHaveLength(MAX_RUN_RECORDS);
    expect(capped.list()[0].sessionId).toBe('newest');
    fs.writeFileSync(file, '{ not json');
    expect(new RunStore(file).list()).toEqual([]);
  });
});

describe('prefill builders', () => {
  it('caps every door at the prefill limit and says the text was shortened', () => {
    const long = 'x'.repeat(PREFILL_MAX_CHARS * 2);
    for (const prefill of [digestPrefill('r', long), handoffPrefill('r', long), retroPrefill('r', long, [long], [long])]) {
      expect(prefill.goal.length).toBeLessThanOrEqual(PREFILL_MAX_CHARS);
      expect(prefill.goal).toContain('Shortened to fit');
    }
    expect(capPrefill('  short  ')).toBe('short');
  });

  it('continues a session with an empty box and the id to resume', () => {
    expect(continueSessionPrefill('abc', 'r')).toEqual({ door: 'continue-session', goal: '', repository: 'r', resumeSessionId: 'abc' });
    expect(blankPrefill()).toEqual({ door: 'blank', goal: '' });
  });

  it('lists a plan’s edits by repository-relative path and caps the list', () => {
    const edits = Array.from({ length: PREFILL_MAX_LIST_ITEMS + 3 }, (_, i) => ({ path: `docs/f${i}.md`, action: 'replace' }));
    const prefill = planPrefill('r', 'Tighten the rules.', [{ path: 'AGENTS.md', action: 'replace', rationale: 'Too long' }, ...edits]);
    expect(prefill.door).toBe('improve-plan');
    expect(prefill.goal).toContain('- replace `AGENTS.md`: Too long');
    expect(prefill.goal).toContain('Tighten the rules.');
    expect(prefill.goal).toContain('and 4 more');
    expect(prefill.goal).toContain('Show me each change before you write it.');
  });

  it('builds a retry from the retrospective’s own sentences and asks for verification', () => {
    const prefill = retroPrefill(undefined, 'Add the export', ['State the end state.'], ['Tools failed in a row.']);
    expect(prefill).toMatchObject({ door: 'retro-advice' });
    expect(prefill.repository).toBeUndefined();
    expect(prefill.goal).toContain('Goal: Add the export');
    expect(prefill.goal).toContain('- State the end state.');
    expect(prefill.goal).toContain('- Tools failed in a row.');
    expect(prefill.goal).toContain('Run the project checks');
    expect(retroPrefill('r', undefined, [], []).goal).toContain('describe what you want done');
  });
});
