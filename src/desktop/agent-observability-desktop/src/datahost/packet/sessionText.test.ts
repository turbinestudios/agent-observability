import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionDetail, SessionTurn } from '@agent-observability/core/src/telemetry/models';
import type { SessionRetrospective } from '@agent-observability/core/src/analysis/retrospective';
import { emptyActivity, type SessionActivity } from '@agent-observability/core/src/analysis/sessionActivity';
import type { SessionContextAnalysis } from '@agent-observability/core/src/context/models';
import type { SessionFacts } from '../detail/detailRenderer';
import {
  UNRESOLVED_ROOT_NOTE,
  buildHandoff,
  buildReviewPackets,
  cwdFromTranscriptHead,
  repoPathFn,
  resumeTarget,
  type HandoffBriefDeps,
} from './sessionText';

/**
 * The datahost side of the review packet, the hand-off brief and "Resume in
 * terminal", against fake facts and a temp directory. Paths are built with
 * `path.join` so nothing depends on the platform's separators.
 */

const REPO = 'https://github.com/o/repo';
let dir: string;
let root: string;

function turn(over: Partial<SessionTurn> = {}): SessionTurn {
  return {
    timestampMs: 0,
    agentMode: 'agent',
    model: 'model-a',
    durationMs: 60_000,
    success: true,
    llmCalls: 1,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    events: [],
    ...over,
  } as SessionTurn;
}

