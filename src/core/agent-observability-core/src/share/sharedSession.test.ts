import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGGREGATE_SCHEMA } from '../telemetry/testSupport';
import {
  buildSharedSession,
  importedDetail,
  parseSharedSession,
  sharedSessionId,
  validateSharedSession,
} from './sharedSession';
import { fixtureDetail } from './sharedSessionFixture';
import type { SharedSessionEnvelope } from './sharedSessionModels';
import { sharedSessionJsonSchema } from './sharedSessionShape';
import { SharedSessionSource } from './sharedSessionSource';

const SCHEMA_FILE = path.resolve(path.dirname(AGGREGATE_SCHEMA), 'shared-session.schema.json');

function build(overrides: Partial<Parameters<typeof buildSharedSession>[0]> = {}): SharedSessionEnvelope {
  const result = buildSharedSession({
    detail: fixtureDetail(),
    source: 'claude',
    costMode: 'usd',
    toolVersion: '2.5.0',
    nowMs: 5_000,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.envelope;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('buildSharedSession', () => {
  it('redacts secrets in the conversation and counts them', () => {
    const envelope = build();
    expect(envelope.detail.turns[0].userRequest).toContain('[REDACTED:token]');
    expect(envelope.detail.turns[0].userRequest).not.toContain('ghp_');
    expect(envelope.redactions.count).toBe(1);
    expect(envelope.redactions.kinds).toEqual(['token']);
  });

  it('leaves out the local rename history and the external link', () => {
    const summary = build().detail.summary as unknown as Record<string, unknown>;
    expect(summary).not.toHaveProperty('titleOriginal');
    expect(summary).not.toHaveProperty('externalUrl');
    expect(summary).not.toHaveProperty('source');
  });

  it('drops fields the format does not know, so a new model field stays local', () => {
    const detail = fixtureDetail();
    (detail.turns[0] as unknown as Record<string, unknown>).someFutureField = 'raw';
    const envelope = build({ detail });
    expect(envelope.detail.turns[0]).not.toHaveProperty('someFutureField');
    expect(validateSharedSession(clone(envelope))).toEqual([]);
  });

  it('uses the name the user sees in place of the derived title', () => {
    const envelope = build({ title: 'My name for it' });
    expect(envelope.detail.summary.title).toBe('My name for it');
    expect(envelope.detail.summary.titleDerived).toBe(false);
  });

  it('refuses to re-share an imported session', () => {
    const result = buildSharedSession({
      detail: fixtureDetail(),
      source: 'shared',
      costMode: 'usd',
      toolVersion: '2.5.0',
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('records where the session came from', () => {
    const envelope = build({ source: 'copilot-cli', costMode: 'aiu' });
    expect(envelope.origin).toEqual({ source: 'copilot-cli', costMode: 'aiu' });
  });
});

describe('validateSharedSession', () => {
  it('accepts what the builder writes', () => {
    expect(validateSharedSession(clone(build()))).toEqual([]);
  });

  it('rejects an unknown key at any level', () => {
    const top = clone(build()) as unknown as Record<string, unknown>;
    top.extra = 1;
    expect(validateSharedSession(top)).toContain('extra is not allowed.');

    const nested = clone(build());
    (nested.detail.turns[0].events[0] as unknown as Record<string, unknown>).args = '{"path":"/etc"}';
    expect(validateSharedSession(nested).join('\n')).toContain('detail.turns[0].events[0].args is not allowed.');
  });

  it('rejects a link smuggled into the summary', () => {
    const value = clone(build());
    (value.detail.summary as unknown as Record<string, unknown>).externalUrl = 'https://example.invalid';
    expect(validateSharedSession(value)).toContain('detail.summary.externalUrl is not allowed.');
  });

  it('rejects wrong types, negative numbers and closed-set violations', () => {
    const value = clone(build());
    (value.detail.summary as unknown as Record<string, unknown>).inputTokens = -1;
    (value.detail.turns[0] as unknown as Record<string, unknown>).agentMode = 'evil';
    (value.origin as unknown as Record<string, unknown>).source = 'shared';
    const errors = validateSharedSession(value);
    expect(errors).toContain('detail.summary.inputTokens must be a non-negative number.');
    expect(errors.join('\n')).toContain('detail.turns[0].agentMode must be one of');
    expect(errors.join('\n')).toContain('origin.source must be one of');
  });

  it('names a newer format as one to update for', () => {
    const value = clone(build()) as unknown as Record<string, unknown>;
    value.schemaVersion = '2.0';
    expect(validateSharedSession(value)[0]).toContain('cannot read. Update the app');
  });

  it('rejects a file that is not a shared session at all', () => {
    expect(validateSharedSession({ schemaVersion: '1.0' })[0]).toContain('not a shared session');
    expect(parseSharedSession('{ nope').ok).toBe(false);
  });
});

describe('the checked-in schema', () => {
  it('is exactly what the shape generates', () => {
    const onDisk = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as unknown;
    expect(onDisk).toEqual(sharedSessionJsonSchema());
  });

  it('agrees with the validator', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as object);
    const good = clone(build());
    expect(validate(good)).toBe(true);

    const bad = clone(build());
    (bad.detail.treeStats as unknown as Record<string, unknown>).leak = 'x';
    expect(validate(bad)).toBe(false);
    expect(validateSharedSession(bad)).not.toEqual([]);
  });
});

describe('sharedSessionId', () => {
  it('is stable for the same session and differs by source', () => {
    const a = build();
    const b = build({ nowMs: 9_999, title: 'Renamed' });
    expect(sharedSessionId(a)).toBe(sharedSessionId(b));
    expect(sharedSessionId(build({ source: 'copilot-cli', costMode: 'aiu' }))).not.toBe(sharedSessionId(a));
    expect(sharedSessionId(a)).toMatch(/^claude\.[0-9a-f]{16}$/);
  });

  it('serves the detail under the imported id and the shared source', () => {
    const envelope = build();
    const served = importedDetail(envelope, 'claude.0123456789abcdef');
    expect(served.summary.sessionId).toBe('claude.0123456789abcdef');
    expect(served.summary.source).toBe('shared');
  });
});

describe('SharedSessionSource', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-shared-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function store(envelope: SharedSessionEnvelope): string {
    const id = sharedSessionId(envelope);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(envelope), 'utf8');
    return id;
  }

  it('serves a stored session and its cost basis', () => {
    const id = store(build({ source: 'copilot-cli', costMode: 'aiu' }));
    const source = new SharedSessionSource(dir);
    const detail = source.getSessionDetail(id);
    expect(detail.ok && detail.value.summary.sessionId).toBe(id);
    expect(detail.ok && detail.value.turns[0].finalResponse).toBe('Done. I changed the session check.');
    expect(source.costModeOf(id)).toBe('aiu');
    expect(source.originDetails(id)).toEqual({ source: 'copilot-cli', exportedAtMs: 5_000, toolVersion: '2.5.0' });
    expect(source.sessions().sessions.map((s) => s.id)).toEqual([id]);
  });

  it('contributes nothing to the user\'s own figures', () => {
    store(build());
    const source = new SharedSessionSource(dir);
    const rows = source.getAggregationRows();
    const overview = source.getOverview();
    expect(rows.ok && rows.value).toEqual([]);
    expect(overview.ok && overview.value.totalSessions).toBe(0);
  });

  it('refuses a stored file that was edited to break the format', () => {
    const id = store(build());
    const file = path.join(dir, `${id}.json`);
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    tampered.extra = true;
    fs.writeFileSync(file, JSON.stringify(tampered), 'utf8');
    const source = new SharedSessionSource(dir);
    expect(source.getSessionDetail(id).ok).toBe(false);
    expect(source.sessions().problems).toHaveLength(1);
  });

  it('refuses a file whose name does not match its content', () => {
    const envelope = build();
    const wrong = 'claude.ffffffffffffffff';
    fs.writeFileSync(path.join(dir, `${wrong}.json`), JSON.stringify(envelope), 'utf8');
    expect(new SharedSessionSource(dir).getSessionDetail(wrong).ok).toBe(false);
  });

  it('never resolves an id outside its folder', () => {
    const source = new SharedSessionSource(dir);
    expect(source.fileFor(`..${path.sep}escape`)).toBeUndefined();
    expect(source.getSessionDetail('../../etc/passwd').ok).toBe(false);
  });

  it('lists nothing when the folder does not exist yet', () => {
    const source = new SharedSessionSource(path.join(dir, 'missing'));
    expect(source.sessions()).toEqual({ sessions: [], problems: [] });
  });
});
