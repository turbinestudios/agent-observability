import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRepoCustomizationIndex } from './customizationFilter';
import {
  extractContextObservations,
  type ContextSignalsProvider,
  type SessionContext,
  type SessionContextSignals,
} from './contextInsightsExtractor';

/**
 * Fusion tests for the reworked extractor: the primary signals are now the
 * system-prompt `<file>` listing and `read_file` tool calls (NOT just discovery
 * events, which the otlp-http live-updates stream never emits).
 */
describe('extractContextObservations — signal fusion (no discovery required)', () => {
  let tmpDir: string;
  let index: ReturnType<typeof buildRepoCustomizationIndex>;

  const T0 = Date.parse('2026-06-01T10:00:00.000Z');
  const session = (sessionKey: string): SessionContext => ({
    sessionKey,
    repository: 'https://github.com/acme/widgets',
    startTimeMs: T0,
    hadError: false,
    hadDeviation: false,
  });

  const noSignals: SessionContextSignals = { discoveryEvents: [], toolReads: [], systemInstructions: [] };

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-fuse-'));
    const write = (rel: string, body: string): void => {
      const abs = path.join(tmpDir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    };
    write('.github/instructions/security.instructions.md', '# security\n'.repeat(40));
    write('.github/prompts/refactor.prompt.md', '# refactor\n'.repeat(12));
    write('.github/skills/tour/SKILL.md', '# tour\n'.repeat(20));
    index = buildRepoCustomizationIndex(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function extract(signalsByKey: Map<string, SessionContextSignals>, keys: string[]): ReturnType<typeof extractContextObservations> {
    const provider: ContextSignalsProvider = (k) => signalsByKey.get(k) ?? noSignals;
    return extractContextObservations(keys.map(session), provider, tmpDir, index);
  }

  it('derives applied observations from the system-prompt <file> listing alone', () => {
    const text = `<file>${path.join(tmpDir, '.github/instructions/security.instructions.md')}</file>`;
    const obs = extract(
      new Map([['s1', { discoveryEvents: [], toolReads: [], systemInstructions: [text] }]]),
      ['s1'],
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      contextFile: '.github/instructions/security.instructions.md',
      category: 'instruction',
      applied: true,
      sessionKey: 's1',
    });
    expect(obs[0].estTokens).toBeGreaterThan(0);
  });

  it('derives applied observations from a read_file tool call alone', () => {
    const obs = extract(
      new Map([
        ['s1', {
          discoveryEvents: [],
          toolReads: [{ filePath: path.join(tmpDir, '.github/prompts/refactor.prompt.md') }],
          systemInstructions: [],
        }],
      ]),
      ['s1'],
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      contextFile: '.github/prompts/refactor.prompt.md',
      category: 'prompt',
      applied: true,
    });
  });

  it('folds the same file seen as both listed and read into ONE applied observation', () => {
    const abs = path.join(tmpDir, '.github/skills/tour/SKILL.md');
    const obs = extract(
      new Map([
        ['s1', {
          discoveryEvents: [],
          toolReads: [{ filePath: abs }],
          systemInstructions: [`<file>${abs}</file>`],
        }],
      ]),
      ['s1'],
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ contextFile: '.github/skills/tour/SKILL.md', category: 'skill', applied: true });
  });

  it('drops out-of-workspace files (absolute paths outside the repo)', () => {
    const outside = path.join(os.tmpdir(), 'other-repo', '.github', 'instructions', 'foreign.instructions.md');
    const obs = extract(
      new Map([
        ['s1', {
          discoveryEvents: [],
          toolReads: [{ filePath: outside }],
          systemInstructions: [`<file>${outside}</file>`],
        }],
      ]),
      ['s1'],
    );
    expect(obs).toHaveLength(0);
  });

  it('produces no observation for a session with no signals', () => {
    const obs = extract(new Map(), ['s1']);
    expect(obs).toHaveLength(0);
  });
});
