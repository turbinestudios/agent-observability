import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContextAnalysis, SessionContextAnalysis } from '../context/models';
import { AGGREGATE_SCHEMA } from '../telemetry/testSupport';
import { ABSOLUTE_PATH, IMPORTED_CONTEXT_NOTE } from './sharedContext';
import { buildSharedSession, sharedSessionId, validateSharedSession } from './sharedSession';
import { fixtureDetail } from './sharedSessionFixture';
import type { SharedSessionEnvelope } from './sharedSessionModels';
import { SharedSessionSource } from './sharedSessionSource';

/**
 * The Context Analysis in a shared-session file: it travels without a single
 * absolute path, and an importer refuses a file that puts one back.
 *
 * Paths are built with `path.join` from the platform's own root, so the same
 * assertions hold on the Windows and macOS runners.
 */

const SCHEMA_FILE = path.resolve(path.dirname(AGGREGATE_SCHEMA), 'shared-session.schema.json');
const ROOT = path.parse(process.cwd()).root;
const REPO = path.join(ROOT, 'work', 'sender-repo');
const HOME_SKILL = path.join(ROOT, 'home', 'someone', '.claude', 'skills', 'plan', 'SKILL.md');
const repoRootOf = (file: string): string | undefined => (file.startsWith(REPO + path.sep) ? REPO : undefined);

function agent(kind: AgentContextAnalysis['kind'], agentName: string): AgentContextAnalysis {
  return {
    agentName,
    kind,
    loadedFiles: [
      {
        name: 'SKILL.md',
        filePath: path.join(REPO, '.github', 'skills', 'review', 'SKILL.md'),
        category: 'skill',
        status: 'applied',
        estimatedTokens: 300,
        charCount: 1200,
      },
      { name: 'SKILL.md', filePath: HOME_SKILL, category: 'skill', status: 'read', estimatedTokens: 90 },
      {
        name: 'go.instructions.md',
        filePath: path.join(REPO, '.github', 'instructions', 'go.instructions.md'),
        category: 'instruction',
        status: 'skipped',
        skipReason: `applyTo did not match ${path.join(REPO, 'cmd')}`,
      },
    ],
    expectedMissing: [
      {
        name: 'testing.md',
        referencedBy: [
          { sourceFile: 'AGENTS.md', referencedFile: path.join(REPO, 'docs', 'testing.md'), referenceType: 'file-path' },
          { sourceFile: 'AGENTS.md', referencedFile: path.join(ROOT, 'elsewhere', 'notes.md'), referenceType: 'file-path' },
        ],
      },
    ],
    totalContextTokens: 20_000,
    contextFileTokens: 390,
    otherContextTokens: 19_610,
    oversizedFiles: [],
  };
}

function analysis(): SessionContextAnalysis {
  return {
    total: agent('total', 'Total'),
    agents: [agent('main', 'Main Agent'), agent('subagent', 'reviewer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')],
    note: `Read from the disk of this machine under ${REPO}`,
  };
}