function detail(): SessionDetail {
  return {
    summary: { sessionId: 'sess-1', repository: REPO, durationMs: 60_000, source: 'claude' },
    treeStats: { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
    turns: [turn({ userRequest: 'Fix the login test. Never touch the public API.', finalResponse: 'Done.' })],
    modelUsage: [{ model: 'model-a', inputTokens: 100, outputTokens: 50 }],
    agentUsage: [],
    treeModelTurns: [],
  } as unknown as SessionDetail;
}

function retro(): SessionRetrospective {
  return {
    sessionId: 'sess-1',
    goal: 'Fix the login test',
    goalSource: 'ai-title',
    goalConfidence: 'high',
    verdict: 'smooth',
    verdictReasons: [],
    outcome: 'unclear',
    findings: [],
    tips: [],
    counts: {},
    contentDerived: true,
  } as unknown as SessionRetrospective;
}

function activity(): SessionActivity {
  const a = emptyActivity(true);
  a.edits.push(
    { order: 1, turnIndex: 0, path: path.join(root, 'src', 'login.ts'), linesAdded: 4, linesRemoved: 1, created: false, tool: 'Edit' },
    { order: 2, turnIndex: 0, path: path.join(dir, 'elsewhere', 'notes.md'), linesAdded: 2, linesRemoved: 0, created: true, tool: 'Write' },
  );
  return a;
}

function facts(over: Partial<SessionFacts> = {}): SessionFacts {
  return { detail: detail(), retro: retro(), context: undefined, activity: activity(), ...over };
}

function deps(over: Partial<HandoffBriefDeps> = {}): HandoffBriefDeps {
  return {
    facts: () => facts(),
    row: () => ({ repository: REPO, title: 'Renamed by the user' }),
    resolveRoot: () => root,
    costMode: () => 'usd',
    live: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-packet-'));
  root = path.join(dir, 'checkout');
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('repoPathFn', () => {
  it('relativizes inside the root, names files outside it, and guesses nothing without a root', () => {
    const fn = repoPathFn(root);
    expect(fn(path.join(root, 'src', 'a.ts'))).toEqual({ path: 'src/a.ts', insideRepo: true });
    expect(fn(path.join(dir, 'other', 'b.ts'))).toEqual({ path: 'b.ts', insideRepo: false });
    expect(fn('docs\\c.md')).toEqual({ path: 'docs/c.md', insideRepo: true });
    expect(repoPathFn(undefined)(path.join(root, 'src', 'a.ts'))).toEqual({ path: 'a.ts', insideRepo: true });
  });
});

describe('buildReviewPackets', () => {
  it('builds one packet per session with repo-relative paths and the list title', () => {
    const result = buildReviewPackets([{ source: 'claude', sessionId: 'sess-1' }], deps());
    expect(result.skipped).toEqual([]);
    expect(result.note).toBeUndefined();
    const [packet] = result.packets;
    expect(packet.source).toBe('claude');
    expect(packet.sessionId).toBe('sess-1');
    expect(packet.title).toBe('Renamed by the user');
    expect(packet.files.map((f) => f.path).sort()).toEqual(['notes.md', 'src/login.ts']);
    const json = JSON.stringify(result);
    expect(json).not.toContain(root);
    expect(json).not.toContain(dir);
  });

  it('lists a session that cannot be read as skipped instead of failing the packet', () => {
    const result = buildReviewPackets(
      [
        { source: 'claude', sessionId: 'sess-1' },
        { source: 'claude', sessionId: 'gone' },
      ],
      deps({
        facts: (_source, sessionId) => {
          if (sessionId === 'gone') {
            throw new Error('transcript not found');
          }
          return facts();
        },
      }),
    );
    expect(result.packets).toHaveLength(1);
    expect(result.skipped).toEqual([{ source: 'claude', sessionId: 'gone', message: 'transcript not found' }]);
  });

  it('falls back to file names and says so when no checkout is known', () => {
    const result = buildReviewPackets([{ source: 'claude', sessionId: 'sess-1' }], deps({ resolveRoot: () => undefined }));
    expect(result.note).toBe(UNRESOLVED_ROOT_NOTE);
    expect(result.packets[0].files.map((f) => f.path).sort()).toEqual(['login.ts', 'notes.md']);
    expect(result.packets[0].risks.some((r) => r.id === 'write-outside-repo')).toBe(false);
  });

  it('builds a degraded packet when the retrospective could not be built', () => {
    const result = buildReviewPackets(
      [{ source: 'copilot', sessionId: 'sess-1' }],
      deps({ facts: () => facts({ retro: undefined, activity: emptyActivity(false) }) }),
    );
    expect(result.packets[0].filesAvailable).toBe(false);
  });
});

describe('buildHandoff', () => {
  it('makes context files repo-relative and carries the live ending when the session is on the board', () => {
    const context = {
      total: {
        loadedFiles: [
          { name: 'AGENTS.md', filePath: path.join(root, 'AGENTS.md') },
          { name: 'CLAUDE.md', filePath: path.join(dir, 'home', '.claude', 'CLAUDE.md') },
          { name: 'a-skill' },
        ],
      },
    } as unknown as SessionContextAnalysis;
    const { brief, note } = buildHandoff(
      'claude',
      'sess-1',
      deps({ facts: () => facts({ context }), live: () => ({ lastEvent: 'interruption' }) }),
    );
    expect(note).toBeUndefined();
    expect(brief.contextFiles).toEqual(['AGENTS.md', 'CLAUDE.md', 'a-skill']);
    expect(brief.state.ending).toBe('interrupted');
    expect(brief.source).toBe('claude');
    expect(JSON.stringify(brief)).not.toContain(dir);
  });

  it('works without a live row and without a checkout', () => {
    const { brief, note } = buildHandoff('claude', 'sess-1', deps({ resolveRoot: () => undefined }));
    expect(note).toBe(UNRESOLVED_ROOT_NOTE);
    expect(brief.files.every((f) => !f.path.includes(path.sep) || path.sep === '/')).toBe(true);
    expect(brief.suggestedPrompt.length).toBeGreaterThan(0);
  });
});

describe('resumeTarget', () => {
  it('reads the working directory from the head of a Claude transcript', () => {
    const transcript = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'summary', summary: 'x' }),
        '{ not json',
        JSON.stringify({ type: 'user', cwd: root, message: { role: 'user', content: 'hi' } }),
      ].join('\n'),
    );
    expect(resumeTarget('claude', 'id-1', { mainPath: () => transcript })).toEqual({
      cwd: root,
      sessionId: 'id-1',
      cli: 'claude',
    });
  });

  it('reports a folder that no longer exists, a missing session file, and an unsupported source', () => {
    const gone = path.join(dir, 'gone');
    expect(
      resumeTarget('claude', 'id-1', {
        mainPath: () => 'x',
        readHead: () => JSON.stringify({ cwd: gone }),
      }).problem,
    ).toContain('no longer exists');
    expect(resumeTarget('claude', 'id-1', { mainPath: () => undefined }).problem).toContain('no longer known');
    expect(resumeTarget('copilot', 'id-1', { mainPath: () => 'x' }).problem).toContain('Only Claude Code and Copilot CLI');
  });

  it('reads a Copilot CLI session from the workspace file beside its events', () => {
    const session = path.join(dir, 'session-state', 'abc');
    fs.mkdirSync(session, { recursive: true });
    const target = resumeTarget('copilot-cli', 'abc', {
      mainPath: () => path.join(session, 'events.jsonl'),
      readWorkspace: (file) => {
        expect(file).toBe(path.join(session, 'workspace.yaml'));
        return { cwd: root };
      },
    });
    expect(target).toEqual({ cwd: root, sessionId: 'abc', cli: 'copilot' });
  });

  it('finds nothing in a head without a cwd', () => {
    expect(cwdFromTranscriptHead(undefined)).toBeUndefined();
    expect(cwdFromTranscriptHead('{"type":"summary"}\n')).toBeUndefined();
  });
});
