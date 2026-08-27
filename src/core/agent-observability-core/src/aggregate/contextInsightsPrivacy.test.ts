import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv/dist/2020';
import { CONTEXT_INSIGHTS_SCHEMA } from '../telemetry/testSupport';
import { REPOSITORY_PATTERN } from '../telemetry/repositoryUrl';
import { computeDeveloperId } from './pseudonymizer';
import { buildRepoCustomizationIndex, SAFE_CONTEXT_FILE_PATTERN } from './customizationFilter';
import {
  extractContextObservations,
  type ContextFileObservation,
  type SessionContext,
  type ContextSignalsProvider,
} from './contextInsightsExtractor';
import { buildContextInsightsBatch } from './contextInsightsAggregator';
import type { ContextInsightsBatch } from './contextInsightsModels';
import type { DiscoveryEventRow } from '../context/discoveryParser';

/**
 * CRITICAL privacy regression test for the context-insights upload path.
 *
 * The context-insights batch is the FIRST contract that conveys repo-relative
 * customization-file PATHS to the cloud, so this test drives the real producer
 * pipeline (index build -> observation extraction -> batch aggregation) with a
 * deliberately adversarial mix of inputs and proves end-to-end that:
 *  (1) the batch validates against the strict shared JSON Schema (ajv) — proving
 *      `additionalProperties:false` holds so no unexpected/raw field can leak;
 *  (2) only safe, in-repo, allowlisted customization paths survive — global-scope
 *      (absolute), traversal, ambiguous, and non-allowlisted files are dropped;
 *  (3) NOTHING in the batch contains an absolute path, drive letter, `..`, `@`,
 *      backslash, an email shape, the workspace/home directory, a username, or
 *      the raw free-text skip reason (only the closed-set taxonomy ships);
 *  (4) every contextFile matches the schema path pattern and every repository the
 *      repository pattern; the developer id is pseudonymous; categories are enum-only;
 *  (5) re-building yields an identical batchId and rowKeys (idempotency).
 */

const SALT = 'b'.repeat(64);
const DEV_ID = computeDeveloperId(SALT, 'tester@example.com');
const REPO = 'https://github.com/acme/widgets';

// A fixed window/anchor so output is deterministic.
const T0 = Date.parse('2026-06-01T10:00:00.000Z');
const WINDOW_START = T0;
const WINDOW_END = T0 + 3_600_000;

