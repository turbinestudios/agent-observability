import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexDb } from '../indexer/indexDb';
import type { DesktopSettingsReader } from '../drivers/desktopConfig';
import type { DeepRetroStore } from '../deepRetros';
import type { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import type { ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import { CONTEXT_PLAN_FENCE } from '@agent-observability/core/src/chat/tasks/contextImprovement';
import { ContextPlanStore } from './contextPlans';
import { IMPROVE_ENABLED_KEY, generateContextPlan, sha256 } from './contextPlan';

/**
 * The consent gate and the storage contract. The pure prompt/parse pieces are
 * covered in core; what matters here is that a gate-off call transmits NOTHING
 * (the runPrompt seam is never touched), and that a stored plan carries the
 * hashes the apply path will verify against.
 */

const REPO = 'github.com/acme/app';

let dir: string;
let repoDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-improve-'));
  repoDir = path.join(dir, 'repo');
  // A real .git marker, so the root resolution exercises the actual climb.
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Rules\nOld content.\n', 'utf8');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function settings(enabled: boolean): DesktopSettingsReader {
  return {
    get: <T,>(key: string, fallback: T): T =>
      key === IMPROVE_ENABLED_KEY ? (enabled as unknown as T) : fallback,
  } as unknown as DesktopSettingsReader;
}

function stubDb(rows: Record<string, { repository: string; title?: string }> = {}): IndexDb {
  return {
    getRow: (source: string, sessionId: string) => rows[`${source}:${sessionId}`],
    hotspots: () => [
      {
        file: path.join(repoDir, 'CLAUDE.md'),
        name: 'CLAUDE.md',
        category: 'instruction',
        sessionCount: 5,
        appliedCount: 4,
        skippedCount: 1,
        readCount: 0,
        estTokensMax: 900,
        errorSessions: 1,
        deviationSessions: 0,
        lastSeenMs: 0,
      },
    ],
    cwdsForRepository: () => [{ cwd: repoDir, resolvedAtMs: 1 }],
    contextFilePathsForRepository: () => [],
  } as unknown as IndexDb;
}

function deps(over: {
  enabled?: boolean;
  db?: IndexDb;
  runPrompt?: (prompt: string) => Promise<string>;
  onPrompt?: (prompt: string) => void;
}) {
  const store = new ContextPlanStore(path.join(dir, 'plans.json'));
  return {
    store,
    deps: {
      db: over.db ?? stubDb(),
      sources: { get: () => undefined } as unknown as SourceRegistry,
      store,
      deepRetros: { get: () => undefined } as unknown as DeepRetroStore,
      config: { getAiHelperClaudeModel: () => 'sonnet', getAiHelperCopilotCliModel: () => 'auto' } as unknown as Configuration,
      settings: settings(over.enabled ?? true),
      backend: { id: 'claude-code', label: 'Claude Code' } as unknown as ChatBackend,
      vendor: 'Anthropic',
      rootSeams: { resolveRepository: () => REPO },
      runPrompt: async (prompt: string) => {
        over.onPrompt?.(prompt);
        return (over.runPrompt ?? (async () => reply()))(prompt);
      },
    },
  };
}

function reply(): string {
  return [
    'Tighten the rules file.',
    '```' + CONTEXT_PLAN_FENCE,
    JSON.stringify({
      summary: 'Tighten CLAUDE.md',
      edits: [{ path: 'CLAUDE.md', action: 'replace', content: '# Rules\nNew content.\n' }],
    }),
    '```',
  ].join('\n');
}

describe('generateContextPlan', () => {
  it('refuses with the gate off, and the CLI seam is never touched', async () => {
    let prompts = 0;
    const { deps: d } = deps({ enabled: false, onPrompt: () => (prompts += 1) });
    const result = await generateContextPlan(
      { repository: REPO, hotspotFiles: ['x'], sessions: [] },
      d,
    );
    expect(result.error).toContain('turned off in Settings');
    expect(prompts).toBe(0);
  });

  it('refuses an empty selection and a cross-repo session', async () => {
    const { deps: d } = deps({});
    expect(
      (await generateContextPlan({ repository: REPO, hotspotFiles: [], sessions: [] }, d)).error,
    ).toContain('Select at least one');

    const { deps: d2 } = deps({
      db: stubDb({ 'claude:s1': { repository: 'github.com/acme/other' } }),
    });
    expect(
      (
        await generateContextPlan(
          {
            repository: REPO,
            hotspotFiles: ['x'],
            sessions: [{ source: 'claude', sessionId: 's1' }],
          },
          d2,
        )
      ).error,
    ).toContain('must all belong');
  });

  it('stores the plan with base hashes and no absolute paths in the prompt', async () => {
    let seenPrompt = '';
    const { deps: d, store } = deps({ onPrompt: (p) => (seenPrompt = p) });
    const result = await generateContextPlan(
      { repository: REPO, hotspotFiles: [path.join(repoDir, 'CLAUDE.md')], sessions: [] },
      d,
    );

    expect(result.error).toBeUndefined();
    expect(result.plan?.summary).toBe('Tighten CLAUDE.md');
    expect(result.plan?.edits).toEqual([
      { path: 'CLAUDE.md', action: 'replace', canUndo: false },
    ]);
    // The hotspot row's absolute identity was mapped repo-relative.
    expect(seenPrompt).toContain('| CLAUDE.md | instruction |');
    expect(seenPrompt).not.toContain(repoDir);

    const stored = store.list()[0];
    expect(stored.repoRoot).toBe(repoDir);
    expect(stored.edits[0].baseHash).toBe(sha256('# Rules\nOld content.\n'));
    expect(stored.gathered.find((g) => g.path === 'CLAUDE.md')?.baseHash).toBe(
      sha256('# Rules\nOld content.\n'),
    );
  });

  it('reports a CLI failure as an error value, not a throw', async () => {
    const { deps: d } = deps({
      runPrompt: async () => {
        throw new Error('spawn kaboom');
      },
    });
    const result = await generateContextPlan(
      { repository: REPO, hotspotFiles: ['x'], sessions: [] },
      d,
    );
    expect(result.error).toContain('spawn kaboom');
  });
});
