import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeService, ClaudeServiceConfig } from './claudeCodeService';
import { ClaudeFs, defaultFs } from './paths';

/**
 * Service-level repository exclusion (`agentObservability.excludedRepositories`)
 * over real temp-dir transcripts: one session in a repo with a git remote, one
 * in a plain directory (→ `unknown`). The excluded repository must vanish from
 * the summaries chokepoint (overview / repository list / session list) AND from
 * the aggregation rows that feed cloud sync and the payload preview.
 */

const HIDDEN_REPO = 'https://github.com/example-org/hidden-repo';
const SESSION_A = '11111111-1111-4111-8111-111111111111'; // in the git repo
const SESSION_B = '22222222-2222-4222-8222-222222222222'; // no remote → unknown

/** Two-record transcript (user prompt + one assistant turn) rooted at `cwd`. */
function writeTranscript(file: string, cwd: string): void {
  const escapedCwd = JSON.stringify(cwd);
  const lines = [
    `{"type":"user","timestamp":"2026-05-01T10:00:00.000Z","cwd":${escapedCwd},"message":{"role":"user","content":"Add a feature"}}`,
    `{"type":"assistant","timestamp":"2026-05-01T10:00:05.000Z","cwd":${escapedCwd},"message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":20},"stop_reason":"end_turn","content":[{"type":"text","text":"Done"}]}}`,
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

describe('ClaudeCodeService repository exclusion', () => {
  let root: string;
  let excluded: ReadonlySet<string> = new Set();
  let service: ClaudeCodeService;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-claude-'));

    // A working directory inside a git repo with an origin remote…
    const repoCwd = path.join(root, 'work', 'repo-a');
    fs.mkdirSync(path.join(repoCwd, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(repoCwd, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/example-org/hidden-repo.git\n',
    );
    // …and one with no repository at all (resolves to `unknown`).
    const plainCwd = path.join(root, 'work', 'plain');
    fs.mkdirSync(plainCwd, { recursive: true });

    const projects = path.join(root, 'projects');
    const slugA = path.join(projects, 'enc-repo-a');
    const slugB = path.join(projects, 'enc-plain');
    fs.mkdirSync(slugA, { recursive: true });
    fs.mkdirSync(slugB, { recursive: true });
    writeTranscript(path.join(slugA, `${SESSION_A}.jsonl`), repoCwd);
    writeTranscript(path.join(slugB, `${SESSION_B}.jsonl`), plainCwd);

    const config: ClaudeServiceConfig = {
      isClaudeEnabled: () => true,
      getClaudeProjectsPathOverride: () => projects,
      getClaudeScanDepth: () => 4,
      getClaudeMaxSessions: () => 150,
      getCodeFileExtensions: () => [],
      getDocFileExtensions: () => [],
      getExcludedRepositories: () => excluded,
    };
    // Real filesystem, but home/env pinned into the temp root so the developer's
    // own ~/.claude/projects can never leak into the discovery.
    const env: ClaudeFs = {
      ...defaultFs,
      homedir: () => path.join(root, 'home'),
      env: {},
    };
    service = new ClaudeCodeService(config, env);
  });

  afterAll(() => {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('baseline: both sessions and both repositories are visible', () => {
    excluded = new Set();
    const repos = service.listRepositories();
    expect(repos.ok).toBe(true);
    if (repos.ok) {
      expect(repos.value.map((r) => r.repository).sort()).toEqual([HIDDEN_REPO, 'unknown']);
    }
    const sessions = service.listSessions();
    expect(sessions.ok && sessions.value.length === 2).toBe(true);
    const rows = service.getAggregationRows();
    expect(rows.ok && rows.value.some((r) => r.repository === HIDDEN_REPO)).toBe(true);
  });

  it('excluding the repo hides its session from every listing and the overview', () => {
    excluded = new Set([HIDDEN_REPO]);
    const repos = service.listRepositories();
    expect(repos.ok).toBe(true);
    if (repos.ok) {
      expect(repos.value.map((r) => r.repository)).toEqual(['unknown']);
    }
    const sessions = service.listSessions();
    expect(sessions.ok).toBe(true);
    if (sessions.ok) {
      expect(sessions.value.map((s) => s.sessionId)).toEqual([SESSION_B]);
    }
    const direct = service.listSessions(HIDDEN_REPO);
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      expect(direct.value).toEqual([]);
    }
    const overview = service.getOverview();
    expect(overview.ok).toBe(true);
    if (overview.ok) {
      expect(overview.value.totalSessions).toBe(1);
      expect(overview.value.totalRepositories).toBe(1);
    }
  });

  it('drops the excluded repository from the aggregation rows (sync/preview path)', () => {
    excluded = new Set([HIDDEN_REPO]);
    const rows = service.getAggregationRows();
    expect(rows.ok).toBe(true);
    if (rows.ok) {
      expect(rows.value.length).toBeGreaterThan(0); // the unknown session still aggregates
      expect(rows.value.some((r) => r.repository === HIDDEN_REPO)).toBe(false);
    }
  });

  it('the literal `unknown` hides sessions with no detected git remote', () => {
    excluded = new Set(['unknown']);
    const sessions = service.listSessions();
    expect(sessions.ok).toBe(true);
    if (sessions.ok) {
      expect(sessions.value.map((s) => s.sessionId)).toEqual([SESSION_A]);
    }
  });
});