function build(withRoots = true): SharedSessionEnvelope {
  const result = buildSharedSession({
    detail: fixtureDetail(),
    source: 'claude',
    costMode: 'usd',
    toolVersion: '2.6.0',
    nowMs: 5_000,
    context: analysis(),
    ...(withRoots ? { repoRootOf } : {}),
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.envelope;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every string anywhere in `value`. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

describe('exporting the Context Analysis', () => {
  it('writes the 1.1 format with the analysis in it', () => {
    const envelope = build();
    expect(envelope.schemaVersion).toBe('1.1');
    expect(envelope.contextAnalysis?.agents).toHaveLength(2);
  });

  it('leaves no absolute path anywhere in the file', () => {
    const json = JSON.stringify(build());
    for (const text of strings(JSON.parse(json))) {
      expect(ABSOLUTE_PATH.test(text)).toBe(false);
    }
    expect(json).not.toContain(JSON.stringify(REPO).slice(1, -1));
    expect(json).not.toContain('someone');
  });

  it('keeps a repository file as its repository-relative path', () => {
    const [review] = build().contextAnalysis!.total.loadedFiles;
    expect(review).toEqual({
      name: 'SKILL.md',
      repoPath: '.github/skills/review/SKILL.md',
      category: 'skill',
      status: 'applied',
      estimatedTokens: 300,
      charCount: 1200,
    });
  });

  it('names a file outside the repository by its label only', () => {
    const home = build().contextAnalysis!.total.loadedFiles[1];
    expect(home.name).toBe('plan/SKILL.md');
    expect(home).not.toHaveProperty('repoPath');
    expect(home).not.toHaveProperty('filePath');
  });

  it('keeps names only when the repository cannot be found', () => {
    const files = build(false).contextAnalysis!.total.loadedFiles;
    expect(files.map((f) => f.name)).toEqual(['review/SKILL.md', 'plan/SKILL.md', 'go.instructions.md']);
    expect(files.some((f) => f.repoPath !== undefined)).toBe(false);
  });

  it('drops the skip reason and the source note', () => {
    const context = build().contextAnalysis!;
    expect(context).not.toHaveProperty('note');
    expect(context.total.loadedFiles[2]).not.toHaveProperty('skipReason');
  });

  it('cuts a reference by absolute path to the repository path or the file name', () => {
    const [missing] = build().contextAnalysis!.total.expectedMissing;
    expect(missing.referencedBy.map((r) => r.referencedFile)).toEqual(['docs/testing.md', 'notes.md']);
  });

  it('redacts secrets in agent names and counts them with the rest', () => {
    const envelope = build();
    expect(envelope.contextAnalysis!.agents[1].agentName).toContain('[REDACTED:token]');
    // One in the fixture's prompt, one in the sub-agent's name.
    expect(envelope.redactions.count).toBe(2);
  });

  it('writes no context block when the source has none', () => {
    const result = buildSharedSession({
      detail: fixtureDetail(),
      source: 'claude',
      costMode: 'usd',
      toolVersion: '2.6.0',
      nowMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.envelope : undefined).not.toHaveProperty('contextAnalysis');
  });
});

describe('importing the Context Analysis', () => {
  const tamper = (mutate: (e: SharedSessionEnvelope) => void): string[] => {
    const envelope = clone(build());
    mutate(envelope);
    return validateSharedSession(envelope);
  };

  it('accepts what the exporter wrote', () => {
    expect(validateSharedSession(clone(build()))).toEqual([]);
  });

  it.each([
    ['an absolute repository path', path.join(REPO, 'AGENTS.md')],
    ['a POSIX absolute repository path', '/etc/passwd'],
    ['a drive-letter path', 'C:/Users/x/AGENTS.md'],
    ['a parent-folder escape', '../outside/AGENTS.md'],
    ['a parent folder in the middle', 'docs/../../AGENTS.md'],
    ['a backslash path', 'docs\\AGENTS.md'],
  ])('refuses %s', (_, repoPath) => {
    expect(tamper((e) => (e.contextAnalysis!.total.loadedFiles[0].repoPath = repoPath))).not.toEqual([]);
  });

  it('refuses an absolute path in a name or a reference', () => {
    expect(tamper((e) => (e.contextAnalysis!.total.loadedFiles[0].name = '/home/x/SKILL.md'))).not.toEqual([]);
    expect(
      tamper((e) => (e.contextAnalysis!.agents[0].expectedMissing[0].referencedBy[0].referencedFile = 'C:\\x.md')),
    ).not.toEqual([]);
  });

  it('refuses the fields the exporter drops', () => {
    expect(tamper((e) => ((e.contextAnalysis as unknown as Record<string, unknown>).note = 'x'))).not.toEqual([]);
    expect(
      tamper((e) => ((e.contextAnalysis!.total.loadedFiles[0] as unknown as Record<string, unknown>).filePath = 'a')),
    ).not.toEqual([]);
  });

  it('still reads a 1.0 file, which has no analysis', () => {
    const envelope = clone(build()) as unknown as Record<string, unknown>;
    envelope.schemaVersion = '1.0';
    delete envelope.contextAnalysis;
    expect(validateSharedSession(envelope)).toEqual([]);
  });

  it('agrees with the checked-in schema', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as object);
    expect(validate(clone(build()))).toBe(true);
    const bad = clone(build());
    bad.contextAnalysis!.total.loadedFiles[0].repoPath = '../x';
    expect(validate(bad)).toBe(false);
  });
});

describe('an imported session', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-shared-ctx-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the analysis read-only, captioned as the sender’s', () => {
    const envelope = build();
    const id = sharedSessionId(envelope);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(envelope), 'utf8');
    const served = new SharedSessionSource(dir).getContextAnalysis(id);
    expect(served?.readOnly).toBe(true);
    expect(served?.note).toBe(IMPORTED_CONTEXT_NOTE);
    expect(served?.total.loadedFiles[0].repoPath).toBe('.github/skills/review/SKILL.md');
  });

  it('serves none for a file without one', () => {
    const envelope = clone(build());
    delete envelope.contextAnalysis;
    const id = sharedSessionId(envelope);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(envelope), 'utf8');
    expect(new SharedSessionSource(dir).getContextAnalysis(id)).toBeUndefined();
  });
});