const CATEGORY_ENUM = ['instruction', 'skill', 'agent', 'hook', 'prompt'];
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A Windows drive-letter path root (e.g. "C:/" or "C:\"). The leading boundary keeps
// this from matching the "s:/" inside a legitimate "https://" repository URL.
const DRIVE_LETTER = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/;

/** Secret-bearing tokens injected into adversarial inputs; none may reach the batch. */
const FORBIDDEN_TOKENS = [
  'jdoe',
  'AppData',
  'Roaming',
  'etc/passwd',
  'passwd',
  'global.prompt',
  'common.instructions',
  'secrets.env',
  'applyTo glob', // raw skip-reason text
  '/Users/',
];

/** Collect every string value (and key) reachable in an arbitrary JSON value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) {
      collectStrings(v, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
}

function discovery(
  spanName: string,
  eventCategory: 'discovery' | 'customization',
  eventDetails: string,
): DiscoveryEventRow {
  return {
    spanName,
    eventDetails,
    eventCategory,
    conversationId: null,
    chatSessionId: null,
    agentName: null,
    debugLabel: null,
  };
}

describe('context-insights batch privacy contract (adversarial producer pipeline)', () => {
  let tmpDir: string;
  let batch: ContextInsightsBatch;
  let observations: ContextFileObservation[];
  let validate: ValidateFunction;

  beforeAll(() => {
    // 1. A real temp repo with allowlisted customization files at UNIQUE paths,
    //    plus TWO same-named files to exercise the ambiguous-drop path.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-ctx-'));
    const write = (rel: string, body: string): void => {
      const abs = path.join(tmpDir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    };
    write('.github/copilot-instructions.md', '# repo instructions\n'.repeat(8));
    write('.github/instructions/security.instructions.md', '# security\n'.repeat(40));
    write('.github/prompts/refactor.prompt.md', '# refactor\n'.repeat(12));
    write('.agents/reviewer.agent.md', '# reviewer\n'.repeat(6));
    write('.claude/skills/analyzer/SKILL.md', '# analyzer skill\n'.repeat(20));
    write('AGENTS.md', '# agents\n'.repeat(4));
    // Ambiguous: same base name in two locations -> must NOT be attributed.
    write('.github/instructions/common.instructions.md', '# common a\n');
    write('.copilot/common.instructions.md', '# common b\n');

    const index = buildRepoCustomizationIndex(tmpDir);

    // 2. Per-session discovery events: safe loads + adversarial entries that must drop.
    const eventsByKey = new Map<string, DiscoveryEventRow[]>([
      [
        'sess-A',
        [
          discovery(
            'Instructions Discovery',
            'discovery',
            'Resolved 2 instructions in 12.3ms | loaded: [copilot-instructions.md, security.instructions.md] | folders: [.github]',
          ),
          discovery('Skill Discovery', 'discovery', 'Resolved 1 skills in 4.1ms | loaded: [SKILL.md] | folders: [.claude/skills]'),
          discovery('Agent Discovery', 'discovery', 'Resolved 1 agents in 2.0ms | loaded: [reviewer.agent.md] | folders: [.agents]'),
          discovery('Customization', 'customization', '[applying] AGENTS.md — always added'),
          // Adversarial: absolute/global, traversal, ambiguous, non-allowlisted — ALL dropped.
          discovery(
            'Prompt Discovery',
            'discovery',
            'Resolved 0 prompts in 1ms | loaded: [C:/Users/jdoe/AppData/Roaming/Code/User/prompts/global.prompt.md, ../../../../etc/passwd.instructions.md, common.instructions.md, secrets.env] | folders: [user]',
          ),
          // Skipped with a secret-bearing free-text reason — only the taxonomy key may ship.
          discovery(
            'Prompt Discovery',
            'discovery',
            'Resolved 0 prompts in 1ms | skipped: [refactor.prompt.md (applyTo glob /Users/jdoe/secret/** did not match)]',
          ),
        ],
      ],
      [
        'sess-B',
        [
          discovery(
            'Instructions Discovery',
            'discovery',
            'Resolved 1 instructions in 8.0ms | loaded: [security.instructions.md] | folders: [.github]',
          ),
        ],
      ],
    ]);
    const getSignals: ContextSignalsProvider = (k) => ({
      discoveryEvents: eventsByKey.get(k) ?? [],
      toolReads: [],
      systemInstructions: [],
    });

    const sessions: SessionContext[] = [
      { sessionKey: 'sess-A', repository: REPO, startTimeMs: T0, hadError: true, hadDeviation: false },
      { sessionKey: 'sess-B', repository: REPO, startTimeMs: T0 + 60_000, hadError: false, hadDeviation: true },
    ];

    observations = extractContextObservations(sessions, getSignals, tmpDir, index);
    batch = buildContextInsightsBatch({
      observations,
      pseudonymousDeveloperId: DEV_ID,
      toolVersion: '0.1.19',
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      generatedAtMs: Date.parse('2026-06-01T11:00:00.000Z'),
    });

    const schema = JSON.parse(readFileSync(CONTEXT_INSIGHTS_SCHEMA, 'utf8')) as object;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addFormat('date-time', true);
    validate = ajv.compile(schema);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(0) only safe in-repo customization files survive; adversarial inputs are dropped', () => {
    const files = [...new Set(batch.rows.map((r) => r.contextFile))].sort();
    expect(files).toEqual(
      [
        '.agents/reviewer.agent.md',
        '.claude/skills/analyzer/SKILL.md',
        '.github/copilot-instructions.md',
        '.github/instructions/security.instructions.md',
        '.github/prompts/refactor.prompt.md',
        'AGENTS.md',
      ].sort(),
    );
    expect(batch.rows.length).toBeGreaterThan(0);
  });

  it('(1) validates against the strict shared JSON Schema (additionalProperties:false satisfied)', () => {
    const ok = validate(batch);
    if (!ok) {
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('(2) leaks no absolute path, drive letter, "..", "@", backslash, email, workspace/home dir, username, or raw skip text', () => {
    const strings: string[] = [];
    collectStrings(batch, strings);

    const homedir = os.homedir();
    const username = os.userInfo().username;

    for (const s of strings) {
      for (const token of FORBIDDEN_TOKENS) {
        expect(s.includes(token)).toBe(false);
      }
      expect(s.includes('..')).toBe(false);
      expect(s.includes('@')).toBe(false);
      expect(s.includes('\\')).toBe(false);
      expect(DRIVE_LETTER.test(s)).toBe(false);
      expect(EMAIL_SHAPE.test(s)).toBe(false);
      expect(s.includes(tmpDir)).toBe(false);
      expect(s.includes(homedir)).toBe(false);
      if (username.length >= 4) {
        expect(s.includes(username)).toBe(false);
      }
    }
  });

  it('(3) every contextFile matches the schema path pattern and is repo-relative', () => {
    for (const row of batch.rows) {
      expect(SAFE_CONTEXT_FILE_PATTERN.test(row.contextFile)).toBe(true);
      expect(path.isAbsolute(row.contextFile)).toBe(false);
    }
  });

  it('(4) repositories, developer id, categories, and skipReason keys are all constrained', () => {
    for (const row of batch.rows) {
      expect(REPOSITORY_PATTERN.test(row.repository)).toBe(true);
      expect(CATEGORY_ENUM).toContain(row.category);
      if (row.skipReasonCounts !== undefined) {
        for (const key of Object.keys(row.skipReasonCounts)) {
          expect(['applyToNoMatch', 'other']).toContain(key);
        }
      }
    }
    expect(batch.pseudonymousDeveloperId).toMatch(/^dev_[0-9a-f]{32}$/);
  });

  it('(5) friction co-occurrence is attributed correctly (error + deviation across sessions)', () => {
    const security = batch.rows.find((r) => r.contextFile === '.github/instructions/security.instructions.md');
    expect(security).toBeDefined();
    // Applied in both sessions; one had an error, the other a deviation.
    expect(security!.distinctSessionCount).toBe(2);
    expect(security!.sessionsWithErrorCount).toBe(1);
    expect(security!.sessionsWithDeviationCount).toBe(1);

    const refactor = batch.rows.find((r) => r.contextFile === '.github/prompts/refactor.prompt.md');
    expect(refactor).toBeDefined();
    expect(refactor!.skippedCount).toBe(1);
    expect(refactor!.skipReasonCounts).toEqual({ applyToNoMatch: 1 });
  });

  it('(6) re-building from the same observations yields an identical batchId and rowKeys (idempotent)', () => {
    const rebuilt = buildContextInsightsBatch({
      observations,
      pseudonymousDeveloperId: DEV_ID,
      toolVersion: '0.1.19',
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      generatedAtMs: Date.parse('2026-06-01T11:30:00.000Z'),
    });

    expect(rebuilt.batchId).toBe(batch.batchId);
    expect(rebuilt.rows.map((r) => r.rowKey)).toEqual(batch.rows.map((r) => r.rowKey));
  });
});
